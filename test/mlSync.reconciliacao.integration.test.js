// Teste de INTEGRAÇÃO (precisa de Postgres local — DATABASE_URL, ver
// comentário no topo de relatorioVendas.integration.test.js pra como
// preparar) do checklist pedido pelo usuário na tarefa "corrigir
// sincronização do Mercado Livre":
//   1. um pedido novo entra no banco sozinho (a MESMA função que a
//      sincronização automática de 1 em 1 minuto chama — lib/syncScheduler.js
//      → sincronizarConta — nunca precisa de clique manual);
//   2. rodar a sincronização de novo NUNCA duplica um pedido já importado
//      (idempotência pela chave conta_ml_id + ml_order_id);
//   3. uma mudança de status/pagamento/envio num pedido JÁ existente vira
//      UPDATE da mesma linha, nunca uma linha nova.
//
// Roda sincronizarConta() de verdade (o mesmo código que tanto o botão
// manual quanto o ciclo automático usam) contra os 11 pedidos REAIS da
// conta PFEMBALAGEMS (server/test/fixtures/real-orders.json) — só a
// CHAMADA HTTP pro Mercado Livre é mockada (lib/mercadolivre.js#apiGet),
// porque este sandbox não tem credenciais reais nem acesso à internet
// pra API do Mercado Livre. Tudo o mais (banco, upsert, rateio de frete,
// fila por pedido) é o código de produção de verdade.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const TEM_BANCO = !!process.env.DATABASE_URL;
// IDs propositalmente DIFERENTES de 900/901 (a conta/empresa fixture
// compartilhada por praticamente todos os outros testes de integração —
// dre.test.js, faturamento.test.js, relatorioVendas.integration.test.js,
// relatorios.test.js, etc.). Este arquivo deleta e reinsere pedidos durante
// o teste, e `node --test` roda arquivos em paralelo — usar os mesmos IDs
// da 900 quebraria (e quebrou, na primeira versão deste arquivo) os outros
// testes que dependem daquela fixture continuar intacta o tempo todo.
const CONTA_ML_ID = 930;
const EMPRESA_ID = 930;
const CONTA_ISOLAMENTO = 931;
const EMPRESA_ISOLAMENTO = 931;

describe(
  'Sincronização automática — checklist do usuário (novo pedido aparece sozinho / nunca duplica / atualiza mudança de status)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool, ml, cryptoLib, sincronizarConta, executarCicloDeSincronizacao;
    let orders, porId, apiGetReal, apiGetMock;

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');

      pool = require('../db/pool');
      ml = require('../lib/mercadolivre');
      cryptoLib = require('../lib/crypto');
      ({ sincronizarConta } = require('../lib/mlSync'));
      ({ executarCicloDeSincronizacao } = require('../lib/syncScheduler'));

      orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/real-orders.json'), 'utf8'));
      porId = Object.fromEntries(orders.map((o) => [String(o.ml_order_id), o]));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'55555555000191','PF EMBALAGENS TESTE (RECONCILIACAO)',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,930000001,$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc, refresh_token_enc=EXCLUDED.refresh_token_enc,
           token_expires_at=EXCLUDED.token_expires_at, status='ativa', ultimo_erro=NULL`,
        [CONTA_ML_ID, EMPRESA_ID, cryptoLib.encrypt('fake-access-token'), cryptoLib.encrypt('fake-refresh-token')]
      );
      await pool.query('DELETE FROM ml_pedidos WHERE conta_ml_id = $1', [CONTA_ML_ID]);

      apiGetReal = ml.apiGet;
      apiGetMock = async (p) => {
        if (p.startsWith('/orders/search')) {
          const ids = Object.keys(porId);
          return { paging: { total: ids.length }, results: ids.map((id) => ({ id: Number(id) })) };
        }
        let m = /^\/orders\/(\d+)$/.exec(p);
        if (m && porId[m[1]]) return JSON.parse(JSON.stringify(porId[m[1]].order));
        m = /^\/shipments\/(\d+)\/costs$/.exec(p);
        if (m) {
          const achado = orders.find((o) => o.order.shipping && String(o.order.shipping.id) === m[1]);
          if (achado) return achado.custosEnvio;
        }
        m = /^\/shipments\/(\d+)$/.exec(p);
        if (m) {
          const achado = orders.find((o) => o.order.shipping && String(o.order.shipping.id) === m[1]);
          if (achado) return achado.envio;
        }
        throw new Error('mock ml.apiGet: rota não coberta neste teste: ' + p);
      };
      ml.apiGet = apiGetMock; // mlSync.js chama `ml.apiGet(...)` — mesmo objeto de módulo, então isto já intercepta
    });

    after(async () => {
      ml.apiGet = apiGetReal;
      await pool.query('DELETE FROM ml_pedidos WHERE conta_ml_id = ANY($1)', [[CONTA_ML_ID, CONTA_ISOLAMENTO]]);
      await pool.query('DELETE FROM ml_contas WHERE id = ANY($1)', [[CONTA_ML_ID, CONTA_ISOLAMENTO]]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ID, EMPRESA_ISOLAMENTO]]);
      await pool.end();
    });

    test('checklist 1 — um pedido novo entra no banco sozinho, usando exatamente a função que o ciclo automático chama', async () => {
      const { rows: antes } = await pool.query('SELECT count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1', [CONTA_ML_ID]);
      assert.equal(antes[0].n, 0);

      // Isto é literalmente o que syncScheduler.executarCicloDeSincronizacao()
      // chama a cada 1 minuto — sem nenhum clique manual.
      const resultado = await sincronizarConta(CONTA_ML_ID, { diasAtras: 400 });
      assert.equal(resultado.erros.length, 0, 'nenhum pedido deveria falhar ao importar: ' + JSON.stringify(resultado.erros));

      const { rows: depois } = await pool.query('SELECT count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1', [CONTA_ML_ID]);
      assert.equal(depois[0].n, orders.length, 'todos os pedidos do fixture deveriam ter entrado automaticamente');
    });

    test('checklist 2 — rodar a sincronização de novo NUNCA duplica (idempotência por conta_ml_id + ml_order_id)', async () => {
      await sincronizarConta(CONTA_ML_ID, { diasAtras: 400 });
      await sincronizarConta(CONTA_ML_ID, { diasAtras: 400 }); // roda 2x seguidas de propósito

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1', [CONTA_ML_ID]);
      assert.equal(rows[0].n, orders.length, 'a contagem de pedidos não pode crescer ao ressincronizar');

      const { rows: dup } = await pool.query(
        `SELECT ml_order_id, count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1 GROUP BY ml_order_id HAVING count(*) > 1`,
        [CONTA_ML_ID]
      );
      assert.equal(dup.length, 0, 'nenhum ml_order_id pode aparecer mais de uma vez pra mesma conta');
    });

    test('checklist 3 — mudança de status num pedido existente vira UPDATE da mesma linha, nunca um pedido novo', async () => {
      const idAlvo = String(orders[0].ml_order_id);
      const original = ml.apiGet;
      ml.apiGet = async (p) => {
        if (p === `/orders/${idAlvo}`) {
          const o = JSON.parse(JSON.stringify(porId[idAlvo].order));
          o.status = 'cancelled';
          o.status_detail = 'buyer_resolution';
          return o;
        }
        return original(p);
      };

      try {
        await sincronizarConta(CONTA_ML_ID, { diasAtras: 400 });
      } finally {
        ml.apiGet = original;
      }

      const { rows } = await pool.query(
        'SELECT status, status_detail FROM ml_pedidos WHERE conta_ml_id=$1 AND ml_order_id=$2',
        [CONTA_ML_ID, idAlvo]
      );
      assert.equal(rows.length, 1, 'a mudança de status não pode criar uma segunda linha pro mesmo pedido');
      assert.equal(rows[0].status, 'cancelled');
      assert.equal(rows[0].status_detail, 'buyer_resolution');

      const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1', [CONTA_ML_ID]);
      assert.equal(total[0].n, orders.length, 'o total de pedidos não pode mudar só por causa de uma atualização de status');
    });

    test('o ciclo automático (syncScheduler) chama sincronizarConta sozinho e nunca mistura pedidos entre contas/empresas diferentes', async () => {
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'44444444000191','EMPRESA ISOLAMENTO TESTE',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ISOLAMENTO]
      );
      // Conta de isolamento propositalmente com token inválido — precisa
      // falhar sozinha, sem afetar a conta principal deste teste nem
      // inventar pedidos pra ela.
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,999999901,'invalido-nao-decripta','invalido-nao-decripta', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO NOTHING`,
        [CONTA_ISOLAMENTO, EMPRESA_ISOLAMENTO]
      );

      const status = await executarCicloDeSincronizacao();

      // Não afirma um total exato: outras contas de outros arquivos de
      // teste (ex.: a 900, fixture compartilhada) podem estar 'ativa' ao
      // mesmo tempo — o que importa é que ESTAS duas contas específicas se
      // comportam certo (uma falha isolada, a outra nunca é afetada).
      assert.ok(status.contasProcessadas >= 2, 'esperava pelo menos as 2 contas deste teste no ciclo');
      assert.ok(!status.contasComErro.find((c) => c.contaId === CONTA_ML_ID), 'a conta principal deste teste não deveria falhar');
      assert.ok(status.contasComErro.find((c) => c.contaId === CONTA_ISOLAMENTO), 'a conta de isolamento (token inválido) deveria falhar isoladamente');

      const { rows: pedidos901 } = await pool.query('SELECT count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1', [CONTA_ISOLAMENTO]);
      assert.equal(pedidos901[0].n, 0, 'a conta 901 nunca pode ganhar pedidos da conta 900');

      const { rows: pedidos900 } = await pool.query('SELECT count(*)::int AS n FROM ml_pedidos WHERE conta_ml_id=$1', [CONTA_ML_ID]);
      assert.equal(pedidos900[0].n, orders.length, 'a conta 900 continua com seus próprios pedidos, sem duplicar');
    });
  }
);
