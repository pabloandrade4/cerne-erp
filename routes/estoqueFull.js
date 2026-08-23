// Estoque Full — anúncios com logística "fulfillment" (Full) das contas do
// Mercado Livre conectadas, com a quantidade real no centro de distribuição
// quando a API disponibilizar. Visualização ao vivo, sem tabela no banco —
// mesmo padrão de routes/anuncios.js. Nunca inventa: se a empresa não tiver
// conta conectada, se a conexão estiver com erro, ou se a API falhar, a
// resposta diz isso explicitamente (`pendente: true` + motivo).
const express = require('express');
const pool = require('../db/pool');
const { buscarEstoqueFullDaConta } = require('../lib/mlFull');

const router = express.Router();

// GET /api/estoque-full?empresaId=ID&offset=0&limit=50
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, offset, limit } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: contas } = await pool.query(
      `SELECT * FROM ml_contas WHERE empresa_id = $1 ORDER BY created_at DESC`,
      [empresaId]
    );

    if (!contas.length) {
      return res.json({
        pendente: true,
        motivo: 'sem_conta',
        mensagem: 'Nenhuma conta do Mercado Livre conectada para esta empresa. Conecte em Marketplaces para ver o estoque Full aqui.',
        itens: [],
        verificados: 0,
        totalContaGeral: 0,
      });
    }

    const conta = contas[0];
    if (conta.status !== 'ativa') {
      return res.json({
        pendente: true,
        motivo: 'conta_com_erro',
        mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada. Reconecte em Marketplaces para ver o estoque Full aqui.',
        conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
        itens: [],
        verificados: 0,
        totalContaGeral: 0,
      });
    }

    try {
      const resultado = await buscarEstoqueFullDaConta(conta.id, {
        offset: Number(offset) || 0,
        limit: Math.min(Number(limit) || 50, 100),
      });
      res.json({
        pendente: false,
        conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
        ...resultado,
      });
    } catch (err) {
      res.json({
        pendente: true,
        motivo: 'erro_api',
        mensagem: 'Não foi possível buscar o estoque Full agora (' + (err.message || 'erro na API do Mercado Livre') + '). Tente novamente em instantes.',
        conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
        itens: [],
        verificados: 0,
        totalContaGeral: 0,
      });
    }
  } catch (err) { next(err); }
});

module.exports = router;
