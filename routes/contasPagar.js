// Contas a Pagar — ativado em 24/08/2026 (ver docs/04-alteracoes.md).
// Router fino: toda a regra de negócio mora em lib/contasPagar.js
// (mesmo padrão de lib/relatorioVendas.js/lib/resultadoVenda.js), pra ficar
// testável sem precisar do Express.
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const contasPagar = require('../lib/contasPagar');
const importacao = require('../lib/contasPagarImportacao');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/contas-pagar?empresaId=ID&periodo=30d&status=pendente|pago|vencido|cancelado&search=texto
// A LISTA só filtra por período as contas já PAGAS (pela data de
// pagamento) — pendentes/vencidas/canceladas aparecem sempre, o período
// do header não as esconde. O RESUMO (topo da tela) segue a mesma lógica
// pros KPIs de saldo — ver comentário em lib/contasPagar.js/
// listarContasPagar e resumoContasPagar.
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde, ate } = periodoParaDatasBRT(periodoCalc);

    const [contas, resumo] = await Promise.all([
      contasPagar.listarContasPagar({ empresaId, desde, ate, status, search }),
      contasPagar.resumoContasPagar({ empresaId, desde, ate }),
    ]);

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde, ate },
      contas,
      resumo,
    });
  } catch (err) { next(err); }
});

router.get('/categorias-sugeridas', (req, res) => {
  res.json({ categorias: contasPagar.CATEGORIAS_SUGERIDAS });
});


// POST /api/contas-pagar/importar/ler — recebe os bytes crus do CSV/XLSX,
// lê apenas a primeira aba (XLSX) e devolve colunas + linhas para o wizard de
// mapeamento. O arquivo não é persistido no servidor.
router.post('/importar/ler', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res, next) => {
  try {
    const nomeArquivo = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    if (!nomeArquivo) return res.status(400).json({ error: 'Informe o nome do arquivo.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Arquivo vazio.' });
    const lido = await importacao.lerArquivo(req.body, nomeArquivo);
    if (!lido.colunas.length) return res.status(400).json({ error: 'Não encontrei cabeçalho na planilha.' });
    if (!lido.linhas.length) return res.status(400).json({ error: 'A planilha não possui linhas de dados.' });
    res.json({
      nomeArquivo,
      nomeAba: lido.nomeAba || null,
      colunas: lido.colunas,
      linhas: lido.linhas,
      mapeamentoSugerido: importacao.sugerirMapeamento(lido.colunas),
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

router.post('/importar/preview', async (req, res, next) => {
  try {
    const result = await importacao.previsualizarImportacao(req.body);
    res.json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

router.post('/importar/confirmar', async (req, res, next) => {
  try {
    const result = await importacao.confirmarImportacao(req.body);
    res.status(201).json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

router.get('/importar/historico', async (req, res, next) => {
  try {
    const empresaId = Number(req.query.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query(
      `SELECT id, nome_arquivo, total_linhas, total_importadas, total_ignoradas, total_erros, created_at
       FROM contas_pagar_importacoes WHERE empresa_id = $1 ORDER BY id DESC LIMIT 30`,
      [empresaId]
    );
    res.json({ importacoes: rows.map(r => ({
      id: r.id, nomeArquivo: r.nome_arquivo, totalLinhas: r.total_linhas,
      totalImportadas: r.total_importadas, totalIgnoradas: r.total_ignoradas,
      totalErros: r.total_erros, criadoEm: r.created_at,
    })) });
  } catch (err) { next(err); }
});

router.get('/importar/modelo', async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contas a Pagar');
    const headers = ['Fornecedor','Descrição','Categoria','Documento','Parcela','Data Emissão','Vencimento','Valor','Forma Pagamento','Banco/Conta','Status','Data Pagamento','Valor Pago','Observação'];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns = headers.map((h, i) => ({ key: 'c'+i, width: Math.max(14, Math.min(28, h.length + 4)) }));
    const instrucoes = wb.addWorksheet('Instruções');
    instrucoes.addRows([
      ['Como usar'],
      ['1. Preencha uma linha por conta/parcela.'],
      ['2. Descrição, Vencimento e Valor são obrigatórios.'],
      ['3. Status vazio = Pendente. "Vencido" também é tratado como Pendente e o ERP calcula o vencimento pela data.'],
      ['4. Se usar status Pago, informe Data Pagamento. Pagamento parcial ainda não é suportado.'],
      ['5. Fornecedor não cadastrado será preservado pelo nome, sem criar CNPJ/CPF fictício.'],
    ]);
    instrucoes.getRow(1).font = { bold: true };
    instrucoes.getColumn(1).width = 110;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="modelo-contas-a-pagar.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const result = await contasPagar.criarContaPagar(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const result = await contasPagar.atualizarContaPagar(req.params.id, req.body);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/pagar', async (req, res, next) => {
  try {
    const result = await contasPagar.marcarComoPago(req.params.id, req.body.dataPagamento);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/cancelar', async (req, res, next) => {
  try {
    const result = await contasPagar.cancelarContaPagar(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await contasPagar.excluirContaPagar(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
