// Ferramentas (function calling) da IA Gestora — ativada em 2026, 3 passos
// pedidos pelo usuário (ver docs/02-decisoes.md e docs/04-alteracoes.md).
//
// Regras centrais do usuário, repetidas aqui de propósito (mesma filosofia
// já usada em lib/visaoGeralPainel.js):
//   1) "A IA NÃO deve responder números inventados. Ela deve consultar os
//      dados reais do sistema através do backend." — por isso cada
//      ferramenta abaixo é só uma casca fina em cima das mesmas funções já
//      usadas por Visão Geral/Pedidos/Financeiro/Relatórios/DRE/Contas a
//      Pagar/Contas a Receber/Estoque. NENHUM cálculo financeiro novo é
//      criado neste arquivo.
//   2) "Não quero uma segunda regra financeira criada só para a IA." — as
//      mesmas fontes de sempre: lib/relatorioVendas.js, lib/dre.js,
//      lib/contasPagar.js, lib/contasReceber.js, lib/relatoriosAgregados.js,
//      lib/visaoGeralPainel.js (alertas — reaproveitado, não reescrito) e a
//      tabela ml_estoque_itens (mesma fonte de Estoque/Estoque Full).
//   3) "A IA precisa respeitar: empresa selecionada; período selecionado;
//      permissões do usuário." — empresaId e período NUNCA são um parâmetro
//      que o modelo escolhe: eles ficam presos no `contexto` (criado uma
//      vez por pergunta, a partir do que o front-end mandou do header) e
//      cada ferramenta só enxerga esse contexto, nunca um empresaId vindo
//      do texto da pergunta ou de uma decisão do modelo. Isso torna
//      estruturalmente impossível a IA responder com dado de uma empresa
//      diferente da selecionada. (Sobre "permissões do usuário": este ERP
//      ainda não tem tela/rota de login nem permissão por usuário — ver
//      docs/00-visao-geral.md/"users" — então hoje o único controle de
//      acesso que existe, em qualquer tela do sistema, é "existe uma
//      empresa com esse ID" (routes/iaGestora.js valida isso antes de
//      qualquer pergunta, mesmo padrão de todo o resto da API). Quando o
//      login/permissão por usuário existir, o lugar certo de aplicar essa
//      checagem é aqui, antes de `criarContexto` devolver os dados.)
//   4) "Não envie para o modelo mais dados do que o necessário para
//      responder à pergunta." — cada ferramenta devolve só um resumo já
//      agregado (nunca a lista bruta de pedidos/itens) — a lista de
//      pedidos/itens do período é buscada no máximo uma vez por pergunta
//      (cache em `contexto`), mas nunca sai daqui inteira para o modelo.
const pool = require('../../db/pool');
const { calcularPeriodo, periodoParaDatasBRT } = require('../periodo');
const { buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo } = require('../relatorioVendas');
const { gerarDRE } = require('../dre');
const { resumoContasPagar } = require('../contasPagar');
const { resumoContasReceber } = require('../contasReceber');
const { relatorioProdutos, relatorioMarketplaces } = require('../relatoriosAgregados');
const { gerarAlertas, conexoesEEmpresas, resumoRecebimentos, ESTOQUE_BAIXO_LIMITE } = require('../visaoGeralPainel');

function formatMoneyOuNull(v) {
  if (v === null || v === undefined) return null;
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Formato de resposta padrão pra um campo {valor,pendentes} (o mesmo
// formato já usado por resumirPeriodo/somarComPendencia em
// lib/relatorioVendas.js) — deixa explícito pro modelo, em texto, quando um
// valor está indisponível E por quê (nunca um número no lugar de um "não
// sei"), pra ele nunca precisar adivinhar o motivo.
function campoResposta({ valor, pendentes }) {
  return {
    valor,
    valorFormatado: formatMoneyOuNull(valor),
    disponivel: valor !== null,
    pedidosSemEssaInformacao: pendentes || 0,
  };
}

function linhaResposta(linha) {
  return {
    valor: linha.valor,
    valorFormatado: formatMoneyOuNull(linha.valor),
    disponivel: linha.valor !== null,
    percentualSobreFaturamento: linha.percentual === undefined ? null : linha.percentual,
    pedidosSemEssaInformacao: linha.pendentes || 0,
  };
}

// Contexto de uma pergunta: empresa e período NUNCA vêm do modelo — vêm só
// do que o front-end mandou (o mesmo header/CerneFiltro usado em todo o
// resto do ERP). Cache simples pra nunca buscar pedidos/itens do período
// mais de uma vez, mesmo que o modelo chame várias ferramentas na mesma
// pergunta.
function criarContexto({ empresaId, periodoChave }) {
  const periodoCalc = calcularPeriodo(periodoChave);
  const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);
  const empresaIdNum = Number(empresaId);
  let promessaPedidos = null;
  let promessaItens = null;
  return {
    empresaId: empresaIdNum,
    periodoCalc,
    desdeStr,
    ateStr,
    pedidos() {
      if (!promessaPedidos) {
        promessaPedidos = buscarPedidosDoPeriodo({ empresaId: empresaIdNum, desde: periodoCalc.desde, ate: periodoCalc.ate })
          .then((r) => r.pedidos);
      }
      return promessaPedidos;
    },
    itens() {
      if (!promessaItens) {
        promessaItens = buscarItensDoPeriodo({ empresaId: empresaIdNum, desde: periodoCalc.desde, ate: periodoCalc.ate })
          .then((r) => r.itens);
      }
      return promessaItens;
    },
  };
}

// ---------------- Ferramentas ----------------

async function handleResumoVendas(_input, ctx) {
  const pedidos = await ctx.pedidos();
  const r = resumirPeriodo(pedidos);
  return {
    periodo: ctx.periodoCalc.label,
    // Distingue "não houve nenhum pedido no período" (valor null com
    // pedidosSemEssaInformacao 0 — mesma convenção de "Sem dados" já usada
    // em Visão Geral/DRE) de "houve pedido, mas falta alguma informação"
    // (valor null com pedidosSemEssaInformacao > 0 — "Pendente"). O modelo
    // usa este campo pra nunca confundir os dois casos na resposta.
    temPedidoNoPeriodo: (r.qtdPedidos + r.cancelados.quantidade) > 0,
    quantidadePedidos: r.qtdPedidos,
    faturamento: campoResposta(r.faturamento),
    margemContribuicao: campoResposta(r.margemContribuicao),
    margemContribuicaoPercentual: r.margemPercentual,
    taxasEComissoesMarketplace: campoResposta(r.tarifas),
    freteDoVendedor: campoResposta(r.freteVendedor),
    impostos: campoResposta(r.imposto),
    custoDosProdutos: campoResposta(r.custoProduto),
    descontosDeCupom: campoResposta(r.desconto),
    pedidosCancelados: { quantidade: r.cancelados.quantidade, valor: r.cancelados.valor, valorFormatado: formatMoneyOuNull(r.cancelados.valor) },
    observacao: 'Mesmos números mostrados em Visão Geral, Pedidos e Financeiro para esta empresa e período — pedidos cancelados nunca entram nestes totais.',
  };
}

async function handleResultadoPeriodo(_input, ctx) {
  const dre = await gerarDRE({
    empresaId: ctx.empresaId,
    desde: ctx.periodoCalc.desde,
    ate: ctx.periodoCalc.ate,
    desdeBRT: ctx.desdeStr,
    ateBRT: ctx.ateStr,
  });
  const l = dre.linhas;
  return {
    periodo: ctx.periodoCalc.label,
    temPedidoNoPeriodo: dre.hasOrders,
    margemContribuicao: linhaResposta(l.margemContribuicao),
    despesasPagasNoPeriodo: linhaResposta(l.despesasPeriodo),
    resultadoFinal: linhaResposta(l.resultadoFinal),
    observacao: 'Resultado Final = Margem de Contribuição das vendas do período menos as despesas (Contas a Pagar) efetivamente PAGAS no mesmo período — é o número mais próximo de "lucro" já calculado neste ERP (mesmo demonstrativo da tela DRE). Despesas pagas contam mesmo em período sem nenhuma venda.',
  };
}

async function handleProdutosDesempenho(input, ctx) {
  const { linhas } = await relatorioProdutos({ empresaId: ctx.empresaId, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
  const comMargem = linhas.filter((l) => l.margemContribuicao !== null);
  const ordenarPor = input && input.ordenarPor === 'prejuizo' ? 'prejuizo' : 'lucro';
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 5, 1), 20);

  const selecionados = ordenarPor === 'prejuizo'
    ? comMargem.filter((l) => l.margemContribuicao < 0).sort((a, b) => a.margemContribuicao - b.margemContribuicao)
    : [...comMargem].sort((a, b) => b.margemContribuicao - a.margemContribuicao);

  return {
    periodo: ctx.periodoCalc.label,
    criterio: ordenarPor,
    produtos: selecionados.slice(0, limite).map((l) => ({
      sku: l.sku,
      quantidadeVendida: l.quantidade,
      faturamento: l.faturamento,
      faturamentoFormatado: formatMoneyOuNull(l.faturamento),
      margemContribuicao: l.margemContribuicao,
      margemContribuicaoFormatada: formatMoneyOuNull(l.margemContribuicao),
    })),
    totalSkusVendidosNoPeriodo: linhas.length,
    skusSemMargemCalculavel: linhas.length - comMargem.length,
    observacao: 'Margem por SKU decompõe o mesmo pedido usado em Pedidos/DRE/Financeiro (rateio de frete/taxas/desconto quando o pedido tem mais de 1 item — nunca um cálculo novo). SKU sem custo cadastrado fica de fora da lista (não tem margem calculável).',
  };
}

async function handleSkusSemCusto(_input, ctx) {
  const itens = await ctx.itens();
  const semCusto = itens.filter((it) => it.sku && it.custoProduto === null);
  const skusUnicos = [...new Set(semCusto.map((it) => it.sku))];
  const LIMITE_LISTA = 30;
  return {
    periodo: ctx.periodoCalc.label,
    quantidadeSkusSemCusto: skusUnicos.length,
    skus: skusUnicos.slice(0, LIMITE_LISTA),
    listaTruncada: skusUnicos.length > LIMITE_LISTA,
    observacao: 'Baseado nos itens efetivamente vendidos no período e empresa selecionados — um SKU só aparece aqui se foi vendido em algum pedido sem ter custo cadastrado na tela Produtos. Cadastrar o custo faz o SKU sair desta lista e a margem das vendas dele passar a ser calculada.',
  };
}

async function handleContasAReceber(_input, ctx) {
  const [resumo, pedidos] = await Promise.all([
    resumoContasReceber({ empresaId: ctx.empresaId, desde: ctx.desdeStr, ate: ctx.ateStr }),
    ctx.pedidos(),
  ]);
  const recebimentosMl = resumoRecebimentos(pedidos);
  return {
    periodo: ctx.periodoCalc.label,
    totalAReceberEmAberto: { valor: resumo.totalAReceber, valorFormatado: formatMoneyOuNull(resumo.totalAReceber) },
    previstoParaHoje: { valor: resumo.previstoHoje, valorFormatado: formatMoneyOuNull(resumo.previstoHoje) },
    atrasado: { valor: resumo.atrasado, valorFormatado: formatMoneyOuNull(resumo.atrasado) },
    recebidoNoPeriodoSelecionado: { valor: resumo.recebidoNoPeriodo, valorFormatado: formatMoneyOuNull(resumo.recebidoNoPeriodo) },
    recebimentosMercadoLivreEsperadosNoPeriodo: campoResposta({ valor: recebimentosMl.valorLiquidoEsperado, pendentes: recebimentosMl.pendentes }),
    observacao: '"Total a receber em aberto", "previsto para hoje" e "atrasado" são o saldo ATUAL de Contas a Receber (lançamento manual), independente do período do header — só "recebido no período" e os recebimentos do Mercado Livre usam o período selecionado.',
  };
}

async function handleContasAPagar(_input, ctx) {
  const resumo = await resumoContasPagar({ empresaId: ctx.empresaId, desde: ctx.desdeStr, ate: ctx.ateStr });
  return {
    periodo: ctx.periodoCalc.label,
    totalAPagarEmAberto: { valor: resumo.totalAPagar, valorFormatado: formatMoneyOuNull(resumo.totalAPagar) },
    vencendoHoje: { valor: resumo.vencendoHoje, valorFormatado: formatMoneyOuNull(resumo.vencendoHoje) },
    vencidas: { valor: resumo.vencidas, valorFormatado: formatMoneyOuNull(resumo.vencidas) },
    pagoNoPeriodoSelecionado: { valor: resumo.pagasNoPeriodo, valorFormatado: formatMoneyOuNull(resumo.pagasNoPeriodo) },
    observacao: '"Total a pagar em aberto", "vencendo hoje" e "vencidas" são o saldo ATUAL de Contas a Pagar, independente do período do header — só "pago no período" usa o período selecionado.',
  };
}

async function handleEstoqueResumo(_input, ctx) {
  const { rows } = await pool.query(
    `SELECT tipo, quantidade, pendente FROM ml_estoque_itens WHERE empresa_id = $1`,
    [ctx.empresaId]
  );

  function resumoTipo(tipo) {
    const doTipo = rows.filter((r) => r.tipo === tipo);
    const sincronizados = doTipo.filter((r) => !r.pendente && r.quantidade !== null);
    const pendentes = doTipo.length - sincronizados.length;
    const zerados = sincronizados.filter((r) => Number(r.quantidade) === 0).length;
    const baixos = sincronizados.filter((r) => Number(r.quantidade) > 0 && Number(r.quantidade) <= ESTOQUE_BAIXO_LIMITE).length;
    return {
      totalAnuncios: doTipo.length,
      anunciosSincronizados: sincronizados.length,
      anunciosPendentesDeSincronizacao: pendentes,
      unidadesDisponiveis: sincronizados.length ? sincronizados.reduce((s, r) => s + Number(r.quantidade), 0) : (doTipo.length ? null : 0),
      anunciosComEstoqueZerado: zerados,
      anunciosComEstoqueMuitoBaixo: baixos,
    };
  }

  return {
    limiteConsideradoEstoqueBaixo: ESTOQUE_BAIXO_LIMITE,
    foraDoFull: resumoTipo('proprio'),
    full: resumoTipo('full'),
    observacao: 'Estoque é sempre um espelho ao vivo do que o Mercado Livre retornou (sincronizado automaticamente a cada 1 minuto) — depende só da empresa selecionada, nunca do período do header. Quantidade "pendente" nunca é somada como zero.',
  };
}

async function handleDesempenhoPorLoja(input, ctx) {
  const { linhas } = await relatorioMarketplaces({ empresaId: ctx.empresaId, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
  const ordenarPor = input && input.ordenarPor === 'margem' ? 'margem' : 'faturamento';
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 10, 1), 20);

  const chaveOrdenacao = (l) => (ordenarPor === 'margem' ? l.resumo.margemContribuicao.valor : l.resumo.faturamento.valor);
  const ordenado = [...linhas].sort((a, b) => {
    const va = chaveOrdenacao(a), vb = chaveOrdenacao(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va;
  });

  return {
    periodo: ctx.periodoCalc.label,
    criterio: ordenarPor,
    contasMercadoLivre: ordenado.slice(0, limite).map((l) => ({
      loja: l.loja || ('Conta ' + l.contaMlId),
      quantidadePedidos: l.resumo.qtdPedidos,
      faturamento: campoResposta(l.resumo.faturamento),
      margemContribuicao: campoResposta(l.resumo.margemContribuicao),
      margemContribuicaoPercentual: l.resumo.margemPercentual,
    })),
    totalContasComVendaNoPeriodo: linhas.length,
    observacao: 'Hoje o ERP só integra o Mercado Livre — quando uma segunda integração (ex: Shopee) existir, ela aparece aqui automaticamente.',
  };
}

async function handleAlertasOperacionais(_input, ctx) {
  const [pedidos, itens, conexoes, contasAPagar, contasAReceber] = await Promise.all([
    ctx.pedidos(),
    ctx.itens(),
    conexoesEEmpresas(ctx.empresaId),
    resumoContasPagar({ empresaId: ctx.empresaId, desde: ctx.desdeStr, ate: ctx.ateStr }),
    resumoContasReceber({ empresaId: ctx.empresaId, desde: ctx.desdeStr, ate: ctx.ateStr }),
  ]);
  const alertas = await gerarAlertas({ empresaId: ctx.empresaId, pedidos, itens, fluxoCaixa: { contasAPagar, contasAReceber }, conexoes });
  return {
    periodo: ctx.periodoCalc.label,
    quantidadeDeAlertas: alertas.length,
    alertas: alertas.map((a) => ({ tipo: a.tipo, severidade: a.severidade, titulo: a.titulo, descricao: a.descricao, telaRelacionada: a.pagina })),
    observacao: alertas.length
      ? 'Mesmos alertas (mesmas regras) já mostrados em Visão Geral > Alertas & IA.'
      : 'Nenhum alerta ativo no momento, pelas mesmas regras já usadas em Visão Geral > Alertas & IA.',
  };
}

// ---------------- Catálogo (schema de ferramentas + despacho) ----------------

const FERRAMENTAS = [
  {
    name: 'resumo_vendas',
    description: 'Resumo de vendas da empresa e período selecionados: faturamento, quantidade de pedidos, margem de contribuição (R$ e %), taxas/comissões do marketplace, frete do vendedor, impostos, custo dos produtos, descontos de cupom e pedidos cancelados. Use para perguntas como "quanto vendi", "quanto gastei com taxas/frete", "qual minha margem de contribuição".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleResumoVendas,
  },
  {
    name: 'resultado_periodo',
    description: 'Resultado final (o mais próximo de "lucro" já calculado no ERP) da empresa e período selecionados: Margem de Contribuição das vendas menos as despesas (Contas a Pagar) pagas no mesmo período — mesmo demonstrativo da tela DRE. Use para perguntas como "quanto estou lucrando" ou "qual meu resultado".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleResultadoPeriodo,
  },
  {
    name: 'produtos_desempenho',
    description: 'Lista os produtos (por SKU) com mais lucro ou mais prejuízo (margem de contribuição) no período e empresa selecionados. Use para "qual produto está dando mais lucro" (ordenarPor=lucro) ou "qual produto está dando prejuízo" (ordenarPor=prejuizo).',
    input_schema: {
      type: 'object',
      properties: {
        ordenarPor: { type: 'string', enum: ['lucro', 'prejuizo'], description: 'lucro = maior margem de contribuição primeiro; prejuizo = só produtos com margem negativa, do mais negativo pro menos negativo.' },
        limite: { type: 'integer', minimum: 1, maximum: 20, description: 'Quantos produtos retornar (padrão 5).' },
      },
      additionalProperties: false,
    },
    handler: handleProdutosDesempenho,
  },
  {
    name: 'skus_sem_custo',
    description: 'Lista os SKUs que foram vendidos no período e empresa selecionados mas ainda não têm custo cadastrado em Produtos — por isso a margem dessas vendas não pode ser calculada. Use para "quais SKUs estão sem custo cadastrado".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleSkusSemCusto,
  },
  {
    name: 'contas_a_receber_resumo',
    description: 'Saldo de Contas a Receber da empresa selecionada (total em aberto, vencendo hoje, atrasado — sempre o saldo atual) e recebido/esperado do Mercado Livre no período selecionado. Use para "quanto tenho para receber".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleContasAReceber,
  },
  {
    name: 'contas_a_pagar_resumo',
    description: 'Saldo de Contas a Pagar da empresa selecionada (total em aberto, vencendo hoje, vencidas — sempre o saldo atual) e pago no período selecionado. Use para "quanto tenho para pagar".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleContasAPagar,
  },
  {
    name: 'estoque_resumo',
    description: 'Resumo do estoque da empresa selecionada (fora do Full e Full, separados): total de anúncios, quantos já sincronizaram, unidades disponíveis, quantos estão com estoque zerado ou muito baixo. Não depende do período selecionado (estoque é sempre um espelho ao vivo do Mercado Livre). Use para "como está meu estoque".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleEstoqueResumo,
  },
  {
    name: 'desempenho_por_loja',
    description: 'Compara as contas do Mercado Livre conectadas à empresa selecionada, no período selecionado, por faturamento ou por margem de contribuição. Use para "qual conta do Mercado Livre está performando melhor".',
    input_schema: {
      type: 'object',
      properties: {
        ordenarPor: { type: 'string', enum: ['faturamento', 'margem'], description: 'Critério de comparação (padrão faturamento).' },
        limite: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    handler: handleDesempenhoPorLoja,
  },
  {
    name: 'alertas_operacionais',
    description: 'Lista os alertas ativos agora para a empresa e período selecionados (SKU sem custo, pedido sem custo, margem negativa, erro de sincronização do Mercado Livre, conta a pagar vencida, recebimento atrasado, estoque zerado/baixo) — mesma central de Visão Geral > Alertas & IA. Use para "quais problemas precisam da minha atenção" ou "tem alguma venda dando prejuízo".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleAlertasOperacionais,
  },
];

const FERRAMENTAS_POR_NOME = new Map(FERRAMENTAS.map((f) => [f.name, f]));

// Schema no formato que a API de Mensagens da Anthropic espera — sem o
// `handler` (que é implementação interna, nunca deve viajar pra fora do
// backend).
const FERRAMENTAS_SCHEMA = FERRAMENTAS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

async function executarFerramenta(nome, input, ctx) {
  const ferramenta = FERRAMENTAS_POR_NOME.get(nome);
  if (!ferramenta) {
    return { erro: `Ferramenta "${nome}" não existe.` };
  }
  try {
    return await ferramenta.handler(input || {}, ctx);
  } catch (err) {
    return { erro: 'Não foi possível consultar esse dado agora: ' + (err.message || 'erro desconhecido.') };
  }
}

module.exports = {
  FERRAMENTAS_SCHEMA,
  criarContexto,
  executarFerramenta,
};
