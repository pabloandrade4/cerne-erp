// Pedidos importados do Mercado Livre: listagem e detalhe (com o cálculo
// financeiro preparado no Passo 3 — comissão real da API, frete do vendedor
// real da API, imposto configurado pelo ERP e custo do produto cadastrado).
//
// A listagem usa lib/relatorioVendas.js — a MESMA função usada por Visão
// Geral e Financeiro (routes/relatorios.js) — pra nunca mostrar um número
// diferente do que essas duas telas mostram pro mesmo período.
const express = require('express');
const pool = require('../db/pool');
const { calcularResultadoVenda, round2 } = require('../lib/resultadoVenda');
const { calcularPeriodo } = require('../lib/periodo');
const { buscarPedidosDoPeriodo } = require('../lib/relatorioVendas');

const router = express.Router();

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

const LIMITE_LISTAGEM = 500;

// GET /api/pedidos?empresaId=ID&periodo=30d — lista pedidos de uma empresa no período
// periodo: hoje | ontem | 7d | 30d (padrão) | mes
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      limit: LIMITE_LISTAGEM,
    });

    res.json({
      pedidos,
      totalNoPeriodo,
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
    });
  } catch (err) { next(err); }
});

// GET /api/pedidos/:id — detalhe completo + resultado financeiro (Passo 3)
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, e.id AS empresa_id_real, c.nickname AS conta_nickname
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
    const margemPercentual = resultado !== null && valorVenda ? round2((resultado / valorVenda) * 100) : null;

    res.json({
      pedido: {
        id: pedido.id,
        empresaId,
        loja: pedido.conta_nickname,
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
        margemPercentual,
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
