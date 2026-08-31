// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/dre.test.js) da etapa "Categorias financeiras + DRE detalhada +
// conciliação simples", ativada em 31/08/2026.
//
// Cobre os cenários #5-#20 da lista de 20 cenários obrigatórios pedidos
// pelo usuário (os #1-#4 e #18 já são cobertos por test/contasBancarias.test.js
// e test/saldoExtratoFluxo.test.js, herdados da etapa anterior — ver
// docs/02-decisoes.md):
//   5  lançar despesa sem fornecedor
//   6  lançar "Salgados" na categoria Alimentação (subcategoria)
//   7  categoria aparecer na DRE
//   8  DRE detalhar as despesas da categoria (itens/subcategoria)
//   9  gráfico usar os mesmos valores da DRE (mesma lista/soma)
//   10 transferência interna não entrar como despesa
//   11 conta a pagar conciliada com extrato não duplicar
//   12 busca por CR/documento
//   13 busca por descrição
//   14 filtros por período
//   15 filtros por categoria (inclui subcategoria -> categoria pai)
//   16 multiempresa (isolamento total por empresa_id)
//   17 exportação detalhada (rota HTTP real)
//   19 CMV não ser duplicado / nunca afetado por despesas
//   20 alteração de categoria refletir corretamente nos relatórios (JOIN vivo)
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test test/dreCategoriasDespesas.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_A = 987001;
const EMPRESA_B = 987002;
const PREFIXO = '[TESTE AUTOMATIZADO DRE/CATEGORIAS]';

describe('Categorias financeiras + Despesas detalhadas + DRE — 31/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let pool, periodo, categoriasFinanceiras, contasPagar, contasBancarias, despesasFinanceiras, dreLib;
  let desde, ate, desdeBRT, ateBRT;
  let alimentacaoId, salgadosId, softwareId;
  let contaBancariaAId;
  let contaSemFornecedor, contaSalgados, contaForaPeriodo, contaOutraCategoria, contaConciliada, contaEmpresaB;
  let movimentoTransferencia, movimentoConciliado;

  before(async () => {
    pool = require('../db/pool');
    periodo = require('../lib/periodo');
    categoriasFinanceiras = require('../lib/categoriasFinanceiras');
    contasPagar = require('../lib/contasPagar');
    contasBancarias = require('../lib/contasBancarias');
    despesasFinanceiras = require('../lib/despesasFinanceiras');
    dreLib = require('../lib/dre');

    await pool.query(
      `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'98700100000191','EMPRESA TESTE DRE CATEGORIAS A',TRUE), ($2,'98700200000191','EMPRESA TESTE DRE CATEGORIAS B',TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [EMPRESA_A, EMPRESA_B]
    );

    // Período próprio deste arquivo — 2026-08-27 a 2026-08-30 — nunca
    // reaproveita o período de test/dre.test.js (2026-08-22 a 2026-08-25),
    // pra nunca correr risco de contar lançamento de um arquivo no outro.
    desde = periodo.inicioDoDiaBRTDeString('2026-08-27');
    ate = periodo.inicioDoDiaBRTDeString('2026-08-31'); // limite exclusivo -> cobre até 2026-08-30
    ({ desde: desdeBRT, ate: ateBRT } = periodo.periodoParaDatasBRT({ desde, ate }));

    // Semeia as 25 categorias padrão pra empresa A (primeira chamada real) e
    // localiza "Alimentação" e "Software" pra usar nos testes.
    const cats = await categoriasFinanceiras.listarCategoriasFlat({ empresaId: EMPRESA_A });
    alimentacaoId = cats.find((c) => c.nome === 'Alimentação').id;
    softwareId = cats.find((c) => c.nome === 'Software').id;

    // Subcategoria "Salgados" dentro de "Alimentação" — único nível,
    // exatamente como pedido ("se não complicar... não criar complexidade
    // desnecessária").
    const criadaSub = await categoriasFinanceiras.criarCategoria({ empresaId: EMPRESA_A, nome: PREFIXO + ' Salgados', categoriaPaiId: alimentacaoId });
    salgadosId = criadaSub.categoria.id;

    const contaBanco = await contasBancarias.criarContaBancaria({ empresaId: EMPRESA_A, nome: PREFIXO + ' Conta Corrente' });
    contaBancariaAId = contaBanco.conta.id;

    // #5 — despesa qualquer, sem fornecedor (fornecedorId nunca obrigatório).
    const c5 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_A, descricao: PREFIXO + ' Compra avulsa sem fornecedor', valor: 45, vencimento: '2026-08-28' });
    assert.ok(c5.conta, 'esperava criar a conta sem fornecedor: ' + JSON.stringify(c5.errors));
    contaSemFornecedor = (await contasPagar.marcarComoPago(c5.conta.id, '2026-08-28')).conta;

    // #6 — "Salgados" na categoria Alimentação (subcategoria), com CR pra
    // alimentar os testes de busca (#12).
    const c6 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_A, descricao: PREFIXO + ' Salgados para evento de lançamento', categoriaId: salgadosId, documento: 'CR-777', valor: 80, vencimento: '2026-08-28' });
    assert.ok(c6.conta, 'esperava criar a conta Salgados: ' + JSON.stringify(c6.errors));
    contaSalgados = (await contasPagar.marcarComoPago(c6.conta.id, '2026-08-28')).conta;

    // #14 — despesa paga FORA do período do teste (deve ficar de fora dos
    // filtros por período).
    const c14 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_A, descricao: PREFIXO + ' Despesa fora do período', valor: 30, vencimento: '2026-08-20' });
    contaForaPeriodo = (await contasPagar.marcarComoPago(c14.conta.id, '2026-08-20')).conta;

    // #15 — despesa em outra categoria (Software), pra provar que o filtro
    // por categoria realmente restringe.
    const c15 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_A, descricao: PREFIXO + ' Assinatura de software', categoriaId: softwareId, valor: 60, vencimento: '2026-08-29' });
    contaOutraCategoria = (await contasPagar.marcarComoPago(c15.conta.id, '2026-08-29')).conta;

    // #11 — conta a pagar paga E também vista no extrato (mesma despesa,
    // duas fontes) — conciliada manualmente, nunca deve dobrar o total.
    const c11 = await contasPagar.criarContaPagar({ empresaId: EMPRESA_A, descricao: PREFIXO + ' Frete conciliado com extrato', valor: 150, vencimento: '2026-08-29' });
    contaConciliada = (await contasPagar.marcarComoPago(c11.conta.id, '2026-08-29')).conta;
    const impConciliado = await contasBancarias.confirmarImportacao({
      empresaId: EMPRESA_A, contaBancariaId: contaBancariaAId, nomeArquivo: PREFIXO + ' extrato-conciliacao.csv', arquivoHash: 'hash-conciliacao-' + Date.now(), formato: 'csv',
      movimentos: [{ data: '2026-08-29', tipo: 'saida', descricao: PREFIXO + ' Frete visto no extrato', valor: 150, fingerprint: 'fp-conciliacao-' + Date.now() }],
    }, pool);
    const movsConciliado = await contasBancarias.listarMovimentos({ empresaId: EMPRESA_A, contaBancariaId: contaBancariaAId, limite: 500 });
    movimentoConciliado = movsConciliado.find((m) => m.descricao === PREFIXO + ' Frete visto no extrato');
    assert.ok(movimentoConciliado, 'esperava encontrar o movimento importado pra conciliar');
    const vinculo = await contasBancarias.vincularContaPagar(movimentoConciliado.id, contaConciliada.id, { empresaId: EMPRESA_A });
    assert.ok(vinculo.ok, 'esperava conciliar com sucesso: ' + JSON.stringify(vinculo));

    // #10 — transferência interna entre contas da própria empresa nunca é
    // despesa.
    const impTransferencia = await contasBancarias.confirmarImportacao({
      empresaId: EMPRESA_A, contaBancariaId: contaBancariaAId, nomeArquivo: PREFIXO + ' extrato-transferencia.csv', arquivoHash: 'hash-transferencia-' + Date.now(), formato: 'csv',
      movimentos: [{ data: '2026-08-29', tipo: 'saida', descricao: PREFIXO + ' PIX entre contas próprias', valor: 500, fingerprint: 'fp-transferencia-' + Date.now() }],
    }, pool);
    const movsTransferencia = await contasBancarias.listarMovimentos({ empresaId: EMPRESA_A, contaBancariaId: contaBancariaAId, limite: 500 });
    movimentoTransferencia = movsTransferencia.find((m) => m.descricao === PREFIXO + ' PIX entre contas próprias');
    assert.ok(movimentoTransferencia, 'esperava encontrar o movimento de transferência');
    const marcado = await contasBancarias.marcarTransferenciaInterna(movimentoTransferencia.id, { empresaId: EMPRESA_A, transferenciaInterna: true });
    assert.ok(marcado.ok, 'esperava marcar como transferência interna: ' + JSON.stringify(marcado));

    // #16 — mesma janela de tempo, despesa de OUTRA empresa (isolamento).
    const cB = await contasPagar.criarContaPagar({ empresaId: EMPRESA_B, descricao: PREFIXO + ' Despesa da empresa B', valor: 999, vencimento: '2026-08-28' });
    contaEmpresaB = (await contasPagar.marcarComoPago(cB.conta.id, '2026-08-28')).conta;
  });

  after(async () => {
    await pool.query('DELETE FROM extrato_movimentos WHERE empresa_id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
    await pool.query('DELETE FROM extrato_importacoes WHERE empresa_id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
    await pool.query('DELETE FROM contas_pagar WHERE empresa_id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
    await pool.query('DELETE FROM contas_bancarias WHERE empresa_id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
    await pool.query('DELETE FROM categorias_financeiras WHERE empresa_id = ANY($1) AND categoria_pai_id IS NOT NULL', [[EMPRESA_A, EMPRESA_B]]);
    await pool.query('DELETE FROM categorias_financeiras WHERE empresa_id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
    await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_A, EMPRESA_B]]);
    await pool.end();
  });

  test('#5 — lança despesa sem fornecedor (fornecedorId nunca é obrigatório)', () => {
    assert.equal(contaSemFornecedor.fornecedorId, null);
    assert.equal(contaSemFornecedor.status, 'pago');
    assert.equal(contaSemFornecedor.valor, 45);
  });

  test('#6 — lança "Salgados" na categoria Alimentação (subcategoria de um único nível)', () => {
    assert.equal(contaSalgados.categoriaId, salgadosId);
    assert.equal(contaSalgados.categoria, PREFIXO + ' Salgados');
  });

  test('#7 e #9 — categoria aparece na DRE, e o gráfico usa a MESMA lista/soma dos cards', async () => {
    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT });
    const blocoAlimentacao = dre.despesas.porCategoria.find((c) => c.categoria === 'Alimentação');
    assert.ok(blocoAlimentacao, 'esperava um bloco "Alimentação" na DRE');
    assert.equal(blocoAlimentacao.total, 80);

    // "PARA ONDE ESTÁ INDO O DINHEIRO?" é alimentado por dre.despesas.porCategoria
    // — o MESMO array usado pelos cards do topo (dre.despesas.cards) — nunca
    // uma segunda consulta com filtro diferente.
    const somaCategorias = dre.despesas.porCategoria.reduce((s, c) => s + c.total, 0);
    assert.equal(Math.round(somaCategorias * 100) / 100, dre.despesas.cards.totalDespesas);
  });

  test('#8 — DRE detalha as despesas da categoria (subcategoria + itens)', async () => {
    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT });
    const blocoAlimentacao = dre.despesas.porCategoria.find((c) => c.categoria === 'Alimentação');
    const subSalgados = blocoAlimentacao.subcategorias.find((s) => s.subcategoria === PREFIXO + ' Salgados');
    assert.ok(subSalgados, 'esperava a subcategoria Salgados dentro do bloco Alimentação');
    assert.equal(subSalgados.total, 80);
    assert.ok(subSalgados.itens.some((i) => i.descricao === PREFIXO + ' Salgados para evento de lançamento'));
    assert.ok(blocoAlimentacao.itens.some((i) => i.descricao === PREFIXO + ' Salgados para evento de lançamento'), 'o item também aparece agregado no nível da categoria-pai');
  });

  test('#10 — transferência interna entre contas próprias nunca entra como despesa', async () => {
    const despesas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT });
    assert.equal(despesas.some((d) => d.descricao === PREFIXO + ' PIX entre contas próprias'), false);

    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT });
    const somaTotal = dre.despesas.cards.totalDespesas;
    assert.ok(somaTotal < 500, 'os R$500 da transferência interna nunca deveriam entrar no total de despesas');
  });

  test('#11 — conta a pagar conciliada com o extrato conta UMA VEZ só (nunca duplica)', async () => {
    const despesas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT });
    // Do lado de contas_pagar, entra normalmente:
    assert.ok(despesas.some((d) => d.id === 'cp-' + contaConciliada.id && d.valor === 150));
    // Do lado do extrato, o MESMO movimento (agora com conta_pagar_id
    // preenchido) nunca aparece de novo:
    assert.equal(despesas.some((d) => d.id === 'em-' + movimentoConciliado.id), false);
    // A soma dos R$150 aparece só uma vez no total, nunca R$300:
    const total150 = despesas.filter((d) => d.descricao.includes('Frete')).reduce((s, d) => s + d.valor, 0);
    assert.equal(total150, 150);
  });

  test('#12 — busca por CR/documento encontra o lançamento', async () => {
    const despesas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT, search: 'CR-777' });
    assert.equal(despesas.length, 1);
    assert.equal(despesas[0].documento, 'CR-777');
  });

  test('#13 — busca por descrição encontra o lançamento', async () => {
    const despesas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT, search: 'evento de lançamento' });
    assert.equal(despesas.length, 1);
    assert.equal(despesas[0].id, 'cp-' + contaSalgados.id);
  });

  test('#14 — filtro por período exclui despesa paga fora da janela', async () => {
    const despesas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT });
    assert.equal(despesas.some((d) => d.id === 'cp-' + contaForaPeriodo.id), false);

    // Ampliando o período pra cobrir 2026-08-20, a despesa aparece:
    const { desde: desde2, ate: ate2 } = periodo.periodoParaDatasBRT({ desde: periodo.inicioDoDiaBRTDeString('2026-08-19'), ate });
    const despesasAmplas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desde2, ate: ate2 });
    assert.ok(despesasAmplas.some((d) => d.id === 'cp-' + contaForaPeriodo.id));
  });

  test('#15 — filtro por categoria restringe corretamente (inclui subcategoria -> pai)', async () => {
    const soAlimentacao = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT, categoriaId: alimentacaoId });
    assert.ok(soAlimentacao.every((d) => d.categoria === 'Alimentação'), 'filtrar por Alimentação nunca deveria trazer Software');
    assert.ok(soAlimentacao.some((d) => d.subcategoria === PREFIXO + ' Salgados'), 'a subcategoria Salgados deveria aparecer ao filtrar pela categoria-pai Alimentação');
    assert.equal(soAlimentacao.some((d) => d.id === 'cp-' + contaOutraCategoria.id), false);
  });

  test('#16 — multiempresa: despesa da empresa B nunca aparece pra empresa A', async () => {
    const despesasA = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT });
    assert.equal(despesasA.some((d) => d.id === 'cp-' + contaEmpresaB.id), false);

    const despesasB = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_B, desde: desdeBRT, ate: ateBRT });
    assert.ok(despesasB.some((d) => d.id === 'cp-' + contaEmpresaB.id));
    assert.equal(despesasB.some((d) => d.id === 'cp-' + contaSalgados.id), false, 'a categoria/despesa da empresa A nunca vaza pra empresa B');

    const dreA = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT });
    assert.equal(dreA.despesas.cards.quantidadeDespesas < 20, true); // sanity: não inclui o volume da empresa B
  });

  test('#19 — CMV/receita nunca são afetados pelo filtro de despesas (fórmula sempre isolada)', async () => {
    const dreSemFiltro = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT });
    const dreComFiltro = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT, categoriaId: alimentacaoId });

    // O filtro de categoria muda o total de despesas mostrado...
    assert.notEqual(dreSemFiltro.despesas.cards.totalDespesas, dreComFiltro.despesas.cards.totalDespesas);
    // ...mas NUNCA muda receita, cancelamentos, CMV ou margem de contribuição
    // (que não têm nada a ver com categoria de despesa — são a mesma fonte
    // única de lib/relatorioVendas.js, intocada por esta etapa).
    assert.deepEqual(dreSemFiltro.linhas.custoProdutos, dreComFiltro.linhas.custoProdutos);
    assert.deepEqual(dreSemFiltro.linhas.receitaBruta, dreComFiltro.linhas.receitaBruta);
    assert.deepEqual(dreSemFiltro.linhas.margemContribuicao, dreComFiltro.linhas.margemContribuicao);
  });

  test('#20 — renomear uma categoria reflete imediatamente nos relatórios (JOIN vivo, nunca uma cópia congelada)', async () => {
    const novoNome = PREFIXO + ' Salgados Fritos (renomeado)';
    const upd = await categoriasFinanceiras.atualizarCategoria(salgadosId, { nome: novoNome });
    assert.ok(upd.categoria, 'esperava renomear com sucesso: ' + JSON.stringify(upd.errors));

    try {
      const despesas = await despesasFinanceiras.listarDespesasDetalhadas({ empresaId: EMPRESA_A, desde: desdeBRT, ate: ateBRT });
      const item = despesas.find((d) => d.id === 'cp-' + contaSalgados.id);
      assert.equal(item.subcategoria, novoNome, 'o lançamento antigo passa a mostrar o novo nome, sem precisar editar ele mesmo');

      const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_A, desde, ate, desdeBRT, ateBRT });
      const blocoAlimentacao = dre.despesas.porCategoria.find((c) => c.categoria === 'Alimentação');
      assert.ok(blocoAlimentacao.subcategorias.some((s) => s.subcategoria === novoNome));
    } finally {
      // Devolve o nome original pra não confundir os outros testes deste
      // arquivo que rodam depois (node --test roda os testes de um mesmo
      // describe em ordem, mas melhor não depender disso).
      await categoriasFinanceiras.atualizarCategoria(salgadosId, { nome: PREFIXO + ' Salgados' });
    }
  });

  describe('#17 — exportação (rota HTTP real GET /api/dre/exportar)', () => {
    let server, baseUrl;

    before(async () => {
      const express = require('express');
      const dreRouter = require('../routes/dre');
      const app = express();
      app.use(express.json());
      app.use('/api/dre', dreRouter);
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => { await new Promise((resolve) => server.close(resolve)); });

    test('exportação resumida (xlsx) responde 200 com o content-type correto', async () => {
      const resp = await fetch(`${baseUrl}/api/dre/exportar?tipo=resumida&formato=xlsx&empresaId=${EMPRESA_A}&periodo=personalizado&desde=2026-08-27&ate=2026-08-30`);
      assert.equal(resp.status, 200);
      assert.match(resp.headers.get('content-type') || '', /spreadsheetml/);
    });

    test('exportação detalhada de despesas (csv) traz o lançamento e respeita a busca', async () => {
      const resp = await fetch(`${baseUrl}/api/dre/exportar?tipo=despesas&formato=csv&empresaId=${EMPRESA_A}&periodo=personalizado&desde=2026-08-27&ate=2026-08-30`);
      assert.equal(resp.status, 200);
      assert.match(resp.headers.get('content-type') || '', /text\/csv/);
      const texto = await resp.text();
      assert.match(texto, /Salgados para evento de lan.amento/);
      assert.doesNotMatch(texto, /Despesa da empresa B/, 'exportação nunca deve vazar dado de outra empresa');
    });

    test('GET /api/dre principal responde com o bloco de despesas por categoria', async () => {
      const resp = await fetch(`${baseUrl}/api/dre?empresaId=${EMPRESA_A}&periodo=personalizado&desde=2026-08-27&ate=2026-08-30`);
      assert.equal(resp.status, 200);
      const body = await resp.json();
      assert.ok(body.dre.despesas.porCategoria.some((c) => c.categoria === 'Alimentação'));
    });
  });
});
