// Anúncios (itens/listagens) das contas do Mercado Livre conectadas —
// visualização ao vivo, sem editar preço/estoque nesta etapa (pedido
// explícito do usuário: "Primeiro quero visualizar corretamente os
// anúncios"). Nada é gravado no banco aqui — cada carregamento busca direto
// na API do Mercado Livre. Nunca inventa anúncio: se a empresa não tiver
// conta conectada, se a conexão estiver com erro, ou se a API falhar, a
// resposta diz isso explicitamente (`pendente: true` + motivo) em vez de
// devolver uma lista vazia sem explicação.
const express = require('express');
const pool = require('../db/pool');
const { buscarAnunciosDaConta } = require('../lib/mlAnuncios');

const router = express.Router();

// GET /api/anuncios?empresaId=ID&offset=0&limit=50
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
        mensagem: 'Nenhuma conta do Mercado Livre conectada para esta empresa. Conecte em Marketplaces para ver os anúncios aqui.',
        itens: [],
        total: 0,
      });
    }

    const conta = contas[0];
    if (conta.status !== 'ativa') {
      return res.json({
        pendente: true,
        motivo: 'conta_com_erro',
        mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada. Reconecte em Marketplaces para ver os anúncios aqui.',
        conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
        itens: [],
        total: 0,
      });
    }

    try {
      const resultado = await buscarAnunciosDaConta(conta.id, {
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
        mensagem: 'Não foi possível buscar os anúncios agora (' + (err.message || 'erro na API do Mercado Livre') + '). Tente novamente em instantes.',
        conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
        itens: [],
        total: 0,
      });
    }
  } catch (err) { next(err); }
});

module.exports = router;
