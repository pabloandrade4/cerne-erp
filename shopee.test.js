// Testes da integração com a Shopee (Open Platform v2) — Etapa "conectar a
// Shopee ao ERP", 3 passos pedidos pelo usuário: (1) preparar a integração
// (credenciais no backend, nunca no front/GitHub); (2) botão "Conectar
// Shopee" funcionando de verdade (OAuth real, salvar Shop ID/nome/empresa/
// tokens/expiração/status/última atualização); (3) testar e manter a
// conexão (visualizar status, renovar token automaticamente, sobreviver a
// um reinício do servidor). "Não importe pedidos ainda" — nenhum teste
// aqui cobre pedidos/estoque/Ads/financeiro da Shopee (fora do escopo).
//
// Como não há credenciais reais da Shopee Open Platform neste ambiente
// (mesma limitação de sempre — ver docs/05-problemas-conhecidos.md), os
// testes de rede mockam `global.fetch` só para chamadas cujo destino é o
// host da Shopee (contém "shopeemobile.com") — chamadas para o servidor de
// teste local (http://127.0.0.1:PORT) passam pelo fetch real, então os
// testes de rota HTTP abaixo continuam batendo num Express real.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const TEM_BANCO = !!process.env.DATABASE_URL;

// ============================================================
// Parte 1 — lib/shopeeCrypto.js (sem rede, sem banco)
// ============================================================
describe('lib/shopeeCrypto — criptografia dos tokens da Shopee (chave própria, nunca a do Mercado Livre)', () => {
  let shopeeCrypto;
  let envOriginal;

  before(() => {
    envOriginal = { ...process.env };
    shopeeCrypto = require('../lib/shopeeCrypto');
  });
  afterEach(() => { process.env = { ...envOriginal }; });

  test('encrypt/decrypt fazem ida e volta perfeita', () => {
    process.env.SHOPEE_TOKEN_KEY = shopeeCrypto.generateKey();
    const original = 'um-access-token-bem-secreto-da-shopee';
    const enc = shopeeCrypto.encrypt(original);
    assert.notEqual(enc, original); // nunca texto puro
    assert.equal(shopeeCrypto.decrypt(enc), original);
  });

  test('sem SHOPEE_TOKEN_KEY configurada, lança erro claro (nunca silencioso)', () => {
    delete process.env.SHOPEE_TOKEN_KEY;
    assert.throws(() => shopeeCrypto.encrypt('x'), /SHOPEE_TOKEN_KEY não configurada/);
  });

  test('chave é PRÓPRIA da Shopee — configurar só ML_TOKEN_KEY nunca é suficiente', () => {
    delete process.env.SHOPEE_TOKEN_KEY;
    process.env.ML_TOKEN_KEY = require('../lib/crypto').generateKey();
    assert.throws(() => shopeeCrypto.encrypt('x'), /SHOPEE_TOKEN_KEY não configurada/);
  });
});

// ============================================================
// Parte 2 — lib/shopee.js (assinatura HMAC + chamadas HTTP mockadas)
// ============================================================
describe('lib/shopee — assinatura HMAC-SHA256 e chamadas à API (fetch mockado, sem rede real)', () => {
  let shopee;
  let fetchOriginal;

  const PARTNER_ID = '2001234';
  const PARTNER_KEY = 'chave-parceiro-de-teste-bem-secreta';

  before(() => { shopee = require('../lib/shopee'); });
  beforeEach(() => { fetchOriginal = global.fetch; });
  afterEach(() => { global.fetch = fetchOriginal; });

  function hmacHex(baseString) {
    return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
  }

  test('assinatura "public" (partner_id+path+timestamp) bate com o cálculo manual', () => {
    const sign = shopee._assinar({ partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, path: '/api/v2/auth/token/get', timestamp: 1700000000, tipo: 'public' });
    assert.equal(sign, hmacHex(`${PARTNER_ID}/api/v2/auth/token/get1700000000`));
  });

  test('assinatura "shop" (partner_id+path+timestamp+access_token+shop_id) bate com o cálculo manual', () => {
    const sign = shopee._assinar({
      partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, path: '/api/v2/shop/get_shop_info',
      timestamp: 1700000000, tipo: 'shop', accessToken: 'tok123', shopId: '999888',
    });
    assert.equal(sign, hmacHex(`${PARTNER_ID}/api/v2/shop/get_shop_info1700000000tok123999888`));
  });

  test('buildAuthorizationUrl: host correto, partner_id/redirect ecoados sem alteração, sign recalculável a partir do timestamp da própria URL', () => {
    const url = shopee.buildAuthorizationUrl({
      partnerId: PARTNER_ID, partnerKey: PARTNER_KEY,
      redirectUri: 'https://meuerp.com/api/integracoes/shopee/callback?state=abc123',
    });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'partner.shopeemobile.com');
    assert.equal(parsed.pathname, '/api/v2/shop/auth_partner');
    assert.equal(parsed.searchParams.get('partner_id'), PARTNER_ID);
    assert.equal(parsed.searchParams.get('redirect'), 'https://meuerp.com/api/integracoes/shopee/callback?state=abc123');
    const timestamp = Number(parsed.searchParams.get('timestamp'));
    const esperado = hmacHex(`${PARTNER_ID}/api/v2/shop/auth_partner${timestamp}`);
    assert.equal(parsed.searchParams.get('sign'), esperado);
  });

  test('buildAuthorizationUrl respeita SHOPEE_HOST (ambiente de testes da Shopee)', () => {
    const envOriginal = process.env.SHOPEE_HOST;
    process.env.SHOPEE_HOST = 'partner.test-stable.shopeemobile.com';
    try {
      const url = shopee.buildAuthorizationUrl({ partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, redirectUri: 'https://x.com/cb' });
      assert.equal(new URL(url).hostname, 'partner.test-stable.shopeemobile.com');
    } finally {
      if (envOriginal === undefined) delete process.env.SHOPEE_HOST; else process.env.SHOPEE_HOST = envOriginal;
    }
  });

  test('exchangeCodeForToken: POST correto (path/query/body) e devolve access_token/refresh_token/expire_in', async () => {
    let chamada = null;
    global.fetch = async (url, opts) => {
      chamada = { url: String(url), opts };
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT123', refresh_token: 'RT456', expire_in: 14400, shop_id: 999888 }) };
    };
    const data = await shopee.exchangeCodeForToken({ partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, code: 'CODE1', shopId: '999888' });
    assert.equal(data.access_token, 'AT123');
    assert.equal(data.refresh_token, 'RT456');
    assert.equal(data.expire_in, 14400);
    const parsed = new URL(chamada.url);
    assert.equal(parsed.pathname, '/api/v2/auth/token/get');
    assert.equal(opts_method(chamada.opts), 'POST');
    const body = JSON.parse(chamada.opts.body);
    assert.deepEqual(body, { code: 'CODE1', shop_id: 999888, partner_id: Number(PARTNER_ID) });
    // sign da chamada bate com o tipo "public" (token/get ainda não tem access_token)
    const timestamp = Number(parsed.searchParams.get('timestamp'));
    assert.equal(parsed.searchParams.get('sign'), hmacHex(`${PARTNER_ID}/api/v2/auth/token/get${timestamp}`));
  });

  test('refreshAccessToken: POST correto (body com refresh_token) e devolve novo access_token/refresh_token', async () => {
    let chamada = null;
    global.fetch = async (url, opts) => {
      chamada = { url: String(url), opts };
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT-NOVO', refresh_token: 'RT-NOVO', expire_in: 14400 }) };
    };
    const data = await shopee.refreshAccessToken({ partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, refreshToken: 'RT456', shopId: '999888' });
    assert.equal(data.access_token, 'AT-NOVO');
    const parsed = new URL(chamada.url);
    assert.equal(parsed.pathname, '/api/v2/auth/access_token/get');
    const body = JSON.parse(chamada.opts.body);
    assert.deepEqual(body, { refresh_token: 'RT456', shop_id: 999888, partner_id: Number(PARTNER_ID) });
  });

  test('obterInfoLoja: GET com assinatura "shop" (inclui access_token+shop_id) e devolve shop_name/region', async () => {
    let chamada = null;
    global.fetch = async (url) => {
      chamada = String(url);
      return { ok: true, status: 200, json: async () => ({ shop_name: 'Loja Teste BR', region: 'BR' }) };
    };
    const data = await shopee.obterInfoLoja({ partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, accessToken: 'AT123', shopId: '999888' });
    assert.equal(data.shop_name, 'Loja Teste BR');
    const parsed = new URL(chamada);
    assert.equal(parsed.searchParams.get('access_token'), 'AT123');
    assert.equal(parsed.searchParams.get('shop_id'), '999888');
    const timestamp = Number(parsed.searchParams.get('timestamp'));
    assert.equal(parsed.searchParams.get('sign'), hmacHex(`${PARTNER_ID}/api/v2/shop/get_shop_info${timestamp}AT123999888`));
  });

  test('erro de negócio da Shopee (HTTP 200 mas body.error preenchido — "wrong sign" etc.) sempre vira exceção, nunca passa como sucesso', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: 'error_sign', message: 'Wrong sign' }) });
    await assert.rejects(
      () => shopee.exchangeCodeForToken({ partnerId: PARTNER_ID, partnerKey: PARTNER_KEY, code: 'X', shopId: '1' }),
      /Wrong sign/
    );
  });

  function opts_method(opts) { return (opts && opts.method) || 'GET'; }
});

// ============================================================
// Parte 3 — lib/shopeeTokenScheduler.js (Postgres real)
// ============================================================
describe(
  'lib/shopeeTokenScheduler — renovação automática de token (Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool, shopeeCrypto, scheduler;
    let fetchOriginal;
    const EMPRESA_ID = 960;
    const CONTA_PERTO_DE_EXPIRAR = 960; // token vence em 10min — deve ser renovada
    const CONTA_LONGE_DE_EXPIRAR = 961; // token vence em 6h — NÃO deve ser renovada
    const CONTA_ERRO = 962; // status='erro' — nunca entra no ciclo automático

    before(async () => {
      process.env.SHOPEE_PARTNER_ID = '2001234';
      process.env.SHOPEE_PARTNER_KEY = 'chave-parceiro-de-teste-bem-secreta';
      if (!process.env.SHOPEE_TOKEN_KEY) {
        shopeeCrypto = require('../lib/shopeeCrypto');
        process.env.SHOPEE_TOKEN_KEY = shopeeCrypto.generateKey();
      }
      pool = require('../db/pool');
      shopeeCrypto = require('../lib/shopeeCrypto');
      scheduler = require('../lib/shopeeTokenScheduler');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'44444444000191','EMPRESA TESTE SHOPEE SCHEDULER',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID]
      );
      await pool.query('DELETE FROM shopee_contas WHERE id = ANY($1)', [[CONTA_PERTO_DE_EXPIRAR, CONTA_LONGE_DE_EXPIRAR, CONTA_ERRO]]);
      await pool.query(
        `INSERT INTO shopee_contas (id, empresa_id, shopee_shop_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES
           ($1, $2, 900001, $5, $5, now() + interval '10 minutes', 'ativa'),
           ($3, $2, 900002, $5, $5, now() + interval '6 hours', 'ativa'),
           ($4, $2, 900003, $5, $5, now() + interval '10 minutes', 'erro')`,
        [CONTA_PERTO_DE_EXPIRAR, EMPRESA_ID, CONTA_LONGE_DE_EXPIRAR, CONTA_ERRO, shopeeCrypto.encrypt('refresh-token-inicial')]
      );
    });

    beforeEach(() => { fetchOriginal = global.fetch; });
    afterEach(() => { global.fetch = fetchOriginal; });

    after(async () => {
      await pool.query('DELETE FROM shopee_contas WHERE id = ANY($1)', [[CONTA_PERTO_DE_EXPIRAR, CONTA_LONGE_DE_EXPIRAR, CONTA_ERRO]]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      // pool.end() NÃO é chamado aqui — o pool é um singleton (db/pool.js)
      // compartilhado por todo o processo; encerrá-lo aqui derrubaria a
      // conexão para a próxima describe (rotas HTTP, abaixo), que também
      // precisa dele. Só a última describe do arquivo fecha o pool (mesmo
      // padrão já usado em test/iaFerramentas.test.js e test/mlEstoque.test.js
      // quando um arquivo tem mais de um describe de integração).
    });

    test('renovarTokenDaConta: com o token perto de vencer, chama a Shopee, criptografa e grava o novo access/refresh token e a nova expiração', async () => {
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'AT-RENOVADO-1', refresh_token: 'RT-RENOVADO-1', expire_in: 14400 }) });
      const antes = (await pool.query('SELECT * FROM shopee_contas WHERE id=$1', [CONTA_PERTO_DE_EXPIRAR])).rows[0];

      const atualizado = await scheduler.renovarTokenDaConta(CONTA_PERTO_DE_EXPIRAR);

      assert.equal(shopeeCrypto.decrypt(atualizado.access_token_enc), 'AT-RENOVADO-1');
      assert.equal(shopeeCrypto.decrypt(atualizado.refresh_token_enc), 'RT-RENOVADO-1');
      assert.notEqual(atualizado.access_token_enc, antes.access_token_enc);
      assert.equal(atualizado.status, 'ativa');
      assert.ok(new Date(atualizado.token_expires_at).getTime() > Date.now() + 14000 * 1000, 'expiração deveria ter sido empurrada pra ~4h à frente');
      assert.ok(new Date(atualizado.updated_at).getTime() >= new Date(antes.updated_at).getTime(), '"última atualização" precisa refletir a renovação');
    });

    test('renovarTokenDaConta: token ainda longe do vencimento NÃO gasta chamada à Shopee nem rotaciona o refresh_token à toa', async () => {
      let chamou = false;
      global.fetch = async () => { chamou = true; return { ok: true, status: 200, json: async () => ({}) }; };
      const resultado = await scheduler.renovarTokenDaConta(CONTA_LONGE_DE_EXPIRAR);
      assert.equal(chamou, false, 'não deveria ter chamado a API da Shopee — token ainda válido por horas');
      assert.equal(resultado.id, CONTA_LONGE_DE_EXPIRAR);
    });

    test('renovarTokenDaConta: falha na renovação marca status=erro com o motivo, sem derrubar o processo', async () => {
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: 'error_auth', message: 'refresh token expirado' }) });
      await assert.rejects(() => scheduler.renovarTokenDaConta(CONTA_PERTO_DE_EXPIRAR, { forcar: true }), /Não foi possível renovar/);
      const { rows } = await pool.query('SELECT status, ultimo_erro FROM shopee_contas WHERE id=$1', [CONTA_PERTO_DE_EXPIRAR]);
      assert.equal(rows[0].status, 'erro');
      assert.match(rows[0].ultimo_erro, /refresh token expirado/);
      // devolve pro estado "ativa" de novo pros próximos testes do arquivo
      await pool.query(`UPDATE shopee_contas SET status='ativa', token_expires_at = now() + interval '10 minutes' WHERE id=$1`, [CONTA_PERTO_DE_EXPIRAR]);
    });

    test('executarCicloDeRenovacao: renova só quem está perto de vencer, nunca conta com status=erro, e um erro isolado não impede as demais nem os próximos ciclos', async () => {
      const chamadas = [];
      const status = await scheduler.executarCicloDeRenovacao({
        renovarTokenDaContaFn: async (contaId) => {
          chamadas.push(contaId);
          if (contaId === CONTA_PERTO_DE_EXPIRAR) throw new Error('falha simulada nesta conta');
        },
      });
      assert.ok(chamadas.includes(CONTA_PERTO_DE_EXPIRAR), 'conta perto de vencer deveria ter sido chamada');
      assert.ok(!chamadas.includes(CONTA_LONGE_DE_EXPIRAR), 'conta longe do vencimento não deveria ter sido chamada neste ciclo');
      assert.ok(!chamadas.includes(CONTA_ERRO), 'conta com status=erro nunca entra no ciclo automático');
      assert.equal(status.ultimoCicloOk, false); // por causa da falha simulada acima
      assert.ok(status.contasComErro.some((c) => c.contaId === CONTA_PERTO_DE_EXPIRAR));

      // ciclo seguinte roda normalmente (a falha do ciclo anterior não trava nada)
      const status2 = await scheduler.executarCicloDeRenovacao({ renovarTokenDaContaFn: async () => {} });
      assert.equal(status2.ultimoCicloOk, true);
    });

    test('"reconexão após reiniciar o servidor": módulo recarregado do zero (simulando um novo processo Node) continua renovando a partir só do que está no Postgres — nenhum estado em memória é necessário', async () => {
      delete require.cache[require.resolve('../lib/shopeeTokenScheduler')];
      const schedulerNovo = require('../lib/shopeeTokenScheduler');

      await pool.query(`UPDATE shopee_contas SET status='ativa', token_expires_at = now() + interval '10 minutes' WHERE id=$1`, [CONTA_PERTO_DE_EXPIRAR]);
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'AT-APOS-RESTART', refresh_token: 'RT-APOS-RESTART', expire_in: 14400 }) });

      const atualizado = await schedulerNovo.renovarTokenDaConta(CONTA_PERTO_DE_EXPIRAR);
      assert.equal(shopeeCrypto.decrypt(atualizado.access_token_enc), 'AT-APOS-RESTART');
    });
  }
);

// ============================================================
// Parte 4 — routes/shopee.js (HTTP real via Express + Postgres real)
// ============================================================
describe(
  'Rotas HTTP de /api/integracoes/shopee (Express real + Postgres real, API da Shopee mockada)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl, shopeeCrypto;
    let fetchOriginal;
    const EMPRESA_ID = 965;
    const EMPRESA_INATIVA_ID = 966;

    before(async () => {
      process.env.SHOPEE_PARTNER_ID = '2001234';
      process.env.SHOPEE_PARTNER_KEY = 'chave-parceiro-de-teste-bem-secreta';
      shopeeCrypto = require('../lib/shopeeCrypto');
      if (!process.env.SHOPEE_TOKEN_KEY) process.env.SHOPEE_TOKEN_KEY = shopeeCrypto.generateKey();

      pool = require('../db/pool');
      const express = require('express');
      const shopeeRouter = require('../routes/shopee');
      const app = express();
      app.use(express.json());
      app.use('/api/integracoes/shopee', shopeeRouter);
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'55555555000191','EMPRESA TESTE ROTAS SHOPEE',TRUE), ($2,'55555555000272','EMPRESA INATIVA ROTAS SHOPEE',FALSE)
         ON CONFLICT (id) DO UPDATE SET ativo = EXCLUDED.ativo`,
        [EMPRESA_ID, EMPRESA_INATIVA_ID]
      );
      await pool.query('DELETE FROM shopee_contas WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM shopee_oauth_states WHERE empresa_id = ANY($1)', [[EMPRESA_ID, EMPRESA_INATIVA_ID]]);
    });

    beforeEach(() => { fetchOriginal = global.fetch; });
    afterEach(() => { global.fetch = fetchOriginal; });

    after(async () => {
      await pool.query('DELETE FROM shopee_contas WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM shopee_oauth_states WHERE empresa_id = ANY($1)', [[EMPRESA_ID, EMPRESA_INATIVA_ID]]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ID, EMPRESA_INATIVA_ID]]);
      server.close();
      await pool.end();
    });

    // fetch "roteador": chamadas pro host da Shopee usam o mock; tudo mais
    // (o próprio servidor de teste local) passa pro fetch real.
    function mockShopeeFetch(handler) {
      global.fetch = async (url, opts) => {
        const urlStr = String(url);
        if (urlStr.includes('shopeemobile.com')) return handler(urlStr, opts);
        return fetchOriginal(url, opts);
      };
    }

    test('GET /config-status reflete exatamente se as 3 variáveis de ambiente estão presentes', async () => {
      const semKey = process.env.SHOPEE_TOKEN_KEY;
      delete process.env.SHOPEE_TOKEN_KEY;
      let body = await fetch(baseUrl + '/api/integracoes/shopee/config-status').then((r) => r.json());
      assert.equal(body.configurado, false);
      process.env.SHOPEE_TOKEN_KEY = semKey;
      body = await fetch(baseUrl + '/api/integracoes/shopee/config-status').then((r) => r.json());
      assert.equal(body.configurado, true);
    });

    test('GET /conectar sem empresaId redireciona com erro claro, nunca inicia o OAuth', async () => {
      const res = await fetch(baseUrl + '/api/integracoes/shopee/conectar', { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = decodeURIComponent(res.headers.get('location'));
      assert.match(location, /shopee=error/);
      assert.match(location, /Selecione uma empresa/);
    });

    test('GET /conectar com empresa INATIVA nunca conecta', async () => {
      const res = await fetch(baseUrl + '/api/integracoes/shopee/conectar?empresaId=' + EMPRESA_INATIVA_ID, { redirect: 'manual' });
      const location = decodeURIComponent(res.headers.get('location'));
      assert.match(location, /empresa ativa/);
    });

    test('GET /conectar com empresa ativa redireciona pra Shopee (auth_partner) e grava o state no banco', async () => {
      const res = await fetch(baseUrl + '/api/integracoes/shopee/conectar?empresaId=' + EMPRESA_ID, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location');
      assert.match(location, /^https:\/\/partner\.shopeemobile\.com\/api\/v2\/shop\/auth_partner\?/);
      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get('partner_id'), process.env.SHOPEE_PARTNER_ID);
      const redirectParam = parsed.searchParams.get('redirect');
      assert.match(redirectParam, /\/api\/integracoes\/shopee\/callback\?state=/);

      const state = new URL(redirectParam).searchParams.get('state');
      const { rows } = await pool.query('SELECT * FROM shopee_oauth_states WHERE state=$1', [state]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].empresa_id, EMPRESA_ID);
    });

    test('GET /callback: troca o code, salva Shop ID/nome/empresa/tokens/expiração/status no banco (criptografado) e redireciona com sucesso', async () => {
      // 1) inicia o fluxo de verdade pra ter um state válido no banco
      const conectarRes = await fetch(baseUrl + '/api/integracoes/shopee/conectar?empresaId=' + EMPRESA_ID, { redirect: 'manual' });
      const authUrl = new URL(conectarRes.headers.get('location'));
      const redirectUri = authUrl.searchParams.get('redirect');
      const state = new URL(redirectUri).searchParams.get('state');

      mockShopeeFetch(async (urlStr) => {
        const parsed = new URL(urlStr);
        if (parsed.pathname === '/api/v2/auth/token/get') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'AT-CALLBACK-1', refresh_token: 'RT-CALLBACK-1', expire_in: 14400 }) };
        }
        if (parsed.pathname === '/api/v2/shop/get_shop_info') {
          return { ok: true, status: 200, json: async () => ({ shop_name: 'Loja Callback BR', region: 'BR' }) };
        }
        throw new Error('endpoint da Shopee inesperado no teste: ' + parsed.pathname);
      });

      const callbackUrl = `${baseUrl}/api/integracoes/shopee/callback?state=${encodeURIComponent(state)}&code=CODE-TESTE&shop_id=777001`;
      const res = await fetch(callbackUrl, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location');
      assert.match(location, /shopee=success/);

      // state é de uso único
      const { rows: stateRows } = await pool.query('SELECT * FROM shopee_oauth_states WHERE state=$1', [state]);
      assert.equal(stateRows.length, 0);

      const { rows } = await pool.query('SELECT * FROM shopee_contas WHERE shopee_shop_id=777001');
      assert.equal(rows.length, 1);
      const conta = rows[0];
      assert.equal(conta.empresa_id, EMPRESA_ID);
      assert.equal(conta.shop_name, 'Loja Callback BR');
      assert.equal(conta.region, 'BR');
      assert.equal(conta.status, 'ativa');
      assert.equal(shopeeCrypto.decrypt(conta.access_token_enc), 'AT-CALLBACK-1');
      assert.equal(shopeeCrypto.decrypt(conta.refresh_token_enc), 'RT-CALLBACK-1');
      assert.ok(new Date(conta.token_expires_at).getTime() > Date.now());
      assert.ok(conta.updated_at);
    });

    test('GET /callback com state inválido/expirado nunca cria conta nem quebra', async () => {
      mockShopeeFetch(async () => { throw new Error('não deveria chamar a Shopee sem state válido'); });
      const res = await fetch(`${baseUrl}/api/integracoes/shopee/callback?state=state-que-nao-existe&code=X&shop_id=1`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /shopee=error/);
    });

    test('reconectar a MESMA loja (mesmo shop_id) nunca duplica linha — atualiza (upsert), mesma regra do Mercado Livre', async () => {
      const conectarRes = await fetch(baseUrl + '/api/integracoes/shopee/conectar?empresaId=' + EMPRESA_ID, { redirect: 'manual' });
      const redirectUri = new URL(conectarRes.headers.get('location')).searchParams.get('redirect');
      const state = new URL(redirectUri).searchParams.get('state');

      mockShopeeFetch(async (urlStr) => {
        const parsed = new URL(urlStr);
        if (parsed.pathname === '/api/v2/auth/token/get') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'AT-RECONECTOU', refresh_token: 'RT-RECONECTOU', expire_in: 14400 }) };
        }
        return { ok: true, status: 200, json: async () => ({ shop_name: 'Loja Callback BR (atualizada)', region: 'BR' }) };
      });

      await fetch(`${baseUrl}/api/integracoes/shopee/callback?state=${encodeURIComponent(state)}&code=CODE-2&shop_id=777001`, { redirect: 'manual' });

      const { rows } = await pool.query('SELECT * FROM shopee_contas WHERE shopee_shop_id=777001');
      assert.equal(rows.length, 1, 'nunca deveria existir 2 linhas pro mesmo shop_id');
      assert.equal(shopeeCrypto.decrypt(rows[0].access_token_enc), 'AT-RECONECTOU');
      assert.equal(rows[0].shop_name, 'Loja Callback BR (atualizada)');
    });

    test('POST /:id/renovar-token força a renovação mesmo com o token ainda válido (botão manual)', async () => {
      const { rows } = await pool.query('SELECT id FROM shopee_contas WHERE shopee_shop_id=777001');
      const contaId = rows[0].id;
      await pool.query(`UPDATE shopee_contas SET token_expires_at = now() + interval '3 hours' WHERE id=$1`, [contaId]);

      mockShopeeFetch(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'AT-MANUAL', refresh_token: 'RT-MANUAL', expire_in: 14400 }) }));

      const res = await fetch(`${baseUrl}/api/integracoes/shopee/${contaId}/renovar-token`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.conta.id, contaId);

      const { rows: novo } = await pool.query('SELECT access_token_enc FROM shopee_contas WHERE id=$1', [contaId]);
      assert.equal(shopeeCrypto.decrypt(novo[0].access_token_enc), 'AT-MANUAL');
    });
  }
);
