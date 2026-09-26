// Devoluções — 26/09/2026, pedido explícito do usuário: entender "oque é
// devolção e oque é cancelamento de pedido". Só leitura + sincronizar —
// nunca aceita/recusa nada aqui (isso continua sendo feito direto no
// Mercado Livre/Shopee).
const express = require('express');
const pool = require('../db/pool');
const { executarCicloDevolucoesEmpresa } = require('../lib/devolucoes');

const router = express.Router();

function serializeDevolucao(row) {
  return {
    id: row.id,
    marketplace: row.marketplace,
    idExterno: row.id_externo,
    pedidoRef: row.pedido_ref,
    status: row.status,
    motivo: row.motivo,
    valorReembolsado: row.valor_reembolsado === null ? null : Number(row.valor_reembolsado),
    dataCriacao: row.data_criacao,
    dataConclusao: row.data_conclusao,
    sincronizadoEm: row.sincronizado_em,
  };
}

// GET /api/devolucoes/resumo?empresaId=&desde=&ate= — contagem/valor por
// status, dentro do período (por data_criacao da devolução, não do pedido).
router.get('/resumo', async (req, res, next) => {
  try {
    const { empresaId, desde, ate } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtroData = '';
    if (desde && ate) { params.push(desde, ate); filtroData = ' AND data_criacao >= $2 AND data_criacao < $3'; }

    const { rows } = await pool.query(
      `SELECT status, count(*) AS quantidade, COALESCE(SUM(valor_reembolsado),0) AS valor_reembolsado_soma,
              count(*) FILTER (WHERE valor_reembolsado IS NULL) AS sem_valor_confirmado
         FROM pedido_devolucoes
        WHERE empresa_id = $1 ${filtroData}
        GROUP BY status`,
      params
    );
    const porStatus = Object.fromEntries(rows.map((r) => [r.status, {
      quantidade: Number(r.quantidade),
      valorReembolsado: Number(r.valor_reembolsado_soma),
      semValorConfirmado: Number(r.sem_valor_confirmado),
    }]));
    res.json({
      abertas: porStatus.aberta || { quantidade: 0, valorReembolsado: 0, semValorConfirmado: 0 },
      confirmadas: porStatus.confirmada || { quantidade: 0, valorReembolsado: 0, semValorConfirmado: 0 },
      negadasOuCanceladas: porStatus.negada_ou_cancelada || { quantidade: 0, valorReembolsado: 0, semValorConfirmado: 0 },
    });
  } catch (err) { next(err); }
});

// GET /api/devolucoes/lista?empresaId=&status= — histórico pra uma tela.
router.get('/lista', async (req, res, next) => {
  try {
    const { empresaId, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtro = '';
    if (status && ['aberta', 'confirmada', 'negada_ou_cancelada'].includes(status)) { params.push(status); filtro = ' AND status = $2'; }
    const { rows } = await pool.query(
      `SELECT * FROM pedido_devolucoes WHERE empresa_id = $1 ${filtro} ORDER BY data_criacao DESC NULLS LAST LIMIT 300`,
      params
    );
    res.json({ devolucoes: rows.map(serializeDevolucao) });
  } catch (err) { next(err); }
});

// POST /api/devolucoes/sincronizar-agora { empresaId }
router.post('/sincronizar-agora', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await executarCicloDevolucoesEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
