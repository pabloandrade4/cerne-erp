// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/financeiro.test.js) do Fluxo de Caixa, ativado em 25/08/2026 (ver
// docs/04-alteracoes.md). Roda as funções REAIS de lib/fluxoCaixa.js contra
// o banco de teste (empresa 900).
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test fluxoCaixa.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';

describe('Fluxo de Caixa — 25/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let fluxoCaixa, despesasFixas, contasPagar, contasReceber, recebimentosMl, pool;
  const idsDespesas = [];
  const idsContasPagar = [];
  const idsContasReceber = [];
  let recebimentoMlRestaurar = null; // { id, statusOriginal } — recebimento de marketplace usado no teste de conciliação, restaurado no after()

  before(async () => {
    fluxoCaixa = require('../lib/fluxoCaixa');
    despesasFixas = require('../lib/despesasFixas');
    contasPagar = require('../lib/contasPagar');
    contasReceber = require('../lib/contasReceber');
    recebimentosMl = require('../lib/recebimentosMl');
    pool = require('../db/pool');
  });

  after(async () => {
    await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.query(`DELETE FROM contas_receber WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.query(`DELETE FROM despesas_fixas WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.query(`DELETE FROM fluxo_caixa_saldo_inicial WHERE empresa_id = $1`, [EMPRESA_ID]);
    if (recebimentoMlRestaurar) {
      // devolve o recebimento de marketplace usado no teste ao estado original —
      // é dado real sincronizado (não criado pelo teste), não pode ficar sujo pra outros testes.
      await pool.query(
        `UPDATE recebimentos_marketplace SET status=$1, valor_recebido=NULL, data_efetiva_recebimento=NULL, origem_confirmacao=NULL, updated_at=now() WHERE id=$2`,
        [recebimentoMlRestaurar.statusOriginal, recebimentoMlRestaurar.id]
      );
    }
    await pool.end();
  });

  describe('período próprio (7/15/30 dias, este mês, próximo mês, personalizado)', () => {
    test('7/15/30 dias contam a partir de HOJE (inclusive) — diferente do período do header, que olha pra trás', () => {
      const hoje = despesasFixas.hojeBRT();
      const p7 = fluxoCaixa.calcularPeriodoFluxoCaixa('7d', {});
      assert.equal(p7.desde, hoje);
      const dias = (new Date(p7.ate + 'T00:00:00Z') - new Date(p7.desde + 'T00:00:00Z')) / 86400000;
      assert.equal(dias, 6, '7 dias = hoje + mais 6 = 7 dias no total');
    });

    test('proximoMes é o mês de calendário seguinte inteiro', () => {
      const hoje = despesasFixas.hojeBRT();
      const [y, m] = hoje.split('-').map(Number);
      const p = fluxoCaixa.calcularPeriodoFluxoCaixa('proximoMes', {});
      const esperadoMes = m === 12 ? 1 : m + 1;
      const [, pm] = p.desde.split('-').map(Number);
      assert.equal(pm, esperadoMes);
      assert.equal(p.desde.slice(8, 10), '01');
    });

    test('personalizado inverte desde/ate quando vem trocado, e nunca passa do limite de segurança', () => {
      const p = fluxoCaixa.calcularPeriodoFluxoCaixa('personalizado', { desde: '2026-12-31', ate: '2026-01-01' });
      assert.equal(p.desde, '2026-01-01');
      assert.equal(p.ate, '2026-12-31');
    });
  });

  describe('saldo inicial — sempre informado pelo usuário, nunca inventado', () => {
    test('sem saldo inicial informado, saldoAtual/saldoProjetado vêm null com motivo (nunca um número inventado)', async () => {
      await pool.query('DELETE FROM fluxo_caixa_saldo_inicial WHERE empresa_id = $1', [EMPRESA_ID]);
      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: '7d' });
      assert.equal(f.cards.saldoAtual.valor, null);
      assert.equal(f.cards.saldoAtual.motivo, 'sem_saldo_inicial_informado');
      assert.equal(f.cards.saldoProjetado.valor, null);
    });

    test('validação: valor precisa ser numérico e dataReferencia precisa ser uma data válida', async () => {
      const r1 = await fluxoCaixa.definirSaldoInicial({ empresaId: EMPRESA_ID, valor: 'abc', dataReferencia: '2026-08-01' });
      assert.ok(r1.errors.valor);
      const r2 = await fluxoCaixa.definirSaldoInicial({ empresaId: EMPRESA_ID, valor: 100, dataReferencia: 'não é data' });
      assert.ok(r2.errors.dataReferencia);
    });

    test('com saldo informado, saldoAtual reflete o valor + movimentos realizados desde a referência', async () => {
      const set = await fluxoCaixa.definirSaldoInicial({ empresaId: EMPRESA_ID, valor: 5000, dataReferencia: despesasFixas.hojeBRT() });
      assert.equal(set.errors, undefined);
      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: '7d' });
      assert.equal(f.cards.saldoAtual.valor, 5000, 'referência é hoje, nenhum movimento ainda somado');
    });
  });

  describe('nunca conta uma despesa fixa 2x quando ela já virou conta a pagar', () => {
    test('despesa fixa prevista some do total assim que a conta a pagar correspondente é gerada', async () => {
      const hoje = despesasFixas.hojeBRT();
      const [y, m] = hoje.split('-').map(Number);
      const inicioDoMes = `${y}-${String(m).padStart(2, '0')}-01`;

      const criada = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Aluguel Fluxo', categoria: 'Aluguel', valor: 3000,
        frequencia: 'mensal', diaVencimento: 28, dataInicio: inicioDoMes,
      });
      assert.equal(criada.errors, undefined);
      idsDespesas.push(criada.despesa.id);

      // ANTES de gerar: aparece como "despesa fixa prevista".
      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: 'mes' });
      assert.equal(antes.resumoFormula.despesasFixasPrevistas, 3000);
      const saidasPrevistasAntes = antes.cards.saidasPrevistas;

      // Gera a conta a pagar correspondente.
      const g = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });
      assert.ok(g.detalhes.find((d) => d.despesaFixaId === criada.despesa.id));

      // DEPOIS de gerar: a mesma ocorrência não pode aparecer duas vezes —
      // "despesasFixasPrevistas" cai a 0 e o total de saídas previstas do
      // período continua o MESMO valor (3000 uma única vez), nunca dobra.
      const depois = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: 'mes' });
      assert.equal(depois.resumoFormula.despesasFixasPrevistas, 0, 'não deveria mais aparecer como "prevista" — já é uma conta a pagar de verdade');
      assert.equal(depois.cards.saidasPrevistas, saidasPrevistasAntes, 'total de saídas previstas do período tem que ser o MESMO — nunca R$6.000 em vez de R$3.000');
    });
  });

  describe('REALIZADO x PROJETADO por dia', () => {
    test('conta paga HOJE aparece em "realizado"; conta pendente com vencimento futuro aparece em "projetado"', async () => {
      const hoje = despesasFixas.hojeBRT();
      const criadaPaga = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' paga hoje', valor: 111, vencimento: hoje });
      idsContasPagar.push(criadaPaga.conta.id);
      await contasPagar.marcarComoPago(criadaPaga.conta.id, hoje);

      const [y, m, d] = hoje.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + 3);
      const daqui3Dias = dt.toISOString().slice(0, 10);
      const criadaFutura = await contasReceber.criarContaReceber({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' a receber futuro', valor: 222, dataPrevista: daqui3Dias });
      idsContasReceber.push(criadaFutura.conta.id);

      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: '7d' });
      const diaHoje = f.serieDiaria.find((x) => x.dia === hoje);
      assert.ok(diaHoje.realizado.saidas >= 111, 'a conta paga hoje precisa contar como REALIZADO');

      const diaFuturo = f.serieDiaria.find((x) => x.dia === daqui3Dias);
      assert.ok(diaFuturo, 'o dia daqui a 3 dias precisa estar dentro da série de 7 dias');
      assert.ok(diaFuturo.projetado.entradas >= 222, 'a conta a receber futura precisa contar como PROJETADO, nunca REALIZADO');
      assert.equal(diaFuturo.realizado.entradas, 0, 'dia futuro não pode ter nada REALIZADO ainda');
    });
  });

  describe('recebimento de marketplace: PREVISTO vira REALIZADO sem duplicar (regra mais importante do Passo 2)', () => {
    test('marcar um recebimento ML como recebido tira o valor de "previsto" e soma exatamente uma vez em "realizado"', async () => {
      const hoje = despesasFixas.hojeBRT();

      // Pega um recebimento real (sincronizado) ainda 'a_receber' pra usar no teste.
      const { rows } = await pool.query(
        `SELECT id, valor_liquido_esperado, status FROM recebimentos_marketplace WHERE empresa_id = $1 AND status = 'a_receber' AND valor_liquido_esperado IS NOT NULL ORDER BY id LIMIT 1`,
        [EMPRESA_ID]
      );
      assert.ok(rows.length, 'precisa existir ao menos um recebimento ML "a_receber" com valor calculável nos dados de teste (real-orders.json)');
      const alvo = rows[0];
      recebimentoMlRestaurar = { id: alvo.id, statusOriginal: alvo.status };
      const valor = Number(alvo.valor_liquido_esperado);

      // ANTES: aparece como PREVISTO (recebimentosMarketplaces.total inclui esse valor).
      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: 'personalizado', desde: '2026-01-01', ate: hoje });
      const previstoAntes = antes.recebimentosMarketplaces.total;
      const realizadoEntradasAntes = antes.realizadoNoPeriodo.entradas;
      assert.ok(previstoAntes >= valor - 0.01, 'o valor precisa estar contado em "previsto" antes da conciliação');

      // Concilia: marca como recebido HOJE.
      const marcado = await recebimentosMl.marcarComoRecebido(alvo.id, { dataEfetivaRecebimento: hoje, valorRecebido: valor });
      assert.equal(marcado.errors, undefined);
      assert.equal(marcado.recebimento.status, 'recebido');

      // DEPOIS: some de "previsto" e aparece em "realizado" — exatamente uma vez, nunca as duas coisas.
      const depois = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: 'personalizado', desde: '2026-01-01', ate: hoje });
      assert.equal(depois.recebimentosMarketplaces.total, round2(previstoAntes - valor), '"previsto" tem que cair exatamente o valor conciliado — nunca ficar duplicado');
      assert.equal(depois.realizadoNoPeriodo.entradas, round2(realizadoEntradasAntes + valor), '"realizado" tem que subir exatamente o valor conciliado — R$X previsto vira R$X realizado, nunca R$2X');

      const diaHoje = depois.serieDiaria.find((d) => d.dia === hoje);
      assert.ok(diaHoje, 'hoje precisa estar dentro do período personalizado do teste');
      assert.ok(diaHoje.realizado.entradas >= valor - 0.01, 'o valor conciliado precisa aparecer no dia de hoje da série REALIZADO');

      function round2(n) { return Math.round(n * 100) / 100; }
    });
  });
});
