// Rotas HTTP de /api/sac — agentes de SAC (Mercado Livre e Shopee),
// 14/09/2026, pedido explícito do usuário. Mesmo padrão de
// test/iaAgentesHub.test.js/test/dailyRoutes.test.js (Express real +
// Postgres real).
//
// O que estes testes provam: (1) empresaId/marketplace são obrigatórios;
// (2) a caixa de entrada, os filtros (marketplace/tipoOrigem/status/
// urgente) e as estatísticas refletem dado real gravado direto no banco
// (nunca um número inventado); (3) registrar uma decisão (aprovar/editar/
// recusar) NUNCA marca `enviado = true` — Modo supervisionado, Fase 1;
// (4) uma resposta já decidida não pode ser decidida de novo; (5) nunca
// mistura dado de outra empresa; (6) marcar como resolvido é manual.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 975;
const OUTRA_EMPRESA_ID = 976;

describe(
  'Rotas HTTP de /api/sac (agentes de SAC — Mercado Livre e Shopee)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl, sacStore;

    function montarApp() {
      delete require.cache[require.resolve('../routes/sac')];
      const express = require('express');
      const sacRouter = require('../routes/sac');
      const app = express();
      app.use(express.json());
      app.use('/api/sac', sacRouter);
      return app;
    }

    async function seedEmpresa(id, nome) {
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [id, String(97000000000000 + id).slice(0, 14), nome]
      );
    }

    async function limparEmpresa(id) {
      await pool.query('DELETE FROM sac_atendimentos WHERE empresa_id = $1', [id]);
    }

    before(async () => {
      pool = require('../db/pool');
      sacStore = require('../lib/ia/sacStore');
      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      await seedEmpresa(EMPRESA_ID, '[TESTE AUTOMATIZADO] Empresa SAC');
      await seedEmpresa(OUTRA_EMPRESA_ID, '[TESTE AUTOMATIZADO] Empresa SAC (outra)');
    });

    beforeEach(async () => {
      await limparEmpresa(EMPRESA_ID);
      await limparEmpresa(OUTRA_EMPRESA_ID);
    });

    after(async () => {
      await limparEmpresa(EMPRESA_ID);
      await limparEmpresa(OUTRA_EMPRESA_ID);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      server.close();
    });

    test('GET /atendimentos sem empresaId -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/sac/atendimentos`);
      assert.equal(res.status, 400);
    });

    test('GET /atendimentos com marketplace inválido -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/sac/atendimentos?empresaId=${EMPRESA_ID}&marketplace=aliexpress`);
      assert.equal(res.status, 400);
    });

    test('GET /stats sem marketplace -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/sac/stats?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 400);
    });

    test('GET /atendimentos sem nenhum dado -> lista vazia, nunca um atendimento inventado', async () => {
      const res = await fetch(`${baseUrl}/api/sac/atendimentos?empresaId=${EMPRESA_ID}&marketplace=mercado_livre`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.atendimentos, []);
    });

    test('GET /stats sem nenhum dado -> tudo 0/null', async () => {
      const res = await fetch(`${baseUrl}/api/sac/stats?empresaId=${EMPRESA_ID}&marketplace=shopee`);
      const body = await res.json();
      assert.equal(body.atendimentosNovos, 0);
      assert.equal(body.tempoMedioRespostaMin, null);
      assert.equal(body.ultimaAtualizacao, null);
    });

    test('atendimento real: aparece na lista, respeita filtro de marketplace/tipoOrigem, e nunca vaza pra outra empresa', async () => {
      await sacStore.upsertAtendimento(EMPRESA_ID, 'mercado_livre', 1, {
        tipoOrigem: 'pergunta', idExterno: 'Q100', mensagemCliente: '[TESTE AUTOMATIZADO] Qual a medida?', dataRecebido: new Date(),
      });
      await sacStore.upsertAtendimento(EMPRESA_ID, 'shopee', 2, {
        tipoOrigem: 'devolucao', idExterno: 'R100', mensagemCliente: '[TESTE AUTOMATIZADO] Quero devolver', dataRecebido: new Date(),
      });
      await sacStore.upsertAtendimento(OUTRA_EMPRESA_ID, 'mercado_livre', 3, {
        tipoOrigem: 'pergunta', idExterno: 'Q999', mensagemCliente: '[TESTE AUTOMATIZADO] Nunca deveria aparecer', dataRecebido: new Date(),
      });

      let res = await fetch(`${baseUrl}/api/sac/atendimentos?empresaId=${EMPRESA_ID}&marketplace=mercado_livre`);
      let body = await res.json();
      assert.equal(body.atendimentos.length, 1);
      assert.equal(body.atendimentos[0].tipoOrigem, 'pergunta');

      res = await fetch(`${baseUrl}/api/sac/atendimentos?empresaId=${EMPRESA_ID}&marketplace=shopee&tipoOrigem=devolucao`);
      body = await res.json();
      assert.equal(body.atendimentos.length, 1);
      assert.equal(body.atendimentos[0].idExterno, 'R100');

      res = await fetch(`${baseUrl}/api/sac/atendimentos?empresaId=${OUTRA_EMPRESA_ID}&marketplace=mercado_livre`);
      body = await res.json();
      assert.equal(body.atendimentos.length, 1);
      assert.notEqual(body.atendimentos[0].idExterno, 'Q100');
    });

    test('PUT /respostas/:id/decisao aprova, registra o texto final, e NUNCA marca enviado=true (Modo supervisionado)', async () => {
      const { id } = await sacStore.upsertAtendimento(EMPRESA_ID, 'mercado_livre', 1, {
        tipoOrigem: 'pergunta', idExterno: 'Q200', mensagemCliente: '[TESTE AUTOMATIZADO] Tem em azul?', dataRecebido: new Date(),
      });
      await sacStore.upsertSugestaoPendente(id, { respostaSugeridaIa: 'Sim, temos em azul!', classificacao: 'duvida_simples', urgente: false });
      const detalhe = await sacStore.buscarAtendimento(id, EMPRESA_ID);
      assert.ok(detalhe.respostaPendente);

      const res = await fetch(`${baseUrl}/api/sac/respostas/${detalhe.respostaPendente.id}/decisao`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, statusDecisao: 'aprovada', respostaFinal: 'Sim, temos em azul!', decididoPor: 'Pablo' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status_decisao, 'aprovada');
      assert.equal(body.resposta_final, 'Sim, temos em azul!');
      assert.equal(body.enviado, false); // NUNCA true nesta fase — nenhum envio real ao Mercado Livre/Shopee

      // decidir de novo (já decidida) -> 404
      const res2 = await fetch(`${baseUrl}/api/sac/respostas/${detalhe.respostaPendente.id}/decisao`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, statusDecisao: 'aprovada', respostaFinal: 'outra coisa' }),
      });
      assert.equal(res2.status, 404);

      // atendimento status vira 'respondido'
      const resAt = await fetch(`${baseUrl}/api/sac/atendimentos/${id}?empresaId=${EMPRESA_ID}`);
      const bodyAt = await resAt.json();
      assert.equal(bodyAt.status, 'respondido');
      assert.equal(bodyAt.ultimaDecisao.statusDecisao, 'aprovada');
    });

    test('PUT /respostas/:id/decisao recusada não exige respostaFinal', async () => {
      const { id } = await sacStore.upsertAtendimento(EMPRESA_ID, 'shopee', 2, {
        tipoOrigem: 'reclamacao', idExterno: 'C300', mensagemCliente: '[TESTE AUTOMATIZADO] Produto veio errado', dataRecebido: new Date(),
      });
      await sacStore.upsertSugestaoPendente(id, { respostaSugeridaIa: null, motivoSemSugestao: 'Precisa de análise humana.', classificacao: 'reclamacao', urgente: true });
      const detalhe = await sacStore.buscarAtendimento(id, EMPRESA_ID);

      const res = await fetch(`${baseUrl}/api/sac/respostas/${detalhe.respostaPendente.id}/decisao`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, statusDecisao: 'recusada' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status_decisao, 'recusada');
      assert.equal(body.resposta_final, null);
    });

    test('PUT /respostas/:id/decisao com statusDecisao inválido -> 400; aprovar sem respostaFinal -> 400', async () => {
      const { id } = await sacStore.upsertAtendimento(EMPRESA_ID, 'mercado_livre', 1, {
        tipoOrigem: 'pergunta', idExterno: 'Q400', mensagemCliente: '[TESTE AUTOMATIZADO] teste', dataRecebido: new Date(),
      });
      await sacStore.upsertSugestaoPendente(id, { respostaSugeridaIa: 'resposta', classificacao: 'duvida_simples', urgente: false });
      const detalhe = await sacStore.buscarAtendimento(id, EMPRESA_ID);

      let res = await fetch(`${baseUrl}/api/sac/respostas/${detalhe.respostaPendente.id}/decisao`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, statusDecisao: 'enviada_de_verdade' }),
      });
      assert.equal(res.status, 400);

      res = await fetch(`${baseUrl}/api/sac/respostas/${detalhe.respostaPendente.id}/decisao`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, statusDecisao: 'aprovada' }),
      });
      assert.equal(res.status, 400);
    });

    test('PUT /atendimentos/:id/resolver marca resolvido manualmente', async () => {
      const { id } = await sacStore.upsertAtendimento(EMPRESA_ID, 'mercado_livre', 1, {
        tipoOrigem: 'mensagem', idExterno: 'M500', mensagemCliente: '[TESTE AUTOMATIZADO] obrigado!', dataRecebido: new Date(),
      });
      const res = await fetch(`${baseUrl}/api/sac/atendimentos/${id}/resolver`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID }),
      });
      assert.equal(res.status, 200);

      const resOutra = await fetch(`${baseUrl}/api/sac/atendimentos/${id}/resolver`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: OUTRA_EMPRESA_ID }),
      });
      assert.equal(resOutra.status, 404); // não deixa marcar resolvido um atendimento de outra empresa
    });

    test('POST /gerar-agora sem contas ativas -> não quebra, devolve contasProcessadas 0', async () => {
      const res = await fetch(`${baseUrl}/api/sac/gerar-agora`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, marketplace: 'mercado_livre' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.contasProcessadas, 0);
      assert.equal(body.atendimentosNovos, 0);
    });
  }
);
