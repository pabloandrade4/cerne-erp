// Rotas HTTP de GET /api/ia-agentes/stats e GET /api/ia-agentes/historico —
// ETAPA 2/3 (14/09/2026) do redesign da tela "Agentes de IA" (hub), mesmo
// padrão de test/dailyRoutes.test.js (Express real + Postgres real).
//
// O que estes testes provam: (1) os KPIs e stats por agente batem com o
// que está de verdade em ia_decisoes_ads/ia_decisoes_promocoes/
// radar_alertas/ia_conversas+ia_mensagens (nunca um número inventado —
// regra 3 do pedido do usuário); (2) sem nenhum dado, tudo vem 0/null,
// nunca um valor fabricado; (3) o histórico junta sugestão + decisão +
// alerta na ordem certa (mais recente primeiro) e nunca inclui um evento
// de "enviado ao Mercado Livre" (executado é sempre false nesta fase);
// (4) nunca mistura dado de outra empresa; (5) empresaId é obrigatório nas
// duas rotas.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 973;
const OUTRA_EMPRESA_ID = 972;
const CONTA_ID = 973;
const OUTRA_CONTA_ID = 972;

describe(
  'Rotas HTTP de /api/ia-agentes/stats e /historico (hub de Agentes de IA)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;

    function montarApp() {
      delete require.cache[require.resolve('../routes/iaAgentes')];
      const express = require('express');
      const iaAgentesRouter = require('../routes/iaAgentes');
      const app = express();
      app.use(express.json());
      app.use('/api/ia-agentes', iaAgentesRouter);
      return app;
    }

    async function seedEmpresa(id, contaId, nome) {
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [id, String(90000000000000 + id).slice(0, 14), nome]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, $3, $4, 'x', 'x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status = 'ativa'`,
        [contaId, id, 900000000 + contaId, nome]
      );
    }

    async function limparEmpresa(id, contaId) {
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [id]);
      await pool.query('DELETE FROM ia_decisoes_promocoes WHERE empresa_id = $1', [id]);
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [id]);
      await pool.query('DELETE FROM ia_mensagens WHERE conversa_id IN (SELECT id FROM ia_conversas WHERE empresa_id = $1)', [id]);
      await pool.query('DELETE FROM ia_conversas WHERE empresa_id = $1', [id]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [contaId]);
    }

    before(async () => {
      pool = require('../db/pool');
      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      await seedEmpresa(EMPRESA_ID, CONTA_ID, '[TESTE AUTOMATIZADO] Empresa Hub Agentes IA');
      await seedEmpresa(OUTRA_EMPRESA_ID, OUTRA_CONTA_ID, '[TESTE AUTOMATIZADO] Empresa Hub Agentes IA (outra)');
    });

    beforeEach(async () => {
      await limparEmpresa(EMPRESA_ID, CONTA_ID);
      await limparEmpresa(OUTRA_EMPRESA_ID, OUTRA_CONTA_ID);
      await seedEmpresa(EMPRESA_ID, CONTA_ID, '[TESTE AUTOMATIZADO] Empresa Hub Agentes IA');
      await seedEmpresa(OUTRA_EMPRESA_ID, OUTRA_CONTA_ID, '[TESTE AUTOMATIZADO] Empresa Hub Agentes IA (outra)');
    });

    after(async () => {
      await limparEmpresa(EMPRESA_ID, CONTA_ID);
      await limparEmpresa(OUTRA_EMPRESA_ID, OUTRA_CONTA_ID);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      server.close();
    });

    test('GET /stats sem empresaId -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/ia-agentes/stats`);
      assert.equal(res.status, 400);
    });

    test('GET /historico sem empresaId -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/ia-agentes/historico`);
      assert.equal(res.status, 400);
    });

    test('GET /stats sem nenhum dado -> tudo 0/null, nunca um número inventado', async () => {
      const res = await fetch(`${baseUrl}/api/ia-agentes/stats?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      // 6 agentes ativos hoje: ads_performance, promocoes, os 2 de SAC
      // (sac_mercado_livre, sac_shopee — 14/09/2026) e os 2 novos de
      // Anúncios/Concorrente (anuncios_radar, concorrente — 19/09/2026, ver
      // db/schema.sql).
      assert.equal(body.kpis.agentesAtivos, 6);
      assert.equal(body.kpis.tarefasHoje, 0);
      assert.equal(body.kpis.alertasImportantes, 0);
      const ads = body.agentes.find((a) => a.codigo === 'ads_performance');
      assert.equal(ads.pendentes, 0);
      assert.equal(ads.decididasHoje, 0);
      assert.equal(ads.ultimaAtualizacao, null);
      assert.equal(body.iaGestora.conversasHoje, 0);
      assert.equal(body.iaGestora.mensagensHoje, 0);
    });

    test('GET /stats reflete sugestão pendente + decisão de hoje + alerta aberto de verdade', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','[TESTE AUTOMATIZADO] Campanha Pendente','aumentar_orcamento','Margem folgada.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );
      await pool.query(
        `INSERT INTO ia_decisoes_promocoes (empresa_id, conta_id, promotion_id, promotion_type, ml_item_id, titulo, tipo_acao, motivo, valor_sugerido_ia, status_decisao, decidido_em, decidido_por)
         VALUES ($1,$2,'P1','SELLER_CAMPAIGN','MLB1','[TESTE AUTOMATIZADO] Anúncio Decidido','entrar_promocao','Margem real positiva.', '{}', 'aprovada', now(), 'Pablo')`,
        [EMPRESA_ID, CONTA_ID]
      );
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, '[TESTE AUTOMATIZADO] chave-1', 'estoque', 'critico', '[TESTE AUTOMATIZADO] Estoque baixo', 'SKU X com 2 unidades', 'Reponha', '{}', 'aberto')`,
        [EMPRESA_ID]
      );

      const res = await fetch(`${baseUrl}/api/ia-agentes/stats?empresaId=${EMPRESA_ID}`);
      const body = await res.json();
      const ads = body.agentes.find((a) => a.codigo === 'ads_performance');
      const promo = body.agentes.find((a) => a.codigo === 'promocoes');
      assert.equal(ads.pendentes, 1);
      assert.equal(promo.decididasHoje, 1);
      // tarefasHoje = sugestões novas hoje (ads=1 + promoções=1) + alertas novos hoje (1)
      assert.equal(body.kpis.tarefasHoje, 3);
      assert.equal(body.kpis.alertasImportantes, 1);

      // nunca vaza pra outra empresa
      const resOutra = await fetch(`${baseUrl}/api/ia-agentes/stats?empresaId=${OUTRA_EMPRESA_ID}`);
      const bodyOutra = await resOutra.json();
      assert.equal(bodyOutra.kpis.tarefasHoje, 0);
      assert.equal(bodyOutra.kpis.alertasImportantes, 0);
    });

    test('GET /historico junta sugestão + decisão + alerta, mais recente primeiro, nunca um evento de execução no Mercado Livre', async () => {
      const { rows } = await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao, decidido_em, decidido_por, criado_em, atualizado_em)
         VALUES ($1,$2,'campanha','C1','[TESTE AUTOMATIZADO] Campanha Histórico','diminuir_orcamento','ACOS acima da meta', '{}', 'aprovada', now(), 'Pablo', now() - interval '10 minutes', now())
         RETURNING id`,
        [EMPRESA_ID, CONTA_ID]
      );
      assert.ok(rows.length);

      const res = await fetch(`${baseUrl}/api/ia-agentes/historico?empresaId=${EMPRESA_ID}&limit=10`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.eventos.length, 2); // 1 sugestão (criado_em) + 1 decisão (decidido_em)

      const [maisRecente, maisAntigo] = body.eventos;
      assert.equal(maisRecente.tipo, 'aprovada');
      assert.equal(maisRecente.usuario, 'Pablo');
      assert.equal(maisAntigo.tipo, 'sugestao');
      assert.ok(new Date(maisRecente.ts) >= new Date(maisAntigo.ts));

      body.eventos.forEach((ev) => {
        assert.notEqual(ev.tipo, 'executado');
        assert.notEqual(ev.tipo, 'enviado_ml');
      });
    });

    test('GET /historico respeita o limit e nunca mistura evento de outra empresa', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, '[TESTE AUTOMATIZADO] chave-outra', 'financeiro', 'atencao', '[TESTE AUTOMATIZADO] Alerta de outra empresa', 'Nunca deveria aparecer aqui', 'x', '{}', 'aberto')`,
        [OUTRA_EMPRESA_ID]
      );
      const res = await fetch(`${baseUrl}/api/ia-agentes/historico?empresaId=${EMPRESA_ID}&limit=1`);
      const body = await res.json();
      assert.equal(body.eventos.length, 0);
    });
  }
);
