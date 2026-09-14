// Orquestrador do agente de IA "Ads e Performance" — Fase 1 (14/09/2026),
// pedido explícito do usuário: transforma a classificação que a tela de
// Ads já mostra (lib/ia/adsMotor.js) em sugestões de ação concretas
// (lib/ia/adsDecisor.js), gravando/atualizando cada uma em ia_decisoes_ads
// pra o usuário aprovar, alterar ou recusar (ver routes/ads.js#/decisoes).
//
// NUNCA chama a API do Mercado Livre — só lê o que já foi sincronizado em
// background (lib/ads.js/lib/adsScheduler.js) e grava a sugestão. Chamado
// automaticamente ao final de cada ciclo de sincronização de Ads (ver
// lib/adsScheduler.js), mesmo padrão de lib/ia/promocoesCiclo.js.
//
// Cada situação (um anúncio, ou uma campanha) mantém NO MÁXIMO uma decisão
// "pendente" por vez (ver índice único parcial em db/schema.sql) — se a
// mesma situação persistir de um ciclo pro outro, só atualiza os números
// (snapshot/valor sugerido) da linha já existente; se o usuário já decidiu,
// uma NOVA situação abre uma linha NOVA — o histórico nunca é sobrescrito.
// Se uma decisão pendente deixar de fazer sentido (a situação que a gerou
// não aparece mais no ciclo atual), ela é marcada "expirada" — nunca
// apagada.
const pool = require('../../db/pool');
const { calcularPeriodo, periodoParaDatasBRT } = require('../periodo');
const { listarAds } = require('../ads');
const { classificarLinhasEAgregarCampanhas } = require('./adsMotor');
const { sugerirAcaoAnuncio, sugerirEntrarEmCampanha, sugerirAcaoCampanha } = require('./adsDecisor');

const PERIODO_CHAVE_PADRAO = '30d'; // mesma janela padrão da tela de Ads
const DIAS_PARA_AVALIAR_RESULTADO = Number(process.env.IA_DECISOES_DIAS_AVALIACAO) || 5;

async function buscarMargemMinima(empresaId) {
  const { rows } = await pool.query('SELECT margem_minima_pct FROM config_ads_ia WHERE empresa_id = $1', [empresaId]);
  return rows.length ? Number(rows[0].margem_minima_pct) : 10;
}

async function buscarCampanhasPorNome(contaIds) {
  if (!contaIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT conta_id, campanha_id, nome, orcamento_diario, acos_alvo, status_campanha
       FROM ads_campanhas WHERE conta_id = ANY($1)`,
    [contaIds]
  );
  const mapa = new Map();
  rows.forEach((r) => {
    if (!r.nome) return;
    mapa.set(r.conta_id + '::' + r.nome, {
      campanhaId: r.campanha_id,
      orcamentoDiario: r.orcamento_diario === null ? null : Number(r.orcamento_diario),
      acosAlvo: r.acos_alvo === null ? null : Number(r.acos_alvo),
      statusCampanha: r.status_campanha,
    });
  });
  return mapa;
}

async function buscarDecisaoPendente({ contaId, tipoReferencia, mlItemId, campanhaId, tipoAcao }) {
  const { rows } = await pool.query(
    `SELECT id FROM ia_decisoes_ads
      WHERE conta_id = $1 AND tipo_referencia = $2
        AND COALESCE(ml_item_id,'') = COALESCE($3,'')
        AND COALESCE(campanha_id,'') = COALESCE($4,'')
        AND tipo_acao = $5
        AND status_decisao = 'pendente'`,
    [contaId, tipoReferencia, mlItemId || null, campanhaId || null, tipoAcao]
  );
  return rows.length ? rows[0].id : null;
}

async function upsertDecisaoAds(campo) {
  const s = campo.snapshot || {};
  const idExistente = await buscarDecisaoPendente(campo);

  if (idExistente) {
    await pool.query(
      `UPDATE ia_decisoes_ads SET
         campanha_nome = $1, sku = $2, titulo = $3, motivo = $4,
         snapshot_investimento = $5, snapshot_faturamento_real = $6, snapshot_roas = $7, snapshot_acos = $8,
         snapshot_margem_antes_ads = $9, snapshot_margem_depois_ads = $10, snapshot_margem_depois_ads_pct = $11,
         snapshot_qtd_vendas = $12, snapshot_orcamento_atual = $13, snapshot_acos_alvo_atual = $14,
         valor_sugerido_ia = $15, atualizado_em = now()
       WHERE id = $16`,
      [
        campo.campanhaNome || null, campo.sku || null, campo.titulo || null, campo.motivo,
        s.investimento ?? null, s.faturamentoReal ?? null, s.roas ?? null, s.acos ?? null,
        s.margemAntesDoAds ?? null, s.margemDepoisDoAds ?? null, s.margemDepoisDoAdsPct ?? null,
        s.qtdVendas ?? null, s.orcamentoAtual ?? null, s.acosAlvoAtual ?? null,
        JSON.stringify(campo.valorSugeridoIa || {}), idExistente,
      ]
    );
    return idExistente;
  }

  const { rows } = await pool.query(
    `INSERT INTO ia_decisoes_ads (
       empresa_id, conta_id, tipo_referencia, ml_item_id, campanha_id, campanha_nome, sku, titulo,
       tipo_acao, motivo,
       snapshot_investimento, snapshot_faturamento_real, snapshot_roas, snapshot_acos,
       snapshot_margem_antes_ads, snapshot_margem_depois_ads, snapshot_margem_depois_ads_pct, snapshot_qtd_vendas,
       snapshot_orcamento_atual, snapshot_acos_alvo_atual, valor_sugerido_ia
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id`,
    [
      campo.empresaId, campo.contaId, campo.tipoReferencia, campo.mlItemId || null, campo.campanhaId || null,
      campo.campanhaNome || null, campo.sku || null, campo.titulo || null, campo.tipoAcao, campo.motivo,
      s.investimento ?? null, s.faturamentoReal ?? null, s.roas ?? null, s.acos ?? null,
      s.margemAntesDoAds ?? null, s.margemDepoisDoAds ?? null, s.margemDepoisDoAdsPct ?? null, s.qtdVendas ?? null,
      s.orcamentoAtual ?? null, s.acosAlvoAtual ?? null,
      JSON.stringify(campo.valorSugeridoIa || {}),
    ]
  );
  return rows[0].id;
}

async function expirarNaoTocadas(contaId, idsTocados) {
  if (!idsTocados.length) {
    await pool.query(
      `UPDATE ia_decisoes_ads SET status_decisao = 'expirada', atualizado_em = now()
        WHERE conta_id = $1 AND status_decisao = 'pendente'`,
      [contaId]
    );
    return;
  }
  await pool.query(
    `UPDATE ia_decisoes_ads SET status_decisao = 'expirada', atualizado_em = now()
      WHERE conta_id = $1 AND status_decisao = 'pendente' AND id <> ALL($2::int[])`,
    [contaId, idsTocados]
  );
}

// Preenche `resultado_snapshot` de decisões já decididas (aprovada/alterada)
// há pelo menos DIAS_PARA_AVALIAR_RESULTADO dias e ainda não avaliadas —
// pedido explícito do usuário ("resultado depois da alteração"). Reaproveita
// os números já lidos neste mesmo ciclo (nunca uma chamada extra à API).
async function avaliarResultadosAds(empresaId, linhasComClassificacao, campanhas) {
  const { rows: pendentesAvaliacao } = await pool.query(
    `SELECT id, tipo_referencia, ml_item_id, campanha_nome, conta_id
       FROM ia_decisoes_ads
      WHERE empresa_id = $1 AND status_decisao IN ('aprovada','alterada')
        AND resultado_avaliado_em IS NULL
        AND decidido_em <= now() - ($2 || ' days')::interval`,
    [empresaId, DIAS_PARA_AVALIAR_RESULTADO]
  );
  if (!pendentesAvaliacao.length) return;

  const porItemId = new Map(linhasComClassificacao.map((l) => [l.mlItemId, l]));
  const porCampanha = new Map((campanhas || []).map((c) => [c.contaMlId + '::' + c.campanha, c]));

  for (const row of pendentesAvaliacao) {
    let atual = null;
    if (row.tipo_referencia === 'anuncio' && row.ml_item_id) atual = porItemId.get(row.ml_item_id) || null;
    else if (row.tipo_referencia === 'campanha' && row.campanha_nome) atual = porCampanha.get(row.conta_id + '::' + row.campanha_nome) || null;
    if (!atual) continue; // anúncio/campanha não aparece mais neste ciclo — avalia num ciclo futuro

    const resultado = {
      investimento: atual.investimento ?? null,
      faturamentoReal: atual.faturamentoReal ?? null,
      margemDepoisDoAds: atual.margemDepoisDoAds ?? null,
      margemDepoisDoAdsPct: atual.margemDepoisDoAdsPct ?? null,
      avaliadoEm: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE ia_decisoes_ads SET resultado_snapshot = $1, resultado_avaliado_em = now() WHERE id = $2`,
      [JSON.stringify(resultado), row.id]
    );
  }
}

async function executarCicloDecisoesAdsEmpresa(empresaId) {
  const empresaRow = await pool.query('SELECT id FROM empresas WHERE id = $1 AND ativo = TRUE', [empresaId]);
  if (!empresaRow.rows.length) return { empresaId, ignorado: true };

  const { rows: contas } = await pool.query(
    "SELECT id FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY id",
    [empresaId]
  );
  if (!contas.length) return { empresaId, contasProcessadas: 0, decisoesGeradas: 0 };
  const contaIdsAtivas = new Set(contas.map((c) => c.id));

  const margemMinimaPct = await buscarMargemMinima(empresaId);

  const periodoCalc = calcularPeriodo(PERIODO_CHAVE_PADRAO);
  const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);
  const hojeCalc = calcularPeriodo('hoje');
  const { desde: hojeStr } = periodoParaDatasBRT(hojeCalc);
  const mesCalc = calcularPeriodo('mes');
  const { desde: mesDesdeStr, ate: mesAteStr } = periodoParaDatasBRT(mesCalc);

  let resultado;
  try {
    resultado = await listarAds({
      empresaId, contaId: null, periodoChave: periodoCalc.chave,
      desde: periodoCalc.desde, ate: periodoCalc.ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr,
    });
  } catch (err) {
    console.error(`[Ads IA][decisões] falha ao ler dados de Ads da empresa ${empresaId}: ${err.message}`);
    return { empresaId, erro: err.message };
  }
  if (resultado.semConta || !resultado.linhas) return { empresaId, contasProcessadas: contas.length, decisoesGeradas: 0 };

  const { linhas: linhasComClassificacao, campanhas } = classificarLinhasEAgregarCampanhas(resultado.linhas, margemMinimaPct);
  const campanhasPorNome = await buscarCampanhasPorNome([...contaIdsAtivas]);

  const idsTocadosPorConta = new Map();
  contaIdsAtivas.forEach((id) => idsTocadosPorConta.set(id, []));

  for (const linha of linhasComClassificacao) {
    if (!linha.contaMlId || !idsTocadosPorConta.has(linha.contaMlId)) continue;
    const sugestao = sugerirAcaoAnuncio({ linha }) || sugerirEntrarEmCampanha({ linha });
    if (!sugestao) continue;

    const snapshot = {
      investimento: linha.investimento, faturamentoReal: linha.faturamentoReal, roas: linha.roas, acos: linha.acos,
      margemAntesDoAds: linha.margemAntesDoAds, margemDepoisDoAds: linha.margemDepoisDoAds,
      margemDepoisDoAdsPct: linha.margemDepoisDoAdsPct, qtdVendas: linha.quantidadeVendidaReal,
    };
    const id = await upsertDecisaoAds({
      empresaId, contaId: linha.contaMlId, tipoReferencia: 'anuncio', mlItemId: linha.mlItemId,
      campanhaId: null, campanhaNome: linha.campanha || null, sku: linha.sku, titulo: linha.anuncio,
      tipoAcao: sugestao.tipoAcao, motivo: sugestao.motivo, snapshot, valorSugeridoIa: sugestao.valorSugeridoIa,
    });
    idsTocadosPorConta.get(linha.contaMlId).push(id);
  }

  for (const campanha of campanhas) {
    if (!campanha.contaMlId || !idsTocadosPorConta.has(campanha.contaMlId)) continue;
    const meta = campanhasPorNome.get(campanha.contaMlId + '::' + campanha.campanha) || null;
    const sugestao = sugerirAcaoCampanha({
      campanha, orcamentoAtual: meta ? meta.orcamentoDiario : null, statusCampanhaAtual: meta ? meta.statusCampanha : null,
    });
    if (!sugestao) continue;

    const snapshot = {
      investimento: campanha.investimento, faturamentoReal: campanha.faturamentoReal, roas: campanha.roas, acos: campanha.acos,
      margemDepoisDoAds: campanha.margemDepoisDoAds, margemDepoisDoAdsPct: campanha.margemDepoisDoAdsPct,
      orcamentoAtual: meta ? meta.orcamentoDiario : null, acosAlvoAtual: meta ? meta.acosAlvo : null,
    };
    const id = await upsertDecisaoAds({
      empresaId, contaId: campanha.contaMlId, tipoReferencia: 'campanha', mlItemId: null,
      campanhaId: meta ? meta.campanhaId : null, campanhaNome: campanha.campanha, sku: null, titulo: null,
      tipoAcao: sugestao.tipoAcao, motivo: sugestao.motivo, snapshot, valorSugeridoIa: sugestao.valorSugeridoIa,
    });
    idsTocadosPorConta.get(campanha.contaMlId).push(id);
  }

  let decisoesGeradas = 0;
  for (const [contaId, ids] of idsTocadosPorConta) {
    try {
      await expirarNaoTocadas(contaId, ids);
    } catch (err) {
      console.error(`[Ads IA][decisões] falha ao expirar decisões antigas da conta ${contaId}: ${err.message}`);
    }
    decisoesGeradas += ids.length;
  }

  try {
    await avaliarResultadosAds(empresaId, linhasComClassificacao, campanhas);
  } catch (err) {
    console.error(`[Ads IA][decisões] falha ao avaliar resultados da empresa ${empresaId}: ${err.message}`);
  }

  return { empresaId, contasProcessadas: contas.length, decisoesGeradas };
}

async function executarCicloDecisoesAds() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloDecisoesAdsEmpresa(e.id)));
  const comErro = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      comErro.push({ empresaId: empresas[i].id, erro: String((r.reason && r.reason.message) || r.reason) });
      console.error(`[Ads IA][decisões] empresa ${empresas[i].id} falhou: ${comErro[comErro.length - 1].erro}`);
    }
  });
  return { empresasProcessadas: empresas.length, comErro };
}

module.exports = { executarCicloDecisoesAdsEmpresa, executarCicloDecisoesAds };
