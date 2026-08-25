// Testes de lib/auth/ — hash/verificação de senha (sem banco) e sessões
// (Postgres real, ver db/schema.sql#sessoes_usuario). A cobertura de ponta
// a ponta (login via HTTP, cookie, exigirLogin) fica em
// test/iaGestoraRoutes.test.js — aqui é só a camada de baixo nível.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { hashSenha, verificarSenha } = require('../lib/auth/senha');

describe('lib/auth/senha — hash e verificação (sem banco)', () => {
  test('hashSenha nunca guarda a senha original nem produz o mesmo hash duas vezes (salt aleatório)', () => {
    const h1 = hashSenha('SenhaForte123');
    const h2 = hashSenha('SenhaForte123');
    assert.notEqual(h1, h2);
    assert.ok(!h1.includes('SenhaForte123'));
    assert.match(h1, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  test('verificarSenha aceita a senha certa e rejeita a errada', () => {
    const hash = hashSenha('MinhaSenha!456');
    assert.equal(verificarSenha('MinhaSenha!456', hash), true);
    assert.equal(verificarSenha('minhasenha!456', hash), false);
    assert.equal(verificarSenha('', hash), false);
  });

  test('verificarSenha nunca lança exceção com hash malformado', () => {
    assert.equal(verificarSenha('qualquer', 'nao-e-um-hash-valido'), false);
    assert.equal(verificarSenha('qualquer', null), false);
    assert.equal(verificarSenha('qualquer', undefined), false);
  });
});

const TEM_BANCO = !!process.env.DATABASE_URL;

describe(
  'lib/auth/sessoes — criação/validação/revogação (Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, sessoes;
    const USUARIO_ID = 970;

    before(async () => {
      pool = require('../db/pool');
      sessoes = require('../lib/auth/sessoes');
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, ativo) VALUES ($1, 'sessoes-teste@cerne.local', 'x:x', 'Teste Sessões', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [USUARIO_ID]
      );
    });
    after(async () => {
      await pool.query('DELETE FROM users WHERE id = $1', [USUARIO_ID]); // cascade apaga sessoes_usuario
      await pool.end();
    });

    test('criarSessao + validarSessao: token válido resolve pro usuário certo; token errado nunca resolve', async () => {
      const { token } = await sessoes.criarSessao(USUARIO_ID);
      const resolvido = await sessoes.validarSessao(token);
      assert.equal(resolvido.id, USUARIO_ID);
      assert.equal(resolvido.email, 'sessoes-teste@cerne.local');

      assert.equal(await sessoes.validarSessao('token-que-nunca-existiu'), null);
      assert.equal(await sessoes.validarSessao(null), null);
    });

    test('revogarSessao: token deixa de validar depois (logout de verdade, não só cookie apagado)', async () => {
      const { token } = await sessoes.criarSessao(USUARIO_ID);
      assert.ok(await sessoes.validarSessao(token));
      await sessoes.revogarSessao(token);
      assert.equal(await sessoes.validarSessao(token), null);
    });

    test('usuário desativado (ativo=false): sessão existente para de validar', async () => {
      const { token } = await sessoes.criarSessao(USUARIO_ID);
      await pool.query('UPDATE users SET ativo = FALSE WHERE id = $1', [USUARIO_ID]);
      assert.equal(await sessoes.validarSessao(token), null);
      await pool.query('UPDATE users SET ativo = TRUE WHERE id = $1', [USUARIO_ID]);
    });

    test('nunca guarda o token em texto puro no banco — só um hash', async () => {
      const { token } = await sessoes.criarSessao(USUARIO_ID);
      const { rows } = await pool.query('SELECT token_hash FROM sessoes_usuario WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1', [USUARIO_ID]);
      assert.notEqual(rows[0].token_hash, token);
      assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    });
  }
);
