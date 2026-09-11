// Testes de ORQUESTRAÇÃO do ciclo automático de sincronização de Ads
// (lib/adsScheduler.js — Passo 2 do pedido do usuário: sincronização em
// BACKEND, nunca dependendo do navegador aberto). Mesmo padrão de
// test/syncScheduler.test.js: usa sincronizarTodasAsContasAdsFn injetada
// (nunca a função real, que chamaria a API do Mercado Livre), testando só
// a orquestração — trava contra ciclos sobrepostos, e um ciclo com erro não
// pode impedir o próximo. A cobertura da sincronização de verdade (dados
// reais gravados em ads_contas/ads_metricas_anuncio) está em
// test/mlAds.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { executarCicloDeSincronizacaoAds } = require('../lib/adsScheduler');

describe('adsScheduler — orquestração do ciclo automático de Product Ads', () => {
  test('um ciclo com erro geral não impede o PRÓXIMO ciclo de rodar normalmente', async () => {
    const statusComErro = await executarCicloDeSincronizacaoAds({
      sincronizarTodasAsContasAdsFn: async () => { throw new Error('falha proposital'); },
    });
    assert.equal(statusComErro.ultimoCicloOk, false);
    assert.match(statusComErro.ultimoErroGeral, /falha proposital/);

    const statusOk = await executarCicloDeSincronizacaoAds({
      sincronizarTodasAsContasAdsFn: async () => ({ contasProcessadas: 3, comErro: [] }),
    });
    assert.equal(statusOk.ultimoCicloOk, true, 'o próximo ciclo precisa rodar normalmente mesmo depois de um ciclo com erro');
    assert.equal(statusOk.contasProcessadas, 3);
  });

  test('uma conta com erro dentro do ciclo não marca o ciclo inteiro como travado — só ultimoCicloOk=false, contasComErro preenchido', async () => {
    const status = await executarCicloDeSincronizacaoAds({
      sincronizarTodasAsContasAdsFn: async () => ({ contasProcessadas: 2, comErro: [{ contaId: 950, erro: 'sem_anunciante' }] }),
    });
    assert.equal(status.ultimoCicloOk, false);
    assert.equal(status.contasComErro.length, 1);
    assert.equal(status.contasComErro[0].contaId, 950);
  });

  test('trava contra ciclos sobrepostos: um 2º disparo enquanto o 1º ainda está rodando é pulado (retorna null)', async () => {
    let liberarPrimeiro;
    const primeiroTravado = new Promise((resolve) => { liberarPrimeiro = resolve; });

    const p1 = executarCicloDeSincronizacaoAds({
      sincronizarTodasAsContasAdsFn: async () => { await primeiroTravado; return { contasProcessadas: 1, comErro: [] }; },
    });
    await new Promise((r) => setImmediate(r)); // dá um tick pro emExecucao virar true antes do 2º disparo

    const resultado2 = await executarCicloDeSincronizacaoAds({
      sincronizarTodasAsContasAdsFn: async () => { throw new Error('não deveria rodar'); },
    });
    assert.equal(resultado2, null, 'um ciclo já em andamento deve fazer o próximo disparo ser pulado, nunca rodar em paralelo');

    liberarPrimeiro();
    const status1 = await p1;
    assert.equal(status1.ultimoCicloOk, true);
  });
});
