// Aba "Performance de Anúncios" (Análise) — criada em 26/08/2026, pedido
// explícito do usuário. Analisa anúncio por anúncio com dados REAIS: vendas
// vêm da mesma fonte única de sempre (lib/relatorioVendas.js →
// lib/resultadoVenda.js, via lib/anunciosBase.js#agruparVendasDetalhado);
// preço atual/status/estoque vêm AO VIVO do Mercado Livre (mesma fonte da
// tela Anúncios — lib/mlAnuncios.js). Nunca inventa dado: quando uma loja
// está com a conexão do Mercado Livre com erro, o preço/status daquela loja
// aparece como indisponível (nunca um valor antigo/estimado) — ver
// `situacaoPorConta` no retorno.
//
// ============================================================================
// CRITÉRIOS OBJETIVOS DOS INDICADORES 🟢/🟡/🔴 (pedido explícito do usuário:
// "Não crie esses status arbitrariamente. Defina critérios objetivos e
// documentados.") — os MESMOS critérios abaixo estão documentados em
// docs/01-regras-de-negocio.md; qualquer mudança aqui precisa refletir lá.
//
// Só se aplica a anúncios com status "active" (anúncio pausado/encerrado
// não recebe indicador de desempenho — recebe o badge do próprio status).
//
//   🔴 Baixo desempenho, quando QUALQUER um for verdade:
//      - está há DIAS_SEM_VENDER_RUIM (14) dias ou mais sem nenhuma venda; OU
//      - vendia no período anterior e NÃO vendeu nada no período atual; OU
//      - crescimento de unidades vendidas <= QUEDA_FORTE_PCT (-50%) em
//        relação ao período anterior (só quando havia venda no período
//        anterior para comparar).
//   🟡 Atenção, quando não é 🔴 e QUALQUER um for verdade:
//      - está há DIAS_SEM_VENDER_ATENCAO (7) a 13 dias sem venda; OU
//      - crescimento de unidades vendidas <= QUEDA_MODERADA_PCT (-20%); OU
//      - está "praticamente parado" (vendeu no período, mas média de vendas
//        por dia <= MEDIA_DIA_PARADO (0,1 — ou seja, menos de 1 unidade a
//        cada 10 dias)).
//   🟢 Bom desempenho: não é 🔴 nem 🟡 e vendeu ao menos 1 unidade no
//      período.
//   (sem classificação): ativo, mas sem nenhuma venda no período nem no
//      histórico consultado — não dá para avaliar tendência ainda (ex:
//      anúncio novo).
//
// Sinalizações adicionais (mostradas como tags, independentes da cor):
//   - "Sem vender há X dias" quando diasSemVender >= DIAS_SEM_VENDER_ATENCAO.
//   - "Vendendo cada vez menos" quando crescimento <= QUEDA_MODERADA_PCT.
//   - "Crescendo" quando crescimento >= CRESCIMENTO_PCT (+20%).
//   - "Praticamente parado" quando MEDIA_DIA_PARADO acima, com venda > 0.
// ============================================================================
const { round2 } = require('./resultadoVenda');
const { buscarItensDoPeriodo } = require('./relatorioVendas');
const { periodoAnteriorEquivalente } = require('./periodoComparacao');
const {
  agruparVendasDetalhado, buscarAnunciosVivosPorConta, buscarUltimaVendaPorAnuncio,
  buscarNomesProdutoPorSku, buscarContasFiltradas, diasEntre, calcularCrescimento, resolverIdentidade,
} = require('./anunciosBase');

const DIAS_SEM_VENDER_RUIM = 14;
const DIAS_SEM_VENDER_ATENCAO = 7;
const QUEDA_FORTE_PCT = -50;
const QUEDA_MODERADA_PCT = -20;
const CRESCIMENTO_PCT = 20;
const MEDIA_DIA_PARADO = 0.1;

const CRITERIOS = {
  diasSemVenderRuim: DIAS_SEM_VENDER_RUIM,
  diasSemVenderAtencao: DIAS_SEM_VENDER_ATENCAO,
  quedaFortePct: QUEDA_FORTE_PCT,
  quedaModeradaPct: QUEDA_MODERADA_PCT,
  crescimentoPct: CRESCIMENTO_PCT,
  mediaDiaParado: MEDIA_DIA_PARADO,
  descricao: 'Critérios objetivos documentados em docs/01-regras-de-negocio.md — só se aplicam a anúncios com status ativo.',
};

function classificarIndicador({ status, diasSemVender, crescimentoPercentual, unidadesVendidas, unidadesAnterior, mediaVendasPorDia }) {
  if (status !== 'active') return null;

  const semVendaVariosDias = diasSemVender !== null && diasSemVender >= DIAS_SEM_VENDER_RUIM;
  const paroDeVenderVsAnterior = unidadesVendidas === 0 && unidadesAnterior > 0;
  const quedaForte = crescimentoPercentual !== null && crescimentoPercentual <= QUEDA_FORTE_PCT;
  if (semVendaVariosDias || paroDeVenderVsAnterior || quedaForte) return 'baixo';

  const semVendaAtencao = diasSemVender !== null && diasSemVender >= DIAS_SEM_VENDER_ATENCAO;
  const quedaModerada = crescimentoPercentual !== null && crescimentoPercentual <= QUEDA_MODERADA_PCT;
  const praticamenteParado = unidadesVendidas > 0 && mediaVendasPorDia <= MEDIA_DIA_PARADO;
  if (semVendaAtencao || quedaModerada || praticamenteParado) return 'atencao';

  if (unidadesVendidas > 0) return 'bom';
  return 'sem_classificacao';
}

async function gerarPerformanceAnuncios({ empresaId, contaId, sku, status, periodoCalc, desdeStr, ateStr }) {
  const { contasTodas, contasFiltradas } = await buscarContasFiltradas({ empresaId, contaId });
  if (!contasTodas.length) {
    return { semConta: true, lojas: [], situacaoPorConta: [], linhas: [], periodo: null, periodoAnterior: null, criterios: CRITERIOS };
  }

  const { desde, ate } = periodoCalc;
  const periodoAnteriorCalc = periodoAnteriorEquivalente({ desde, ate });

  const contaIdsFiltradas = contasFiltradas.map((c) => c.id);
  const [{ itens: itensAtuais }, { itens: itensAnteriores }, { porItemId: anunciosVivos, situacaoPorConta }, ultimaVendaPorItem] = await Promise.all([
    buscarItensDoPeriodo({ empresaId, desde, ate }),
    buscarItensDoPeriodo({ empresaId, desde: periodoAnteriorCalc.desde, ate: periodoAnteriorCalc.ate }),
    buscarAnunciosVivosPorConta(contasFiltradas),
    buscarUltimaVendaPorAnuncio({ empresaId, contaIds: contaIdsFiltradas, ateStr }),
  ]);

  const itensAtuaisFiltrados = contaId ? itensAtuais.filter((it) => String(it.contaMlId) === String(contaId)) : itensAtuais;
  const itensAnterioresFiltrados = contaId ? itensAnteriores.filter((it) => String(it.contaMlId) === String(contaId)) : itensAnteriores;

  const vendasAtuais = agruparVendasDetalhado(itensAtuaisFiltrados);
  const vendasAnteriores = agruparVendasDetalhado(itensAnterioresFiltrados);

  const skusParaNome = [...vendasAtuais.values()].map((v) => v.sku).concat([...anunciosVivos.values()].map((v) => v.sku));
  const nomesProduto = await buscarNomesProdutoPorSku(empresaId, skusParaNome);

  const diasNoPeriodo = Math.max(1, diasEntre(desde, ate));

  const chaves = new Set([...vendasAtuais.keys(), ...anunciosVivos.keys()]);
  const linhas = [...chaves].map((chave) => {
    const venda = vendasAtuais.get(chave) || null;
    const vivo = anunciosVivos.get(chave) || null;
    const idBruto = (venda && venda.mlItemId) || (vivo && String(vivo.id)) || (chave.startsWith('sem-id:') ? null : chave);
    const identidade = resolverIdentidade({ mlItemId: idBruto, venda, vivo });
    const mlItemId = identidade.mlItemId;
    const vendaAnterior = mlItemId ? (vendasAnteriores.get(mlItemId) || null) : null;

    const unidadesVendidas = venda ? venda.quantidade : 0;
    const unidadesAnterior = vendaAnterior ? vendaAnterior.quantidade : 0;
    const { percentual: crescimentoPercentual, novo: novoNoPeriodo } = calcularCrescimento(unidadesVendidas, unidadesAnterior);
    const mediaVendasPorDia = round2(unidadesVendidas / diasNoPeriodo);

    const ultimaVenda = mlItemId ? (ultimaVendaPorItem.get(mlItemId) || null) : null;
    const diasSemVender = ultimaVenda ? diasEntre(ultimaVenda, ate) : null;
    const semVendaHistorico = !ultimaVenda;

    const sku = identidade.sku;
    const statusAnuncio = identidade.status;

    const indicador = classificarIndicador({
      status: statusAnuncio, diasSemVender, crescimentoPercentual, unidadesVendidas, unidadesAnterior, mediaVendasPorDia,
    });

    return {
      mlItemId,
      imagemUrl: identidade.imagemUrl,
      anuncio: identidade.anuncio,
      sku,
      produto: sku ? (nomesProduto.get(sku) || null) : null,
      loja: identidade.loja,
      contaMlId: identidade.contaMlId,
      status: statusAnuncio,
      precoAtual: identidade.precoAtual,
      unidadesVendidas,
      quantidadePedidos: venda ? venda.quantidadePedidos : 0,
      faturamento: venda ? venda.faturamento : 0,
      mediaVendasPorDia,
      unidadesPeriodoAnterior: unidadesAnterior,
      faturamentoPeriodoAnterior: vendaAnterior ? vendaAnterior.faturamento : 0,
      crescimentoPercentual,
      novoNoPeriodo,
      diasSemVender,
      semVendaHistorico,
      tags: {
        semVendaVariosDias: diasSemVender !== null && diasSemVender >= DIAS_SEM_VENDER_ATENCAO,
        vendendoCadaVezMenos: crescimentoPercentual !== null && crescimentoPercentual <= QUEDA_MODERADA_PCT,
        crescendo: crescimentoPercentual !== null && crescimentoPercentual >= CRESCIMENTO_PCT,
        praticamenteParado: unidadesVendidas > 0 && mediaVendasPorDia <= MEDIA_DIA_PARADO,
      },
      indicador,
      semDadosVivos: !vivo,
      semVendaNoPeriodo: unidadesVendidas === 0,
    };
  });

  // Filtros de SKU/status aplicados aqui (backend) — os mesmos que a tela
  // expõe; ordenação é feita no front-end (mesmo padrão já usado na tela
  // Ads), pra reaproveitar as mesmas linhas sem recarregar o servidor a
  // cada troca de ordenação.
  let linhasFiltradas = linhas;
  if (sku) {
    const alvo = sku.trim().toLowerCase();
    linhasFiltradas = linhasFiltradas.filter((l) => (l.sku || '').toLowerCase().includes(alvo));
  }
  if (status) linhasFiltradas = linhasFiltradas.filter((l) => l.status === status);

  return {
    semConta: false,
    lojas: contasTodas.map((c) => ({ id: c.id, nickname: c.nickname })),
    situacaoPorConta,
    periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde, ate },
    periodoAnterior: { desde: periodoAnteriorCalc.desde, ate: periodoAnteriorCalc.ate },
    linhas: linhasFiltradas,
    criterios: CRITERIOS,
  };
}

module.exports = { gerarPerformanceAnuncios, classificarIndicador, CRITERIOS };
