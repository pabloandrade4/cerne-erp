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
//      diferente da selecionada. (Sobre "permissões do usuário": desde a
//      tarefa "IA Gestora — central de análise" (25/08/2026) a IA Gestora
//      passou a exigir login real — ver lib/auth/ e routes/iaGestora.js — a
//      checagem de "quem pode perguntar" acontece ali, na rota, ANTES de
//      chegar aqui, via o middleware exigirLogin. O que continua igual: uma
//      "empresa" em si não pertence a um usuário específico — qualquer
//      login válido pode selecionar qualquer empresa ativa no cabeçalho,
//      igual a todo o resto do ERP hoje. O que É por usuário, de verdade, é
//      o HISTÓRICO de conversas — ver ia_conversas.usuario_id no schema —
//      nunca a lista de empresas em si.)
//   4) "Não envie para o modelo mais dados do que o necessário para
//      responder à pergunta." — cada ferramenta devolve só um resumo já
//      agregado (nunca a lista bruta de pedidos/itens) — a lista de
//      pedidos/itens do período é buscada no máximo uma vez por pergunta
//      (cache em `contexto`), mas nunca sai daqui inteira para o modelo.
const pool = require('../../db/pool');
const { calcularPeriodo, periodoParaDatasBRT, diaBRT } = require('../periodo');
const { buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo } = require('../relatorioVendas');
const { gerarDRE } = require('../dre');
const { resumoContasPagar } = require('../contasPagar');
const { resumoContasReceber } = require('../contasReceber');
const { relatorioProdutos, relatorioProdutosPorCaixa, relatorioMarketplaces } = require('../relatoriosAgregados');
const { gerarAlertas, conexoesEEmpresas, resumoRecebimentos, fluxoDeCaixa, ESTOQUE_BAIXO_LIMITE } = require('../visaoGeralPainel');
const { listarAds } = require('../ads');
const { resumoComprasPorFornecedor } = require('../compras');
const { listarNotasFiscais } = require('../notasFiscais');
const { consultarDocumentacao, TEMAS: TEMAS_DOCUMENTACAO } = require('./baseConhecimento');
const { round2 } = require('../resultadoVenda');
const { calcularEstoqueFisico } = require('../estoqueFisico');
// Passo 3 da tarefa "Recebimentos + Fluxo de Caixa + IA Gestora"
// (27/08/2026, ver docs/02-decisoes.md): a IA Gestora ganha acesso SOMENTE
// DE LEITURA aos dados novos do Passo 1 (recebimentos de marketplace
// organizados por status) e do Passo 2 (extrato bancário importado +
// conciliação) — 3 ferramentas ADITIVAS abaixo (recebimentos_marketplace_resumo,
// fluxo_de_caixa_detalhado, extrato_bancario_analise), todas cascas finas
// sobre lib/recebimentosMl.js/lib/fluxoCaixa.js/lib/extratoBancario.js
// (mesmas fontes da tela, nenhuma fórmula nova). NUNCA modificam nada — só
// leem. As ferramentas 'fluxo_de_caixa' (linha ~530 abaixo) e
// 'contas_a_receber_resumo'/'contas_a_pagar_resumo' já existentes e
// validadas continuam INTOCADAS.
const recebimentosMl = require('../recebimentosMl');
const { gerarFluxoDeCaixa } = require('../fluxoCaixa');
const extratoBancario = require('../extratoBancario');

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
  const ordenarPor = ['prejuizo', 'faturamento', 'quantidade'].includes(input && input.ordenarPor) ? input.ordenarPor : 'lucro';
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 5, 1), 20);

  let selecionados;
  if (ordenarPor === 'prejuizo') {
    selecionados = comMargem.filter((l) => l.margemContribuicao < 0).sort((a, b) => a.margemContribuicao - b.margemContribuicao);
  } else if (ordenarPor === 'faturamento') {
    // Faturamento de um SKU nunca é pendente (só a margem depende de custo
    // cadastrado) — por isso usa `linhas` inteiro, não só `comMargem`.
    selecionados = [...linhas].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0));
  } else if (ordenarPor === 'quantidade') {
    selecionados = [...linhas].sort((a, b) => (b.quantidade || 0) - (a.quantidade || 0));
  } else {
    selecionados = [...comMargem].sort((a, b) => b.margemContribuicao - a.margemContribuicao);
  }

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
    observacao: 'Margem por SKU decompõe o mesmo pedido usado em Pedidos/DRE/Financeiro (rateio de frete/taxas/desconto quando o pedido tem mais de 1 item — nunca um cálculo novo). SKU sem custo cadastrado fica de fora do critério "lucro"/"prejuizo" (não tem margem calculável), mas continua contando em "faturamento"/"quantidade".',
  };
}

// "Modelo de caixa mais vendido em unidades físicas" e demais perguntas de
// produto físico (não SKU/kit) — casca fina sobre
// relatoriosAgregados.relatorioProdutosPorCaixa (mesma fonte, mesma regra de
// identificação determinística de produto base — ver docs/01-regras-de-
// negocio.md, seção Relatórios).
async function handleProdutosPorCaixa(input, ctx) {
  const { linhas, semProdutoBase } = await relatorioProdutosPorCaixa({ empresaId: ctx.empresaId, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
  const ordenarPor = input && input.ordenarPor === 'faturamento' ? 'faturamento' : 'caixas';
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 5, 1), 20);

  const ordenado = ordenarPor === 'faturamento'
    ? [...linhas].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0))
    : [...linhas].sort((a, b) => (b.quantidadeCaixas || 0) - (a.quantidadeCaixas || 0));

  const kitsSemProdutoBase = semProdutoBase.reduce((s, l) => s + l.kitsVendidos, 0);

  return {
    periodo: ctx.periodoCalc.label,
    criterio: ordenarPor,
    produtosBase: ordenado.slice(0, limite).map((l) => ({
      produtoBase: l.produtoBase,
      caixasFisicasVendidas: l.quantidadeCaixas,
      kitsVendidos: l.kitsVendidos,
      faturamento: l.faturamento,
      faturamentoFormatado: formatMoneyOuNull(l.faturamento),
      quantidadePedidos: l.quantidadePedidos,
      identificacaoPorPadraoDeSku: l.origemHeuristica,
    })),
    totalProdutosBaseNoPeriodo: linhas.length,
    skusSemProdutoBaseIdentificado: semProdutoBase.length,
    kitsVendidosSemProdutoBaseIdentificado: kitsSemProdutoBase,
    observacao: 'Caixas físicas vendidas = kits vendidos × unidades por kit do SKU, somado pelo produto base (mesma visão "Por Caixa" de Relatórios > Produtos — nenhum cálculo novo). "Faturamento" é a soma de todos os SKUs/kit daquele produto base, nunca dividido pela quantidade de caixas. SKUs sem produto base identificado ficam de fora deste agrupamento (nunca chutados).',
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
    previstoProximos7Dias: { valor: resumo.previstoProximos7Dias, valorFormatado: formatMoneyOuNull(resumo.previstoProximos7Dias) },
    recebidoNoPeriodoSelecionado: { valor: resumo.recebidoNoPeriodo, valorFormatado: formatMoneyOuNull(resumo.recebidoNoPeriodo) },
    recebimentosMercadoLivreEsperadosNoPeriodo: campoResposta({ valor: recebimentosMl.valorLiquidoEsperado, pendentes: recebimentosMl.pendentes }),
    observacao: '"Total a receber em aberto", "previsto para hoje", "atrasado" e "previsto próximos 7 dias" são o saldo ATUAL de Contas a Receber (lançamento manual), independente do período do header — só "recebido no período" e os recebimentos do Mercado Livre usam o período selecionado. "Previsto" nunca é dinheiro já disponível — é uma expectativa, não um saldo em caixa.',
  };
}

async function handleContasAPagar(_input, ctx) {
  const resumo = await resumoContasPagar({ empresaId: ctx.empresaId, desde: ctx.desdeStr, ate: ctx.ateStr });
  return {
    periodo: ctx.periodoCalc.label,
    totalAPagarEmAberto: { valor: resumo.totalAPagar, valorFormatado: formatMoneyOuNull(resumo.totalAPagar) },
    vencendoHoje: { valor: resumo.vencendoHoje, valorFormatado: formatMoneyOuNull(resumo.vencendoHoje) },
    vencidas: { valor: resumo.vencidas, valorFormatado: formatMoneyOuNull(resumo.vencidas) },
    vencendoProximos7Dias: { valor: resumo.vencendoProximos7Dias, valorFormatado: formatMoneyOuNull(resumo.vencendoProximos7Dias) },
    pagoNoPeriodoSelecionado: { valor: resumo.pagasNoPeriodo, valorFormatado: formatMoneyOuNull(resumo.pagasNoPeriodo) },
    observacao: '"Total a pagar em aberto", "vencendo hoje", "vencidas" e "vencendo próximos 7 dias" são o saldo ATUAL de Contas a Pagar, independente do período do header — só "pago no período" usa o período selecionado.',
  };
}

// "Vendas com prejuízo" — mesmo filtro já usado no alerta "margem-negativa"
// de Visão Geral > Alertas & IA (lib/visaoGeralPainel.js/gerarAlertas), só
// que devolvendo a lista de pedidos em vez de só a contagem.
async function handleVendasComPrejuizo(input, ctx) {
  const pedidos = await ctx.pedidos();
  const comPrejuizo = pedidos
    .filter((p) => !p.cancelado && p.calculoCompleto && p.margemContribuicao < 0)
    .sort((a, b) => a.margemContribuicao - b.margemContribuicao);
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 10, 1), 30);

  return {
    periodo: ctx.periodoCalc.label,
    quantidadeVendasComPrejuizo: comPrejuizo.length,
    vendas: comPrejuizo.slice(0, limite).map((p) => ({
      numeroPedido: p.mlOrderId,
      loja: p.loja,
      produtoOuSku: p.skuResumo || p.produtoResumo,
      data: p.dataEfetiva ? diaBRT(p.dataEfetiva) : null,
      valorVenda: p.valorTotal,
      valorVendaFormatado: formatMoneyOuNull(p.valorTotal),
      margemContribuicao: p.margemContribuicao,
      margemContribuicaoFormatada: formatMoneyOuNull(p.margemContribuicao),
    })),
    listaTruncada: comPrejuizo.length > limite,
    observacao: 'Só considera pedidos com o cálculo de margem completo (nunca um pedido com informação faltando classificado como prejuízo por engano) — mesmo critério do alerta "margem de contribuição negativa" de Visão Geral > Alertas & IA.',
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

// "Dinheiro parado em estoque"/"matéria-prima em estoque" — corrigido em
// 26/08/2026 (ver docs/02-decisoes.md, tarefa "IA Gestora: corrigir análise
// do Estoque Full"). SEMPRE em quantidade FÍSICA (kits/caixas já
// convertidos em unidades reais pela mesma regra normalizada do Relatório
// de Produtos > "Por Caixa" — lib/estoqueFisico.js) × custo cadastrado em
// Produto Base — nunca o preço de venda, nunca o custo do kit exato. Estoque
// (fora do Full) e Estoque Full são SEMPRE somados separadamente, nunca um
// único total consolidado sem explicar quanto pertence a cada um (pedido
// explícito do usuário). Um produto físico sem custo cadastrado, ou um SKU
// sem produto base identificado, nunca entra na soma — fica relatado à
// parte, nunca com custo zero fingindo ser um valor real.
async function handleEstoqueValorParado(_input, ctx) {
  const dados = await calcularEstoqueFisico(ctx.empresaId);
  const semCustoTotal = dados.full.unidadesFisicasSemCustoCadastrado + dados.foraDoFull.unidadesFisicasSemCustoCadastrado;
  const semProdutoBaseTotal = dados.full.unidadesSemProdutoBaseIdentificado + dados.foraDoFull.unidadesSemProdutoBaseIdentificado;

  const observacoes = [
    'Valor a custo = quantidade FÍSICA (kits já convertidos em unidades reais, mesma regra do Relatório de Produtos > "Por Caixa") × custo cadastrado em Produto Base — nunca o preço de venda. Estoque (fora do Full) e Estoque Full são sempre somados separadamente, nunca misturados num total único.',
  ];
  if (semCustoTotal > 0) observacoes.push(`${semCustoTotal} unidades não entraram no cálculo porque o produto está sem custo cadastrado.`);
  if (semProdutoBaseTotal > 0) observacoes.push(`${semProdutoBaseTotal} unidades não entraram no cálculo porque o SKU não pôde ser identificado a um produto base.`);

  return {
    valorEstoqueNormal: { valor: dados.foraDoFull.valorTotalACusto, valorFormatado: formatMoneyOuNull(dados.foraDoFull.valorTotalACusto) },
    valorEstoqueFull: { valor: dados.full.valorTotalACusto, valorFormatado: formatMoneyOuNull(dados.full.valorTotalACusto) },
    valorTotal: { valor: dados.valorTotalGeral, valorFormatado: formatMoneyOuNull(dados.valorTotalGeral) },
    unidadesFisicasForaDoFull: dados.foraDoFull.unidadesFisicas,
    unidadesFisicasFull: dados.full.unidadesFisicas,
    unidadesSemCustoCadastrado: semCustoTotal,
    unidadesSemProdutoBaseIdentificado: semProdutoBaseTotal,
    emTransitoOuAguardandoConferencia: 'Ainda não consigo consultar o estoque em trânsito pelo ERP.',
    observacao: observacoes.join(' '),
  };
}

// Detalhe por produto FÍSICO (Full e/ou fora do Full, separados), com
// filtro opcional por produto base e limite — responde perguntas como
// "quantas caixas físicas tenho no Full", "quanto tenho da caixa
// 20x20x20 no Full" ou "quais produtos representam mais dinheiro no
// Full/estoque". Mesma fonte/regra de handleEstoqueValorParado
// (lib/estoqueFisico.js) — nenhum cálculo novo.
async function handleEstoqueFisicoDetalhado(input, ctx) {
  const dados = await calcularEstoqueFisico(ctx.empresaId);
  const escopo = ['full', 'fora_do_full', 'ambos'].includes(input && input.escopo) ? input.escopo : 'full';
  const filtroTexto = input && input.produtoBase ? String(input.produtoBase).trim() : null;
  const filtroBusca = filtroTexto ? filtroTexto.toUpperCase() : null;
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 10, 1), 30);

  function montarBloco(dadosBloco) {
    let produtosBase = dadosBloco.produtosBase;
    if (filtroBusca) produtosBase = produtosBase.filter((p) => p.produtoBase.toUpperCase().includes(filtroBusca));
    return {
      valorTotalACusto: dadosBloco.valorTotalACusto,
      valorTotalACustoFormatado: formatMoneyOuNull(dadosBloco.valorTotalACusto),
      unidadesFisicas: filtroBusca ? produtosBase.reduce((s, p) => s + p.quantidadeFisica, 0) : dadosBloco.unidadesFisicas,
      produtos: produtosBase.slice(0, limite).map((p) => ({
        produto: p.produtoBase,
        unidadesFisicas: p.quantidadeFisica,
        custoUnitario: p.custoUnitario,
        custoUnitarioFormatado: formatMoneyOuNull(p.custoUnitario),
        valorEmEstoque: p.valorEmEstoque,
        valorEmEstoqueFormatado: formatMoneyOuNull(p.valorEmEstoque),
      })),
      unidadesSemCustoCadastrado: dadosBloco.unidadesFisicasSemCustoCadastrado,
      unidadesSemProdutoBaseIdentificado: dadosBloco.unidadesSemProdutoBaseIdentificado,
    };
  }

  const resposta = {
    escopo,
    marketplace: dados.marketplace,
    fullDisponivel: 'Produtos já recebidos e disponíveis no centro de distribuição do Mercado Livre.',
    fullEmTransitoOuAguardandoConferencia: 'Ainda não consigo consultar o estoque em trânsito pelo ERP.',
  };
  if (escopo === 'full' || escopo === 'ambos') resposta.full = montarBloco(dados.full);
  if (escopo === 'fora_do_full' || escopo === 'ambos') resposta.foraDoFull = montarBloco(dados.foraDoFull);

  const nadaEncontrado = filtroBusca && (!resposta.full || !resposta.full.produtos.length) && (!resposta.foraDoFull || !resposta.foraDoFull.produtos.length);
  resposta.observacao = 'Quantidade física já converte kits/caixas do Mercado Livre em unidades reais (mesma regra do Relatório de Produtos > "Por Caixa"); custo é sempre o cadastrado em Produto Base (nunca o preço de venda).'
    + (nadaEncontrado ? ` Nenhum produto físico encontrado com "${filtroTexto}" — confira o código cadastrado em Produto Base.` : '');

  return resposta;
}

// Ads — casca fina sobre lib/ads.js#listarAds (mesma fonte da tela Ads),
// consultando TODAS as lojas/contas da empresa selecionada de uma vez (a
// tela permite filtrar por loja; a IA sempre olha a empresa inteira, como
// as demais ferramentas). "Gasto hoje/mês" precisam de uma janela própria
// (mês corrente, independente do período do header) — mesmo padrão já usado
// por routes/ads.js.
async function handleAdsDesempenho(input, ctx) {
  const mesCalc = calcularPeriodo('mes');
  const { desde: mesDesdeStr, ate: mesAteStr } = periodoParaDatasBRT(mesCalc);
  const hojeStr = diaBRT(new Date());
  const limite = Math.min(Math.max(parseInt(input && input.limite, 10) || 5, 1), 15);

  const resultado = await listarAds({
    empresaId: ctx.empresaId, contaId: null, periodoChave: ctx.periodoCalc.chave,
    desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate,
    desdeStr: ctx.desdeStr, ateStr: ctx.ateStr,
    mesDesdeStr, mesAteStr, hojeStr,
  });

  if (resultado.semConta) {
    return {
      disponivel: false,
      motivo: 'sem_conta',
      observacao: 'Esta empresa não tem nenhuma conta do Mercado Livre conectada — sem conta conectada não há como consultar Ads.',
    };
  }

  const comMargem = resultado.linhas.filter((l) => l.margemDepoisDoAds !== null);
  const melhores = [...comMargem].sort((a, b) => b.margemDepoisDoAds - a.margemDepoisDoAds).slice(0, limite);
  const piores = [...comMargem].sort((a, b) => a.margemDepoisDoAds - b.margemDepoisDoAds).slice(0, limite).filter((l) => l.margemDepoisDoAds < 0);

  const linhaAds = (l) => ({
    anuncio: l.anuncio, sku: l.sku, loja: l.loja,
    investimentoAds: l.investimento, investimentoAdsFormatado: formatMoneyOuNull(l.investimento),
    faturamentoRealDoSku: l.faturamentoReal, faturamentoRealDoSkuFormatado: formatMoneyOuNull(l.faturamentoReal),
    margemAntesDoAds: l.margemAntesDoAds, margemAntesDoAdsFormatado: formatMoneyOuNull(l.margemAntesDoAds),
    margemDepoisDoAds: l.margemDepoisDoAds, margemDepoisDoAdsFormatado: formatMoneyOuNull(l.margemDepoisDoAds),
    roasAtribuido: l.roas, acosAtribuido: l.acos, status: l.status,
  });

  return {
    periodo: ctx.periodoCalc.label,
    disponivel: resultado.cards.disponivel,
    algumaContaComProblema: resultado.situacaoPorConta.filter((s) => !s.disponivel).map((s) => ({ loja: s.loja, motivo: s.motivo, mensagem: s.mensagem })),
    gastoHoje: { valor: resultado.cards.gastoHoje, valorFormatado: formatMoneyOuNull(resultado.cards.gastoHoje) },
    gastoMes: { valor: resultado.cards.gastoMes, valorFormatado: formatMoneyOuNull(resultado.cards.gastoMes) },
    investimentoNoPeriodoSelecionado: { valor: resultado.cards.investimentoPeriodo, valorFormatado: formatMoneyOuNull(resultado.cards.investimentoPeriodo) },
    receitaAtribuidaNoPeriodoSelecionado: { valor: resultado.cards.receitaAtribuidaPeriodo, valorFormatado: formatMoneyOuNull(resultado.cards.receitaAtribuidaPeriodo) },
    roasNoPeriodoSelecionado: resultado.cards.roasPeriodo,
    acosNoPeriodoSelecionado: resultado.cards.acosPeriodo,
    melhoresAnunciosAposAds: melhores.map(linhaAds),
    pioresAnunciosAposAds: piores.map(linhaAds),
    observacao: 'Investimento/ROAS/ACOS "atribuído" vêm direto da API de Ads do Mercado Livre — não representam necessariamente 100% de venda paga (podem incluir venda orgânica misturada, o próprio Mercado Livre não separa isso). "Margem depois do Ads" é a margem de contribuição REAL das vendas daquele anúncio (mesma fórmula de sempre) menos o investimento em Ads — nunca um segundo cálculo financeiro.',
  };
}

// Fluxo de caixa — casca fina sobre lib/visaoGeralPainel.js#fluxoDeCaixa
// (mesmos 3 blocos já mostrados em Visão Geral > Fluxo de Caixa: contas a
// pagar em aberto, contas a receber em aberto, recebimentos do Mercado
// Livre esperados no período). "Saldo projetado" é SEMPRE null — o ERP não
// tem saldo bancário cadastrado (ver observacao abaixo e
// docs/01-regras-de-negocio.md) — nunca inventado aqui.
async function handleFluxoDeCaixa(_input, ctx) {
  const pedidos = await ctx.pedidos();
  const fluxo = await fluxoDeCaixa({ empresaId: ctx.empresaId, desdeStr: ctx.desdeStr, ateStr: ctx.ateStr, pedidos });

  return {
    periodo: ctx.periodoCalc.label,
    realizado: {
      recebidoDeContasAReceberNoPeriodo: { valor: fluxo.contasAReceber.recebidoNoPeriodo, valorFormatado: formatMoneyOuNull(fluxo.contasAReceber.recebidoNoPeriodo) },
      pagoDeContasAPagarNoPeriodo: { valor: fluxo.contasAPagar.pagasNoPeriodo, valorFormatado: formatMoneyOuNull(fluxo.contasAPagar.pagasNoPeriodo) },
    },
    previstoOuProjetado: {
      contasAReceberEmAberto: { valor: fluxo.contasAReceber.totalAReceber, valorFormatado: formatMoneyOuNull(fluxo.contasAReceber.totalAReceber) },
      contasAReceberProximos7Dias: { valor: fluxo.contasAReceber.previstoProximos7Dias, valorFormatado: formatMoneyOuNull(fluxo.contasAReceber.previstoProximos7Dias) },
      contasAReceberAtrasadas: { valor: fluxo.contasAReceber.atrasado, valorFormatado: formatMoneyOuNull(fluxo.contasAReceber.atrasado) },
      contasAPagarEmAberto: { valor: fluxo.contasAPagar.totalAPagar, valorFormatado: formatMoneyOuNull(fluxo.contasAPagar.totalAPagar) },
      contasAPagarProximos7Dias: { valor: fluxo.contasAPagar.vencendoProximos7Dias, valorFormatado: formatMoneyOuNull(fluxo.contasAPagar.vencendoProximos7Dias) },
      contasAPagarVencidas: { valor: fluxo.contasAPagar.vencidas, valorFormatado: formatMoneyOuNull(fluxo.contasAPagar.vencidas) },
      recebimentosMercadoLivreEsperadosNoPeriodo: campoResposta({ valor: fluxo.recebimentosMl.valorLiquidoEsperado, pendentes: fluxo.recebimentosMl.pendentes }),
    },
    saldoProjetado: { valor: null, disponivel: false, motivo: 'sem_saldo_bancario_cadastrado' },
    observacao: 'O ERP ainda não tem nenhum cadastro de saldo bancário real — por isso NUNCA existe um "saldo projetado" final (saldo atual + recebimentos previstos − contas a pagar) calculado automaticamente: sem um saldo inicial de verdade, esse número seria inventado. Os valores acima são os componentes reais dessa conta, sempre separando o que já ACONTECEU ("realizado") do que é só uma EXPECTATIVA ("previsto"/"projetado") — nunca apresente um valor previsto como dinheiro já disponível.',
  };
}

// ---------------- Passo 3 (27/08/2026): Recebimentos + Fluxo de Caixa + extrato ----------------

// Recebimentos de marketplace organizados por status (a_receber/disponivel/
// recebido) — casca fina sobre lib/recebimentosMl.js#resumoRecebimentosMarketplace
// (mesma fonte da tela Recebimentos). SEMPRE atual (não depende do período
// do header) — mesma decisão já tomada em contas_a_receber_resumo/
// contas_a_pagar_resumo, pelo mesmo motivo: "quanto já recebi hoje/este
// mês" e "quanto ainda tenho pra receber" são perguntas sobre o AGORA.
async function handleRecebimentosMarketplaceResumo(_input, ctx) {
  const r = await recebimentosMl.resumoRecebimentosMarketplace(ctx.empresaId);
  return {
    recebidoHoje: { valor: r.recebidoHoje, valorFormatado: formatMoneyOuNull(r.recebidoHoje) },
    recebidoEsteMes: { valor: r.recebidoMes, valorFormatado: formatMoneyOuNull(r.recebidoMes) },
    aReceberTotal: { valor: r.aReceberTotal, valorFormatado: formatMoneyOuNull(r.aReceberTotal) },
    aReceberAtrasado: { valor: r.aReceberAtrasado, valorFormatado: formatMoneyOuNull(r.aReceberAtrasado) },
    aReceberProximos7Dias: { valor: r.aReceberProximos7Dias, valorFormatado: formatMoneyOuNull(r.aReceberProximos7Dias) },
    aReceberProximos15Dias: { valor: r.aReceberProximos15Dias, valorFormatado: formatMoneyOuNull(r.aReceberProximos15Dias) },
    aReceberProximos30Dias: { valor: r.aReceberProximos30Dias, valorFormatado: formatMoneyOuNull(r.aReceberProximos30Dias) },
    aReceberSemPrevisaoDeLiberacaoInformada: {
      quantidade: r.aReceberSemPrevisaoDeLiberacao.quantidade,
      valor: r.aReceberSemPrevisaoDeLiberacao.valor,
      valorFormatado: formatMoneyOuNull(r.aReceberSemPrevisaoDeLiberacao.valor),
    },
    porMarketplace: r.porMarketplace.map((m) => ({
      marketplace: m.marketplace,
      recebido: m.recebido, recebidoFormatado: formatMoneyOuNull(m.recebido),
      aReceber: m.aReceber, aReceberFormatado: formatMoneyOuNull(m.aReceber),
    })),
    porLoja: r.porLoja.map((l) => ({
      loja: l.loja,
      recebido: l.recebido, recebidoFormatado: formatMoneyOuNull(l.recebido),
      aReceber: l.aReceber, aReceberFormatado: formatMoneyOuNull(l.aReceber),
    })),
    observacao: 'RECEBIDO/CONCILIADO = valor efetivamente identificado no extrato bancário (conciliação) ou confirmado manualmente pelo usuário — dinheiro de verdade já disponível. A_RECEBER/DISPONÍVEL (ambos somados em "a receber") = a venda já aconteceu, mas o dinheiro ainda não foi confirmado no banco — NUNCA apresente isso como já recebido, mesmo quando o marketplace já marcou como "disponível/liberado" pra ele. O Mercado Livre não informa a data real de liberação/repasse — por isso os recortes "próximos 7/15/30 dias" só contam o que tem previsão de liberação INFORMADA MANUALMENTE pelo usuário na tela Recebimentos; o resto aparece em "aReceberSemPrevisaoDeLiberacaoInformada" (nunca estimado ou distribuído escondido dentro de um recorte de dias).',
  };
}

const PERIODOS_FLUXO_CAIXA_IA = ['7d', '15d', '30d', 'mes', 'proximoMes'];

// Fluxo de Caixa DETALHADO — casca fina sobre lib/fluxoCaixa.js#gerarFluxoDeCaixa
// (a tela dedicada de Fluxo de Caixa, com saldo bancário real quando o
// usuário informou um saldo inicial — DIFERENTE da ferramenta 'fluxo_de_caixa'
// acima, que usa a versão simples de Visão Geral e nunca teve saldo real).
// Único jeito da IA responder "como fica meu fluxo de caixa" com Caixa
// atual/Saldo projetado de verdade — formato de resposta pedido
// explicitamente pelo usuário: Caixa atual (Saldo realizado) / Entradas
// previstas por marketplace / Saídas previstas / Saldo projetado, seguido
// de leitura qualitativa.
//
// Período PRÓPRIO (não é o período do header, `ctx.periodoCalc`) — mesma
// decisão já documentada em lib/fluxoCaixa.js: aqui o filtro sempre olha
// pra FRENTE (é uma projeção), "próximos N dias" a partir de hoje.
async function handleFluxoDeCaixaDetalhado(input, ctx) {
  const periodoChave = PERIODOS_FLUXO_CAIXA_IA.includes(input && input.periodoChave) ? input.periodoChave : '30d';
  const fluxo = await gerarFluxoDeCaixa({ empresaId: ctx.empresaId, periodoChave });

  return {
    periodo: fluxo.periodo.label,
    saldoAtual: fluxo.saldoInicial
      ? { valor: fluxo.cards.saldoAtual.valor, valorFormatado: formatMoneyOuNull(fluxo.cards.saldoAtual.valor), disponivel: fluxo.cards.saldoAtual.valor !== null }
      : { valor: null, disponivel: false, motivo: 'O usuário ainda não informou um saldo bancário inicial na tela Fluxo de Caixa — sem isso, não existe um "saldo atual" calculável (nunca um número inventado).' },
    realizadoNoPeriodo: {
      entradas: { valor: fluxo.realizadoNoPeriodo.entradas, valorFormatado: formatMoneyOuNull(fluxo.realizadoNoPeriodo.entradas) },
      saidas: { valor: fluxo.realizadoNoPeriodo.saidas, valorFormatado: formatMoneyOuNull(fluxo.realizadoNoPeriodo.saidas) },
      observacao: 'Dinheiro que JÁ ENTROU/SAIU de verdade no período: contas a receber/pagar com status RECEBIDO/PAGO, mais recebimentos de marketplace conciliados com o extrato bancário importado (ou confirmados manualmente) — nunca inclui nada ainda só "previsto".',
    },
    entradasPrevistas: {
      contasAReceberNoPeriodo: { valor: fluxo.resumoFormula.contasAReceber, valorFormatado: formatMoneyOuNull(fluxo.resumoFormula.contasAReceber) },
      recebimentosMarketplacesPrevistos: {
        valor: fluxo.recebimentosMarketplaces.total,
        valorFormatado: formatMoneyOuNull(fluxo.recebimentosMarketplaces.total),
        quantidadePedidos: fluxo.recebimentosMarketplaces.quantidade,
        observacao: 'Só entra no TOTAL do período (nunca num dia específico do gráfico) — o marketplace não informa a data real de liberação. Já são excluídos automaticamente os que já foram conciliados/recebidos (esses contam em "realizadoNoPeriodo", nunca nos dois ao mesmo tempo).',
      },
    },
    saidasPrevistas: { valor: fluxo.cards.saidasPrevistas, valorFormatado: formatMoneyOuNull(fluxo.cards.saidasPrevistas) },
    contasVencidas: { valor: fluxo.cards.contasVencidas, valorFormatado: formatMoneyOuNull(fluxo.cards.contasVencidas) },
    saldoProjetado: fluxo.cards.saldoProjetado.valor !== null
      ? { valor: fluxo.cards.saldoProjetado.valor, valorFormatado: formatMoneyOuNull(fluxo.cards.saldoProjetado.valor), disponivel: true }
      : { valor: null, disponivel: false, motivo: 'sem_saldo_inicial_informado' },
    observacao: 'SEMPRE diferencie REALIZADO (já aconteceu — "realizadoNoPeriodo", conferido no banco) de PREVISTO/PROJETADO (expectativa — "entradasPrevistas"/"saidasPrevistas"/"saldoProjetado") na resposta. Formato de resposta sugerido: 1) Caixa atual / Saldo realizado; 2) Entradas previstas (por marketplace e Contas a Receber); 3) Saídas previstas; 4) Saldo projetado; 5) explicação qualitativa curta. Nunca apresente um valor previsto como dinheiro já disponível em caixa, e nunca some recebimentosMarketplacesPrevistos com o que já está em realizadoNoPeriodo — são mutuamente exclusivos.',
  };
}

// Análise do extrato bancário importado — casca fina sobre
// lib/extratoBancario.js#listarMovimentos (mesma tabela extrato_movimentos
// da tela Fluxo de Caixa > Importar extrato). Usa o PERÍODO DO HEADER
// (ctx.desdeStr/ateStr — ex: "esta semana") por consistência com o resto
// das ferramentas. Só leitura — nunca concilia nem altera nada.
async function handleExtratoBancarioAnalise(input, ctx) {
  const contaBancariaId = input && input.contaBancariaId ? Number(input.contaBancariaId) : undefined;
  const movimentos = await extratoBancario.listarMovimentos({ empresaId: ctx.empresaId, contaBancariaId, desde: ctx.desdeStr, ate: ctx.ateStr });

  if (!movimentos.length) {
    return {
      periodo: ctx.periodoCalc.label,
      temMovimentacaoNoPeriodo: false,
      observacao: 'Nenhuma movimentação de extrato bancário importada pra este período/conta — pode ser que o usuário ainda não tenha importado o extrato dessa semana em Fluxo de Caixa > Importar extrato bancário.',
    };
  }

  const entradas = movimentos.filter((m) => m.tipo === 'entrada');
  const saidas = movimentos.filter((m) => m.tipo === 'saida');
  const totalEntradas = round2(entradas.reduce((s, m) => s + m.valor, 0));
  const totalSaidas = round2(saidas.reduce((s, m) => s + m.valor, 0));

  const conciliados = movimentos.filter((m) => m.statusConciliacao === 'conciliado');
  const naoConciliados = movimentos.filter((m) => m.statusConciliacao === 'nao_conciliado');
  const ignorados = movimentos.filter((m) => m.statusConciliacao === 'ignorado');

  function topPorValor(lista, n) {
    return [...lista].sort((a, b) => b.valor - a.valor).slice(0, n).map((m) => ({
      data: m.data, descricao: m.descricao, valor: m.valor, valorFormatado: formatMoneyOuNull(m.valor),
      statusConciliacao: m.statusConciliacao,
    }));
  }

  // Movimentações "fora do normal": valor bem acima da mediana do próprio
  // grupo (entrada/saída) — só um destaque estatístico sobre os números
  // reais do extrato (nunca um valor novo/estimado), e só quando há
  // amostra suficiente pra "mediana" fazer sentido.
  function foraDoNormal(lista) {
    if (lista.length < 3) return [];
    const valores = lista.map((m) => m.valor).sort((a, b) => a - b);
    const mediana = valores.length % 2 === 0
      ? round2((valores[valores.length / 2 - 1] + valores[valores.length / 2]) / 2)
      : valores[(valores.length - 1) / 2];
    if (!mediana) return [];
    return lista.filter((m) => m.valor > mediana * 3).map((m) => ({
      data: m.data, descricao: m.descricao, valor: m.valor, valorFormatado: formatMoneyOuNull(m.valor), tipo: m.tipo,
    }));
  }

  const movimentosComSaldo = movimentos.filter((m) => m.saldoApos !== null).sort((a, b) => a.data.localeCompare(b.data) || a.id - b.id);
  const evolucaoSaldo = movimentosComSaldo.length
    ? {
        disponivel: true,
        inicio: { data: movimentosComSaldo[0].data, valor: movimentosComSaldo[0].saldoApos, valorFormatado: formatMoneyOuNull(movimentosComSaldo[0].saldoApos) },
        fim: { data: movimentosComSaldo[movimentosComSaldo.length - 1].data, valor: movimentosComSaldo[movimentosComSaldo.length - 1].saldoApos, valorFormatado: formatMoneyOuNull(movimentosComSaldo[movimentosComSaldo.length - 1].saldoApos) },
      }
    : { disponivel: false, motivo: 'A planilha importada não trouxe uma coluna de saldo mapeada, ou nenhum saldo foi informado.' };

  return {
    periodo: ctx.periodoCalc.label,
    temMovimentacaoNoPeriodo: true,
    quantidadeMovimentacoes: movimentos.length,
    totalEntradas: { valor: totalEntradas, valorFormatado: formatMoneyOuNull(totalEntradas) },
    totalSaidas: { valor: totalSaidas, valorFormatado: formatMoneyOuNull(totalSaidas) },
    principaisEntradas: topPorValor(entradas, 5),
    principaisSaidas: topPorValor(saidas, 5),
    movimentacoesForaDoNormal: [...foraDoNormal(entradas), ...foraDoNormal(saidas)],
    recebimentosConciliados: {
      quantidade: conciliados.length,
      valor: round2(conciliados.reduce((s, m) => s + m.valor, 0)),
      valorFormatado: formatMoneyOuNull(round2(conciliados.reduce((s, m) => s + m.valor, 0))),
    },
    naoIdentificados: {
      quantidade: naoConciliados.length,
      valor: round2(naoConciliados.reduce((s, m) => s + m.valor, 0)),
      valorFormatado: formatMoneyOuNull(round2(naoConciliados.reduce((s, m) => s + m.valor, 0))),
      observacao: 'Movimentações do extrato que ainda não foram relacionadas a nenhum recebimento/conta do ERP nem marcadas como "ignorado" pelo usuário — só uma sugestão de conciliação existe pra elas em Fluxo de Caixa > Conciliação, nunca conciliadas automaticamente.',
    },
    ignorados: { quantidade: ignorados.length },
    evolucaoSaldoBancario: evolucaoSaldo,
    observacao: 'Todos os valores vêm do extrato bancário REAL importado pelo usuário (nunca um cálculo/estimativa) — "movimentacoesForaDoNormal" é só um destaque estatístico (valor bem acima da mediana do período), não um alerta de fraude ou erro. "recebimentosConciliados" é dinheiro confirmado; "naoIdentificados" ainda depende de o usuário confirmar uma sugestão de conciliação.',
  };
}

// DRE completa — casca fina sobre lib/dre.js#gerarDRE, expondo TODAS as
// linhas do demonstrativo (resultado_periodo, acima, só expõe um resumo de
// 3 linhas — esta ferramenta é pra quando o usuário pede a DRE em si, ex:
// "mostre minha DRE deste mês").
async function handleDreCompleta(_input, ctx) {
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
    linhas: {
      receitaBruta: linhaResposta(l.receitaBruta),
      cancelamentosDevolucoes: linhaResposta(l.cancelamentos),
      descontosCupom: linhaResposta(l.descontos),
      receitaLiquida: linhaResposta(l.receitaLiquida),
      custoDosProdutos: linhaResposta(l.custoProdutos),
      taxasEComissoes: linhaResposta(l.taxasComissoes),
      freteDoVendedor: linhaResposta(l.freteVendedor),
      impostos: linhaResposta(l.impostos),
      margemDeContribuicao: linhaResposta(l.margemContribuicao),
      despesasPagasNoPeriodo: linhaResposta(l.despesasPeriodo),
      resultadoFinal: linhaResposta(l.resultadoFinal),
    },
    observacao: 'Cada linha em R$ e em % sobre a Receita Bruta. Sem nenhum pedido no período inteiro, todas as linhas de receita vêm "Sem dados" (disponivel:false, pedidosSemEssaInformacao:0) — diferente de "Pendente" (disponivel:false com pedidosSemEssaInformacao>0), que significa que havia pedido mas faltou alguma informação (ex: custo de SKU). A Margem de Contribuição é sempre a mesma já mostrada em Pedidos/Visão Geral/Financeiro — nunca recalculada por soma das outras linhas.',
  };
}

// Compras por fornecedor — casca fina sobre lib/compras.js (novo módulo
// criado nesta tarefa, sem cálculo financeiro próprio: só agrupa
// compras.valor_total, o mesmo valor já calculado pelo servidor na
// criação/edição da compra).
async function handleComprasResumo(_input, ctx) {
  const resumo = await resumoComprasPorFornecedor({ empresaId: ctx.empresaId, desde: ctx.desdeStr, ate: ctx.ateStr });
  return {
    periodo: ctx.periodoCalc.label,
    totalCompradoNoPeriodo: { valor: resumo.valorTotal, valorFormatado: formatMoneyOuNull(resumo.valorTotal) },
    quantidadeDeCompras: resumo.quantidadeCompras,
    porFornecedor: resumo.porFornecedor.map((f) => ({
      fornecedor: f.fornecedorNome,
      quantidadeCompras: f.quantidadeCompras,
      valorTotal: f.valorTotal,
      valorTotalFormatado: formatMoneyOuNull(f.valorTotal),
    })),
    porStatus: resumo.porStatus,
    comprasCanceladasNoPeriodo: { quantidade: resumo.quantidadeCanceladas, valor: resumo.valorCancelado, valorFormatado: formatMoneyOuNull(resumo.valorCancelado) },
    observacao: 'Filtra pela data da compra (não pela previsão de chegada). Compras canceladas nunca entram no total geral nem no total por fornecedor — aparecem só à parte, como informação. "Recebido" nesta etapa é só uma mudança de status — não gera entrada automática em Estoque.',
  };
}

// Notas fiscais — casca fina sobre lib/notasFiscais.js#listarNotasFiscais
// (mesma fonte da tela Emissão de notas fiscais), só contando por status em
// vez de listar pedido a pedido.
async function handleNotasFiscaisResumo(_input, ctx) {
  const { itens, totalNoPeriodo } = await listarNotasFiscais({ empresaId: ctx.empresaId, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
  const contagem = { pendente: 0, emitida: 0, cancelada: 0, rejeitada: 0 };
  itens.forEach((i) => { contagem[i.status] = (contagem[i.status] || 0) + 1; });

  return {
    periodo: ctx.periodoCalc.label,
    totalDePedidosNoPeriodo: totalNoPeriodo,
    notasPendentes: contagem.pendente,
    notasEmitidas: contagem.emitida,
    notasCanceladas: contagem.cancelada,
    notasRejeitadas: contagem.rejeitada,
    observacao: 'Sem integração real com a SEFAZ nesta etapa — "Emitida" aqui significa só que o número/série/data/chave de acesso foram registrados manualmente no ERP, não que a nota foi de fato transmitida/autorizada perante o fisco. Um pedido sem nota registrada conta como "pendente".',
  };
}

// Comparação com o período anterior EQUIVALENTE (mesma duração em dias,
// terminando exatamente onde o período selecionado começa) — nunca um
// período escolhido pelo modelo/usuário em texto livre: a regra "empresa e
// período nunca vêm do modelo" (topo deste arquivo) vale igualmente aqui,
// então o único período de comparação permitido é calculado
// deterministicamente a partir do período já selecionado no cabeçalho.
async function handleComparacaoPeriodoAnterior(_input, ctx) {
  const duracaoMs = ctx.periodoCalc.ate.getTime() - ctx.periodoCalc.desde.getTime();
  const anteriorAte = ctx.periodoCalc.desde;
  const anteriorDesde = new Date(anteriorAte.getTime() - duracaoMs);

  const [pedidosAtual, { pedidos: pedidosAnterior }] = await Promise.all([
    ctx.pedidos(),
    buscarPedidosDoPeriodo({ empresaId: ctx.empresaId, desde: anteriorDesde, ate: anteriorAte }),
  ]);
  const atual = resumirPeriodo(pedidosAtual);
  const anterior = resumirPeriodo(pedidosAnterior);

  function variacao(a, b) {
    if (a === null || b === null) return null;
    if (!b) return null;
    return Math.round(((a - b) / Math.abs(b)) * 100 * 100) / 100;
  }

  return {
    periodoAtual: { label: ctx.periodoCalc.label, desde: diaBRT(ctx.periodoCalc.desde), ate: diaBRT(new Date(ctx.periodoCalc.ate.getTime() - 1)) },
    periodoAnterior: { label: 'Período anterior equivalente (mesma duração)', desde: diaBRT(anteriorDesde), ate: diaBRT(new Date(anteriorAte.getTime() - 1)) },
    faturamento: {
      atual: campoResposta(atual.faturamento), anterior: campoResposta(anterior.faturamento),
      variacaoPercentual: variacao(atual.faturamento.valor, anterior.faturamento.valor),
    },
    margemContribuicao: {
      atual: campoResposta(atual.margemContribuicao), anterior: campoResposta(anterior.margemContribuicao),
      variacaoPercentual: variacao(atual.margemContribuicao.valor, anterior.margemContribuicao.valor),
    },
    quantidadePedidos: {
      atual: atual.qtdPedidos, anterior: anterior.qtdPedidos,
      variacaoPercentual: variacao(atual.qtdPedidos, anterior.qtdPedidos),
    },
    observacao: 'O período anterior é sempre a mesma duração do período selecionado no cabeçalho, terminando exatamente onde ele começa (ex: se o cabeçalho está em "Últimos 7 dias", compara com os 7 dias imediatamente anteriores) — nunca um intervalo escolhido livremente. Use esta ferramenta para "o que piorou/melhorou" ou "como estou comparado ao período anterior".',
  };
}

// Consulta a documentação interna do ERP (regras de negócio e limitações
// conhecidas) — nunca devolve um número, só explicações já registradas em
// docs/ (ver lib/ia/baseConhecimento.js).
async function handleConsultarDocumentacao(input) {
  const tema = input && input.tema;
  return consultarDocumentacao(tema);
}

// ---------------- Projeção do mês corrente ----------------
//
// Adicionado na tarefa "corrigir o comportamento da IA Gestora" (pedido
// explícito do usuário, docs/02-decisoes.md): a IA respondia "o ERP não
// possui essa funcionalidade" pra "faça uma projeção do meu faturamento até
// o fim do mês" — mas TODOS os dados pra calcular isso já existem no ERP
// (faturamento realizado, dias corridos, dias restantes). O usuário quer
// que a IA RACIOCINE/calcule em cima de dado real, em vez de recusar só
// porque não existe uma tela de "Projeções". Regras explícitas do usuário
// pra esta ferramenta:
//   - Todo número de ENTRADA vem do ERP (nunca inventado) — a única coisa
//     calculada aqui é matemática simples (média, regra de três, variação
//     percentual) em cima desses números reais.
//   - Sempre separar REALIZADO (o que já aconteceu) de PROJETADO
//     (estimativa) — nunca apresentar um como se fosse o outro.
//   - Quando faltar dado essencial (ex: margem pendente por SKU sem custo),
//     dizer exatamente o que falta, no formato pedido: "Consigo projetar o
//     faturamento, mas ainda não consigo projetar o lucro com precisão
//     porque N SKUs estão sem custo cadastrado."
//
// SEMPRE projeta o MÊS CORRENTE (calendário), independente do período
// selecionado no cabeçalho — mesma decisão já usada pelos cards "gasto
// hoje/mês" de Ads (lib/ads.js) — porque "projeção até o fim do mês" não
// faz sentido calculada em cima de "Hoje" ou "Últimos 7 dias".
//
// `metrica` escolhe o que projetar (faturamento/margem+lucro/pedidos/Ads) —
// cada uma busca só o dado que precisa, pra nunca carregar mais do ERP do
// que a pergunta exige (mesma regra de performance/custo do resto deste
// arquivo).

// Dia do mês (1-31) e quantidade de dias do mês corrente, em BRT.
function diaEDiasDoMesBRT() {
  const hojeStr = diaBRT(new Date());
  const [ano, mes] = hojeStr.split('-').map(Number);
  const diaAtual = Number(hojeStr.split('-')[2]);
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // dia 0 do mês seguinte = último dia deste mês
  return { diaAtual, diasNoMes, diasRestantes: diasNoMes - diaAtual, mesReferencia: `${String(mes).padStart(2, '0')}/${ano}` };
}

// Projeção simples (média diária × dias do mês) + projeção ajustada pela
// tendência recente (realizado + média diária dos últimos 7 dias × dias
// restantes) — só quando os últimos 7 dias tiverem dado real. A "faixa
// provável" é o intervalo entre as duas projeções calculadas (nunca um
// modelo estatístico/probabilístico à parte) — deixado explícito na
// observação de cada resposta, pra nunca parecer mais sofisticado do que
// realmente é.
function projetar(realizadoMes, diaAtual, diasNoMes, diasRestantes, realizado7d) {
  if (realizadoMes === null || !diaAtual) return { disponivel: false };

  const mediaDiariaMes = round2(realizadoMes / diaAtual);
  const projecaoSimples = round2(mediaDiariaMes * diasNoMes);

  let projecaoAjustada = projecaoSimples;
  let mediaDiaria7d = null;
  let tendenciaPercentual = null;
  const tendenciaDisponivel = realizado7d !== null;
  if (tendenciaDisponivel) {
    mediaDiaria7d = round2(realizado7d / 7);
    projecaoAjustada = round2(realizadoMes + mediaDiaria7d * diasRestantes);
    tendenciaPercentual = mediaDiariaMes ? round2(((mediaDiaria7d - mediaDiariaMes) / Math.abs(mediaDiariaMes)) * 100) : null;
  }

  return {
    disponivel: true,
    mediaDiariaMes,
    mediaDiariaUltimos7Dias: mediaDiaria7d,
    tendenciaDisponivel,
    tendenciaPercentual,
    projecaoSimples,
    projecaoAjustadaPelaTendencia: projecaoAjustada,
    faixaProvavel: { min: Math.min(projecaoSimples, projecaoAjustada), max: Math.max(projecaoSimples, projecaoAjustada) },
  };
}

function formatarProjecao(p) {
  if (!p.disponivel) return { disponivel: false };
  return {
    disponivel: true,
    mediaDiariaMes: p.mediaDiariaMes,
    mediaDiariaMesFormatada: formatMoneyOuNull(p.mediaDiariaMes),
    mediaDiariaUltimos7Dias: p.mediaDiariaUltimos7Dias,
    mediaDiariaUltimos7DiasFormatada: formatMoneyOuNull(p.mediaDiariaUltimos7Dias),
    tendencia: p.tendenciaDisponivel
      ? { percentual: p.tendenciaPercentual, direcao: p.tendenciaPercentual > 0.5 ? 'subindo' : p.tendenciaPercentual < -0.5 ? 'caindo' : 'estavel' }
      : { percentual: null, direcao: 'sem_dado_suficiente' },
    projecaoSimples: p.projecaoSimples,
    projecaoSimplesFormatada: formatMoneyOuNull(p.projecaoSimples),
    projecaoAjustadaPelaTendencia: p.projecaoAjustadaPelaTendencia,
    projecaoAjustadaPelaTendenciaFormatada: formatMoneyOuNull(p.projecaoAjustadaPelaTendencia),
    faixaProvavel: {
      min: p.faixaProvavel.min, minFormatado: formatMoneyOuNull(p.faixaProvavel.min),
      max: p.faixaProvavel.max, maxFormatado: formatMoneyOuNull(p.faixaProvavel.max),
    },
  };
}

async function handleProjecaoMes(input, ctx) {
  const metrica = ['faturamento', 'margem_e_lucro', 'pedidos', 'ads'].includes(input && input.metrica) ? input.metrica : 'faturamento';
  const { diaAtual, diasNoMes, diasRestantes, mesReferencia } = diaEDiasDoMesBRT();
  const base = { mesReferencia, diaAtual, diasNoMes, diasRestantes, metrica };

  const mesCalc = calcularPeriodo('mes');
  const periodo7dCalc = calcularPeriodo('7d');

  if (metrica === 'ads') {
    const { desde: mesDesdeStr, ate: mesAteStr } = periodoParaDatasBRT(mesCalc);
    const { desde: p7DesdeStr, ate: p7AteStr } = periodoParaDatasBRT(periodo7dCalc);
    const hojeStr = diaBRT(new Date());
    const resultado = await listarAds({
      empresaId: ctx.empresaId, contaId: null, periodoChave: periodo7dCalc.chave,
      desde: periodo7dCalc.desde, ate: periodo7dCalc.ate, desdeStr: p7DesdeStr, ateStr: p7AteStr,
      mesDesdeStr, mesAteStr, hojeStr,
    });
    if (resultado.semConta || !resultado.cards.disponivel) {
      return { ...base, disponivel: false, motivo: resultado.semConta ? 'sem_conta' : 'ads_indisponivel', observacao: 'Sem dado real de Ads disponível para projetar (conta não conectada, ou sincronização de Ads indisponível no momento).' };
    }
    const gasto7d = (resultado.diario || []).filter((d) => d.investimento !== null);
    const gasto7dTotal = gasto7d.length ? round2(gasto7d.reduce((s, d) => s + d.investimento, 0)) : null;
    const projecao = projetar(resultado.cards.gastoMes, diaAtual, diasNoMes, diasRestantes, gasto7dTotal);
    return {
      ...base,
      gastoRealizadoNoMesAteHoje: { valor: resultado.cards.gastoMes, valorFormatado: formatMoneyOuNull(resultado.cards.gastoMes) },
      projecaoGastoAds: formatarProjecao(projecao),
      observacao: 'Projeta o investimento em Ads do mês corrente com a mesma lógica das outras projeções (média diária × dias do mês, ajustada pela tendência dos últimos 7 dias). "Gasto realizado" vem direto da API de Ads do Mercado Livre (mesma fonte da tela Ads) — nunca um valor calculado.',
    };
  }

  const [{ pedidos: pedidosMes }, { pedidos: pedidos7d }] = await Promise.all([
    buscarPedidosDoPeriodo({ empresaId: ctx.empresaId, desde: mesCalc.desde, ate: mesCalc.ate }),
    buscarPedidosDoPeriodo({ empresaId: ctx.empresaId, desde: periodo7dCalc.desde, ate: periodo7dCalc.ate }),
  ]);
  const resumoMes = resumirPeriodo(pedidosMes);
  const resumo7d = resumirPeriodo(pedidos7d);
  const semVendaNoMesAinda = resumoMes.qtdPedidos + resumoMes.cancelados.quantidade === 0;

  if (metrica === 'pedidos') {
    if (semVendaNoMesAinda) {
      return { ...base, disponivel: false, motivo: 'sem_venda_no_mes_ainda', observacao: 'Ainda não há nenhum pedido registrado este mês — sem um único dia de referência, não dá pra projetar quantidade de pedidos.' };
    }
    const projecao = projetar(resumoMes.qtdPedidos, diaAtual, diasNoMes, diasRestantes, resumo7d.qtdPedidos);
    // Quantidade de pedidos é sempre um número inteiro na resposta final —
    // a média/projeção interna usa casas decimais (matemática correta), só
    // o valor mostrado é arredondado.
    const arred = (v) => (v === null ? null : Math.round(v));
    return {
      ...base,
      pedidosRealizadosNoMesAteHoje: resumoMes.qtdPedidos,
      pedidosUltimos7Dias: resumo7d.qtdPedidos,
      projecaoPedidos: projecao.disponivel ? {
        disponivel: true,
        projecaoSimples: arred(projecao.projecaoSimples),
        projecaoAjustadaPelaTendencia: arred(projecao.projecaoAjustadaPelaTendencia),
        faixaProvavel: { min: arred(projecao.faixaProvavel.min), max: arred(projecao.faixaProvavel.max) },
        tendencia: projecao.tendenciaDisponivel ? { percentual: projecao.tendenciaPercentual } : null,
      } : { disponivel: false },
      observacao: 'Projeção simples de quantidade de pedidos (não valor em R$) — mesma lógica de média diária × dias do mês, ajustada pelo ritmo dos últimos 7 dias.',
    };
  }

  if (metrica === 'margem_e_lucro') {
    if (semVendaNoMesAinda) {
      return { ...base, disponivel: false, motivo: 'sem_venda_no_mes_ainda', observacao: 'Ainda não há nenhum pedido registrado este mês — sem um único dia de referência, não dá pra projetar margem/lucro.' };
    }
    const projecaoFaturamento = projetar(resumoMes.faturamento.valor, diaAtual, diasNoMes, diasRestantes, resumo7d.faturamento.valor);

    if (resumoMes.margemContribuicao.valor === null) {
      // Margem pendente — explica EXATAMENTE o que falta, no formato pedido
      // pelo usuário ("Consigo projetar o faturamento, mas ainda não
      // consigo projetar o lucro com precisão porque N SKUs estão sem
      // custo cadastrado."). Busca os SKUs sem custo só aqui, dentro deste
      // branch — nunca carregado à toa quando a margem já está disponível.
      const { itens } = await buscarItensDoPeriodo({ empresaId: ctx.empresaId, desde: mesCalc.desde, ate: mesCalc.ate });
      const skusSemCusto = [...new Set(itens.filter((it) => it.sku && it.custoProduto === null).map((it) => it.sku))];
      return {
        ...base,
        faturamentoRealizadoNoMesAteHoje: { valor: resumoMes.faturamento.valor, valorFormatado: formatMoneyOuNull(resumoMes.faturamento.valor) },
        projecaoFaturamento: formatarProjecao(projecaoFaturamento),
        margemEProjecaoDisponivel: false,
        pedidosSemCustoNoMes: resumoMes.margemContribuicao.pendentes,
        skusSemCustoNoMes: skusSemCusto.length,
        observacao: `Consigo projetar o faturamento, mas ainda não consigo projetar a margem/lucro com precisão porque ${skusSemCusto.length} SKU(s) (em ${resumoMes.margemContribuicao.pendentes} pedido(s) deste mês) ainda estão sem custo cadastrado em Produtos. Cadastrando o custo, a projeção de margem/lucro passa a ficar disponível.`,
      };
    }

    const projecaoMargem = projetar(resumoMes.margemContribuicao.valor, diaAtual, diasNoMes, diasRestantes, resumo7d.margemContribuicao.valor);
    const margemPercentualProjetada = (projecaoMargem.disponivel && projecaoFaturamento.disponivel && projecaoFaturamento.projecaoSimples)
      ? round2((projecaoMargem.projecaoSimples / projecaoFaturamento.projecaoSimples) * 100)
      : null;

    return {
      ...base,
      faturamentoRealizadoNoMesAteHoje: { valor: resumoMes.faturamento.valor, valorFormatado: formatMoneyOuNull(resumoMes.faturamento.valor) },
      margemContribuicaoRealizadaNoMesAteHoje: { valor: resumoMes.margemContribuicao.valor, valorFormatado: formatMoneyOuNull(resumoMes.margemContribuicao.valor) },
      margemContribuicaoPercentualRealizada: resumoMes.margemPercentual,
      projecaoFaturamento: formatarProjecao(projecaoFaturamento),
      margemEProjecaoDisponivel: true,
      projecaoMargemDeContribuicao: formatarProjecao(projecaoMargem),
      margemPercentualProjetada,
      observacao: '"Margem de contribuição" é o número mais próximo de "lucro" já calculado no ERP (mesma definição de resultado_periodo/DRE — venda menos taxas, frete, imposto e custo do produto) — ainda NÃO desconta despesas fixas pagas no período (Contas a Pagar), que não seguem um ritmo diário previsível como a venda. Para o resultado final já realizado (incluindo despesas pagas até agora), use a ferramenta resultado_periodo.',
    };
  }

  // metrica === 'faturamento' (padrão)
  if (semVendaNoMesAinda) {
    return { ...base, disponivel: false, motivo: 'sem_venda_no_mes_ainda', observacao: 'Ainda não há nenhum pedido registrado este mês — sem um único dia de referência, não dá pra projetar faturamento.' };
  }
  const projecao = projetar(resumoMes.faturamento.valor, diaAtual, diasNoMes, diasRestantes, resumo7d.faturamento.valor);
  return {
    ...base,
    faturamentoRealizadoNoMesAteHoje: { valor: resumoMes.faturamento.valor, valorFormatado: formatMoneyOuNull(resumoMes.faturamento.valor) },
    faturamentoUltimos7Dias: { valor: resumo7d.faturamento.valor, valorFormatado: formatMoneyOuNull(resumo7d.faturamento.valor) },
    projecaoFaturamento: formatarProjecao(projecao),
    observacao: projecao.disponivel
      ? 'Projeção simples = média diária do mês corrente × dias do mês. Projeção ajustada pela tendência = realizado + (média diária dos últimos 7 dias × dias restantes) — só calculada quando há venda real nos últimos 7 dias. "Faixa provável" é o intervalo entre as duas projeções (nunca um modelo estatístico à parte). Se o faturamento realizado tiver algum pedido com valor pendente, a projeção fica indisponível (nunca calculada com um valor parcial).'
      : 'Faturamento do mês corrente ainda pendente de alguma informação — não é possível projetar com segurança agora.',
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
    description: 'Lista os produtos (por SKU/kit) do período e empresa selecionados, ordenados por lucro, prejuízo, faturamento ou quantidade vendida. Use para "qual produto está dando mais lucro" (lucro), "qual produto está dando prejuízo" (prejuizo), "produto que mais faturou" (faturamento) ou "SKU mais vendido" (quantidade).',
    input_schema: {
      type: 'object',
      properties: {
        ordenarPor: { type: 'string', enum: ['lucro', 'prejuizo', 'faturamento', 'quantidade'], description: 'lucro = maior margem de contribuição primeiro; prejuizo = só produtos com margem negativa; faturamento = maior faturamento primeiro; quantidade = mais unidades vendidas primeiro.' },
        limite: { type: 'integer', minimum: 1, maximum: 20, description: 'Quantos produtos retornar (padrão 5).' },
      },
      additionalProperties: false,
    },
    handler: handleProdutosDesempenho,
  },
  {
    name: 'produtos_por_caixa_desempenho',
    description: 'Lista os PRODUTOS FÍSICOS (caixas/medidas, agrupando os SKUs/kits do Mercado Livre que representam o mesmo produto físico) mais vendidos em unidades/caixas físicas ou por faturamento, no período e empresa selecionados — mesma visão "Por Caixa" de Relatórios > Produtos. Use para "qual modelo de caixa mais vendeu em unidades físicas".',
    input_schema: {
      type: 'object',
      properties: {
        ordenarPor: { type: 'string', enum: ['caixas', 'faturamento'], description: 'caixas = mais caixas físicas vendidas primeiro (padrão); faturamento = maior faturamento primeiro.' },
        limite: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    handler: handleProdutosPorCaixa,
  },
  {
    name: 'vendas_com_prejuizo',
    description: 'Lista os PEDIDOS individuais com margem de contribuição negativa no período e empresa selecionados (venda que deu prejuízo depois de taxas, frete, imposto e custo do produto). Use para "quais vendas deram prejuízo" ou "onde estou perdendo dinheiro" (a nível de pedido, não de SKU agregado).',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer', minimum: 1, maximum: 30, description: 'Quantos pedidos retornar (padrão 10).' } },
      additionalProperties: false,
    },
    handler: handleVendasComPrejuizo,
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
    description: 'Lista os alertas ativos agora para a empresa e período selecionados (SKU sem custo, pedido sem custo, margem negativa, erro de sincronização do Mercado Livre, conta a pagar vencida, recebimento atrasado, estoque zerado/baixo) — mesma central de Visão Geral > Alertas & IA. Use para "quais problemas precisam da minha atenção", "maiores problemas hoje" ou "tem alguma venda dando prejuízo".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleAlertasOperacionais,
  },
  {
    name: 'estoque_valor_parado',
    description: 'Calcula quanto dinheiro (matéria-prima) está parado em estoque A CUSTO da empresa selecionada — sempre em quantidade FÍSICA (kits/caixas do Mercado Livre já convertidos em unidades reais, ex: 20 kits de "100CX-20X20X20" = 2.000 caixas físicas) × custo cadastrado em Produto Base, nunca o preço de venda — separando SEMPRE "estoque fora do Full", "estoque Full" e o total dos dois (nunca um total único sem explicar quanto pertence a cada um). Não depende do período selecionado. Use para "quanto tenho no Full em matéria-prima", "quanto vale meu estoque Full/fora do Full a custo", "quanto dinheiro tenho parado no Full", "quanto vale Full + estoque normal juntos". Este ERP já tem esse dado — NUNCA direcione o usuário para o painel do Mercado Livre nessas perguntas.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleEstoqueValorParado,
  },
  {
    name: 'estoque_fisico_detalhado',
    description: 'Detalha o estoque FÍSICO por produto base (caixa/medida), já convertendo kits do Mercado Livre em unidades reais (mesma regra do Relatório de Produtos > "Por Caixa") — separando Full de fora do Full. Use para "quantas caixas físicas tenho no Full", "quanto tenho da caixa 20x20x20 no Full/estoque" (parâmetro produtoBase), ou "quais produtos representam mais dinheiro no Full/estoque" (ranking por valor). "Full disponível" é sempre o que já foi recebido no centro de distribuição do Mercado Livre — este ERP ainda não consulta o estoque "em trânsito/aguardando conferência" (a ferramenta sempre avisa isso, mas continua respondendo normalmente sobre o Full disponível — nunca bloqueie a resposta por causa disso, e nunca direcione o usuário para o painel do Mercado Livre).',
    input_schema: {
      type: 'object',
      properties: {
        escopo: { type: 'string', enum: ['full', 'fora_do_full', 'ambos'], description: 'full = só Estoque Full (padrão); fora_do_full = só Estoque (fora do Full); ambos = os dois, separados.' },
        produtoBase: { type: 'string', description: 'Filtra por um produto físico específico (ex: "20x20x20" encontra "CX-20X20X20"). Omita para listar todos, ordenados por valor em estoque.' },
        limite: { type: 'integer', minimum: 1, maximum: 30, description: 'Quantos produtos retornar, ordenados por valor em estoque (padrão 10).' },
      },
      additionalProperties: false,
    },
    handler: handleEstoqueFisicoDetalhado,
  },
  {
    name: 'ads_desempenho',
    description: 'Investimento e resultado de Ads (Mercado Ads/Product Ads) da empresa selecionada: gasto hoje, gasto no mês, investimento/receita atribuída/ROAS/ACOS no período selecionado, e os anúncios com melhor e pior resultado REAL depois de descontar o Ads (não confundir com "vendas atribuídas", que é uma métrica separada da API de Ads — ver observacao da resposta). Use para "quanto gastei com Ads hoje/este mês" ou "quais anúncios tiveram pior resultado depois do Ads".',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer', minimum: 1, maximum: 15, description: 'Quantos anúncios retornar em cada ranking (melhores/piores), padrão 5.' } },
      additionalProperties: false,
    },
    handler: handleAdsDesempenho,
  },
  {
    name: 'fluxo_de_caixa',
    description: 'Componentes reais do fluxo de caixa da empresa selecionada: o que já foi recebido/pago no período (realizado), contas a receber/pagar em aberto, vencendo nos próximos 7 dias e atrasadas/vencidas (previsto), e recebimentos esperados do Mercado Livre. Nunca inclui um "saldo bancário projetado" (o ERP não tem saldo bancário cadastrado). Use para "como está meu fluxo de caixa", "o que vence esta semana" ou perguntas hipotéticas de caixa (explique com os números reais, nunca com um saldo final inventado).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleFluxoDeCaixa,
  },
  {
    name: 'recebimentos_marketplace_resumo',
    description: 'Recebimentos de marketplace (Mercado Livre) da empresa selecionada, SEMPRE ATUAIS (independe do período do header), já separados por status financeiro: RECEBIDO (dinheiro confirmado no banco), A RECEBER/DISPONÍVEL (venda feita, dinheiro ainda não confirmado no banco, mesmo quando o marketplace já "liberou"). Traz recebido hoje/este mês, total ainda a receber, atrasado, próximos 7/15/30 dias (só o que tem previsão de liberação informada — o resto some em separado), por marketplace e por loja. Use para "quanto já recebi hoje/este mês", "quanto ainda tenho pra receber", "quanto o Mercado Livre ainda vai me pagar", "quanto vou receber nos próximos 7/15/30 dias", "existe recebimento atrasado".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleRecebimentosMarketplaceResumo,
  },
  {
    name: 'fluxo_de_caixa_detalhado',
    description: 'Fluxo de caixa COMPLETO da tela dedicada Fluxo de Caixa (empresa selecionada) — caixa atual/saldo realizado (quando o usuário já informou um saldo bancário inicial), entradas previstas (Contas a Receber + recebimentos de marketplace ainda não conciliados), saídas previstas, contas vencidas e saldo projetado. SEMPRE diferencia REALIZADO (já aconteceu, conferido no banco/conciliado) de PREVISTO/PROJETADO (expectativa). Use para "quanto entrou realmente no banco esta semana", "qual valor previsto ainda não caiu", "como fica meu fluxo de caixa nos próximos 7/15/30 dias/este mês/próximo mês", "quanto dinheiro eu realmente tenho disponível", "saldo projetado até o fim do mês", "diferença entre o que o marketplace disse que ia pagar e o que entrou de verdade" (compare recebimentosMarketplacesPrevistos com o que aparece em realizadoNoPeriodo).',
    input_schema: {
      type: 'object',
      properties: {
        periodoChave: { type: 'string', enum: PERIODOS_FLUXO_CAIXA_IA, description: '7d/15d/30d = próximos N dias a partir de hoje (inclusive); mes = mês corrente; proximoMes = mês de calendário seguinte inteiro. Padrão: 30d ("próximos 30 dias").' },
      },
      additionalProperties: false,
    },
    handler: handleFluxoDeCaixaDetalhado,
  },
  {
    name: 'extrato_bancario_analise',
    description: 'Analisa o extrato bancário IMPORTADO (planilha) no período selecionado da empresa: total de entradas/saídas, principais entradas/saídas, movimentações fora do normal (destaque estatístico, nunca um cálculo novo), quanto já foi conciliado com recebimentos/contas do ERP, quanto ainda não foi identificado, e evolução do saldo bancário informado pela própria planilha (quando ela trouxer essa coluna). Use para "quanto entrou/saiu esta semana no banco", "quais as maiores saídas/entradas", "existe alguma movimentação estranha no extrato", "quantos recebimentos ainda não foram identificados".',
    input_schema: {
      type: 'object',
      properties: {
        contaBancariaId: { type: 'integer', description: 'Filtra por uma conta bancária específica (ver lista em Fluxo de Caixa > Importar extrato). Omitido = todas as contas bancárias da empresa.' },
      },
      additionalProperties: false,
    },
    handler: handleExtratoBancarioAnalise,
  },
  {
    name: 'dre_completa',
    description: 'A DRE (Demonstrativo de Resultado) completa da empresa e período selecionados, linha por linha, em R$ e %: Receita Bruta, Cancelamentos, Descontos, Receita Líquida, Custo dos Produtos, Taxas e Comissões, Frete do Vendedor, Impostos, Margem de Contribuição, Despesas pagas no período, Resultado Final. Use quando o usuário pedir a DRE em si (ex: "mostre minha DRE deste mês") — para só o resultado final resumido, prefira resultado_periodo.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleDreCompleta,
  },
  {
    name: 'compras_resumo',
    description: 'Resumo de Compras (pedidos de compra a fornecedores) da empresa e período selecionados (filtrado pela data da compra): total comprado, quantidade de compras, detalhamento por fornecedor e por status. Use para "quanto comprei este mês por fornecedor" ou "quanto gastei em compras".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleComprasResumo,
  },
  {
    name: 'notas_fiscais_resumo',
    description: 'Resumo de Emissão de notas fiscais da empresa e período selecionados: quantos pedidos têm nota pendente, emitida, cancelada ou rejeitada. Use para "quantas notas fiscais estão pendentes" ou "quantos pedidos ainda não têm nota emitida".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleNotasFiscaisResumo,
  },
  {
    name: 'comparacao_periodo_anterior',
    description: 'Compara faturamento, margem de contribuição e quantidade de pedidos do período selecionado com o período imediatamente anterior de mesma duração (ex: "Últimos 7 dias" compara com os 7 dias antes desses). Use para "o que piorou/melhorou", "como estou comparado ao período anterior" ou "comparação mês a mês" (quando o período selecionado for "Este mês").',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleComparacaoPeriodoAnterior,
  },
  {
    name: 'projecao_mes',
    description: 'Projeta (estima, com matemática simples sobre dado real — nunca inventa) faturamento, margem/lucro, quantidade de pedidos ou gasto de Ads até o ÚLTIMO DIA DO MÊS CORRENTE (sempre o mês corrente, independente do período selecionado no cabeçalho). Usa: realizado até hoje, dias já transcorridos, dias restantes, média diária, e a tendência dos últimos 7 dias quando houver dado suficiente — sempre devolvendo uma projeção simples E uma ajustada pela tendência, separadas claramente do que é realizado. Use para QUALQUER pergunta de "quanto devo faturar/lucrar/vender/gastar de Ads até o fim do mês", "se continuar nesse ritmo...", "compare os últimos 7 dias com a média do mês" — nunca recuse essas perguntas dizendo que "não existe essa funcionalidade": esta ferramenta existe exatamente pra isso. Para dinheiro a RECEBER (contas a receber já lançadas) prefira contas_a_receber_resumo/fluxo_de_caixa — aquilo é dado real agendado, não uma tendência estimada.',
    input_schema: {
      type: 'object',
      properties: {
        metrica: {
          type: 'string',
          enum: ['faturamento', 'margem_e_lucro', 'pedidos', 'ads'],
          description: 'O que projetar até o fim do mês: faturamento (padrão), margem_e_lucro (inclui faturamento, já que a margem % depende dos dois), pedidos (quantidade), ads (investimento em Ads).',
        },
      },
      additionalProperties: false,
    },
    handler: handleProjecaoMes,
  },
  {
    name: 'consultar_documentacao',
    description: 'Consulta a documentação interna do ERP para explicar uma REGRA DE NEGÓCIO ou LIMITAÇÃO conhecida de um módulo (nunca retorna um número — só explicação em texto). Use quando o usuário perguntar "por quê" algo funciona de um certo jeito, ou pedir para entender um limite do sistema (ex: por que o ROAS do ERP não bate com o painel do Mercado Ads, por que não existe "estoque por caixa", por que não há saldo projetado de caixa).',
    input_schema: {
      type: 'object',
      properties: {
        tema: {
          type: 'string',
          enum: Object.keys(TEMAS_DOCUMENTACAO),
          description: 'Tópico a consultar: regra_geral_nunca_inventar, ads, estoque, fluxo_de_caixa, compras_fornecedores, notas_fiscais, contas_a_pagar_receber, dre, produtos_por_caixa, ia_gestora, shopee, permissoes_usuario.',
        },
      },
      required: ['tema'],
      additionalProperties: false,
    },
    handler: handleConsultarDocumentacao,
  },
  // Ferramenta de APRESENTAÇÃO, não de dado — adicionada na tarefa "IA
  // Gestora — central de análise" (25/08/2026, ver docs/02-decisoes.md,
  // Passo 2). Nunca consulta o banco: só estrutura o que o modelo já apurou
  // chamando as outras ferramentas nesta mesma pergunta. Chamar (ou não)
  // esta ferramenta é o que decide se a resposta vira um "card" visual
  // (resumo/KPIs/tabela/gráfico — montados em lib/ia/estrutura.js a partir
  // das OUTRAS ferramentas já chamadas, nunca a partir do que o modelo
  // escrever aqui) ou continua só texto — por isso a REGRA 7 do system
  // prompt é enfática sobre quando usar. `insights` e `atencao` são a única
  // parte desta ferramenta que o modelo realmente "escreve": são leitura,
  // não número novo (a regra 1 do system prompt — nunca afirmar um número
  // sem ferramenta — continua valendo pra qualquer número dentro do texto
  // de `insights`/`atencao`: só pode citar um valor que já veio de outra
  // ferramenta chamada antes).
  {
    name: 'apresentar_analise',
    description: 'Chame esta ferramenta UMA VEZ, por último, só quando a pergunta merecer uma resposta visual completa (relatório, ranking, análise, resumo executivo, fechamento, "faça uma análise de..." — qualquer pergunta que combine várias ferramentas ou traga uma lista/ranking). Ela transforma a resposta num card com resumo, KPIs, tabela e gráfico (montados automaticamente a partir dos dados já obtidos pelas outras ferramentas chamadas nesta pergunta) — você só preenche o título da conversa e a leitura qualitativa (insights/atenção). NUNCA chame para uma pergunta simples de um único número (ex: "quanto faturei hoje?", "qual meu saldo a receber?") — nessas respostas curtas, responda só em texto normal.',
    input_schema: {
      type: 'object',
      properties: {
        tituloConversa: {
          type: 'string',
          description: 'Título curto (até 60 caracteres) resumindo o assunto desta conversa, ex: "Análise de vendas de agosto", "Fluxo de caixa", "Produtos mais vendidos", "Análise de Ads", "Fechamento do mês". Só é usado quando é a primeira pergunta de uma conversa nova (uma conversa já existente mantém o título que já tem).',
        },
        insights: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista curta (2 a 5 itens) das principais conclusões, em frases diretas — cada uma baseada só em números que alguma ferramenta já devolveu nesta mesma pergunta (nunca uma estimativa nova). Ex: "CX-20X20X20 liderou o faturamento.", "Produto Y cresceu 23% em relação ao período anterior." (o percentual, nesse caso, só pode vir de comparacao_periodo_anterior).',
        },
        atencao: {
          type: 'string',
          description: 'Um alerta curto e específico (1-2 frases), só quando os dados já obtidos mostrarem um problema real (ex: margem negativa, atraso relevante, queda forte). Omita este campo quando não houver nada que mereça destaque — nunca invente um alerta genérico só para preencher.',
        },
      },
      required: ['insights'],
      additionalProperties: false,
    },
    // Não é uma "ferramenta de dado" — não toca o banco, não recebe `ctx`.
    // Só devolve exatamente o que o modelo mandou, pra o orquestrador
    // (lib/ia/orchestrator.js) capturar como `apresentacaoInput` e passar
    // pra lib/ia/estrutura.js montar o card visual.
    handler: async (input) => input,
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
