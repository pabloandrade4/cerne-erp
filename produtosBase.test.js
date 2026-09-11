// Teste de INTEGRAÇÃO HTTP (precisa de Postgres local — DATABASE_URL, mesmo
// padrão dos outros arquivos *.test.js que sobem servidor real) da etapa
// "Mapa de Produtos" (27/08/2026 — primeira etapa da proposta
// docs/PROPOSTA-contexto-negocio-ia-gestora.md):
//   - produtos_base ganhou `medida`/`categoria`
//   - tabela nova `produto_base_aliases` (apelidos em linguagem natural)
//   - GET /api/produtos-base/categorias-sugeridas
// Sobe um servidor mínimo com o router routes/produtosBase.js (não o
// server.js inteiro) e bate com fetch(), confirmando o contrato JSON que o
// front-end novo (window.MapaProdutos em public/index.html) espera.
//
// Também cobre, de propósito, a REGRESSÃO encontrada ao vivo durante o
// desenvolvimento desta etapa: o `express` "-stub" deste ambiente de
// desenvolvimento faz correspondência de PREFIXO POR STRING em
// `app.use(caminho, ...)` sem checar limite de segmento — uma requisição
// pra '/api/produtos-base/...' (inclusive o próprio `GET /api/produtos-base`
// sem subcaminho, ex: '/api/produtos-base?empresaId=1' vira '-base' depois
// de descontado o prefixo '/api/produtos') caía no router errado (montado
// em '/api/produtos') sempre que '/api/produtos' era registrado ANTES de
// '/api/produtos-base'. server.js foi corrigido pra registrar o prefixo
// mais específico primeiro (ver comentário lá) — o teste abaixo monta os
// dois routers NA MESMA ORDEM CORRIGIDA de server.js de propósito, pra
// nunca mais regredir sem que este teste quebre. Ver docs/05-problemas-conhecidos.md.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';
const EMPRESA_ID = 966;

describe(
  'Rotas HTTP de Mapa de Produtos (produtos_base + medida/categoria + produto_base_aliases)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;

    before(async () => {
      pool = require('../db/pool');
      const express = require('express');
      const produtosRouter = require('../routes/produtos');
      const produtosBaseRouter = require('../routes/produtosBase');

      const app = express();
      app.use(express.json());
      // Ordem de propósito, IGUAL à de server.js: '/api/produtos-base'
      // ANTES de '/api/produtos'. Se alguém inverter essa ordem de novo
      // (em server.js ou aqui), os testes de categorias-sugeridas/listagem
      // abaixo voltam a falhar — é exatamente o sinal que queremos.
      app.use('/api/produtos-base', produtosBaseRouter);
      app.use('/api/produtos', produtosRouter);

      server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'55555555000199',$2,TRUE)
         ON CONFLICT (id) DO UPDATE SET razao_social = EXCLUDED.razao_social, ativo = TRUE`,
        [EMPRESA_ID, `${PREFIXO_TESTE} EMPRESA MAPA DE PRODUTOS`]
      );
      // Limpa qualquer resíduo de execuções anteriores desta mesma empresa de teste.
      await pool.query('DELETE FROM produto_base_aliases WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produtos_base WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM produto_base_aliases WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produtos_base WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    });

    let produtoBaseId;

    test('POST /api/produtos-base cria produto base com medida e categoria', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          empresaId: EMPRESA_ID,
          codigo: `${PREFIXO_TESTE}-CX-16X11X6`,
          nome: 'Caixa de papelão 16x11x6',
          medida: '16X11X6',
          categoria: 'Caixas de papelão',
          custo: 3.5,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.produtoBase.medida, '16X11X6');
      assert.equal(body.produtoBase.categoria, 'Caixas de papelão');
      assert.equal(body.produtoBase.custo, 3.5);
      assert.equal(body.produtoBase.ativo, true);
      produtoBaseId = body.produtoBase.id;
    });

    test('POST /api/produtos-base sem código devolve 400 com erro de validação', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.errors.codigo);
    });

    test('GET /api/produtos-base?search= encontra pela medida, não só por código/nome', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base?empresaId=${EMPRESA_ID}&search=16x11`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.produtosBase.some((p) => p.id === produtoBaseId), 'busca por medida deve achar o produto cadastrado com medida 16X11X6');
    });

    test('GET /api/produtos-base/categorias-sugeridas devolve as categorias já usadas por esta empresa (regressão de roteamento)', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/categorias-sugeridas?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200, 'se isso vier 404/500, o router /api/produtos está interceptando /api/produtos-base de novo');
      const body = await res.json();
      assert.ok(Array.isArray(body.categorias));
      assert.ok(body.categorias.includes('Caixas de papelão'));
    });

    test('PUT /api/produtos-base/:id atualiza medida e categoria sem afetar o resto', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/${produtoBaseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ medida: '16X11X6 (corrigida)' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.produtoBase.medida, '16X11X6 (corrigida)');
      assert.equal(body.produtoBase.categoria, 'Caixas de papelão', 'campo não enviado no PUT deve permanecer intacto');
    });

    test('PATCH /api/produtos-base/:id/status desativa e reativa', async () => {
      let res = await fetch(`${baseUrl}/api/produtos-base/${produtoBaseId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: false }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).produtoBase.ativo, false);

      const listaInativos = await (await fetch(`${baseUrl}/api/produtos-base?empresaId=${EMPRESA_ID}&status=inativos`)).json();
      assert.ok(listaInativos.produtosBase.some((p) => p.id === produtoBaseId));

      res = await fetch(`${baseUrl}/api/produtos-base/${produtoBaseId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: true }),
      });
      assert.equal((await res.json()).produtoBase.ativo, true);
    });

    let vinculoId;

    test('POST /api/produtos-base/vinculos cria vínculo SKU -> produto base existente', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/vinculos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          empresaId: EMPRESA_ID,
          sku: `${PREFIXO_TESTE}-100CX-16X11X6`,
          produtoBaseId,
          multiplicador: 100,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.vinculo.multiplicador, 100);
      assert.equal(body.vinculo.produtoBaseId, produtoBaseId);
      assert.equal(body.vinculo.origem, 'manual');
      vinculoId = body.vinculo.id;
    });

    test('POST /api/produtos-base/vinculos com codigoProdutoBase cria o produto base na hora', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/vinculos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          empresaId: EMPRESA_ID,
          sku: `${PREFIXO_TESTE}-25CX-19X12X12`,
          codigoProdutoBase: `${PREFIXO_TESTE}-CX-19X12X12`,
          multiplicador: 25,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.vinculo.produtoBaseCodigo, `${PREFIXO_TESTE}-CX-19X12X12`);

      const listaProdutos = await (await fetch(`${baseUrl}/api/produtos-base?empresaId=${EMPRESA_ID}`)).json();
      assert.ok(listaProdutos.produtosBase.some((p) => p.codigo === `${PREFIXO_TESTE}-CX-19X12X12`), 'o produto base novo deve ter sido criado automaticamente');
    });

    test('PUT /api/produtos-base/vinculos/:id corrige o multiplicador e valida entrada inválida', async () => {
      let res = await fetch(`${baseUrl}/api/produtos-base/vinculos/${vinculoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplicador: 120 }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).vinculo.multiplicador, 120);

      res = await fetch(`${baseUrl}/api/produtos-base/vinculos/${vinculoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplicador: 0 }),
      });
      assert.equal(res.status, 400, 'multiplicador zero/negativo deve ser rejeitado');
    });

    test('GET /api/produtos-base/vinculos/sugestoes nunca inclui um SKU que já tem vínculo salvo', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/vinculos/sugestoes?empresaId=${EMPRESA_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!body.sugestoes.some((s) => s.sku === `${PREFIXO_TESTE}-100CX-16X11X6`));
    });

    test('DELETE /api/produtos-base/vinculos/:id remove o vínculo', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/vinculos/${vinculoId}`, { method: 'DELETE' });
      assert.equal(res.status, 204);
      const lista = await (await fetch(`${baseUrl}/api/produtos-base/vinculos?empresaId=${EMPRESA_ID}`)).json();
      assert.ok(!lista.vinculos.some((v) => v.id === vinculoId));
    });

    let aliasId;

    test('POST /api/produtos-base/aliases cria um apelido para o produto base', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, produtoBaseId, alias: `${PREFIXO_TESTE} aquela 16x11x6` }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.alias.origem, 'manual');
      assert.equal(body.alias.produtoBaseCodigo, `${PREFIXO_TESTE}-CX-16X11X6`);
      aliasId = body.alias.id;
    });

    test('POST /api/produtos-base/aliases sem produto base nem alias devolve 400 com os dois erros', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.errors.alias);
      assert.ok(body.errors.produtoBase);
    });

    test('GET /api/produtos-base/aliases?produtoBaseId= filtra por produto', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/aliases?empresaId=${EMPRESA_ID}&produtoBaseId=${produtoBaseId}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.aliases.every((a) => a.produtoBaseId === produtoBaseId));
      assert.ok(body.aliases.some((a) => a.id === aliasId));
    });

    test('PUT /api/produtos-base/aliases/:id corrige o texto do apelido e marca origem manual', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/aliases/${aliasId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: `${PREFIXO_TESTE} caixa pequena` }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.alias.alias, `${PREFIXO_TESTE} caixa pequena`);
      assert.equal(body.alias.origem, 'manual');
    });

    test('DELETE /api/produtos-base/aliases/:id remove o apelido', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/aliases/${aliasId}`, { method: 'DELETE' });
      assert.equal(res.status, 204);
      const lista = await (await fetch(`${baseUrl}/api/produtos-base/aliases?empresaId=${EMPRESA_ID}`)).json();
      assert.ok(!lista.aliases.some((a) => a.id === aliasId));
    });

    test('DELETE /api/produtos-base/aliases/:id inexistente devolve 404', async () => {
      const res = await fetch(`${baseUrl}/api/produtos-base/aliases/999999999`, { method: 'DELETE' });
      assert.equal(res.status, 404);
    });
  }
);
