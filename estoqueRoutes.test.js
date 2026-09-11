// Teste de INTEGRAÇÃO HTTP (precisa de Postgres local — DATABASE_URL, mesmo
// padrão dos outros arquivos *.integration.test.js) das rotas novas da
// Etapa "corrigir a lógica do módulo Estoque" (26/08/2026):
//   GET  /api/estoque             -> aba Estoque (fora do Full)
//   GET  /api/estoque-full        -> aba Estoque Full
//   POST /api/estoque/sincronizar -> botão "Sincronizar agora"
//   PUT  /api/estoque-produto-base/:id -> DESATIVADO (410), ajuste manual
//        antigo nunca mais deve funcionar (pedido explícito do usuário).
//
// Sobe um servidor HTTP real (servidor mínimo, só com os routers desta
// etapa — não o server.js inteiro, pra não depender de todas as outras
// rotas/variáveis de ambiente) e bate com fetch(), confirmando o contrato
// JSON exato que o front-end (window.Estoque/window.EstoqueFull em
// public/index.html) espera: produto, sku, loja, mlItemId, mlVariationId,
// estoqueDisponivel, status, ultimaSincronizacao.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 950;
const EMPRESA_SEM_CONTA_ID = 951;
const CONTA_ML_ID = 950;

describe(
  'Rotas HTTP de Estoque (GET /api/estoque, GET /api/estoque-full, POST /api/estoque/sincronizar, PUT /api/estoque-produto-base desativado)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;

    before(async () => {
      pool = require('../db/pool');
      const express = require('express');
      const estoqueRouter = require('../routes/estoque');
      const estoqueFullRouter = require('../routes/estoqueFull');
      const estoqueProdutoBaseRouter = require('../routes/estoqueProdutoBase');

      const app = express();
      app.use(express.json());
      app.use('/api/estoque', estoqueRouter);
      app.use('/api/estoque-full', estoqueFullRouter);
      app.use('/api/estoque-produto-base', estoqueProdutoBaseRouter);

      server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'66666666000191','EMPRESA TESTE ROTAS ESTOQUE',TRUE), ($2,'77777777000191','EMPRESA SEM CONTA (ROTAS ESTOQUE)',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID, EMPRESA_SEM_CONTA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,950000001,'LOJA ROTAS TESTE','x','x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa'`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query(
        `INSERT INTO ml_estoque_itens
           (conta_ml_id, empresa_id, tipo, ml_item_id, ml_variation_id, titulo, sku, loja, status, quantidade, pendente, motivo_pendencia, recurso_usado)
         VALUES
           ($1,$2,'proprio','MLB100',NULL,'Caixa de papelão 19x12x12','CX-19X12X12','LOJA ROTAS TESTE','active',800,FALSE,NULL,'available_quantity'),
           ($1,$2,'full','MLB200',NULL,'Caixa de papelão Full','CX-FULL','LOJA ROTAS TESTE','active',15,FALSE,NULL,'full_inventory'),
           ($1,$2,'proprio','MLB300',333,'Fita adesiva (rolo grande)',NULL,'LOJA ROTAS TESTE','paused',NULL,TRUE,'sem_dado_na_api',NULL)`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1)', [[EMPRESA_ID, EMPRESA_SEM_CONTA_ID]]);
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    });

    test('GET /api/estoque devolve só os itens tipo=proprio, com as colunas pedidas pelo usuário', async () => {
      const res = await fetch(`${baseUrl}/api/estoque?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.itens.length, 2, 'só os 2 itens tipo=proprio (MLB100, MLB300) — nunca o item Full (MLB200)');
      assert.ok(!body.itens.some((it) => it.mlItemId === 'MLB200'), 'nunca mistura o item Full aqui');

      const item = body.itens.find((it) => it.mlItemId === 'MLB100');
      assert.equal(item.produto, 'Caixa de papelão 19x12x12');
      assert.equal(item.sku, 'CX-19X12X12');
      assert.equal(item.loja, 'LOJA ROTAS TESTE');
      assert.equal(item.estoqueDisponivel, 800);
      assert.equal(item.status, 'active');
      assert.ok(item.ultimaSincronizacao);
      assert.equal(item.pendente, false);

      const pendente = body.itens.find((it) => it.mlItemId === 'MLB300');
      assert.equal(pendente.estoqueDisponivel, null, 'nunca inventa quantidade quando a API não retornou o dado');
      assert.equal(pendente.pendente, true);
      assert.equal(pendente.mlVariationId, 333);
    });

    test('GET /api/estoque-full devolve só o item tipo=full — nunca soma/mistura com o estoque fora do Full', async () => {
      const res = await fetch(`${baseUrl}/api/estoque-full?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.itens.length, 1);
      assert.equal(body.itens[0].mlItemId, 'MLB200');
      assert.equal(body.itens[0].estoqueDisponivel, 15);
    });

    test('empresa sem nenhuma conta do Mercado Livre -> pendente "sem_conta", itens vazio (nunca inventa dado)', async () => {
      const res = await fetch(`${baseUrl}/api/estoque?empresaId=${EMPRESA_SEM_CONTA_ID}`);
      const body = await res.json();
      assert.equal(body.pendente, true);
      assert.equal(body.motivo, 'sem_conta');
      assert.deepEqual(body.itens, []);
    });

    test('POST /api/estoque/sincronizar sem conta ativa -> 400, nunca falha silenciosamente', async () => {
      const res = await fetch(`${baseUrl}/api/estoque/sincronizar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_SEM_CONTA_ID }),
      });
      assert.equal(res.status, 400);
    });

    test('PUT /api/estoque-produto-base/:id (ajuste manual antigo) está DESATIVADO — sempre 410, nunca altera nada', async () => {
      const res = await fetch(`${baseUrl}/api/estoque-produto-base/1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ empresaId: EMPRESA_ID, quantidade: 999 }),
      });
      assert.equal(res.status, 410);
      const body = await res.json();
      assert.match(body.error, /Mercado Livre/);
    });
  }
);
