// Análise de Concorrente — virou um AGENTE AUTOMÁTICO (19/09/2026, pedido
// explícito do usuário: "quero que essas ia nunca pare de trabalhar...
// análisar concorrentes e sempre buscar concorrentes que estão vendendo o
// mesmo produto que eu"). Até aqui (ver lib/concorrente.js) a busca só
// rodava sob demanda, produto por produto, quando alguém clicava em
// "Buscar concorrentes" na tela. Este arquivo é o ORQUESTRADOR do ciclo
// automático: varre os produtos elegíveis de cada empresa (ver
// lib/concorrente.js#listarProdutosElegiveisParaVarredura), reaproveita a
// MESMA função de busca (lib/concorrente.js#buscarConcorrentesPorProduto —
// nada de regra nova/duplicada), e entrega o resultado exatamente como o
// resto do sistema já espera: alertas reais na Central de Alertas
// (radar_alertas, categoria 'concorrente_ativo') e aviso por WhatsApp só
// quando a situação é NOVA ou PIOROU — reaproveitando 100% o motor já
// existente do Radar da IA (lib/ia/radar.js#persistirSituacoes/
// notificarWhatsapp/interpretarComIA), nunca uma cópia paralela dessa
// lógica.
//
// Por que um scheduler PRÓPRIO (lib/ia/concorrenteScheduler.js) e não só
// mais uma regra dentro do ciclo do Radar (que roda a cada 15min): cada
// produto varrido aqui gasta pelo menos 1 chamada real à API pública do
// Mercado Livre (busca por catálogo e/ou por título) — rodar isso a cada
// 15min pra cada produto de cada empresa estouraria rate limit rápido.
// Por isso o ciclo aqui é 1x por dia (configurável, ver
// concorrenteScheduler.js) e tem um limite de produtos por ciclo (ver
// lib/concorrente.js#listarProdutosElegiveisParaVarredura).
//
// Escopo desta etapa (aprovado explicitamente pelo usuário): só compara
// preço dos produtos que a empresa JÁ VENDE — "buscar novos produtos" que
// o concorrente vende e a empresa ainda não vende é uma etapa DIFERENTE,
// que precisa antes de uma categoria/nicho de busca combinado com o
// usuário, e fica pra depois (usuário escolheu focar no que já vende
// primeiro).
const pool = require('../../db/pool');
const { buscarConcorrentesPorProduto, listarProdutosElegiveisParaVarredura } = require('../concorrente');
const {
  persistirSituacoes, interpretarComIA, aplicarRecomendacoesIA, notificarWhatsapp,
} = require('./radar');

// Limite de produtos varridos por empresa por ciclo — mesma proteção de
// rate limit citada acima; configurável só por variável de ambiente (nunca
// pela tela, pra não virar um jeito acidental de gastar a API à toa).
const MAX_PRODUTOS_POR_CICLO = Number(process.env.IA_CONCORRENTE_MAX_PRODUTOS) || 40;

// A partir de qual diferença de preço um concorrente mais barato vira
// 'crítico' (nunca escala sozinho pra 'crítico' quando o produto é só um
// CANDIDATO de busca por título — sem certeza de que é o mesmo produto,
// o máximo que chega é 'atencao', pra nunca alarmar demais em cima de uma
// aproximação de texto).
const LIMIAR_DIFERENCA_CRITICA_PCT = 15;

function round2(v) { return Math.round(v * 100) / 100; }

function formatMoney(v) {
  if (v === null || v === undefined) return null;
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------- Regra determinística (a mesma ideia de radarAnuncios.js/radarNegocio.js) ----------------
// Devolve null quando não há NADA a alertar (nenhum concorrente realmente
// vendendo agora) — nunca cria uma situação vazia só pra "ter alguma
// coisa". Isso também significa: se o concorrente sumir, este produto
// simplesmente não aparece mais na lista de situações do ciclo, e
// persistirSituacoes() resolve automaticamente o alerta antigo — sem
// nenhuma lógica extra aqui.
function avaliarProduto({ produto, resultado }) {
  const { modo, itemBase, concorrentes } = resultado;
  if (!concorrentes || !concorrentes.length) return null;

  const confiavel = modo === 'catalogo'; // Mercado Livre garante que é o mesmo produto
  const precosValidos = concorrentes
    .map((c) => c.preco)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number);
  const menorPreco = precosValidos.length ? Math.min(...precosValidos) : null;
  const meuPreco = itemBase && itemBase.precoUltimaVenda !== null && itemBase.precoUltimaVenda !== undefined
    ? Number(itemBase.precoUltimaVenda) : null;

  let diffPct = null;
  let diffValor = null;
  if (menorPreco !== null && meuPreco) {
    diffValor = round2(meuPreco - menorPreco);
    diffPct = round2((diffValor / meuPreco) * 100);
  }

  let severidade;
  if (diffPct !== null && diffPct >= LIMIAR_DIFERENCA_CRITICA_PCT) severidade = confiavel ? 'critico' : 'atencao';
  else if (diffPct !== null && diffPct > 0) severidade = confiavel ? 'atencao' : 'informativo';
  else if (diffPct !== null) severidade = 'oportunidade'; // seu preço já é igual ou menor que o concorrente encontrado
  else severidade = confiavel ? 'atencao' : 'informativo'; // sem preço seu pra comparar — só confirma que tem concorrente ativo

  const nome = produto.nome || produto.sku || ('produto ' + produto.id);
  const qtd = concorrentes.length;
  const modoTexto = confiavel
    ? 'o Mercado Livre confirma que é o mesmo produto (catálogo)'
    : `${qtd === 1 ? 'candidato encontrado' : 'candidatos encontrados'} por título do anúncio — confirme se é de fato o mesmo produto antes de decidir qualquer coisa`;

  let titulo;
  let descricao;
  if (diffPct !== null && diffPct > 0) {
    titulo = `${nome}: concorrente ${formatMoney(menorPreco)} — ${diffPct.toLocaleString('pt-BR')}% mais barato que sua última venda`;
    descricao = `Encontrei ${qtd} concorrente${qtd === 1 ? '' : 's'} vendendo ${nome} agora (${modoTexto}). O menor preço encontrado foi ${formatMoney(menorPreco)}; sua última venda registrada foi a ${formatMoney(meuPreco)} — ${formatMoney(diffValor)} de diferença.`;
  } else if (diffPct !== null) {
    titulo = `${nome}: você já está no preço (ou abaixo) do concorrente encontrado`;
    descricao = `Encontrei ${qtd} concorrente${qtd === 1 ? '' : 's'} vendendo ${nome} agora (${modoTexto}). O menor preço encontrado foi ${formatMoney(menorPreco)}; sua última venda registrada foi a ${formatMoney(meuPreco)} — você já está competitivo, sem necessidade de agir agora.`;
  } else {
    titulo = `${nome}: ${qtd} concorrente${qtd === 1 ? '' : 's'} vendendo o mesmo produto agora`;
    descricao = `Encontrei ${qtd} concorrente${qtd === 1 ? '' : 's'} vendendo ${nome} agora (${modoTexto}). Não foi possível comparar com seu preço porque não há um preço de venda recente registrado para este SKU.`;
  }

  const recomendacaoPadrao = severidade === 'oportunidade'
    ? 'Você está competitivo em preço frente ao que foi encontrado — pode ser uma boa hora para reforçar estoque/exposição deste produto, em vez de baixar o preço.'
    : confiavel
      ? 'Confira o anúncio do concorrente (mesmo produto de catálogo) e decida se vale ajustar preço, melhorar a oferta (frete, prazo, fotos) ou manter — a IA só observa e recomenda, nunca altera preço sozinha.'
      : 'Este é um candidato encontrado por título, não uma certeza — confira o anúncio antes de considerar concorrente de verdade. Se for o mesmo produto, avalie preço, frete e prazo antes de decidir qualquer ajuste.';

  return {
    chave: 'concorrente_ativo:' + produto.id,
    categoria: 'concorrente_ativo',
    severidade,
    titulo,
    descricao,
    recomendacaoPadrao,
    pagina: 'concorrente',
    dados: {
      produtoId: produto.id, sku: produto.sku, nome: produto.nome,
      modo, confiavel, quantidadeConcorrentes: qtd,
      menorPrecoConcorrente: menorPreco, meuPrecoUltimaVenda: meuPreco,
      diferencaPct: diffPct, valorEnvolvido: diffValor !== null ? Math.abs(diffValor) : null,
      buscadoEm: resultado.buscadoEm,
    },
  };
}

// ---------------- Varredura de uma empresa ----------------
async function analisarConcorrentes({ empresaId, limite = MAX_PRODUTOS_POR_CICLO } = {}) {
  const produtos = await listarProdutosElegiveisParaVarredura(empresaId, { limite });
  const situacoes = [];
  const comErro = [];

  for (const produto of produtos) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequencial de propósito: é uma chamada real à API do Mercado Livre por produto, nunca em paralelo, pra nunca estourar rate limit num único ciclo.
      const resultado = await buscarConcorrentesPorProduto({ empresaId, produtoId: produto.id });
      if (resultado.modo === 'sem_dado') continue; // sem dado suficiente — nunca inventa alerta
      const situacao = avaliarProduto({ produto, resultado });
      if (situacao) situacoes.push(situacao);
    } catch (err) {
      // Uma falha (ex.: API do Mercado Livre fora do ar, ou este ambiente
      // sem acesso à internet) nunca pode travar os outros produtos —
      // mesma filosofia defensiva do resto do Radar da IA.
      comErro.push({ produtoId: produto.id, sku: produto.sku, erro: String((err && err.message) || err) });
      console.error(`[concorrente ia] produto ${produto.id} (${produto.sku}) falhou: ${(err && err.message) || err}`);
    }
  }

  return { situacoes, produtosAnalisados: produtos.length, comErro };
}

// ---------------- Ciclo completo de uma empresa (varre + persiste + avisa) ----------------
async function executarCicloConcorrenteEmpresa(empresaId) {
  const empresaRow = await pool.query('SELECT id, razao_social, nome_fantasia FROM empresas WHERE id = $1 AND ativo = TRUE', [empresaId]);
  if (!empresaRow.rows.length) return { empresaId, ignorado: true };
  const empresa = { id: empresaRow.rows[0].id, nome: empresaRow.rows[0].nome_fantasia || empresaRow.rows[0].razao_social };

  const { situacoes, produtosAnalisados, comErro } = await analisarConcorrentes({ empresaId });

  // origem 'concorrente' (20/09/2026, correção de bug real — ver o
  // comentário em lib/ia/radar.js#persistirSituacoes e o ALTER TABLE de
  // `origem_ciclo` em db/schema.sql): sem isolar por origem, o Radar
  // principal (que roda 15min depois) resolvia sozinho todo alerta de
  // concorrente por "não ter sido detectado" no SEU próprio ciclo — mesmo
  // com o concorrente continuando ativo.
  const novasOuEscaladas = await persistirSituacoes(empresaId, situacoes, 'concorrente');
  await interpretarComIA({ empresa, itens: novasOuEscaladas });
  await aplicarRecomendacoesIA(empresaId, novasOuEscaladas);
  await notificarWhatsapp(empresa, novasOuEscaladas);

  return {
    empresaId, produtosAnalisados, produtosComErro: comErro.length,
    situacoesDetectadas: situacoes.length, novasOuEscaladas: novasOuEscaladas.length,
  };
}

// Roda o ciclo pra TODAS as empresas ativas — cada uma isolada
// (Promise.allSettled, mesmo padrão de lib/ia/radar.js#executarCicloRadar):
// uma empresa falhando nunca impede as demais.
async function executarCicloConcorrente() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloConcorrenteEmpresa(e.id)));

  const comErro = [];
  let produtosAnalisados = 0;
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && !r.value.ignorado) {
      produtosAnalisados += r.value.produtosAnalisados || 0;
    }
    if (r.status === 'rejected') {
      const empresaId = empresas[i].id;
      comErro.push({ empresaId, erro: String((r.reason && r.reason.message) || r.reason) });
      console.error(`[concorrente ia] empresa ${empresaId} falhou: ${comErro[comErro.length - 1].erro}`);
    }
  });

  return { empresasProcessadas: empresas.length, produtosAnalisados, comErro };
}

module.exports = {
  analisarConcorrentes,
  executarCicloConcorrenteEmpresa,
  executarCicloConcorrente,
};
