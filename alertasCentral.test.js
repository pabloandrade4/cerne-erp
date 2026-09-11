// Central de Alertas — testes de INTEGRAÇÃO (precisa de Postgres local —
// DATABASE_URL, mesmo padrão dos outros arquivos *.test.js desta pasta) da
// Etapa 7 pedida pelo usuário (ver docs/04-alteracoes.md): "Central de
// Alertas" organizada por Prioridade (Crítico/Alto/Médio/Baixo) e Status
// (Novo/Visualizado/Resolvido/Ignorado).
//
// Cobre:
//   1) lib/ia/radar.js#listarAlertasCentral — lê TODOS os status (não só
//      'aberto', diferente de obterRadarParaEmpresa), mapeia
//      severidade->prioridade, deriva Novo x Visualizado de visualizado_em,
//      e filtra por prioridade/status quando pedido.
//   2) As 4 ações manuais (visualizar/ignorar/resolver/reabrir) — sempre
//      isoladas por empresa_id (uma empresa nunca consegue alterar o
//      alerta de outra, mesmo sabendo o id).
//   3) O ponto mais importante: um alerta marcado 'ignorado' pelo usuário
//      PRECISA sobreviver ao próximo ciclo do Radar (executarCicloRadarEmpresa,
//      que roda a cada 15min em produção) enquanto a situação não piorar —
//      sem isso, ignorar um alerta não serviria pra nada (o próximo ciclo
//      desfaria silenciosamente, ver correção em persistirSituacoes).
//   4) Rotas HTTP (routes/alertas.js) — contrato JSON e validação de
//      empresaId.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 971;
const CONTA_ML_ID = 971;
const OUTRA_EMPRESA_ID = 972;

describe(
  'Central de Alertas — listarAlertasCentral, ações manuais, isolamento por empresa, e "ignorado" sobrevive ao próximo ciclo do Radar',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool, radar;

    before(async () => {
      pool = require('../db/pool');
      radar = require('../lib/ia/radar');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
           ($1, '97171717000199', 'EMPRESA TESTE CENTRAL DE ALERTAS', TRUE),
           ($2, '97272727000199', 'OUTRA EMPRESA (ISOLAMENTO)', TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID, OUTRA_EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 971000001, 'LOJA TESTE CENTRAL ALERTAS', 'x', 'x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO NOTHING`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo) VALUES
           ($1, 'Produto com prejuízo (central de alertas)', 'CENTRAL-PREJU-SKU', 40.00, TRUE)
         ON CONFLICT (empresa_id, sku) DO UPDATE SET custo = EXCLUDED.custo, ativo = TRUE`,
        [EMPRESA_ID]
      );
      // Pedido com resultado NEGATIVO de verdade (venda R$20, custo R$40) —
      // gera uma situação 'critico' real via lib/ia/radarNegocio.js, sem
      // depender de nenhuma chamada ao Mercado Livre.
      const p = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, data_fechamento, status, pagamento_status, valor_total, taxa_venda_total, frete_vendedor, pagamento_taxas)
         VALUES ($1, 9710000001, now() - interval '3 days', now() - interval '3 days', 'paid', 'approved', 20, 0, 0, 0)
         RETURNING id`,
        [CONTA_ML_ID]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item, taxa_venda)
         VALUES ($1, 'CENTRAL-PREJU-001', 'Produto com prejuízo (central de alertas)', 'CENTRAL-PREJU-SKU', 1, 20, 20, 0)`,
        [p.rows[0].id]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = ANY($1)', [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query('DELETE FROM radar_estado WHERE empresa_id = ANY($1)', [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      // executarCicloRadarEmpresa (via radarNegocio.js) grava um snapshot
      // interno de custos por empresa — precisa ser limpo antes de apagar a
      // empresa (FK), mesma ordem que test/radar.test.js já usa.
      await pool.query('DELETE FROM radar_snapshot_custos WHERE empresa_id = ANY($1)', [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query('DELETE FROM ml_pedido_itens WHERE pedido_id IN (SELECT id FROM ml_pedidos WHERE conta_ml_id = $1)', [CONTA_ML_ID]);
      await pool.query('DELETE FROM ml_pedidos WHERE conta_ml_id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM produtos WHERE empresa_id = $1 AND sku = $2', [EMPRESA_ID, 'CENTRAL-PREJU-SKU']);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      // NUNCA `pool.end()` aqui: `pool` é um módulo singleton compartilhado
      // com o describe de rotas HTTP logo abaixo, neste mesmo arquivo — só
      // o ÚLTIMO describe do arquivo encerra o pool.
    });

    let alertaId;

    test('1º ciclo do Radar detecta a situação real -> aparece em listarAlertasCentral como prioridade Crítico, status Novo', async () => {
      await radar.executarCicloRadarEmpresa(EMPRESA_ID);
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID);
      const alerta = resultado.alertas.find((a) => a.dados && a.dados.sku === 'CENTRAL-PREJU-SKU');
      assert.ok(alerta, 'a situação de prejuízo real deveria ter gerado um alerta');
      assert.equal(alerta.severidade, 'critico');
      assert.equal(alerta.prioridade, 'critico');
      assert.equal(alerta.prioridadeLabel, 'Crítico');
      assert.equal(alerta.statusCentral, 'novo', 'recém-criado, ninguém visualizou ainda -> Novo');
      alertaId = alerta.id;
    });

    test('marcarAlertaVisualizado muda o status central pra "visualizado" (nunca mexe em `status`/severidade)', async () => {
      const ok = await radar.marcarAlertaVisualizado(alertaId, EMPRESA_ID);
      assert.equal(ok, true);
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID, { status: 'visualizado' });
      const alerta = resultado.alertas.find((a) => a.id === alertaId);
      assert.ok(alerta, 'deveria aparecer no filtro status=visualizado');
      assert.equal(alerta.statusCentral, 'visualizado');
    });

    test('isolamento: OUTRA empresa não consegue marcar/ver o alerta desta empresa, mesmo sabendo o id', async () => {
      const ok = await radar.marcarAlertaIgnorado(alertaId, OUTRA_EMPRESA_ID);
      assert.equal(ok, false, 'nunca deveria conseguir alterar um alerta de outra empresa');
      const resultadoOutra = await radar.listarAlertasCentral(OUTRA_EMPRESA_ID);
      assert.ok(!resultadoOutra.alertas.find((a) => a.id === alertaId), 'o alerta da empresa 971 nunca pode aparecer pra empresa 972');
    });

    test('marcarAlertaIgnorado muda o status central pra "ignorado"', async () => {
      const ok = await radar.marcarAlertaIgnorado(alertaId, EMPRESA_ID);
      assert.equal(ok, true);
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID, { status: 'ignorado' });
      const alerta = resultado.alertas.find((a) => a.id === alertaId);
      assert.ok(alerta);
      assert.equal(alerta.statusCentral, 'ignorado');
    });

    test('CORREÇÃO CENTRAL: rodar o Radar de novo (situação inalterada) NÃO desfaz o "ignorado" — sem isso, ignorar um alerta não serviria pra nada', async () => {
      await radar.executarCicloRadarEmpresa(EMPRESA_ID); // mesmo ciclo que roda a cada 15min em produção
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID);
      const alerta = resultado.alertas.find((a) => a.id === alertaId);
      assert.ok(alerta, 'o alerta continua existindo (a situação real ainda existe)');
      assert.equal(alerta.statusCentral, 'ignorado', 'precisa continuar ignorado depois de outro ciclo do Radar com a MESMA severidade');
    });

    test('marcarAlertaResolvidoManual muda o status central pra "resolvido"', async () => {
      const ok = await radar.marcarAlertaResolvidoManual(alertaId, EMPRESA_ID);
      assert.equal(ok, true);
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID, { status: 'resolvido' });
      assert.ok(resultado.alertas.find((a) => a.id === alertaId));
    });

    test('reabrirAlertaManual volta pra "novo" (visualizado_em/ignorado_em/resolvido_em zerados)', async () => {
      const ok = await radar.reabrirAlertaManual(alertaId, EMPRESA_ID);
      assert.equal(ok, true);
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID, { status: 'novo' });
      const alerta = resultado.alertas.find((a) => a.id === alertaId);
      assert.ok(alerta);
      assert.equal(alerta.statusCentral, 'novo');
    });

    test('filtro por prioridade funciona (só devolve os da prioridade pedida)', async () => {
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID, { prioridade: 'critico' });
      assert.ok(resultado.alertas.length > 0);
      resultado.alertas.forEach((a) => assert.equal(a.prioridade, 'critico'));

      const semNada = await radar.listarAlertasCentral(EMPRESA_ID, { prioridade: 'baixo' });
      assert.ok(!semNada.alertas.find((a) => a.id === alertaId), 'o alerta crítico não pode aparecer no filtro de prioridade Baixo');
    });

    test('contagemPorPrioridade e contagemPorStatus batem com os alertas devolvidos', async () => {
      const resultado = await radar.listarAlertasCentral(EMPRESA_ID);
      const totalContagemStatus = Object.values(resultado.contagemPorStatus).reduce((a, b) => a + b, 0);
      assert.equal(totalContagemStatus, resultado.alertas.length);
      const totalContagemPrioridade = Object.values(resultado.contagemPorPrioridade).reduce((a, b) => a + b, 0);
      assert.equal(totalContagemPrioridade, resultado.alertas.length);
    });
  }
);

// ============================================================
// Rotas HTTP (routes/alertas.js) — servidor mínimo só com este router,
// mesmo padrão de test/estoqueRoutes.test.js.
// ============================================================
describe(
  'Rotas HTTP da Central de Alertas (GET/PATCH /api/alertas)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    const EMPRESA_HTTP_ID = 973;
    let pool, server, baseUrl, alertaId;

    before(async () => {
      pool = require('../db/pool');
      const express = require('express');
      const alertasRouter = require('../routes/alertas');
      const app = express();
      app.use(express.json());
      app.use('/api/alertas', alertasRouter);
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97373737000199', 'EMPRESA TESTE ROTAS ALERTAS', TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_HTTP_ID]
      );
      const ins = await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, pagina, status)
         VALUES ($1, 'teste_http_alerta', 'financeiro', 'atencao', 'Alerta de teste HTTP', 'descrição', 'recomendação padrão', '{}', 'financeiro', 'aberto')
         RETURNING id`,
        [EMPRESA_HTTP_ID]
      );
      alertaId = ins.rows[0].id;
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [EMPRESA_HTTP_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_HTTP_ID]);
      await pool.end();
    });

    test('GET /api/alertas sem empresaId -> 400', async () => {
      const res = await fetch(`${baseUrl}/api/alertas`);
      assert.equal(res.status, 400);
    });

    test('GET /api/alertas?empresaId=X -> devolve o alerta com prioridade/statusCentral já mapeados', async () => {
      const res = await fetch(`${baseUrl}/api/alertas?empresaId=${EMPRESA_HTTP_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const alerta = body.alertas.find((a) => a.id === alertaId);
      assert.ok(alerta);
      assert.equal(alerta.prioridadeLabel, 'Alto'); // severidade 'atencao' -> prioridade 'alto'
      assert.equal(alerta.statusCentralLabel, 'Novo');
    });

    test('PATCH /api/alertas/:id/visualizar sem empresaId -> 400; com empresaId errado -> 404; com o certo -> 200', async () => {
      const semEmpresa = await fetch(`${baseUrl}/api/alertas/${alertaId}/visualizar`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      assert.equal(semEmpresa.status, 400);

      const empresaErrada = await fetch(`${baseUrl}/api/alertas/${alertaId}/visualizar`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: 999999 }) });
      assert.equal(empresaErrada.status, 404);

      const ok = await fetch(`${baseUrl}/api/alertas/${alertaId}/visualizar`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_HTTP_ID }) });
      assert.equal(ok.status, 200);

      const res = await fetch(`${baseUrl}/api/alertas?empresaId=${EMPRESA_HTTP_ID}&status=visualizado`);
      const body = await res.json();
      assert.ok(body.alertas.find((a) => a.id === alertaId));
    });
  }
);
