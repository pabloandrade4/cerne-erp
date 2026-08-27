// Importação de extrato bancário (Passo 2 da tarefa "Recebimentos + Fluxo
// de Caixa + IA Gestora", 27/08/2026, ver docs/02-decisoes.md).
//
// Fluxo pedido pelo usuário: 1) ler a planilha (XLSX/CSV) e sugerir um
// mapeamento de colunas; 2) mostrar uma PRÉVIA (quantas movimentações,
// quanto em entradas/saídas, quantas já existiam) ANTES de gravar
// qualquer coisa; 3) só confirma quando o usuário confirma.
//
// NUNCA duplica: cada movimentação recebe um hash determinístico (conta
// bancária + data + valor + tipo + descrição + documento) e o próprio
// banco garante unicidade (UNIQUE (conta_bancaria_id, hash_dedup) +
// ON CONFLICT DO NOTHING em db/schema.sql) — reimportar a mesma planilha
// nunca cria linha nova pras que já existem.
//
// A PLANILHA EM SI NUNCA É ARMAZENADA (pedido explícito do usuário) — este
// módulo só recebe os bytes do arquivo em memória (base64, decodificado
// aqui), extrai as movimentações e descarta o arquivo; só o que sobra
// gravado é a movimentação estruturada (extrato_movimentos) e um resumo do
// lote (extrato_importacoes: nome do arquivo, contagens, quem importou —
// nunca o conteúdo).
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { round2 } = require('./resultadoVenda');

const FORMATOS_VALIDOS = ['xlsx', 'csv'];
const CAMPOS_MAPEAVEIS = ['data', 'descricao', 'documento', 'entrada', 'saida', 'valor', 'saldo'];

function pad2(n) { return String(n).padStart(2, '0'); }

// ---------------- Leitura do arquivo (XLSX/CSV) -> grade bruta ----------------

function normalizarCabecalho(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase().trim();
}

function cellValue(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result; // fórmula: usa o resultado calculado
    if (v.text !== undefined) return v.text; // rich text
    if (v.richText) return v.richText.map((p) => p.text).join('');
  }
  return v;
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { colunas: [], linhas: [] };

  const brutas = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const valores = [];
    for (let i = 1; i <= row.cellCount; i++) valores.push(cellValue(row.getCell(i)));
    brutas.push(valores);
  });
  if (!brutas.length) return { colunas: [], linhas: [] };

  const colunas = brutas[0].map((c) => String(c ?? '').trim());
  const linhas = brutas.slice(1).filter((l) => l.some((v) => v !== null && v !== undefined && String(v).trim() !== ''));
  return { colunas, linhas };
}

// Parser CSV leve (sem dependência externa) — suporta ; ou , como
// delimitador (detecção automática pela primeira linha, comum em extratos
// de banco brasileiro) e campos entre aspas (com aspas escapadas "").
function detectarDelimitador(texto) {
  const primeiraLinha = texto.split(/\r?\n/, 1)[0] || '';
  const semicolons = (primeiraLinha.match(/;/g) || []).length;
  const virgulas = (primeiraLinha.match(/,/g) || []).length;
  return semicolons > virgulas ? ';' : ',';
}

function parseCsvTexto(texto) {
  const delimitador = detectarDelimitador(texto);
  const linhas = [];
  let campo = '', linha = [], dentroAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else dentroAspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { dentroAspas = true; continue; }
    if (c === delimitador) { linha.push(campo); campo = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.length > 1 || linha[0] !== '') linhas.push(linha);
      linha = [];
      continue;
    }
    campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

function parseCsv(buffer) {
  const texto = buffer.toString('utf8').replace(/^﻿/, ''); // remove BOM comum em export de banco
  const brutas = parseCsvTexto(texto);
  if (!brutas.length) return { colunas: [], linhas: [] };
  const colunas = brutas[0].map((c) => String(c ?? '').trim());
  const linhas = brutas.slice(1).filter((l) => l.some((v) => String(v ?? '').trim() !== ''));
  return { colunas, linhas };
}

async function lerPlanilha({ conteudoBase64, formato }) {
  if (!FORMATOS_VALIDOS.includes(formato)) throw Object.assign(new Error('Formato inválido — use xlsx ou csv.'), { status: 400 });
  const buffer = Buffer.from(String(conteudoBase64 || ''), 'base64');
  if (!buffer.length) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });
  return formato === 'xlsx' ? parseXlsx(buffer) : parseCsv(buffer);
}

// ---------------- Sugestão de mapeamento de colunas ----------------

const PALAVRAS_CHAVE = {
  data: ['data', 'dt', 'data lancamento', 'data mov', 'data do lancamento', 'dt lancamento'],
  descricao: ['descricao', 'historico', 'lancamento', 'discriminacao', 'complemento'],
  documento: ['documento', 'doc', 'num documento', 'numero documento', 'nr documento', 'cheque'],
  entrada: ['entrada', 'credito', 'valor credito', 'valor(entrada)', 'creditos'],
  saida: ['saida', 'debito', 'valor debito', 'valor(saida)', 'debitos'],
  valor: ['valor', 'valor(r$)', 'valor r$', 'valor lancamento'],
  saldo: ['saldo', 'saldo apos', 'saldo final', 'saldo do dia', 'saldo atual'],
};

function sugerirMapeamento(colunas) {
  const normalizadas = colunas.map(normalizarCabecalho);
  const mapeamento = {};
  const usados = new Set();
  for (const campo of CAMPOS_MAPEAVEIS) {
    let encontrado = null;
    for (let i = 0; i < normalizadas.length; i++) {
      if (usados.has(i)) continue;
      if (PALAVRAS_CHAVE[campo].includes(normalizadas[i])) { encontrado = i; break; }
    }
    if (encontrado === null) {
      // segunda passada: contém a palavra-chave (não só igualdade exata)
      for (let i = 0; i < normalizadas.length; i++) {
        if (usados.has(i)) continue;
        if (PALAVRAS_CHAVE[campo].some((p) => normalizadas[i].includes(p))) { encontrado = i; break; }
      }
    }
    if (encontrado !== null) { mapeamento[campo] = encontrado; usados.add(encontrado); }
    else mapeamento[campo] = null;
  }
  return mapeamento;
}

// ---------------- Parsing de data e valor monetário ----------------

function parseData(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return `${raw.getUTCFullYear()}-${pad2(raw.getUTCMonth() + 1)}-${pad2(raw.getUTCDate())}`;
  }
  if (typeof raw === 'number') {
    // número de série de data do Excel (sistema 1900) — planilhas exportadas
    // de banco às vezes trazem a data sem formatação de data aplicada.
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) return `20${m[3]}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
  return null;
}

function parseValorMonetario(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? round2(raw) : null;
  let s = String(raw).trim();
  if (!s) return null;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negativo = true; s = s.replace(/-\s*$/, ''); }
  if (/^-/.test(s)) { negativo = true; s = s.replace(/^-/, ''); }
  s = s.replace(/R\$\s*/i, '').trim();

  const ultimaVirgula = s.lastIndexOf(',');
  const ultimoPonto = s.lastIndexOf('.');
  if (ultimaVirgula > -1 && ultimoPonto > -1) {
    if (ultimaVirgula > ultimoPonto) s = s.replace(/\./g, '').replace(',', '.'); // pt-BR: 1.234,56
    else s = s.replace(/,/g, ''); // en-US: 1,234.56
  } else if (ultimaVirgula > -1) {
    s = s.replace(/\./g, '').replace(',', '.'); // só vírgula -> decimal pt-BR
  }
  s = s.replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return round2(negativo ? -Math.abs(n) : n);
}

// ---------------- Aplicar mapeamento -> movimentos normalizados ----------------

function aplicarMapeamento({ colunas, linhas, mapeamento }) {
  const idx = mapeamento || {};
  const movimentos = [];
  const erros = [];

  linhas.forEach((linha, i) => {
    const numeroLinha = i + 2; // +1 cabeçalho, +1 pra base 1
    const data = idx.data !== null && idx.data !== undefined ? parseData(linha[idx.data]) : null;
    if (!data) { erros.push({ linha: numeroLinha, motivo: 'Data inválida ou ausente.' }); return; }

    const descricao = idx.descricao !== null && idx.descricao !== undefined ? String(linha[idx.descricao] ?? '').trim() || null : null;
    const documento = idx.documento !== null && idx.documento !== undefined ? String(linha[idx.documento] ?? '').trim() || null : null;

    let valor = null, tipo = null;
    if ((idx.entrada !== null && idx.entrada !== undefined) || (idx.saida !== null && idx.saida !== undefined)) {
      const entrada = idx.entrada !== null && idx.entrada !== undefined ? parseValorMonetario(linha[idx.entrada]) : null;
      const saida = idx.saida !== null && idx.saida !== undefined ? parseValorMonetario(linha[idx.saida]) : null;
      if (entrada !== null && entrada !== 0) { valor = round2(Math.abs(entrada)); tipo = 'entrada'; }
      else if (saida !== null && saida !== 0) { valor = round2(Math.abs(saida)); tipo = 'saida'; }
    }
    if (valor === null && idx.valor !== null && idx.valor !== undefined) {
      const bruto = parseValorMonetario(linha[idx.valor]);
      if (bruto !== null && bruto !== 0) { valor = round2(Math.abs(bruto)); tipo = bruto > 0 ? 'entrada' : 'saida'; }
    }
    if (valor === null || !tipo) { erros.push({ linha: numeroLinha, motivo: 'Não foi possível identificar entrada/saída/valor nesta linha.' }); return; }

    const saldoApos = idx.saldo !== null && idx.saldo !== undefined ? parseValorMonetario(linha[idx.saldo]) : null;
    movimentos.push({ data, descricao, documento, valor, tipo, saldoApos });
  });

  return { movimentos, erros };
}

// ---------------- Hash de deduplicação ----------------

function calcularHashDedup(contaBancariaId, mov) {
  const base = [
    contaBancariaId,
    mov.data,
    Number(mov.valor).toFixed(2),
    mov.tipo,
    (mov.descricao || '').trim().toLowerCase(),
    (mov.documento || '').trim().toLowerCase(),
  ].join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

// ---------------- Prévia (ANTES de confirmar — pedido explícito do usuário) ----------------

async function gerarPreview({ contaBancariaId, movimentos }) {
  const comHash = movimentos.map((m) => ({ ...m, hashDedup: calcularHashDedup(contaBancariaId, m) }));
  const hashes = comHash.map((m) => m.hashDedup);
  const existentesSet = new Set();
  if (hashes.length) {
    const { rows } = await pool.query(
      `SELECT hash_dedup FROM extrato_movimentos WHERE conta_bancaria_id = $1 AND hash_dedup = ANY($2::text[])`,
      [contaBancariaId, hashes]
    );
    rows.forEach((r) => existentesSet.add(r.hash_dedup));
  }

  let totalEntradas = 0, totalSaidas = 0, totalDuplicadas = 0;
  const anotados = comHash.map((m) => {
    const duplicada = existentesSet.has(m.hashDedup);
    if (duplicada) totalDuplicadas++;
    else if (m.tipo === 'entrada') totalEntradas = round2(totalEntradas + m.valor);
    else totalSaidas = round2(totalSaidas + m.valor);
    return { ...m, duplicada };
  });

  return {
    movimentos: anotados,
    resumo: {
      totalMovimentacoes: anotados.length,
      totalNovas: anotados.length - totalDuplicadas,
      totalDuplicadas,
      totalEntradas,
      totalSaidas,
    },
  };
}

// Junta leitura do arquivo + mapeamento + prévia — usado pela rota de preview.
async function previsualizarImportacao({ conteudoBase64, formato, nomeArquivo, mapeamento, contaBancariaId }) {
  const { colunas, linhas } = await lerPlanilha({ conteudoBase64, formato });
  if (!colunas.length) return { errors: { arquivo: 'Não foi possível ler nenhuma linha desta planilha.' } };

  const mapeamentoFinal = mapeamento && Object.keys(mapeamento).length ? mapeamento : sugerirMapeamento(colunas);
  if (mapeamentoFinal.data === null || mapeamentoFinal.data === undefined) {
    return { errors: { mapeamento: 'Não foi possível identificar a coluna de data — selecione manualmente o mapeamento.' }, colunas, mapeamentoSugerido: mapeamentoFinal };
  }
  if ((mapeamentoFinal.entrada === null || mapeamentoFinal.entrada === undefined) &&
      (mapeamentoFinal.saida === null || mapeamentoFinal.saida === undefined) &&
      (mapeamentoFinal.valor === null || mapeamentoFinal.valor === undefined)) {
    return { errors: { mapeamento: 'Informe ao menos as colunas de entrada/saída ou uma coluna de valor.' }, colunas, mapeamentoSugerido: mapeamentoFinal };
  }

  const { movimentos, erros } = aplicarMapeamento({ colunas, linhas, mapeamento: mapeamentoFinal });
  if (!movimentos.length) return { errors: { arquivo: 'Nenhuma movimentação válida encontrada nesta planilha.' }, linhasComErro: erros, colunas, mapeamentoSugerido: mapeamentoFinal };

  const preview = await gerarPreview({ contaBancariaId, movimentos });
  return {
    colunas,
    mapeamentoSugerido: mapeamentoFinal,
    nomeArquivo: nomeArquivo || null,
    formato,
    linhasComErro: erros,
    ...preview,
  };
}

// ---------------- Confirmar importação ----------------

function serializeImportacao(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    contaBancariaId: row.conta_bancaria_id,
    nomeArquivo: row.nome_arquivo,
    formato: row.formato,
    totalMovimentacoes: row.total_movimentacoes,
    totalNovas: row.total_novas,
    totalDuplicadas: row.total_duplicadas,
    totalEntradas: row.total_entradas === null ? null : Number(row.total_entradas),
    totalSaidas: row.total_saidas === null ? null : Number(row.total_saidas),
    status: row.status,
    importadoPor: row.importado_por,
    criadoEm: row.created_at,
  };
}

async function confirmarImportacao({ empresaId, contaBancariaId, nomeArquivo, formato, mapeamento, movimentos, importadoPor }) {
  const errors = {};
  if (!empresaId) errors.empresaId = 'Informe a empresa.';
  if (!contaBancariaId) errors.contaBancariaId = 'Selecione a conta bancária.';
  if (!Array.isArray(movimentos) || !movimentos.length) errors.movimentos = 'Nenhuma movimentação pra importar — gere a prévia primeiro.';
  if (Object.keys(errors).length) return { errors };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: impRows } = await client.query(
      `INSERT INTO extrato_importacoes (empresa_id, conta_bancaria_id, nome_arquivo, formato, mapeamento_colunas, total_movimentacoes, importado_por, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'concluida') RETURNING id`,
      [empresaId, contaBancariaId, nomeArquivo || 'extrato.xlsx', formato || null, JSON.stringify(mapeamento || {}), movimentos.length, importadoPor || null]
    );
    const importacaoId = impRows[0].id;

    let totalNovas = 0, totalDuplicadas = 0, totalEntradas = 0, totalSaidas = 0;
    for (const m of movimentos) {
      const hash = calcularHashDedup(contaBancariaId, m);
      // `RETURNING id` (em vez de só olhar rowCount) é o jeito confiável de
      // saber se o INSERT realmente inseriu ou se o ON CONFLICT descartou —
      // mesmo padrão já usado em lib/despesasFixas.js: com
      // ON CONFLICT ... DO NOTHING, uma linha descartada por conflito nunca
      // aparece em RETURNING — 0 linhas devolvidas = já existia.
      const { rows: inseridas } = await client.query(
        `INSERT INTO extrato_movimentos (empresa_id, conta_bancaria_id, importacao_id, data, descricao, documento, valor, tipo, saldo_apos, hash_dedup)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (conta_bancaria_id, hash_dedup) DO NOTHING
         RETURNING id`,
        [empresaId, contaBancariaId, importacaoId, m.data, m.descricao || null, m.documento || null, m.valor, m.tipo, m.saldoApos ?? null, hash]
      );
      if (inseridas.length) {
        totalNovas++;
        if (m.tipo === 'entrada') totalEntradas = round2(totalEntradas + m.valor);
        else totalSaidas = round2(totalSaidas + m.valor);
      } else {
        totalDuplicadas++;
      }
    }

    await client.query(
      `UPDATE extrato_importacoes SET total_novas=$1, total_duplicadas=$2, total_entradas=$3, total_saidas=$4 WHERE id=$5`,
      [totalNovas, totalDuplicadas, totalEntradas, totalSaidas, importacaoId]
    );
    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM extrato_importacoes WHERE id = $1', [importacaoId]);
    return { importacao: serializeImportacao(rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------- Consultas ----------------

async function listarImportacoes({ empresaId, contaBancariaId }) {
  const condicoes = ['empresa_id = $1'];
  const params = [empresaId];
  if (contaBancariaId) { condicoes.push('conta_bancaria_id = $2'); params.push(contaBancariaId); }
  const { rows } = await pool.query(
    `SELECT * FROM extrato_importacoes WHERE ${condicoes.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  return rows.map(serializeImportacao);
}

function serializeMovimento(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    contaBancariaId: row.conta_bancaria_id,
    importacaoId: row.importacao_id,
    data: row.data ? String(row.data).slice(0, 10) : null,
    descricao: row.descricao,
    documento: row.documento,
    valor: row.valor === null ? null : Number(row.valor),
    tipo: row.tipo,
    saldoApos: row.saldo_apos === null ? null : Number(row.saldo_apos),
    statusConciliacao: row.status_conciliacao,
    conciliadoComTipo: row.conciliado_com_tipo,
    conciliadoComId: row.conciliado_com_id,
    conciliadoEm: row.conciliado_em,
  };
}

async function listarMovimentos({ empresaId, contaBancariaId, desde, ate, statusConciliacao }) {
  const condicoes = ['empresa_id = $1'];
  const params = [empresaId];
  if (contaBancariaId) { params.push(contaBancariaId); condicoes.push(`conta_bancaria_id = $${params.length}`); }
  if (desde) { params.push(desde); condicoes.push(`data >= $${params.length}`); }
  if (ate) { params.push(ate); condicoes.push(`data <= $${params.length}`); }
  if (statusConciliacao) { params.push(statusConciliacao); condicoes.push(`status_conciliacao = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM extrato_movimentos WHERE ${condicoes.join(' AND ')} ORDER BY data DESC, id DESC LIMIT 2000`,
    params
  );
  return rows.map(serializeMovimento);
}

async function buscarMovimentoPorId(id) {
  const { rows } = await pool.query('SELECT * FROM extrato_movimentos WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = {
  FORMATOS_VALIDOS,
  CAMPOS_MAPEAVEIS,
  lerPlanilha,
  sugerirMapeamento,
  aplicarMapeamento,
  parseData,
  parseValorMonetario,
  calcularHashDedup,
  gerarPreview,
  previsualizarImportacao,
  confirmarImportacao,
  listarImportacoes,
  listarMovimentos,
  buscarMovimentoPorId,
  serializeMovimento,
};
