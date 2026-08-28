const { dataCalendarioISO } = require('./periodo');
function round2(n) { return Math.round(n * 100) / 100; }

function normalizarValor(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? round2(valor) : null;
  let s = String(valor).trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (!s) return null;
  const negativoParenteses = /^\(.*\)$/.test(s);
  if (negativoParenteses) s = s.slice(1, -1);
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');
  if (temVirgula && temPonto) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (temVirgula) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (temPonto && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return round2(negativoParenteses ? -n : n);
}

function dataValidaISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function normalizarData(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const p = n => String(n).padStart(2, '0');
    return valor.getUTCFullYear() + '-' + p(valor.getUTCMonth() + 1) + '-' + p(valor.getUTCDate());
  }
  const s = String(valor).trim();
  let iso = null;
  const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T/.exec(s);
  if (isoTimestamp) iso = isoTimestamp[1] + '-' + isoTimestamp[2] + '-' + isoTimestamp[3];
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) iso = m[1] + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[3])).padStart(2, '0');
  if (!iso) {
    m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s);
    if (m) iso = m[3] + '-' + String(Number(m[2])).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
  }
  return iso && dataValidaISO(iso) ? iso : null;
}

function slugHeader(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

const ALIASES = {
  fornecedor: ['fornecedor', 'fornecedor nome', 'nome fornecedor', 'razao social', 'credor', 'beneficiario'],
  descricao: ['descricao', 'historico', 'conta', 'titulo', 'despesa', 'lancamento'],
  categoria: ['categoria', 'tipo despesa', 'classificacao', 'plano de contas'],
  documento: ['cr', 'codigo cr', 'documento', 'numero documento', 'n documento', 'nf', 'nota fiscal', 'numero nota fiscal', 'boleto'],
  parcela: ['parcela', 'n parcela', 'numero parcela'],
  dataEmissao: ['data emissao', 'dt emissao', 'emissao'],
  vencimento: ['vencimento', 'data vencimento', 'dt venc', 'dt vencimento', 'data de vencimento'],
  valor: ['valor', 'vlr', 'vlr total', 'valor total', 'total', 'valor conta', 'valor da conta'],
  formaPagamento: ['forma pagamento', 'forma de pagamento', 'pagamento', 'meio pagamento'],
  bancoConta: ['banco', 'conta bancaria', 'banco conta', 'conta pagamento'],
  status: ['status', 'situacao'],
  dataPagamento: ['data pagamento', 'dt pagamento', 'pago em', 'data de pagamento'],
  valorPago: ['valor pago', 'vlr pago', 'pago'],
  observacao: ['observacao', 'obs', 'notas', 'comentario'],
};

function sugerirMapeamento(colunas) {
  const normalized = (colunas || []).map(c => ({ original: String(c), slug: slugHeader(c) }));
  const out = {};
  for (const [campo, aliases] of Object.entries(ALIASES)) {
    const aliasSlugs = aliases.map(slugHeader);
    const exato = normalized.find(c => aliasSlugs.includes(c.slug));
    if (exato) out[campo] = exato.original;
  }
  return out;
}


function detectarDelimitador(texto) {
  const primeira = String(texto || '').split(/\r?\n/).find(l => l.trim()) || '';
  const candidatos = [';', ',', '\t'];
  let melhor = ';', max = -1;
  for (const d of candidatos) {
    let count = 0, aspas = false;
    for (let i = 0; i < primeira.length; i++) {
      const c = primeira[i];
      if (c === '"') {
        if (aspas && primeira[i + 1] === '"') i++;
        else aspas = !aspas;
      } else if (!aspas && c === d) count++;
    }
    if (count > max) { max = count; melhor = d; }
  }
  return melhor;
}

function parseCsv(texto, delimitador) {
  const rows = [];
  let row = [], campo = '', aspas = false;
  const s = String(texto || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (aspas) {
      if (c === '"' && s[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === delimitador) { row.push(campo); campo = ''; }
    else if (c === '\n') {
      row.push(campo.replace(/\r$/, '')); campo = '';
      if (row.some(v => String(v).trim() !== '')) rows.push(row);
      row = [];
    } else campo += c;
  }
  if (campo || row.length) {
    row.push(campo.replace(/\r$/, ''));
    if (row.some(v => String(v).trim() !== '')) rows.push(row);
  }
  return rows;
}

function lerCsvBuffer(buffer) {
  const texto = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const delimitador = detectarDelimitador(texto);
  const matriz = parseCsv(texto, delimitador);
  if (!matriz.length) return { colunas: [], linhas: [], delimitador };
  const colunas = matriz[0].map((c, i) => String(c || '').trim() || `Coluna ${i + 1}`);
  const linhas = matriz.slice(1).map(vals => {
    const obj = {};
    colunas.forEach((c, i) => { obj[c] = vals[i] === undefined ? '' : vals[i]; });
    return obj;
  });
  return { colunas, linhas, delimitador };
}

function valorDaLinha(linha, mapeamento, campo) {
  const coluna = mapeamento && mapeamento[campo];
  return coluna ? linha[coluna] : undefined;
}

function textoLimpo(v, max) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function normalizarStatus(valor) {
  const s = slugHeader(valor);
  if (!s || s === 'pendente' || s === 'aberto' || s === 'em aberto' || s === 'vencido' || s === 'vencida') return 'pendente';
  if (s === 'pago' || s === 'paga' || s === 'quitado' || s === 'quitada') return 'pago';
  if (s === 'cancelado' || s === 'cancelada') return 'cancelado';
  return null;
}

function prepararLinha(linha, mapeamento, { fornecedoresPorNome = {} } = {}) {
  const erros = [];
  const descricao = textoLimpo(valorDaLinha(linha, mapeamento, 'descricao'), 200);
  const valorRaw = valorDaLinha(linha, mapeamento, 'valor');
  const vencRaw = valorDaLinha(linha, mapeamento, 'vencimento');
  const valor = normalizarValor(valorRaw);
  const vencimento = normalizarData(vencRaw);
  const statusRaw = valorDaLinha(linha, mapeamento, 'status');
  const status = normalizarStatus(statusRaw);

  if (!descricao) erros.push('Informe a descrição.');
  if (valor === null || valor <= 0) erros.push('Informe um valor maior que zero.');
  if (!vencimento) erros.push('Informe uma data de vencimento válida.');
  if (status === null) erros.push('Status não reconhecido. Use Pendente, Pago, Vencido ou Cancelado.');

  const fornecedorNome = textoLimpo(valorDaLinha(linha, mapeamento, 'fornecedor'), 200);
  let fornecedorId = null, fornecedorNomeImportado = fornecedorNome;
  if (fornecedorNome) {
    const cadastrado = fornecedoresPorNome[slugHeader(fornecedorNome)];
    if (cadastrado) { fornecedorId = Number(cadastrado.id); fornecedorNomeImportado = null; }
  }

  const dataPagamentoRaw = valorDaLinha(linha, mapeamento, 'dataPagamento');
  const dataPagamento = dataPagamentoRaw ? normalizarData(dataPagamentoRaw) : null;
  const valorPagoRaw = valorDaLinha(linha, mapeamento, 'valorPago');
  const valorPago = valorPagoRaw === undefined || valorPagoRaw === null || String(valorPagoRaw).trim() === '' ? null : normalizarValor(valorPagoRaw);
  if (status === 'pago' && !dataPagamento) erros.push('Conta marcada como paga precisa da data de pagamento.');
  if (status === 'pago' && valorPago !== null && (valorPago <= 0 || Math.abs(valorPago - valor) > 0.01)) {
    erros.push('O ERP ainda não suporta pagamento parcial na importação; o valor pago deve ser igual ao valor da conta.');
  }
  if (dataPagamentoRaw && !dataPagamento) erros.push('Data de pagamento inválida.');
  if (valorPagoRaw !== undefined && valorPagoRaw !== null && String(valorPagoRaw).trim() !== '' && valorPago === null) erros.push('Valor pago inválido.');

  const dataEmissaoRaw = valorDaLinha(linha, mapeamento, 'dataEmissao');
  const dataEmissao = dataEmissaoRaw ? normalizarData(dataEmissaoRaw) : null;
  if (dataEmissaoRaw && !dataEmissao) erros.push('Data de emissão inválida.');

  return {
    erros,
    dados: {
      fornecedorId,
      fornecedorNomeImportado,
      descricao,
      categoria: textoLimpo(valorDaLinha(linha, mapeamento, 'categoria'), 100),
      documento: textoLimpo(valorDaLinha(linha, mapeamento, 'documento'), 100),
      parcela: textoLimpo(valorDaLinha(linha, mapeamento, 'parcela'), 50),
      dataEmissao,
      vencimento,
      valor,
      formaPagamento: textoLimpo(valorDaLinha(linha, mapeamento, 'formaPagamento'), 100),
      bancoConta: textoLimpo(valorDaLinha(linha, mapeamento, 'bancoConta'), 150),
      status: status || 'pendente',
      dataPagamento,
      valorPago: status === 'pago' ? (valorPago === null ? valor : valorPago) : null,
      observacao: textoLimpo(valorDaLinha(linha, mapeamento, 'observacao')),
    },
  };
}


function chaveDuplicidade(dados, empresaId) {
  const fornecedor = dados.fornecedorId
    ? `id:${Number(dados.fornecedorId)}`
    : `nome:${slugHeader(dados.fornecedorNomeImportado || '') || 'sem-fornecedor'}`;
  const valor = Number(dados.valor || 0).toFixed(2);
  const vencimento = dados.vencimento || '';
  const documento = slugHeader(dados.documento || '');
  const parcela = slugHeader(dados.parcela || '');
  if (documento) return ['doc', Number(empresaId), fornecedor, documento, parcela, valor, vencimento].join('|');
  return ['fallback', Number(empresaId), fornecedor, slugHeader(dados.descricao || ''), valor, vencimento].join('|');
}

function avaliarLinhas({ empresaId, linhas, mapeamento, fornecedoresPorNome = {}, chavesExistentes = new Set() }) {
  const vistos = new Set(chavesExistentes || []);
  return (linhas || []).map((linha, idx) => {
    const preparado = prepararLinha(linha, mapeamento, { fornecedoresPorNome });
    const item = {
      linha: idx + 2,
      status: preparado.erros.length ? 'erro' : 'pronto',
      erros: preparado.erros,
      dados: preparado.dados,
      duplicidade: false,
    };
    if (!preparado.erros.length) {
      const chave = chaveDuplicidade(preparado.dados, empresaId);
      item.chaveDuplicidade = chave;
      if (vistos.has(chave)) {
        item.status = 'duplicidade';
        item.duplicidade = true;
      } else vistos.add(chave);
    }
    return item;
  });
}


async function validarEmpresa(db, empresaId) {
  const { rows } = await db.query('SELECT id FROM empresas WHERE id = $1', [Number(empresaId)]);
  return !!rows.length;
}

async function carregarFornecedores(db, empresaId) {
  const { rows } = await db.query(
    'SELECT id, razao_social, nome_fantasia FROM fornecedores WHERE empresa_id = $1',
    [Number(empresaId)]
  );
  const mapa = {};
  for (const r of rows) {
    const item = { id: Number(r.id), nome: r.razao_social };
    if (r.razao_social) mapa[slugHeader(r.razao_social)] = item;
    if (r.nome_fantasia) mapa[slugHeader(r.nome_fantasia)] = item;
  }
  return mapa;
}

function dadosExistente(row) {
  return {
    fornecedorId: row.fornecedor_id ? Number(row.fornecedor_id) : null,
    fornecedorNomeImportado: row.fornecedor_nome_importado || null,
    descricao: row.descricao,
    documento: row.documento || null,
    parcela: row.parcela || null,
    valor: Number(row.valor),
    vencimento: dataCalendarioISO(row.vencimento),
  };
}

async function carregarChavesExistentes(db, empresaId, preparados) {
  const validos = (preparados || []).filter(p => !p.erros.length && p.dados.vencimento);
  if (!validos.length) return new Set();
  const datas = validos.map(p => p.dados.vencimento).sort();
  const desde = datas[0], ate = datas[datas.length - 1];
  const { rows } = await db.query(
    `SELECT fornecedor_id, fornecedor_nome_importado, descricao, documento, parcela, valor, vencimento
     FROM contas_pagar
     WHERE empresa_id = $1 AND vencimento >= $2 AND vencimento <= $3`,
    [Number(empresaId), desde, ate]
  );
  return new Set(rows.map(r => chaveDuplicidade(dadosExistente(r), empresaId)));
}

function resumirAvaliacao(itens) {
  return {
    total: itens.length,
    prontas: itens.filter(i => i.status === 'pronto').length,
    duplicidades: itens.filter(i => i.status === 'duplicidade').length,
    erros: itens.filter(i => i.status === 'erro').length,
  };
}

function validarMapeamento(mapeamento) {
  const faltando = [];
  for (const campo of ['descricao', 'vencimento', 'valor']) {
    if (!mapeamento || !mapeamento[campo]) faltando.push(campo);
  }
  return faltando;
}

async function previsualizarImportacao({ empresaId, linhas, mapeamento }, db) {
  const eid = Number(empresaId);
  if (!eid) throw Object.assign(new Error('Selecione a empresa.'), { statusCode: 400 });
  if (!Array.isArray(linhas) || !linhas.length) throw Object.assign(new Error('A planilha não possui linhas para importar.'), { statusCode: 400 });
  if (linhas.length > 5000) throw Object.assign(new Error('A importação aceita no máximo 5.000 linhas por arquivo.'), { statusCode: 400 });
  const faltando = validarMapeamento(mapeamento);
  if (faltando.length) throw Object.assign(new Error('Mapeie as colunas obrigatórias: descrição, vencimento e valor.'), { statusCode: 400 });
  const database = db || require('../db/pool');
  if (!(await validarEmpresa(database, eid))) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });
  const fornecedoresPorNome = await carregarFornecedores(database, eid);
  const preparados = linhas.map(l => prepararLinha(l, mapeamento, { fornecedoresPorNome }));
  const chavesExistentes = await carregarChavesExistentes(database, eid, preparados);
  const itens = avaliarLinhas({ empresaId: eid, linhas, mapeamento, fornecedoresPorNome, chavesExistentes });
  return { itens, resumo: resumirAvaliacao(itens) };
}


async function confirmarImportacao({ empresaId, linhas, mapeamento, nomeArquivo, forceLinhas = [] }, dbPool) {
  const eid = Number(empresaId);
  if (!eid) throw Object.assign(new Error('Selecione a empresa.'), { statusCode: 400 });
  if (!Array.isArray(linhas) || !linhas.length) throw Object.assign(new Error('A planilha não possui linhas para importar.'), { statusCode: 400 });
  if (linhas.length > 5000) throw Object.assign(new Error('A importação aceita no máximo 5.000 linhas por arquivo.'), { statusCode: 400 });
  const faltando = validarMapeamento(mapeamento);
  if (faltando.length) throw Object.assign(new Error('Mapeie as colunas obrigatórias: descrição, vencimento e valor.'), { statusCode: 400 });
  const pool = dbPool || require('../db/pool');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa importações simultâneas da mesma empresa, evitando que duas
    // confirmações concorrentes passem pela checagem de duplicidade ao mesmo tempo.
    await client.query('SELECT pg_advisory_xact_lock(20260828, $1)', [eid]);
    if (!(await validarEmpresa(client, eid))) throw Object.assign(new Error('Empresa não encontrada.'), { statusCode: 404 });

    const fornecedoresPorNome = await carregarFornecedores(client, eid);
    const preparados = linhas.map(l => prepararLinha(l, mapeamento, { fornecedoresPorNome }));
    const chavesExistentes = await carregarChavesExistentes(client, eid, preparados);
    const itens = avaliarLinhas({ empresaId: eid, linhas, mapeamento, fornecedoresPorNome, chavesExistentes });
    const forcar = new Set((forceLinhas || []).map(Number));

    const { rows: loteRows } = await client.query(
      `INSERT INTO contas_pagar_importacoes
       (empresa_id, nome_arquivo, total_linhas, total_importadas, total_ignoradas, total_erros)
       VALUES ($1,$2,$3,0,0,0)
       RETURNING id`,
      [eid, textoLimpo(nomeArquivo, 255) || 'planilha', itens.length]
    );
    const importacaoId = Number(loteRows[0].id);

    let importadas = 0, duplicidadesIgnoradas = 0, erros = 0;
    const ids = [];
    for (const item of itens) {
      if (item.status === 'erro') { erros++; continue; }
      if (item.status === 'duplicidade' && !forcar.has(Number(item.linha))) {
        duplicidadesIgnoradas++;
        continue;
      }
      const d = item.dados;
      const { rows } = await client.query(
        `INSERT INTO contas_pagar (empresa_id, fornecedor_id, fornecedor_nome_importado, descricao, categoria,
          documento, parcela, data_emissao, valor, vencimento, forma_pagamento,
          banco_conta, status, data_pagamento, valor_pago, observacao, importacao_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [eid, d.fornecedorId, d.fornecedorNomeImportado, d.descricao, d.categoria,
          d.documento, d.parcela, d.dataEmissao, d.valor, d.vencimento, d.formaPagamento,
          d.bancoConta, d.status, d.status === 'pago' ? d.dataPagamento : null,
          d.status === 'pago' ? d.valorPago : null, d.observacao, importacaoId]
      );
      importadas++;
      ids.push(Number(rows[0].id));
    }

    await client.query(
      `UPDATE contas_pagar_importacoes
       SET total_importadas = $1, total_ignoradas = $2, total_erros = $3
       WHERE id = $4`,
      [importadas, duplicidadesIgnoradas, erros, importacaoId]
    );
    await client.query('COMMIT');
    return { importacaoId, importadas, duplicidadesIgnoradas, erros, ids, itens };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    if (client.release) client.release();
  }
}


function valorCelulaXlsx(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v;
  if (Object.prototype.hasOwnProperty.call(v, 'result')) return valorCelulaXlsx(v.result);
  if (Object.prototype.hasOwnProperty.call(v, 'text')) return v.text;
  if (Array.isArray(v.richText)) return v.richText.map(x => x.text || '').join('');
  if (v.hyperlink && v.text) return v.text;
  return String(v);
}

async function lerXlsxBuffer(buffer, ExcelJSImpl) {
  const ExcelJS = ExcelJSImpl || require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const ws = workbook.worksheets && workbook.worksheets[0];
  if (!ws) return { colunas: [], linhas: [], nomeAba: null };
  const rowCount = Math.min(Number(ws.rowCount || 0), 5001);
  const colCount = Math.min(Number(ws.columnCount || 0), 100);
  let headerRow = null;
  let headerIndex = 0;
  for (let r = 1; r <= Math.min(rowCount, 50); r++) {
    const vals = [];
    for (let c = 1; c <= colCount; c++) vals.push(valorCelulaXlsx(ws.getRow(r).getCell(c).value));
    if (vals.some(v => String(v === null || v === undefined ? '' : v).trim() !== '')) {
      headerRow = vals;
      headerIndex = r;
      break;
    }
  }
  if (!headerRow) return { colunas: [], linhas: [], nomeAba: ws.name || null };
  const colunas = headerRow.map((v, i) => String(v || '').trim() || `Coluna ${i + 1}`);
  const linhas = [];
  for (let r = headerIndex + 1; r <= rowCount && linhas.length < 5000; r++) {
    const obj = {};
    let temValor = false;
    for (let c = 1; c <= colunas.length; c++) {
      const v = valorCelulaXlsx(ws.getRow(r).getCell(c).value);
      obj[colunas[c - 1]] = v;
      if (String(v === null || v === undefined ? '' : v).trim() !== '') temValor = true;
    }
    if (temValor) linhas.push(obj);
  }
  return { colunas, linhas, nomeAba: ws.name || null };
}

async function lerArquivo(buffer, nomeArquivo, ExcelJSImpl) {
  const nome = String(nomeArquivo || '').toLowerCase();
  if (nome.endsWith('.csv')) return lerCsvBuffer(buffer);
  if (nome.endsWith('.xlsx')) return lerXlsxBuffer(buffer, ExcelJSImpl);
  throw Object.assign(new Error('Formato não suportado. Envie um arquivo CSV ou XLSX.'), { statusCode: 400 });
}

module.exports = {
  ALIASES,
  normalizarValor,
  normalizarData,
  slugHeader,
  sugerirMapeamento,
  detectarDelimitador,
  parseCsv,
  lerCsvBuffer,
  normalizarStatus,
  prepararLinha,
  chaveDuplicidade,
  avaliarLinhas,
  validarMapeamento,
  carregarFornecedores,
  carregarChavesExistentes,
  resumirAvaliacao,
  previsualizarImportacao,
  confirmarImportacao,
  valorCelulaXlsx,
  lerXlsxBuffer,
  lerArquivo,
};
