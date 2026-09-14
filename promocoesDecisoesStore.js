// Grava/atualiza as sugestões do agente de IA "Promoções" em
// ia_decisoes_promocoes — Fase 1 (14/09/2026). Ver lib/ia/promocoesDecisor.js
// para a regra que decide a sugestão, e lib/ia/promocoesCiclo.js (ciclo
// automático a cada 1h) para quem chama isto. Mesmo padrão de
// lib/ia/adsDecisoesCiclo.js: uma decisão "pendente" por item, nunca
// duplica; se o usuário já decidiu, uma situação nova abre uma linha nova.
// NUNCA chama a API do Mercado Livre.
const pool = require('../../db/pool');
const { sugerirAcaoPromocao } = require('./promocoesDecisor');

const DIAS_PARA_AVALIAR_RESULTADO = Number(process.env.IA_DECISOES_DIAS_AVALIACAO) || 5;

async function upsertDecisaoPromocao(linha, sugestao) {
  const existente = await pool.query(
    `SELECT id FROM ia_decisoes_promocoes
      WHERE conta_id = $1 AND promotion_id = $2 AND ml_item_id = $3 AND status_decisao = 'pendente'`,
    [linha.contaId, linha.promotionId, linha.mlItemId]
  );

  if (existente.rows.length) {
    const id = existente.rows[0].id;
    await pool.query(
      `UPDATE ia_decisoes_promocoes SET
         titulo = $1, sku = $2, motivo = $3,
         snapshot_preco_normal = $4, snapshot_preco_promo = $5, snapshot_desconto_pct = $6,
         snapshot_custo_produto = $7, snapshot_tarifas_estimadas = $8, snapshot_frete_vendedor_estimado = $9,
         snapshot_imposto_estimado = $10, snapshot_margem_real = $11, snapshot_margem_real_pct = $12,
         valor_sugerido_ia = $13, atualizado_em = now()
       WHERE id = $14`,
      [
        linha.titulo || null, linha.sku || null, sugestao.motivo,
        linha.precoNormal, linha.precoPromo, linha.descontoPct,
        linha.custoProduto, linha.tarifasEstimadas, linha.freteVendedorEstimado, linha.impostoEstimado,
        linha.margemReal, linha.margemRealPct,
        JSON.stringify(sugestao.valorSugeridoIa || {}), id,
      ]
    );
    return id;
  }

  const { rows } = await pool.query(
    `INSERT INTO ia_decisoes_promocoes (
       empresa_id, conta_id, promotion_id, promotion_type, promotion_label, ml_item_id,
       titulo, sku, tipo_acao, motivo,
       snapshot_preco_normal, snapshot_preco_promo, snapshot_desconto_pct,
       snapshot_custo_produto, snapshot_tarifas_estimadas, snapshot_frete_vendedor_estimado, snapshot_imposto_estimado,
       snapshot_margem_real, snapshot_margem_real_pct, valor_sugerido_ia
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id`,
    [
      linha.empresaId, linha.contaId, linha.promotionId, linha.promotionType, linha.promotionLabel, linha.mlItemId,
      linha.titulo || null, linha.sku || null, sugestao.tipoAcao, sugestao.motivo,
      linha.precoNormal, linha.precoPromo, linha.descontoPct,
      linha.custoProduto, linha.tarifasEstimadas, linha.freteVendedorEstimado, linha.impostoEstimado,
      linha.margemReal, linha.margemRealPct, JSON.stringify(sugestao.valorSugeridoIa || {}),
    ]
  );
  return rows[0].id;
}

// Chamado uma vez por item analisado (ver lib/ia/promocoesCiclo.js). Nunca
// deixa uma falha aqui derrubar a análise principal que já foi gravada em
// promocoes_analises — o erro só é logado.
async function sincronizarDecisaoPromocao(linha) {
  const sugestao = sugerirAcaoPromocao(linha);
  if (!sugestao) return null;
  try {
    return await upsertDecisaoPromocao(linha, sugestao);
  } catch (err) {
    console.error(`[Promoções IA][decisões] falha ao gravar sugestão (conta ${linha.contaId}, item ${linha.mlItemId}): ${err.message}`);
    return null;
  }
}

async function expirarDecisoesPromocaoNaoTocadas(contaId, idsTocados) {
  if (!idsTocados.length) {
    await pool.query(
      `UPDATE ia_decisoes_promocoes SET status_decisao = 'expirada', atualizado_em = now()
        WHERE conta_id = $1 AND status_decisao = 'pendente'`,
      [contaId]
    );
    return;
  }
  await pool.query(
    `UPDATE ia_decisoes_promocoes SET status_decisao = 'expirada', atualizado_em = now()
      WHERE conta_id = $1 AND status_decisao = 'pendente' AND id <> ALL($2::int[])`,
    [contaId, idsTocados]
  );
}

// Preenche `resultado_snapshot` de decisões já decididas (aprovada/alterada)
// há pelo menos DIAS_PARA_AVALIAR_RESULTADO dias e ainda não avaliadas —
// pedido explícito do usuário ("depois analisamos o resultado da
// promoção"). `linhasPorChave` é um Map(contaId::promotionId::mlItemId ->
// linha) com o que já foi calculado neste mesmo ciclo (nunca uma chamada
// extra à API).
async function avaliarResultadosPromocoes(empresaId, linhasPorChave) {
  const { rows: pendentesAvaliacao } = await pool.query(
    `SELECT id, conta_id, promotion_id, ml_item_id FROM ia_decisoes_promocoes
      WHERE empresa_id = $1 AND status_decisao IN ('aprovada','alterada')
        AND resultado_avaliado_em IS NULL
        AND decidido_em <= now() - ($2 || ' days')::interval`,
    [empresaId, DIAS_PARA_AVALIAR_RESULTADO]
  );
  if (!pendentesAvaliacao.length) return;

  for (const row of pendentesAvaliacao) {
    const atual = linhasPorChave.get(row.conta_id + '::' + row.promotion_id + '::' + row.ml_item_id);
    if (!atual) continue; // item já não está mais em nenhuma promoção rodando — avalia num ciclo futuro
    const resultado = {
      precoPromo: atual.precoPromo ?? null,
      margemReal: atual.margemReal ?? null,
      margemRealPct: atual.margemRealPct ?? null,
      classificacaoCodigo: atual.classificacaoCodigo ?? null,
      avaliadoEm: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE ia_decisoes_promocoes SET resultado_snapshot = $1, resultado_avaliado_em = now() WHERE id = $2`,
      [JSON.stringify(resultado), row.id]
    );
  }
}

module.exports = { sincronizarDecisaoPromocao, expirarDecisoesPromocaoNaoTocadas, avaliarResultadosPromocoes };
