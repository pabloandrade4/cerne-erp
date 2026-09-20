// Testes da Etapa "ativar a parte inferior da Visão Geral" (26/08/2026) —
// Evolução diária (já coberta por relatorioVendas.test.js/relatorios.test.js
// via serieDiaria) + Por marketplace, Fluxo de Caixa, Conexões & Empresas e
// Alertas & IA (lib/visaoGeralPainel.js).
//
// Parte 1 (sem banco): funções puras (identificarCanal, porCanal,
// resumoRecebimentos) com pedidos FABRICADOS — confirma a matemática de
// agrupamento/porcentagem sem depender de dado real.
//
// Parte 2 (precisa de Postgres local — DATABASE_URL, mesmo padrão dos
// outros *.test.js): gerarAlertas contra um Postgres real (só a consulta de
// estoque baixo/zerado precisa de banco; os outros 6 tipos de alerta usam
// pedidos/fluxoCaixa/conexões fabricados, pra testar cada regra isolada, na
// mesma chamada) + painelVisaoGeral de ponta a ponta contra a empresa 900
// (11 pedidos reais já seedados por outros testes — reconciliação PF ERP x
// Mercado Turbo) e contra uma empresa vazia (sem conta, sem pedido).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  painelVisaoGeral, identificarCanal, porCanal, evolucaoFaturamento, resumoRecebimentos,
  conexoesEEmpresas, gerarAlertas, formatMoney,
} = require('../lib/visaoGeralPainel');

function pedidoFake(overrides) {
  return {
    id: overrides.id || 1,
    cancelado: false,
    valorTotal: 100,
    desconto: 0,
    tarifasMl: 10,
    freteVendedor: 5,
    imposto: 2,
    custoProduto: 20,
    margemContribuicao: 63,
    margemPercentual: 63,
    calculoCompleto: true,
    pagamentoStatus: 'approved',
    ...overrides,
  };
}

describe('visaoGeralPainel — funções puras (sem banco)', () => {
  test('identificarCanal sempre devolve "Mercado Livre" hoje (única integração existente)', () => {
    assert.equal(identificarCanal(pedidoFake({})), 'Mercado Livre');
    assert.equal(identificarCanal({}), 'Mercado Livre');
  });

  test('porCanal agrupa tudo em "Mercado Livre" com 100% de participação quando só há 1 canal', () => {
    const pedidos = [pedidoFake({ id: 1, valorTotal: 100 }), pedidoFake({ id: 2, valorTotal: 300 })];
    const resultado = porCanal(pedidos);
    assert.equal(resultado.linhas.length, 1);
    assert.equal(resultado.linhas[0].canal, 'Mercado Livre');
    assert.equal(resultado.linhas[0].qtdPedidos, 2);
    assert.equal(resultado.linhas[0].faturamento.valor, 400);
    assert.equal(resultado.linhas[0].participacaoPercentual, 100);
    assert.equal(resultado.totalFaturamento, 400);
  });

  test('porCanal nunca inventa participação quando o faturamento total está pendente (null)', () => {
    const pedidos = [pedidoFake({ id: 1, valorTotal: null })];
    const resultado = porCanal(pedidos);
    assert.equal(resultado.totalFaturamento, null);
    assert.equal(resultado.linhas[0].participacaoPercentual, null);
  });

  test('porCanal ignora pedidos cancelados (mesma regra de resumirPeriodo)', () => {
    const pedidos = [pedidoFake({ id: 1, valorTotal: 100 }), pedidoFake({ id: 2, valorTotal: 999, cancelado: true })];
    const resultado = porCanal(pedidos);
    assert.equal(resultado.linhas[0].qtdPedidos, 1);
    assert.equal(resultado.linhas[0].faturamento.valor, 100);
  });

  test('porCanal com lista vazia nunca inventa total (fica null, não zero)', () => {
    const resultado = porCanal([]);
    assert.deepEqual(resultado.linhas, []);
    assert.equal(resultado.totalFaturamento, null);
  });

  test('resumoRecebimentos soma só pedidos elegíveis (pagamento aprovado, não cancelado)', () => {
    const pedidos = [
      pedidoFake({ id: 1, valorTotal: 100, tarifasMl: 10, freteVendedor: 5, desconto: 0, pagamentoStatus: 'approved' }),
      pedidoFake({ id: 2, valorTotal: 200, tarifasMl: 20, freteVendedor: 0, desconto: 0, pagamentoStatus: 'pending' }),
      pedidoFake({ id: 3, valorTotal: 50, tarifasMl: 5, freteVendedor: 0, desconto: 0, cancelado: true, pagamentoStatus: 'approved' }),
    ];
    const resumo = resumoRecebimentos(pedidos);
    // Só o pedido 1 é elegível (aprovado e não cancelado): 100 - 10 - 5 = 85.
    assert.equal(resumo.quantidade, 1);
    assert.equal(resumo.valorLiquidoEsperado, 85);
    assert.equal(resumo.pendentes, 0);
  });

  test('formatMoney formata igual ao resto do projeto (R$, vírgula, 2 casas)', () => {
    assert.equal(formatMoney(1234.5), 'R$ 1.234,50');
  });
});

// 20/09/2026 — pedido explícito do usuário: "em visão geral quero colocar
// tudo que for possível... principalmente se o faturamento está caindo ou
// aumentando, comparado ao mês passado".
describe('evolucaoFaturamento — compara com o período anterior, nunca inventa % a partir de dado faltando', () => {
  const periodoAnterior = { desdeStr: '01/08/2026', ateStr: '20/08/2026' };

  test('faturamento subiu: variação positiva, tendência "subindo"', () => {
    const r = evolucaoFaturamento({ faturamentoAtual: 1200, faturamentoAnterior: 1000, periodoAnterior });
    assert.equal(r.variacaoValor, 200);
    assert.equal(r.variacaoPct, 20);
    assert.equal(r.tendencia, 'subindo');
    assert.equal(r.motivoSemDado, null);
    assert.deepEqual(r.periodoAnterior, { desde: '01/08/2026', ate: '20/08/2026' });
  });

  test('faturamento caiu: variação negativa, tendência "caindo"', () => {
    const r = evolucaoFaturamento({ faturamentoAtual: 800, faturamentoAnterior: 1000, periodoAnterior });
    assert.equal(r.variacaoValor, -200);
    assert.equal(r.variacaoPct, -20);
    assert.equal(r.tendencia, 'caindo');
  });

  test('faturamento igual: tendência "estavel", variação 0', () => {
    const r = evolucaoFaturamento({ faturamentoAtual: 1000, faturamentoAnterior: 1000, periodoAnterior });
    assert.equal(r.variacaoValor, 0);
    assert.equal(r.variacaoPct, 0);
    assert.equal(r.tendencia, 'estavel');
  });

  test('sem faturamento no período atual (null): nunca inventa uma variação, motivo explícito', () => {
    const r = evolucaoFaturamento({ faturamentoAtual: null, faturamentoAnterior: 1000, periodoAnterior });
    assert.equal(r.variacaoValor, null);
    assert.equal(r.variacaoPct, null);
    assert.equal(r.tendencia, 'sem_dado');
    assert.match(r.motivoSemDado, /confirmado/);
  });

  test('sem faturamento no período anterior (null): nunca inventa uma variação, motivo explícito', () => {
    const r = evolucaoFaturamento({ faturamentoAtual: 1000, faturamentoAnterior: null, periodoAnterior });
    assert.equal(r.variacaoValor, null);
    assert.equal(r.tendencia, 'sem_dado');
  });

  test('período anterior era 0 e o atual tem faturamento: sobe, mas sem % (base zero não tem leitura útil)', () => {
    const r = evolucaoFaturamento({ faturamentoAtual: 500, faturamentoAnterior: 0, periodoAnterior });
    assert.equal(r.variacaoValor, 500);
    assert.equal(r.variacaoPct, null);
    assert.equal(r.tendencia, 'subindo');
  });
});

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_REAL_ID = 900; // já seedada por outros testes (11 pedidos reais)
const EMPRESA_ALERTAS_ID = 961;
const CONTA_ALERTAS_ID = 961;
const EMPRESA_VAZIA_ID = 962;

describe(
  'visaoGeralPainel — integração (Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado (ver relatorioVendas.integration.test.js)' },
  () => {
    let pool;

    before(async () => {
      pool = require('../db/pool');
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
           ($1,'55555555000191','EMPRESA TESTE ALERTAS VISAO GERAL',TRUE),
           ($2,'44444444000191','EMPRESA VAZIA VISAO GERAL',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ALERTAS_ID, EMPRESA_VAZIA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,961000001,'LOJA ALERTAS TESTE','x','x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa'`,
        [CONTA_ALERTAS_ID, EMPRESA_ALERTAS_ID]
      );
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ALERTAS_ID]);
      await pool.query(
        `INSERT INTO ml_estoque_itens
           (conta_ml_id, empresa_id, tipo, ml_item_id, ml_variation_id, titulo, sku, loja, status, quantidade, pendente, motivo_pendencia, recurso_usado)
         VALUES
           ($1,$2,'proprio','MLB900',NULL,'Item zerado','SKU-ZERADO','LOJA ALERTAS TESTE','active',0,FALSE,NULL,'available_quantity'),
           ($1,$2,'proprio','MLB901',NULL,'Item estoque baixo','SKU-BAIXO','LOJA ALERTAS TESTE','active',3,FALSE,NULL,'available_quantity'),
           ($1,$2,'proprio','MLB902',NULL,'Item estoque normal','SKU-NORMAL','LOJA ALERTAS TESTE','active',500,FALSE,NULL,'available_quantity'),
           ($1,$2,'proprio','MLB903',NULL,'Item pendente (nunca conta)','SKU-PENDENTE','LOJA ALERTAS TESTE','active',NULL,TRUE,'sem_dado_na_api',NULL)`,
        [CONTA_ALERTAS_ID, EMPRESA_ALERTAS_ID]
      );
      // Shopee (25/08/2026) — conta conectada só pra provar que
      // conexoesEEmpresas() passou a ler shopee_contas de verdade (deixou
      // de ser hardcoded em 0/"nao_conectado").
      await pool.query(
        `INSERT INTO shopee_contas (id, empresa_id, shopee_shop_id, shop_name, region, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,961000001,'LOJA SHOPEE ALERTAS TESTE','BR','x','x', now() + interval '4 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa'`,
        [CONTA_ALERTAS_ID, EMPRESA_ALERTAS_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ALERTAS_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ALERTAS_ID]);
      await pool.query('DELETE FROM shopee_contas WHERE id = $1', [CONTA_ALERTAS_ID]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ALERTAS_ID, EMPRESA_VAZIA_ID]]);
      await pool.end();
    });

    test('gerarAlertas dispara os 7 tipos de alerta quando as condições reais existem', async () => {
      const pedidos = [
        // Pedido sem custo (SKU não cadastrado em produtos).
        pedidoFake({ id: 101, valorTotal: 100, custoProduto: null, calculoCompleto: false, margemContribuicao: null }),
        // Venda com margem negativa (cálculo completo, resultado < 0).
        pedidoFake({ id: 102, valorTotal: 50, tarifasMl: 40, freteVendedor: 10, imposto: 5, custoProduto: 20, calculoCompleto: true, margemContribuicao: -25 }),
      ];
      const itens = [
        { sku: 'SKU-SEM-CUSTO-1', custoProduto: null },
        { sku: 'SKU-SEM-CUSTO-1', custoProduto: null }, // mesmo SKU 2x — não deve duplicar no alerta (Set)
        { sku: 'SKU-COM-CUSTO', custoProduto: 10 },
        { sku: null, custoProduto: null }, // sem SKU — nunca vira alerta de "SKU sem custo"
      ];
      const fluxoCaixa = {
        contasAPagar: { totalAPagar: 500, vencendoHoje: 0, vencidas: 300, pagasNoPeriodo: 0 },
        contasAReceber: { totalAReceber: 200, previstoHoje: 0, atrasado: 150, recebidoNoPeriodo: 0 },
        recebimentosMl: { quantidade: 0, valorLiquidoEsperado: null, pendentes: 0 },
        saldoProjetado: { valor: null, motivo: 'sem_saldo_bancario_cadastrado' },
      };
      const conexoes = await conexoesEEmpresas(EMPRESA_ALERTAS_ID);
      // Força status de erro numa conta fabricada (sem alterar o banco) —
      // testa só a regra de geração do alerta, não a gravação do status.
      conexoes.mercadoLivre.contas = [{ id: CONTA_ALERTAS_ID, nickname: 'LOJA ALERTAS TESTE', status: 'erro', ultimoErro: 'Token expirado.' }];

      const alertas = await gerarAlertas({ empresaId: EMPRESA_ALERTAS_ID, pedidos, itens, fluxoCaixa, conexoes });
      const tipos = alertas.map((a) => a.tipo);

      assert.ok(tipos.includes('sku_sem_custo'), 'deveria alertar SKU sem custo');
      const skuAlerta = alertas.find((a) => a.tipo === 'sku_sem_custo');
      assert.equal(skuAlerta.titulo, 'SKU SKU-SEM-CUSTO-1 está sem custo cadastrado', 'SKU único — mensagem no formato do exemplo do usuário');
      assert.equal(skuAlerta.pagina, 'products');

      assert.ok(tipos.includes('pedido_sem_custo'));
      assert.ok(tipos.includes('margem_negativa'));
      assert.ok(tipos.includes('ml_sync_erro'));
      assert.ok(tipos.includes('contas_pagar_vencidas'));
      assert.ok(tipos.includes('recebimento_atrasado'));
      assert.ok(tipos.includes('estoque_zerado'));
      assert.ok(tipos.includes('estoque_baixo'));

      const zerado = alertas.find((a) => a.tipo === 'estoque_zerado');
      assert.equal(zerado.titulo, '1 anúncio com estoque zerado');
      assert.equal(zerado.pagina, 'stock');
      const baixo = alertas.find((a) => a.tipo === 'estoque_baixo');
      assert.equal(baixo.titulo, '1 anúncio com estoque muito baixo', 'o item com 500 unidades nunca entra aqui');

      // Severidade danger sempre antes de warning.
      const severidades = alertas.map((a) => a.severidade);
      const primeiroWarningIdx = severidades.indexOf('warning');
      const ultimoDangerIdx = severidades.lastIndexOf('danger');
      if (primeiroWarningIdx !== -1 && ultimoDangerIdx !== -1) assert.ok(ultimoDangerIdx < primeiroWarningIdx);
    });

    test('gerarAlertas nunca inventa alerta quando está tudo limpo', async () => {
      const conexoesVazias = await conexoesEEmpresas(EMPRESA_VAZIA_ID);
      const fluxoCaixaLimpo = {
        contasAPagar: { totalAPagar: 0, vencendoHoje: 0, vencidas: 0, pagasNoPeriodo: 0 },
        contasAReceber: { totalAReceber: 0, previstoHoje: 0, atrasado: 0, recebidoNoPeriodo: 0 },
        recebimentosMl: { quantidade: 0, valorLiquidoEsperado: null, pendentes: 0 },
        saldoProjetado: { valor: null, motivo: 'sem_saldo_bancario_cadastrado' },
      };
      const alertas = await gerarAlertas({ empresaId: EMPRESA_VAZIA_ID, pedidos: [], itens: [], fluxoCaixa: fluxoCaixaLimpo, conexoes: conexoesVazias });
      assert.deepEqual(alertas, []);
    });

    test('conexoesEEmpresas: empresa sem conta do Mercado Livre nem da Shopee -> status "sem_conta", 0 contas nos dois', async () => {
      const resultado = await conexoesEEmpresas(EMPRESA_VAZIA_ID);
      assert.equal(resultado.mercadoLivre.contasConectadas, 0);
      assert.equal(resultado.mercadoLivre.status, 'sem_conta');
      assert.equal(resultado.mercadoLivre.ultimaSincronizacao, null);
      assert.equal(resultado.shopee.contasConectadas, 0);
      assert.equal(resultado.shopee.status, 'sem_conta');
      assert.ok(resultado.empresas.total >= 2, 'deveria contar pelo menos as empresas cadastradas por este arquivo de teste');
    });

    test('conexoesEEmpresas: empresa com conta ML e conta Shopee ativas reflete o status real dos dois (25/08/2026 — Shopee deixou de ser hardcoded)', async () => {
      const resultado = await conexoesEEmpresas(EMPRESA_ALERTAS_ID);
      assert.equal(resultado.mercadoLivre.contasConectadas, 1);
      assert.equal(resultado.mercadoLivre.status, 'ativa');
      assert.equal(resultado.shopee.contasConectadas, 1);
      assert.equal(resultado.shopee.status, 'ativa');
      assert.equal(resultado.shopee.contas[0].shopName, 'LOJA SHOPEE ALERTAS TESTE');
      assert.equal(resultado.shopee.contas[0].shopId, '961000001');
      assert.equal(resultado.shopee.contas[0].ultimaSincronizacao, null, 'Shopee ainda não importa pedidos nesta etapa — nunca inventa uma data');
    });

    test('painelVisaoGeral: empresa real (900) com pedidos já sincronizados — por canal bate 100% com o total geral', async () => {
      const resultado = await painelVisaoGeral({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      assert.ok(resultado.porCanal.linhas.length <= 1, 'hoje só existe o canal Mercado Livre');
      if (resultado.porCanal.linhas.length === 1) {
        assert.equal(resultado.porCanal.linhas[0].canal, 'Mercado Livre');
        assert.equal(resultado.porCanal.linhas[0].participacaoPercentual, 100);
      }
      assert.ok('contasAPagar' in resultado.fluxoCaixa);
      assert.ok('contasAReceber' in resultado.fluxoCaixa);
      assert.ok('recebimentosMl' in resultado.fluxoCaixa);
      // saldoProjetado (fim de período à frente) continua nunca calculado
      // por este painel — só a tela Fluxo de Caixa faz o laço dia-a-dia
      // completo (ver lib/fluxoCaixa.js#gerarFluxoDeCaixa). Desde
      // 31/08/2026 o motivo já não é "sem saldo bancário cadastrado" (isso
      // deixou de ser sempre verdade com a importação de extrato) — ver
      // saldoBancarioAtual abaixo pro saldo real, quando existir.
      assert.equal(resultado.fluxoCaixa.saldoProjetado.valor, null, 'nunca inventa saldo bancário');
      assert.equal(resultado.fluxoCaixa.saldoProjetado.motivo, 'projecao_dia_a_dia_disponivel_na_tela_fluxo_de_caixa');
      assert.ok('saldoBancarioAtual' in resultado.fluxoCaixa, 'deve expor o saldo bancário real consolidado (ou null com motivo) — nunca omitido');
      assert.ok(Array.isArray(resultado.alertas));
      // 20/09/2026 — comparação de faturamento com o período anterior e
      // resumo dos Agentes de IA, pedidos explicitamente pelo usuário pra
      // Visão Geral (ver evolucaoFaturamento e lib/ia/agentesResumo.js).
      assert.ok('faturamentoEvolucao' in resultado);
      assert.equal(resultado.faturamentoEvolucao.faturamentoAtual, resultado.porCanal.totalFaturamento);
      assert.ok(['subindo', 'caindo', 'estavel', 'sem_dado'].includes(resultado.faturamentoEvolucao.tendencia));
      assert.ok(resultado.faturamentoEvolucao.periodoAnterior.desde, 'período anterior precisa vir com a data explícita, nunca ambíguo');
      assert.ok(resultado.agentesIa, 'resumo dos Agentes de IA não deveria falhar pra uma empresa com dado real');
      assert.equal(resultado.agentesIaError, null);
      assert.ok(Array.isArray(resultado.agentesIa.agentes));
      assert.ok(resultado.agentesIa.agentes.length >= 6, 'os 6 agentes reais cadastrados precisam aparecer no resumo');
    });

    test('painelVisaoGeral: empresa vazia nunca quebra e nunca inventa dado', async () => {
      const resultado = await painelVisaoGeral({ empresaId: EMPRESA_VAZIA_ID, periodoChave: '30d' });
      assert.deepEqual(resultado.porCanal.linhas, []);
      assert.equal(resultado.porCanal.totalFaturamento, null);
      assert.equal(resultado.conexoes.mercadoLivre.contasConectadas, 0);
      assert.deepEqual(resultado.alertas, []);
      // Sem pedido nenhum em nenhum dos dois períodos: nunca inventa uma
      // variação, vem com o motivo explícito.
      assert.equal(resultado.faturamentoEvolucao.variacaoValor, null);
      assert.equal(resultado.faturamentoEvolucao.tendencia, 'sem_dado');
      assert.ok(resultado.agentesIa, 'resumo dos Agentes de IA existe mesmo pra empresa sem nenhum pedido (todos os contadores ficam 0)');
    });
  }
);
