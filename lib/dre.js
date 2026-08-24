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

async function gerarDRE({ empresaId, desde, ate, desdeBRT, ateBRT }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const resumo = resumirPeriodo(pedidos);
  const despesas = await resumoContasPagar({ empresaId, desde: desdeBRT, ate: ateBRT });

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

  const despesasPeriodo = { valor: despesas.pagasNoPeriodo, pendentes: 0 }; // resumoContasPagar nunca retorna null — 0 quando nada foi pago no período

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
  };
}

module.exports = { gerarDRE, normalizarZero, somar, subtrair, percentualSobreFaturamento };
