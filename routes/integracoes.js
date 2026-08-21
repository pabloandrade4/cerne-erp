// Integração real com o Mercado Livre: conectar via OAuth (PKCE), consultar
// status da conexão e disparar sincronização de pedidos. Não implementa
// Shopee nem nenhum outro marketplace nesta etapa.
const express = require('express');
const pool = require('../db/pool');
const { encrypt } = require('../lib/crypto');
const { generateState, generatePkce } = require('../lib/pkce');
const ml = require('../lib/mercadolivre');
const { sincronizarConta } = require('../lib/mlSync');

const router = express.Router();

function getRedirectUri(req) {
  return process.env.ML_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/integracoes/mercadolivre/callback`;
}

function mlConfigurado() {
  return Boolean(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET && process.env.ML_TOKEN_KEY);
}

function serializeConta(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    mlUserId: String(row.ml_user_id),
    nickname: row.nickname,
    email: row.email,
    siteId: row.site_id,
    status: row.status,
    ultimoErro: row.ultimo_erro,
    tokenExpiraEm: row.token_expires_at,
    ultimaSincronizacaoEm: row.ultima_sincronizacao_em,
    criadoEm: row.created_at,
  };
}

// GET /api/integracoes/mercadolivre/config-status — se o app do ML já foi configurado no servidor
router.get('/config-status', (req, res) => {
  res.json({ configurado: mlConfigurado() });
});

// GET /api/integracoes/mercadolivre — lista contas conectadas (opcionalmente por empresa)
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    const where = empresaId ? 'WHERE empresa_id = $1' : '';
    const params = empresaId ? [empresaId] : [];
    const { rows } = await pool.query(`SELECT * FROM ml_contas ${where} ORDER BY created_at DESC`, params);
    res.json({ contas: rows.map(serializeConta) });
  } catch (err) { next(err); }
});

// GET /api/integracoes/mercadolivre/conectar?empresaId=ID — inicia o OAuth (redireciona pro Mercado Livre)
router.get('/conectar', async (req, res) => {
  const { empresaId } = req.query;
  const redirectComErro = (msg) => res.redirect('/#marketplaces?ml=error&msg=' + encodeURIComponent(msg));

  if (!mlConfigurado()) {
    return redirectComErro('Integração com o Mercado Livre ainda não foi configurada neste ambiente (faltam credenciais do app).');
  }
  if (!empresaId) {
    return redirectComErro('Selecione uma empresa antes de conectar o Mercado Livre.');
  }

  try {
    const { rows } = await pool.query('SELECT id, ativo FROM empresas WHERE id = $1', [empresaId]);
    if (!rows.length) return redirectComErro('Empresa não encontrada.');
    if (!rows[0].ativo) return redirectComErro('Só é possível conectar o Mercado Livre a uma empresa ativa.');

    const state = generateState();
    const { verifier, challenge } = generatePkce();
    await pool.query(
      'INSERT INTO ml_oauth_states (state, empresa_id, code_verifier) VALUES ($1,$2,$3)',
      [state, empresaId, verifier]
    );

    const url = ml.buildAuthorizationUrl({
      clientId: process.env.ML_CLIENT_ID,
      redirectUri: getRedirectUri(req),
      state,
      codeChallenge: challenge,
    });
    res.redirect(url);
  } catch (err) {
    console.error('[integracoes/mercadolivre/conectar]', err);
    redirectComErro('Não foi possível iniciar a conexão com o Mercado Livre.');
  }
});

// GET /api/integracoes/mercadolivre/callback — volta do Mercado Livre com ?code&state
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const redirectComErro = (msg) => res.redirect('/#marketplaces?ml=error&msg=' + encodeURIComponent(msg));

  if (error) {
    return redirectComErro(errorDescription || 'Autorização cancelada ou negada no Mercado Livre.');
  }
  if (!code || !state) {
    return redirectComErro('Retorno inválido do Mercado Livre.');
  }

  try {
    const { rows: stateRows } = await pool.query('SELECT * FROM ml_oauth_states WHERE state = $1', [state]);
    if (!stateRows.length) return redirectComErro('Sessão de conexão expirada ou inválida. Tente conectar novamente.');
    const { empresa_id: empresaId, code_verifier: codeVerifier } = stateRows[0];
    await pool.query('DELETE FROM ml_oauth_states WHERE state = $1', [state]); // uso único

    const tokenData = await ml.exchangeCodeForToken({
      clientId: process.env.ML_CLIENT_ID,
      clientSecret: process.env.ML_CLIENT_SECRET,
      code,
      redirectUri: getRedirectUri(req),
      codeVerifier,
    });

    const me = await ml.apiGet('/users/me', tokenData.access_token);

    const { rows } = await pool.query(
      `INSERT INTO ml_contas (
         empresa_id, ml_user_id, nickname, email, site_id,
         access_token_enc, refresh_token_enc, token_expires_at, status, ultimo_erro, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ativa',NULL, now())
       ON CONFLICT (ml_user_id) DO UPDATE SET
         empresa_id = EXCLUDED.empresa_id,
         nickname = EXCLUDED.nickname,
         email = EXCLUDED.email,
         site_id = EXCLUDED.site_id,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         token_expires_at = EXCLUDED.token_expires_at,
         status = 'ativa',
         ultimo_erro = NULL,
         updated_at = now()
       RETURNING id`,
      [
        empresaId,
        me.id,
        me.nickname || null,
        me.email || null,
        me.site_id || null,
        encrypt(tokenData.access_token),
        encrypt(tokenData.refresh_token),
        new Date(Date.now() + tokenData.expires_in * 1000),
      ]
    );

    res.redirect('/#marketplaces?ml=success&conta=' + rows[0].id);
  } catch (err) {
    console.error('[integracoes/mercadolivre/callback]', err);
    redirectComErro('Não foi possível concluir a conexão com o Mercado Livre.');
  }
});

// POST /api/integracoes/mercadolivre/:id/sincronizar — importa/atualiza os pedidos dessa conta
router.post('/:id/sincronizar', async (req, res, next) => {
  try {
    const resultado = await sincronizarConta(req.params.id);
    res.json(resultado);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
