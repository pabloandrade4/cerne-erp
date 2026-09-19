// Rotas GET/PUT /api/promocoes/config — cobertura focada no campo
// margem_conforto_pct (15/09/2026, pedido explícito do usuário: "voce deve
// me trazer promoções do mesmo valor com uma margem igual ou valores
// abaixo com uma margem um pouco menor mas respeitando a margem minima").
// Mesmo padrão de test/sac.test.js (Express real + Postgres real). Não
// existia cobertura de rota nenhuma pra config_promocoes antes desta
// mudança — esta suíte cobre só o que foi tocado agora, não o arquivo
// inteiro (diagnóstico/análise já têm outras suítes).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 980;

describe(
  'GET/PUT /api/promocoes/config — margem_conforto_pct',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;

    function montarApp() {
      delete require.cache[require.resolve('../routes/promocoes')];
      const express = require('express');
      const promocoesRouter = require('../routes/promocoes');
      const app = express();
      app.use(express.json());
      app.use('/api/promocoes', promocoesRouter);
      return app;
    }

    before(async () => {
      pool = require('../db/pool');
      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID, String(98000000000000 + EMPRESA_ID).slice(0, 14), '[TESTE AUTOMATIZADO] Empresa Config Promoções']
      );
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM config_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM config_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      server.close();
    });

    test('GET sem configuração salva ainda -> devolve o padrão com margemConfortoPct = 0 (desligado)', async () => {
      const res = await fetch(`${baseUrl}/api/promocoes/config?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.margemMinimaPct, 14);
      assert.equal(body.margemConfortoPct, 0);
    });

    test('PUT salva margemConfortoPct, e o GET seguinte devolve o valor salvo (nunca o padrão)', async () => {
      const put = await fetch(`${baseUrl}/api/promocoes/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 14, margemConfortoPct: 5 }),
      });
      assert.equal(put.status, 200);
      const putBody = await put.json();
      assert.equal(putBody.margemConfortoPct, 5);

      const get = await fetch(`${baseUrl}/api/promocoes/config?empresaId=${EMPRESA_ID}`);
      const getBody = await get.json();
      assert.equal(getBody.margemConfortoPct, 5);
    });

    test('PUT sem informar margemConfortoPct preserva o valor já salvo (nunca reseta pra 0 sem querer)', async () => {
      await fetch(`${baseUrl}/api/promocoes/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, margemConfortoPct: 7 }),
      });
      const put2 = await fetch(`${baseUrl}/api/promocoes/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, margemMinimaPct: 20 }), // não manda margemConfortoPct de novo
      });
      const body2 = await put2.json();
      assert.equal(body2.margemMinimaPct, 20);
      assert.equal(body2.margemConfortoPct, 7); // preservado
    });

    test('PUT com margemConfortoPct fora de 0-100 -> 400, nunca salva um valor inválido', async () => {
      const res = await fetch(`${baseUrl}/api/promocoes/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, margemConfortoPct: 150 }),
      });
      assert.equal(res.status, 400);
    });
  }
);
