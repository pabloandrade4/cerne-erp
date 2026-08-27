// Testes de lib/mapaProdutos.js#identificarProdutoFisico — Etapa (b) da
// tarefa "IA Gestora que conhece o negócio" (27/08/2026, ver
// docs/02-decisoes.md e docs/PROPOSTA-contexto-negocio-ia-gestora.md).
//
// Regra central testada aqui, repetida do comentário do próprio arquivo:
// a função NUNCA escolhe sozinha entre produtos candidatos — só devolve
// 'identificado' quando existe exatamente 1 resultado numa camada; qualquer
// outra situação com mais de um candidato vira 'ambiguo', nunca uma escolha
// arbitrária (ex: "o primeiro da lista").
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { identificarProdutoFisico } = require('../lib/mapaProdutos');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_MAPA_ID = 972;
const OUTRA_EMPRESA_ID = 900; // já seedada por outros testes — usada só pra provar isolamento entre empresas

describe(
  'mapaProdutos — identificarProdutoFisico (Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado (ver relatorioVendas.integration.test.js)' },
  () => {
    let pool;
    let idExato, idOutro, idDup1, idDup2;

    before(async () => {
      pool = require('../db/pool');
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'66666666000100','EMPRESA TESTE MAPA PRODUTOS',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_MAPA_ID]
      );
      await pool.query('DELETE FROM produto_base_aliases WHERE empresa_id = $1', [EMPRESA_MAPA_ID]);
      await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1', [EMPRESA_MAPA_ID]);
      await pool.query('DELETE FROM produtos_base WHERE empresa_id = $1', [EMPRESA_MAPA_ID]);

      const { rows } = await pool.query(
        `INSERT INTO produtos_base (empresa_id, codigo, nome, medida, categoria, ativo) VALUES
           ($1,'CX-MAPA-EXATO','Caixa Mapa Exato','10X10X10','Teste Mapa',TRUE),
           ($1,'CX-MAPA-OUTRO','Caixa Mapa Outro','20X20X20','Teste Mapa',TRUE),
           ($1,'CX-MAPA-DUP-1','Caixa Mapa Duplicada 1','DUP-MEDIDA-MAPA','Teste Mapa',TRUE),
           ($1,'CX-MAPA-DUP-2','Caixa Mapa Duplicada 2','DUP-MEDIDA-MAPA','Teste Mapa',TRUE)
         RETURNING id, codigo`,
        [EMPRESA_MAPA_ID]
      );
      idExato = rows.find((r) => r.codigo === 'CX-MAPA-EXATO').id;
      idOutro = rows.find((r) => r.codigo === 'CX-MAPA-OUTRO').id;
      idDup1 = rows.find((r) => r.codigo === 'CX-MAPA-DUP-1').id;
      idDup2 = rows.find((r) => r.codigo === 'CX-MAPA-DUP-2').id;

      await pool.query(
        `INSERT INTO produto_base_aliases (empresa_id, produto_base_id, alias, origem) VALUES ($1,$2,'apelido mapa teste','manual')`,
        [EMPRESA_MAPA_ID, idExato]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM produto_base_aliases WHERE empresa_id = $1', [EMPRESA_MAPA_ID]);
      await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1', [EMPRESA_MAPA_ID]);
      await pool.query('DELETE FROM produtos_base WHERE empresa_id = $1', [EMPRESA_MAPA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_MAPA_ID]);
      await pool.end();
    });

    test('identificado por CÓDIGO exato (case-insensitive, ignorando espaço nas pontas)', async () => {
      const r = await identificarProdutoFisico(EMPRESA_MAPA_ID, '  cx-mapa-exato  ');
      assert.equal(r.status, 'identificado');
      assert.equal(r.camadaEncontrada, 'codigo');
      assert.equal(r.produto.id, idExato);
      assert.equal(r.produto.codigo, 'CX-MAPA-EXATO');
      assert.deepEqual(r.candidatos, []);
    });

    test('identificado por APELIDO exato', async () => {
      const r = await identificarProdutoFisico(EMPRESA_MAPA_ID, 'Apelido Mapa Teste');
      assert.equal(r.status, 'identificado');
      assert.equal(r.camadaEncontrada, 'apelido');
      assert.equal(r.produto.id, idExato);
    });

    test('identificado por MEDIDA exata (sem código/apelido batendo)', async () => {
      const r = await identificarProdutoFisico(EMPRESA_MAPA_ID, '20X20X20');
      assert.equal(r.status, 'identificado');
      assert.equal(r.camadaEncontrada, 'medida');
      assert.equal(r.produto.id, idOutro);
    });

    test('ambíguo quando MAIS DE UM produto compartilha a mesma medida — nunca escolhe um sozinho', async () => {
      const r = await identificarProdutoFisico(EMPRESA_MAPA_ID, 'DUP-MEDIDA-MAPA');
      assert.equal(r.status, 'ambiguo');
      assert.equal(r.produto, null);
      assert.equal(r.candidatos.length, 2);
      assert.deepEqual(r.candidatos.map((c) => c.id).sort(), [idDup1, idDup2].sort());
    });

    test('ambíguo via busca aproximada quando nenhuma camada exata bate mas vários produtos contêm o texto', async () => {
      const r = await identificarProdutoFisico(EMPRESA_MAPA_ID, 'MAPA');
      assert.equal(r.status, 'ambiguo');
      assert.equal(r.camadaEncontrada, 'aproximado');
      assert.ok(r.candidatos.length >= 2);
    });

    test('não encontrado quando nada bate, nem de forma aproximada', async () => {
      const r = await identificarProdutoFisico(EMPRESA_MAPA_ID, 'XYZ-NADA-QUE-EXISTA-AQUI-9999');
      assert.equal(r.status, 'nao_encontrado');
      assert.equal(r.produto, null);
      assert.deepEqual(r.candidatos, []);
    });

    test('texto vazio: nunca quebra, devolve nao_encontrado', async () => {
      const r1 = await identificarProdutoFisico(EMPRESA_MAPA_ID, '');
      const r2 = await identificarProdutoFisico(EMPRESA_MAPA_ID, '   ');
      const r3 = await identificarProdutoFisico(EMPRESA_MAPA_ID, undefined);
      assert.equal(r1.status, 'nao_encontrado');
      assert.equal(r2.status, 'nao_encontrado');
      assert.equal(r3.status, 'nao_encontrado');
    });

    test('isolamento entre empresas: um código cadastrado numa empresa nunca aparece pra outra empresa', async () => {
      const r = await identificarProdutoFisico(OUTRA_EMPRESA_ID, 'CX-MAPA-EXATO');
      assert.equal(r.status, 'nao_encontrado');
    });
  }
);
