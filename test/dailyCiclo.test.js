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

  // Etapa 3 — Agente Coordenador (20/09/2026): as conclusões do Coordenador
  // precisam aparecer em DESTAQUE, ANTES do detalhe por agente — é o
  // "pontual o que deve ser feito" que o usuário pediu, não pode ficar
  // perdido no meio da mensagem.
  test('com correlações do Coordenador: aparecem no TOPO da mensagem, antes dos blocos por agente', () => {
    const texto = formatarMensagemWhatsappDaily({
      empresaNome: 'Teste', dataReferencia: '2026-09-20',
      achadosPorAgente: { anuncios_radar: [{ titulo: 'Anúncio X parado', prioridade: 'alta' }] },
      nomesAgentes: { anuncios_radar: 'Anúncios' },
      correlacoes: [{ conclusao: 'SKU CX-1: causa provável identificada — Ads pausado.', prioridade: 'alta' }],
    });
    const posicaoCorrelacao = texto.indexOf('O que fazer primeiro');
    const posicaoBlocoAgente = texto.indexOf('*Anúncios*');
    assert.ok(posicaoCorrelacao !== -1 && posicaoBlocoAgente !== -1 && posicaoCorrelacao < posicaoBlocoAgente);
    assert.match(texto, /causa provável identificada — Ads pausado\./);
  });

  test('sem correlações do Coordenador (parâmetro omitido): mensagem funciona igual, sem bloco de destaque', () => {
    const texto = formatarMensagemWhatsappDaily({
      empresaNome: 'Teste', dataReferencia: '2026-09-20',
      achadosPorAgente: { anuncios_radar: [{ titulo: 'Anúncio X parado', prioridade: 'alta' }] },
      nomesAgentes: { anuncios_radar: 'Anúncios' },
    });
    assert.doesNotMatch(texto, /O que fazer primeiro/);
  });
});

describe(
  'Daily dos Agentes — Etapa 2 (especialistas + ciclo) e Etapa 3 (Agente Coordenador)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool;
    let especialistaAds;
    let especialistaPromocoes;
    let dailyCiclo;
    let concorrente;

    before(async () => {
      pool = require('../db/pool');
      especialistaAds = require('../lib/ia/especialistaAds');
      especialistaPromocoes = require('../lib/ia/especialistaPromocoes');
      dailyCiclo = require('../lib/ia/dailyCiclo');
      concorrente = require('../lib/concorrente');

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
      // Ordem importa: ia_correlacoes_diarias/ia_achados_diarios referenciam
      // reuniao_id (sem CASCADE) — precisam sumir ANTES de apagar a reunião,
      // senão o DELETE de ia_reunioes_diarias quebra por FK.
      await pool.query('DELETE FROM ia_correlacoes_diarias WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM concorrentes_monitorados WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM ia_correlacoes_diarias WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id IN (SELECT id FROM ia_reunioes_diarias WHERE empresa_id = $1)', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_reunioes_diarias WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_ads WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ia_decisoes_promocoes WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM radar_alertas WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM concorrentes_monitorados WHERE empresa_id = $1', [EMPRESA_ID]);
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
      // Telegram (21/09/2026 — alternativa ao WhatsApp): mesmo comportamento
      // honesto — ambiente de teste também não tem TELEGRAM_* configurado.
      assert.equal(r1.telegram.enviado, false);
      assert.equal(r1.telegram.motivo, 'nao_configurado');
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

    test('executarDailyComNotificacao: WhatsApp e Telegram são independentes — só o Telegram injetado/configurado envia, WhatsApp continua nao_configurado', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_promocoes (empresa_id, conta_id, promotion_id, promotion_type, promotion_label, ml_item_id, sku, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'P2','SMART','Promo Telegram','MLB4','SKU-4','entrar_promocao','Margem boa.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );
      let textoEnviadoTelegram = null;
      const r1 = await dailyCiclo.executarDailyComNotificacao(EMPRESA_ID, {
        agora: new Date('2026-09-16T13:00:00Z'),
        enviarMensagemTelegramFn: async (texto) => { textoEnviadoTelegram = texto; return { enviado: true, messageId: 7 }; },
      });
      assert.equal(r1.telegram.enviado, true);
      assert.equal(r1.telegram.messageId, 7);
      assert.match(textoEnviadoTelegram, /Promo Telegram/);
      assert.equal(r1.whatsapp.enviado, false);
      assert.equal(r1.whatsapp.motivo, 'nao_configurado');
    });

    test('buscarUltimaReuniao: empresa sem nenhuma Daily ainda -> reuniao null (nunca inventa)', async () => {
      const { reuniao, achadosPorAgente, correlacoes } = await dailyCiclo.buscarUltimaReuniao(999998);
      assert.equal(reuniao, null);
      assert.deepEqual(achadosPorAgente, {});
      assert.deepEqual(correlacoes, []);
    });

    // ---------------- Etapa 3: Agente Coordenador — wiring real ----------------
    // (20/09/2026) Os testes de lib/ia/coordenadorDiario.js já cobrem as 4
    // regras isoladamente (função pura, sem banco). Aqui o que importa é
    // provar que executarDailyEmpresa: (a) devolve os IDs REAIS gerados
    // pelo Postgres pro Coordenador cruzar; (b) persiste o resultado em
    // ia_correlacoes_diarias; (c) buscarUltimaReuniao devolve isso de
    // volta; (d) nunca duplica ao rodar 2x no mesmo dia.
    test('executarDailyEmpresa: achado de Anúncios (radar_alertas) + achado de Ads (pausar_campanha) no mesmo SKU -> gera e persiste a correlação R1', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'anuncio_parado:teste-coord-1', 'anuncio_parado', 'atencao', 'Caixa Coordenador parada', 'Sem venda há 15 dias.', 'Revise o anúncio.',
                 $2::jsonb, 'aberto')`,
        [EMPRESA_ID, JSON.stringify({ sku: 'SKU-COORD-1', diasSemVenda: 15, estoqueDisponivel: 8, estoqueSincronizado: true })]
      );
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, sku, tipo_acao, motivo, snapshot_orcamento_atual, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C-COORD-1','Campanha Coordenador','SKU-COORD-1','pausar_campanha','Resultado negativo real.', 250, '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );

      const resultado = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-16' });
      assert.equal(resultado.status, 'concluida');
      assert.equal(resultado.totalCorrelacoes, 1);
      assert.equal(resultado.comErro.length, 0);

      const { correlacoes, achadosPorAgente } = await dailyCiclo.buscarUltimaReuniao(EMPRESA_ID);
      assert.equal(correlacoes.length, 1);
      assert.equal(correlacoes[0].regraCodigo, 'r1_ads_pausado_correlaciona_queda_anuncio');
      assert.equal(correlacoes[0].sku, 'SKU-COORD-1');
      assert.match(correlacoes[0].conclusao, /R\$ 250,00/);

      // os ids citados na correlação precisam ser os ids REAIS gravados em
      // ia_achados_diarios — nunca um id inventado/fora de ordem.
      const idAnuncio = achadosPorAgente.anuncios_radar[0].id;
      const idAds = achadosPorAgente.ads_performance[0].id;
      assert.deepEqual(correlacoes[0].achadosRelacionados.sort(), [idAnuncio, idAds].sort());
    });

    test('executarDailyEmpresa: anúncio com estoque zerado -> correlação R2, mesmo sem nenhum outro agente envolvido', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'anuncio_venda_baixa:teste-coord-2', 'anuncio_venda_baixa', 'atencao', 'Caixa Coordenador sem estoque', 'Vendeu pouco.', 'Revise.',
                 $2::jsonb, 'aberto')`,
        [EMPRESA_ID, JSON.stringify({ sku: 'SKU-COORD-2', estoqueDisponivel: 0, estoqueSincronizado: true })]
      );

      const resultado = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-16' });
      assert.equal(resultado.totalCorrelacoes, 1);

      const { correlacoes } = await dailyCiclo.buscarUltimaReuniao(EMPRESA_ID);
      assert.equal(correlacoes[0].regraCodigo, 'r2_estoque_zerado_anuncio');
      assert.equal(correlacoes[0].sku, 'SKU-COORD-2');
    });

    test('executarDailyEmpresa: anúncio em queda + concorrente CADASTRADO (lib/concorrente.js) pro mesmo SKU -> correlação R4 com o link real', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'anuncio_parado:teste-coord-4', 'anuncio_parado', 'atencao', 'Caixa Coordenador concorrente', 'Sem venda há 9 dias.', 'Revise.',
                 $2::jsonb, 'aberto')`,
        [EMPRESA_ID, JSON.stringify({ sku: 'SKU-COORD-4', diasSemVenda: 9 })]
      );
      await concorrente.cadastrarConcorrente({
        empresaId: EMPRESA_ID, sku: 'SKU-COORD-4', url: 'https://exemplo.com/concorrente-coordenador', apelido: 'Loja Rival Coordenador',
      });

      const resultado = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-16' });
      assert.equal(resultado.totalCorrelacoes, 1);

      const { correlacoes } = await dailyCiclo.buscarUltimaReuniao(EMPRESA_ID);
      assert.equal(correlacoes[0].regraCodigo, 'r4_concorrente_cadastrado_anuncio');
      assert.match(correlacoes[0].conclusao, /Loja Rival Coordenador/);
      assert.match(correlacoes[0].conclusao, /https:\/\/exemplo\.com\/concorrente-coordenador/);
    });

    test('executarDailyEmpresa: sem nenhum cruzamento possível -> zero correlações (honesto, nunca inventa causa)', async () => {
      await pool.query(
        `INSERT INTO ia_decisoes_ads (empresa_id, conta_id, tipo_referencia, campanha_id, campanha_nome, tipo_acao, motivo, valor_sugerido_ia, status_decisao)
         VALUES ($1,$2,'campanha','C-COORD-5','Campanha sem cruzamento','aumentar_orcamento','Margem folgada.', '{}', 'pendente')`,
        [EMPRESA_ID, CONTA_ID]
      );
      const resultado = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-16' });
      assert.equal(resultado.totalCorrelacoes, 0);
      const { correlacoes } = await dailyCiclo.buscarUltimaReuniao(EMPRESA_ID);
      assert.deepEqual(correlacoes, []);
    });

    test('executarDailyEmpresa: rodar 2x no mesmo dia regenera a correlação sem duplicar', async () => {
      await pool.query(
        `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, status)
         VALUES ($1, 'anuncio_parado:teste-coord-6', 'anuncio_parado', 'atencao', 'Caixa Coordenador repete', 'Sem venda.', 'Revise.',
                 $2::jsonb, 'aberto')`,
        [EMPRESA_ID, JSON.stringify({ sku: 'SKU-COORD-6', estoqueDisponivel: 0, estoqueSincronizado: true })]
      );
      const r1 = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-16' });
      const r2 = await dailyCiclo.executarDailyEmpresa(EMPRESA_ID, { dataReferencia: '2026-09-16' });
      assert.equal(r1.reuniaoId, r2.reuniaoId);
      assert.equal(r2.totalCorrelacoes, 1);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ia_correlacoes_diarias WHERE reuniao_id = $1', [r1.reuniaoId]);
      assert.equal(rows[0].n, 1);
    });
  }
);
