// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/financeiro.test.js) de Despesas Fixas, ativado em 25/08/2026 (ver
// docs/04-alteracoes.md). Roda as funções REAIS de lib/despesasFixas.js
// contra o banco de teste (empresa 900, mesma convenção do resto do
// projeto).
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test despesasFixas.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';

// Primeiro dia do mês corrente (BRT) — usado como dataInicio nos testes que
// precisam garantir que a ocorrência do dia de vencimento escolhido (5, 15,
// 20...) sempre caia DEPOIS de dataInicio, não importa em que dia do mês o
// teste rodar (ocorrenciasNoIntervalo nunca gera uma data antes de
// dataInicio — ver lib/despesasFixas.js).
function inicioDoMesCorrenteBRT() {
  const despesasFixasLib = require('../lib/despesasFixas');
  const hoje = despesasFixasLib.hojeBRT();
  const [y, m] = hoje.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

describe('Despesas Fixas — 25/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let despesasFixas, pool;
  const criadas = [];

  before(async () => {
    despesasFixas = require('../lib/despesasFixas');
    pool = require('../db/pool');
  });

  after(async () => {
    // Limpa só o que este teste criou (nunca mexe em dado real de outra origem).
    await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.query(`DELETE FROM despesas_fixas WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.end();
  });

  describe('validação', () => {
    test('recusa sem descrição, sem valor válido, sem frequência, sem data de início', async () => {
      const r1 = await despesasFixas.criarDespesaFixa({ empresaId: EMPRESA_ID, valor: 10, frequencia: 'mensal', diaVencimento: 5, dataInicio: '2026-01-01' });
      assert.ok(r1.errors.descricao);

      const r2 = await despesasFixas.criarDespesaFixa({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' x', valor: 0, frequencia: 'mensal', diaVencimento: 5, dataInicio: '2026-01-01' });
      assert.ok(r2.errors.valor);

      const r3 = await despesasFixas.criarDespesaFixa({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' x', valor: 10, frequencia: 'quinzenal', diaVencimento: 5, dataInicio: '2026-01-01' });
      assert.ok(r3.errors.frequencia);

      const r4 = await despesasFixas.criarDespesaFixa({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' x', valor: 10, frequencia: 'mensal', diaVencimento: 5 });
      assert.ok(r4.errors.dataInicio);
    });

    test('data de término antes da data de início é rejeitada', async () => {
      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' x', valor: 10, frequencia: 'mensal',
        diaVencimento: 5, dataInicio: '2026-06-01', dataFim: '2026-01-01',
      });
      assert.ok(r.errors.dataFim);
    });

    test('despesa semanal: diaVencimento é sempre derivado do dia da semana de dataInicio (nunca aceito do formulário)', async () => {
      // 2026-08-24 é uma segunda-feira (ISO 1).
      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' semanal', valor: 50, frequencia: 'semanal',
        diaVencimento: 7, dataInicio: '2026-08-24', // manda 7 (domingo) só pra provar que é ignorado
      });
      assert.equal(r.errors, undefined);
      criadas.push(r.despesa.id);
      assert.equal(r.despesa.diaVencimento, 1, 'deveria ter sido recalculado pro dia da semana real de dataInicio (segunda=1)');
    });
  });

  describe('ocorrenciasNoIntervalo (cálculo puro — sem banco)', () => {
    test('mensal: uma ocorrência por mês, clampada no último dia quando o mês é mais curto', () => {
      const despesa = { frequencia: 'mensal', diaVencimento: 31, dataInicio: '2026-01-01', dataFim: null };
      const ocorrencias = despesasFixas.ocorrenciasNoIntervalo(despesa, '2026-01-01', '2026-04-30');
      assert.deepEqual(ocorrencias, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    });

    test('semanal: sempre de 7 em 7 dias a partir de dataInicio', () => {
      const despesa = { frequencia: 'semanal', diaVencimento: 1, dataInicio: '2026-08-03', dataFim: null };
      const ocorrencias = despesasFixas.ocorrenciasNoIntervalo(despesa, '2026-08-01', '2026-08-31');
      assert.deepEqual(ocorrencias, ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31']);
    });

    test('anual: só no mês de dataInicio, uma vez por ano', () => {
      const despesa = { frequencia: 'anual', diaVencimento: 15, dataInicio: '2025-03-15', dataFim: null };
      const ocorrencias = despesasFixas.ocorrenciasNoIntervalo(despesa, '2025-01-01', '2027-12-31');
      assert.deepEqual(ocorrencias, ['2025-03-15', '2026-03-15', '2027-03-15']);
    });

    test('respeita dataFim — nenhuma ocorrência depois do término', () => {
      const despesa = { frequencia: 'mensal', diaVencimento: 10, dataInicio: '2026-01-01', dataFim: '2026-03-05' };
      const ocorrencias = despesasFixas.ocorrenciasNoIntervalo(despesa, '2026-01-01', '2026-06-30');
      assert.deepEqual(ocorrencias, ['2026-01-10', '2026-02-10']); // 10/03 já é depois de 05/03
    });
  });

  describe('geração automática de Contas a Pagar', () => {
    test('gera 1 conta a pagar por ocorrência, e rodar de novo NUNCA duplica', async () => {
      const hoje = despesasFixas.hojeBRT();
      const [y, m] = hoje.split('-').map(Number);
      const mesPassado = m === 1 ? 12 : m - 1;
      const anoMesPassado = m === 1 ? y - 1 : y;
      const dataInicio = `${anoMesPassado}-${String(mesPassado).padStart(2, '0')}-10`;

      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Aluguel', categoria: 'Aluguel', valor: 3000,
        frequencia: 'mensal', diaVencimento: 10, dataInicio,
      });
      assert.equal(r.errors, undefined);
      criadas.push(r.despesa.id);

      const g1 = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });
      const detalheDaDespesa = g1.detalhes.find((d) => d.despesaFixaId === r.despesa.id);
      assert.ok(detalheDaDespesa, 'deveria ter gerado pelo menos 1 conta a pagar pra esta despesa');
      assert.equal(detalheDaDespesa.geradas, 2, 'mês passado + mês corrente = 2 ocorrências');

      const g2 = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });
      const detalheSegundaRodada = g2.detalhes.find((d) => d.despesaFixaId === r.despesa.id);
      assert.equal(detalheSegundaRodada, undefined, 'segunda rodada não deveria gerar nada de novo pra esta despesa');

      const { rows } = await pool.query(
        'SELECT vencimento, valor, status FROM contas_pagar WHERE despesa_fixa_id = $1 ORDER BY vencimento',
        [r.despesa.id]
      );
      assert.equal(rows.length, 2, 'não deveria haver conta duplicada no banco mesmo rodando 2x');
      rows.forEach((row) => {
        assert.equal(Number(row.valor), 3000);
        assert.equal(row.status, 'pendente');
      });
    });

    test('despesa inativa não gera novas contas', async () => {
      const inicioDoMes = inicioDoMesCorrenteBRT();
      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Internet', valor: 200,
        frequencia: 'mensal', diaVencimento: 5, dataInicio: inicioDoMes, ativo: false,
      });
      criadas.push(r.despesa.id);
      assert.equal(r.despesa.ativo, false);

      const g = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });
      const detalhe = g.detalhes.find((d) => d.despesaFixaId === r.despesa.id);
      assert.equal(detalhe, undefined, 'despesa inativa não deveria aparecer nos detalhes de geração');
    });
  });

  describe('editar / ativar / desativar / excluir', () => {
    test('editar depois de gerar conta a pagar não altera a conta já gerada', async () => {
      const inicioDoMes = inicioDoMesCorrenteBRT();
      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Sistemas', valor: 100,
        frequencia: 'mensal', diaVencimento: 5, dataInicio: inicioDoMes,
      });
      criadas.push(r.despesa.id);
      await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });

      const antes = await pool.query('SELECT valor FROM contas_pagar WHERE despesa_fixa_id = $1', [r.despesa.id]);
      assert.ok(antes.rows.length > 0, 'pré-condição: precisa ter gerado ao menos 1 conta pra este teste fazer sentido');

      const editado = await despesasFixas.atualizarDespesaFixa(r.despesa.id, { valor: 999 });
      assert.equal(editado.errors, undefined);
      assert.equal(editado.despesa.valor, 999);

      const depois = await pool.query('SELECT valor FROM contas_pagar WHERE despesa_fixa_id = $1', [r.despesa.id]);
      assert.deepEqual(antes.rows.map((x) => Number(x.valor)), depois.rows.map((x) => Number(x.valor)), 'contas já geradas nunca mudam de valor sozinhas');
    });

    test('ativar/desativar alterna o campo ativo', async () => {
      const hoje = despesasFixas.hojeBRT();
      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Contador', valor: 500,
        frequencia: 'mensal', diaVencimento: 20, dataInicio: hoje,
      });
      criadas.push(r.despesa.id);

      const off = await despesasFixas.definirAtivo(r.despesa.id, false);
      assert.equal(off.despesa.ativo, false);
      const on = await despesasFixas.definirAtivo(r.despesa.id, true);
      assert.equal(on.despesa.ativo, true);
    });

    test('excluir é bloqueado depois de já ter gerado uma conta a pagar', async () => {
      const inicioDoMes = inicioDoMesCorrenteBRT();
      const r = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Energia', valor: 300,
        frequencia: 'mensal', diaVencimento: 15, dataInicio: inicioDoMes,
      });
      criadas.push(r.despesa.id);
      const g = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });
      assert.ok(g.detalhes.find((d) => d.despesaFixaId === r.despesa.id), 'pré-condição: precisa ter gerado ao menos 1 conta pra este teste fazer sentido');

      const resultado = await despesasFixas.excluirDespesaFixa(r.despesa.id);
      assert.ok(resultado.errors, 'não deveria conseguir excluir depois de já ter gerado histórico');
    });
  });
});
