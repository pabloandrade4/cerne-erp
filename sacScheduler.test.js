// Testes de ORQUESTRAÇÃO do ciclo automático dos Agentes de SAC
// (lib/ia/sacScheduler.js — 15/09/2026, pedido explícito do usuário: "nao
// quero ter que ficar sincronizando nada quero tudo automatico"). Mesmo
// padrão de test/adsScheduler.test.js: usa as funções de ciclo do Mercado
// Livre/Shopee INJETADAS (nunca as reais, que chamariam a API de verdade
// e o banco), testando só a orquestração — trava contra ciclos
// sobrepostos, Mercado Livre e Shopee rodam ISOLADOS (um falhar nunca
// impede o outro), e um ciclo com erro não pode impedir o próximo. A
// cobertura do ciclo de verdade (dado real gravado em sac_atendimentos)
// está em test/sac.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { executarCiclo, obterStatusScheduler } = require('../lib/ia/sacScheduler');

describe('sacScheduler — orquestração do ciclo automático dos Agentes de SAC', () => {
  test('um ciclo com Mercado Livre e Shopee OK marca ultimoCicloOk=true e guarda os dois resultados', async () => {
    const status = await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => ({ empresasProcessadas: 2, atendimentosNovos: 3, sugestoesGeradas: 3, comErro: [] }),
      executarCicloSacShopeeFn: async () => ({ empresasProcessadas: 2, atendimentosNovos: 1, sugestoesGeradas: 1, comErro: [] }),
    });
    assert.equal(status.ultimoCicloOk, true);
    assert.equal(status.mercadoLivre.atendimentosNovos, 3);
    assert.equal(status.shopee.atendimentosNovos, 1);
  });

  test('Mercado Livre falhando por completo não impede o ciclo do Shopee no mesmo disparo (isolados)', async () => {
    const status = await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => { throw new Error('API do Mercado Livre fora do ar'); },
      executarCicloSacShopeeFn: async () => ({ empresasProcessadas: 1, atendimentosNovos: 2, sugestoesGeradas: 2, comErro: [] }),
    });
    assert.equal(status.ultimoCicloOk, false);
    assert.equal(status.mercadoLivre.comErro.length, 1);
    assert.match(status.mercadoLivre.comErro[0].erro, /fora do ar/);
    // Shopee rodou normal, sem nenhum efeito colateral do Mercado Livre ter falhado
    assert.equal(status.shopee.comErro.length, 0);
    assert.equal(status.shopee.atendimentosNovos, 2);
  });

  test('Shopee falhando por completo não impede o ciclo do Mercado Livre no mesmo disparo (isolados)', async () => {
    const status = await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => ({ empresasProcessadas: 1, atendimentosNovos: 5, sugestoesGeradas: 5, comErro: [] }),
      executarCicloSacShopeeFn: async () => { throw new Error('token Shopee expirado'); },
    });
    assert.equal(status.ultimoCicloOk, false);
    assert.equal(status.mercadoLivre.comErro.length, 0);
    assert.equal(status.mercadoLivre.atendimentosNovos, 5);
    assert.equal(status.shopee.comErro.length, 1);
    assert.match(status.shopee.comErro[0].erro, /token Shopee expirado/);
  });

  test('um ciclo com erro não impede o PRÓXIMO ciclo de rodar normalmente', async () => {
    const statusComErro = await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => { throw new Error('falha proposital'); },
      executarCicloSacShopeeFn: async () => { throw new Error('falha proposital'); },
    });
    assert.equal(statusComErro.ultimoCicloOk, false);

    const statusOk = await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => ({ empresasProcessadas: 1, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] }),
      executarCicloSacShopeeFn: async () => ({ empresasProcessadas: 1, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] }),
    });
    assert.equal(statusOk.ultimoCicloOk, true, 'o próximo ciclo precisa rodar normalmente mesmo depois de um ciclo com erro');
  });

  test('trava contra ciclos sobrepostos: um 2º disparo enquanto o 1º ainda está rodando é pulado (retorna null)', async () => {
    let liberarPrimeiro;
    const primeiroTravado = new Promise((resolve) => { liberarPrimeiro = resolve; });

    const p1 = executarCiclo({
      executarCicloSacMercadoLivreFn: async () => { await primeiroTravado; return { empresasProcessadas: 1, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] }; },
      executarCicloSacShopeeFn: async () => { await primeiroTravado; return { empresasProcessadas: 1, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] }; },
    });
    await new Promise((r) => setImmediate(r)); // dá um tick pro emExecucao virar true antes do 2º disparo

    const resultado2 = await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => { throw new Error('não deveria rodar'); },
      executarCicloSacShopeeFn: async () => { throw new Error('não deveria rodar'); },
    });
    assert.equal(resultado2, null, 'um ciclo já em andamento deve fazer o próximo disparo ser pulado, nunca rodar em paralelo');

    liberarPrimeiro();
    const status1 = await p1;
    assert.equal(status1.ultimoCicloOk, true);
  });

  test('obterStatusScheduler nunca vaza a referência interna do estado (comErro é uma cópia)', async () => {
    await executarCiclo({
      executarCicloSacMercadoLivreFn: async () => { throw new Error('erro pra testar imutabilidade'); },
      executarCicloSacShopeeFn: async () => ({ empresasProcessadas: 0, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] }),
    });
    const status = obterStatusScheduler();
    status.mercadoLivre.comErro.push({ empresaId: 999, erro: 'injetado no teste' });
    const statusDeNovo = obterStatusScheduler();
    assert.equal(statusDeNovo.mercadoLivre.comErro.length, 1, 'mutar o objeto devolvido não pode afetar o estado interno do scheduler');
  });
});
