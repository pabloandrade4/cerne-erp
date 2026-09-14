// Teste de INTEGRAÇÃO HTTP (precisa de Postgres local — mesmo padrão de
// test/produtosBase.test.js) da rota GET /api/produtos/sugestoes-sku
// (14/09/2026, pedido explícito do usuário: "como podemos fazer para puxar
// o sku com o custo direto").
//
// O que esta rota resolve: produto cadastrado errado (SKU digitado
// diferente do que veio no pedido) nunca casa com a venda no cálculo de
// margem (lib/relatorioVendas.js compara SKU por igualdade exata) — o
// produto some "sem custo" mesmo já existindo em Produtos. Em vez de
// digitar o SKU na mão ao cadastrar, o usuário agora pode escolher de uma
// lista puxada direto dos pedidos reais (Mercado Livre + Shopee), com o
// nome do item sugerido — garantindo que o SKU cadastrado bate com o SKU
// que realmente aparece na venda.
//
// Estes testes provam: (1) só sugere SKU que AINDA não tem produto
// cadastrado nesta empresa (nunca sugere de novo um SKU já existente); (2)
// junta Mercado Livre e Shopee na mesma lista; (3) devolve o nome mais
// recente do item e a contagem de pedidos distintos; (4) nunca mistura
// dados de outra empresa.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';
const EMPRESA_ID = 977;
const OUTRA_EMPRESA_ID = 978;

describe(
  'GET /api/produtos/sugestoes-sku — sugere SKU direto dos pedidos (Mercado Livre + Shopee)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;

    before(async () => {
      pool = require('../db/pool');
      const express = require('express');
      const produtosRouter = require('../routes/produtos');

      const app = express();
      app.use(express.json());
      app.use('/api/produtos', produtosRouter);

      server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;

      for (const id of [EMPRESA_ID, OUTRA_EMPRESA_ID]) {
        await pool.query(
          `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,$2,$3,TRUE)
           ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
          [id, `9777${id}000199`.slice(0, 14), `${PREFIXO_TESTE} EMPRESA ${id}`]
        );
      }

      await limpar();

      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,$3,'Loja ML Teste','x','x', now() + interval '3 hours', 'ativa')`,
        [EMPRESA_ID, EMPRESA_ID, 900000 + EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO shopee_contas (id, empresa_id, shopee_shop_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,$3,'x','x', now() + interval '3 hours', 'ativa')`,
        [EMPRESA_ID, EMPRESA_ID, 900000 + EMPRESA_ID]
      );
      // Conta de OUTRA empresa — usada pra provar que a rota nunca mistura
      // SKU de empresa diferente na sugestão.
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,$3,'Loja ML Outra Empresa','x','x', now() + interval '3 hours', 'ativa')`,
        [OUTRA_EMPRESA_ID, OUTRA_EMPRESA_ID, 900000 + OUTRA_EMPRESA_ID]
      );

      // --- Pedido Mercado Livre com SKU NOVO (nunca cadastrado em Produtos) ---
      const { rows: pedMl1 } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, status, data_criacao) VALUES ($1,$2,'paid',now()) RETURNING id`,
        [EMPRESA_ID, 700001]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item)
         VALUES ($1,'MLB700001','Caixa de papelão 30x20x15 (mais recente)','${PREFIXO_TESTE}-CX-NOVO',1,50,50)`,
        [pedMl1[0].id]
      );
      // Segundo pedido do MESMO sku novo, em outro momento, com título mais
      // antigo — a rota deve devolver o nome do pedido mais RECENTE e
      // contar 2 pedidos distintos (não 2 linhas).
      const { rows: pedMl2 } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, status, data_criacao) VALUES ($1,$2,'paid', now() - interval '2 days') RETURNING id`,
        [EMPRESA_ID, 700002]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item)
         VALUES ($1,'MLB700002','Caixa de papelao 30x20x15 (nome antigo)','${PREFIXO_TESTE}-CX-NOVO',1,50,50)`,
        [pedMl2[0].id]
      );

      // --- Pedido Mercado Livre com SKU que JÁ está cadastrado em Produtos ---
      await pool.query(
        `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo) VALUES ($1,$2,$3,10,TRUE)`,
        [EMPRESA_ID, `${PREFIXO_TESTE} Produto já cadastrado`, `${PREFIXO_TESTE}-SKU-JA-CADASTRADO`]
      );
      const { rows: pedMl3 } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, status, data_criacao) VALUES ($1,$2,'paid',now()) RETURNING id`,
        [EMPRESA_ID, 700003]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item)
         VALUES ($1,'MLB700003','Produto já cadastrado','${PREFIXO_TESTE}-SKU-JA-CADASTRADO',1,20,20)`,
        [pedMl3[0].id]
      );

      // --- Pedido Shopee com SKU NOVO (nunca cadastrado) ---
      const { rows: pedShopee1 } = await pool.query(
        `INSERT INTO shopee_pedidos (conta_shopee_id, order_sn, order_status, data_criacao, valor_total, raw_pedido)
         VALUES ($1,'ORD-SUGESTAO-SKU','SHIPPED', now(), 61.60, '{}'::jsonb) RETURNING id`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO shopee_pedido_itens (pedido_id, item_id, nome, sku, quantidade, preco_unitario, valor_total_item)
         VALUES ($1,1,'Fita adesiva transparente','${PREFIXO_TESTE}-FITA-NOVA',2,30.80,61.60)`,
        [pedShopee1[0].id]
      );

      // --- Pedido de OUTRA empresa com um SKU novo — nunca deve aparecer
      // na sugestão da empresa de teste principal.
      const { rows: pedOutra } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, status, data_criacao) VALUES ($1,$2,'paid',now()) RETURNING id`,
        [OUTRA_EMPRESA_ID, 700004]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario, valor_total_item)
         VALUES ($1,'MLB700004','Produto de outra empresa','${PREFIXO_TESTE}-SKU-OUTRA-EMPRESA',1,15,15)`,
        [pedOutra[0].id]
      );
    });

    async function limpar() {
      await pool.query(`DELETE FROM shopee_pedido_itens WHERE pedido_id IN (SELECT id FROM shopee_pedidos WHERE conta_shopee_id IN (SELECT id FROM shopee_contas WHERE empresa_id = ANY($1)))`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query(`DELETE FROM shopee_pedidos WHERE conta_shopee_id IN (SELECT id FROM shopee_contas WHERE empresa_id = ANY($1))`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query(`DELETE FROM shopee_contas WHERE empresa_id = ANY($1)`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query(`DELETE FROM ml_pedido_itens WHERE pedido_id IN (SELECT id FROM ml_pedidos WHERE conta_ml_id IN (SELECT id FROM ml_contas WHERE empresa_id = ANY($1)))`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query(`DELETE FROM ml_pedidos WHERE conta_ml_id IN (SELECT id FROM ml_contas WHERE empresa_id = ANY($1))`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query(`DELETE FROM ml_contas WHERE empresa_id = ANY($1)`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await pool.query(`DELETE FROM produtos WHERE empresa_id = ANY($1)`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
    }

    after(async () => {
      await limpar();
      await pool.query(`DELETE FROM empresas WHERE id = ANY($1)`, [[EMPRESA_ID, OUTRA_EMPRESA_ID]]);
      await new Promise((resolve) => server.close(resolve));
      // pool.end() não é chamado aqui — mesmo padrão documentado em
      // test/shopeeMargemEstimada.test.js (pool singleton compartilhado).
    });

    test('sugere SKUs novos do Mercado Livre e da Shopee, com nome mais recente e contagem de pedidos', async () => {
      const res = await fetch(`${baseUrl}/api/produtos/sugestoes-sku?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();

      const porSku = Object.fromEntries(body.sugestoes.map((s) => [s.sku, s]));

      assert.ok(porSku[`${PREFIXO_TESTE}-CX-NOVO`], 'deveria sugerir o SKU novo do Mercado Livre');
      assert.equal(porSku[`${PREFIXO_TESTE}-CX-NOVO`].nomeSugerido, 'Caixa de papelão 30x20x15 (mais recente)');
      assert.equal(porSku[`${PREFIXO_TESTE}-CX-NOVO`].qtdPedidos, 2, 'apareceu em 2 pedidos distintos do mesmo sku — não pode contar 2x por engano nem colapsar em 1');

      assert.ok(porSku[`${PREFIXO_TESTE}-FITA-NOVA`], 'deveria sugerir o SKU novo da Shopee');
      assert.equal(porSku[`${PREFIXO_TESTE}-FITA-NOVA`].nomeSugerido, 'Fita adesiva transparente');
      assert.equal(porSku[`${PREFIXO_TESTE}-FITA-NOVA`].qtdPedidos, 1);
    });

    test('nunca sugere um SKU que já está cadastrado em Produtos', async () => {
      const res = await fetch(`${baseUrl}/api/produtos/sugestoes-sku?empresaId=${EMPRESA_ID}`);
      const body = await res.json();
      const skus = body.sugestoes.map((s) => s.sku);
      assert.ok(!skus.includes(`${PREFIXO_TESTE}-SKU-JA-CADASTRADO`), 'SKU já cadastrado não deveria aparecer como sugestão de novo');
    });

    test('nunca mistura SKU de outra empresa', async () => {
      const res = await fetch(`${baseUrl}/api/produtos/sugestoes-sku?empresaId=${EMPRESA_ID}`);
      const body = await res.json();
      const skus = body.sugestoes.map((s) => s.sku);
      assert.ok(!skus.includes(`${PREFIXO_TESTE}-SKU-OUTRA-EMPRESA`), 'SKU de outra empresa nunca deveria aparecer aqui');

      const resOutra = await fetch(`${baseUrl}/api/produtos/sugestoes-sku?empresaId=${OUTRA_EMPRESA_ID}`);
      const bodyOutra = await resOutra.json();
      const skusOutra = bodyOutra.sugestoes.map((s) => s.sku);
      assert.ok(skusOutra.includes(`${PREFIXO_TESTE}-SKU-OUTRA-EMPRESA`), 'a própria empresa dona do pedido deveria ver a sugestão');
    });

    test('sem empresaId devolve erro 400 (nunca busca sem filtro de empresa)', async () => {
      const res = await fetch(`${baseUrl}/api/produtos/sugestoes-sku`);
      assert.equal(res.status, 400);
    });
  }
);
