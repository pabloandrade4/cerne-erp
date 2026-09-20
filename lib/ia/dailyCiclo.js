// Orquestração da "Daily dos Agentes" — Etapa 2 (14/09/2026, pedido
// explícito do usuário). Cria/atualiza a reunião do dia e chama cada
// especialista cadastrado em lib/ia/especialistas.js, gravando os achados
// reais que eles produzirem em ia_achados_diarios.
//
// NESTA ETAPA NÃO HÁ AGENTE COORDENADOR (Etapa 3, ainda não implementada) —
// nenhum cruzamento entre achados de agentes diferentes acontece aqui, só a
// coleta.
//
// Etapa 4 (19/09/2026, pedido explícito do usuário: "quero que atualize...
// e quero... me enviar relatórios... pelo WhatsApp"): agendamento automático
// (ver lib/ia/dailyScheduler.js, que decide QUANDO rodar) + envio do resumo
// por WhatsApp — `executarDailyComNotificacao` abaixo é o que o agendador
// chama; roda executarDailyEmpresa (mesma função da Etapa 2, sem mudar nada
// nela) e, se ainda não enviou hoje pra essa empresa, manda o resumo real
// pro WhatsApp configurado (ver lib/whatsapp.js — mesma integração já usada
// pelo Radar da IA). `routes/daily.js` continua funcionando exatamente igual
// pra disparo manual/conferência em tela.
const pool = require('../../db/pool');
const { diaBRT } = require('../periodo');
const { ESPECIALISTAS } = require('./especialistas');
const { whatsappConfigurado, enviarMensagemWhatsapp } = require('../whatsapp');

// Reaproveita a reunião do dia se ela já existir (índice único em
// ia_reunioes_diarias por empresa+data) — rodar de novo no mesmo dia
// atualiza a MESMA reunião, nunca duplica. `reuniao_anterior_id` é decidido
// só na primeira vez que a reunião do dia é criada (a reunião concluída
// mais recente ANTES desta data) e nunca muda depois, mesmo que você rode
// de novo no mesmo dia.
async function obterOuCriarReuniaoDoDia(empresaId, dataReferencia) {
  const { rows: anterior } = await pool.query(
    `SELECT id FROM ia_reunioes_diarias
      WHERE empresa_id = $1 AND data_referencia < $2
      ORDER BY data_referencia DESC LIMIT 1`,
    [empresaId, dataReferencia]
  );
  const reuniaoAnteriorIdCandidata = anterior.length ? anterior[0].id : null;

  const { rows } = await pool.query(
    `INSERT INTO ia_reunioes_diarias (empresa_id, data_referencia, reuniao_anterior_id, status, erro, finalizada_em)
     VALUES ($1, $2, $3, 'em_andamento', NULL, NULL)
     ON CONFLICT (empresa_id, data_referencia)
       DO UPDATE SET status = 'em_andamento', erro = NULL, finalizada_em = NULL
     RETURNING id, reuniao_anterior_id`,
    [empresaId, dataReferencia, reuniaoAnteriorIdCandidata]
  );
  return { reuniaoId: rows[0].id, reuniaoAnteriorId: rows[0].reuniao_anterior_id };
}

async function limparAchados(reuniaoId) {
  await pool.query('DELETE FROM ia_achados_diarios WHERE reuniao_id = $1', [reuniaoId]);
}

async function inserirAchados(reuniaoId, agenteCodigo, achados) {
  for (const a of achados) {
    await pool.query(
      `INSERT INTO ia_achados_diarios
         (reuniao_id, agente_codigo, tipo, titulo, descricao, dados, prioridade,
          sku, campanha_id, pedido_id, decisao_tabela, decisao_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        reuniaoId, agenteCodigo, a.tipo, a.titulo, a.descricao || null,
        a.dados !== undefined && a.dados !== null ? JSON.stringify(a.dados) : null,
        a.prioridade || null, a.sku || null, a.campanhaId || null, a.pedidoId || null,
        a.decisaoTabela || null, a.decisaoId || null,
      ]
    );
  }
}

// Roda a Daily de UMA empresa — chama todo especialista cadastrado. Uma
// falha de um especialista NUNCA derruba os demais (mesma filosofia de
// resiliência já usada em lib/ia/promocoesCiclo.js/lib/adsScheduler.js) —
// fica registrada em `comErro` e no campo `erro` da reunião; a reunião só
// termina como 'falhou' se NENHUM especialista conseguir produzir achados.
async function executarDailyEmpresa(empresaId, { dataReferencia } = {}) {
  const dataRef = dataReferencia || diaBRT(new Date());
  const { reuniaoId, reuniaoAnteriorId } = await obterOuCriarReuniaoDoDia(empresaId, dataRef);
  await limparAchados(reuniaoId);

  const achadosPorAgente = {};
  const comErro = [];
  for (const especialista of ESPECIALISTAS) {
    try {
      const { achados } = await especialista.gerarResumoDiario({
        empresaId, dataReferencia: dataRef, reuniaoAnteriorId,
      });
      await inserirAchados(reuniaoId, especialista.AGENTE_CODIGO, achados || []);
      achadosPorAgente[especialista.AGENTE_CODIGO] = (achados || []).length;
    } catch (err) {
      const msg = String((err && err.message) || err);
      comErro.push({ agenteCodigo: especialista.AGENTE_CODIGO, erro: msg });
      console.error(`[Daily] especialista "${especialista.AGENTE_CODIGO}" falhou (empresa ${empresaId}):`, msg);
    }
  }

  const totalAchados = Object.values(achadosPorAgente).reduce((soma, n) => soma + n, 0);
  const status = Object.keys(achadosPorAgente).length ? 'concluida' : 'falhou';
  await pool.query(
    `UPDATE ia_reunioes_diarias SET status = $2, erro = $3, finalizada_em = now() WHERE id = $1`,
    [reuniaoId, status, comErro.length ? JSON.stringify(comErro) : null]
  );

  return {
    reuniaoId, empresaId, dataReferencia: dataRef, reuniaoAnteriorId,
    status, totalAchados, achadosPorAgente, comErro,
  };
}

// Devolve a reunião mais recente da empresa (qualquer status) com os
// achados agrupados por agente — usado pela tela de conferência (Etapa 2) e
// pela futura tela "Plano de Ação do Dia" (Etapa 5). Nunca inventa: reunião
// inexistente devolve `reuniao: null`, nunca um objeto vazio fingindo dado.
async function buscarUltimaReuniao(empresaId) {
  const { rows: reunioes } = await pool.query(
    `SELECT id, data_referencia, reuniao_anterior_id, status, erro, iniciada_em, finalizada_em
       FROM ia_reunioes_diarias
      WHERE empresa_id = $1
      ORDER BY data_referencia DESC, id DESC
      LIMIT 1`,
    [empresaId]
  );
  if (!reunioes.length) return { reuniao: null, achadosPorAgente: {} };

  const reuniao = reunioes[0];
  const { rows: achados } = await pool.query(
    `SELECT id, agente_codigo, tipo, titulo, descricao, dados, prioridade,
            sku, campanha_id, pedido_id, decisao_tabela, decisao_id, criado_em
       FROM ia_achados_diarios
      WHERE reuniao_id = $1
      ORDER BY agente_codigo,
               CASE prioridade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 WHEN 'baixa' THEN 3 ELSE 4 END,
               id`,
    [reuniao.id]
  );

  const achadosPorAgente = {};
  for (const a of achados) {
    if (!achadosPorAgente[a.agente_codigo]) achadosPorAgente[a.agente_codigo] = [];
    achadosPorAgente[a.agente_codigo].push({
      id: a.id,
      tipo: a.tipo,
      titulo: a.titulo,
      descricao: a.descricao,
      dados: a.dados,
      prioridade: a.prioridade,
      sku: a.sku,
      campanhaId: a.campanha_id,
      pedidoId: a.pedido_id,
      decisaoTabela: a.decisao_tabela,
      decisaoId: a.decisao_id,
      criadoEm: a.criado_em,
    });
  }

  return {
    reuniao: {
      id: reuniao.id,
      dataReferencia: reuniao.data_referencia,
      reuniaoAnteriorId: reuniao.reuniao_anterior_id,
      status: reuniao.status,
      erro: reuniao.erro,
      iniciadaEm: reuniao.iniciada_em,
      finalizadaEm: reuniao.finalizada_em,
    },
    achadosPorAgente,
  };
}

// ---------------- Etapa 4: agendamento automático + WhatsApp ----------------
// (19/09/2026, pedido explícito do usuário)

const PRIORIDADE_EMOJI = { critica: '🔴', alta: '🟠', media: '🟡', baixa: '🟢' };
const MAX_ACHADOS_POR_AGENTE_NA_MENSAGEM = 8; // mensagem de WhatsApp não pode virar um relatório infinito

// Devolve se a reunião do dia (se já existir) já teve o WhatsApp enviado —
// índice único por empresa+data garante no máximo 1 linha. Reunião
// inexistente ainda = nunca enviou (nunca inventa um envio que não houve).
async function buscarStatusEnvioHoje(empresaId, dataReferencia) {
  const { rows } = await pool.query(
    `SELECT id, whatsapp_enviado_em FROM ia_reunioes_diarias WHERE empresa_id = $1 AND data_referencia = $2`,
    [empresaId, dataReferencia]
  );
  if (!rows.length) return { reuniaoId: null, jaEnviou: false };
  return { reuniaoId: rows[0].id, jaEnviou: Boolean(rows[0].whatsapp_enviado_em) };
}

async function marcarWhatsappEnviado(reuniaoId) {
  await pool.query('UPDATE ia_reunioes_diarias SET whatsapp_enviado_em = now() WHERE id = $1', [reuniaoId]);
}

// Nomes reais dos agentes (ia_agentes.nome) — nunca um texto inventado pro
// código interno (ex.: 'ads_performance') virar título de seção na mensagem.
async function nomesDosAgentes(codigos) {
  if (!codigos.length) return {};
  const { rows } = await pool.query('SELECT codigo, nome FROM ia_agentes WHERE codigo = ANY($1)', [codigos]);
  const mapa = {};
  rows.forEach((r) => { mapa[r.codigo] = r.nome; });
  return mapa;
}

// Mesmo espírito de lib/ia/radar.js#formatarMensagemWhatsapp: só frases
// montadas a partir de dado real (título/prioridade do achado, nome real do
// agente) — zero achado hoje também é uma mensagem honesta ("tudo dentro do
// esperado"), nunca silêncio.
function formatarMensagemWhatsappDaily({ empresaNome, dataReferencia, achadosPorAgente, nomesAgentes }) {
  const entradas = Object.entries(achadosPorAgente).filter(([, achados]) => achados.length);
  const totalAchados = entradas.reduce((soma, [, achados]) => soma + achados.length, 0);
  const cabecalho = `📋 *PF Embalagens* — Resumo diário (${dataReferencia}) para *${empresaNome}*`;

  if (!totalAchados) {
    return `${cabecalho}\n\n✅ Nenhum achado novo hoje nos agentes de IA (Ads, Promoções, Anúncios, Análise de Concorrente e SAC) — nada pendente além do que você já vê no sistema.`;
  }

  const blocos = entradas.map(([codigo, achados]) => {
    const nomeAgente = nomesAgentes[codigo] || codigo;
    const linhas = achados.slice(0, MAX_ACHADOS_POR_AGENTE_NA_MENSAGEM).map((a) => {
      const emoji = PRIORIDADE_EMOJI[a.prioridade] || '⚪';
      return `${emoji} ${a.titulo}`;
    });
    const excedente = achados.length - linhas.length;
    if (excedente > 0) linhas.push(`… e mais ${excedente}.`);
    return `*${nomeAgente}* (${achados.length}):\n${linhas.join('\n')}`;
  });

  return [cabecalho, ...blocos, 'Veja, aprove ou recuse cada sugestão em Agentes IA, dentro do sistema.'].join('\n\n');
}

// Roda a Daily de uma empresa (reaproveitando executarDailyEmpresa, Etapa 2,
// sem alterar seu comportamento) e, se ainda não mandou hoje pra essa
// empresa, envia o resumo por WhatsApp — no máximo 1 mensagem por empresa
// por dia, mesmo que o processo reinicie ou o agendador rode de novo antes
// do próximo dia (ver buscarStatusEnvioHoje/marcarWhatsappEnviado acima).
// Quem decide QUANDO chamar isto (respeitando o horário configurado) é
// lib/ia/dailyScheduler.js — esta função nunca olha o relógio, só o que já
// foi ou não enviado hoje.
async function executarDailyComNotificacao(empresaId, { agora = new Date(), enviarMensagemWhatsappFn } = {}) {
  const dataRef = diaBRT(agora);
  const statusEnvio = await buscarStatusEnvioHoje(empresaId, dataRef);
  if (statusEnvio.jaEnviou) {
    return { empresaId, dataReferencia: dataRef, pulado: true, motivo: 'ja_enviado_hoje' };
  }

  const resultado = await executarDailyEmpresa(empresaId, { dataReferencia: dataRef });

  const { rows: empresaRows } = await pool.query('SELECT razao_social, nome_fantasia FROM empresas WHERE id = $1', [empresaId]);
  const empresaNome = empresaRows.length ? (empresaRows[0].nome_fantasia || empresaRows[0].razao_social) : `Empresa ${empresaId}`;

  const { achadosPorAgente } = await buscarUltimaReuniao(empresaId);
  const nomesAgentes = await nomesDosAgentes(Object.keys(achadosPorAgente));
  const texto = formatarMensagemWhatsappDaily({ empresaNome, dataReferencia: dataRef, achadosPorAgente, nomesAgentes });

  // `enviarMensagemWhatsappFn` explícita (só em teste, ver test/dailyCiclo.test.js)
  // pula a checagem de configuração — quem injeta a função sabe o que está
  // testando. Sem override (uso real, via lib/ia/dailyScheduler.js), sempre
  // respeita whatsappConfigurado() antes de tentar enviar de verdade.
  const enviarFn = enviarMensagemWhatsappFn || enviarMensagemWhatsapp;
  let whatsapp = { enviado: false, motivo: 'nao_configurado' };
  if (enviarMensagemWhatsappFn || whatsappConfigurado()) {
    try {
      whatsapp = await enviarFn(texto);
    } catch (err) {
      whatsapp = { enviado: false, motivo: 'erro_inesperado', detalhe: String((err && err.message) || err) };
    }
  }
  if (!whatsapp.enviado) {
    console.error(`[Daily] não foi possível enviar o resumo por WhatsApp (empresa ${empresaId}): motivo=${whatsapp.motivo}${whatsapp.detalhe ? ' detalhe=' + whatsapp.detalhe : ''}`);
  }

  // Marca como "tentado hoje" mesmo se o WhatsApp falhar/não estiver
  // configurado — a Daily em si já rodou e os achados já estão reais e
  // consultáveis em tela; não faz sentido tentar de novo a cada ciclo do
  // agendador até amanhã (mesma filosofia resiliente do Radar da IA: loga e
  // segue, nunca trava o resto do sistema por causa do WhatsApp).
  if (resultado.reuniaoId) await marcarWhatsappEnviado(resultado.reuniaoId);

  return { ...resultado, empresaNome, whatsapp };
}

module.exports = {
  executarDailyEmpresa,
  buscarUltimaReuniao,
  executarDailyComNotificacao,
  formatarMensagemWhatsappDaily,
};
