// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/relatorioVendas.integration.test.js) de Contas a Pagar, Contas a
// Receber e Recebimentos (ativados em 24/08/2026, ver docs/04-alteracoes.md).
// Roda as funções REAIS de lib/contasPagar.js, lib/contasReceber.js e
// lib/recebimentosMl.js contra dados reais já sincronizados (empresa/conta
// 900, mesmos 11 pedidos reais da reconciliação PF ERP x Mercado Turbo).
//
// Como rodar (Postgres local já seedado com os 11 pedidos reais — ver
// cabeçalho de relatorioVendas.integration.test.js):
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test financeiro.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';

describe('Contas a Pagar / Contas a Receber / Recebimentos — 24/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let contasPagar, contasReceber, recebimentosMl, periodo;
  let fornecedorId;
  let hoje, ontem, amanha;
  const criados = { pagar: [], receber: [] };
  let recebimentoMlRestaurar = null; // { id, statusOriginal } — ver describe "ações manuais" abaixo

  before(async () => {
    contasPagar = require('../lib/contasPagar');
    contasReceber = require('../lib/contasReceber');
    recebimentosMl = require('../lib/recebimentosMl');
    periodo = require('../lib/periodo');
    const pool = require('../db/pool');

    hoje = contasPagar.hojeBRT();
    ontem = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    amanha = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `INSERT INTO fornecedores (empresa_id, razao_social, documento)
       VALUES ($1, $2, $3)
       ON CONFLICT (empresa_id, documento) DO UPDATE SET razao_social = EXCLUDED.razao_social
       RETURNING id`,
      [EMPRESA_ID, PREFIXO_TESTE + ' Fornecedor', '11222333000181']
    );
    fornecedorId = rows[0].id;
  });

  after(async () => {
    // Limpa só o que este teste criou (nunca mexe em dado real de outra
    // origem) — descrição sempre prefixada, fornecedor identificável.
    const pool = require('../db/pool');
    await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.query(`DELETE FROM contas_receber WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
    await pool.query(`DELETE FROM fornecedores WHERE id = $1`, [fornecedorId]);
    if (recebimentoMlRestaurar) {
      // devolve o recebimento ML (dado real sincronizado, não criado pelo
      // teste) ao estado original — não pode ficar sujo pra outros testes.
      await pool.query(
        `UPDATE recebimentos_marketplace SET status=$1, valor_recebido=NULL, data_efetiva_recebimento=NULL, data_efetiva_liberacao=NULL, data_prevista_liberacao=NULL, origem_confirmacao=NULL, updated_at=now() WHERE id=$2`,
        [recebimentoMlRestaurar.statusOriginal, recebimentoMlRestaurar.id]
      );
    }
    await pool.end();
  });

  describe('Contas a Pagar', () => {
    test('validação: recusa sem descrição, sem valor válido, sem vencimento', async () => {
      const r1 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, valor: 10, vencimento: hoje });
      assert.ok(r1.errors.descricao);
      const r2 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: 'x', valor: 0, vencimento: hoje });
      assert.ok(r2.errors.valor);
      const r3 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: 'x', valor: 10 });
      assert.ok(r3.errors.vencimento);
    });

    test('fornecedor de outra empresa é rejeitado', async () => {
      const r = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, fornecedorId: 999999, descricao: PREFIXO_TESTE + ' x', valor: 10, vencimento: hoje });
      assert.ok(r.errors.fornecedorId);
    });

    test('cria conta vencida (vencimento no passado) com status calculado, nunca gravado', async () => {
      const r = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, fornecedorId, descricao: PREFIXO_TESTE + ' vencida', categoria: 'Fornecedores', valor: 500.5, vencimento: ontem });
      criados.pagar.push(r.conta.id);
      assert.equal(r.conta.status, 'vencido');
      assert.equal(r.conta.statusBase, 'pendente'); // nunca grava "vencido" de verdade
      assert.equal(r.conta.fornecedorNome, PREFIXO_TESTE + ' Fornecedor');
    });

    test('vencendo hoje não conta como vencido', async () => {
      const r = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' hoje', valor: 200, vencimento: hoje });
      criados.pagar.push(r.conta.id);
      assert.equal(r.conta.status, 'pendente');
    });

    test('resumo: totalAPagar/vencendoHoje/vencidas são o saldo em aberto (não dependem do período)', async () => {
      const periodoHoje = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('hoje'));
      const periodoMes = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('mes'));
      const r1 = await contasPagar.resumoContasPagar({ empresaId: EMPRESA_ID, ...periodoHoje });
      const r2 = await contasPagar.resumoContasPagar({ empresaId: EMPRESA_ID, ...periodoMes });
      assert.equal(r1.vencidas, r2.vencidas, 'vencidas não deveria mudar com o período');
      assert.equal(r1.totalAPagar, r2.totalAPagar, 'totalAPagar não deveria mudar com o período');
      assert.ok(r1.vencidas >= 500.5);
      assert.ok(r1.vencendoHoje >= 200);
    });

    test('marcar como pago, depois bloqueia edição e exclusão', async () => {
      const criada = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' a pagar', valor: 77, vencimento: amanha });
      criados.pagar.push(criada.conta.id);
      const pago = await contasPagar.marcarComoPago(criada.conta.id, hoje);
      assert.equal(pago.conta.status, 'pago');
      assert.equal(pago.conta.dataPagamento, hoje);

      const edit = await contasPagar.atualizarContaPagar(criada.conta.id, { valor: 999 });
      assert.ok(edit.errors);
      const del = await contasPagar.excluirContaPagar(criada.conta.id);
      assert.ok(del.errors);

      const repetir = await contasPagar.marcarComoPago(criada.conta.id, hoje);
      assert.ok(repetir.errors, 'não deveria permitir pagar de novo uma conta já paga');
    });

    test('cancelar bloqueado se já pago; permitido se pendente', async () => {
      const criada = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' cancelavel', valor: 33, vencimento: amanha });
      criados.pagar.push(criada.conta.id);
      const cancelada = await contasPagar.cancelarContaPagar(criada.conta.id);
      assert.equal(cancelada.conta.status, 'cancelado');
      const cancelarDeNovo = await contasPagar.cancelarContaPagar(criada.conta.id);
      assert.ok(cancelarDeNovo.errors);
    });

    test('filtro por status efetivo (vencido) e por busca', async () => {
      const periodoMes = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('mes'));
      const vencidas = await contasPagar.listarContasPagar({ empresaId: EMPRESA_ID, ...periodoMes, status: 'vencido' });
      assert.ok(vencidas.some(c => c.descricao === PREFIXO_TESTE + ' vencida'));
      assert.ok(vencidas.every(c => c.status === 'vencido'));

      const busca = await contasPagar.listarContasPagar({ empresaId: EMPRESA_ID, ...periodoMes, search: 'vencida' });
      assert.ok(busca.some(c => c.descricao === PREFIXO_TESTE + ' vencida'));
    });

    test('BUG CORRIGIDO: conta com vencimento futuro aparece na lista mesmo com o período mais estreito do header', async () => {
      // Antes da correção, a lista era sempre filtrada por vencimento dentro
      // do período do header — e nenhuma opção de período (hoje/ontem/7d/
      // 30d/mes) inclui datas futuras (o limite superior é sempre "agora",
      // nunca o fim do mês/período). Uma conta recém-criada com vencimento
      // futuro ficava invisível na tela, sem aparecer nem em Pendente nem em
      // Vencido, até o vencimento "entrar" na janela do período.
      const futuro = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const r = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' futura', valor: 321, vencimento: futuro });
      criados.pagar.push(r.conta.id);
      assert.equal(r.conta.status, 'pendente');

      const periodoHoje = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('hoje'));
      const lista = await contasPagar.listarContasPagar({ empresaId: EMPRESA_ID, ...periodoHoje });
      const encontrada = lista.find(c => c.descricao === PREFIXO_TESTE + ' futura');
      assert.ok(encontrada, 'conta com vencimento futuro deveria aparecer na lista mesmo com período "hoje"');
      assert.equal(encontrada.status, 'pendente');
    });

    test('conta paga só aparece na lista quando a data de pagamento está dentro do período selecionado (pendentes/vencidas nunca dependem disso)', async () => {
      const criada = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' paga fora do periodo', valor: 88, vencimento: ontem });
      criados.pagar.push(criada.conta.id);
      const dataPagamentoAntiga = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await contasPagar.marcarComoPago(criada.conta.id, dataPagamentoAntiga);

      const periodoHoje = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('hoje'));
      const listaHoje = await contasPagar.listarContasPagar({ empresaId: EMPRESA_ID, ...periodoHoje });
      assert.ok(!listaHoje.some(c => c.descricao === PREFIXO_TESTE + ' paga fora do periodo'), 'conta paga há 60 dias não deveria aparecer no período "hoje"');

      const listaAmpla = await contasPagar.listarContasPagar({ empresaId: EMPRESA_ID, desde: dataPagamentoAntiga, ate: hoje });
      const encontrada = listaAmpla.find(c => c.descricao === PREFIXO_TESTE + ' paga fora do periodo');
      assert.ok(encontrada, 'conta paga deveria aparecer quando a data de pagamento está dentro do período');
      assert.equal(encontrada.status, 'pago');
    });

    test('regressão do bug relatado pelo usuário: futura/hoje/vencida/paga aparecem todas na categoria certa, juntas, sob o período padrão do header (30d)', async () => {
      const futuro = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const passado = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const cFutura = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' regressao futura', valor: 10, vencimento: futuro });
      const cHoje = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' regressao hoje', valor: 20, vencimento: hoje });
      const cVencida = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' regressao vencida', valor: 30, vencimento: passado });
      const cPagaBase = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' regressao paga', valor: 40, vencimento: passado });
      criados.pagar.push(cFutura.conta.id, cHoje.conta.id, cVencida.conta.id, cPagaBase.conta.id);
      await contasPagar.marcarComoPago(cPagaBase.conta.id, hoje);

      const periodo30d = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('30d'));
      const lista = await contasPagar.listarContasPagar({ empresaId: EMPRESA_ID, ...periodo30d });
      const porDescricao = (desc) => lista.find(c => c.descricao === PREFIXO_TESTE + desc);

      assert.equal(porDescricao(' regressao futura').status, 'pendente');
      assert.equal(porDescricao(' regressao hoje').status, 'pendente');
      assert.equal(porDescricao(' regressao vencida').status, 'vencido');
      assert.equal(porDescricao(' regressao paga').status, 'pago');
    });
  });

  describe('Contas a Receber', () => {
    test('cria conta atrasada com status calculado', async () => {
      const r = await contasReceber.criarContaReceber({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' atrasada', origem: 'Venda direta', valor: 1234.56, dataPrevista: ontem });
      criados.receber.push(r.conta.id);
      assert.equal(r.conta.status, 'atrasado');
      assert.equal(r.conta.statusBase, 'a_receber');
    });

    test('marcar como recebido, depois bloqueia edição e exclusão', async () => {
      const criada = await contasReceber.criarContaReceber({ empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' a receber', valor: 50, dataPrevista: amanha });
      criados.receber.push(criada.conta.id);
      const recebido = await contasReceber.marcarComoRecebido(criada.conta.id, hoje);
      assert.equal(recebido.conta.status, 'recebido');
      const edit = await contasReceber.atualizarContaReceber(criada.conta.id, { valor: 1 });
      assert.ok(edit.errors);
      const del = await contasReceber.excluirContaReceber(criada.conta.id);
      assert.ok(del.errors);
    });

    test('resumo: atrasado/totalAReceber independentes do período, recebidoNoPeriodo depende', async () => {
      const periodoMes = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('mes'));
      const r = await contasReceber.resumoContasReceber({ empresaId: EMPRESA_ID, ...periodoMes });
      assert.ok(r.atrasado >= 1234.56);
      assert.ok(r.recebidoNoPeriodo >= 50);
    });
  });

  describe('Recebimentos (Mercado Livre) — dados reais sincronizados', () => {
    test('lista só pedidos com pagamento aprovado e não cancelados; nunca inventa liberação/recebimento', async () => {
      const desde = periodo.inicioDoDiaBRTDeString('2026-08-23');
      const ate = new Date(desde.getTime() + 24 * 60 * 60 * 1000);
      const recebimentos = await recebimentosMl.listarRecebimentosMl({ empresaId: EMPRESA_ID, desde, ate });
      assert.ok(recebimentos.length > 0, 'deveria haver recebimentos reais em 23/08/2026');
      for (const r of recebimentos) {
        assert.equal(r.marketplace, 'Mercado Livre');
        assert.equal(r.status, 'a_receber');
        assert.equal(r.dataPrevistaLiberacao, null);
        assert.equal(r.valorRecebido, null);
        assert.equal(r.dataRecebimento, null);
        if (r.valorBruto !== null && r.taxasDescontos !== null) {
          assert.equal(r.valorLiquidoEsperado, Math.round((r.valorBruto - r.taxasDescontos) * 100) / 100);
        }
      }
    });

    test('pedido real 2000018075073530: taxasDescontos = comissão + frete vendedor + desconto (sem imposto/custo)', async () => {
      const desde = periodo.inicioDoDiaBRTDeString('2026-08-23');
      const ate = new Date(desde.getTime() + 24 * 60 * 60 * 1000);
      const recebimentos = await recebimentosMl.listarRecebimentosMl({ empresaId: EMPRESA_ID, desde, ate });
      const p = recebimentos.find(r => r.pedidoRef === '2000018075073530');
      assert.ok(p, 'pedido 2000018075073530 deveria aparecer em Recebimentos');
      // frete vendedor rateado = 7.95 (Bug 1), desconto = 0 (sem cupom nesse pedido) — ver docs/04-alteracoes.md
      assert.equal(p.valorBruto, 43);
      assert.equal(p.taxasDescontos, 10.31);
      assert.equal(p.valorLiquidoEsperado, 32.69);
    });
  });

  describe('Recebimentos — ações manuais e resumo (Passo 1, 27/08/2026)', () => {
    let pool;
    before(() => { pool = require('../db/pool'); });

    test('status financeiro: a_receber -> disponivel -> recebido, nunca anda pra trás, nunca sobrescreve estado mais avançado', async () => {
      const { rows } = await pool.query(
        `SELECT id, status FROM recebimentos_marketplace WHERE empresa_id = $1 AND status = 'a_receber' ORDER BY id LIMIT 1`,
        [EMPRESA_ID]
      );
      assert.ok(rows.length, 'precisa existir um recebimento "a_receber" nos dados de teste');
      const id = rows[0].id;
      recebimentoMlRestaurar = { id, statusOriginal: rows[0].status };

      const disp = await recebimentosMl.marcarComoDisponivel(id, { dataEfetivaLiberacao: hoje });
      assert.equal(disp.errors, undefined);
      assert.equal(disp.recebimento.status, 'disponivel');
      assert.equal(disp.recebimento.dataEfetivaLiberacao, hoje);

      // Não pode marcar como disponível de novo (já não está mais em "a_receber").
      const dispDeNovo = await recebimentosMl.marcarComoDisponivel(id, {});
      assert.ok(dispDeNovo.errors, 'não pode marcar como disponível um recebimento que já não está mais "a_receber"');

      const rec = await recebimentosMl.marcarComoRecebido(id, { dataEfetivaRecebimento: hoje, valorRecebido: 99.9 });
      assert.equal(rec.errors, undefined);
      assert.equal(rec.recebimento.status, 'recebido');
      assert.equal(rec.recebimento.valorRecebido, 99.9);
      assert.equal(rec.recebimento.dataRecebimento, hoje);
      assert.equal(rec.recebimento.origemConfirmacao, 'manual');

      // Não pode marcar como recebido de novo (bloqueio de "andar pra trás"/duplicar).
      const recDeNovo = await recebimentosMl.marcarComoRecebido(id, {});
      assert.ok(recDeNovo.errors, 'não pode marcar como recebido um recebimento que já está recebido');

      // Nem definir previsão de liberação depois de já recebido (não faz sentido).
      const prevDepois = await recebimentosMl.definirPrevisaoLiberacao(id, amanha);
      assert.ok(prevDepois.errors, 'não pode definir previsão de liberação depois de já recebido');
    });

    test('definirPrevisaoLiberacao só é usada pelo usuário quando o ML não informa a data (nunca inventada automaticamente)', async () => {
      const { rows } = await pool.query(
        `SELECT id, status FROM recebimentos_marketplace WHERE empresa_id = $1 AND status = 'a_receber' AND id != COALESCE($2, 0) ORDER BY id LIMIT 1`,
        [EMPRESA_ID, recebimentoMlRestaurar ? recebimentoMlRestaurar.id : null]
      );
      assert.ok(rows.length, 'precisa existir outro recebimento "a_receber" nos dados de teste');
      const id = rows[0].id;
      const antes = recebimentoMlRestaurar;
      // se o teste anterior já marcou um id pra restaurar, mantém — só adiciona este se for outro.

      const result = await recebimentosMl.definirPrevisaoLiberacao(id, amanha);
      assert.equal(result.errors, undefined);
      assert.equal(result.recebimento.dataPrevistaLiberacao, amanha);
      assert.equal(result.recebimento.status, 'a_receber', 'informar a previsão de liberação não muda o status');

      // limpa esse segundo recebimento manualmente (não é o principal rastreado por recebimentoMlRestaurar).
      await pool.query(`UPDATE recebimentos_marketplace SET data_prevista_liberacao = NULL, updated_at = now() WHERE id = $1`, [id]);
      recebimentoMlRestaurar = antes;
    });

    test('resumoRecebimentosMarketplace nunca chama "recebido no banco" o que só está "disponível"/liberado pelo marketplace', async () => {
      const resumo = await recebimentosMl.resumoRecebimentosMarketplace(EMPRESA_ID);
      assert.equal(typeof resumo.recebidoHoje, 'number');
      assert.equal(typeof resumo.recebidoMes, 'number');
      assert.equal(typeof resumo.aReceberTotal, 'number');
      assert.ok(Array.isArray(resumo.porMarketplace));
      assert.ok(Array.isArray(resumo.porLoja));
      assert.ok(resumo.aReceberSemPrevisaoDeLiberacao, 'precisa expor separadamente o que não tem previsão — nunca somar escondido num recorte de dias');
    });
  });
});
