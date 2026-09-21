// Avisos por Telegram — alternativa ao WhatsApp (routes/whatsapp.js), pedida
// pelo usuário em 21/09/2026. Router bem fino: quem manda de verdade é
// lib/telegram.js, disparado automaticamente pelo Radar da IA
// (lib/ia/radar.js#notificarTelegram) e pela Daily dos Agentes
// (lib/ia/dailyCiclo.js#executarDailyComNotificacao) — mesmo padrão já usado
// pro WhatsApp, lado a lado (os dois podem ficar configurados ao mesmo
// tempo, ou só um dos dois — nenhum depende do outro).
const express = require('express');
const { telegramConfigurado, enviarMensagemTelegram, listarChatsRecentes } = require('../lib/telegram');

const router = express.Router();

// GET /api/integracoes/telegram/status — se TELEGRAM_BOT_TOKEN e
// TELEGRAM_CHAT_ID já foram configurados neste ambiente (nunca devolve os
// valores em si, só se existem).
router.get('/status', (req, res) => {
  res.json({ configurado: telegramConfigurado() });
});

// GET /api/integracoes/telegram/descobrir-chat-id — passo intermediário pra
// configurar: o usuário cria o bot, manda "oi" pra ele, e chama esta rota só
// com TELEGRAM_BOT_TOKEN já configurado (antes ainda de saber o CHAT_ID) —
// ela lê as mensagens recentes que o bot recebeu e devolve os chats
// encontrados, pra copiar o chatId certo.
router.get('/descobrir-chat-id', async (req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return res.status(400).json({ ok: false, motivo: 'nao_configurado', mensagem: 'Configure TELEGRAM_BOT_TOKEN nas variáveis de ambiente do servidor antes de usar esta rota.' });
  }
  const resultado = await listarChatsRecentes();
  if (!resultado.ok) return res.status(502).json(resultado);
  if (!resultado.chats.length) {
    return res.json({ ok: true, chats: [], mensagem: 'Nenhuma mensagem recebida ainda. Mande qualquer mensagem (ex: "oi") pro seu bot no Telegram e chame esta rota de novo.' });
  }
  res.json(resultado);
});

// GET /api/integracoes/telegram/testar — manda uma mensagem de teste pro
// chat configurado em TELEGRAM_CHAT_ID. Mesmo espírito de conveniência de
// GET /api/integracoes/whatsapp/testar (dá pra testar só abrindo o link no
// navegador).
router.get('/testar', async (req, res) => {
  if (!telegramConfigurado()) {
    return res.status(400).json({ enviado: false, motivo: 'nao_configurado', mensagem: 'Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nas variáveis de ambiente do servidor antes de testar.' });
  }
  const resultado = await enviarMensagemTelegram('✅ Teste do PF Embalagens: se você recebeu esta mensagem, os avisos automáticos do Radar da IA (Financeiro, Estoque, Ads, Margem) vão chegar por aqui a partir de agora.');
  res.status(resultado.enviado ? 200 : 502).json(resultado);
});

module.exports = router;
