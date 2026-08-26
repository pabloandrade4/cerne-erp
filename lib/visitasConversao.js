// Aba "Visitas e Conversão" (Análise) — criada em 26/08/2026, pedido
// explícito do usuário. Funil por anúncio: visitas (API de Visitas do
// Mercado Livre — lib/mlVisitas.js, novo cliente criado nesta etapa),
// vendas/pedidos (mesma fonte única de sempre — lib/relatorioVendas.js).
//
// REGRA EXPLÍCITA DO USUÁRIO (verbatim): "Não invente número de visitas. Se
// o Mercado Livre não disponibilizar determinada métrica para algum
// anúncio/período, mostrar: Dado não disponível." — por isso todo campo de
// visitas/conversão que dependa da API de Visitas vem como `null` quando a
// API não respondeu (conta com erro, token inválido, endpoint indisponível,
// ou o anúncio simplesmente não aparece na resposta) — o front-end mostra
// literalmente "Dado não disponível" nesses casos, nunca "0" nem "—".
//
// DEFINIÇÃO DE CONVERSÃO (pedido do usuário: "utilize a métrica mais
// adequada... e deixe claro qual definição está sendo usada"): este ERP usa
//   CONVERSÃO = PEDIDOS ÷ VISITAS × 100
// (pedidos, não unidades — um pedido com 3 unidades do mesmo anúncio é 1
// conversão, não 3; é a definição padrão de "taxa de conversão" de
// e-commerce). Mostrada em todo lugar da tela com esse rótulo explícito,
// nunca só "Conversão", para não ficar ambíguo com quem espera
// unidades/visitas.
//
// LIMITAÇÃO DOCUMENTADA (pedido do usuário: "implemente a estrutura e
// informe claramente o que ainda falta"): a API de Visitas do Mercado Livre
// não oferece uma série diária de visitas POR ANÚNCIO sem uma chamada por
// anúncio (não escala para um catálogo inteiro) — por isso os gráficos
// "Visitas x Vendas" e "Conversão ao longo do tempo" mostram a série diária
// AGREGADA de todas as contas/anúncios filtrados, nunca por anúncio
// individual; a tabela por anúncio mostra visitas TOTAIS do período e a
// evolução (comparação percentual) vs. o período anterior, não uma série
// diária por anúncio.
const pool = require('../db/pool');
const { decrypt } = require('./crypto');
const { round2 } = require('./resultadoVenda');
const { buscarItensDoPeriodo, SQL_DATA_EFETIVA } = require('./relatorioVendas');
const { periodoAnteriorEquivalente } = require('./periodoComparacao');
const { buscarVisitasPorPeriodo, buscarVisitasDiariasPorConta } = require('./mlVisitas');
const { diaBRT } = require('./periodo');
const {
  agruparVendasDetalhado, buscarAnunciosVivosPorConta, buscarContasFiltradas, calcularCrescimento, resolverIdentidade,
} = require('./anunciosBase');
const { getContaComTokenValido } = require('./mlSync');

// ============================================================================
// SINALIZAÇÕES OBJETIVAS (pedido do usuário: "Quero conseguir identificar
// situações como...") — documentadas em docs/01-regras-de-negocio.md. Só
// calculadas para anúncios com visitas disponíveis (nunca inferidas sem
// dado real). "Muitas"/"poucas" visitas e "boa" conversão são relativas ao
// próprio conjunto filtrado (terços — mesmo critério de Margem por
// Anúncio, ver lib/margemAnuncio.js), porque não existe um número fixo de
// visitas que seja "muito" para qualquer empresa/anúncio.
//   - "Muitas visitas + poucas vendas": visitas no terço de cima do
//     conjunto E conversão <= CONVERSAO_BAIXA_PCT (1%).
//   - "Poucas visitas + boa conversão": visitas no terço de baixo do
//     conjunto E conversão >= CONVERSAO_BOA_PCT (5%).
//   - "Muitas visitas + boa conversão" (anúncio forte): visitas no terço de
//     cima E conversão >= CONVERSAO_BOA_PCT (5%).
//   - "Queda de visitas": evolução de visitas <= QUEDA_VISITAS_PCT (-30%)
//     em relação ao período anterior.
// ============================================================================
const CONVERSAO_BAIXA_PCT = 1;
const CONVERSAO_BOA_PCT = 5;
const QUEDA_VISITAS_PCT = -30;

const CRITERIOS = {
  definicaoConversao: 'Conversão = pedidos ÷ visitas × 100',
  conversaoBaixaPct: CONVERSAO_BAIXA_PCT,
  conversaoBoaPct: CONVERSAO_BOA_PCT,
  quedaVisitasPct: QUEDA_VISITAS_PCT,
  descricao: '"Muitas"/"poucas" visitas são relativas ao terço de cima/baixo do próprio conjunto filtrado — documentado em docs/01-regras-de-negocio.md.',
};

function limiaresPorTercos(valores) {
  const validos = valores.filter((v) => v !== null && v !== undefined).slice().sort((a, b) => a - b);
  if (validos.length < 3) return { corteBaixo: null, corteAlto: null };
  const corteBaixo = validos[Math.floor(validos.length / 3) - 1] ?? validos[0];
  const corteAlto = validos[Math.ceil((validos.length * 2) / 3)] ?? validos[validos.length - 1];
  return { corteBaixo, corteAlto };
}

function calcularConversao(pedidos, visitas) {
  if (visitas === null || visitas === undefined || visitas <= 0) return null;
  return round2((pedidos / visitas) * 100);
}

// Busca as visitas por anúncio de todas as contas ATIVAS filtradas, para um
// intervalo de datas. Contas com erro/desconectadas entram em
// `situacaoPorConta` com o motivo real (nunca tentadas ao vivo).
async function buscarVisitasDeContas(contasFiltradas, itemIdsPorConta, desdeStr, ateStr) {
  const porItem = new Map();
  const situacaoPorConta = [];
  for (const conta of contasFiltradas) {
    if (conta.status !== 'ativa') {
      situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: false, motivo: 'conta_com_erro', mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada — visitas indisponíveis para os anúncios desta loja.' });
      continue;
    }
    const itemIds = itemIdsPorConta.get(conta.id) || [];
    if (!itemIds.length) { situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: true }); continue; }
    try {
      const accessToken = decrypt((await getContaComTokenValido(conta.id)).access_token_enc);
      const resultado = await buscarVisitasPorPeriodo({ accessToken, itemIds, desde: desdeStr, ate: ateStr });
      resultado.porItem.forEach((v, k) => porItem.set(k, v));
      situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: resultado.disponivel, parcial: resultado.parcial, motivo: resultado.motivo, mensagem: resultado.mensagem });
    } catch (err) {
      situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: false, motivo: 'erro_api', mensagem: 'Não foi possível consultar a API de Visitas desta loja agora (' + (err.message || 'erro') + ').' });
    }
  }
  return { porItem, situacaoPorConta };
}

// Série diária de vendas (unidades) — pedidos não cancelados, agrupados
// pela mesma "data efetiva" usada em todo o resto do ERP (lib/relatorioVendas.js).
async function buscarVendasDiarias({ empresaId, contaId, desdeStr, ateStr }) {
  const { rows } = await pool.query(
    `SELECT to_char(${SQL_DATA_EFETIVA}, 'YYYY-MM-DD') AS dia, COALESCE(SUM(pi.quantidade), 0) AS unidades
       FROM ml_pedidos p
       JOIN ml_contas c ON c.id = p.conta_ml_id
       JOIN ml_pedido_itens pi ON pi.pedido_id = p.id
      WHERE c.empresa_id = $1 AND p.status <> 'cancelled'
        AND ${SQL_DATA_EFETIVA} >= $2::date AND ${SQL_DATA_EFETIVA} < ($3::date + interval '1 day')
        ${contaId ? 'AND p.conta_ml_id = $4' : ''}
      GROUP BY 1 ORDER BY 1`,
    contaId ? [empresaId, desdeStr, ateStr, contaId] : [empresaId, desdeStr, ateStr]
  );
  return rows.map((r) => ({ dia: r.dia, unidades: Number(r.unidades) }));
}

// Série diária AGREGADA de visitas de todas as contas ativas filtradas
// (soma dia a dia) — ver limitação documentada no topo do arquivo.
async function buscarVisitasDiariasAgregadas(contasAtivas, dias, ateStr) {
  const somaPorDia = new Map();
  let algumaDisponivel = false;
  for (const conta of contasAtivas) {
    try {
      const accessToken = decrypt((await getContaComTokenValido(conta.id)).access_token_enc);
      const resultado = await buscarVisitasDiariasPorConta({ accessToken, mlUserId: conta.ml_user_id, dias, endingStr: ateStr });
      if (resultado.disponivel) {
        algumaDisponivel = true;
        resultado.dias.forEach((d) => somaPorDia.set(d.data, (somaPorDia.get(d.data) || 0) + d.visitas));
      }
    } catch (e) { /* conta sem token válido — segue sem essa conta, nunca inventa a série */ }
  }
  return { disponivel: algumaDisponivel, porDia: somaPorDia };
}

async function gerarVisitasConversao({ empresaId, contaId, sku, periodoCalc, desdeStr, ateStr }) {
  const { contasTodas, contasFiltradas } = await buscarContasFiltradas({ empresaId, contaId });
  if (!contasTodas.length) {
    return { semConta: true, lojas: [], situacaoPorConta: [], linhas: [], periodo: null, grafico: null, criterios: CRITERIOS };
  }

  const { desde, ate } = periodoCalc;
  const periodoAnteriorCalc = periodoAnteriorEquivalente({ desde, ate });
  const anteriorDesdeStr = diaBRT(periodoAnteriorCalc.desde);
  const anteriorAteStr = diaBRT(new Date(periodoAnteriorCalc.ate.getTime() - 1));

  const [{ itens: itensAtuais }, { itens: itensAnteriores }, { porItemId: anunciosVivos, situacaoPorConta: situacaoVivos }] = await Promise.all([
    buscarItensDoPeriodo({ empresaId, desde, ate }),
    buscarItensDoPeriodo({ empresaId, desde: periodoAnteriorCalc.desde, ate: periodoAnteriorCalc.ate }),
    buscarAnunciosVivosPorConta(contasFiltradas),
  ]);

  const itensAtuaisFiltrados = contaId ? itensAtuais.filter((it) => String(it.contaMlId) === String(contaId)) : itensAtuais;
  const itensAnterioresFiltrados = contaId ? itensAnteriores.filter((it) => String(it.contaMlId) === String(contaId)) : itensAnteriores;
  const vendasAtuais = agruparVendasDetalhado(itensAtuaisFiltrados);
  const vendasAnteriores = agruparVendasDetalhado(itensAnterioresFiltrados);

  // IDs de anúncio a consultar visitas: união de quem vendeu (período atual
  // e anterior) e de quem está vivo no catálogo — mesmo espírito de nunca
  // esconder um anúncio que só aparece de um dos lados.
  const todosItemIds = new Set([...vendasAtuais.keys(), ...vendasAnteriores.keys(), ...anunciosVivos.keys()].filter((k) => !String(k).startsWith('sem-id:')));
  const itemIdsPorConta = new Map();
  contasFiltradas.forEach((c) => itemIdsPorConta.set(c.id, []));
  todosItemIds.forEach((id) => {
    const vivo = anunciosVivos.get(id);
    const venda = vendasAtuais.get(id) || vendasAnteriores.get(id);
    const contaMlId = (vivo && vivo.contaId) || (venda && venda.contaMlId);
    if (contaMlId && itemIdsPorConta.has(contaMlId)) itemIdsPorConta.get(contaMlId).push(id);
  });

  const [visitasAtuais, visitasAnteriores] = await Promise.all([
    buscarVisitasDeContas(contasFiltradas, itemIdsPorConta, desdeStr, ateStr),
    buscarVisitasDeContas(contasFiltradas, itemIdsPorConta, anteriorDesdeStr, anteriorAteStr),
  ]);

  let linhas = [...todosItemIds].map((mlItemId) => {
    const venda = vendasAtuais.get(mlItemId) || null;
    const vendaAnterior = vendasAnteriores.get(mlItemId) || null;
    const vivo = anunciosVivos.get(mlItemId) || null;
    const identidade = resolverIdentidade({ mlItemId, venda, vivo });

    const visitas = visitasAtuais.porItem.has(mlItemId) ? visitasAtuais.porItem.get(mlItemId) : null;
    const visitasAnterior = visitasAnteriores.porItem.has(mlItemId) ? visitasAnteriores.porItem.get(mlItemId) : null;

    const pedidos = venda ? venda.quantidadePedidos : 0;
    const unidadesVendidas = venda ? venda.quantidade : 0;
    const pedidosAnterior = vendaAnterior ? vendaAnterior.quantidadePedidos : 0;

    const conversao = calcularConversao(pedidos, visitas);
    const conversaoAnterior = calcularConversao(pedidosAnterior, visitasAnterior);
    const evolucaoConversaoPontos = (conversao !== null && conversaoAnterior !== null) ? round2(conversao - conversaoAnterior) : null;
    const { percentual: evolucaoVisitasPercentual, novo: visitasNovo } = calcularCrescimento(visitas, visitasAnterior);

    return {
      mlItemId,
      imagemUrl: identidade.imagemUrl,
      anuncio: identidade.anuncio,
      sku: identidade.sku,
      loja: identidade.loja,
      contaMlId: identidade.contaMlId,
      visitas,
      unidadesVendidas,
      pedidos,
      faturamento: venda ? venda.faturamento : 0,
      conversao,
      visitasAnterior,
      conversaoAnterior,
      evolucaoVisitasPercentual,
      visitasNovo,
      evolucaoConversaoPontos,
      dadoNaoDisponivel: visitas === null,
    };
  });

  if (sku) {
    const alvo = sku.trim().toLowerCase();
    linhas = linhas.filter((l) => (l.sku || '').toLowerCase().includes(alvo));
  }

  const linhasComVisita = linhas.filter((l) => l.visitas !== null);
  const { corteBaixo, corteAlto } = limiaresPorTercos(linhasComVisita.map((l) => l.visitas));
  linhas = linhas.map((l) => {
    if (l.visitas === null) return { ...l, insights: { muitasVisitasPoucasVendas: false, poucasVisitasBoaConversao: false, muitasVisitasBoaConversao: false, quedaDeVisitas: false } };
    const muitasVisitas = corteAlto !== null && l.visitas >= corteAlto;
    const poucasVisitas = corteBaixo !== null && l.visitas <= corteBaixo;
    return {
      ...l,
      insights: {
        muitasVisitasPoucasVendas: muitasVisitas && l.conversao !== null && l.conversao <= CONVERSAO_BAIXA_PCT,
        poucasVisitasBoaConversao: poucasVisitas && l.conversao !== null && l.conversao >= CONVERSAO_BOA_PCT,
        muitasVisitasBoaConversao: muitasVisitas && l.conversao !== null && l.conversao >= CONVERSAO_BOA_PCT,
        quedaDeVisitas: l.evolucaoVisitasPercentual !== null && l.evolucaoVisitasPercentual <= QUEDA_VISITAS_PCT,
      },
    };
  });

  // Gráfico agregado (ver limitação documentada no topo do arquivo).
  const diasNoPeriodo = Math.max(1, Math.round((ate.getTime() - desde.getTime()) / (24 * 60 * 60 * 1000)));
  const contasAtivas = contasFiltradas.filter((c) => c.status === 'ativa');
  const [vendasDiarias, visitasDiarias] = await Promise.all([
    buscarVendasDiarias({ empresaId, contaId, desdeStr, ateStr }),
    buscarVisitasDiariasAgregadas(contasAtivas, diasNoPeriodo, ateStr),
  ]);
  const vendasPorDia = new Map(vendasDiarias.map((d) => [d.dia, d.unidades]));
  const todosOsDias = new Set([...vendasPorDia.keys(), ...visitasDiarias.porDia.keys()]);
  const serieDiaria = [...todosOsDias].sort().map((dia) => {
    const unidades = vendasPorDia.get(dia) || 0;
    const visitasDia = visitasDiarias.disponivel ? (visitasDiarias.porDia.get(dia) ?? null) : null;
    return { dia, unidades, visitas: visitasDia, conversao: calcularConversao(unidades, visitasDia) };
  });

  return {
    semConta: false,
    lojas: contasTodas.map((c) => ({ id: c.id, nickname: c.nickname })),
    situacaoPorConta: [...situacaoVivos, ...visitasAtuais.situacaoPorConta],
    periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde, ate },
    periodoAnterior: { desde: periodoAnteriorCalc.desde, ate: periodoAnteriorCalc.ate },
    linhas,
    grafico: { disponivel: visitasDiarias.disponivel, serieDiaria },
    criterios: CRITERIOS,
  };
}

module.exports = { gerarVisitasConversao, CRITERIOS };
