// Sessões de login — cookie httpOnly com token opaco (ver
// db/schema.sql#sessoes_usuario e docs/02-decisoes.md). Nunca JWT/token
// auto-contido: o token em si não guarda nada, ele só é uma chave que
// aponta pra uma linha em `sessoes_usuario` — assim uma sessão pode ser
// revogada de verdade a qualquer momento (logout), e o banco nunca guarda o
// token em texto puro (só o hash SHA-256 dele), então nem um dump do banco
// permite se passar por um usuário logado.
const crypto = require('crypto');
const pool = require('../../db/pool');

const TOKEN_BYTES = 32;
const SESSAO_DIAS = Number(process.env.IA_SESSAO_DIAS) > 0 ? Number(process.env.IA_SESSAO_DIAS) : 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function criarSessao(usuarioId) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const expiraEm = new Date(Date.now() + SESSAO_DIAS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessoes_usuario (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)',
    [usuarioId, tokenHash, expiraEm]
  );
  return { token, expiraEm };
}

// Devolve { id, email, nome } do usuário dono da sessão, ou null quando o
// token não existe, expirou, ou o usuário foi desativado (`ativo=false`) —
// nunca lança exceção por sessão inválida (chamador sempre trata como "não
// autenticado", nunca como erro de servidor).
async function validarSessao(token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT s.id AS sessao_id, u.id, u.email, u.name, u.ativo
     FROM sessoes_usuario s
     JOIN users u ON u.id = s.usuario_id
     WHERE s.token_hash = $1 AND s.expira_em > now()`,
    [tokenHash]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (!row.ativo) return null;
  // Best-effort: atualiza último uso, nunca bloqueia a resposta por causa
  // disso (é só telemetria, não faz parte da checagem de validade).
  pool.query('UPDATE sessoes_usuario SET ultimo_uso_em = now() WHERE id = $1', [row.sessao_id]).catch(() => {});
  return { id: row.id, email: row.email, nome: row.name };
}

async function revogarSessao(token) {
  if (!token) return;
  await pool.query('DELETE FROM sessoes_usuario WHERE token_hash = $1', [hashToken(token)]);
}

module.exports = { criarSessao, validarSessao, revogarSessao, SESSAO_DIAS };
