// Avisos por WhatsApp (Twilio) — pedido explícito do usuário em 11/09/2026.
// Router bem fino: quem manda de verdade é lib/whatsapp.js, disparado
// automaticamente pelo ciclo do Radar da IA (lib/ia/radar.js#notificarWhatsapp)
// — esta rota NUNCA dispara um aviso de alerta de verdade, só serve pra (1)
// a tela/o próprio usuário conferirem se o Twilio já está configurado neste
// ambiente e (2) mandar uma mensagem de teste avulsa, sem precisar esperar
// o Radar detectar algo.
const express = require('express');
const { whatsappConfigurado, whatsappModeloAprovadoConfigurado, enviarMensagemWhatsapp } = require('../lib/whatsapp');

const router = express.Router();

// GET /api/integracoes/whatsapp/status — se TWILIO_ACCOUNT_SID/AUTH_TOKEN/
// WHATSAPP_FROM/WHATSAPP_TO já foram configurados neste ambiente (nunca
// devolve os valores em si, só se existem). `modeloAprovado` (14/09/2026):
// se TWILIO_WHATSAPP_CONTENT_SID também já foi configurado — quando true, o
// envio funciona a qualquer hora, sem depender da janela de 24h do WhatsApp
// (ver comentário em lib/whatsapp.js).
router.get('/status', (req, res) => {
  res.json({ configurado: whatsappConfigurado(), modeloAprovado: whatsappModeloAprovadoConfigurado() });
});

// GET /api/integracoes/whatsapp/testar — manda uma mensagem de teste pro
// número configurado em TWILIO_WHATSAPP_TO. É GET (em vez de POST) de
// propósito, pra dar pra testar só abrindo o link no navegador — mesmo
// espírito de conveniência já usado em GET /api/integracoes/shopee/conectar.
router.get('/testar', async (req, res) => {
  if (!whatsappConfigurado()) {
    return res.status(400).json({ enviado: false, motivo: 'nao_configurado', mensagem: 'Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM e TWILIO_WHATSAPP_TO nas variáveis de ambiente do servidor antes de testar.' });
  }
  const resultado = await enviarMensagemWhatsapp('✅ Teste do PF Embalagens: se você recebeu esta mensagem, os avisos automáticos do Radar da IA (Financeiro, Estoque, Ads, Margem) vão chegar por aqui a partir de agora.');
  res.status(resultado.enviado ? 200 : 502).json(resultado);
});

module.exports = router;
