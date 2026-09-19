// Testes de ORQUESTRAÇÃO do agendamento automático da Daily dos Agentes —
// Etapa 4 (19/09/2026, pedido explícito do usuário: "resumo diário... pelo
// WhatsApp"). Mesmo padrão de test/adsScheduler.test.js: usa
// executarDailyComNotificacaoFn/buscarEmpresasAtivasFn INJETADAS (nunca as
// reais, que tocariam banco/Twilio), testando só a orquestração — o "ainda
// não é a hora configurada" nunca chama nada, ciclos sobrepostos são
// travados, e uma empresa com erro nunca derruba as demais.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { executarCicloDaily } = require('../lib/ia/dailyScheduler');

describe('dailyScheduler — orquestração do agendamento automático (Etapa 4)', () => {
  test('antes do horário configurado (padrão 9h Brasília): não busca empresas nem chama a Daily de ninguém', async () => {
    let chamouBuscarEmpresas = false;
    const status = await executarCicloDaily({
      agora: new Date('2026-09-19T11:30:00Z'), // 08:30 em Brasília (UTC-3) — ainda antes das 9h
      buscarEmpresasAtivasFn: async () => { chamouBuscarEmpresas = true; return [1, 2]; },
      executarDailyComNotificacaoFn: async () => { throw new Error('não deveria rodar antes da hora'); },
    });
    assert.equal(chamouBuscarEmpresas, false);
    assert.equal(status.horaJaChegouHoje, false);
    assert.equal(status.empresasProcessadas, 0);
    assert.equal(status.empresasNotificadas, 0);
    assert.equal(status.ultimoCicloOk, true);
  });

  test('depois do horário configurado: roda a Daily de cada empresa ativa e conta quantas foram notificadas de verdade por WhatsApp', async () => {
    const status = await executarCicloDaily({
      agora: new Date('2026-09-19T13:00:00Z'), // 10:00 em Brasília — já passou das 9h
      buscarEmpresasAtivasFn: async () => [10, 20, 30],
      executarDailyComNotificacaoFn: async (empresaId) => {
        if (empresaId === 10) return { empresaId, whatsapp: { enviado: true } };
        if (empresaId === 20) return { empresaId, whatsapp: { enviado: false, motivo: 'nao_configurado' } };
        return { empresaId, pulado: true, motivo: 'ja_enviado_hoje' }; // empresa 30 já tinha recebido hoje
      },
    });
    assert.equal(status.horaJaChegouHoje, true);
    assert.equal(status.empresasProcessadas, 3, 'as 3 empresas rodaram (mesmo a que só foi pulada por já ter enviado hoje)');
    assert.equal(status.empresasNotificadas, 1, 'só 1 empresa recebeu WhatsApp de verdade neste ciclo');
    assert.equal(status.ultimoCicloOk, true);
  });

  test('uma empresa que falha (rejeita) não derruba o ciclo das demais — Promise.allSettled', async () => {
    const status = await executarCicloDaily({
      agora: new Date('2026-09-19T13:00:00Z'),
      buscarEmpresasAtivasFn: async () => [1, 2],
      executarDailyComNotificacaoFn: async (empresaId) => {
        if (empresaId === 1) throw new Error('falha proposital');
        return { empresaId, whatsapp: { enviado: true } };
      },
    });
    assert.equal(status.empresasProcessadas, 1, 'só a empresa que não falhou conta como processada');
    assert.equal(status.empresasNotificadas, 1);
    assert.equal(status.ultimoCicloOk, true, 'uma falha isolada de empresa não marca o ciclo inteiro como erro');
  });

  test('um erro geral (ex.: falha ao buscar empresas ativas) marca ultimoCicloOk=false, mas não lança pra quem chamou', async () => {
    const status = await executarCicloDaily({
      agora: new Date('2026-09-19T13:00:00Z'),
      buscarEmpresasAtivasFn: async () => { throw new Error('banco fora do ar'); },
      executarDailyComNotificacaoFn: async () => { throw new Error('não deveria rodar'); },
    });
    assert.equal(status.ultimoCicloOk, false);
    assert.match(status.ultimoErroGeral, /banco fora do ar/);
  });

  test('trava contra ciclos sobrepostos: um 2º disparo enquanto o 1º ainda está rodando é pulado (retorna null)', async () => {
    let liberarPrimeiro;
    const primeiroTravado = new Promise((resolve) => { liberarPrimeiro = resolve; });

    const p1 = executarCicloDaily({
      agora: new Date('2026-09-19T13:00:00Z'),
      buscarEmpresasAtivasFn: async () => { await primeiroTravado; return [1]; },
      executarDailyComNotificacaoFn: async (empresaId) => ({ empresaId, whatsapp: { enviado: true } }),
    });
    await new Promise((r) => setImmediate(r)); // dá um tick pro emExecucao virar true antes do 2º disparo

    const resultado2 = await executarCicloDaily({
      agora: new Date('2026-09-19T13:00:00Z'),
      buscarEmpresasAtivasFn: async () => { throw new Error('não deveria rodar'); },
    });
    assert.equal(resultado2, null, 'um ciclo já em andamento deve fazer o próximo disparo ser pulado, nunca rodar em paralelo');

    liberarPrimeiro();
    const status1 = await p1;
    assert.equal(status1.horaJaChegouHoje, true);
  });
});
