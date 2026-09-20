// Executor real de Ads — "Fase E" (19/09/2026, pedido explícito do usuário:
// "eu vou aprovar, aí vai fazer... por enquanto só vai precisar da minha
// permissão"). Cobre as DUAS travas (config_ads_ia.permite_escrita_ml e
// ia_permissoes_acao.nivel_permissao), o cálculo do payload real de PUT, e
// que a execução NUNCA lança nem impede a aprovação de ficar registrada —
// só grava um motivo honesto quando não executa. Integração com Postgres
// real; a chamada à API do Mercado Livive em si é sempre mockada
// (mlAds.atualizarCampanha), igual ao padrão já usado em test/ads.test.js.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 982;
const CONTA_ID = 982;

describe(
  'lib/ia/adsExecutor — execução real de Ads depois da aprovação (19/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, cryptoLib, mlAds, executor;
    let atualizarCampanhaReal;

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');
      pool = require('../db/pool');
      cryptoLib = require('../lib/crypto');
      mlAds = require('../lib/mlAds');
      executor = require('../lib/ia/adsExecutor');
      atualizarCampanhaReal = mlAds.atualizarCampanha;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'98200098000199','EMPRESA TESTE ADS EXECUTOR',TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, site_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,982000001,'LOJA TESTE EXECUTOR','MLB',$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa', ultimo_erro=NULL`,
        [CONTA_ID, EMPRESA_ID, cryptoLib.encrypt('token-ok'), cryptoLib.encrypt('refresh-ok')]
      );
      await pool.query(
        `INSERT INTO ads_contas (conta_id, advertiser_id, site_id, disponivel)
         VALUES ($1, 'ADV-982', 'MLB', TRUE)
         ON CONFLICT (conta_id) DO UPDATE SET site_id = EXCLUDED.site_id`,
        [CONTA_ID]
      );
    });

    afterEach(async () => {
      mlAds.atualizarCampanha = atualizarCampanhaReal;
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM config_ads_ia WHERE empresa_id = $1', [EMPRESA_ID]);
      // devolve ia_permissoes_acao pro estado seedado original, caso algum
      // teste tenha alterado nivel_permissao pra simular 'recommend_only'.
      await pool.query(
        `UPDATE ia_permissoes_acao SET nivel_permissao = 'approval_required'
          WHERE agente_codigo = 'ads_performance' AND tipo_acao = 'pausar_campanha'`
      );
    });

    after(async () => {
      mlAds.atualizarCampanha = atualizarCampanhaReal;
      await pool.query('DELETE FROM ads_contas WHERE conta_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      await pool.end();
    });

    async function criarDecisao({ tipoReferencia = 'campanha', tipoAcao, campanhaId = 'CAMP-1', valorSugeridoIa }) {
      const { rows } = await pool.query(
        `INSERT INTO ia_decisoes_ads
           (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao, decidido_em, decidido_por)
         VALUES ($1,$2,$3,$4,'Campanha Teste',$5,'motivo teste',$6,'aprovada', now(), 'Pablo')
         RETURNING *`,
        [EMPRESA_ID, CONTA_ID, tipoReferencia, campanhaId, tipoAcao, JSON.stringify(valorSugeridoIa || {})]
      );
      return rows[0];
    }

    async function ligarEscritaMl() {
      await pool.query(
        `INSERT INTO config_ads_ia (empresa_id, margem_minima_pct, permite_escrita_ml)
         VALUES ($1, 10, TRUE)
         ON CONFLICT (empresa_id) DO UPDATE SET permite_escrita_ml = TRUE`,
        [EMPRESA_ID]
      );
    }

    test('montarPayloadExecucao: pausar/ativar campanha viram {status}, orçamento vira {budget} priorizando o valor decidido pelo usuário', () => {
      assert.deepEqual(executor.montarPayloadExecucao({ tipo_acao: 'pausar_campanha', valor_sugerido_ia: {}, valor_decidido_usuario: null }), { status: 'paused' });
      assert.deepEqual(executor.montarPayloadExecucao({ tipo_acao: 'ativar_campanha', valor_sugerido_ia: {}, valor_decidido_usuario: null }), { status: 'active' });
      assert.deepEqual(
        executor.montarPayloadExecucao({ tipo_acao: 'diminuir_orcamento', valor_sugerido_ia: { orcamentoSugerido: 80 }, valor_decidido_usuario: null }),
        { budget: 80 }
      );
      // usuário alterou o valor sugerido antes de aprovar — o decidido manda, nunca o original da IA.
      assert.deepEqual(
        executor.montarPayloadExecucao({ tipo_acao: 'diminuir_orcamento', valor_sugerido_ia: { orcamentoSugerido: 80 }, valor_decidido_usuario: { orcamentoDecidido: 65 } }),
        { budget: 65 }
      );
      assert.equal(executor.montarPayloadExecucao({ tipo_acao: 'diminuir_orcamento', valor_sugerido_ia: {}, valor_decidido_usuario: null }), null);
      assert.equal(executor.montarPayloadExecucao({ tipo_acao: 'colocar_sku_em_campanha', valor_sugerido_ia: {}, valor_decidido_usuario: null }), null);
    });

    test('pausar_anuncio (tipo_referencia=anuncio): nunca tenta executar, mesmo com escrita ligada — motivo "sem_execucao_direta"', async () => {
      await ligarEscritaMl();
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const decisao = await criarDecisao({ tipoReferencia: 'anuncio', tipoAcao: 'pausar_anuncio', valorSugeridoIa: { acao: 'pausar' } });
      const resultado = await executor.executarDecisaoAprovada(decisao.id);
      assert.equal(resultado.executado, false);
      assert.equal(resultado.motivo, 'sem_execucao_direta');
      assert.equal(chamou, false);
      const { rows } = await pool.query('SELECT executado, execucao_erro FROM ia_decisoes_ads WHERE id = $1', [decisao.id]);
      assert.equal(rows[0].executado, false);
      assert.match(rows[0].execucao_erro, /ainda não tem execução automática/);
    });

    test('escrita desligada (config_ads_ia.permite_escrita_ml=false ou sem linha): nunca chama a API, grava motivo honesto', async () => {
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const decisao = await criarDecisao({ tipoAcao: 'pausar_campanha' });
      const resultado = await executor.executarDecisaoAprovada(decisao.id);
      assert.equal(resultado.executado, false);
      assert.equal(resultado.motivo, 'escrita_desligada');
      assert.equal(chamou, false);
      const { rows } = await pool.query('SELECT execucao_erro FROM ia_decisoes_ads WHERE id = $1', [decisao.id]);
      assert.match(rows[0].execucao_erro, /permissão de escrita.*não está liberada/i);
    });

    test('tipo_acao marcado "recommend_only" em ia_permissoes_acao: nunca executa, mesmo aprovado e com escrita ligada', async () => {
      await ligarEscritaMl();
      await pool.query(`UPDATE ia_permissoes_acao SET nivel_permissao = 'recommend_only' WHERE agente_codigo = 'ads_performance' AND tipo_acao = 'pausar_campanha'`);
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const decisao = await criarDecisao({ tipoAcao: 'pausar_campanha' });
      const resultado = await executor.executarDecisaoAprovada(decisao.id);
      assert.equal(resultado.executado, false);
      assert.equal(resultado.motivo, 'recommend_only');
      assert.equal(chamou, false);
    });

    test('escrita ligada + pausar_campanha: chama atualizarCampanha com {status:paused} e marca executado=true', async () => {
      await ligarEscritaMl();
      let payloadRecebido = null;
      mlAds.atualizarCampanha = async (args) => { payloadRecebido = args; return { id: 'CAMP-1', status: 'paused' }; };
      const decisao = await criarDecisao({ tipoAcao: 'pausar_campanha', campanhaId: 'CAMP-1' });
      const resultado = await executor.executarDecisaoAprovada(decisao.id);
      assert.equal(resultado.executado, true);
      assert.equal(payloadRecebido.status, 'paused');
      assert.equal(payloadRecebido.campanhaId, 'CAMP-1');
      assert.equal(payloadRecebido.siteId, 'MLB');
      assert.equal(payloadRecebido.accessToken, 'token-ok');
      const { rows } = await pool.query('SELECT executado, executado_em, execucao_erro, execucao_resposta FROM ia_decisoes_ads WHERE id = $1', [decisao.id]);
      assert.equal(rows[0].executado, true);
      assert.ok(rows[0].executado_em);
      assert.equal(rows[0].execucao_erro, null);
      assert.equal(rows[0].execucao_resposta.status, 'paused');
    });

    test('escrita ligada + diminuir_orcamento com valor alterado pelo usuário: usa o valor decidido, não o sugerido original', async () => {
      await ligarEscritaMl();
      let payloadRecebido = null;
      mlAds.atualizarCampanha = async (args) => { payloadRecebido = args; return { budget: 65 }; };
      const decisao = await criarDecisao({ tipoAcao: 'diminuir_orcamento', valorSugeridoIa: { acao: 'diminuir_orcamento', orcamentoAtual: 100, orcamentoSugerido: 80 } });
      await pool.query(`UPDATE ia_decisoes_ads SET valor_decidido_usuario = $1, status_decisao = 'alterada' WHERE id = $2`, [JSON.stringify({ orcamentoDecidido: 65 }), decisao.id]);
      const resultado = await executor.executarDecisaoAprovada(decisao.id);
      assert.equal(resultado.executado, true);
      assert.equal(payloadRecebido.budget, 65);
    });

    test('erro real da API do Mercado Livre: nunca lança, marca executado=false e grava a mensagem real', async () => {
      await ligarEscritaMl();
      mlAds.atualizarCampanha = async () => {
        const err = new Error('não usado');
        err.status = 400;
        err.data = { message: 'invalid budget value' };
        throw err;
      };
      const decisao = await criarDecisao({ tipoAcao: 'aumentar_orcamento', valorSugeridoIa: { orcamentoSugerido: 120 } });
      const resultado = await executor.executarDecisaoAprovada(decisao.id);
      assert.equal(resultado.executado, false);
      assert.equal(resultado.motivo, 'erro_api');
      assert.match(resultado.erro, /invalid budget value/);
      const { rows } = await pool.query('SELECT executado, execucao_erro FROM ia_decisoes_ads WHERE id = $1', [decisao.id]);
      assert.equal(rows[0].executado, false);
      assert.match(rows[0].execucao_erro, /invalid budget value/);
    });

    test('conta sem site_id sincronizado em ads_contas: não tenta executar, motivo "sem_site_id"', async () => {
      await ligarEscritaMl();
      const OUTRA_CONTA_ID = 9821;
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, site_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,982100001,'LOJA SEM ADS_CONTAS','MLB',$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa'`,
        [OUTRA_CONTA_ID, EMPRESA_ID, cryptoLib.encrypt('token-ok'), cryptoLib.encrypt('refresh-ok')]
      );
      let chamou = false;
      mlAds.atualizarCampanha = async () => { chamou = true; return {}; };
      const { rows: novaDecisao } = await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao, decidido_em, decidido_por)
         VALUES ($1,$2,'campanha','CAMP-X','Campanha X','pausar_campanha','motivo',$3,'aprovada', now(), 'Pablo')
         RETURNING *`,
        [EMPRESA_ID, OUTRA_CONTA_ID, JSON.stringify({})]
      );
      const resultado = await executor.executarDecisaoAprovada(novaDecisao[0].id);
      assert.equal(resultado.executado, false);
      assert.equal(resultado.motivo, 'sem_site_id');
      assert.equal(chamou, false);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE id = $1', [novaDecisao[0].id]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [OUTRA_CONTA_ID]);
    });

    test('decisão que não existe: devolve executado=false sem lançar', async () => {
      const resultado = await executor.executarDecisaoAprovada(999999999);
      assert.equal(resultado.executado, false);
      assert.equal(resultado.motivo, 'decisao_nao_encontrada');
    });
  }
);
