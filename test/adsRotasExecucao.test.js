// Rotas HTTP de execução real de Ads — "Fase E" (19/09/2026, pedido
// explícito do usuário: "eu vou aprovar, aí vai fazer... por enquanto só
// vai precisar da minha permissão"). Cobre: PUT /api/ads/decisoes/:id já
// tentando executar de verdade quando aprovado/alterado (nunca quando
// recusado); GET/PUT /api/ads/config-ia com o novo campo permiteEscritaMl;
// GET /api/ads/status-integracao. Mesmo padrão de Express real + Postgres
// real de test/iaAgentesHub.test.js. A chamada à API do Mercado Livre em
// si é sempre mockada (mlAds.atualizarCampanha).
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 983;
const CONTA_ID = 983;

describe(
  'Rotas HTTP de execução de Ads (PUT /decisoes/:id, /config-ia, /status-integracao) (19/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, cryptoLib, mlAds, server, baseUrl, atualizarCampanhaReal;

    function montarApp() {
      delete require.cache[require.resolve('../routes/ads')];
      const express = require('express');
      const adsRouter = require('../routes/ads');
      const app = express();
      app.use(express.json());
      app.use('/api/ads', adsRouter);
      return app;
    }

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');
      pool = require('../db/pool');
      cryptoLib = require('../lib/crypto');
      mlAds = require('../lib/mlAds');
      atualizarCampanhaReal = mlAds.atualizarCampanha;

      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'98300098000199','EMPRESA TESTE ADS ROTAS EXECUCAO',TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, site_id, escopo_oauth, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,983000001,'LOJA TESTE ROTAS','MLB','offline_access read write',$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa', ultimo_erro=NULL`,
        [CONTA_ID, EMPRESA_ID, cryptoLib.encrypt('token-ok'), cryptoLib.encrypt('refresh-ok')]
      );
      await pool.query(
        `INSERT INTO ads_contas (conta_id, advertiser_id, site_id, disponivel)
         VALUES ($1, 'ADV-983', 'MLB', TRUE)
         ON CONFLICT (conta_id) DO UPDATE SET site_id = EXCLUDED.site_id`,
        [CONTA_ID]
      );
    });

    afterEach(async () => {
      mlAds.atualizarCampanha = atualizarCampanhaReal;
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM config_ads_ia WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      mlAds.atualizarCampanha = atualizarCampanhaReal;
      await pool.query('DELETE FROM ads_contas WHERE conta_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      server.close();
      await pool.end();
    });

    async function criarDecisaoPendente(tipoAcao, valorSugeridoIa) {
      const { rows } = await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','CAMP-9','Campanha Teste',$3,'motivo teste',$4,'pendente')
         RETURNING id`,
        [EMPRESA_ID, CONTA_ID, tipoAcao, JSON.stringify(valorSugeridoIa || {})]
      );
      return rows[0].id;
    }

    test('GET /config-ia sem linha salva: permiteEscritaMl vem false por padrão (nunca liga sozinho)', async () => {
      const res = await fetch(`${baseUrl}/api/ads/config-ia?empresaId=${EMPRESA_ID}`);
      const body = await res.json();
      assert.equal(body.permiteEscritaMl, false);
    });

    test('PUT /config-ia liga permiteEscritaMl sem mexer na margem já salva, e vice-versa', async () => {
      await fetch(`${baseUrl}/api/ads/config-ia`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 12 }) });
      let res = await fetch(`${baseUrl}/api/ads/config-ia?empresaId=${EMPRESA_ID}`);
      let body = await res.json();
      assert.equal(body.margemMinimaPct, 12);
      assert.equal(body.permiteEscritaMl, false);

      await fetch(`${baseUrl}/api/ads/config-ia`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 12, permiteEscritaMl: true }) });
      res = await fetch(`${baseUrl}/api/ads/config-ia?empresaId=${EMPRESA_ID}`);
      body = await res.json();
      assert.equal(body.margemMinimaPct, 12, 'margem continua a mesma');
      assert.equal(body.permiteEscritaMl, true);
    });

    test('GET /status-integracao: escopo sugere escrita (informativo) mas escritaDisponivel só fica true com a trava manual ligada', async () => {
      let res = await fetch(`${baseUrl}/api/ads/status-integracao?empresaId=${EMPRESA_ID}`);
      let body = await res.json();
      assert.equal(body.resumo.escopoSugereEscrita, true, 'escopo_oauth da conta de teste tem "write"');
      assert.equal(body.resumo.escritaDisponivel, false, 'trava manual ainda desligada');

      await fetch(`${baseUrl}/api/ads/config-ia`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 10, permiteEscritaMl: true }) });
      res = await fetch(`${baseUrl}/api/ads/status-integracao?empresaId=${EMPRESA_ID}`);
      body = await res.json();
      assert.equal(body.resumo.escritaDisponivel, true);
      assert.equal(body.contas[0].escritaDisponivel, true);
    });

    test('PUT /decisoes/:id aprovada, com escrita DESLIGADA: fica aprovada, mas não executada (execucaoErro explica por quê)', async () => {
      const id = await criarDecisaoPendente('pausar_campanha');
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const res = await fetch(`${baseUrl}/api/ads/decisoes/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusDecisao: 'aprovada', decididoPor: 'Pablo' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.statusDecisao, 'aprovada', 'a aprovação em si sempre acontece, mesmo sem executar');
      assert.equal(body.executado, false);
      assert.match(body.execucaoErro, /permissão de escrita.*não está liberada/i);
      assert.equal(chamou, false);
    });

    test('PUT /decisoes/:id aprovada, com escrita LIGADA: executa de verdade e devolve o resultado já atualizado na mesma resposta', async () => {
      await fetch(`${baseUrl}/api/ads/config-ia`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 10, permiteEscritaMl: true }) });
      const id = await criarDecisaoPendente('pausar_campanha');
      let payloadRecebido = null;
      mlAds.atualizarCampanha = async (args) => { payloadRecebido = args; return { id: 'CAMP-9', status: 'paused' }; };
      const res = await fetch(`${baseUrl}/api/ads/decisoes/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusDecisao: 'aprovada', decididoPor: 'Pablo' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.statusDecisao, 'aprovada');
      assert.equal(body.executado, true);
      assert.ok(body.executadoEm);
      assert.equal(body.execucaoErro, null);
      assert.equal(payloadRecebido.status, 'paused');
      assert.equal(payloadRecebido.campanhaId, 'CAMP-9');
    });

    test('PUT /decisoes/:id recusada: nunca tenta executar', async () => {
      const id = await criarDecisaoPendente('pausar_campanha');
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const res = await fetch(`${baseUrl}/api/ads/decisoes/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusDecisao: 'recusada', decididoPor: 'Pablo' }),
      });
      const body = await res.json();
      assert.equal(body.statusDecisao, 'recusada');
      assert.equal(chamou, false);
    });

    test('colocar_sku_em_campanha aprovada, mesmo com escrita ligada: nunca executa (é só recomendação)', async () => {
      await fetch(`${baseUrl}/api/ads/config-ia`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 10, permiteEscritaMl: true }) });
      const { rows } = await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, sku, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'anuncio','SKU-9','colocar_sku_em_campanha','motivo teste','{}','pendente')
         RETURNING id`,
        [EMPRESA_ID, CONTA_ID]
      );
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const res = await fetch(`${baseUrl}/api/ads/decisoes/${rows[0].id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusDecisao: 'aprovada', decididoPor: 'Pablo' }),
      });
      const body = await res.json();
      assert.equal(body.executado, false);
      assert.equal(chamou, false);
    });
  }
);
