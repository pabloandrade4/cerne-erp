// Testes da correção de 25/08/2026 (ver docs/02-decisoes.md e
// docs/04-alteracoes.md, entrada "Ads: diagnóstico real + endpoints atuais
// + sincronização em banco") — pedido explícito do usuário nos 3 passos:
//
// Parte 1 (sem banco/rede) — Passo 1: diagnóstico real, nunca um "nenhum
// anunciante encontrado" genérico. Testa motivoDeErro (lib/mlAds.js) com
// erros simulados de status/corpo variados.
//
// Parte 2 (Postgres real, API do Mercado Livre mockada — mesmo padrão de
// test/mlEstoque.test.js) — Passo 1 + Passo 2: sincronizarContaAds
// (lib/ads.js) grava o motivo/mensagem/corpo REAL da API quando a conta não
// tem anunciante, e grava as métricas reais em
// ads_contas/ads_campanhas/ads_metricas_anuncio/ads_diario quando a conta
// tem. listarAds (lib/ads.js) NUNCA chama a API do Mercado Livre — lê só o
// que já foi sincronizado (Passo 2: "não depender de consultar toda a API
// toda vez que abro a página").
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const { motivoDeErro } = require('../lib/mlAds');

describe('motivoDeErro — diagnóstico real (Passo 1: nunca um "nenhum anunciante encontrado" genérico)', () => {
  test('401/403 -> sem_acesso_ads, cita a mensagem REAL da API e guarda status/corpo em detalheApi', () => {
    const err = new Error('Forbidden');
    err.status = 403;
    err.data = { message: 'invalid_token: the token does not belong to this application' };
    const r = motivoDeErro(err, { endpoint: '/advertising/advertisers?product_id=PADS', parametros: { product_id: 'PADS' } });
    assert.equal(r.motivo, 'sem_acesso_ads');
    assert.match(r.mensagem, /invalid_token: the token does not belong to this application/);
    assert.equal(r.detalheApi.status, 403);
    assert.equal(r.detalheApi.endpoint, '/advertising/advertisers?product_id=PADS');
    assert.deepEqual(r.detalheApi.corpoResposta, err.data);
  });

  test('404 sem anunciante -> sem_anunciante, cita a causa real quando a API devolve "cause"', () => {
    const err = new Error('Not Found');
    err.status = 404;
    err.data = { message: 'resource not found', cause: [{ code: 'PADS-404', description: 'No permissions found for user_id' }] };
    const r = motivoDeErro(err);
    assert.equal(r.motivo, 'sem_anunciante');
    assert.match(r.mensagem, /No permissions found for user_id/);
    assert.match(r.mensagem, /ativou Product Ads/);
  });

  test('400 -> parametro_invalido, nunca confundido com "sem anunciante"', () => {
    const err = new Error('Bad Request');
    err.status = 400;
    err.data = { message: 'invalid metric: xyz' };
    const r = motivoDeErro(err);
    assert.equal(r.motivo, 'parametro_invalido');
    assert.match(r.mensagem, /invalid metric: xyz/);
  });

  test('504 -> timeout', () => {
    const err = new Error('Tempo limite (20s) excedido');
    err.status = 504;
    const r = motivoDeErro(err);
    assert.equal(r.motivo, 'timeout');
  });

  test('status desconhecido -> erro_api, sempre com detalheApi (nunca um objeto vazio solto)', () => {
    const err = new Error('boom');
    err.status = 500;
    const r = motivoDeErro(err);
    assert.equal(r.motivo, 'erro_api');
    assert.match(r.mensagem, /HTTP 500/);
    assert.ok(r.detalheApi);
  });

  test('sem err.data (rede caiu) -> ainda assim mensagem clara, nunca quebra', () => {
    const err = new Error('fetch failed');
    const r = motivoDeErro(err);
    assert.equal(r.motivo, 'erro_api');
    assert.match(r.mensagem, /fetch failed/);
  });
});

// ============================================================
// Parte 2 — integração com Postgres real + API do Mercado Livre mockada.
// ============================================================
const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 950;
const CONTA_ML_ID = 950;
const CONTA_SEM_ANUNCIANTE_ID = 951;

describe(
  'sincronizarContaAds + listarAds — integração com Postgres real (API mockada)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, ml, cryptoLib, adsLib, apiGetReal;

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');
      pool = require('../db/pool');
      ml = require('../lib/mercadolivre');
      cryptoLib = require('../lib/crypto');
      adsLib = require('../lib/ads');
      apiGetReal = ml.apiGet;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'55555555000191','EMPRESA TESTE ADS',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, site_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,950000001,'LOJA COM ADS','MLB',$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc, status='ativa', ultimo_erro=NULL`,
        [CONTA_ML_ID, EMPRESA_ID, cryptoLib.encrypt('fake-access-token'), cryptoLib.encrypt('fake-refresh-token')]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, site_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,951000001,'LOJA SEM ANUNCIANTE','MLB',$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc, status='ativa', ultimo_erro=NULL`,
        [CONTA_SEM_ANUNCIANTE_ID, EMPRESA_ID, cryptoLib.encrypt('fake-access-token'), cryptoLib.encrypt('fake-refresh-token')]
      );
    });

    after(async () => {
      ml.apiGet = apiGetReal;
      await pool.query('DELETE FROM ads_metricas_anuncio WHERE conta_id = ANY($1)', [[CONTA_ML_ID, CONTA_SEM_ANUNCIANTE_ID]]);
      await pool.query('DELETE FROM ads_campanhas WHERE conta_id = ANY($1)', [[CONTA_ML_ID, CONTA_SEM_ANUNCIANTE_ID]]);
      await pool.query('DELETE FROM ads_diario WHERE conta_id = ANY($1)', [[CONTA_ML_ID, CONTA_SEM_ANUNCIANTE_ID]]);
      await pool.query('DELETE FROM ads_contas WHERE conta_id = ANY($1)', [[CONTA_ML_ID, CONTA_SEM_ANUNCIANTE_ID]]);
      await pool.query('DELETE FROM ml_contas WHERE id = ANY($1)', [[CONTA_ML_ID, CONTA_SEM_ANUNCIANTE_ID]]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      await pool.end();
    });

    test('conta SEM anunciante: sincronizarContaAds grava o motivo/mensagem/corpo REAL da API em ads_contas (Passo 1)', async () => {
      ml.apiGet = async (path) => {
        assert.match(path, /\/advertising\/advertisers\?product_id=PADS&user_id=951000001/, 'a checagem de anunciante precisa mandar user_id (correção do Passo 1)');
        const err = new Error('Not Found');
        err.status = 404;
        err.data = { message: 'resource not found', cause: [{ code: 'PADS-404', description: 'No permissions found for user_id' }] };
        throw err;
      };

      const resultado = await adsLib.sincronizarContaAds(CONTA_SEM_ANUNCIANTE_ID);
      assert.equal(resultado.ok, false);

      const { rows } = await pool.query('SELECT * FROM ads_contas WHERE conta_id = $1', [CONTA_SEM_ANUNCIANTE_ID]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].disponivel, false);
      assert.equal(rows[0].motivo, 'sem_anunciante');
      assert.match(rows[0].mensagem, /No permissions found for user_id/, 'a mensagem tem que citar a causa REAL devolvida pela API, nunca um texto genérico solto');
      assert.equal(rows[0].detalhe_api.status, 404);
      assert.deepEqual(rows[0].detalhe_api.corpoResposta, { message: 'resource not found', cause: [{ code: 'PADS-404', description: 'No permissions found for user_id' }] });
    });

    // Investimento distinto por janela de período (date_from na query string) —
    // prova que a sincronização grava cada período-chave (hoje/ontem/7d/30d/
    // mes, ver lib/periodo.js) separadamente, nunca misturando o número de
    // uma janela na outra (ver teste de isolamento logo abaixo).
    const periodoLib = require('../lib/periodo');
    const INVESTIMENTO_POR_CHAVE = { hoje: 1, ontem: 2, '7d': 7, '30d': 30, mes: 99 };
    function chaveDoDesdeStr(desdeStr) {
      for (const chave of Object.keys(INVESTIMENTO_POR_CHAVE)) {
        const { desde } = periodoLib.periodoParaDatasBRT(periodoLib.calcularPeriodo(chave));
        if (desde === desdeStr) return chave;
      }
      return null;
    }

    test('conta COM anunciante: sincronizarContaAds usa os endpoints ATUAIS (com /search e site no path — Passo 1) e grava CADA período separadamente em banco (Passo 2 e 3)', async () => {
      const chamadas = [];
      ml.apiGet = async (path) => {
        chamadas.push(path);
        if (path.startsWith('/advertising/advertisers')) {
          assert.match(path, /user_id=950000001/);
          return { advertisers: [{ advertiser_id: 777, site_id: 'MLB' }] };
        }
        if (path.startsWith('/marketplace/advertising/MLB/advertisers/777/product_ads/campaigns/search')) {
          return { results: [{ id: 555, name: 'Campanha de teste' }], paging: { total: 1 } };
        }
        if (path.startsWith('/marketplace/advertising/MLB/advertisers/777/product_ads/ads')) {
          if (path.includes('aggregation_type=daily')) {
            return { results: [{ date: '2026-08-24', metrics: { cost: 10, total_amount: 40 } }, { date: '2026-08-25', metrics: { cost: 12, total_amount: 50 } }], paging: { total: 2 } };
          }
          const desdeStr = new URLSearchParams(path.split('?')[1]).get('date_from');
          const chave = chaveDoDesdeStr(desdeStr);
          const investimento = chave ? INVESTIMENTO_POR_CHAVE[chave] : 30;
          return {
            results: [{
              item_id: 'MLB111', title: 'Produto Anunciado', campaign_id: 555,
              metrics: { clicks: 20, prints: 400, ctr: 0.05, cost: investimento, cpc: 1.5, acos: 60, cvr: 0.1, roas: 1.67, total_amount: investimento * 2, units_quantity: 3 },
            }],
            paging: { total: 1 },
          };
        }
        throw new Error('mock ml.apiGet: rota não coberta neste teste: ' + path);
      };

      const resultado = await adsLib.sincronizarContaAds(CONTA_ML_ID);
      assert.equal(resultado.ok, true);
      assert.ok(chamadas.some((p) => p.includes('/search')), 'campanhas precisa usar o endpoint novo com /search (formato antigo foi descontinuado)');
      assert.ok(!chamadas.some((p) => /\/\d+\/product_ads\/(items|campaigns)(\?|$)/.test(p)), 'nunca deveria sobrar chamada ao endpoint LEGADO (/{advertiser_id}/product_ads/...)');

      const { rows: contaRows } = await pool.query('SELECT * FROM ads_contas WHERE conta_id = $1', [CONTA_ML_ID]);
      assert.equal(contaRows[0].disponivel, true);
      assert.equal(contaRows[0].advertiser_id, '777');
      assert.equal(contaRows[0].site_id, 'MLB');

      const { rows: campRows } = await pool.query('SELECT * FROM ads_campanhas WHERE conta_id = $1', [CONTA_ML_ID]);
      assert.equal(campRows.length, 1);
      assert.equal(campRows[0].nome, 'Campanha de teste');

      const { rows: metricaRows } = await pool.query(
        "SELECT * FROM ads_metricas_anuncio WHERE conta_id = $1 AND periodo_chave = '30d'",
        [CONTA_ML_ID]
      );
      assert.equal(metricaRows.length, 1);
      assert.equal(Number(metricaRows[0].investimento), 30);
      assert.equal(Number(metricaRows[0].faturamento_atribuido), 60);
      assert.equal(Number(metricaRows[0].qtd_atribuida), 3);
      assert.equal(metricaRows[0].campanha_id, '555');

      const { rows: diarioRows } = await pool.query('SELECT * FROM ads_diario WHERE conta_id = $1 ORDER BY data', [CONTA_ML_ID]);
      assert.ok(diarioRows.length >= 2);
    });

    test('listarAds NUNCA chama a API do Mercado Livre — lê só o que já foi sincronizado (Passo 2)', async () => {
      let chamouApi = false;
      ml.apiGet = async () => { chamouApi = true; throw new Error('listarAds não deveria chamar a API ao vivo'); };

      const periodo = require('../lib/periodo');
      const desde = periodo.inicioDoDiaBRTDeString('2026-08-01');
      const ate = new Date();
      const { desde: desdeStr, ate: ateStr } = periodo.periodoParaDatasBRT({ desde, ate });
      const { desde: mesDesdeStr, ate: mesAteStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('mes'));
      const { desde: hojeStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('hoje'));

      const resultado = await adsLib.listarAds({
        empresaId: EMPRESA_ID, contaId: CONTA_ML_ID, periodoChave: '30d',
        desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr,
      });

      assert.equal(chamouApi, false);
      const linha = resultado.linhas.find((l) => l.mlItemId === 'MLB111');
      assert.ok(linha, 'o anúncio sincronizado precisa aparecer em listarAds, vindo só do banco');
      assert.equal(linha.investimento, 30);
      assert.equal(linha.faturamentoAtribuido, 60);
      assert.equal(linha.campanha, 'Campanha de teste');
      assert.equal(linha.acos, 60, 'quando a API devolve ACOS, usa o valor real da API (nunca recalcula por cima)');

      const situacao = resultado.situacaoPorConta.find((s) => s.contaId === CONTA_ML_ID);
      assert.equal(situacao.disponivel, true);
    });

    test('listarAds nunca mistura o investimento de uma janela na outra — cada período-chave lê só o que foi sincronizado PARA ELE (Passo 3: "nunca inventar")', async () => {
      ml.apiGet = async () => { throw new Error('não deveria chamar a API'); };
      const periodo = require('../lib/periodo');
      const desde = periodo.inicioDoDiaBRTDeString('2026-08-01');
      const ate = new Date();
      const { desde: mesDesdeStr, ate: mesAteStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('mes'));
      const { desde: hojeStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('hoje'));

      for (const [chave, investimentoEsperado] of Object.entries(INVESTIMENTO_POR_CHAVE)) {
        const { desde: desdeStr, ate: ateStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo(chave));
        const resultado = await adsLib.listarAds({
          empresaId: EMPRESA_ID, contaId: CONTA_ML_ID, periodoChave: chave,
          desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr,
        });
        const linha = resultado.linhas.find((l) => l.mlItemId === 'MLB111');
        assert.ok(linha, `período '${chave}' deveria ter o anúncio sincronizado`);
        assert.equal(linha.investimento, investimentoEsperado, `período '${chave}' misturou investimento de outra janela`);
      }
    });
  }
);
