// Rotas HTTP de /api/ia/daily — Etapa 2 (14/09/2026) — testes de
// INTEGRAÇÃO (Express real + Postgres real, mesmo padrão de
// test/iaGestoraRoutes.test.js). Cobre só o contrato HTTP (validação de
// empresaId, formato da resposta) — a lógica de negócio já é coberta por
// test/dailyCiclo.test.js.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 974;
const CONTA_ID = 974;

describe(
  'Rotas HTTP de /api/ia/daily (Express real + Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;

    function montarApp() {
      delete require.cache[require.resolve('../routes/daily')];
      const express = require('express');
      const dailyRouter = require('../routes/daily');
      const app = express();
      app.use(express.json());
      app.use('/api/ia/daily', dailyRouter);
      return app;
    }

    before(async () => {
      pool = require('../db/pool');
      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97470707000199', 'EMPRESA TESTE ROTAS DAILY', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 974000001, 'LOJA TESTE ROTAS DAILY', 'x', 'x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status = 'ativa'`,
        [CONTA_ID, EMPRESA_ID]
      );
    });

    beforeEach(async () => {
      // ia_correlacoes_diarias precisa sumir ANTES da reunião (FK sem
      // CASCADE) — mesma ordem de test/dailyCiclo.test.js.
      await pool.query('DELETE FROM ia_correlacoes_diarias WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM ia_correlacoes_diarias WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      server.close();
    });

    test('POST /gerar-agora sem empresaId -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/ia/daily/gerar-agora`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });

    test('GET /ultima sem nenhuma Daily rodada -> reuniao null, nunca 404/erro', async () => {
      const res = await fetch(`${baseUrl}/api/ia/daily/ultima?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.reuniao, null);
      assert.deepEqual(body.correlacoes, []);
    });

    test('POST /gerar-agora + GET /ultima: fluxo completo com uma decisão pendente real', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha HTTP','aumentar_orcamento','Margem folgada.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );

      const resGerar = await fetch(`${baseUrl}/api/ia/daily/gerar-agora`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID }),
      });
      assert.equal(resGerar.status, 200);
      const bodyGerar = await resGerar.json();
      assert.equal(bodyGerar.status, 'concluida');
      assert.equal(bodyGerar.achadosPorAgente.ads_performance, 1);

      const resUltima = await fetch(`${baseUrl}/api/ia/daily/ultima?empresaId=${EMPRESA_ID}`);
      const bodyUltima = await resUltima.json();
      assert.equal(bodyUltima.reuniao.status, 'concluida');
      assert.equal(bodyUltima.achadosPorAgente.ads_performance.length, 1);
      assert.equal(bodyUltima.achadosPorAgente.ads_performance[0].tipo, 'oportunidade');
      // "aumentar_orcamento" sozinho (sem achado de Anúncios/Promoções no
      // mesmo SKU) nunca cruza com nenhuma regra do Coordenador — honesto,
      // nunca inventa uma correlação sem base real.
      assert.deepEqual(bodyUltima.correlacoes, []);
    });
  }
);
