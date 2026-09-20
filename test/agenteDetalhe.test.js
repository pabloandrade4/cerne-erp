// "Detalhe do Agente" — 20/09/2026, pedido explícito do usuário: "quando
// clicar em cima do agente de ia, quero ver oque ele esta fazendo, oque
// tenho pra aprovar..., oque ele fez e a melhora que ele teve". Testes de
// INTEGRAÇÃO (Postgres real) pra lib/ia/agenteDetalhe.js e a rota
// GET /api/ia-agentes/:codigo/detalhe.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 985;
const CONTA_ID = 985;

describe(
  'lib/ia/agenteDetalhe + GET /api/ia-agentes/:codigo/detalhe (20/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, agenteDetalhe, server, baseUrl;

    function montarApp() {
      delete require.cache[require.resolve('../routes/iaAgentes')];
      const express = require('express');
      const iaAgentesRouter = require('../routes/iaAgentes');
      const app = express();
      app.use(express.json());
      app.use('/api/ia-agentes', iaAgentesRouter);
      return app;
    }

    before(async () => {
      pool = require('../db/pool');
      agenteDetalhe = require('../lib/ia/agenteDetalhe');
      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '98500985000199', 'EMPRESA TESTE DETALHE AGENTE', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 985000001, 'LOJA TESTE DETALHE', 'x', 'x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status = 'ativa'`,
        [CONTA_ID, EMPRESA_ID]
      );
    });

    afterEach(async () => {
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM sac_atendimentos WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      server.close();
    });

    test('rota rejeita código de agente desconhecido -> 404 (nunca aceita string arbitrária da URL)', async () => {
      const res = await fetch(`${baseUrl}/api/ia-agentes/agente-inventado/detalhe?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 404);
    });

    test('rota sem empresaId -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/ia-agentes/ads_performance/detalhe`);
      assert.equal(res.status, 400);
    });

    test('ads_performance: statusAtual vem do adsScheduler real (nunca null pra um agente cadastrado)', async () => {
      const detalhe = await agenteDetalhe.obterDetalheAgente('ads_performance', EMPRESA_ID);
      assert.ok(detalhe.statusAtual);
      assert.equal(typeof detalhe.statusAtual.ativo, 'boolean');
      assert.equal(typeof detalhe.statusAtual.intervaloMs, 'number');
    });

    test('ads_performance: pendentes conta só status_decisao=pendente da própria empresa', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha X','aumentar_orcamento','x','{}','pendente'),
                ($1,$2,'campanha','C2','Campanha Y','pausar_campanha','x','{}','aprovada')`,
        [EMPRESA_ID, CONTA_ID]
      );
      const { pendentes } = await agenteDetalhe.obterDetalheAgente('ads_performance', EMPRESA_ID);
      assert.equal(pendentes.temFluxoDeAprovacao, true);
      assert.equal(pendentes.total, 1);
    });

    test('anuncios_radar: nunca tem pendente (é só observação) — mesmo com alertas abertos', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'anuncio_parado:teste985', 'anuncio_parado', 'atencao', 'Anúncio parado', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const { pendentes } = await agenteDetalhe.obterDetalheAgente('anuncios_radar', EMPRESA_ID);
      assert.equal(pendentes.temFluxoDeAprovacao, false);
      assert.equal(pendentes.total, 0);
    });

    test('historico do agente "anuncios_radar" mostra o alerta anuncio_% — antes ficava escondido sob o código genérico "radar"', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'anuncio_parado:teste985b', 'anuncio_parado', 'atencao', 'Anúncio parado de novo', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const { historico } = await agenteDetalhe.obterDetalheAgente('anuncios_radar', EMPRESA_ID);
      assert.equal(historico.length, 1);
      assert.equal(historico[0].agenteCodigo, 'anuncios_radar');
      assert.equal(historico[0].referencia, 'Anúncio parado de novo');
    });

    test('historico do agente "concorrente" nunca mistura com alerta de anúncio', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES
           ($1, 'concorrente_ativo:1', 'concorrente_ativo', 'critico', 'Concorrente mais barato', 'x', 'x', '{}', 'aberto'),
           ($1, 'anuncio_parado:x', 'anuncio_parado', 'atencao', 'Não é da Concorrente', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const { historico } = await agenteDetalhe.obterDetalheAgente('concorrente', EMPRESA_ID);
      assert.equal(historico.length, 1);
      assert.equal(historico[0].referencia, 'Concorrente mais barato');
    });

    test('alerta financeiro/estoque (sem agente próprio ainda) nunca aparece no detalhe de anuncios_radar nem de concorrente', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'financeiro_contas_vencidas', 'financeiro_contas_vencidas', 'critico', 'Contas vencidas', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const [anuncios, concorrente] = await Promise.all([
        agenteDetalhe.obterDetalheAgente('anuncios_radar', EMPRESA_ID),
        agenteDetalhe.obterDetalheAgente('concorrente', EMPRESA_ID),
      ]);
      assert.equal(anuncios.historico.length, 0);
      assert.equal(concorrente.historico.length, 0);
    });

    test('melhora do Ads: sem nenhuma decisão avaliada ainda -> avaliadas=0, nunca uma média inventada', async () => {
      const { melhora } = await agenteDetalhe.obterDetalheAgente('ads_performance', EMPRESA_ID);
      assert.equal(melhora.tipo, 'financeira');
      assert.equal(melhora.avaliadas, 0);
      assert.equal(melhora.deltaMedioPct, null);
    });

    test('melhora do Ads: decisão avaliada com margem melhor depois -> delta positivo real', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads
           (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia,
            status_decisao, decidido_em, decidido_por, snapshot_margem_depois_ads_pct, resultado_snapshot, resultado_avaliado_em)
         VALUES ($1,$2,'campanha','C1','Campanha Avaliada','diminuir_orcamento','x','{}',
                 'aprovada', now(), 'Pablo', 10.0, '{"margemDepoisDoAdsPct": 16.0}', now())`,
        [EMPRESA_ID, CONTA_ID]
      );
      const { melhora } = await agenteDetalhe.obterDetalheAgente('ads_performance', EMPRESA_ID);
      assert.equal(melhora.avaliadas, 1);
      assert.equal(melhora.deltaMedioPct, 6);
    });

    test('melhora do Anúncios/Concorrente: conta alertas resolvidos nos últimos 30 dias e abertos agora', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status, resolvido_em)
         VALUES
           ($1, 'anuncio_parado:resolvido1', 'anuncio_parado', 'atencao', 'x', 'x', 'x', '{}', 'resolvido', now() - interval '2 days'),
           ($1, 'anuncio_parado:aberto1', 'anuncio_parado', 'atencao', 'x', 'x', 'x', '{}', 'aberto', NULL)`,
        [EMPRESA_ID]
      );
      const { melhora } = await agenteDetalhe.obterDetalheAgente('anuncios_radar', EMPRESA_ID);
      assert.equal(melhora.tipo, 'resolucao');
      assert.equal(melhora.resolvidosUltimos30d, 1);
      assert.equal(melhora.abertosAgora, 1);
    });

    test('SAC: pendentes conta só do marketplace certo, e melhora conta atendimentos resolvidos recentemente', async () => {
      const { rows: at1 } = await pool.query(
        `INSERT INTO sac_atendimentos (empresa_id, marketplace, conta_id, tipo_origem, id_externo, mensagem_cliente, data_recebido, status)
         VALUES ($1,'mercado_livre',999,'pergunta','q1','msg', now(), 'novo') RETURNING id`,
        [EMPRESA_ID]
      );
      await pool.query(`INSERT INTO sac_respostas (atendimento_id, resposta_sugerida_ia, status_decisao) VALUES ($1,'r','pendente')`, [at1[0].id]);

      await pool.query(
        `INSERT INTO sac_atendimentos (empresa_id, marketplace, conta_id, tipo_origem, id_externo, mensagem_cliente, data_recebido, status, atualizado_em)
         VALUES ($1,'mercado_livre',999,'pergunta','q2','msg', now(), 'resolvido', now() - interval '1 day')`,
        [EMPRESA_ID]
      );
      // Shopee — nunca deve contar pro Mercado Livre
      const { rows: atShopee } = await pool.query(
        `INSERT INTO sac_atendimentos (empresa_id, marketplace, conta_id, tipo_origem, id_externo, mensagem_cliente, data_recebido, status)
         VALUES ($1,'shopee',999,'pergunta','q3','msg', now(), 'novo') RETURNING id`,
        [EMPRESA_ID]
      );
      await pool.query(`INSERT INTO sac_respostas (atendimento_id, resposta_sugerida_ia, status_decisao) VALUES ($1,'r','pendente')`, [atShopee[0].id]);

      const [ml, shopee] = await Promise.all([
        agenteDetalhe.obterDetalheAgente('sac_mercado_livre', EMPRESA_ID),
        agenteDetalhe.obterDetalheAgente('sac_shopee', EMPRESA_ID),
      ]);
      assert.equal(ml.pendentes.total, 1);
      assert.equal(ml.melhora.resolvidosUltimos30d, 1);
      assert.equal(shopee.pendentes.total, 1);
      assert.equal(shopee.melhora.resolvidosUltimos30d, 0);
    });

    test('GET .../detalhe devolve as 4 seções junto com nome/descrição reais do ia_agentes', async () => {
      const res = await fetch(`${baseUrl}/api/ia-agentes/concorrente/detalhe?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.agenteCodigo, 'concorrente');
      assert.equal(body.nome, 'Análise de Concorrente');
      assert.ok(body.statusAtual);
      assert.ok(body.pendentes);
      assert.ok(Array.isArray(body.historico));
      assert.ok(body.melhora);
    });
  }
);
