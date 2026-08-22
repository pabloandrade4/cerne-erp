// Pedidos importados do Mercado Livre: listagem e detalhe (com o cálculo
// financeiro preparado no Passo 3 — comissão real da API, frete do vendedor
// real da API, imposto configurado pelo ERP e custo do produto cadastrado).
const express = require('express');
const pool = require('../db/pool');
const { calcularResultadoVenda } = require('../lib/resultadoVenda');

const router = express.Router();

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

// Empacota o resultado financeiro de uma linha da listagem (já traz
// custo_produto_total pronto da query — ver GET /). Mesma fórmula usada no
// detalhe (lib/resultadoVenda.js), só a origem dos dados muda.
function serializeResumo(row, aliquotaImposto) {
  const valorVenda = toNum(row.valor_total);
  const custoProduto = toNum(row.custo_produto_total);
  const calc = calcularResultadoVenda({
    valorVenda,
    taxaVenda: toNum(row.taxa_venda_total),
    pagamentoTaxas: toNum(row.pagamento_taxas),
    pagamentoTaxaMarketplace: toNum(row.pagamento_taxa_marketplace),
    freteVendedor: toNum(row.frete_vendedor),
    custoProduto,
    aliquotaImposto,
  });

  return {
    id: row.id,
    empresaId: row.empresa_id,
    contaMlId: row.conta_ml_id,
    mlOrderId: String(row.ml_order_id),
    dataCriacao: row.data_criacao,
    status: row.status,
    compradorNickname: row.comprador_nickname,
    valorTotal: valorVenda,
    moeda: row.moeda,
    itemResumo: row.item_resumo,
    qtdItens: Number(row.qtd_itens) || 0,
    freteComprador: toNum(row.frete_comprador),
    freteVendedor: toNum(row.frete_vendedor),
    envioLogisticType: row.envio_logistic_type,
    tarifasMl: calc.tarifasTotal,
    imposto: calc.imposto,
    custoProduto,
    margemLiquida: calc.resultado,
    calculoCompleto: calc.calculoCompleto,
  };
}

// GET /api/pedidos?empresaId=ID — lista pedidos de uma empresa (via conta ML dela)
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: configRows } = await pool.query(
      'SELECT aliquota_imposto FROM config_financeiro WHERE empresa_id = $1',
      [empresaId]
    );
    const aliquotaImposto = configRows.length ? Number(configRows[0].aliquota_imposto) : 0;

    const { rows } = await pool.query(
      `SELECT p.*,
              (SELECT string_agg(titulo, ' + ' ORDER BY id) FROM (
                 SELECT titulo, id FROM ml_pedido_itens WHERE pedido_id = p.id ORDER BY id LIMIT 2
               ) t) AS item_resumo,
              (SELECT count(*) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_itens,
              (SELECT CASE WHEN bool_and(cp.custo IS NOT NULL) THEN SUM(cp.custo * pi.quantidade) ELSE NULL END
                 FROM ml_pedido_itens pi
                 LEFT JOIN custos_produto cp ON cp.empresa_id = $1 AND cp.sku = pi.sku
                 WHERE pi.pedido_id = p.id
              ) AS custo_produto_total
       FROM ml_pedidos p
       JOIN ml_contas c ON c.id = p.conta_ml_id
       WHERE c.empresa_id = $1
       ORDER BY p.data_criacao DESC NULLS LAST
       LIMIT 200`,
      [empresaId]
    );
    res.json({ pedidos: rows.map((r) => serializeResumo(r, aliquotaImposto)) });
  } catch (err) { next(err); }
});

// GET /api/pedidos/:id — detalhe completo + resultado financeiro (Passo 3)
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, e.id AS empresa_id_real
       FROM ml_pedidos p
       JOIN ml_contas c ON c.id = p.conta_ml_id
       JOIN empresas e ON e.id = c.empresa_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const pedido = rows[0];
    const empresaId = pedido.empresa_id_real;

    const { rows: itens } = await pool.query(
      'SELECT * FROM ml_pedido_itens WHERE pedido_id = $1 ORDER BY id',
      [pedido.id]
    );

    const skus = [...new Set(itens.map((i) => i.sku).filter(Boolean))];
    let custosPorSku = {};
    if (skus.length) {
      const { rows: custosRows } = await pool.query(
        'SELECT sku, custo FROM custos_produto WHERE empresa_id = $1 AND sku = ANY($2::text[])',
        [empresaId, skus]
      );
      custosPorSku = Object.fromEntries(custosRows.map((c) => [c.sku, Number(c.custo)]));
    }

    const { rows: configRows } = await pool.query(
      'SELECT aliquota_imposto FROM config_financeiro WHERE empresa_id = $1',
      [empresaId]
    );
    const aliquotaImposto = configRows.length ? Number(configRows[0].aliquota_imposto) : 0;

    const pendencias = [];
    let custoProdutoTotal = 0;
    let custoCompleto = true;
    const itensDetalhados = itens.map((it) => {
      const qtd = it.quantidade || 0;
      let custoUnitario = null;
      if (!it.sku) {
        custoCompleto = false;
        pendencias.push(`Item "${it.titulo || it.ml_item_id}" não tem SKU informado pelo Mercado Livre — custo não pode ser vinculado.`);
      } else if (custosPorSku[it.sku] === undefined) {
        custoCompleto = false;
        pendencias.push(`Custo do SKU "${it.sku}" ainda não foi cadastrado.`);
      } else {
        custoUnitario = custosPorSku[it.sku];
        custoProdutoTotal += custoUnitario * qtd;
      }
      return {
        id: it.id,
        mlItemId: it.ml_item_id,
        titulo: it.titulo,
        sku: it.sku,
        quantidade: qtd,
        precoUnitario: toNum(it.preco_unitario),
        precoUnitarioOriginal: toNum(it.preco_unitario_original),
        valorTotalItem: toNum(it.valor_total_item),
        taxaVenda: toNum(it.taxa_venda),
        custoUnitario,
        custoTotal: custoUnitario != null ? Math.round(custoUnitario * qtd * 100) / 100 : null,
      };
    });

    const valorVenda = toNum(pedido.valor_total);
    const taxaVenda = toNum(pedido.taxa_venda_total);
    const pagamentoTaxas = toNum(pedido.pagamento_taxas);
    const pagamentoTaxaMarketplace = toNum(pedido.pagamento_taxa_marketplace);
    const freteVendedor = toNum(pedido.frete_vendedor);
    const freteComprador = toNum(pedido.frete_comprador);

    if (taxaVenda === null) pendencias.push('O Mercado Livre não retornou a comissão (sale_fee) deste pedido.');
    if (freteVendedor === null) pendencias.push('O Mercado Livre não retornou o custo de frete do vendedor deste pedido.');

    const custoProdutoFinal = itens.length && custoCompleto ? Math.round(custoProdutoTotal * 100) / 100 : null;

    const { tarifasComponentes, tarifasTotal, imposto, resultado, calculoCompleto } = calcularResultadoVenda({
      valorVenda,
      taxaVenda,
      pagamentoTaxas,
      pagamentoTaxaMarketplace,
      freteVendedor,
      custoProduto: custoProdutoFinal,
      aliquotaImposto,
    });

    res.json({
      pedido: {
        id: pedido.id,
        empresaId,
        mlOrderId: String(pedido.ml_order_id),
        packId: pedido.pack_id ? String(pedido.pack_id) : null,
        dataCriacao: pedido.data_criacao,
        dataFechamento: pedido.data_fechamento,
        status: pedido.status,
        statusDetail: pedido.status_detail,
        compradorId: pedido.comprador_id ? String(pedido.comprador_id) : null,
        compradorNickname: pedido.comprador_nickname,
        moeda: pedido.moeda,
        mlPaymentId: pedido.ml_payment_id ? String(pedido.ml_payment_id) : null,
        mlShippingId: pedido.ml_shipping_id ? String(pedido.ml_shipping_id) : null,
        envioStatus: pedido.envio_status,
        envioLogisticMode: pedido.envio_logistic_mode,
        envioLogisticType: pedido.envio_logistic_type,
      },
      itens: itensDetalhados,
      resultadoFinanceiro: {
        valorVenda,
        tarifasMl: { total: tarifasTotal, componentes: tarifasComponentes },
        freteVendedor,
        freteComprador,
        imposto: { aliquota: aliquotaImposto, valor: imposto },
        custoProduto: custoProdutoFinal,
        resultado,
        calculoCompleto,
        pendencias,
      },
      auditoria: {
        rawPedidoDisponivel: !!pedido.raw_pedido,
        rawEnvioDisponivel: !!pedido.raw_envio,
        rawCustosEnvioDisponivel: !!pedido.raw_custos_envio,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
