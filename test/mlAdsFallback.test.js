// Testes PUROS (sem banco, sem rede) do fallback de endpoint de Product Ads
// adicionado em 26/08/2026 depois de uma evidência REAL de produção: a
// conta PFEMBALAGEMS (empresa 2, advertiser_id 753060, site MLB) tem
// anunciante confirmado, mas o endpoint "novo"
// (/marketplace/advertising/{site}/advertisers/{id}/product_ads/ads)
// respondeu 404 mesmo assim — ver comentário em lib/mlAds.js. Este teste
// mocka `lib/mercadolivre.js#apiGet` (nunca chama a API real) pra garantir
// que: 1) um 404 no formato novo tenta o formato clássico antes de desistir;
// 2) um erro que NÃO é 404 (401/403/500) nunca tenta o clássico — não faria
// sentido tentar outro caminho pra um erro de acesso/infra; 3) a mensagem
// de erro nunca mais diz "sem anunciante" quando o anunciante já foi
// confirmado antes (bug real encontrado nesta sessão).
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ml = require('../lib/mercadolivre');
const { buscarItensComMetricas, motivoDeErro } = require('../lib/mlAds');

describe('mlAds — fallback do endpoint novo para o clássico', () => {
  let apiGetOriginal;
  beforeEach(() => { apiGetOriginal = ml.apiGet; });
  afterEach(() => { ml.apiGet = apiGetOriginal; });

  test('404 no endpoint novo tenta o clássico e usa o resultado se ele funcionar', async () => {
    const chamadas = [];
    ml.apiGet = async (path) => {
      chamadas.push(path);
      if (path.startsWith('/marketplace/advertising/')) {
        const err = new Error('resource not found');
        err.status = 404;
        err.data = { error: 'resource not found', message: 'Si quieres conocer los recursos...' };
        throw err;
      }
      if (path.startsWith('/753060/product_ads/items')) {
        return { results: [{ item_id: 'MLB1', metrics: { clicks: 5, cost: 10 } }], paging: { total: 1 } };
      }
      throw new Error('path inesperado: ' + path);
    };

    const r = await buscarItensComMetricas({ accessToken: 'tok', siteId: 'MLB', advertiserId: '753060', desde: '2026-08-01', ate: '2026-08-26' });
    assert.equal(r.formatoEndpoint, 'classico');
    assert.equal(r.itens.length, 1);
    assert.equal(r.itens[0].item_id, 'MLB1');
    assert.equal(chamadas.length, 2, 'tentou o novo primeiro, depois o clássico');
    assert.match(chamadas[0], /^\/marketplace\/advertising\//);
    // CORREÇÃO (11/09/2026): o formato clássico real NÃO tem prefixo `/v1/`
    // — testado ao vivo contra a conta PFEMBALAGEMS, ver lib/mlAds.js.
    assert.match(chamadas[1], /^\/753060\/product_ads\/items/);
  });

  test('erro 401/403 (sem acesso) NUNCA tenta o formato clássico — não é um problema de endpoint errado', async () => {
    const chamadas = [];
    ml.apiGet = async (path) => {
      chamadas.push(path);
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    };
    await assert.rejects(
      () => buscarItensComMetricas({ accessToken: 'tok', siteId: 'MLB', advertiserId: '753060', desde: '2026-08-01', ate: '2026-08-26' }),
      (err) => { assert.equal(err.status, 403); return true; }
    );
    assert.equal(chamadas.length, 1, 'nunca tenta o clássico pra um erro que não é 404');
  });

  test('quando os dois formatos falham com 404, o erro final ainda é 404 e carrega o detalhe do clássico também', async () => {
    ml.apiGet = async (path) => {
      const err = new Error('resource not found');
      err.status = 404;
      err.data = { message: 'not found' };
      throw err;
    };
    await assert.rejects(
      () => buscarItensComMetricas({ accessToken: 'tok', siteId: 'MLB', advertiserId: '753060', desde: '2026-08-01', ate: '2026-08-26' }),
      (err) => {
        assert.equal(err.status, 404);
        assert.ok(err.detalheFormatoClassico, 'guarda o detalhe da tentativa clássica também, nunca esconde que os dois foram tentados');
        return true;
      }
    );
  });

  test('CORREÇÃO (11/09/2026): o corpo REAL da resposta do formato clássico chega em detalheFormatoClassico.corpoResposta (antes só endpoint/status/mensagem curta)', async () => {
    ml.apiGet = async (path) => {
      if (path.startsWith('/marketplace/advertising/')) {
        const err = new Error('resource not found');
        err.status = 404;
        err.data = { message: 'not found (novo)' };
        throw err;
      }
      const err = new Error('resource not found classico');
      err.status = 404;
      err.data = { message: 'Si quieres conocer los recursos de la API...', cause: [{ code: 'X', description: 'motivo real' }] };
      throw err;
    };
    await assert.rejects(
      () => buscarItensComMetricas({ accessToken: 'tok', siteId: 'MLB', advertiserId: '753060', desde: '2026-08-01', ate: '2026-08-26' }),
      (err) => {
        assert.deepEqual(err.detalheFormatoClassico.corpoResposta, { message: 'Si quieres conocer los recursos de la API...', cause: [{ code: 'X', description: 'motivo real' }] });
        assert.match(err.detalheFormatoClassico.endpoint, /^\/753060\/product_ads\/items/);
        return true;
      }
    );
  });
});

describe('mlAds — motivoDeErro inclui o detalhe do formato clássico quando disponível', () => {
  test('detalheApi.formatoClassico carrega o corpo completo da tentativa clássica, nunca só um texto curto', () => {
    const errNovo = new Error('not found'); errNovo.status = 404;
    errNovo.detalheFormatoClassico = { endpoint: '/753060/product_ads/items?x', status: 404, mensagem: 'not found classico', corpoResposta: { message: 'motivo real da API' } };
    const r = motivoDeErro(errNovo, { advertiserJaConfirmado: true, advertiserId: '753060' });
    assert.deepEqual(r.detalheApi.formatoClassico.corpoResposta, { message: 'motivo real da API' });
  });
});

describe('mlAds — motivoDeErro cita as DUAS causas possíveis da mensagem genérica de rota, nunca afirma uma só (correção 11/09/2026: a hipótese "sempre é falta de permissão" foi TESTADA e refutada — a conta PFEMBALAGEMS tinha a permissão "Advertising" habilitada e mesmo assim recebeu essa mensagem)', () => {
  const CORPO_GENERICO_ROTA = { error: 'resource not found', message: 'Si quieres conocer los recursos de la API que se encuentran disponibles visita el Sitio de Desarrolladores de MercadoLibre (http://developers.mercadolibre.com)' };

  test('os dois formatos (novo e clássico) respondendo a MESMA mensagem genérica de rota -> continua sem_anuncios_ads, mas a mensagem cita as duas causas possíveis (sem anúncio ativo OU token desatualizado)', () => {
    const errNovo = new Error('not found'); errNovo.status = 404; errNovo.data = CORPO_GENERICO_ROTA;
    errNovo.detalheFormatoClassico = { endpoint: '/753060/product_ads/items?x', status: 404, mensagem: CORPO_GENERICO_ROTA.message, corpoResposta: CORPO_GENERICO_ROTA };
    const r = motivoDeErro(errNovo, { advertiserJaConfirmado: true, advertiserId: '753060' });
    assert.equal(r.motivo, 'sem_anuncios_ads');
    assert.match(r.mensagem, /nenhum anúncio patrocinado ativo/);
    assert.match(r.mensagem, /token de acesso desta conta foi gerado antes/);
  });

  test('404 com mensagem ESPECÍFICA (não a genérica de rota) usa a mensagem padrão de sem_anuncios_ads, sem citar as duas causas da genérica', () => {
    const errNovo = new Error('not found'); errNovo.status = 404; errNovo.data = { message: 'No active campaigns found for this advertiser in the given period' };
    errNovo.detalheFormatoClassico = { endpoint: '/753060/product_ads/items?x', status: 404, mensagem: 'idem', corpoResposta: { message: 'No active campaigns found for this advertiser in the given period' } };
    const r = motivoDeErro(errNovo, { advertiserJaConfirmado: true, advertiserId: '753060' });
    assert.equal(r.motivo, 'sem_anuncios_ads');
    assert.doesNotMatch(r.mensagem, /token de acesso desta conta foi gerado antes/);
  });

  test('sem detalheFormatoClassico (só um formato foi tentado) mas com a mensagem genérica -> ainda assim cita as duas causas', () => {
    const errNovo = new Error('not found'); errNovo.status = 404; errNovo.data = CORPO_GENERICO_ROTA;
    const r = motivoDeErro(errNovo, { advertiserJaConfirmado: true, advertiserId: '753060' });
    assert.equal(r.motivo, 'sem_anuncios_ads');
    assert.match(r.mensagem, /token de acesso desta conta foi gerado antes/);
  });
});

describe('mlAds — motivoDeErro nunca diz "sem anunciante" quando o anunciante já foi confirmado', () => {
  test('404 comum (sem contexto) continua sendo "sem_anunciante"', () => {
    const err = new Error('not found'); err.status = 404;
    const r = motivoDeErro(err);
    assert.equal(r.motivo, 'sem_anunciante');
    assert.match(r.mensagem, /Nenhuma conta de anunciante/);
  });

  test('404 com advertiserJaConfirmado=true vira "sem_anuncios_ads", nunca "sem anunciante" (bug real corrigido 26/08/2026)', () => {
    const err = new Error('not found'); err.status = 404;
    const r = motivoDeErro(err, { advertiserJaConfirmado: true, advertiserId: '753060' });
    assert.equal(r.motivo, 'sem_anuncios_ads');
    assert.doesNotMatch(r.mensagem, /Nenhuma conta de anunciante/, 'nunca deve alegar que não há anunciante quando ele já foi confirmado');
    assert.match(r.mensagem, /753060/, 'cita o advertiser_id real confirmado, pra não ficar genérico');
  });
});
