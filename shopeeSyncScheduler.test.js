// Testes de INTEGRAÇÃO (precisa de Postgres local — DATABASE_URL, ver
// comentário em relatorioVendas.integration.test.js pra como preparar) da
// ORQUESTRAÇÃO do ciclo de sincronização automática da Shopee
// (lib/shopeeSyncScheduler.js — 14/09/2026, pedido explícito do usuário
// depois de ver a sincronização manual funcionar em produção: "pode
// construir isso na Shopee igual ao mercado livre"). Mesmo espírito de
// test/syncScheduler.test.js (Mercado Livre): 1) automática no backend, sem
// depender de clique; 2) nunca duplicar/misturar pedidos entre lojas/
// empresas; 3) um erro numa loja nunca pode interromper as próximas nem os
// próximos ciclos.
//
// Usa sincronizarContaFn injetada (não a sincronizarConta real) — testa só
// a ORQUESTRAÇÃO (quais lojas entram no ciclo, isolamento de erro, trava
// contra ciclos sobrepostos), sem precisar de credenciais nem chamadas
// reais à Shopee. A cobertura da IMPORTAÇÃO/idempotência de verdade (nunca
// duplicar um pedido) está em test/shopeeSync.test.js, usando a função real
// com a API da Shopee mockada.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Mesmo motivo de test/syncScheduler.test.js: watchdog por loja, testado
// abaixo — precisa de um timeout BEM curto pro teste não demorar os 4min
// padrão de produção. Tem que ser setado antes de
// require('../lib/shopeeSyncScheduler') (lido uma vez só, no carregamento
// do módulo).
process.env.SHOPEE_SYNC_TIMEOUT_POR_CONTA_MS = '150';

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_A = 940;
const EMPRESA_B = 941;
const CONTA_ATIVA = 940; // empresa 940 — deve entrar no ciclo
const CONTA_ERRO = 941; // empresa 941, status='erro' — nunca deve entrar
const CONTA_DESCONECTADA = 942; // empresa 941, status='desconectada' — nunca deve entrar

describe(
  'shopeeSyncScheduler — orquestração do ciclo automático',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool, executarCicloDeSincronizacao;

    before(async () => {
      pool = require('../db/pool');
      ({ executarCicloDeSincronizacao } = require('../lib/shopeeSyncScheduler'));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'44444444000191','EMPRESA TESTE SHOPEE SCHEDULER A',TRUE), ($2,'55555555000191','EMPRESA TESTE SHOPEE SCHEDULER B',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_A, EMPRESA_B]
      );
      await pool.query(
        `INSERT INTO shopee_contas (id, empresa_id, shopee_shop_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES
           ($1, $2, 940000001, 'x', 'x', now() + interval '4 hours', 'ativa'),
           ($3, $4, 940000002, 'x', 'x', now() + interval '4 hours', 'erro'),
           ($5, $4, 940000003, 'x', 'x', now() + interval '4 hours', 'desconectada')
         ON CONFLICT (id) DO NOTHING`,
        [CONTA_ATIVA, EMPRESA_A, CONTA_ERRO, EMPRESA_B, CONTA_DESCONECTADA]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM shopee_contas WHERE id = ANY($1)', [[CONTA_ATIVA, CONTA_ERRO, CONTA_DESCONECTADA]]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
      await pool.end();
    });

    test('só chama sincronização para lojas com status = ativa (nunca erro/desconectada)', async () => {
      const chamadas = [];
      const status = await executarCicloDeSincronizacao({
        sincronizarContaFn: async (contaId) => { chamadas.push(contaId); },
      });
      assert.ok(chamadas.includes(CONTA_ATIVA), 'loja ativa deveria ter sido chamada');
      assert.ok(!chamadas.includes(CONTA_ERRO), 'loja com status=erro nunca deveria ser chamada automaticamente');
      assert.ok(!chamadas.includes(CONTA_DESCONECTADA), 'loja desconectada nunca deveria ser chamada');
      assert.equal(status.ultimoCicloOk, true);
    });

    test('uma loja falhando nunca impede as outras (isolamento) nem mistura empresa/loja no erro reportado', async () => {
      // Simula 2 lojas ativas nesse ciclo: reaproveita CONTA_ERRO temporariamente como "ativa" pra ter 2 no ciclo
      await pool.query(`UPDATE shopee_contas SET status='ativa' WHERE id=$1`, [CONTA_ERRO]);
      try {
        const status = await executarCicloDeSincronizacao({
          sincronizarContaFn: async (contaId) => {
            if (contaId === CONTA_ERRO) throw new Error('falha simulada nesta loja');
            return 'ok';
          },
        });
        assert.ok(status.contasProcessadas >= 2, 'esperava pelo menos as 2 lojas deste teste no ciclo');
        assert.equal(status.ultimoCicloOk, false);
        const erro = status.contasComErro.find((c) => c.contaId === CONTA_ERRO);
        assert.ok(erro, 'a loja que falhou deveria estar em contasComErro');
        assert.equal(erro.empresaId, EMPRESA_B, 'o erro reportado precisa apontar pra empresa certa (nunca misturar)');
        assert.ok(!status.contasComErro.find((c) => c.contaId === CONTA_ATIVA), 'a loja que NÃO falhou não pode aparecer como erro (isolamento)');
      } finally {
        await pool.query(`UPDATE shopee_contas SET status='erro' WHERE id=$1`, [CONTA_ERRO]);
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

    // Mesma reprodução em miniatura do incidente já documentado em
    // lib/syncScheduler.js (01/09/2026): uma loja cuja sincronização nunca
    // resolve/rejeita não pode travar o ciclo pra sempre.
    test('uma loja cuja sincronização NUNCA resolve/rejeita não trava o ciclo pra sempre (watchdog)', async () => {
      const status = await executarCicloDeSincronizacao({
        sincronizarContaFn: async () => new Promise(() => {}),
      });
      assert.ok(status, 'o ciclo precisa terminar (não pode ficar pendurado pra sempre esperando a loja travada)');
      assert.equal(status.ultimoCicloOk, false, 'a loja travada deve contar como erro (abortada pelo watchdog), nunca como sucesso');
      assert.ok(
        status.contasComErro.some((c) => /excedeu/i.test(c.erro || '')),
        'o erro reportado precisa deixar claro que foi o watchdog (timeout) que abortou, não um erro real da Shopee'
      );

      const statusSeguinte = await executarCicloDeSincronizacao({
        sincronizarContaFn: async () => 'ok',
      });
      assert.notEqual(statusSeguinte, null, 'o ciclo seguinte não pode ser pulado — o watchdog precisa ter liberado emExecucao');
      assert.equal(statusSeguinte.ultimoCicloOk, true);
    });
  }
);
