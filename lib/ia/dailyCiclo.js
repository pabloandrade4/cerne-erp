// Orquestração da "Daily dos Agentes" — Etapa 2 (14/09/2026, pedido
// explícito do usuário). Cria/atualiza a reunião do dia e chama cada
// especialista cadastrado em lib/ia/especialistas.js, gravando os achados
// reais que eles produzirem em ia_achados_diarios.
//
// NESTA ETAPA NÃO HÁ AGENTE COORDENADOR (Etapa 3, ainda não implementada) —
// nenhum cruzamento entre achados de agentes diferentes acontece aqui, só a
// coleta. Também não há agendamento automático às 09:00 (Etapa 4) — esta
// função só roda quando chamada manualmente (ver routes/daily.js), do mesmo
// jeito que POST /api/ads/decisoes/gerar-agora já funciona hoje.
const pool = require('../../db/pool');
const { diaBRT } = require('../periodo');
const { ESPECIALISTAS } = require('./especialistas');

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

module.exports = { executarDailyEmpresa, buscarUltimaReuniao };
