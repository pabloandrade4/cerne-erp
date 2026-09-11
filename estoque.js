// Tela Estoque — estoque disponível FORA do Full, direto dos anúncios do
// Mercado Livre (pedido explícito do usuário: ele faz todos os lançamentos
// e ajustes de estoque no Mercado Livre, o ERP nunca mais aceita ajuste
// manual aqui). Somente leitura: lê o espelho gravado por
// lib/mlEstoque.js (tipo='proprio'), sincronizado automaticamente a cada 1
// minuto pelo mesmo ciclo de server/lib/syncScheduler.js — nunca busca ao
// vivo na API a cada carregamento de tela (por isso a coluna "última
// sincronização" faz sentido: é o horário em que aquele anúncio/variação
// foi verificado pela última vez).
//
// Mostra os itens de TODAS as contas do Mercado Livre da empresa (cada
// linha carrega sua própria loja/conta — nunca mistura entre empresas,
// sempre filtrado por empresa_id). Se a empresa não tiver nenhuma conta
// ativa no momento, os itens já sincronizados continuam aparecendo (dado
// real, não inventado) com um aviso de que podem estar desatualizados —
// nunca escondidos.
//
// Nunca inventa: quando a API não retornou a quantidade de um item,
// `estoqueDisponivel` vem `null` e `pendente: true` (ver lib/mlEstoque.js).
const express = require('express');
const pool = require('../db/pool');
const { sincronizarEstoqueConta } = require('../lib/mlEstoque');

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

async function buscarPorTipo(empresaId, tipo) {
  const { rows: contas } = await pool.query(
    `SELECT id, nickname, status FROM ml_contas WHERE empresa_id = $1 ORDER BY created_at DESC`,
    [empresaId]
  );
  const contasAtivas = contas.filter((c) => c.status === 'ativa');

  const { rows: itens } = await pool.query(
    `SELECT * FROM ml_estoque_itens WHERE empresa_id = $1 AND tipo = $2 ORDER BY titulo NULLS LAST, sku NULLS LAST`,
    [empresaId, tipo]
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
    mensagem = 'Nenhuma conta do Mercado Livre conectada para esta empresa. Conecte em Marketplaces para ver o estoque aqui.';
  } else if (!contasAtivas.length) {
    pendente = true;
    motivo = 'conta_com_erro';
    mensagem = 'Nenhuma conta ativa no momento — os itens abaixo (se houver) são da última sincronização e podem estar desatualizados. Reconecte em Marketplaces.';
  } else if (!itens.length) {
    pendente = true;
    motivo = 'aguardando_primeira_sincronizacao';
    mensagem = 'Ainda não há dados sincronizados. A sincronização automática roda a cada 1 minuto — ou clique em "Sincronizar agora".';
  }

  return {
    pendente,
    motivo,
    mensagem,
    contas: contas.map((c) => ({ id: c.id, nickname: c.nickname, status: c.status })),
    itens: itens.map(serializeItem),
    ultimaSincronizacaoGeral,
  };
}

// GET /api/estoque?empresaId=ID — aba "Estoque" (fora do Full).
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    res.json(await buscarPorTipo(empresaId, 'proprio'));
  } catch (err) { next(err); }
});

// POST /api/estoque/sincronizar { empresaId } — botão "Sincronizar agora"
// (opção de emergência; a sincronização automática de 1 em 1 minuto já
// cobre o caso normal). Sincroniza estoque (Full + fora do Full, mesma
// varredura) de TODAS as contas ativas da empresa, isoladamente — uma
// conta falhando não impede as demais.
router.post('/sincronizar', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: contas } = await pool.query(
      `SELECT id FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa'`,
      [empresaId]
    );
    if (!contas.length) {
      return res.status(400).json({ error: 'Nenhuma conta ativa do Mercado Livre para esta empresa.' });
    }

    const resultados = await Promise.allSettled(contas.map((c) => sincronizarEstoqueConta(c.id)));
    const erros = [];
    resultados.forEach((r, i) => {
      if (r.status === 'rejected') erros.push({ contaId: contas[i].id, erro: (r.reason && r.reason.message) || String(r.reason) });
    });

    res.json({
      ok: erros.length === 0,
      contasSincronizadas: contas.length - erros.length,
      contasComErro: erros,
    });
  } catch (err) { next(err); }
});

module.exports = router;
