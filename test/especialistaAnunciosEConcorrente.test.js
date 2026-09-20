// Especialistas "Anúncios" e "Análise de Concorrente" para a Daily dos
// Agentes (19/09/2026, pedido explícito do usuário: "quero que os
// relatórios... me envie tudo no whatsapp"). Testes de INTEGRAÇÃO — cada
// especialista só LÊ radar_alertas (nunca recalcula/chama API nenhuma),
// então basta inserir/limpar linhas reais na tabela pra testar.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 981;

describe(
  'especialistaAnuncios / especialistaConcorrente — Daily dos Agentes só lê o que já foi persistido, nunca recalcula (19/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, especialistaAnuncios, especialistaConcorrente;

    before(async () => {
      pool = require('../db/pool');
      especialistaAnuncios = require('../lib/ia/especialistaAnuncios');
      especialistaConcorrente = require('../lib/ia/especialistaConcorrente');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '98170707000199', 'EMPRESA TESTE ESPECIALISTAS', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
    });

    afterEach(async () => {
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
    });

    test('AGENTE_CODIGO bate com o codigo cadastrado em ia_agentes (senão a Daily quebra por causa da FK)', async () => {
      const { rows } = await pool.query('SELECT codigo FROM ia_agentes WHERE codigo = ANY($1)', [
        [especialistaAnuncios.AGENTE_CODIGO, especialistaConcorrente.AGENTE_CODIGO],
      ]);
      const codigos = rows.map((r) => r.codigo).sort();
      assert.deepEqual(codigos, [especialistaAnuncios.AGENTE_CODIGO, especialistaConcorrente.AGENTE_CODIGO].sort());
    });

    test('especialistaAnuncios: sem nenhum alerta "anuncio_*" aberto -> nenhum achado (nunca inventa)', async () => {
      const { achados } = await especialistaAnuncios.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.deepEqual(achados, []);
    });

    test('especialistaAnuncios: só entra alerta com categoria "anuncio_*" — nunca os financeiros/negócio do mesmo Radar', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES
           ($1, 'anuncio_parado:teste981', 'anuncio_parado', 'atencao', 'Anúncio parado', 'x', 'x', '{"sku":"SKU-981"}', 'aberto'),
           ($1, 'financeiro_contas_vencidas:teste981', 'financeiro_contas_vencidas', 'critico', 'Contas vencidas', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const { achados } = await especialistaAnuncios.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].titulo, 'Anúncio parado');
      assert.equal(achados[0].sku, 'SKU-981');
      assert.equal(achados[0].decisaoTabela, null, 'achado de Anúncios é só observação, nunca finge um fluxo de aprovar/recusar');
    });

    test('especialistaConcorrente: só entra alerta com categoria "concorrente_ativo", e severidade "critico"/"atencao" viram achado tipo "problema"', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES
           ($1, 'concorrente_ativo:1', 'concorrente_ativo', 'critico', 'Concorrente bem mais barato', 'x', 'x', '{"sku":"SKU-CONC-981"}', 'aberto'),
           ($1, 'anuncio_parado:outro981', 'anuncio_parado', 'atencao', 'Não é achado de concorrente', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const { achados } = await especialistaConcorrente.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].titulo, 'Concorrente bem mais barato');
      assert.equal(achados[0].tipo, 'problema');
      assert.equal(achados[0].prioridade, 'alta');
      assert.equal(achados[0].sku, 'SKU-CONC-981');
    });

    test('especialistaConcorrente: severidade "oportunidade" vira achado tipo "oportunidade", nunca tratado como problema', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'concorrente_ativo:2', 'concorrente_ativo', 'oportunidade', 'Você está competitivo', 'x', 'x', '{}', 'aberto')`,
        [EMPRESA_ID]
      );
      const { achados } = await especialistaConcorrente.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].tipo, 'oportunidade');
    });

    test('alerta RESOLVIDO nunca aparece pra nenhum dos dois especialistas', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status, resolvido_em)
         VALUES
           ($1, 'anuncio_parado:resolvido981', 'anuncio_parado', 'atencao', 'x', 'x', 'x', '{}', 'resolvido', now()),
           ($1, 'concorrente_ativo:resolvido981', 'concorrente_ativo', 'critico', 'x', 'x', 'x', '{}', 'resolvido', now())`,
        [EMPRESA_ID]
      );
      const [anuncios, concorrente] = await Promise.all([
        especialistaAnuncios.gerarResumoDiario({ empresaId: EMPRESA_ID }),
        especialistaConcorrente.gerarResumoDiario({ empresaId: EMPRESA_ID }),
      ]);
      assert.deepEqual(anuncios.achados, []);
      assert.deepEqual(concorrente.achados, []);
    });
  }
);
