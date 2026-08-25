// Radar da IA — testes de INTEGRAÇÃO (precisa de Postgres local — mesma
// regra de skip por DATABASE_URL dos outros arquivos de teste desta pasta)
// da tarefa "evoluir a IA Gestora para acompanhamento contínuo" (ver
// docs/02-decisoes.md). Cobre exatamente os itens do checklist pedido pelo
// usuário:
//   1) análise automática de anúncios (Passo 1 — lib/ia/radarAnuncios.js)
//   2) pelo menos um alerta financeiro (Passo 2 — lib/ia/radarNegocio.js)
//   3) pelo menos uma oportunidade (Passo 1 — "não quero uma IA que procure
//      somente problemas")
//   4) confirma que funciona SEM o navegador aberto: em todo este arquivo,
//      o ciclo é disparado chamando executarCicloRadarEmpresa() como uma
//      função Node comum — nunca via HTTP/rota — exatamente como
//      lib/ia/radarScheduler.js dispara sozinho, no servidor, sem depender
//      de nenhuma aba aberta. O teste "sobrevive a reiniciar o processo",
//      abaixo, reforça isso: descarrega os módulos do zero e confere que o
//      resultado persistido no Postgres continua lá.
//
// Usa uma empresa dedicada (970, nunca usada por outro arquivo de teste)
// com pedidos/produtos/contas fabricados à mão para disparar, de forma
// determinística, uma situação de cada categoria — sem depender de nenhuma
// chamada real ao Mercado Livre (Ads é passado vazio/indisponível, mesma
// forma que listarAdsSeguro já trata a falta de conta configurada).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 970;
const CONTA_ML_ID = 970;

describe(
  'Radar da IA — análise automática de anúncios, alertas financeiros, oportunidades e ciclo em segundo plano',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool;

    before(async () => {
      pool = require('../db/pool');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97070707000199', 'EMPRESA TESTE RADAR', TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 970000001, 'LOJA TESTE RADAR', 'x', 'x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO NOTHING`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo) VALUES
           ($1, 'Produto vendendo pouco', 'RADAR-BAIXA-SKU', 5.00, TRUE),
           ($1, 'Produto com prejuízo', 'RADAR-PREJU-SKU', 40.00, TRUE),
           ($1, 'Produto bom desempenho', 'RADAR-BOM-SKU', 50.00, TRUE)
         ON CONFLICT (empresa_id, sku) DO UPDATE SET custo = EXCLUDED.custo, ativo = TRUE`,
        [EMPRESA_ID]
      );

      // Pedido 1 — "anúncio vendendo pouco": 3 unidades, última venda há 15
      // dias (>= 10 dias de atenção, < 30 dias de "parado").
      const p1 = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, data_fechamento, status, pagamento_status, valor_total, taxa_venda_total, frete_vendedor, pagamento_taxas)
         VALUES ($1, 9700000001, now() - interval '15 days', now() - interval '15 days', 'paid', 'approved', 30, 0, 0, 0)
         RETURNING id`,
        [CONTA_ML_ID]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item, taxa_venda)
         VALUES ($1, 'RADAR-BAIXA-001', 'Produto vendendo pouco', 'RADAR-BAIXA-SKU', 3, 10, 30, 0)`,
        [p1.rows[0].id]
      );

      // Pedido 2 — "anúncio dando prejuízo": 1 unidade há 3 dias, vendida
      // por R$20 com custo de R$40 — resultado negativo de verdade (nunca
      // um valor negativo inventado, é R$20 de venda menos R$40 de custo).
      const p2 = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, data_fechamento, status, pagamento_status, valor_total, taxa_venda_total, frete_vendedor, pagamento_taxas)
         VALUES ($1, 9700000002, now() - interval '3 days', now() - interval '3 days', 'paid', 'approved', 20, 0, 0, 0)
         RETURNING id`,
        [CONTA_ML_ID]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item, taxa_venda)
         VALUES ($1, 'RADAR-PREJU-001', 'Produto com prejuízo', 'RADAR-PREJU-SKU', 1, 20, 20, 0)`,
        [p2.rows[0].id]
      );

      // Pedido 3 — "anúncio bom / oportunidade": 6 unidades há 2 dias,
      // faturando R$600 com margem de 50% (bem acima do saudável de 15%).
      const p3 = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, data_fechamento, status, pagamento_status, valor_total, taxa_venda_total, frete_vendedor, pagamento_taxas)
         VALUES ($1, 9700000003, now() - interval '2 days', now() - interval '2 days', 'paid', 'approved', 600, 0, 0, 0)
         RETURNING id`,
        [CONTA_ML_ID]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item, taxa_venda)
         VALUES ($1, 'RADAR-BOM-001', 'Produto bom desempenho', 'RADAR-BOM-SKU', 6, 100, 600, 0)`,
        [p3.rows[0].id]
      );

      // Alerta financeiro: uma conta a pagar já vencida há 3 dias.
      await pool.query(
        `INSERT INTO contas_pagar (empresa_id, descricao, valor, vencimento, status)
         VALUES ($1, 'Conta teste radar (vencida)', 500, CURRENT_DATE - INTERVAL '3 days', 'pendente')`,
        [EMPRESA_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM radar_estado WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM radar_snapshot_custos WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM contas_pagar WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ml_pedidos WHERE conta_ml_id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM produtos WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      await pool.end();
    });

    test('1) análise automática de anúncios: detecta "vendendo pouco" com o mesmo formato de exemplo pedido pelo usuário', async () => {
      const { analisarAnuncios } = require('../lib/ia/radarAnuncios');
      const situacoes = await analisarAnuncios({ empresaId: EMPRESA_ID, adsResultado30: { linhas: [] }, adsResultado7: { linhas: [] } });

      const vendaBaixa = situacoes.find((s) => s.categoria === 'anuncio_venda_baixa');
      assert.ok(vendaBaixa, 'deveria detectar o anúncio que vendeu pouco');
      assert.equal(vendaBaixa.severidade, 'atencao');
      assert.match(vendaBaixa.descricao, /vendeu apenas 3 unidade/);
      assert.match(vendaBaixa.descricao, /15 dias sem nenhuma venda/);
      assert.equal(vendaBaixa.recomendacaoPadrao, 'Esse anúncio merece revisão. Verifique preço, título, fotos, concorrência e exposição.');
      assert.equal(vendaBaixa.dados.quantidadeVendida30d, 3);
      assert.equal(vendaBaixa.dados.sku, 'RADAR-BAIXA-SKU');

      const prejuizo = situacoes.find((s) => s.categoria === 'anuncio_prejuizo');
      assert.ok(prejuizo, 'deveria detectar o anúncio dando prejuízo (usa os mesmos números reais, nunca inventados)');
      assert.equal(prejuizo.severidade, 'critico');
      assert.equal(prejuizo.dados.faturamento7d, 20);
      assert.equal(prejuizo.valorEnvolvido, 20); // |resultado| = |20 - 40| = 20

      const bomDesempenho = situacoes.find((s) => s.categoria === 'anuncio_bom_desempenho');
      assert.ok(bomDesempenho, 'deveria detectar o anúncio de bom desempenho');
      assert.equal(bomDesempenho.severidade, 'oportunidade');
      assert.equal(bomDesempenho.dados.margemPercentual30d, 50);
    });

    test('2) e 3) ciclo completo (executarCicloRadarEmpresa, SEM nenhuma rota HTTP envolvida): persiste alerta financeiro E oportunidade no mesmo ciclo — "não quero uma IA que procure só problemas"', async () => {
      const { executarCicloRadarEmpresa, obterRadarParaEmpresa } = require('../lib/ia/radar');

      // Chamada direta da função — o mesmo jeito que lib/ia/radarScheduler.js
      // dispara sozinho no servidor, nunca dependendo de ninguém com o ERP
      // aberto no navegador.
      const resultado = await executarCicloRadarEmpresa(EMPRESA_ID);
      assert.ok(resultado.situacoesDetectadas >= 4, 'deveria ter detectado pelo menos as 4 situações fabricadas neste teste');

      const radar = await obterRadarParaEmpresa(EMPRESA_ID);
      assert.ok(radar.contagem.critico >= 2, 'prejuízo + contas vencidas são críticos');
      assert.ok(radar.contagem.oportunidade >= 1, 'bom desempenho é oportunidade');

      const alertaFinanceiro = radar.alertas.find((a) => a.categoria === 'financeiro_contas_vencidas');
      assert.ok(alertaFinanceiro, 'alerta financeiro (contas vencidas) deveria estar na lista');
      assert.equal(alertaFinanceiro.severidade, 'critico');
      assert.equal(Number(alertaFinanceiro.dados.valorVencido), 500);
      assert.match(alertaFinanceiro.descricao, /R\$\s*500,00/);

      const oportunidade = radar.alertas.find((a) => a.categoria === 'anuncio_bom_desempenho');
      assert.ok(oportunidade, 'oportunidade deveria estar na lista de alertas abertos');
      assert.equal(oportunidade.severidade, 'oportunidade');

      // "O que precisa da minha atenção hoje": crítico sempre antes de
      // oportunidade (mesma ordem de severidade usada no resto do Radar).
      assert.ok(radar.resumoHoje.length > 0);
      const idxCritico = radar.resumoHoje.findIndex((r) => r.severidade === 'critico');
      const idxOportunidade = radar.resumoHoje.findIndex((r) => r.severidade === 'oportunidade');
      if (idxCritico !== -1 && idxOportunidade !== -1) assert.ok(idxCritico < idxOportunidade);

      assert.equal(radar.ultimaExecucaoOk, true);
    });

    test('nunca duplica alerta: rodar o ciclo de novo com os MESMOS dados atualiza o alerta existente (upsert por chave), nunca cria um segundo', async () => {
      const { executarCicloRadarEmpresa } = require('../lib/ia/radar');
      await executarCicloRadarEmpresa(EMPRESA_ID); // 2º ciclo, dados inalterados

      const { rows } = await pool.query(
        `SELECT id FROM radar_alertas WHERE empresa_id = $1 AND chave = 'financeiro_contas_vencidas'`,
        [EMPRESA_ID]
      );
      assert.equal(rows.length, 1, 'nunca pode existir mais de uma linha aberta pra mesma chave — precisa atualizar, não duplicar');
    });

    test('resolve automaticamente quando a situação deixa de ser verdade (paga a conta vencida)', async () => {
      const { executarCicloRadarEmpresa } = require('../lib/ia/radar');
      await pool.query(`UPDATE contas_pagar SET status = 'pago', data_pagamento = CURRENT_DATE WHERE empresa_id = $1`, [EMPRESA_ID]);

      await executarCicloRadarEmpresa(EMPRESA_ID);

      const { rows } = await pool.query(
        `SELECT status, resolvido_em FROM radar_alertas WHERE empresa_id = $1 AND chave = 'financeiro_contas_vencidas'`,
        [EMPRESA_ID]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'resolvido');
      assert.ok(rows[0].resolvido_em, 'resolvido_em deveria estar preenchido');

      // Restaura pro estado "vencida" pra não afetar os testes seguintes
      // deste arquivo (dedup/auto-resolve rodam nesta ordem).
      await pool.query(`UPDATE contas_pagar SET status = 'pendente', data_pagamento = NULL WHERE empresa_id = $1`, [EMPRESA_ID]);
    });

    test('4) funciona sem o navegador aberto: o resultado persistido sobrevive a um "reinício do processo" (só Postgres, nunca em memória)', async () => {
      const { executarCicloRadarEmpresa } = require('../lib/ia/radar');
      await executarCicloRadarEmpresa(EMPRESA_ID); // garante que a conta voltou a estar vencida no radar

      // Simula reiniciar o servidor: descarrega TODOS os módulos do Radar do
      // require.cache e carrega tudo de novo do zero — nenhum estado em
      // memória sobrevive a isso, só o que está no Postgres.
      ['../lib/ia/radar', '../lib/ia/radarAnuncios', '../lib/ia/radarNegocio', '../lib/ia/radarScheduler'].forEach((m) => {
        delete require.cache[require.resolve(m)];
      });
      const radarRecarregado = require('../lib/ia/radar');

      const radar = await radarRecarregado.obterRadarParaEmpresa(EMPRESA_ID);
      const alertaFinanceiro = radar.alertas.find((a) => a.categoria === 'financeiro_contas_vencidas');
      assert.ok(alertaFinanceiro, 'o alerta persistido antes do "reinício" continua lá — prova que não dependia de nada em memória/navegador');
      assert.ok(radar.ultimaExecucaoEm, 'ultima_execucao_em precisa estar gravada no banco, não só numa variável do processo');
    });
  }
);
