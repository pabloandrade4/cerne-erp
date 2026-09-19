// Sala dos Agentes — GET /api/agentes-3d/status (19/09/2026, pedido
// explícito do usuário: "agentes de ia pra rodar 24h por dia" + "sala 3d
// onde vai mostrar todos agentes trabalhando"; reescrito no mesmo dia,
// pedido explícito: "as IA não são aquelas... vou te passar quais são" —
// agora só os 5 setores pedidos: Promoções, Ads, Anúncios, Análise de
// Concorrente, SAC). Precisa de Postgres: a rota agora consulta contagens
// reais (ia_decisoes_ads/ia_decisoes_promocoes/radar_alertas) pra mostrar o
// que cada IA está sugerindo AGORA, não só se o scheduler rodou.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;

describe(
  'Rotas HTTP de Sala dos Agentes (GET /api/agentes-3d/status)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
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

    test('devolve exatamente os 5 setores pedidos pelo usuário, cada um com o formato esperado pelo front-end', async () => {
      const res = await fetch(baseUrl + '/api/agentes-3d/status');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.agentes));
      assert.equal(body.agentes.length, 5);

      const ids = body.agentes.map((a) => a.id);
      assert.deepEqual(
        [...ids].sort(),
        ['ads', 'anuncios-ia', 'concorrente-ia', 'promocoes-ia', 'sac-ia'].sort()
      );

      body.agentes.forEach((a) => {
        assert.equal(typeof a.id, 'string');
        assert.equal(typeof a.nome, 'string');
        assert.equal(typeof a.categoria, 'string');
        assert.equal(typeof a.ativo, 'boolean');
        assert.equal(typeof a.emExecucao, 'boolean');
        assert.ok(a.intervaloMs === null || typeof a.intervaloMs === 'number');
        assert.equal(typeof a.resumo, 'string');
        assert.ok(a.resumo.length > 0);
      });
    });

    test('nunca inventa "em execução" — todos começam parados até o próprio scheduler rodar um ciclo', async () => {
      const res = await fetch(baseUrl + '/api/agentes-3d/status');
      const body = await res.json();
      body.agentes.forEach((a) => assert.equal(a.emExecucao, false));
    });

    test('setor "Anúncios" mostra a contagem real de alertas de anúncio (categoria anuncio_%), nunca os alertas financeiros do mesmo Radar', async () => {
      // Lê o total ANTES de inserir (outros arquivos de teste também usam
      // radar_alertas no mesmo banco compartilhado) e verifica o DELTA, pra
      // este teste nunca depender de o banco estar "zerado".
      const pool = require('../db/pool');
      const antes = await fetch(baseUrl + '/api/agentes-3d/status').then((r) => r.json());
      const totalAntes = parseInt(antes.agentes.find((a) => a.id === 'anuncios-ia').resumo, 10) || 0;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES (975, '97570707000199', 'EMPRESA TESTE SALA', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`
      );
      await pool.query(`DELETE FROM radar_alertas WHERE empresa_id = 975`);
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES
           (975, 'anuncio_parado:teste975', 'anuncio_parado', 'atencao', 'Anúncio parado', 'x', 'x', '{}', 'aberto'),
           (975, 'anuncio_prejuizo:teste975', 'anuncio_prejuizo', 'critico', 'Anúncio no prejuízo', 'x', 'x', '{}', 'aberto'),
           (975, 'financeiro_contas_vencidas:teste975', 'financeiro_contas_vencidas', 'critico', 'Contas vencidas', 'x', 'x', '{}', 'aberto')`
      );

      const res = await fetch(baseUrl + '/api/agentes-3d/status');
      const body = await res.json();
      const anuncios = body.agentes.find((a) => a.id === 'anuncios-ia');
      const totalDepois = parseInt(anuncios.resumo, 10);
      assert.equal(totalDepois - totalAntes, 2, 'só os 2 alertas de anuncio_* devem contar, nunca o financeiro');

      await pool.query(`DELETE FROM radar_alertas WHERE empresa_id = 975`);
      await pool.query(`DELETE FROM empresas WHERE id = 975`);
    });
  }
);
