// Números agregados usados por Visão Geral e Financeiro — reaproveita
// lib/relatorioVendas.js (a mesma função que a listagem de Pedidos usa em
// routes/pedidos.js), pra Visão Geral, Pedidos e Financeiro nunca mostrarem
// um valor diferente pro mesmo período.
//
// Ativado em 25/08/2026: as rotas da tela Relatórios (categorias Vendas e
// Margem / Produtos / Marketplaces-Lojas + exportação XLSX/CSV) foram
// ACRESCENTADAS abaixo, sem alterar a rota /resumo-vendas já existente. Elas
// só chamam lib/relatoriosAgregados.js, que por sua vez só reaproveita
// lib/relatorioVendas.js e lib/ads.js (regra do usuário: "os números dos
// Relatórios devem usar as MESMAS regras já utilizadas em Visão Geral,
// Pedidos e Financeiro — não crie cálculos separados").
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { calcularPeriodo, periodoParaDatasBRT, diaBRT } = require('../lib/periodo');
const { buscarPedidosDoPeriodo, resumirPeriodo, serieDiaria } = require('../lib/relatorioVendas');
const { relatorioVendasMargem, relatorioProdutos, relatorioMarketplaces } = require('../lib/relatoriosAgregados');

const router = express.Router();

// GET /api/relatorios/resumo-vendas?empresaId=ID&periodo=30d
// periodo: hoje | ontem | 7d | 30d (padrão) | mes
router.get('/resumo-vendas', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      totalNoPeriodo,
      resumo: resumirPeriodo(pedidos),
      serieDiaria: serieDiaria(pedidos),
    });
  } catch (err) { next(err); }
});

// ============ Relatórios por categoria (Vendas e Margem / Produtos / Marketplaces) ============

function periodoInfo(periodoCalc) {
  return { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate };
}

// GET /api/relatorios/vendas-margem?empresaId=&periodo=&contaId=
router.get('/vendas-margem', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const periodoCalc = calcularPeriodo(periodo);
    const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);
    const resultado = await relatorioVendasMargem({
      empresaId, contaId: contaId || null, desde: periodoCalc.desde, ate: periodoCalc.ate, desdeStr, ateStr,
    });
    res.json({ periodo: periodoInfo(periodoCalc), ...resultado });
  } catch (err) { next(err); }
});

// GET /api/relatorios/produtos?empresaId=&periodo=&contaId=&sku=
router.get('/produtos', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, sku } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const periodoCalc = calcularPeriodo(periodo);
    const resultado = await relatorioProdutos({
      empresaId, contaId: contaId || null, desde: periodoCalc.desde, ate: periodoCalc.ate, sku: sku || null,
    });
    res.json({ periodo: periodoInfo(periodoCalc), ...resultado });
  } catch (err) { next(err); }
});

// GET /api/relatorios/marketplaces?empresaId=&periodo=
router.get('/marketplaces', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const periodoCalc = calcularPeriodo(periodo);
    const resultado = await relatorioMarketplaces({ empresaId, desde: periodoCalc.desde, ate: periodoCalc.ate });
    res.json({ periodo: periodoInfo(periodoCalc), ...resultado });
  } catch (err) { next(err); }
});

// ============ Exportação (XLSX/CSV) ============
// Mesma filosofia de routes/pedidos.js (Relatório de Pedidos): reaproveita os
// dados já calculados pelas funções acima — nunca soma/calcula de novo só
// pra exportar — e sempre respeita os filtros selecionados (empresa, loja,
// período, SKU). Nunca exporta dado de outra empresa/período: os filtros vêm
// só da query string, nunca de um valor "lembrado" de outra requisição.

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

function aplicarCelula(cell, tipo) {
  if (cell.value === null || cell.value === undefined) { cell.value = 'pendente'; return; }
  if (tipo === 'money') cell.numFmt = 'R$ #,##0.00';
  else if (tipo === 'percent') { cell.value = Number(cell.value) / 100; cell.numFmt = '0.0%'; }
}

async function gerarXlsxGenerico({ nomeAba, colunas, linhas, filtrosTexto, vazio }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cerne ERP';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(nomeAba);
  sheet.columns = colunas.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true, name: 'Arial' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  linhas.forEach((linhaObj) => {
    const row = sheet.addRow(linhaObj);
    colunas.forEach((c, idx) => {
      const cell = row.getCell(idx + 1);
      cell.font = { name: 'Arial' };
      if (c.tipo === 'money' || c.tipo === 'percent') aplicarCelula(cell, c.tipo);
    });
  });

  const rodape = workbook.addWorksheet('Filtros');
  rodape.getColumn(1).width = 90;
  rodape.addRow([filtrosTexto]).font = { italic: true, name: 'Arial' };
  if (vazio) rodape.addRow(['Nenhum dado encontrado para os filtros selecionados.']).font = { italic: true, name: 'Arial' };

  return workbook;
}

function gerarCsvGenerico({ colunas, linhas, filtrosTexto, vazio }) {
  const out = [];
  out.push(colunas.map((c) => csvEscape(c.header)).join(';'));
  linhas.forEach((linhaObj) => {
    const valores = colunas.map((c) => {
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
  if (vazio) out.push(csvEscape('Nenhum dado encontrado para os filtros selecionados.'));
  return out.join('\r\n');
}

function formatarNomeArquivoRelatorio(categoria, periodoCalc, extensao) {
  const diaInicio = diaBRT(periodoCalc.desde);
  const diaFim = diaBRT(new Date(periodoCalc.ate.getTime() - 1));
  const base = diaInicio === diaFim ? `relatorio-${categoria}-${diaInicio}` : `relatorio-${categoria}-${diaInicio}-a-${diaFim}`;
  return `${base}.${extensao}`;
}

async function nomesParaFiltro(empresaId, contaId) {
  let empresaNome = null;
  let lojaNome = null;
  try {
    const { rows: empresaRows } = await pool.query('SELECT nome_fantasia, razao_social FROM empresas WHERE id = $1', [empresaId]);
    if (empresaRows.length) empresaNome = empresaRows[0].nome_fantasia || empresaRows[0].razao_social;
    if (contaId) {
      const { rows: contaRows } = await pool.query('SELECT nickname FROM ml_contas WHERE id = $1', [contaId]);
      if (contaRows.length) lojaNome = contaRows[0].nickname;
    }
  } catch (e) { /* nome é só informativo no rodapé do relatório — nunca bloqueia a exportação */ }
  return { empresaNome, lojaNome };
}

const COLUNAS_PRODUTOS = [
  { header: 'SKU', key: 'sku', width: 24 },
  { header: 'Quantidade vendida', key: 'quantidade', width: 18, tipo: 'int' },
  { header: 'Faturamento', key: 'faturamento', width: 16, tipo: 'money' },
  { header: 'Custo', key: 'custo', width: 16, tipo: 'money' },
  { header: 'Imposto', key: 'imposto', width: 16, tipo: 'money' },
  { header: 'Margem gerada pelas vendas', key: 'margemContribuicao', width: 24, tipo: 'money' },
];

const COLUNAS_MARKETPLACES = [
  { header: 'Loja', key: 'loja', width: 22 },
  { header: 'Faturamento', key: 'faturamento', width: 16, tipo: 'money' },
  { header: 'Pedidos', key: 'pedidos', width: 12, tipo: 'int' },
  { header: 'Taxas/comissões', key: 'taxas', width: 16, tipo: 'money' },
  { header: 'Frete vendedor', key: 'frete', width: 16, tipo: 'money' },
  { header: 'Custo dos produtos', key: 'custo', width: 18, tipo: 'money' },
  { header: 'Margem de contribuição (R$)', key: 'margemRs', width: 22, tipo: 'money' },
  { header: 'Margem de contribuição (%)', key: 'margemPct', width: 20, tipo: 'percent' },
];

// A categoria "Vendas e Margem" resume UM período/loja (não é uma lista de
// entidades) — exporta como pares Métrica/Valor, cada linha com seu próprio
// tipo (money/percent/int), igual ao "Resumo" do Relatório de Pedidos.
function linhasVendasMargem(resultado, totalUnidades) {
  const { resumo, ads } = resultado;
  const semPedidos = resumo.qtdPedidos === 0;
  const money = (v) => (semPedidos ? 0 : v);
  const linhasBase = [
    ['Faturamento', money(resumo.faturamento.valor), 'money'],
    ['Pedidos', resumo.qtdPedidos, 'int'],
    ['Unidades vendidas', totalUnidades, 'int'],
    ['Taxas/comissões', money(resumo.tarifas.valor), 'money'],
    ['Frete vendedor', money(resumo.freteVendedor.valor), 'money'],
    ['Imposto', money(resumo.imposto.valor), 'money'],
    ['Custo dos produtos', money(resumo.custoProduto.valor), 'money'],
    ['Ads', ads.disponivel ? ads.valor : null, 'money'],
    ['Margem de contribuição (R$)', money(resumo.margemContribuicao.valor), 'money'],
    ['Margem de contribuição (%)', semPedidos ? 0 : resumo.margemPercentual, 'percent'],
  ];
  return linhasBase.map(([label, valor, tipo]) => ({ label, valor, _tipo: tipo }));
}

// GET /api/relatorios/exportar?categoria=vendas-margem|produtos|marketplaces&empresaId=&periodo=&contaId=&sku=&formato=xlsx|csv
router.get('/exportar', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, sku, categoria } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const categoriasValidas = ['vendas-margem', 'produtos', 'marketplaces'];
    if (!categoriasValidas.includes(categoria)) {
      return res.status(400).json({ error: 'Informe categoria: vendas-margem, produtos ou marketplaces.' });
    }
    const formato = ['xlsx', 'csv'].includes(String(req.query.formato)) ? req.query.formato : 'xlsx';
    const periodoCalc = calcularPeriodo(periodo);
    const { empresaNome, lojaNome } = await nomesParaFiltro(empresaId, contaId);

    let colunas;
    let linhas;
    let vazio;
    let nomeAba;

    if (categoria === 'vendas-margem') {
      const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);
      const resultado = await relatorioVendasMargem({
        empresaId, contaId: contaId || null, desde: periodoCalc.desde, ate: periodoCalc.ate, desdeStr, ateStr,
      });
      colunas = [
        { header: 'Métrica', key: 'label', width: 40, tipo: 'texto' },
        { header: 'Valor', key: 'valorFmt', width: 20, tipo: 'texto' },
      ];
      const brutas = linhasVendasMargem(resultado, resultado.totalUnidades);
      linhas = brutas.map((l) => ({
        label: l.label,
        valorFmt: l._tipo === 'money' ? fmtMoneyCsv(l.valor) : l._tipo === 'percent' ? fmtPctCsv(l.valor) : fmtIntCsv(l.valor),
      }));
      vazio = resultado.resumo.qtdPedidos === 0;
      nomeAba = 'Vendas e Margem';
    } else if (categoria === 'produtos') {
      const resultado = await relatorioProdutos({
        empresaId, contaId: contaId || null, desde: periodoCalc.desde, ate: periodoCalc.ate, sku: sku || null,
      });
      colunas = COLUNAS_PRODUTOS;
      linhas = resultado.linhas;
      vazio = linhas.length === 0;
      nomeAba = 'Produtos';
    } else {
      const resultado = await relatorioMarketplaces({ empresaId, desde: periodoCalc.desde, ate: periodoCalc.ate });
      const filtradas = contaId ? resultado.linhas.filter((l) => String(l.contaMlId) === String(contaId)) : resultado.linhas;
      colunas = COLUNAS_MARKETPLACES;
      linhas = filtradas.map((l) => ({
        loja: l.loja || '',
        faturamento: l.resumo.faturamento.valor,
        pedidos: l.resumo.qtdPedidos,
        taxas: l.resumo.tarifas.valor,
        frete: l.resumo.freteVendedor.valor,
        custo: l.resumo.custoProduto.valor,
        margemRs: l.resumo.margemContribuicao.valor,
        margemPct: l.resumo.margemPercentual,
      }));
      vazio = linhas.length === 0;
      nomeAba = 'Marketplaces';
    }

    const filtrosTexto = [
      `Empresa: ${empresaNome || '—'}`,
      `Período: ${periodoCalc.label} (${diaBRT(periodoCalc.desde)} a ${diaBRT(new Date(periodoCalc.ate.getTime() - 1))})`,
      `Loja: ${lojaNome || 'todas'}`,
      sku ? `SKU: ${sku}` : null,
    ].filter(Boolean).join(' · ');

    const nomeArquivo = formatarNomeArquivoRelatorio(categoria, periodoCalc, formato);

    if (formato === 'csv') {
      const csv = gerarCsvGenerico({ colunas, linhas, filtrosTexto, vazio });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      res.send('﻿' + csv);
    } else {
      const workbook = await gerarXlsxGenerico({ nomeAba, colunas, linhas, filtrosTexto, vazio });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      await workbook.xlsx.write(res);
      res.end();
    }
  } catch (err) { next(err); }
});

module.exports = router;
