// DRE (Demonstrativo de Resultado do Exercício) — ativado em 24/08/2026.
//
// NÃO existe cálculo financeiro novo aqui: a DRE só reorganiza, em forma de
// demonstrativo, números que já são calculados em outro lugar —
// lib/relatorioVendas.js (buscarPedidosDoPeriodo + resumirPeriodo, a MESMA
// fonte única já usada por Visão Geral, Pedidos e Financeiro) para a parte
// de vendas, e lib/contasPagar.js (resumoContasPagar) para a linha de
// despesas/contas pagas do período. Nenhuma das duas funções foi alterada
// nem duplicada — ver docs/02-decisoes.md para o desenho completo de cada
// linha e por quê.
//
// Regra do usuário: nunca inventar valor. "Sem dados" (nenhum pedido no
// período) e "Pendente" (tem pedido, mas falta alguma informação) seguem
// exatamente a mesma distinção já usada em Visão Geral/Financeiro — ver
// `normalizarZero` abaixo.
const { buscarPedidosDoPeriodo, resumirPeriodo } = require('./relatorioVendas');
const { resumoContasPagar } = require('./contasPagar');
const { round2 } = require('./resultadoVenda');
const { periodoParaDatasBRT } = require('./periodo');
const { listarDespesasDetalhadas, agruparPorCategoria, calcularCards } = require('./despesasFinanceiras');

// Período PRÓPRIO da DRE (31/08/2026) — deliberadamente separado do período
// compartilhado de Visão Geral/Pedidos/Financeiro (lib/periodo.js), mesmo
// padrão já usado por lib/fluxoCaixa.js#calcularPeriodoFluxoCaixa: a DRE
// precisa de opções que as outras telas não têm (15 dias, mês anterior,
// personalizado) sem arriscar mudar o dropdown de nenhuma outra tela.
// Reaproveita a mesma matemática de fuso (BRT, UTC-3 fixo) já documentada
// em lib/periodo.js.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const UM_DIA_MS = 24 * 60 * 60 * 1000;
const PERIODOS_DRE_VALIDOS = ['hoje', '7d', '15d', '30d', 'mes', 'mesAnterior', 'personalizado'];

function inicioDoDiaBRT(instante) {
  const brt = new Date(instante.getTime() - BRT_OFFSET_MS);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + BRT_OFFSET_MS);
}
function inicioDoMesBRT(instante) {
  const brt = new Date(instante.getTime() - BRT_OFFSET_MS);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1) + BRT_OFFSET_MS);
}

function calcularPeriodoDre(chaveRecebida, { desde: desdeQuery, ate: ateQuery } = {}) {
  const agora = new Date();
  if (chaveRecebida === 'personalizado' && desdeQuery && ateQuery) {
    const desde = new Date(desdeQuery + 'T00:00:00.000-03:00');
    let ate = new Date(ateQuery + 'T00:00:00.000-03:00');
    ate = new Date(ate.getTime() + UM_DIA_MS); // limite exclusivo, igual ao resto do projeto
    if (ate <= desde) ate = new Date(desde.getTime() + UM_DIA_MS);
    return { chave: 'personalizado', label: 'Período personalizado', desde, ate };
  }
  if (chaveRecebida === 'hoje') {
    const desde = inicioDoDiaBRT(agora);
    return { chave: 'hoje', label: 'Hoje', desde, ate: new Date(desde.getTime() + UM_DIA_MS) };
  }
  if (chaveRecebida === 'mes') {
    return { chave: 'mes', label: 'Este mês', desde: inicioDoMesBRT(agora), ate: agora };
  }
  if (chaveRecebida === 'mesAnterior') {
    const inicioMesAtual = inicioDoMesBRT(agora);
    // Último instante do mês anterior é o próprio início deste mês (limite
    // exclusivo); o início do mês anterior é o início deste mês menos os
    // dias do mês anterior — calculado a partir do dia BRT, nunca por
    // subtração de milissegundos fixos (meses têm tamanhos diferentes).
    const brt = new Date(inicioMesAtual.getTime() - BRT_OFFSET_MS);
    const inicioMesAnterior = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth() - 1, 1) + BRT_OFFSET_MS);
    return { chave: 'mesAnterior', label: 'Mês anterior', desde: inicioMesAnterior, ate: inicioMesAtual };
  }
  const dias = { '7d': 7, '15d': 15, '30d': 30 }[chaveRecebida] || 30;
  const chave = ['7d', '15d', '30d'].includes(chaveRecebida) ? chaveRecebida : '30d';
  return { chave, label: `Últimos ${dias} dias`, desde: new Date(agora.getTime() - dias * UM_DIA_MS), ate: agora };
}

// `campo` é sempre { valor, pendentes } (formato de somarComPendencia em
// relatorioVendas.js). Quando valor é null: pendentes>0 significa "havia
// pedido nesse grupo, mas faltou essa informação" (pendência real, fica
// null); pendentes===0 significa "o grupo estava vazio" (soma de nada é
// zero de verdade, não pendência) — vira 0. Mesma distinção já documentada
// em docs/01-regras-de-negocio.md (Relatório de Pedidos): zero de verdade
// é diferente de dado faltando.
//
// `hasOrders` (true quando há QUALQUER pedido, cancelado ou não, no
// período inteiro) tem prioridade: sem nenhum pedido no período, a DRE
// mostra "Sem dados" (null) em vez de "R$ 0,00" — mesma convenção já usada
// em Visão Geral ("Se não houver nenhum pedido no período, os indicadores
// mostram 'Sem dados'"). Sem esse gate, um grupo vazio all-zero (ex:
// nenhum pedido cancelado nem não-cancelado) viraria 0 mesmo quando o
// período inteiro está vazio.
function normalizarZero(campo, hasOrders) {
  if (!hasOrders) return { valor: null, pendentes: 0 };
  if (campo.valor !== null) return campo;
  return campo.pendentes > 0 ? campo : { valor: 0, pendentes: 0 };
}

// Soma vários campos {valor,pendentes}, propagando null (pendente) se
// QUALQUER um dos campos for null.
function somar(...campos) {
  const pendentes = campos.reduce((s, c) => s + (c.pendentes || 0), 0);
  if (campos.some((c) => c.valor === null)) return { valor: null, pendentes };
  return { valor: round2(campos.reduce((s, c) => s + c.valor, 0)), pendentes };
}

// base - soma(campos), propagando null.
function subtrair(base, ...campos) {
  return somar(base, ...campos.map((c) => ({ valor: c.valor === null ? null : -c.valor, pendentes: c.pendentes })));
}

// Percentual sobre o faturamento (mesma base já usada por
// resumirPeriodo/margemPercentual — resumo.faturamento.valor, ou seja, o
// total de vendas NÃO canceladas do período). Null quando o faturamento é
// pendente OU exatamente zero (não dá pra calcular percentual sobre uma
// base zero/desconhecida).
function percentualSobreFaturamento(valor, faturamentoBase) {
  if (valor === null || faturamentoBase === null || !faturamentoBase) return null;
  return round2((valor / faturamentoBase) * 100);
}

function linha(campo, faturamentoBase) {
  return { valor: campo.valor, pendentes: campo.pendentes, percentual: percentualSobreFaturamento(campo.valor, faturamentoBase) };
}

async function gerarDRE({ empresaId, desde, ate, desdeBRT, ateBRT, categoriaId, contaBancariaId }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const resumo = resumirPeriodo(pedidos);
  const despesas = await resumoContasPagar({ empresaId, desde: desdeBRT, ate: ateBRT });

  // Detalhamento linha-a-linha + agrupamento por categoria (31/08/2026) —
  // ver lib/despesasFinanceiras.js pra como isso nunca soma o mesmo real
  // duas vezes (contas a pagar conciliadas com o extrato só entram uma
  // vez, transferência interna nunca entra). ÚNICA mudança real na fórmula
  // da DRE nesta etapa: `despesasPeriodo` (e por consequência
  // `resultadoFinal`) passa a incluir também saídas do extrato bancário
  // que nunca viraram uma conta a pagar (ex.: uma tarifa vista só no
  // extrato) — antes, esse tipo de saída simplesmente não entrava na DRE
  // em lugar nenhum. Tudo o mais (receita, cancelamentos, CMV, margem de
  // contribuição) continua exatamente a mesma fórmula de antes.
  const despesasDetalhadas = await listarDespesasDetalhadas({ empresaId, desde: desdeBRT, ate: ateBRT, categoriaId, contaBancariaId });
  const blocoDespesasPorCategoria = agruparPorCategoria(despesasDetalhadas);
  const cardsDespesas = calcularCards(despesasDetalhadas, desdeBRT, ateBRT);

  const hasOrders = resumo.qtdPedidos + resumo.cancelados.quantidade > 0;

  const fat = normalizarZero(resumo.faturamento, hasOrders);
  const canc = normalizarZero({
    valor: resumo.cancelados.valor,
    pendentes: resumo.cancelados.valor === null && resumo.cancelados.quantidade > 0 ? resumo.cancelados.quantidade : 0,
  }, hasOrders);
  const desc = normalizarZero(resumo.desconto, hasOrders);
  const custo = normalizarZero(resumo.custoProduto, hasOrders);
  const tarifas = normalizarZero(resumo.tarifas, hasOrders);
  const frete = normalizarZero(resumo.freteVendedor, hasOrders);
  const imposto = normalizarZero(resumo.imposto, hasOrders);
  // Margem de Contribuição é SEMPRE lida direto de resumirPeriodo (nunca
  // recalculada por subtração aqui) — é a fonte única, a mesma que
  // Pedidos/Visão Geral/Financeiro mostram. Ver docs/02-decisoes.md sobre
  // por que a soma das linhas do demonstrativo pode, em casos raros de
  // pendência parcial (um pedido com uma informação faltando mas outra
  // presente), não bater centavo a centavo com este número — este número é
  // sempre o correto.
  const margemContribuicao = normalizarZero(resumo.margemContribuicao, hasOrders);

  const receitaBruta = somar(fat, canc);
  const receitaLiquida = subtrair(receitaBruta, canc, desc);

  const faturamentoBase = fat.valor; // mesma base de resumo.margemPercentual

  // `despesasPeriodo.valor` agora vem de `cardsDespesas.totalDespesas` — a
  // MESMA lista unificada (contas a pagar pagas + saídas de extrato nunca
  // conciliadas) que alimenta o bloco por categoria, o gráfico "Para onde
  // está indo o dinheiro?" e o detalhamento linha-a-linha, pra nunca
  // divergir entre o card do topo e o restante da tela. `despesas.pagasNoPeriodo`
  // (só contas a pagar) fica disponível abaixo, em `despesasContasPagarApenas`,
  // só pra transparência/depuração — nunca é o que alimenta o Resultado Final.
  const despesasPeriodo = { valor: cardsDespesas.totalDespesas, pendentes: 0 }; // listarDespesasDetalhadas nunca retorna null — 0 quando nada no período
  const despesasContasPagarApenas = { valor: despesas.pagasNoPeriodo, pendentes: 0 }; // resumoContasPagar nunca retorna null — 0 quando nada foi pago no período

  // Resultado Final só é calculável quando a Margem de Contribuição em si é
  // conhecida (não "Sem dados"/pendente) — sem saber a receita, não dá pra
  // afirmar um resultado final, mesmo sabendo as despesas pagas.
  const resultadoFinal = margemContribuicao.valor === null
    ? { valor: null, pendentes: margemContribuicao.pendentes }
    : { valor: round2(margemContribuicao.valor - despesasPeriodo.valor), pendentes: margemContribuicao.pendentes };

  return {
    empresaId: Number(empresaId),
    hasOrders,
    qtdPedidos: resumo.qtdPedidos,
    qtdPedidosCancelados: resumo.cancelados.quantidade,
    totalNoPeriodo,
    linhas: {
      receitaBruta: linha(receitaBruta, faturamentoBase),
      cancelamentos: linha(canc, faturamentoBase),
      descontos: linha(desc, faturamentoBase),
      receitaLiquida: linha(receitaLiquida, faturamentoBase),
      custoProdutos: linha(custo, faturamentoBase),
      taxasComissoes: linha(tarifas, faturamentoBase),
      freteVendedor: linha(frete, faturamentoBase),
      impostos: linha(imposto, faturamentoBase),
      // percentual da margem de contribuição é o MESMO resumo.margemPercentual
      // já usado em Financeiro/Visão Geral (não recalculado aqui), pra nunca
      // divergir da mesma porcentagem mostrada nas outras telas.
      margemContribuicao: { valor: margemContribuicao.valor, pendentes: margemContribuicao.pendentes, percentual: resumo.margemPercentual },
      despesasPeriodo: linha(despesasPeriodo, faturamentoBase),
      resultadoFinal: linha(resultadoFinal, faturamentoBase),
    },
    // Bloco novo (31/08/2026) — "PARA ONDE ESTÁ INDO O DINHEIRO?": cards,
    // categorias expansíveis (com subcategoria e itens) e o detalhamento
    // linha-a-linha, todos derivados da MESMA lista (`despesasDetalhadas`),
    // nunca de uma segunda consulta com filtro diferente. `despesasDetalhadas`
    // aqui já vem limitado (ver listarDespesasDetalhadas/routes/dre.js) —
    // a busca/paginação fina do detalhamento completo é servida por
    // GET /api/dre/detalhamento, que aceita os mesmos filtros + `search`.
    despesas: {
      cards: cardsDespesas,
      porCategoria: blocoDespesasPorCategoria,
      contasPagarApenas: despesasContasPagarApenas, // só pra depuração/transparência — nunca usado no cálculo do Resultado Final
    },
  };
}

module.exports = {
  gerarDRE,
  normalizarZero,
  somar,
  subtrair,
  percentualSobreFaturamento,
  calcularPeriodoDre,
  PERIODOS_DRE_VALIDOS,
};
