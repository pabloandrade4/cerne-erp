// Sala dos Agentes — GET /api/agentes-3d/status (19/09/2026, pedido
// explícito do usuário: "agentes de ia pra rodar 24h por dia" + "sala 3d
// onde vai mostrar todos agentes trabalhando"). Este teste NÃO precisa de
// Postgres: a rota só lê o estado em memória que cada scheduler já expõe
// (obterStatus*()), nunca consulta o banco — mesmo espírito de
// test/syncScheduler.test.js (schedulers testados sem depender de conta
// real do Mercado Livre/Shopee).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

describe('Rotas HTTP de Sala dos Agentes (GET /api/agentes-3d/status)', () => {
  let server, baseUrl;

  before(async () => {
    const express = require('express');
    const agentes3dRouter = require('../routes/agentes3d');
    const app = express();
    app.use('/api/agentes-3d', agentes3dRouter);
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('devolve exatamente os 10 agentes reais, cada um com o formato esperado pelo front-end', async () => {
    const res = await fetch(baseUrl + '/api/agentes-3d/status');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.agentes));
    assert.equal(body.agentes.length, 10);

    const ids = body.agentes.map((a) => a.id);
    assert.deepEqual(
      [...ids].sort(),
      ['ads', 'daily', 'despesas-fixas', 'ml-estoque', 'ml-pedidos', 'promocoes-ia', 'radar-ia', 'sac-ia', 'shopee-pedidos', 'shopee-token'].sort()
    );

    body.agentes.forEach((a) => {
      assert.equal(typeof a.id, 'string');
      assert.equal(typeof a.nome, 'string');
      assert.equal(typeof a.categoria, 'string');
      assert.equal(typeof a.ativo, 'boolean');
      assert.equal(typeof a.emExecucao, 'boolean');
      assert.equal(typeof a.intervaloMs, 'number');
      // Nenhum ciclo rodou ainda neste processo de teste — nunca inventa um
      // valor: ultimaExecucaoEm/ultimoCicloOk continuam null, e o resumo
      // precisa dizer isso explicitamente (nunca um texto genérico).
      assert.equal(a.ultimaExecucaoEm, null);
      assert.equal(a.ultimoCicloOk, null);
      assert.equal(typeof a.resumo, 'string');
      assert.ok(a.resumo.length > 0);
    });
  });

  test('nunca inventa "em execução" — todos começam parados até o próprio scheduler rodar um ciclo', async () => {
    const res = await fetch(baseUrl + '/api/agentes-3d/status');
    const body = await res.json();
    body.agentes.forEach((a) => assert.equal(a.emExecucao, false));
  });
});
