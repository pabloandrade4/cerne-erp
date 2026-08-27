// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão dos
// outros *.test.js) da importação de extrato bancário + conciliação
// (Passo 2 da tarefa "Recebimentos + Fluxo de Caixa + IA Gestora",
// 27/08/2026, ver docs/04-alteracoes.md). Cobre os testes OBRIGATÓRIOS
// pedidos pelo usuário: 1) importar planilha; 2) reimportar a mesma
// planilha sem duplicar; 3) conciliar um recebimento de marketplace; 4)
// previsto -> realizado sem duplicação (esse último tem um teste dedicado
// e mais detalhado em fluxoCaixa.test.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';

describe('Extrato Bancário + Conciliação — Passo 2 (27/08/2026)', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let extratoBancario, contasBancarias, conciliacaoBancaria, contasReceber, pool;
  let contaBancariaId;
  let contaReceberId;
  let recebimentoMlId, recebimentoMlStatusOriginal, recebimentoMlValor;

  before(async () => {
    extratoBancario = require('../lib/extratoBancario');
    contasBancarias = require('../lib/contasBancarias');
    conciliacaoBancaria = require('../lib/conciliacaoBancaria');
    contasReceber = require('../lib/contasReceber');
    pool = require('../db/pool');

    const conta = await contasBancarias.criarContaBancaria({ empresaId: EMPRESA_ID, nome: PREFIXO_TESTE + ' Banco Extrato' });
    assert.equal(conta.errors, undefined);
    contaBancariaId = conta.conta.id;

    const cr = await contasReceber.criarContaReceber({
      empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' recebível pra conciliar', origem: 'Outros', valor: 77.5, dataPrevista: '2026-08-20',
    });
    assert.equal(cr.errors, undefined);
    contaReceberId = cr.conta.id;

    const { rows } = await pool.query(
      `SELECT id, status, valor_liquido_esperado FROM recebimentos_marketplace WHERE empresa_id = $1 AND status = 'a_receber' AND valor_liquido_esperado IS NOT NULL ORDER BY id LIMIT 1`,
      [EMPRESA_ID]
    );
    assert.ok(rows.length, 'precisa existir um recebimento ML "a_receber" nos dados de teste');
    recebimentoMlId = rows[0].id;
    recebimentoMlStatusOriginal = rows[0].status;
    recebimentoMlValor = Number(rows[0].valor_liquido_esperado);
  });

  after(async () => {
    if (contaBancariaId) {
      await pool.query('DELETE FROM extrato_movimentos WHERE conta_bancaria_id = $1', [contaBancariaId]);
      await pool.query('DELETE FROM extrato_importacoes WHERE conta_bancaria_id = $1', [contaBancariaId]);
      await pool.query('DELETE FROM contas_bancarias WHERE id = $1', [contaBancariaId]);
    }
    if (contaReceberId) await pool.query('DELETE FROM contas_receber WHERE id = $1', [contaReceberId]);
    if (recebimentoMlId) {
      await pool.query(
        `UPDATE recebimentos_marketplace SET status=$1, valor_recebido=NULL, data_efetiva_recebimento=NULL, origem_confirmacao=NULL, updated_at=now() WHERE id=$2`,
        [recebimentoMlStatusOriginal, recebimentoMlId]
      );
    }
    await pool.end();
  });

  function csvBase64(linhas) {
    const texto = 'Data;Histórico;Documento;Entrada;Saída\n' + linhas.join('\n');
    return Buffer.from(texto, 'utf8').toString('base64');
  }

  describe('Teste obrigatório 1 e 2: importar planilha, reimportar sem duplicar', () => {
    let conteudoBase64;
    let mapeamentoUsado;

    before(() => {
      conteudoBase64 = csvBase64([
        `27/08/2026;PIX RECEBIDO MERCADO PAGO;DOC001;${recebimentoMlValor.toFixed(2).replace('.', ',')};`,
        '20/08/2026;TED RECEBIDA;DOC002;77,50;',
        '19/08/2026;TARIFA BANCARIA;DOC003;;9,90',
      ]);
    });

    test('CSV com ; e vírgula decimal é lido corretamente, mapeamento sugerido identifica as colunas certas', async () => {
      const { colunas, linhas } = await extratoBancario.lerPlanilha({ conteudoBase64, formato: 'csv' });
      assert.deepEqual(colunas, ['Data', 'Histórico', 'Documento', 'Entrada', 'Saída']);
      assert.equal(linhas.length, 3);

      const mapeamento = extratoBancario.sugerirMapeamento(colunas);
      assert.equal(mapeamento.data, 0);
      assert.equal(mapeamento.descricao, 1);
      assert.equal(mapeamento.documento, 2);
      assert.equal(mapeamento.entrada, 3);
      assert.equal(mapeamento.saida, 4);
      mapeamentoUsado = mapeamento;
    });

    test('prévia mostra contagens ANTES de qualquer gravação (nenhuma linha em extrato_movimentos ainda)', async () => {
      const preview = await extratoBancario.previsualizarImportacao({
        conteudoBase64, formato: 'csv', nomeArquivo: 'extrato.csv', mapeamento: mapeamentoUsado, contaBancariaId,
      });
      assert.equal(preview.errors, undefined);
      assert.equal(preview.resumo.totalMovimentacoes, 3);
      assert.equal(preview.resumo.totalNovas, 3);
      assert.equal(preview.resumo.totalDuplicadas, 0);
      assert.equal(preview.resumo.totalEntradas, round2(recebimentoMlValor + 77.5));
      assert.equal(preview.resumo.totalSaidas, 9.9);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM extrato_movimentos WHERE conta_bancaria_id = $1', [contaBancariaId]);
      assert.equal(rows[0].n, 0, 'a prévia NUNCA grava nada no banco');
    });

    test('Teste obrigatório 1 — confirmar a importação grava as movimentações', async () => {
      const preview = await extratoBancario.previsualizarImportacao({
        conteudoBase64, formato: 'csv', nomeArquivo: 'extrato.csv', mapeamento: mapeamentoUsado, contaBancariaId,
      });
      const result = await extratoBancario.confirmarImportacao({
        empresaId: EMPRESA_ID, contaBancariaId, nomeArquivo: 'extrato.csv', formato: 'csv',
        mapeamento: mapeamentoUsado, movimentos: preview.movimentos, importadoPor: 'teste-automatizado',
      });
      assert.equal(result.errors, undefined);
      assert.equal(result.importacao.totalNovas, 3);
      assert.equal(result.importacao.totalDuplicadas, 0);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM extrato_movimentos WHERE conta_bancaria_id = $1', [contaBancariaId]);
      assert.equal(rows[0].n, 3);
    });

    test('Teste obrigatório 2 — reimportar a MESMA planilha não duplica nenhuma movimentação', async () => {
      const preview = await extratoBancario.previsualizarImportacao({
        conteudoBase64, formato: 'csv', nomeArquivo: 'extrato.csv', mapeamento: mapeamentoUsado, contaBancariaId,
      });
      assert.equal(preview.resumo.totalNovas, 0, 'a prévia da reimportação já mostra 0 novas — tudo já existe');
      assert.equal(preview.resumo.totalDuplicadas, 3);

      const result = await extratoBancario.confirmarImportacao({
        empresaId: EMPRESA_ID, contaBancariaId, nomeArquivo: 'extrato.csv', formato: 'csv',
        mapeamento: mapeamentoUsado, movimentos: preview.movimentos, importadoPor: 'teste-automatizado',
      });
      assert.equal(result.importacao.totalNovas, 0);
      assert.equal(result.importacao.totalDuplicadas, 3);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM extrato_movimentos WHERE conta_bancaria_id = $1', [contaBancariaId]);
      assert.equal(rows[0].n, 3, 'CONTINUA em 3 — reimportar a mesma planilha nunca duplica');
    });
  });

  describe('Teste obrigatório 3: conciliar um recebimento de marketplace', () => {
    test('sugestão encontra o recebimento certo pelo valor; confirmar muda o status pra RECEBIDO e marca o movimento como conciliado', async () => {
      const sugestoes = await conciliacaoBancaria.sugerirConciliacoes({ empresaId: EMPRESA_ID, contaBancariaId });
      const doRecebimentoMl = sugestoes.find((s) => s.movimento.descricao.includes('PIX RECEBIDO MERCADO PAGO'));
      assert.ok(doRecebimentoMl, 'deveria haver uma sugestão pro movimento do PIX recebido');
      const candidato = doRecebimentoMl.candidatos.find((c) => c.tipo === 'recebimento_marketplace' && c.id === recebimentoMlId);
      assert.ok(candidato, 'o recebimento ML certo (mesmo valor) deveria aparecer como candidato');

      const confirmado = await conciliacaoBancaria.confirmarConciliacao({
        movimentoId: doRecebimentoMl.movimento.id, tipo: 'recebimento_marketplace', alvoId: recebimentoMlId,
      });
      assert.equal(confirmado.errors, undefined);
      assert.equal(confirmado.alvo.status, 'recebido');
      assert.equal(confirmado.alvo.origemConfirmacao, 'conciliacao_extrato');
      assert.equal(confirmado.movimento.statusConciliacao, 'conciliado');
      assert.equal(confirmado.movimento.conciliadoComTipo, 'recebimento_marketplace');
      assert.equal(confirmado.movimento.conciliadoComId, recebimentoMlId);

      // Não pode conciliar de novo o mesmo movimento.
      const denovo = await conciliacaoBancaria.confirmarConciliacao({
        movimentoId: doRecebimentoMl.movimento.id, tipo: 'recebimento_marketplace', alvoId: recebimentoMlId,
      });
      assert.ok(denovo.errors, 'não pode conciliar um movimento que já foi conciliado');
    });

    test('conciliar uma conta a receber muda o status dela pra recebido, sem duplicar', async () => {
      const sugestoes = await conciliacaoBancaria.sugerirConciliacoes({ empresaId: EMPRESA_ID, contaBancariaId });
      const daContaReceber = sugestoes.find((s) => s.candidatos.some((c) => c.tipo === 'conta_receber' && c.id === contaReceberId));
      assert.ok(daContaReceber, 'deveria haver uma sugestão pra conta a receber de teste (R$77,50)');

      const confirmado = await conciliacaoBancaria.confirmarConciliacao({
        movimentoId: daContaReceber.movimento.id, tipo: 'conta_receber', alvoId: contaReceberId,
      });
      assert.equal(confirmado.errors, undefined);
      assert.equal(confirmado.alvo.status, 'recebido');
    });

    test('movimento sem candidato correspondente (tarifa bancária) não aparece nas sugestões — usuário usa "ignorar"', async () => {
      const sugestoes = await conciliacaoBancaria.sugerirConciliacoes({ empresaId: EMPRESA_ID, contaBancariaId });
      const daTarifa = sugestoes.find((s) => s.movimento.descricao.includes('TARIFA BANCARIA'));
      assert.equal(daTarifa, undefined, 'nunca sugere um candidato forçado pra um valor sem correspondência real');
    });
  });
});

function round2(n) { return Math.round(n * 100) / 100; }
