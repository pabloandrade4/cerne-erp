// Orquestrador do "Agente de Envio Full" — 23/09/2026, pedido explícito do
// usuário (ver lib/ia/envioFullMotor.js para o motor de cálculo). Mesmo
// padrão de lib/ia/comprasCiclo.js: cada produto base mantém NO MÁXIMO uma
// recomendação "pendente" por vez (índice único parcial em db/schema.sql)
// — se a mesma situação persistir de um ciclo pro outro, só atualiza os
// números da linha já existente; se deixar de fazer sentido (Full já
// abastecido, por exemplo), a recomendação pendente é marcada "expirada",
// nunca apagada.
//
// NUNCA busca dado novo em API nenhuma — reaproveita, sem nenhum cálculo
// paralelo:
//   • Estoque físico (Full e fora do Full): lib/estoqueFisico.js — mesma
//     fonte das telas Estoque, Estoque Full e Compras com IA.
//   • Vendas por período e produtos base ativos: lib/ia/comprasCiclo.js —
//     MESMAS funções já usadas por Compras com IA, importadas (não
//     duplicadas).
const pool = require('../../db/pool');
const { calcularEstoqueFisico } = require('../estoqueFisico');
const { calcularStatusEnvioFull } = require('./envioFullMotor');
const { buscarProdutosBaseAtivos, buscarVendasPorJanelas } = require('./comprasCiclo');

// Status que geram uma recomendação PENDENTE pro usuário aprovar — os
// demais (saudável/atenção) aparecem só como linha informativa na tabela
// principal, sem virar um "pedido de aprovação".
const STATUS_QUE_GERAM_RECOMENDACAO = new Set(['ruptura', 'enviar_agora', 'programar_envio']);

async function buscarRecomendacaoPendente(empresaId, produtoBaseId) {
  const { rows } = await pool.query(
    `SELECT id FROM ia_decisoes_envio_full
      WHERE empresa_id = $1 AND produto_base_id = $2 AND tipo_acao = 'enviar_full' AND status_decisao = 'pendente'`,
    [empresaId, produtoBaseId]
  );
  return rows.length ? rows[0].id : null;
}

function montarMotivo(c) {
  if (c.semHistoricoDeVendas) return 'Sem vendas registradas no período — sem base pra projetar quando enviar ao Full.';
  const partes = [];
  if (c.status === 'ruptura') partes.push(`Full deve zerar em cerca de ${c.diasCoberturaFull} dia(s) — envio urgente.`);
  else if (c.status === 'enviar_agora') partes.push(`Cobertura do Full (${c.diasCoberturaFull} dia(s)) já está dentro do prazo de envio + segurança.`);
  else if (c.status === 'programar_envio') partes.push(`Cobertura do Full (${c.diasCoberturaFull} dia(s)) se aproxima do ponto de reenvio — programe o próximo lote.`);
  if (c.acelerando) partes.push('Venda dos últimos 7 dias acelerando frente aos últimos 30 — projeção deu mais peso ao período recente.');
  if (c.desacelerando) partes.push('Venda dos últimos 7 dias desacelerando frente aos últimos 30 — projeção deu mais peso ao período recente.');
  if (c.semEstoqueGalpaoSuficiente) partes.push('Estoque no Galpão não é suficiente pra cobrir o envio recomendado — segurar até repor o Galpão.');
  return partes.join(' ');
}

async function upsertRecomendacao({ empresaId, produtoBase, calc, motivo }) {
  const idExistente = await buscarRecomendacaoPendente(empresaId, produtoBase.id);

  const params = [
    calc.status, calc.semEstoqueGalpaoSuficiente, motivo,
    calc.estoqueGalpao, calc.estoqueFull,
    calc.mediaDiaria7 * 7, calc.mediaDiaria14 * 14, calc.mediaDiaria30 * 30,
    calc.mediaDiariaProjetada, calc.acelerando,
    calc.diasCoberturaFull, calc.dataRupturaFullPrevista,
    calc.prazoEnvioFullDias, calc.estoqueSegurancaDias,
    calc.quantidadeSugeridaEnvio,
  ];

  if (idExistente) {
    await pool.query(
      `UPDATE ia_decisoes_envio_full SET
         status_urgencia=$1, sem_estoque_galpao_suficiente=$2, motivo=$3,
         snapshot_estoque_galpao=$4, snapshot_estoque_full=$5,
         snapshot_venda_7d=$6, snapshot_venda_14d=$7, snapshot_venda_30d=$8,
         snapshot_media_dia_projetada=$9, snapshot_acelerando=$10,
         snapshot_dias_cobertura_full=$11, snapshot_data_ruptura_full_prevista=$12,
         snapshot_prazo_envio_full_dias=$13, snapshot_estoque_seguranca_dias=$14,
         quantidade_sugerida_envio=$15,
         atualizado_em = now()
       WHERE id = $16`,
      [...params, idExistente]
    );
    return { id: idExistente, novo: false };
  }

  const { rows } = await pool.query(
    `INSERT INTO ia_decisoes_envio_full (
       empresa_id, produto_base_id, produto_base_codigo, tipo_acao,
       status_urgencia, sem_estoque_galpao_suficiente, motivo,
       snapshot_estoque_galpao, snapshot_estoque_full,
       snapshot_venda_7d, snapshot_venda_14d, snapshot_venda_30d,
       snapshot_media_dia_projetada, snapshot_acelerando,
       snapshot_dias_cobertura_full, snapshot_data_ruptura_full_prevista,
       snapshot_prazo_envio_full_dias, snapshot_estoque_seguranca_dias,
       quantidade_sugerida_envio
     ) VALUES ($1,$2,$3,'enviar_full',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [empresaId, produtoBase.id, produtoBase.codigo, ...params]
  );
  return { id: rows[0].id, novo: true };
}

async function expirarNaoTocadas(empresaId, idsTocados) {
  if (!idsTocados.length) {
    await pool.query(
      `UPDATE ia_decisoes_envio_full SET status_decisao='expirada', atualizado_em=now()
        WHERE empresa_id=$1 AND status_decisao='pendente'`,
      [empresaId]
    );
    return;
  }
  await pool.query(
    `UPDATE ia_decisoes_envio_full SET status_decisao='expirada', atualizado_em=now()
      WHERE empresa_id=$1 AND status_decisao='pendente' AND id <> ALL($2::int[])`,
    [empresaId, idsTocados]
  );
}

// Monta os dados calculados (motor + motivo) de TODOS os produtos base
// ativos de uma empresa, de uma vez — reaproveitado tanto pelo ciclo
// automático (que só persiste os que viram recomendação) quanto pela rota
// de leitura ao vivo da tela (que mostra TODOS, incluindo saudável/atenção),
// pra nunca existir dois cálculos diferentes pro mesmo número.
async function montarLinhasParaEmpresa(empresaId, { agora = new Date() } = {}) {
  const produtosBase = await buscarProdutosBaseAtivos(empresaId);
  if (!produtosBase.length) return [];

  const [estoqueFisico, vendas] = await Promise.all([
    calcularEstoqueFisico(empresaId),
    buscarVendasPorJanelas(empresaId, agora),
  ]);

  const galpaoPorCodigo = new Map(estoqueFisico.foraDoFull.produtosBase.map((p) => [p.produtoBase, p.quantidadeFisica]));
  const fullPorCodigo = new Map(estoqueFisico.full.produtosBase.map((p) => [p.produtoBase, p.quantidadeFisica]));

  return produtosBase.map((produtoBase) => {
    const estoqueGalpao = galpaoPorCodigo.get(produtoBase.codigo) || 0;
    const estoqueFull = fullPorCodigo.get(produtoBase.codigo) || 0;
    const venda7d = vendas.v7.get(produtoBase.codigo) || 0;
    const venda14d = vendas.v14.get(produtoBase.codigo) || 0;
    const venda30d = vendas.v30.get(produtoBase.codigo) || 0;

    const calc = calcularStatusEnvioFull({
      estoqueGalpao, estoqueFull,
      venda7d, venda14d, venda30d,
      prazoEnvioFullDiasConfigurado: produtoBase.prazo_envio_full_dias,
      estoqueSegurancaDiasConfigurado: produtoBase.estoque_seguranca_dias,
      agora,
    });

    return { produtoBase, calc, motivo: montarMotivo(calc) };
  });
}

async function executarCicloEnvioFullEmpresa(empresaId, { agora = new Date() } = {}) {
  const empresaRow = await pool.query('SELECT id FROM empresas WHERE id = $1 AND ativo = TRUE', [empresaId]);
  if (!empresaRow.rows.length) return { empresaId, ignorado: true };

  const linhas = await montarLinhasParaEmpresa(empresaId, { agora });
  if (!linhas.length) return { empresaId, produtosAnalisados: 0, recomendacoesGeradas: 0 };

  const idsTocados = [];
  let recomendacoesGeradas = 0;

  for (const { produtoBase, calc, motivo } of linhas) {
    if (!STATUS_QUE_GERAM_RECOMENDACAO.has(calc.status) || calc.quantidadeSugeridaEnvio <= 0) continue;

    const { id } = await upsertRecomendacao({ empresaId, produtoBase, calc, motivo });
    idsTocados.push(id);
    recomendacoesGeradas++;
  }

  try {
    await expirarNaoTocadas(empresaId, idsTocados);
  } catch (err) {
    console.error(`[Envio Full][ciclo] falha ao expirar recomendações antigas da empresa ${empresaId}: ${err.message}`);
  }

  return { empresaId, produtosAnalisados: linhas.length, recomendacoesGeradas };
}

async function executarCicloEnvioFull() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloEnvioFullEmpresa(e.id)));
  const comErro = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      comErro.push({ empresaId: empresas[i].id, erro: String((r.reason && r.reason.message) || r.reason) });
      console.error(`[Envio Full][ciclo] empresa ${empresas[i].id} falhou: ${comErro[comErro.length - 1].erro}`);
    }
  });
  return { empresasProcessadas: empresas.length, comErro };
}

module.exports = {
  executarCicloEnvioFullEmpresa,
  executarCicloEnvioFull,
  montarLinhasParaEmpresa,
};
