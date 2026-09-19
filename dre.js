// DRE — ativado em 24/08/2026, ampliado em 31/08/2026 (categorias, bloco
// "Para onde está indo o dinheiro?", detalhamento linha-a-linha e
// exportação). Router fino: toda a lógica mora em lib/dre.js (reaproveitando
// lib/relatorioVendas.js, lib/contasPagar.js e lib/despesasFinanceiras.js,
// nada novo calculado aqui).
const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { periodoParaDatasBRT, diaBRT } = require('../lib/periodo');
const { gerarDRE, calcularPeriodoDre, PERIODOS_DRE_VALIDOS } = require('../lib/dre');
const { listarDespesasDetalhadas, agruparPorCategoria } = require('../lib/despesasFinanceiras');

const router = express.Router();

// Lê os filtros de período/categoria/conta comuns a todas as rotas abaixo —
// mesma leitura em todo lugar, pra /,  /detalhamento e /exportar nunca
// calcularem um período diferente pros mesmos parâmetros de query.
function lerFiltros(query) {
  const { empresaId, periodo, desde, ate, categoriaId, contaBancariaId, search } = query;
  const periodoCalc = calcularPeriodoDre(periodo, { desde, ate });
  const { desde: desdeBRT, ate: ateBRT } = periodoParaDatasBRT(periodoCalc);
  return {
    empresaId,
    periodoCalc,
    desdeBRT,
    ateBRT,
    categoriaId: categoriaId || null,
    contaBancariaId: contaBancariaId || null,
    search: search || null,
  };
}

// GET /api/dre?empresaId=ID&periodo=hoje|7d|15d|30d|mes|mesAnterior|personalizado&desde=&ate=&categoriaId=&contaBancariaId=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const f = lerFiltros(req.query);

    const dre = await gerarDRE({
      empresaId,
      desde: f.periodoCalc.desde,
      ate: f.periodoCalc.ate,
      desdeBRT: f.desdeBRT,
      ateBRT: f.ateBRT,
      categoriaId: f.categoriaId,
      contaBancariaId: f.contaBancariaId,
    });

    res.json({
      periodo: { chave: f.periodoCalc.chave, label: f.periodoCalc.label, desde: f.periodoCalc.desde, ate: f.periodoCalc.ate },
      periodosDisponiveis: PERIODOS_DRE_VALIDOS,
      dre,
    });
  } catch (err) { next(err); }
});

// GET /api/dre/detalhamento?empresaId=ID&periodo=...&categoriaId=&contaBancariaId=&search=texto
// Detalhamento linha-a-linha completo (mesma lista que alimenta o bloco por
// categoria e o gráfico da DRE), com busca por descrição/fornecedor/CR ou
// categoria — usado pela tabela "DETALHAMENTO DAS DESPESAS" da tela.
router.get('/detalhamento', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const f = lerFiltros(req.query);
    const despesas = await listarDespesasDetalhadas({
      empresaId,
      desde: f.desdeBRT,
      ate: f.ateBRT,
      categoriaId: f.categoriaId,
      contaBancariaId: f.contaBancariaId,
      search: f.search,
    });

    res.json({
      periodo: { chave: f.periodoCalc.chave, label: f.periodoCalc.label, desde: f.desdeBRT, ate: f.ateBRT },
      despesas,
    });
  } catch (err) { next(err); }
});

// ============ Exportação (XLSX/CSV) ============
// Mesma filosofia de routes/relatorios.js: reaproveita os dados já
// calculados por lib/dre.js/lib/despesasFinanceiras.js — nunca soma/calcula
// de novo só pra exportar — e sempre respeita os filtros selecionados
// (empresa, período, categoria, conta bancária, busca).

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

function formatarNomeArquivoDre(tipo, periodoCalc, extensao) {
  const diaInicio = diaBRT(periodoCalc.desde);
  const diaFim = diaBRT(new Date(periodoCalc.ate.getTime() - 1));
  const base = diaInicio === diaFim ? `dre-${tipo}-${diaInicio}` : `dre-${tipo}-${diaInicio}-a-${diaFim}`;
  return `${base}.${extensao}`;
}

async function nomesParaFiltro(empresaId, categoriaId, contaBancariaId) {
  let empresaNome = null;
  let categoriaNome = null;
  let contaNome = null;
  try {
    const { rows: empresaRows } = await pool.query('SELECT nome_fantasia, razao_social FROM empresas WHERE id = $1', [empresaId]);
    if (empresaRows.length) empresaNome = empresaRows[0].nome_fantasia || empresaRows[0].razao_social;
    if (categoriaId) {
      const { rows } = await pool.query('SELECT nome FROM categorias_financeiras WHERE id = $1', [categoriaId]);
      if (rows.length) categoriaNome = rows[0].nome;
    }
    if (contaBancariaId) {
      const { rows } = await pool.query('SELECT nome FROM contas_bancarias WHERE id = $1', [contaBancariaId]);
      if (rows.length) contaNome = rows[0].nome;
    }
  } catch (e) { /* nome é só informativo no rodapé do relatório — nunca bloqueia a exportação */ }
  return { empresaNome, categoriaNome, contaNome };
}

// Resumo dos blocos da DRE, na mesma ordem mostrada na tela.
function linhasResumoDre(dre) {
  const l = dre.linhas;
  const linhasBase = [
    ['Receita Bruta', l.receitaBruta.valor, 'money'],
    ['Cancelamentos', l.cancelamentos.valor, 'money'],
    ['Descontos', l.descontos.valor, 'money'],
    ['Receita Líquida', l.receitaLiquida.valor, 'money'],
    ['Custo dos Produtos (CMV)', l.custoProdutos.valor, 'money'],
    ['Taxas/Comissões (Marketplace)', l.taxasComissoes.valor, 'money'],
    ['Frete Vendedor', l.freteVendedor.valor, 'money'],
    ['Impostos', l.impostos.valor, 'money'],
    ['Margem de Contribuição', l.margemContribuicao.valor, 'money'],
    ['Margem de Contribuição (%)', l.margemContribuicao.percentual, 'percent'],
    ['Despesas Operacionais (por categoria)', l.despesasPeriodo.valor, 'money'],
    ['Resultado Final', l.resultadoFinal.valor, 'money'],
  ];
  return linhasBase.map(([label, valor, tipo]) => ({ label, valor, _tipo: tipo }));
}

const COLUNAS_RESUMO = [
  { header: 'Métrica', key: 'label', width: 40, tipo: 'texto' },
  { header: 'Valor', key: 'valorFmt', width: 20, tipo: 'texto' },
];

const COLUNAS_DETALHADA = [
  { header: 'Categoria', key: 'categoria', width: 26 },
  { header: 'Subcategoria', key: 'subcategoria', width: 22 },
  { header: 'Total', key: 'total', width: 16, tipo: 'money' },
  { header: 'Quantidade de lançamentos', key: 'quantidade', width: 24, tipo: 'int' },
];

const COLUNAS_DESPESAS = [
  { header: 'Data', key: 'data', width: 14 },
  { header: 'Descrição', key: 'descricao', width: 34 },
  { header: 'Categoria', key: 'categoria', width: 22 },
  { header: 'Subcategoria', key: 'subcategoria', width: 20 },
  { header: 'Fornecedor', key: 'fornecedor', width: 26 },
  { header: 'CR/Documento', key: 'documento', width: 18 },
  { header: 'Conta bancária', key: 'contaBancaria', width: 20 },
  { header: 'Origem', key: 'origem', width: 18 },
  { header: 'Valor', key: 'valor', width: 16, tipo: 'money' },
  { header: 'Status', key: 'status', width: 12 },
];

// GET /api/dre/exportar?empresaId=ID&periodo=...&categoriaId=&contaBancariaId=&search=&tipo=resumida|detalhada|despesas&formato=xlsx|csv
router.get('/exportar', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const tipo = ['resumida', 'detalhada', 'despesas'].includes(String(req.query.tipo)) ? req.query.tipo : 'resumida';
    const formato = ['xlsx', 'csv'].includes(String(req.query.formato)) ? req.query.formato : 'xlsx';

    const f = lerFiltros(req.query);
    const { empresaNome, categoriaNome, contaNome } = await nomesParaFiltro(empresaId, f.categoriaId, f.contaBancariaId);

    let colunas;
    let linhas;
    let vazio;
    let nomeAba;

    if (tipo === 'resumida') {
      const dre = await gerarDRE({
        empresaId, desde: f.periodoCalc.desde, ate: f.periodoCalc.ate,
        desdeBRT: f.desdeBRT, ateBRT: f.ateBRT, categoriaId: f.categoriaId, contaBancariaId: f.contaBancariaId,
      });
      colunas = COLUNAS_RESUMO;
      const brutas = linhasResumoDre(dre);
      linhas = brutas.map((l) => ({
        label: l.label,
        valorFmt: l._tipo === 'money' ? fmtMoneyCsv(l.valor) : l._tipo === 'percent' ? fmtPctCsv(l.valor) : fmtIntCsv(l.valor),
      }));
      vazio = !dre.hasOrders && dre.despesas.cards.quantidadeDespesas === 0;
      nomeAba = 'Resumo DRE';
    } else if (tipo === 'detalhada') {
      const despesas = await listarDespesasDetalhadas({
        empresaId, desde: f.desdeBRT, ate: f.ateBRT, categoriaId: f.categoriaId, contaBancariaId: f.contaBancariaId, search: f.search,
      });
      const porCategoria = agruparPorCategoria(despesas);
      colunas = COLUNAS_DETALHADA;
      linhas = [];
      porCategoria.forEach((g) => {
        linhas.push({ categoria: g.categoria, subcategoria: '', total: g.total, quantidade: g.quantidade });
        g.subcategorias.forEach((s) => {
          linhas.push({ categoria: g.categoria, subcategoria: s.subcategoria, total: s.total, quantidade: s.quantidade });
        });
      });
      vazio = linhas.length === 0;
      nomeAba = 'Despesas por categoria';
    } else {
      const despesas = await listarDespesasDetalhadas({
        empresaId, desde: f.desdeBRT, ate: f.ateBRT, categoriaId: f.categoriaId, contaBancariaId: f.contaBancariaId, search: f.search,
      });
      colunas = COLUNAS_DESPESAS;
      linhas = despesas.map((d) => ({
        data: d.data,
        descricao: d.descricao || '',
        categoria: d.categoria || '',
        subcategoria: d.subcategoria || '',
        fornecedor: d.fornecedor || '',
        documento: d.documento || '',
        contaBancaria: d.contaBancaria || '',
        origem: d.origem,
        valor: d.valor,
        status: d.status,
      }));
      vazio = linhas.length === 0;
      nomeAba = 'Despesas (linha a linha)';
    }

    const filtrosTexto = [
      `Empresa: ${empresaNome || '—'}`,
      `Período: ${f.periodoCalc.label} (${f.desdeBRT} a ${f.ateBRT})`,
      `Categoria: ${categoriaNome || 'todas'}`,
      `Conta bancária: ${contaNome || 'todas'}`,
      f.search ? `Busca: ${f.search}` : null,
    ].filter(Boolean).join(' · ');

    const nomeArquivo = formatarNomeArquivoDre(tipo, f.periodoCalc, formato);

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
