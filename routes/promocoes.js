// Central de Promoções (Mercado Livre) — primeira etapa (12/09/2026):
// SÓ DIAGNÓSTICO. Não aplica, entra ou sai de nenhuma promoção — só
// consulta o que a API do Mercado Livre devolve de verdade pras contas já
// conectadas, pra sabermos (a) se o aplicativo já tem permissão pra essa
// API e (b) qual é o formato real dos dados, antes de desenhar qualquer
// automação em cima (mesma lição já aprendida neste projeto com a API de
// Ads: nunca desenhar automação em cima de um formato adivinhado).
const express = require('express');
const pool = require('../db/pool');
const { decrypt } = require('../lib/crypto');
const { getContaComTokenValido } = require('../lib/mlSync');
const { buscarPromocoesDaConta } = require('../lib/mlPromocoes');

const router = express.Router();

// POST /api/promocoes/diagnostico  { empresaId }
// Roda pra cada conta ATIVA do Mercado Livre da empresa, grava o resultado
// completo (sucesso ou erro real da API) no log do servidor — prefixado
// "[Promoções][diagnóstico]" pra achar fácil nos logs do Render — e também
// devolve na resposta, pra conseguir ver direto sem precisar abrir o log.
router.post('/diagnostico', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: contas } = await pool.query(
      "SELECT * FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY nickname",
      [empresaId]
    );

    if (!contas.length) {
      return res.json({ contas: [], mensagem: 'Nenhuma conta do Mercado Livre ativa para esta empresa.' });
    }

    const resultados = [];
    for (const conta of contas) {
      let linha = { contaId: conta.id, loja: conta.nickname, mlUserId: conta.ml_user_id };
      try {
        const contaComTokenValido = await getContaComTokenValido(conta.id);
        const accessToken = decrypt(contaComTokenValido.access_token_enc);
        const resultado = await buscarPromocoesDaConta(accessToken, conta.ml_user_id);
        linha = { ...linha, ...resultado };
      } catch (e) {
        linha.ok = false;
        linha.erro = e.message || 'Falha ao obter token válido desta conta.';
      }
      console.log('[Promoções][diagnóstico] conta=' + conta.id + ' (' + conta.nickname + '):', JSON.stringify(linha));
      resultados.push(linha);
    }

    res.json({ contas: resultados });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
