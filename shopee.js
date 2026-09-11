// Integração real com a Shopee (Open Platform v2): conectar via OAuth,
// consultar status da(s) loja(s) conectada(s) e renovar token. Por pedido
// explícito do usuário, esta etapa NÃO importa pedidos, estoque, Ads nem
// financeiro da Shopee — só autorização + status da conexão. Mesmo desenho
// de routes/integracoes.js (Mercado Livre), sem duplicar nenhuma regra dele.
const express = require('express');
const pool = require('../db/pool');
const { encrypt } = require('../lib/shopeeCrypto');
const shopee = require('../lib/shopee');
const { generateState } = require('../lib/pkce'); // reaproveitado (geração de state é genérica, não é específica de PKCE/Mercado Livre)
const { obterStatusRenovacao, renovarTokenDaConta } = require('../lib/shopeeTokenScheduler');

const router = express.Router();

function getRedirectUri(req) {
  return process.env.SHOPEE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/integracoes/shopee/callback`;
}

function shopeeConfigurado() {
  return Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY && process.env.SHOPEE_TOKEN_KEY);
}

function serializeConta(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    shopId: String(row.shopee_shop_id),
    shopName: row.shop_name,
    region: row.region,
    status: row.status,
    ultimoErro: row.ultimo_erro,
    tokenExpiraEm: row.token_expires_at,
    ultimaSincronizacaoEm: row.ultima_sincronizacao_em,
    atualizadoEm: row.updated_at,
    criadoEm: row.created_at,
  };
}

// GET /api/integracoes/shopee/config-status — se o app da Shopee já foi configurado no servidor
router.get('/config-status', (req, res) => {
  res.json({ configurado: shopeeConfigurado() });
});

// GET /api/integracoes/shopee — lista lojas conectadas (opcionalmente por empresa)
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    const where = empresaId ? 'WHERE empresa_id = $1' : '';
    const params = empresaId ? [empresaId] : [];
    const { rows } = await pool.query(`SELECT * FROM shopee_contas ${where} ORDER BY created_at DESC`, params);
    res.json({ contas: rows.map(serializeConta) });
  } catch (err) { next(err); }
});

// GET /api/integracoes/shopee/status-renovacao — estado (em memória do
// servidor) do ciclo automático de renovação de token — mesmo espírito do
// GET /api/integracoes/mercadolivre/status-automatico, mas aqui é só
// renovação de token (não há sincronização de pedidos da Shopee ainda).
router.get('/status-renovacao', (req, res) => {
  const s = obterStatusRenovacao();
  res.json(s);
});

// GET /api/integracoes/shopee/conectar?empresaId=ID — inicia o OAuth (redireciona pra Shopee)
router.get('/conectar', async (req, res) => {
  const { empresaId } = req.query;
  const redirectComErro = (msg) => res.redirect('/#marketplaces?shopee=error&msg=' + encodeURIComponent(msg));

  if (!shopeeConfigurado()) {
    return redirectComErro('Integração com a Shopee ainda não foi configurada neste ambiente (faltam credenciais do app).');
  }
  if (!empresaId) {
    return redirectComErro('Selecione uma empresa antes de conectar a Shopee.');
  }

  try {
    const { rows } = await pool.query('SELECT id, ativo FROM empresas WHERE id = $1', [empresaId]);
    if (!rows.length) return redirectComErro('Empresa não encontrada.');
    if (!rows[0].ativo) return redirectComErro('Só é possível conectar a Shopee a uma empresa ativa.');

    const state = generateState();
    await pool.query(
      'INSERT INTO shopee_oauth_states (state, empresa_id) VALUES ($1,$2)',
      [state, empresaId]
    );

    // A Shopee não tem parâmetro `state` nativo na URL de autorização — o
    // state vai embutido na própria redirectUri (ver lib/shopee.js).
    const redirectUri = `${getRedirectUri(req)}?state=${encodeURIComponent(state)}`;
    const url = shopee.buildAuthorizationUrl({
      partnerId: process.env.SHOPEE_PARTNER_ID,
      partnerKey: process.env.SHOPEE_PARTNER_KEY,
      redirectUri,
    });
    res.redirect(url);
  } catch (err) {
    console.error('[integracoes/shopee/conectar]', err);
    redirectComErro('Não foi possível iniciar a conexão com a Shopee.');
  }
});

// GET /api/integracoes/shopee/callback — volta da Shopee com ?state&code&shop_id
router.get('/callback', async (req, res) => {
  const { code, state, shop_id: shopId } = req.query;
  const redirectComErro = (msg) => res.redirect('/#marketplaces?shopee=error&msg=' + encodeURIComponent(msg));

  if (!code || !state || !shopId) {
    return redirectComErro('Retorno inválido da Shopee.');
  }

  try {
    const { rows: stateRows } = await pool.query('SELECT * FROM shopee_oauth_states WHERE state = $1', [state]);
    if (!stateRows.length) return redirectComErro('Sessão de conexão expirada ou inválida. Tente conectar novamente.');
    const { empresa_id: empresaId } = stateRows[0];
    await pool.query('DELETE FROM shopee_oauth_states WHERE state = $1', [state]); // uso único

    const tokenData = await shopee.exchangeCodeForToken({
      partnerId: process.env.SHOPEE_PARTNER_ID,
      partnerKey: process.env.SHOPEE_PARTNER_KEY,
      code,
      shopId,
    });

    // Nome/região da loja são "quando disponível" (pedido do usuário) —
    // se essa chamada extra falhar por qualquer motivo, a conexão ainda é
    // salva (o essencial: tokens + shop_id), só sem nome/região por ora.
    let shopName = null;
    let region = null;
    try {
      const info = await shopee.obterInfoLoja({
        partnerId: process.env.SHOPEE_PARTNER_ID,
        partnerKey: process.env.SHOPEE_PARTNER_KEY,
        accessToken: tokenData.access_token,
        shopId,
      });
      shopName = info.shop_name || null;
      region = info.region || null;
    } catch (infoErr) {
      console.warn('[integracoes/shopee/callback] não foi possível obter nome/região da loja agora:', infoErr.message);
    }

    const { rows } = await pool.query(
      `INSERT INTO shopee_contas (
         empresa_id, shopee_shop_id, shop_name, region,
         access_token_enc, refresh_token_enc, token_expires_at, status, ultimo_erro, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ativa',NULL, now())
       ON CONFLICT (shopee_shop_id) DO UPDATE SET
         empresa_id = EXCLUDED.empresa_id,
         shop_name = EXCLUDED.shop_name,
         region = EXCLUDED.region,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         token_expires_at = EXCLUDED.token_expires_at,
         status = 'ativa',
         ultimo_erro = NULL,
         updated_at = now()
       RETURNING id`,
      [
        empresaId,
        shopId,
        shopName,
        region,
        encrypt(tokenData.access_token),
        encrypt(tokenData.refresh_token),
        new Date(Date.now() + tokenData.expire_in * 1000),
      ]
    );

    res.redirect('/#marketplaces?shopee=success&conta=' + rows[0].id);
  } catch (err) {
    console.error('[integracoes/shopee/callback]', err);
    redirectComErro('Não foi possível concluir a conexão com a Shopee.');
  }
});

// POST /api/integracoes/shopee/:id/renovar-token — renova manualmente o
// token de uma loja (botão de emergência, mesmo espírito do "Sincronizar
// agora" do Mercado Livre — mas aqui a renovação já acontece sozinha, ver
// lib/shopeeTokenScheduler.js).
router.post('/:id/renovar-token', async (req, res, next) => {
  try {
    const conta = await renovarTokenDaConta(req.params.id, { forcar: true });
    res.json({ conta: serializeConta(conta) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
