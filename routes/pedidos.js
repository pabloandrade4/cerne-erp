// Pedidos importados do Mercado Livre: listagem, detalhe e relatório
// exportável (com o cálculo financeiro preparado no Passo 3 — comissão real
// da API, frete do vendedor real da API, imposto configurado pelo ERP e
// custo do produto cadastrado).
//
// A listagem e o relatório usam lib/relatorioVendas.js — a MESMA função
// usada por Visão Geral e Financeiro (routes/relatorios.js) — pra nunca
// mostrar (ou exportar) um número diferente do que essas telas mostram pro
// mesmo período. Os filtros de loja/status/produto-SKU e a exportação são
// só desta rota — relatorioVendas.js e resultadoVenda.js não foram
// alterados, nem duplicados: o relatório reaproveita exatamente as mesmas
// funções (`buscarPedidosDoPeriodo`, `resumirPeriodo`), só filtrando o
// array de pedidos já calculado antes de somar os totais.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { calcularResultadoVenda, round2 } = require('../lib/resultadoVenda');
const { calcularPeriodo, diaBRT } = require('../lib/periodo');
const { buscarPedidosDoPeriodo, resumirPeriodo } = require('../lib/relatorioVendas');

const router = express.Router();

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

const LIMITE_LISTAGEM = 500;

// Filtros novos (loja, status, produto/SKU) — aplicados em cima do array já
// calculado por buscarPedidosDoPeriodo, nunca mudando a query/cálculo
// compartilhado. `busca` procura tanto no resumo de produtos quanto no de
// SKUs do pedido (mesma coluna combinada "Produto / SKU" da tela).
function filtrarPedidos(pedidos, { contaId, status, busca }) {
  const alvo = busca ? busca.trim().toLowerCase() : '';
  return pedidos.filter((p) => {
    if (contaId && String(p.contaMlId) !== String(contaId)) return false;
    if (status && p.status !== status) return false;
    if (alvo) {
      const hitProduto = (p.produtoResumo || '').toLowerCase().includes(alvo);
      const hitSku = (p.skuResumo || '').toLowerCase().includes(alvo);
      if (!hitProduto && !hitSku) return false;
    }
    return true;
  });
}

// Opções reais para os filtros de Loja e Status — nunca uma lista fixa
// "chutada": Loja vem das contas do Mercado Livre já conectadas à empresa;
// Status vem dos status que realmente aparecem nos pedidos do período (não
// existe lista fechada de status documentada — é o que a API do Mercado
// Livre mandou). Consultas simples (sem as subqueries de itens/custo de
// buscarPedidosDoPeriodo), então não pesam no carregamento da tela.
async function buscarLojasDaEmpresa(empresaId) {
  const { rows } = await pool.query(
    'SELECT id, nickname FROM ml_contas WHERE empresa_id = $1 ORDER BY nickname',
    [empresaId]
  );
  return rows.map((r) => ({ id: r.id, nickname: r.nickname }));
}

async function buscarStatusDoPeriodo(empresaId, desde, ate) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.status FROM ml_pedidos p
     JOIN ml_contas c ON c.id = p.conta_ml_id
     WHERE c.empresa_id = $1 AND p.data_criacao >= $2 AND p.data_criacao < $3 AND p.status IS NOT NULL
     ORDER BY p.status`,
    [empresaId, desde, ate]
  );
  return rows.map((r) => r.status);
}

// GET /api/pedidos?empresaId=ID&periodo=30d&contaId=&status=&busca=
// periodo: hoje | ontem | 7d | 30d (padrão) | mes
// contaId/status/busca são opcionais — quando nenhum é usado, o
// comportamento (e a velocidade) fica idêntico a antes desta etapa: busca
// os 500 pedidos mais recentes do período direto no banco. Quando algum
// filtro extra é usado, busca TODOS os pedidos do período (sem o LIMIT no
// banco) pra filtrar em memória sem arriscar deixar de fora um pedido que
// bateria o filtro mas não estava entre os 500 mais recentes.
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, status, busca } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const temFiltroExtra = !!(contaId || status || (busca && busca.trim()));

    const { pedidos: base, totalNoPeriodo } = await buscarPedidosDoPeriodo({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      limit: temFiltroExtra ? undefined : LIMITE_LISTAGEM,
    });

    const filtrados = temFiltroExtra ? filtrarPedidos(base, { contaId, status, busca }) : base;

    const [lojasDisponiveis, statusDisponiveis] = await Promise.all([
      buscarLojasDaEmpresa(empresaId),
      buscarStatusDoPeriodo(empresaId, periodoCalc.desde, periodoCalc.ate),
    ]);

    res.json({
      pedidos: filtrados.slice(0, LIMITE_LISTAGEM),
      totalFiltrado: filtrados.length,
      totalNoPeriodo,
      filtrosDisponiveis: { lojas: lojasDisponiveis, status: statusDisponiveis },
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
    });
  } catch (err) { next(err); }
});

// ================= Relatório de Pedidos (exportação XLSX/CSV) =================
// Reaproveita buscarPedidosDoPeriodo + resumirPeriodo (lib/relatorioVendas.js,
// intocado) — o relatório nunca calcula margem/taxa/imposto/custo com uma
// fórmula própria, só filtra o array já calculado e soma com a mesma função
// usada em Visão Geral/Financeiro/Pedidos.

function fmtDataBR(instante) {
  if (!instante) return '';
  try { return new Date(instante).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
  catch (e) { return ''; }
}

// Nome do arquivo: relatorio-pedidos-AAAA-MM-DD.ext (um dia) ou
// relatorio-pedidos-AAAA-MM-DD-a-AAAA-MM-DD.ext (intervalo) — sempre a
// partir do período real calculado (nunca uma data "hoje" genérica).
function formatarNomeArquivo(periodoCalc, extensao) {
  const diaInicio = diaBRT(periodoCalc.desde);
  const diaFim = diaBRT(new Date(periodoCalc.ate.getTime() - 1));
  const base = diaInicio === diaFim ? `relatorio-pedidos-${diaInicio}` : `relatorio-pedidos-${diaInicio}-a-${diaFim}`;
  return `${base}.${extensao}`;
}

// Descontos por pedido: full_unit_price (preço original) vs unit_price
// (preço pago), somado por item — dado real já guardado na sincronização do
// Mercado Livre (não é uma regra financeira nova). Se algum item do pedido
// não tem preço original informado pela API, o desconto desse pedido fica
// `null` (pendente) — nunca é tratado como zero.
async function buscarDescontosPorPedido(pedidoIds) {
  if (!pedidoIds.length) return {};
  const { rows } = await pool.query(
    `SELECT pedido_id,
            CASE WHEN bool_and(preco_unitario_original IS NOT NULL)
                 THEN SUM((preco_unitario_original - preco_unitario) * COALESCE(quantidade, 0))
                 ELSE NULL END AS desconto_total
     FROM ml_pedido_itens
     WHERE pedido_id = ANY($1::int[])
     GROUP BY pedido_id`,
    [pedidoIds]
  );
  return Object.fromEntries(rows.map((r) => [r.pedido_id, r.desconto_total === null ? null : Number(r.desconto_total)]));
}

// Uma linha por pedido (não por item) — mesma granularidade já mostrada na
// tela Pedidos (produto/SKU resumidos quando o pedido tem mais de um item).
const COLUNAS_RELATORIO = [
  { header: 'Data', key: 'data', width: 20 },
  { header: 'Pedido', key: 'pedido', width: 16 },
  { header: 'Loja', key: 'loja', width: 18 },
  { header: 'Produto', key: 'produto', width: 38 },
  { header: 'SKU', key: 'sku', width: 22 },
  { header: 'Quantidade', key: 'quantidade', width: 12, tipo: 'int' },
  { header: 'Valor da venda', key: 'valorVenda', width: 16, tipo: 'money' },
  { header: 'Descontos', key: 'descontos', width: 14, tipo: 'money' },
  { header: 'Taxas/comissões ML', key: 'taxas', width: 18, tipo: 'money' },
  { header: 'Frete comprador', key: 'freteComprador', width: 16, tipo: 'money' },
  { header: 'Frete vendedor', key: 'freteVendedor', width: 16, tipo: 'money' },
  { header: 'Imposto', key: 'imposto', width: 14, tipo: 'money' },
  { header: 'Custo do produto', key: 'custoProduto', width: 16, tipo: 'money' },
  { header: 'Margem de contribuição (R$)', key: 'margemRs', width: 22, tipo: 'money' },
  { header: 'Margem de contribuição (%)', key: 'margemPct', width: 20, tipo: 'percent' },
  { header: 'Logística', key: 'logistica', width: 16 },
  { header: 'Status', key: 'status', width: 20 },
];

function linhaDoPedido(p) {
  return {
    data: fmtDataBR(p.dataCriacao),
    pedido: p.mlOrderId,
    loja: p.loja || '',
    produto: p.produtoResumo || '',
    sku: p.skuResumo || '',
    quantidade: p.qtdUnidades,
    valorVenda: p.valorTotal,
    descontos: p.desconto,
    taxas: p.tarifasMl,
    freteComprador: p.freteComprador,
    freteVendedor: p.freteVendedor,
    imposto: p.imposto,
    custoProduto: p.custoProduto,
    margemRs: p.margemContribuicao,
    margemPct: p.margemPercentual,
    logistica: p.envioLogisticType || '',
    status: p.cancelado ? `${p.status} (cancelado)` : (p.status || ''),
  };
}

// Linhas do resumo (mesmos campos pedidos pelo usuário) — a partir do
// `resumo` já calculado por resumirPeriodo, sem recalcular nada. Pedidos
// cancelados nunca entram nesses totais (mesma regra de Visão
// Geral/Financeiro) — só na lista de linhas, cada um com seu próprio status.
//
// "Pendente" só quando falta um dado real (ex: custo do produto não
// cadastrado). Quando o motivo de um total vir `null` de resumirPeriodo é
// simplesmente não haver nenhum pedido nesse grupo (0 pedidos não
// cancelados, ou 0 pedidos cancelados — ex: filtro de Status = "cancelled"
// não tem pedido não-cancelado nenhum pra somar), o total mostrado é R$
// 0,00 de verdade — soma de zero pedidos é zero, não é dado faltando.
function linhasResumo(resumo, totalUnidades) {
  const semPedidos = resumo.qtdPedidos === 0;
  const semCancelados = resumo.cancelados.quantidade === 0;
  const money = (v, zeroSeVazio) => (zeroSeVazio ? 0 : v);
  return [
    ['Total faturado', money(resumo.faturamento.valor, semPedidos), 'money'],
    ['Total de pedidos', resumo.qtdPedidos, 'int'],
    ['Total de unidades', totalUnidades, 'int'],
    ['Total de taxas/comissões', money(resumo.tarifas.valor, semPedidos), 'money'],
    ['Total de frete do vendedor', money(resumo.freteVendedor.valor, semPedidos), 'money'],
    ['Total de imposto', money(resumo.imposto.valor, semPedidos), 'money'],
    ['Total de custo dos produtos', money(resumo.custoProduto.valor, semPedidos), 'money'],
    ['Margem de contribuição total (R$)', money(resumo.margemContribuicao.valor, semPedidos), 'money'],
    ['Margem de contribuição (%)', semPedidos ? 0 : resumo.margemPercentual, 'percent'],
    ['Pedidos cancelados (fora dos totais acima)', resumo.cancelados.quantidade, 'int'],
    ['Valor dos pedidos cancelados', money(resumo.cancelados.valor, semCancelados), 'money'],
  ];
}

function textoFiltros({ empresaNome, periodoCalc, lojaNome, status, busca }) {
  const partes = [
    `Empresa: ${empresaNome || '—'}`,
    `Período: ${periodoCalc.label} (${diaBRT(periodoCalc.desde)} a ${diaBRT(new Date(periodoCalc.ate.getTime() - 1))})`,
  ];
  partes.push(`Loja: ${lojaNome || 'todas'}`);
  partes.push(`Status: ${status || 'todos'}`);
  partes.push(`Produto/SKU: ${busca ? busca : 'sem filtro'}`);
  return partes.join(' · ');
}

async function gerarXlsx({ linhas, resumo, totalUnidades, vazio, filtrosTexto }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cerne ERP';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Pedidos');
  sheet.columns = COLUNAS_RELATORIO.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, name: 'Arial' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  linhas.forEach((linhaObj) => {
    const row = sheet.addRow(linhaObj);
    COLUNAS_RELATORIO.forEach((c, idx) => {
      const cell = row.getCell(idx + 1);
      cell.font = { name: 'Arial' };
      if (c.tipo === 'money') {
        if (cell.value === null || cell.value === undefined) cell.value = 'pendente';
        else cell.numFmt = 'R$ #,##0.00';
      } else if (c.tipo === 'percent') {
        if (cell.value === null || cell.value === undefined) cell.value = 'pendente';
        else { cell.value = Number(cell.value) / 100; cell.numFmt = '0.0%'; }
      }
    });
  });

  const resumoSheet = workbook.addWorksheet('Resumo');
  resumoSheet.getColumn(1).width = 42;
  resumoSheet.getColumn(2).width = 22;
  resumoSheet.addRow(['Filtros aplicados', '']).font = { italic: true, name: 'Arial' };
  resumoSheet.addRow([filtrosTexto, '']);
  resumoSheet.addRow([]);
  linhasResumo(resumo, totalUnidades).forEach(([label, valor, tipo]) => {
    const row = resumoSheet.addRow([label, valor]);
    row.getCell(1).font = { bold: true, name: 'Arial' };
    const cell = row.getCell(2);
    cell.font = { name: 'Arial' };
    if (tipo === 'money') {
      if (cell.value === null || cell.value === undefined) cell.value = 'pendente';
      else cell.numFmt = 'R$ #,##0.00';
    } else if (tipo === 'percent') {
      if (cell.value === null || cell.value === undefined) cell.value = 'pendente';
      else { cell.value = Number(cell.value) / 100; cell.numFmt = '0.0%'; }
    }
  });
  if (vazio) {
    resumoSheet.addRow([]);
    resumoSheet.addRow(['Nenhum pedido encontrado para os filtros selecionados.']).font = { italic: true, name: 'Arial' };
  }

  return workbook;
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[;"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function fmtMoneyCsv(v) {
  return v === null || v === undefined ? 'pendente' : Number(v).toFixed(2).replace('.', ',');
}
function fmtPctCsv(v) {
  return v === null || v === undefined ? 'pendente' : Number(v).toFixed(1).replace('.', ',') + '%';
}
function fmtIntCsv(v) {
  return v === null || v === undefined ? 'pendente' : String(v);
}

function gerarCsv({ linhas, resumo, totalUnidades, vazio, filtrosTexto }) {
  const out = [];
  out.push(COLUNAS_RELATORIO.map((c) => csvEscape(c.header)).join(';'));
  linhas.forEach((linhaObj) => {
    const valores = COLUNAS_RELATORIO.map((c) => {
      const v = linhaObj[c.key];
      if (c.tipo === 'money') return fmtMoneyCsv(v);
      if (c.tipo === 'percent') return fmtPctCsv(v);
      if (c.tipo === 'int') return fmtIntCsv(v);
      return v;
    });
    out.push(valores.map(csvEscape).join(';'));
  });

  out.push('');
  out.push(csvEscape('Filtros aplicados: ' + filtrosTexto));
  out.push('');
  out.push(csvEscape('RESUMO'));
  linhasResumo(resumo, totalUnidades).forEach(([label, valor, tipo]) => {
    const valorFmt = tipo === 'money' ? fmtMoneyCsv(valor) : tipo === 'percent' ? fmtPctCsv(valor) : fmtIntCsv(valor);
    out.push([csvEscape(label), csvEscape(valorFmt)].join(';'));
  });
  if (vazio) out.push(csvEscape('Nenhum pedido encontrado para os filtros selecionados.'));

  return out.join('\r\n');
}

// GET /api/pedidos/relatorio?empresaId=&periodo=&contaId=&status=&busca=&formato=xlsx|csv
// Respeita exatamente os mesmos filtros da listagem (empresa, período, loja,
// status, produto/SKU) — nunca busca com o LIMIT de 500 da tela: o
// relatório sempre inclui TODOS os pedidos que batem o filtro.
router.get('/relatorio', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, status, busca } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const formato = ['xlsx', 'csv'].includes(String(req.query.formato)) ? req.query.formato : 'xlsx';

    const periodoCalc = calcularPeriodo(periodo);
    const { pedidos: todos } = await buscarPedidosDoPeriodo({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
    });
    const filtrados = filtrarPedidos(todos, { contaId, status, busca });

    const descontos = await buscarDescontosPorPedido(filtrados.map((p) => p.id));
    filtrados.forEach((p) => { p.desconto = descontos[p.id] !== undefined ? descontos[p.id] : null; });

    const resumo = resumirPeriodo(filtrados);
    const totalUnidades = filtrados.filter((p) => !p.cancelado).reduce((s, p) => s + (p.qtdUnidades || 0), 0);
    const vazio = filtrados.length === 0;

    let empresaNome = null;
    let lojaNome = null;
    try {
      const { rows: empresaRows } = await pool.query('SELECT nome_fantasia, razao_social FROM empresas WHERE id = $1', [empresaId]);
      if (empresaRows.length) empresaNome = empresaRows[0].nome_fantasia || empresaRows[0].razao_social;
      if (contaId) {
        const { rows: contaRows } = await pool.query('SELECT nickname FROM ml_contas WHERE id = $1', [contaId]);
        if (contaRows.length) lojaNome = contaRows[0].nickname;
      }
    } catch (e) { /* nome da empresa/loja é só informativo no cabeçalho do relatório — nunca bloqueia a exportação */ }

    const filtrosTexto = textoFiltros({ empresaNome, periodoCalc, lojaNome, status, busca });
    const linhas = filtrados.map(linhaDoPedido);
    const nomeArquivo = formatarNomeArquivo(periodoCalc, formato);

    if (formato === 'csv') {
      const csv = gerarCsv({ linhas, resumo, totalUnidades, vazio, filtrosTexto });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      res.send('﻿' + csv); // BOM UTF-8 — Excel só reconhece acentuação certo no CSV com isso.
    } else {
      const workbook = await gerarXlsx({ linhas, resumo, totalUnidades, vazio, filtrosTexto });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      await workbook.xlsx.write(res);
      res.end();
    }
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
