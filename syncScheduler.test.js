// Testes de INTEGRAÇÃO (precisa de Postgres local — DATABASE_URL, ver
// comentário em relatorioVendas.integration.test.js pra como preparar) da
// ORQUESTRAÇÃO do ciclo de sincronização automática (lib/syncScheduler.js —
// Tarefa "corrigir sincronização do Mercado Livre", 3 passos pedidos pelo
// usuário: 1) automática no backend a cada 1 minuto; 2) nunca duplicar/
// misturar pedidos entre contas; 3) um erro numa conta nunca pode
// interromper as próximas nem os próximos ciclos).
//
// Usa sincronizarContaFn injetada (não a sincronizarConta real) — testa só
// a ORQUESTRAÇÃO (quais contas entram no ciclo, isolamento de erro, trava
// contra ciclos sobrepostos), sem precisar de credenciais nem chamadas
// reais ao Mercado Livre. A cobertura da IMPORTAÇÃO/idempotência de
// verdade (nunca duplicar um pedido) está em
// mlSync.reconciliacao.integration.test.js, usando a função real com a API
// do Mercado Livre mockada.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// CORREÇÃO (01/09/2026, diagnóstico do Ads/sync travando — ver
// docs/04-alteracoes.md): watchdog por conta, testado abaixo — precisa de
// um timeout BEM curto pro teste não demorar os 5min padrão de produção.
// Tem que ser setado antes de `require('../lib/syncScheduler')` (lido uma
// vez só, no carregamento do módulo).
process.env.ML_SYNC_TIMEOUT_POR_CONTA_MS = '150';

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_A = 920;
const EMPRESA_B = 921;
const CONTA_ATIVA = 920; // empresa 920 — deve entrar no ciclo
const CONTA_ERRO = 921; // empresa 921, status='erro' — nunca deve entrar
const CONTA_DESCONECTADA = 922; // empresa 921, status='desconectada' — nunca deve entrar

describe(
  'syncScheduler — orquestração do ciclo automático',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool, executarCicloDeSincronizacao;

    before(async () => {
      pool = require('../db/pool');
      ({ executarCicloDeSincronizacao } = require('../lib/syncScheduler'));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'22222222000191','EMPRESA TESTE SCHEDULER A',TRUE), ($2,'33333333000191','EMPRESA TESTE SCHEDULER B',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_A, EMPRESA_B]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES
           ($1, $2, 910000001, 'x', 'x', now() + interval '6 hours', 'ativa'),
           ($3, $4, 910000002, 'x', 'x', now() + interval '6 hours', 'erro'),
           ($5, $4, 910000003, 'x', 'x', now() + interval '6 hours', 'desconectada')
         ON CONFLICT (id) DO NOTHING`,
        [CONTA_ATIVA, EMPRESA_A, CONTA_ERRO, EMPRESA_B, CONTA_DESCONECTADA]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM ml_contas WHERE id = ANY($1)', [[CONTA_ATIVA, CONTA_ERRO, CONTA_DESCONECTADA]]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
      await pool.end();
    });

    test('só chama sincronização para contas com status = ativa (nunca erro/desconectada)', async () => {
      const chamadas = [];
      const status = await executarCicloDeSincronizacao({
        sincronizarContaFn: async (contaId) => { chamadas.push(contaId); },
      });
      assert.ok(chamadas.includes(CONTA_ATIVA), 'conta ativa deveria ter sido chamada');
      assert.ok(!chamadas.includes(CONTA_ERRO), 'conta com status=erro nunca deveria ser chamada automaticamente');
      assert.ok(!chamadas.includes(CONTA_DESCONECTADA), 'conta desconectada nunca deveria ser chamada');
      assert.equal(status.ultimoCicloOk, true);
    });

    test('uma conta falhando nunca impede as outras (isolamento) nem mistura empresa/conta no erro reportado', async () => {
      // Simula 2 contas ativas nesse ciclo: reaproveita CONTA_ERRO temporariamente como "ativa" pra ter 2 no ciclo
      await pool.query(`UPDATE ml_contas SET status='ativa' WHERE id=$1`, [CONTA_ERRO]);
      try {
        const status = await executarCicloDeSincronizacao({
          sincronizarContaFn: async (contaId) => {
            if (contaId === CONTA_ERRO) throw new Error('falha simulada nesta conta');
            return 'ok';
          },
        });
        // Não afirma um total exato de contas processadas: a mesma conta
        // 900 (fixture compartilhada por outros arquivos de teste) também
        // pode estar com status='ativa' ao mesmo tempo, então o ciclo real
        // processa "2 ou mais" — o que importa aqui é que a conta que
        // falhou aparece isolada, sem afetar a conta que não falhou.
        assert.ok(status.contasProcessadas >= 2, 'esperava pelo menos as 2 contas deste teste no ciclo');
        assert.equal(status.ultimoCicloOk, false);
        const erro = status.contasComErro.find((c) => c.contaId === CONTA_ERRO);
        assert.ok(erro, 'a conta que falhou deveria estar em contasComErro');
        assert.equal(erro.empresaId, EMPRESA_B, 'o erro reportado precisa apontar pra empresa certa (nunca misturar)');
        assert.ok(!status.contasComErro.find((c) => c.contaId === CONTA_ATIVA), 'a conta que NÃO falhou não pode aparecer como erro (isolamento)');
      } finally {
        await pool.query(`UPDATE ml_contas SET status='erro' WHERE id=$1`, [CONTA_ERRO]);
      }
    });

    test('um ciclo com erro não impede o PRÓXIMO ciclo de rodar normalmente', async () => {
      const statusComErro = await executarCicloDeSincronizacao({
        sincronizarContaFn: async () => { throw new Error('falha proposital'); },
      });
      assert.equal(statusComErro.ultimoCicloOk, false);

      const statusOk = await executarCicloDeSincronizacao({
        sincronizarContaFn: async () => 'ok',
      });
      assert.equal(statusOk.ultimoCicloOk, true, 'o próximo ciclo precisa rodar normalmente mesmo depois de um ciclo com erro');
    });

    test('trava contra ciclos sobrepostos: um 2º disparo enquanto o 1º ainda está rodando é pulado (retorna null)', async () => {
      let liberarPrimeiro;
      const primeiroTravado = new Promise((resolve) => { liberarPrimeiro = resolve; });

      const p1 = executarCicloDeSincronizacao({ sincronizarContaFn: async () => primeiroTravado });
      await new Promise((r) => setImmediate(r)); // dá um tick pro emExecucao virar true antes do 2º disparo

      const resultado2 = await executarCicloDeSincronizacao({ sincronizarContaFn: async () => 'nao deveria rodar' });
      assert.equal(resultado2, null, 'um ciclo já em andamento deve fazer o próximo disparo ser pulado, nunca rodar em paralelo');

      liberarPrimeiro();
      const status1 = await p1;
      assert.equal(status1.ultimoCicloOk, true);
    });

    // CORREÇÃO (01/09/2026, ver docs/04-alteracoes.md): reproduz em miniatura
    // o incidente real de produção — o ciclo ficou travado (`emExecucao`
    // nunca voltou a `false`) por mais de 34 HORAS seguidas porque
    // Promise.allSettled só resolve quando TODAS as promises terminam, e uma
    // conta cuja sincronização nunca resolve/rejeita (aqui simulada por uma
    // promise que nunca termina) travava o ciclo inteiro pra sempre. Este
    // teste prova que o watchdog por conta (comTimeout, TIMEOUT_POR_CONTA_MS
    // = 150ms neste teste) resolve o ciclo mesmo assim, e que o PRÓXIMO
    // ciclo consegue rodar depois (nunca mais fica pulando pra sempre).
    test('uma conta cuja sincronização NUNCA resolve/rejeita não trava o ciclo pra sempre (watchdog) — reproduz o incidente real de 34h em produção', async () => {
      const status = await executarCicloDeSincronizacao({
        // Nunca resolve nem rejeita — exatamente o cenário observado em
        // produção (uma query sem timeout, presa esperando um lock/conexão).
        sincronizarContaFn: async () => new Promise(() => {}),
      });
      assert.ok(status, 'o ciclo precisa terminar (não pode ficar pendurado pra sempre esperando a conta travada)');
      assert.equal(status.ultimoCicloOk, false, 'a conta travada deve contar como erro (abortada pelo watchdog), nunca como sucesso');
      assert.ok(
        status.contasComErro.some((c) => /excedeu/i.test(c.erro || '')),
        'o erro reportado precisa deixar claro que foi o watchdog (timeout) que abortou, não um erro real do Mercado Livre'
      );

      // E o ciclo SEGUINTE precisa rodar normalmente — sem isso, o guard
      // `estado.emExecucao` ficaria preso em `true` pra sempre, exatamente
      // como em produção.
      const statusSeguinte = await executarCicloDeSincronizacao({
        sincronizarContaFn: async () => 'ok',
      });
      assert.notEqual(statusSeguinte, null, 'o ciclo seguinte não pode ser pulado — o watchdog precisa ter liberado emExecucao');
      assert.equal(statusSeguinte.ultimoCicloOk, true);
    });
  }
);
