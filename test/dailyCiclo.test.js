// "Daily dos Agentes" — Etapa 2 (14/09/2026) — testes de INTEGRAÇÃO (precisa
// de Postgres local, mesma regra de skip por DATABASE_URL dos outros
// arquivos desta pasta, ver topo de test/promocoesCiclo.test.js). Cobre:
//   1) os especialistas (Ads/Promoções) só produzem achado quando existe
//      decisão pendente REAL — nunca acham nada onde não há dado;
//   2) o tipo/prioridade do achado seguem o mapeamento determinístico
//      (nunca a IA "decide" por conta própria);
//   3) o ciclo cria/atualiza a reunião do dia (idempotente — rodar 2x no
//      mesmo dia não duplica achados);
//   4) achados de "alteração" citam APENAS decisões reais que existiam na
//      reunião anterior e já foram decididas, com o dado real da decisão.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 973;
const CONTA_ID = 973;

// formatarMensagemWhatsappDaily é função pura (nenhum banco/rede) — testada
// fora do bloco TEM_BANCO, mesmo espírito de test/radar.test.js#formatarMensagemWhatsapp.
describe('formatarMensagemWhatsappDaily — Etapa 4 (19/09/2026)', () => {
  const { formatarMensagemWhatsappDaily } = require('../lib/ia/dailyCiclo');

  test('zero achados: mensagem honesta de "tudo dentro do esperado", nunca inventa um problema', () => {
    const texto = formatarMensagemWhatsappDaily({
      empresaNome: 'PF Embalagens Teste', dataReferencia: '2026-09-19',
      achadosPorAgente: { ads_performance: [], promocoes: [] }, nomesAgentes: {},
    });
    assert.match(texto, /Nenhum achado novo hoje/);
    assert.match(texto, /PF Embalagens Teste/);
  });

  test('com achados: agrupa por agente (nome real, nunca o código), com emoji por prioridade e título real', () => {
    const texto = formatarMensagemWhatsappDaily({
      empresaNome: 'PF Embalagens Teste', dataReferencia: '2026-09-19',
      achadosPorAgente: {
        ads_performance: [
          { titulo: 'Campanha X com resultado negativo', prioridade: 'alta' },
          { titulo: 'Campanha Y pode escalar', prioridade: 'media' },
        ],
      },
      nomesAgentes: { ads_performance: 'Ads e Performance' },
    });
    assert.match(texto, /\*Ads e Performance\* \(2\)/);
    assert.match(texto, /🟠 Campanha X com resultado negativo/);
    assert.match(texto, /🟡 Campanha Y pode escalar/);
    assert.doesNotMatch(texto, /ads_performance/, 'nunca deve vazar o código interno do agente pro texto da mensagem');
  });

  test('corta em 8 achados por agente e avisa quantos ficaram de fora, nunca manda uma mensagem infinita', () => {
    const achados = Array.from({ length: 12 }, (_, i) => ({ titulo: 'Achado ' + i, prioridade: 'baixa' }));
    const texto = formatarMensagemWhatsappDaily({
      empresaNome: 'Teste', dataReferencia: '2026-09-19',
      achadosPorAgente: { ads_performance: achados }, nomesAgentes: {},
    });
    assert.match(texto, /… e mais 4\./);
  });
});

describe(
  'Daily dos Agentes — Etapa 2 (especialistas + ciclo, sem Coordenador)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool;
    let especialistaAds;
    let especialistaPromocoes;
    let dailyCiclo;

    before(async () => {
      pool = require('../db/pool');
      especialistaAds = require('../lib/ia/especialistaAds');
      especialistaPromocoes = require('../lib/ia/especialistaPromocoes');
      dailyCiclo = require('../lib/ia/dailyCiclo');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97370707000199', 'EMPRESA TESTE DAILY', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 973000001, 'LOJA TESTE DAILY', 'x', 'x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status = 'ativa'`,
        [CONTA_ID, EMPRESA_ID]
      );
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
    });

    test('especialistaAds: empresa sem nenhuma decisão pendente -> nenhum achado (nunca inventa)', async () => {
      const { achados } = await especialistaAds.gerarResumoDiario({ empresaId: EMPRESA_ID, reuniaoAnteriorId: null });
      assert.deepEqual(achados, []);
    });

    test('especialistaAds: decisão "pausar_campanha" pendente -> achado tipo "problema", prioridade "alta", ligado à decisão real', async () => {
      const { rows } = await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo,
                                       snapshot_margem_depois_ads, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha Teste','pausar_campanha','Resultado negativo real.', -120.50, '{"acao":"pausar"}', 'pendente')
         RETURNING id`,
        [EMPRESA_ID, CONTA_ID]
      );
      const decisaoId = rows[0].id;

      const { achados } = await especialistaAds.gerarResumoDiario({ empresaId: EMPRESA_ID, reuniaoAnteriorId: null });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].tipo, 'problema');
      assert.equal(achados[0].prioridade, 'alta');
      assert.equal(achados[0].decisaoTabela, 'ia_decisoes_ads');
      assert.equal(achados[0].decisaoId, decisaoId);
      assert.match(achados[0].titulo, /Campanha Teste/);
      assert.equal(achados[0].descricao, 'Resultado negativo real.');
      assert.equal(Number(achados[0].dados.margemDepoisDoAds), -120.5);
    });

    test('especialistaPromocoes: decisão "entrar_promocao" pendente -> achado tipo "oportunidade"', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_promocoes (empresa_id, conta_id, promotion_id, promotion_type, promotion_label, ml_item_id, sku, tipo_acao, motivo,
                                             snapshot_margem_real_pct, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'P1','SMART','Promo Teste','MLB1','SKU-1','entrar_promocao','Margem boa.', 25.5, '{"acao":"entrar"}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );
      const { achados } = await especialistaPromocoes.gerarResumoDiario({ empresaId: EMPRESA_ID, reuniaoAnteriorId: null });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].tipo, 'oportunidade');
      assert.equal(achados[0].sku, 'SKU-1');
    });

    test('executarDailyEmpresa: cria a reunião do dia e grava achados reais dos dois especialistas', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha X','aumentar_orcamento','Margem folgada.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );
      await pool.query(
        `INSERT INTO ia_decisoes_promocoes (empresa_id, conta_id, promotion_id, promotion_type, promotion_label, ml_item_id, sku, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'P1','SMART','Promo Y','MLB2','SKU-2','sair_promocao','Margem caiu.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );

      const resultado = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-14' });
      assert.equal(resultado.status, 'concluida');
      assert.equal(resultado.achadosPorAgente.ads_performance, 1);
      assert.equal(resultado.achadosPorAgente.promocoes, 1);
      assert.equal(resultado.totalAchados, 2);
      assert.equal(resultado.comErro.length, 0);

      const { reuniao, achadosPorAgente } = await dailyCiclo.buscarUltimaReuniao(EMPRESA_ID);
      assert.equal(reuniao.status, 'concluida');
      assert.equal(achadosPorAgente.ads_performance.length, 1);
      assert.equal(achadosPorAgente.promocoes.length, 1);
      assert.equal(achadosPorAgente.promocoes[0].tipo, 'problema');
    });

    test('executarDailyEmpresa: rodar 2x no mesmo dia reutiliza a MESMA reunião e não duplica achados', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha X','pausar_campanha','Negativo.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );

      const r1 = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-14' });
      const r2 = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-14' });
      assert.equal(r1.reuniaoId, r2.reuniaoId);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ia_achados_diarios WHERE reuniao_id = $1', [r1.reuniaoId]);
      assert.equal(rows[0].n, 1); // nunca duplica

      const { rows: reunioes } = await pool.query('SELECT COUNT(*)::int AS n FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      assert.equal(reunioes[0].n, 1); // nunca cria uma segunda reunião no mesmo dia
    });

    test('achado de "alteração": decisão que estava pendente na reunião anterior e já foi decidida aparece com o dado real da decisão', async () => {
      const { rows } = await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha Z','pausar_campanha','Negativo.', '{}', 'pendente') RETURNING id`,
        [EMPRESA_ID, CONTA_ID]
      );
      const decisaoId = rows[0].id;

      // Dia 1: a Daily roda e acha a decisão pendente.
      const dia1 = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-13' });
      assert.equal(dia1.achadosPorAgente.ads_performance, 1);

      // Você decide (fora da Daily, pelo fluxo normal de aprovar/recusar).
      await pool.query(
        `UPDATE ia_decisoes_ads SET status_decisao = 'aprovada', decidido_em = now(), valor_decidido_usuario = '{"confirmado":true}' WHERE id = $1`,
        [decisaoId]
      );

      // Dia 2: a Daily roda de novo — a decisão não está mais pendente, mas
      // como ela apareceu na reunião anterior, vira achado de "alteração".
      const dia2 = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-14' });
      assert.equal(dia2.reuniaoAnteriorId, dia1.reuniaoId);

      const { achadosPorAgente } = await dailyCiclo.buscarUltimaReuniao(EMPRESA_ID);
      const alteracoes = achadosPorAgente.ads_performance.filter((a) => a.tipo === 'alteracao');
      assert.equal(alteracoes.length, 1);
      assert.equal(alteracoes[0].decisaoId, decisaoId);
      assert.equal(alteracoes[0].dados.statusDecisao, 'aprovada');
      assert.deepEqual(alteracoes[0].dados.valorDecididoUsuario, { confirmado: true });
    });

    test('executarDailyComNotificacao: sem WhatsApp configurado no ambiente, ainda assim marca como "tentado hoje" e nunca roda 2x no mesmo dia pra mesma empresa', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C1','Campanha W','pausar_campanha','Negativo.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );

      const r1 = await dailyCiclo.executarDailyComNotificacao(EMPRESA_ID, { agora: new Date('2026-09-14T13:00:00Z') });
      assert.equal(r1.pulado, undefined);
      assert.equal(r1.totalAchados, 1);
      assert.equal(r1.whatsapp.enviado, false);
      assert.equal(r1.whatsapp.motivo, 'nao_configurado', 'ambiente de teste não tem TWILIO_* configurado — nunca finge que enviou');
      assert.equal(r1.empresaNome, 'EMPRESA TESTE DAILY');

      const r2 = await dailyCiclo.executarDailyComNotificacao(EMPRESA_ID, { agora: new Date('2026-09-14T18:00:00Z') });
      assert.equal(r2.pulado, true);
      assert.equal(r2.motivo, 'ja_enviado_hoje');

      const { rows } = await pool.query('SELECT whatsapp_enviado_em FROM ia_reunioes_diarias WHERE empresa_id = $1 AND data_referencia = $2', [EMPRESA_ID, '2026-09-14']);
      assert.ok(rows[0].whatsapp_enviado_em, 'a tentativa de envio (mesmo sem sucesso) precisa ficar marcada, pra nunca tentar de novo no mesmo dia');
    });

    test('executarDailyComNotificacao: quando a função de envio É injetada e funciona, whatsapp.enviado=true', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_promocoes (empresa_id, conta_id, promotion_id, promotion_type, promotion_label, ml_item_id, sku, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'P1','SMART','Promo Z','MLB3','SKU-3','entrar_promocao','Margem boa.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );
      let textoEnviado = null;
      const r1 = await dailyCiclo.executarDailyComNotificacao(EMPRESA_ID, {
        agora: new Date('2026-09-15T13:00:00Z'),
        enviarMensagemWhatsappFn: async (texto) => { textoEnviado = texto; return { enviado: true, sid: 'SM_TESTE' }; },
      });
      assert.equal(r1.whatsapp.enviado, true);
      assert.equal(r1.whatsapp.sid, 'SM_TESTE');
      assert.match(textoEnviado, /Promo Z/);
    });

    test('buscarUltimaReuniao: empresa sem nenhuma Daily ainda -> reuniao null (nunca inventa)', async () => {
      const { reuniao, achadosPorAgente } = await dailyCiclo.buscarUltimaReuniao(999998);
      assert.equal(reuniao, null);
      assert.deepEqual(achadosPorAgente, {});
    });
  }
);
