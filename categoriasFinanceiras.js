// Categorias financeiras (plano de contas do usuário) — ativado em
// 31/08/2026. Cadastro real, por empresa, com um único nível de
// subcategoria (categoria_pai_id) — ver comentário em db/schema.sql sobre
// por que nunca há subcategoria-de-subcategoria.
//
// Nunca apaga uma categoria de verdade (DELETE quebraria o histórico de
// contas_pagar/extrato_movimentos já categorizados) — só "ativa=false",
// mesmo padrão já usado em despesas_fixas.ativo/contas_bancarias.ativa.
//
// Lista inicial (DEFAULT_CATEGORIAS) é semeada sob demanda, na primeira vez
// que `listarCategorias` é chamada para uma empresa que ainda não tem
// nenhuma categoria — nunca um seed global de boot (empresas são criadas a
// qualquer momento, um seed de boot só cobriria as que já existiam), e
// nunca sobrescreve nada se a empresa já tiver categorias (mesmo 1).
const pool = require('../db/pool');

const DEFAULT_CATEGORIAS = [
  'Matéria-prima', 'Fornecedores', 'Alimentação', 'Funcionários', 'Pró-labore',
  'Frete', 'Ads', 'Impostos', 'Contabilidade', 'Software', 'Aluguel', 'Energia',
  'Água', 'Internet', 'Telefone', 'Combustível', 'Transporte', 'Manutenção',
  'Limpeza', 'Material de escritório', 'Embalagens', 'Tarifas bancárias',
  'Juros', 'Investimentos', 'Outros',
];

function serialize(row) {
  return {
    id: Number(row.id),
    empresaId: Number(row.empresa_id),
    nome: row.nome,
    categoriaPaiId: row.categoria_pai_id === null ? null : Number(row.categoria_pai_id),
    ativa: row.ativa !== false,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

async function semearPadraoSeVazio(empresaId, db) {
  const { rows } = await db.query('SELECT 1 FROM categorias_financeiras WHERE empresa_id=$1 LIMIT 1', [empresaId]);
  if (rows.length) return;
  for (const nome of DEFAULT_CATEGORIAS) {
    await db.query('INSERT INTO categorias_financeiras (empresa_id, nome) VALUES ($1,$2)', [empresaId, nome]);
  }
}

// Devolve a lista (raízes + subcategorias aninhadas em `subcategorias`) —
// mais fácil de renderizar num <select> com grupos no frontend. Passe
// incluirInativas:true só nas telas de gestão de categorias (o formulário
// de lançamento de despesa nunca deve oferecer uma categoria desativada).
async function listarCategorias({ empresaId, incluirInativas = false }, db = null) {
  const id = Number(empresaId);
  if (!id) return [];
  db = db || pool;
  await semearPadraoSeVazio(id, db);
  const { rows } = await db.query(
    'SELECT * FROM categorias_financeiras WHERE empresa_id=$1' + (incluirInativas ? '' : ' AND ativa=true') + ' ORDER BY categoria_pai_id NULLS FIRST, nome',
    [id]
  );
  const todas = rows.map(serialize);
  const raizes = todas.filter((c) => !c.categoriaPaiId);
  for (const raiz of raizes) {
    raiz.subcategorias = todas.filter((c) => c.categoriaPaiId === raiz.id);
  }
  return raizes;
}

// Lista achatada (sem aninhar), útil para montar um mapa id->nome rápido.
async function listarCategoriasFlat({ empresaId, incluirInativas = true }, db = null) {
  const id = Number(empresaId);
  if (!id) return [];
  db = db || pool;
  await semearPadraoSeVazio(id, db);
  const { rows } = await db.query(
    'SELECT * FROM categorias_financeiras WHERE empresa_id=$1' + (incluirInativas ? '' : ' AND ativa=true') + ' ORDER BY nome',
    [id]
  );
  return rows.map(serialize);
}

async function buscarPorId(id, empresaId, db = null) {
  db = db || pool;
  const { rows } = await db.query('SELECT * FROM categorias_financeiras WHERE id=$1 AND empresa_id=$2', [id, empresaId]);
  return rows.length ? serialize(rows[0]) : null;
}

function validarNome(nome) {
  const v = String(nome || '').trim();
  if (!v) return { erro: 'Informe o nome da categoria.' };
  if (v.length > 100) return { erro: 'Nome muito longo (máx. 100 caracteres).' };
  return { valor: v };
}

async function criarCategoria(body, db = null) {
  db = db || pool;
  const empresaId = Number(body.empresaId);
  if (!empresaId) return { errors: { empresaId: 'Selecione a empresa.' } };
  const { erro, valor: nome } = validarNome(body.nome);
  if (erro) return { errors: { nome: erro } };

  let categoriaPaiId = null;
  if (body.categoriaPaiId !== undefined && body.categoriaPaiId !== null && body.categoriaPaiId !== '') {
    categoriaPaiId = Number(body.categoriaPaiId);
    const pai = await buscarPorId(categoriaPaiId, empresaId, db);
    if (!pai) return { errors: { categoriaPaiId: 'Categoria pai não encontrada nesta empresa.' } };
    // Nunca subcategoria-de-subcategoria (um único nível) — ver comentário
    // no topo do arquivo e em db/schema.sql.
    if (pai.categoriaPaiId) return { errors: { categoriaPaiId: 'Uma subcategoria não pode ter sua própria subcategoria.' } };
  }

  const { rows } = await db.query(
    'INSERT INTO categorias_financeiras (empresa_id, nome, categoria_pai_id) VALUES ($1,$2,$3) RETURNING *',
    [empresaId, nome, categoriaPaiId]
  );
  return { categoria: serialize(rows[0]) };
}

async function atualizarCategoria(id, body, db = null) {
  db = db || pool;
  const { rows: atualRows } = await db.query('SELECT * FROM categorias_financeiras WHERE id=$1', [id]);
  if (!atualRows.length) return { notFound: true };
  const { erro, valor: nome } = validarNome(body.nome);
  if (erro) return { errors: { nome: erro } };
  const { rows } = await db.query('UPDATE categorias_financeiras SET nome=$1, updated_at=now() WHERE id=$2 RETURNING *', [nome, id]);
  return { categoria: serialize(rows[0]) };
}

async function definirAtiva(id, ativa, db = null) {
  db = db || pool;
  const { rows } = await db.query('UPDATE categorias_financeiras SET ativa=$1, updated_at=now() WHERE id=$2 RETURNING *', [ativa, id]);
  if (!rows.length) return { notFound: true };
  return { categoria: serialize(rows[0]) };
}

module.exports = {
  DEFAULT_CATEGORIAS,
  serialize,
  listarCategorias,
  listarCategoriasFlat,
  buscarPorId,
  criarCategoria,
  atualizarCategoria,
  definirAtiva,
};
