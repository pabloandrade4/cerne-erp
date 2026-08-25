// Agregação de Compras por fornecedor — criado para a IA Gestora (tarefa
// "IA Gestora como inteligência central", docs/02-decisoes.md). routes/
// compras.js nunca teve um módulo lib próprio (a lógica de CRUD mora direto
// na rota) porque, até aqui, nada além da própria tela Compras precisava
// desses dados; agora a IA Gestora precisa de um resumo agregado, então
// esta função nasce aqui (não em routes/compras.js) pra poder ser
// reaproveitada sem duplicar SQL. Nenhuma regra nova: "valor_total" de cada
// compra é o mesmo campo já calculado pelo servidor na criação/edição da
// compra (routes/compras.js) — este arquivo só agrupa e soma o que já
// existe no banco.
const pool = require('../db/pool');
const { round2 } = require('./resultadoVenda');

// Resumo de compras (pedidos de compra a fornecedores) de uma empresa,
// filtradas pela DATA DA COMPRA dentro de [desde, ate] (datas BRT,
// 'YYYY-MM-DD' — mesmo padrão de contas_pagar/contas_receber).
//
// Compras CANCELADAS nunca representam gasto real (mesma filosofia de
// "pedido cancelado não é venda de verdade" já usada em pedidos do Mercado
// Livre) — ficam de fora do total geral e do total por fornecedor, e
// aparecem só à parte, como contagem/valor informativo.
async function resumoComprasPorFornecedor({ empresaId, desde, ate }) {
  const { rows } = await pool.query(
    `SELECT f.id AS fornecedor_id, f.razao_social AS fornecedor_nome,
            c.status, c.valor_total
     FROM compras c
     JOIN fornecedores f ON f.id = c.fornecedor_id
     WHERE c.empresa_id = $1 AND c.data_compra >= $2 AND c.data_compra <= $3`,
    [empresaId, desde, ate]
  );

  const naoCanceladas = rows.filter((r) => r.status !== 'cancelado');
  const canceladas = rows.filter((r) => r.status === 'cancelado');

  const porFornecedor = new Map();
  naoCanceladas.forEach((r) => {
    const chave = r.fornecedor_id;
    if (!porFornecedor.has(chave)) {
      porFornecedor.set(chave, { fornecedorId: r.fornecedor_id, fornecedorNome: r.fornecedor_nome, quantidadeCompras: 0, valorTotal: 0 });
    }
    const acc = porFornecedor.get(chave);
    acc.quantidadeCompras += 1;
    acc.valorTotal = round2(acc.valorTotal + Number(r.valor_total));
  });

  const porStatus = { em_aberto: 0, pedido_realizado: 0, recebido: 0, cancelado: 0 };
  rows.forEach((r) => { porStatus[r.status] = (porStatus[r.status] || 0) + 1; });

  return {
    quantidadeCompras: naoCanceladas.length,
    valorTotal: round2(naoCanceladas.reduce((s, r) => s + Number(r.valor_total), 0)),
    quantidadeCanceladas: canceladas.length,
    valorCancelado: round2(canceladas.reduce((s, r) => s + Number(r.valor_total), 0)),
    porStatus,
    porFornecedor: [...porFornecedor.values()].sort((a, b) => b.valorTotal - a.valorTotal),
  };
}

module.exports = { resumoComprasPorFornecedor };
