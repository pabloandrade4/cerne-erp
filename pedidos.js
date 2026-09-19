// Pedidos importados do Mercado Livre e da Shopee: listagem, detalhe e
// relatório exportável (com o cálculo financeiro preparado no Passo 3 —
// comissão real da API, frete do vendedor real da API, imposto configurado
// pelo ERP e custo do produto cadastrado).
//
// A listagem e o relatório usam lib/relatorioVendas.js — a MESMA função
// usada por Visão Geral e Financeiro (routes/relatorios.js) — pra nunca
// mostrar (ou exportar) um número diferente do que essas telas mostram pro
// mesmo período. Os filtros de loja/status/produto-SKU e a exportação são
// só desta rota — relatorioVendas.js e resultadoVenda.js não foram
// alterados, nem duplicados: o relatório reaproveita exatamente as mesmas
// funções (`buscarPedidosDoPeriodo`, `resumirPeriodo`), só filtrando o
// array de pedidos já calculado antes de somar os totais.
//
// Shopee (14/09/2026, pedido explícito do usuário: "tudo que foi aplicado
// no mercado livre pode e deve ser aplicado na shopee") — como
// buscarPedidosDoPeriodo já une as duas lojas (ver relatorioVendas.js), a
// listagem/exportação abaixo já incluem Shopee automaticamente. O que
// precisou mudar aqui foi só o que é ESPECÍFICO desta rota: as opções de
// filtro "Loja"/"Status" (buscarLojasDaEmpresa/buscarStatusDoPeriodo, que
// antes consultavam só ml_contas/ml_pedidos) e o filtro por loja
// (filtrarPedidos), que agora usa `contaKey` (formato
// "mercado_livre:<id>"/"shopee:<id>" — ver comentário em
// relatorioVendas.js#serializarPedido) em vez de `contaMlId` sozinho, pra
// nunca arriscar confundir a loja #3 do Mercado Livre com a loja #3 da
// Shopee. GET /:id (detalhe) também passou a aceitar esse mesmo formato de
// chave composta, roteando pra ml_pedidos ou shopee_pedidos conforme o
// prefixo.
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { calcularResultadoVenda, round2 } = require('../lib/resultadoVenda');
const { calcularPeriodo, diaBRT } = require('../lib/periodo');
const {
  buscarPedidosDoPeriodo, resumirPeriodo, SQL_DATA_EFETIVA, SQL_DESCONTO_CUPOM,
  filtrarPorContaKey, buscarLojasDaEmpresa, estimarComissaoShopeePedido,
} = require('../lib/relatorioVendas');

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
  // Loja: mesmo filtro por `contaKey` agora compartilhado com
  // /api/relatorios/resumo-vendas (lib/relatorioVendas.js#filtrarPorContaKey)
  // — ver comentário lá sobre por que um id de conta sozinho não é seguro.
  const porLoja = filtrarPorContaKey(pedidos, contaId);
  return porLoja.filter((p) => {
    if (status && p.status !== status) return false;
    if (alvo) {
      const hitProduto = (p.produtoResumo || '').toLowerCase().includes(alvo);
      const hitSku = (p.skuResumo || '').toLowerCase().includes(alvo);
      if (!hitProduto && !hitSku) return false;
    }
    return true;
  });
}

// Opções reais para o filtro de Status — nunca uma lista fixa "chutada":
// vem dos status que realmente aparecem nos pedidos do período, das duas
// origens (não existe lista fechada de status documentada — é o que cada
// API mandou; os vocabulários não se confundem porque o Mercado Livre usa
// minúsculas ("paid", "cancelled"...) e a Shopee usa maiúsculas
// ("READY_TO_SHIP", "CANCELLED"...)). Opções de Loja agora vêm de
// buscarLojasDaEmpresa em lib/relatorioVendas.js (14/09/2026, movida de
// lá pra ser reaproveitada pelo seletor de loja da Visão Geral também).
async function buscarStatusDoPeriodo(empresaId, desde, ate) {
  const [ml, shopee] = await Promise.all([
    pool.query(
      `SELECT DISTINCT p.status FROM ml_pedidos p
       JOIN ml_contas c ON c.id = p.conta_ml_id
       WHERE c.empresa_id = $1 AND ${SQL_DATA_EFETIVA} >= $2 AND ${SQL_DATA_EFETIVA} < $3 AND p.status IS NOT NULL`,
      [empresaId, desde, ate]
    ),
    // Shopee ainda não distingue "criado" de "fechado" nesta etapa (Fase 1
    // — ver lib/shopeeSync.js), então data_efetiva == data_criacao pra ela,
    // exatamente como já é em SQL_UNIAO_PEDIDOS (relatorioVendas.js).
    pool.query(
      `SELECT DISTINCT p.order_status AS status FROM shopee_pedidos p
       JOIN shopee_contas c ON c.id = p.conta_shopee_id
       WHERE c.empresa_id = $1 AND p.data_criacao >= $2 AND p.data_criacao < $3 AND p.order_status IS NOT NULL`,
      [empresaId, desde, ate]
    ),
  ]);
  const status = new Set([...ml.rows.map((r) => r.status), ...shopee.rows.map((r) => r.status)]);
  return [...status].sort();
}

// Nome da loja a partir da `contaKey` composta ("mercado_livre:12" /
// "shopee:3") — usado só pro texto informativo do cabeçalho do relatório
// exportado (nunca bloqueia a exportação se falhar).
async function buscarNomeLoja(contaKey) {
  if (!contaKey) return null;
  const [marketplace, idStr] = String(contaKey).split(':');
  const id = Number(idStr);
  if (!id) return null;
  try {
    if (marketplace === 'shopee') {
      const { rows } = await pool.query('SELECT shop_name FROM shopee_contas WHERE id = $1', [id]);
      return rows.length ? rows[0].shop_name : null;
    }
    const { rows } = await pool.query('SELECT nickname FROM ml_contas WHERE id = $1', [id]);
    return rows.length ? rows[0].nickname : null;
  } catch (e) {
    return null;
  }
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
    const { empresaId, periodo, contaId, status, busca, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
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

// Descontos por pedido: até 24/08/2026 este relatório calculava aqui,
// sozinho, a partir de full_unit_price (preço "de") vs unit_price (preço
// pago) — mas esse campo vem NULL da API na prática (nunca visto preenchido
// nos pedidos reais conferidos na reconciliação PF ERP x Mercado Turbo), e
// o desconto que realmente bateu com a diferença de margem observada era
// outro: o cupom do pagamento (payments[].coupon_amount — Bug 3, ver
// lib/resultadoVenda.js e docs/04-alteracoes.md). Pra "Descontos" nesta
// planilha bater exatamente com o que é subtraído no cálculo de margem
// (Valor da venda − Descontos − Taxas − Frete − Imposto − Custo = Margem),
// o campo `desconto` de cada pedido já vem pronto de
// buscarPedidosDoPeriodo/resumirPeriodo (fonte única, mesma usada em Visão
// Geral/Pedidos/Financeiro) — não é mais calculado à parte aqui.

// Uma linha por pedido (não por item) — mesma granularidade já mostrada na
// tela Pedidos (produto/SKU resumidos quando o pedido tem mais de um item).
const COLUNAS_RELATORIO = [
  { header: 'Data', key: 'data', width: 20 },
  { header: 'Marketplace', key: 'marketplace', width: 14 },
  { header: 'Pedido', key: 'pedido', width: 16 },
  { header: 'Loja', key: 'loja', width: 18 },
  { header: 'Produto', key: 'produto', width: 38 },
  { header: 'SKU', key: 'sku', width: 22 },
  { header: 'Quantidade', key: 'quantidade', width: 12, tipo: 'int' },
  { header: 'Valor da venda', key: 'valorVenda', width: 16, tipo: 'money' },
  { header: 'Descontos', key: 'descontos', width: 14, tipo: 'money' },
  { header: 'Taxas/comissões', key: 'taxas', width: 18, tipo: 'money' },
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
    marketplace: p.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre',
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
    ['Total de descontos (cupom)', money(resumo.desconto.valor, semPedidos), 'money'],
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
    const { empresaId, periodo, contaId, status, busca, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const formato = ['xlsx', 'csv'].includes(String(req.query.formato)) ? req.query.formato : 'xlsx';

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
    const { pedidos: todos } = await buscarPedidosDoPeriodo({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
    });
    const filtrados = filtrarPedidos(todos, { contaId, status, busca });

    const resumo = resumirPeriodo(filtrados);
    const totalUnidades = filtrados.filter((p) => !p.cancelado).reduce((s, p) => s + (p.qtdUnidades || 0), 0);
    const vazio = filtrados.length === 0;

    let empresaNome = null;
    let lojaNome = null;
    try {
      const { rows: empresaRows } = await pool.query('SELECT nome_fantasia, razao_social FROM empresas WHERE id = $1', [empresaId]);
      if (empresaRows.length) empresaNome = empresaRows[0].nome_fantasia || empresaRows[0].razao_social;
      if (contaId) lojaNome = await buscarNomeLoja(contaId);
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

// Custo por SKU vem de `produtos` (tela Produtos, desde 24/08/2026 — ver
// db/schema.sql e docs/02-decisoes.md) — mesma fonte usada em
// lib/relatorioVendas.js, pra nunca divergir entre a lista de Pedidos e o
// detalhe do pedido, seja Mercado Livre ou Shopee. Não filtra por
// produtos.ativo (ver comentário em relatorioVendas.js sobre o mesmo ponto).
async function buscarCustosPorSku(empresaId, skus) {
  if (!skus.length) return {};
  const { rows } = await pool.query(
    'SELECT sku, custo FROM produtos WHERE empresa_id = $1 AND sku = ANY($2::text[])',
    [empresaId, skus]
  );
  return Object.fromEntries(rows.map((c) => [c.sku, Number(c.custo)]));
}

// GET /api/pedidos/mercado_livre:ID — detalhe completo + resultado
// financeiro do Mercado Livre (Passo 3). Sem mudança de comportamento desde
// sempre — só passou a ser chamado a partir da `detailKey` composta (ver
// dispatcher no fim do arquivo) em vez de um id numérico solto.
async function detalharPedidoMercadoLivre(id, res) {
  const { rows } = await pool.query(
    `SELECT p.*, e.id AS empresa_id_real, c.nickname AS conta_nickname,
            ${SQL_DESCONTO_CUPOM} AS desconto_cupom
     FROM ml_pedidos p
     JOIN ml_contas c ON c.id = p.conta_ml_id
     JOIN empresas e ON e.id = c.empresa_id
     WHERE p.id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const pedido = rows[0];
  const empresaId = pedido.empresa_id_real;

  const { rows: itens } = await pool.query(
    'SELECT * FROM ml_pedido_itens WHERE pedido_id = $1 ORDER BY id',
    [pedido.id]
  );

  const skus = [...new Set(itens.map((i) => i.sku).filter(Boolean))];
  const custosPorSku = await buscarCustosPorSku(empresaId, skus);

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
  const desconto = toNum(pedido.desconto_cupom) || 0;

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
    desconto,
  });
  const margemPercentual = resultado !== null && valorVenda ? round2((resultado / valorVenda) * 100) : null;

  res.json({
    pedido: {
      id: pedido.id,
      marketplace: 'mercado_livre',
      detailKey: `mercado_livre:${pedido.id}`,
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
      desconto,
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
}

// GET /api/pedidos/shopee:ID — detalhe completo do pedido da Shopee
// (14/09/2026, mesmo espírito do detalhe do Mercado Livre acima — "tudo que
// foi aplicado no mercado livre pode e deve ser aplicado na shopee"). A
// diferença real (nunca escondida, sempre como pendência explícita): a
// Shopee só devolve comissão/tarifas de venda numa chamada SEPARADA de
// repasse/escrow (Fase 2b — payment/get_escrow_detail_batch, ver
// lib/shopeeSync.js), depois que o repasse do pedido é processado/liberado —
// nunca junto do pedido em si (get_order_detail, Fase 1). Enquanto esse
// repasse não chega, taxaVenda/pagamentoTaxas/pagamentoTaxaMarketplace ficam
// null aqui, o que automaticamente deixa a margem "pendente" (mesmo
// mecanismo de custo de SKU não cadastrado — nunca um valor inventado).
async function detalharPedidoShopee(id, res) {
  const { rows } = await pool.query(
    `SELECT p.*, e.id AS empresa_id_real, c.shop_name AS conta_nickname
     FROM shopee_pedidos p
     JOIN shopee_contas c ON c.id = p.conta_shopee_id
     JOIN empresas e ON e.id = c.empresa_id
     WHERE p.id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const pedido = rows[0];
  const empresaId = pedido.empresa_id_real;

  const { rows: itens } = await pool.query(
    'SELECT * FROM shopee_pedido_itens WHERE pedido_id = $1 ORDER BY id',
    [pedido.id]
  );

  const skus = [...new Set(itens.map((i) => i.sku).filter(Boolean))];
  const custosPorSku = await buscarCustosPorSku(empresaId, skus);

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
      pendencias.push(`Item "${it.nome || it.item_id}" não tem SKU informado pela Shopee — custo não pode ser vinculado.`);
    } else if (custosPorSku[it.sku] === undefined) {
      custoCompleto = false;
      pendencias.push(`Custo do SKU "${it.sku}" ainda não foi cadastrado.`);
    } else {
      custoUnitario = custosPorSku[it.sku];
      custoProdutoTotal += custoUnitario * qtd;
    }
    return {
      id: it.id,
      itemId: it.item_id ? String(it.item_id) : null,
      titulo: it.nome,
      sku: it.sku,
      quantidade: qtd,
      precoUnitario: toNum(it.preco_unitario),
      valorTotalItem: toNum(it.valor_total_item),
      custoUnitario,
      custoTotal: custoUnitario != null ? Math.round(custoUnitario * qtd * 100) / 100 : null,
    };
  });

  const valorVenda = toNum(pedido.valor_total);
  // Frete do vendedor: CORRIGIDO em 14/09/2026 — antes usava
  // `pedido.frete_real` (actual_shipping_fee) como custo do vendedor, mas o
  // usuário confirmou (comparando com outro sistema) que na Shopee o
  // vendedor NUNCA paga frete, só comissão/taxas. `frete_real` não é um
  // custo do vendedor nesse marketplace — por isso sempre 0 aqui (fato real
  // do modelo da Shopee, nunca "dado faltando"; ver mesmo ajuste em
  // lib/relatorioVendas.js/serializarPedido).
  const freteVendedor = 0;
  // Fase 2b (14/09/2026, pedido explícito do usuário: "quero igual ao
  // mercado livre, mas com as taxas e comissões da shopee") — comissão real
  // vinda de payment/get_escrow_detail_batch (lib/shopeeSync.js), salva em
  // shopee_pedidos.comissao_venda/taxa_transacao_pagamento/taxa_servico.
  // NULL quando a Shopee ainda não processou/liberou o repasse deste
  // pedido.
  let taxaVenda = toNum(pedido.comissao_venda);
  const pagamentoTaxas = toNum(pedido.taxa_transacao_pagamento);
  const pagamentoTaxaMarketplace = toNum(pedido.taxa_servico);
  // Estimativa (14/09/2026, pedido explícito do usuário: "quero que apareça
  // a margem líquida", não "pendente" até o repasse) — só entra quando o
  // repasse real ainda não confirmou nada. Ver TABELA_COMISSAO_SHOPEE_ESTIMADA
  // em lib/relatorioVendas.js (mesma função usada na listagem de Pedidos e
  // em Visão Geral/Relatórios, pra este detalhe nunca divergir do resto).
  let comissaoEstimada = false;
  if (taxaVenda === null) {
    const estimativa = estimarComissaoShopeePedido(itens.map((it) => toNum(it.valor_total_item)));
    if (estimativa !== null) { taxaVenda = estimativa; comissaoEstimada = true; }
  }
  // Cupom da Shopee ainda não é capturado nesta etapa (Fase 1) — 0, mesma
  // regra já documentada em lib/resultadoVenda.js/relatorioVendas.js pra
  // "sem cupom" (fato real conhecido, não dado faltando).
  const desconto = 0;

  if (comissaoEstimada) pendencias.push('A comissão da Shopee deste pedido ainda é uma ESTIMATIVA (tabela oficial de comissão da Shopee) — o repasse real ainda não foi liberado. Quando ele chegar, a margem passa a usar o valor real automaticamente.');
  else if (taxaVenda === null) pendencias.push('A Shopee ainda não processou/liberou o repasse deste pedido, e não foi possível estimar a comissão (nenhum item com valor sincronizado) — a margem fica "pendente" até um dos dois existir.');

  const custoProdutoFinal = itens.length && custoCompleto ? Math.round(custoProdutoTotal * 100) / 100 : null;

  const { tarifasComponentes, tarifasTotal, imposto, resultado, calculoCompleto } = calcularResultadoVenda({
    valorVenda,
    taxaVenda,
    pagamentoTaxas,
    pagamentoTaxaMarketplace,
    freteVendedor,
    custoProduto: custoProdutoFinal,
    aliquotaImposto,
    desconto,
  });
  const margemPercentual = resultado !== null && valorVenda ? round2((resultado / valorVenda) * 100) : null;

  res.json({
    pedido: {
      id: pedido.id,
      marketplace: 'shopee',
      detailKey: `shopee:${pedido.id}`,
      empresaId,
      loja: pedido.conta_nickname,
      mlOrderId: pedido.order_sn, // mesmo campo do Mercado Livre por compatibilidade com o frontend — valor já é o identificador da Shopee (order_sn)
      packId: null,
      dataCriacao: pedido.data_criacao,
      dataFechamento: null, // Shopee ainda não distingue "criado" de "fechado" nesta etapa (Fase 1)
      status: pedido.order_status,
      statusDetail: null,
      compradorId: pedido.comprador_user_id ? String(pedido.comprador_user_id) : null,
      compradorNickname: pedido.comprador_username,
      moeda: pedido.moeda,
      metodoPagamento: pedido.metodo_pagamento,
      mlPaymentId: null,
      mlShippingId: null,
      envioStatus: null,
      envioLogisticMode: null,
      envioLogisticType: pedido.transportadora,
    },
    itens: itensDetalhados,
    resultadoFinanceiro: {
      valorVenda,
      desconto,
      tarifasMl: { total: tarifasTotal, componentes: tarifasComponentes },
      freteVendedor,
      freteComprador: null, // a Shopee não separa frete pago pelo comprador nos campos já buscados nesta etapa
      imposto: { aliquota: aliquotaImposto, valor: imposto },
      custoProduto: custoProdutoFinal,
      resultado,
      margemPercentual,
      calculoCompleto,
      // 14/09/2026 — true quando a comissão usada acima (dentro de
      // tarifasMl/resultado) é a estimativa da tabela oficial da Shopee, não
      // o repasse real confirmado. Ver comentário acima de comissaoEstimada.
      comissaoEstimada,
      pendencias,
    },
    auditoria: {
      rawPedidoDisponivel: !!pedido.raw_pedido,
      rawEnvioDisponivel: false,
      rawCustosEnvioDisponivel: false,
    },
  });
}

// GET /api/pedidos/:id — detalhe completo + resultado financeiro. `:id` é a
// `detailKey` composta vinda de buscarPedidosDoPeriodo
// ("mercado_livre:123"/"shopee:57" — ver relatorioVendas.js#serializarPedido
// e o comentário no topo deste arquivo sobre por que um id sozinho não é
// seguro entre as duas lojas). Um valor sem ":" é tratado como Mercado
// Livre puro, pra nunca quebrar um link/favorito salvo antes desta mudança
// (14/09/2026), quando `id` sozinho só existia pro Mercado Livre.
router.get('/:id', async (req, res, next) => {
  try {
    const chave = String(req.params.id || '');
    const posDoisPontos = chave.indexOf(':');
    const marketplace = posDoisPontos === -1 ? 'mercado_livre' : chave.slice(0, posDoisPontos);
    const idBruto = posDoisPontos === -1 ? chave : chave.slice(posDoisPontos + 1);
    if (marketplace === 'shopee') {
      await detalharPedidoShopee(idBruto, res);
    } else {
      await detalharPedidoMercadoLivre(idBruto, res);
    }
  } catch (err) { next(err); }
});

module.exports = router;
