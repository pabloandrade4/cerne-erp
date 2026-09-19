// Tela Estoque Full — quantidade armazenada no Full do Mercado Livre,
// separada explicitamente da aba Estoque (fora do Full — ver routes/estoque.js).
// Nunca soma nem mistura os dois saldos: cada linha aqui vem só de itens com
// logistic_type='fulfillment' (mesmo critério de lib/mlFull.js/lib/mlEstoque.js).
//
// Somente leitura, lida do espelho gravado por lib/mlEstoque.js
// (tipo='full'), sincronizado automaticamente a cada 1 minuto pelo mesmo
// ciclo de server/lib/syncScheduler.js — não busca mais ao vivo na API a
// cada carregamento (diferente da versão anterior desta tela).
//
// `fisico` (19/09/2026) — pedido explícito do usuário: a tela não deve mais
// mostrar os anúncios "crus" como visão principal; em vez disso, mostrar o
// valor em R$, a quantidade em caixas e a quebra por modelo (produto base) e
// por SKU/anúncio, tudo separado. Em vez de inventar uma conta nova, reusa
// lib/estoqueFisico.js#calcularEstoqueFisico — módulo já existente (criado
// para a IA Gestora, ver seu cabeçalho) que já faz exatamente essa conversão
// kit→físico e a soma a custo, só que ainda não estava ligado a nenhuma rota
// HTTP nem tela. `itens` (cru, por anúncio) continua sendo devolvido sem
// mudança nenhuma, para não quebrar nada que já lê esta rota — `fisico` é um
// campo NOVO e aditivo.
const express = require('express');
const pool = require('../db/pool');
const { calcularEstoqueFisico } = require('../lib/estoqueFisico');

const router = express.Router();

function serializeItem(row) {
  return {
    id: row.id,
    contaId: row.conta_ml_id,
    loja: row.loja,
    mlItemId: row.ml_item_id,
    mlVariationId: row.ml_variation_id,
    produto: row.titulo,
    sku: row.sku,
    estoqueDisponivel: row.pendente ? null : (row.quantidade === null ? null : Number(row.quantidade)),
    pendente: row.pendente,
    motivoPendencia: row.motivo_pendencia,
    status: row.status,
    ultimaSincronizacao: row.sincronizado_em,
  };
}

// GET /api/estoque-full?empresaId=ID — aba "Estoque Full".
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: contas } = await pool.query(
      `SELECT id, nickname, status FROM ml_contas WHERE empresa_id = $1 ORDER BY created_at DESC`,
      [empresaId]
    );
    const contasAtivas = contas.filter((c) => c.status === 'ativa');

    const { rows: itens } = await pool.query(
      `SELECT * FROM ml_estoque_itens WHERE empresa_id = $1 AND tipo = 'full' ORDER BY titulo NULLS LAST, sku NULLS LAST`,
      [empresaId]
    );

    const ultimaSincronizacaoGeral = itens.reduce((max, it) => {
      if (!it.sincronizado_em) return max;
      return !max || it.sincronizado_em > max ? it.sincronizado_em : max;
    }, null);

    let pendente = false;
    let motivo = null;
    let mensagem = null;
    if (!contas.length) {
      pendente = true;
      motivo = 'sem_conta';
      mensagem = 'Nenhuma conta do Mercado Livre conectada para esta empresa. Conecte em Marketplaces para ver o estoque Full aqui.';
    } else if (!contasAtivas.length) {
      pendente = true;
      motivo = 'conta_com_erro';
      mensagem = 'Nenhuma conta ativa no momento — os itens abaixo (se houver) são da última sincronização e podem estar desatualizados. Reconecte em Marketplaces.';
    } else if (!itens.length) {
      pendente = true;
      motivo = 'aguardando_primeira_sincronizacao';
      mensagem = 'Ainda não há dados sincronizados (ou esta conta não tem nenhum anúncio no Full). A sincronização automática roda a cada 1 minuto — ou clique em "Sincronizar agora".';
    }

    const estoqueFisico = await calcularEstoqueFisico(empresaId);

    res.json({
      pendente,
      motivo,
      mensagem,
      contas: contas.map((c) => ({ id: c.id, nickname: c.nickname, status: c.status })),
      itens: itens.map(serializeItem),
      ultimaSincronizacaoGeral,
      fisico: estoqueFisico.full,
    });
  } catch (err) { next(err); }
});

module.exports = router;
