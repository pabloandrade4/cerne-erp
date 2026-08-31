// Detalhamento de despesas — ativado em 31/08/2026. Une, SEM duplicar, as
// duas fontes reais de despesa que já existem no ERP:
//
//   1) contas_pagar pagas no período (mesma fonte, mesmo filtro que
//      lib/contasPagar.js#resumoContasPagar já usa pra `pagasNoPeriodo` —
//      nada de novo é somado aqui, só é reorganizado/detalhado por linha);
//   2) extrato_movimentos de saída que NUNCA viraram uma conta a pagar (ex.:
//      uma tarifa bancária vista só no extrato) — filtradas por
//      `conta_pagar_id IS NULL` e `transferencia_interna = false`.
//
// A condição `conta_pagar_id IS NULL` é o que garante que a soma nunca
// duplica: um movimento do extrato que FOI conciliado com uma conta a pagar
// (extrato_movimentos.conta_pagar_id preenchido) já está contado do lado de
// contas_pagar — ele nunca aparece de novo aqui. Uma transferência entre
// contas da própria empresa (transferencia_interna=true) nunca é despesa —
// nunca entra em nenhuma das duas listas.
//
// NÃO mexe em CMV (lib/resultadoVenda.js/lib/relatorioVendas.js) — essa
// fórmula continua isolada, cuidando só do custo da mercadoria vendida no
// momento da venda, como já funcionava antes desta etapa.
const pool = require('../db/pool');
const { dataCalendarioISO } = require('./periodo');

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// A origem de uma conta a pagar é derivada (nunca gravada como coluna
// separada) a partir de trilhas que já existem: despesa_fixa_id (veio da
// geração automática de despesa fixa), importacao_id (veio de uma planilha
// importada), documento/fornecedor_id (tem CR ou fornecedor — um
// lançamento "de boleto" de verdade); sem nenhuma dessas pistas, foi um
// lançamento simples digitado na hora (ex.: "Salgados").
function origemContaPagar(row) {
  if (row.despesa_fixa_id) return 'despesa_fixa';
  if (row.importacao_id) return 'conta_a_pagar';
  if (row.documento || row.fornecedor_id) return 'conta_a_pagar';
  return 'lancamento_manual';
}

function mapCategoria(nomeCategoria, nomeCategoriaPai) {
  // Se a categoria escolhida TEM pai, ela é a subcategoria e o pai é a
  // categoria "de cima" mostrada no bloco da DRE. Se não tem pai, ela
  // mesma é a categoria de cima e não há subcategoria.
  if (nomeCategoriaPai) return { categoria: nomeCategoriaPai, subcategoria: nomeCategoria };
  return { categoria: nomeCategoria || null, subcategoria: null };
}

async function listarDespesasDetalhadas({ empresaId, desde, ate, categoriaId, contaBancariaId, search }, db = null) {
  db = db || pool;
  const id = Number(empresaId);
  if (!id || !desde || !ate) return [];
  const temBusca = !!(search && String(search).trim());

  const condsCp = ['cp.empresa_id=$1', "cp.status='pago'", 'cp.data_pagamento >= $2', 'cp.data_pagamento <= $3'];
  const paramsCp = [id, desde, ate];
  if (Number(categoriaId)) { paramsCp.push(Number(categoriaId)); condsCp.push('(cp.categoria_id = $' + paramsCp.length + ' OR cat.categoria_pai_id = $' + paramsCp.length + ')'); }
  if (Number(contaBancariaId)) { paramsCp.push(Number(contaBancariaId)); condsCp.push('cp.conta_bancaria_id = $' + paramsCp.length); }
  if (temBusca) {
    paramsCp.push('%' + String(search).trim() + '%');
    const idx = paramsCp.length;
    condsCp.push('(cp.documento ILIKE $' + idx + ' OR cp.descricao ILIKE $' + idx + ' OR cp.categoria ILIKE $' + idx + ' OR f.razao_social ILIKE $' + idx + ' OR cp.fornecedor_nome_importado ILIKE $' + idx + ')');
  }
  const { rows: cpRows } = await db.query(
    `SELECT cp.*, f.razao_social AS fornecedor_nome, cb.nome AS conta_bancaria_nome,
            cat.nome AS categoria_nome_real, cat.id AS categoria_id_real, catp.nome AS categoria_pai_nome
     FROM contas_pagar cp
     LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     LEFT JOIN contas_bancarias cb ON cb.id = cp.conta_bancaria_id
     LEFT JOIN categorias_financeiras cat ON cat.id = cp.categoria_id
     LEFT JOIN categorias_financeiras catp ON catp.id = cat.categoria_pai_id
     WHERE ${condsCp.join(' AND ')}
     ORDER BY cp.data_pagamento DESC, cp.id DESC`,
    paramsCp
  );

  const despesasContasPagar = cpRows.map((r) => {
    const { categoria, subcategoria } = mapCategoria(r.categoria_nome_real || r.categoria, r.categoria_pai_nome);
    return {
      id: 'cp-' + r.id,
      tipo: 'contas_pagar',
      data: dataCalendarioISO(r.data_pagamento),
      descricao: r.descricao,
      categoria,
      subcategoria,
      categoriaId: r.categoria_id_real ? Number(r.categoria_id_real) : null,
      fornecedor: r.fornecedor_nome || r.fornecedor_nome_importado || null,
      documento: r.documento || null,
      contaBancaria: r.conta_bancaria_nome || r.banco_conta || null,
      origem: origemContaPagar(r),
      valor: round2(Number(r.valor)),
      status: 'pago',
    };
  });

  const condsEm = ['em.empresa_id=$1', "em.tipo='saida'", 'em.conta_pagar_id IS NULL', 'em.conta_receber_id IS NULL', 'em.transferencia_interna = false', 'em.data >= $2', 'em.data <= $3'];
  const paramsEm = [id, desde, ate];
  if (Number(categoriaId)) { paramsEm.push(Number(categoriaId)); condsEm.push('(em.categoria_id = $' + paramsEm.length + ' OR cat.categoria_pai_id = $' + paramsEm.length + ')'); }
  if (Number(contaBancariaId)) { paramsEm.push(Number(contaBancariaId)); condsEm.push('em.conta_bancaria_id = $' + paramsEm.length); }
  if (temBusca) {
    paramsEm.push('%' + String(search).trim() + '%');
    condsEm.push('em.descricao ILIKE $' + paramsEm.length);
  }
  const { rows: emRows } = await db.query(
    `SELECT em.*, cb.nome AS conta_bancaria_nome, cat.nome AS categoria_nome_real, cat.id AS categoria_id_real, catp.nome AS categoria_pai_nome
     FROM extrato_movimentos em
     LEFT JOIN contas_bancarias cb ON cb.id = em.conta_bancaria_id
     LEFT JOIN categorias_financeiras cat ON cat.id = em.categoria_id
     LEFT JOIN categorias_financeiras catp ON catp.id = cat.categoria_pai_id
     WHERE ${condsEm.join(' AND ')}
     ORDER BY em.data DESC, em.id DESC`,
    paramsEm
  );

  const despesasExtrato = emRows.map((r) => {
    const { categoria, subcategoria } = mapCategoria(r.categoria_nome_real, r.categoria_pai_nome);
    return {
      id: 'em-' + r.id,
      tipo: 'extrato',
      data: dataCalendarioISO(r.data),
      descricao: r.descricao,
      categoria,
      subcategoria,
      categoriaId: r.categoria_id_real ? Number(r.categoria_id_real) : null,
      fornecedor: null,
      documento: null,
      contaBancaria: r.conta_bancaria_nome || null,
      origem: 'extrato_bancario',
      valor: round2(Number(r.valor)),
      status: 'pago',
    };
  });

  return [...despesasContasPagar, ...despesasExtrato].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
}

// Agrupa a lista já unificada por categoria de topo, aninhando
// subcategorias — alimenta tanto o bloco expansível da DRE quanto o
// gráfico "Para onde está indo o dinheiro?" (mesmos números, sempre).
function agruparPorCategoria(despesas) {
  const mapa = new Map();
  for (const d of despesas) {
    const chave = d.categoria || 'Sem categoria';
    if (!mapa.has(chave)) mapa.set(chave, { categoria: chave, total: 0, quantidade: 0, subcategorias: new Map(), itens: [] });
    const g = mapa.get(chave);
    g.total = round2(g.total + d.valor);
    g.quantidade += 1;
    g.itens.push(d);
    if (d.subcategoria) {
      if (!g.subcategorias.has(d.subcategoria)) g.subcategorias.set(d.subcategoria, { subcategoria: d.subcategoria, total: 0, quantidade: 0, itens: [] });
      const s = g.subcategorias.get(d.subcategoria);
      s.total = round2(s.total + d.valor);
      s.quantidade += 1;
      s.itens.push(d);
    }
  }
  return Array.from(mapa.values())
    .map((g) => ({ ...g, subcategorias: Array.from(g.subcategorias.values()).sort((a, b) => b.total - a.total) }))
    .sort((a, b) => b.total - a.total);
}

function diasNoIntervalo(desde, ate) {
  const [y1, m1, d1] = String(desde).split('-').map(Number);
  const [y2, m2, d2] = String(ate).split('-').map(Number);
  const ms = Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

// Cards do topo da DRE — sempre calculados a partir da MESMA lista que
// alimenta o detalhamento e o gráfico (nunca uma segunda consulta com
// filtro diferente, pra nunca divergir).
function calcularCards(despesas, desde, ate) {
  const total = round2(despesas.reduce((s, d) => s + d.valor, 0));
  const porCategoria = agruparPorCategoria(despesas);
  const dias = desde && ate ? diasNoIntervalo(desde, ate) : 0;
  return {
    totalDespesas: total,
    maiorCategoria: porCategoria[0] ? { categoria: porCategoria[0].categoria, valor: porCategoria[0].total } : null,
    segundaMaiorCategoria: porCategoria[1] ? { categoria: porCategoria[1].categoria, valor: porCategoria[1].total } : null,
    quantidadeDespesas: despesas.length,
    mediaPorDia: dias ? round2(total / dias) : 0,
  };
}

module.exports = { listarDespesasDetalhadas, agruparPorCategoria, calcularCards, diasNoIntervalo, origemContaPagar };
