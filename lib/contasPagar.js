// Contas a Pagar — lançamento manual, por empresa. Ativado em 24/08/2026
// (ver docs/04-alteracoes.md e docs/02-decisoes.md).
//
// Regra central: a coluna `status` no banco só guarda o que o usuário
// realmente definiu (pendente | pago | cancelado). "Vencido" nunca é
// gravado — é sempre calculado aqui (pendente + vencimento no passado),
// pra nunca depender de um job em segundo plano pra "promover" status
// sozinho (mesma filosofia já usada no projeto: nada muda de status
// automaticamente sem uma ação explícita — ver `compras`).
//
// Regra de correção: contas PENDENTES e PAGAS podem ser editadas para
// corrigir erros de lançamento (inclusive código CR/documento e, quando
// paga, a data real do pagamento). Conta CANCELADA continua imutável.
// Exclusão de conta paga permanece bloqueada para preservar o histórico.
const pool = require('../db/pool');
const { diaBRT } = require('./periodo');

const STATUS_VALIDOS = ['pendente', 'pago', 'cancelado'];
const CATEGORIAS_SUGERIDAS = [
  'Fornecedores', 'Aluguel', 'Impostos e taxas', 'Folha de pagamento',
  'Marketing e publicidade', 'Frete e logística', 'Tarifas bancárias',
  'Serviços e assinaturas', 'Manutenção', 'Outros',
];

function hojeBRT() {
  return diaBRT(new Date());
}

function round2(n) { return Math.round(n * 100) / 100; }

// Serializa uma linha do banco pro formato usado pelo front-end. "vencido"
// é calculado aqui (nunca lido de uma coluna) — ver comentário no topo do
// arquivo e em db/schema.sql.
function serialize(row, hoje) {
  const h = hoje || hojeBRT();
  const vencimentoStr = row.vencimento ? String(row.vencimento).slice(0, 10) : null;
  const vencido = row.status === 'pendente' && vencimentoStr !== null && vencimentoStr < h;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    fornecedorId: row.fornecedor_id,
    fornecedorNome: row.fornecedor_nome || row.fornecedor_nome_importado || null,
    descricao: row.descricao,
    categoria: row.categoria,
    valor: Number(row.valor),
    vencimento: vencimentoStr,
    dataPagamento: row.data_pagamento ? String(row.data_pagamento).slice(0, 10) : null,
    statusBase: row.status,
    status: vencido ? 'vencido' : row.status,
    observacao: row.observacao,
    documento: row.documento || null,
    parcela: row.parcela || null,
    dataEmissao: row.data_emissao ? String(row.data_emissao).slice(0, 10) : null,
    formaPagamento: row.forma_pagamento || null,
    bancoConta: row.banco_conta || null,
    valorPago: row.valor_pago === null || row.valor_pago === undefined ? null : Number(row.valor_pago),
    importacaoId: row.importacao_id || null,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

function validatePayload(body, { partial = false } = {}) {
  const errors = {};
  const out = {};

  if (!partial) {
    const empresaId = Number(body.empresaId);
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    else out.empresaId = empresaId;
  }

  if (body.fornecedorId !== undefined) {
    const fornecedorId = body.fornecedorId === null || body.fornecedorId === '' ? null : Number(body.fornecedorId);
    out.fornecedorId = fornecedorId || null;
  } else if (!partial) {
    out.fornecedorId = null;
  }

  if (!partial || body.descricao !== undefined) {
    const descricao = String(body.descricao || '').trim();
    if (!descricao) errors.descricao = 'Informe a descrição.';
    else if (descricao.length > 200) errors.descricao = 'Descrição muito longa (máx. 200 caracteres).';
    else out.descricao = descricao;
  }

  if (body.categoria !== undefined) {
    const categoria = String(body.categoria || '').trim();
    if (categoria.length > 100) errors.categoria = 'Categoria muito longa (máx. 100 caracteres).';
    else out.categoria = categoria || null;
  }

  if (!partial || body.valor !== undefined) {
    const valor = Number(body.valor);
    if (!Number.isFinite(valor) || valor <= 0) errors.valor = 'Informe um valor maior que zero.';
    else out.valor = round2(valor);
  }

  if (!partial || body.vencimento !== undefined) {
    const vencimento = String(body.vencimento || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) errors.vencimento = 'Informe a data de vencimento.';
    else out.vencimento = vencimento;
  }

  if (body.documento !== undefined) {
    const documento = String(body.documento || '').trim();
    if (documento.length > 100) errors.documento = 'Código CR muito longo (máx. 100 caracteres).';
    else out.documento = documento || null;
  }

  if (body.dataPagamento !== undefined) {
    const dataPagamento = String(body.dataPagamento || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPagamento)) errors.dataPagamento = 'Informe a data de pagamento.';
    else out.dataPagamento = dataPagamento;
  }

  if (body.observacao !== undefined) {
    out.observacao = String(body.observacao || '').trim() || null;
  }

  return { errors, data: out };
}

async function validarFornecedor(fornecedorId, empresaId) {
  if (!fornecedorId) return null;
  const { rows } = await pool.query('SELECT id FROM fornecedores WHERE id = $1 AND empresa_id = $2', [fornecedorId, empresaId]);
  if (!rows.length) return 'Fornecedor não encontrado nesta empresa.';
  return null;
}

// Lista contas a pagar de uma empresa e, opcionalmente, filtra por status
// efetivo e por busca livre (descrição, categoria ou fornecedor).
//
// O período [desde, ate] (datas BRT, 'YYYY-MM-DD') só restringe contas já
// PAGAS (pela data_pagamento — o evento que de fato aconteceu naquela
// data), igual ao "pagas no período" do resumo. Contas pendentes/vencidas/
// canceladas são sempre listadas, independente do período: são um saldo
// em aberto (ou um registro cancelado), não um fluxo que aconteceu dentro
// de uma janela de tempo — mesma razão já aplicada aos KPIs em
// resumoContasPagar. Antes desta correção, TODAS as contas eram filtradas
// por vencimento dentro do período; como nenhuma opção de período do
// header inclui datas futuras (mesmo "Este mês" vai só até "agora", nunca
// até o fim do mês), uma conta recém-criada com vencimento futuro
// simplesmente não aparecia na lista — nem em Pendente, nem em Vencido —
// até o vencimento "entrar" na janela do período (ver docs/02-decisoes.md
// e docs/04-alteracoes.md).
async function listarContasPagar({ empresaId, desde, ate, status, search }) {
  const temBusca = !!(search && search.trim());
  const conditions = ['cp.empresa_id = $1'];
  const params = [empresaId];
  // Busca livre é uma localização direta do lançamento: não esconda uma CR
  // paga só porque a data do pagamento ficou fora do período do cabeçalho.
  if (!temBusca) {
    params.push(desde, ate);
    conditions.push("(cp.status != 'pago' OR (cp.data_pagamento >= $2 AND cp.data_pagamento <= $3))");
  }
  if (temBusca) {
    params.push('%' + search.trim() + '%');
    const idx = params.length;
    conditions.push('(cp.documento ILIKE $' + idx + ' OR cp.descricao ILIKE $' + idx + ' OR cp.categoria ILIKE $' + idx + ' OR f.razao_social ILIKE $' + idx + ' OR cp.fornecedor_nome_importado ILIKE $' + idx + ')');
  }

  const { rows } = await pool.query(
    `SELECT cp.*, f.razao_social AS fornecedor_nome
     FROM contas_pagar cp
     LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY cp.vencimento ASC, cp.id DESC`,
    params
  );

  const hoje = hojeBRT();
  let contas = rows.map((r) => serialize(r, hoje));
  if (status) contas = contas.filter((c) => c.status === status);
  return contas;
}

// Data (YYYY-MM-DD, calendário BRT) N dias à frente de uma data-base
// também em 'YYYY-MM-DD' — usado só pra recortar "vencendo nos próximos N
// dias" abaixo, sem nenhuma dependência de fuso além da que já existia
// (soma em cima da própria string de data, nunca um novo cálculo de
// timezone).
function somarDiasData(dataStr, dias) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

// Resumo pro topo da tela. "Total a pagar", "vencendo hoje" e "vencidas"
// são SEMPRE o saldo em aberto da empresa (não dependem do período
// selecionado no header — são um saldo, não um fluxo do período; ver
// docs/02-decisoes.md). Só "pagas no período" usa o período selecionado
// (data_pagamento dentro de [desde, ate]).
//
// "vencendoProximos7Dias" — adicionado pra IA Gestora (docs/02-decisoes.md,
// tarefa "IA Gestora como inteligência central") responder "o que vence
// esta semana": soma o que vence de amanhã até 6 dias à frente (janela
// corrida de 7 dias a partir de hoje, exclusive hoje/vencidas — que já têm
// seus próprios campos acima, pra nunca contar o mesmo valor duas vezes em
// campos diferentes). Mesmo saldo em aberto de sempre, só mais um recorte
// dele — nenhum cálculo financeiro novo.
async function resumoContasPagar({ empresaId, desde, ate }) {
  const hoje = hojeBRT();
  const limite7dias = somarDiasData(hoje, 7);
  const { rows: abertos } = await pool.query(
    `SELECT vencimento, valor FROM contas_pagar WHERE empresa_id = $1 AND status = 'pendente'`,
    [empresaId]
  );
  let totalAPagar = 0, vencendoHoje = 0, vencidas = 0, vencendoProximos7Dias = 0;
  for (const r of abertos) {
    const v = Number(r.valor);
    totalAPagar += v;
    const venc = String(r.vencimento).slice(0, 10);
    if (venc === hoje) vencendoHoje += v;
    else if (venc < hoje) vencidas += v;
    else if (venc <= limite7dias) vencendoProximos7Dias += v;
  }

  const { rows: pagos } = await pool.query(
    `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_pagar
     WHERE empresa_id = $1 AND status = 'pago' AND data_pagamento >= $2 AND data_pagamento <= $3`,
    [empresaId, desde, ate]
  );

  return {
    totalAPagar: round2(totalAPagar),
    vencendoHoje: round2(vencendoHoje),
    vencidas: round2(vencidas),
    vencendoProximos7Dias: round2(vencendoProximos7Dias),
    pagasNoPeriodo: round2(Number(pagos[0].total)),
  };
}

async function criarContaPagar(body) {
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };

  const erroFornecedor = await validarFornecedor(data.fornecedorId, data.empresaId);
  if (erroFornecedor) return { errors: { fornecedorId: erroFornecedor } };

  const { rows } = await pool.query(
    `INSERT INTO contas_pagar (empresa_id, fornecedor_id, descricao, categoria, valor, vencimento, observacao, documento, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendente')
     RETURNING *`,
    [data.empresaId, data.fornecedorId, data.descricao, data.categoria || null, data.valor, data.vencimento, data.observacao || null, data.documento || null]
  );
  return { conta: await buscarPorId(rows[0].id).then(serialize) };
}

async function buscarPorId(id) {
  const { rows } = await pool.query(
    `SELECT cp.*, f.razao_social AS fornecedor_nome FROM contas_pagar cp LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id WHERE cp.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function atualizarContaPagar(id, body) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'cancelado') {
    return { errors: { status: 'Conta cancelada não pode ser alterada.' } };
  }

  const { errors, data } = validatePayload(body, { partial: true });
  if (Object.keys(errors).length) return { errors };
  if (!Object.keys(data).length) return { errors: { geral: 'Nada para atualizar.' } };

  if (data.fornecedorId !== undefined) {
    const erroFornecedor = await validarFornecedor(data.fornecedorId, atual.empresa_id);
    if (erroFornecedor) return { errors: { fornecedorId: erroFornecedor } };
  }

  const colMap = { fornecedorId: 'fornecedor_id', descricao: 'descricao', categoria: 'categoria', valor: 'valor', vencimento: 'vencimento', observacao: 'observacao', documento: 'documento' };
  if (atual.status === 'pago') colMap.dataPagamento = 'data_pagamento';
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(colMap)) {
    if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
  }
  fields.push('updated_at = now()');
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE contas_pagar SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return { conta: await buscarPorId(rows[0].id).then(serialize) };
}

async function marcarComoPago(id, dataPagamento) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'cancelado') return { errors: { geral: 'Não é possível marcar como paga uma conta cancelada.' } };
  if (atual.status === 'pago') return { errors: { geral: 'Esta conta já está marcada como paga.' } };

  const data = dataPagamento && /^\d{4}-\d{2}-\d{2}$/.test(dataPagamento) ? dataPagamento : hojeBRT();
  const { rows } = await pool.query(
    `UPDATE contas_pagar SET status = 'pago', data_pagamento = $1, updated_at = now() WHERE id = $2 RETURNING id`,
    [data, id]
  );
  return { conta: await buscarPorId(rows[0].id).then(serialize) };
}

async function cancelarContaPagar(id) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'pago') return { errors: { geral: 'Não é possível cancelar uma conta já paga.' } };
  if (atual.status === 'cancelado') return { errors: { geral: 'Esta conta já está cancelada.' } };

  const { rows } = await pool.query(
    `UPDATE contas_pagar SET status = 'cancelado', updated_at = now() WHERE id = $1 RETURNING id`,
    [id]
  );
  return { conta: await buscarPorId(rows[0].id).then(serialize) };
}

async function excluirContaPagar(id) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'pago') return { errors: { geral: 'Não é possível excluir uma conta já paga — cancele um novo lançamento em vez de apagar o histórico.' } };

  await pool.query('DELETE FROM contas_pagar WHERE id = $1', [id]);
  return { ok: true };
}

module.exports = {
  STATUS_VALIDOS,
  CATEGORIAS_SUGERIDAS,
  serialize,
  hojeBRT,
  listarContasPagar,
  resumoContasPagar,
  criarContaPagar,
  buscarPorId,
  atualizarContaPagar,
  marcarComoPago,
  cancelarContaPagar,
  excluirContaPagar,
};
