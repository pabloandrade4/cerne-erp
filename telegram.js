// Envio de avisos por Telegram — alternativa ao WhatsApp (lib/whatsapp.js),
// pedida pelo usuário em 21/09/2026 depois de dificuldade real pra concluir
// a aprovação do modelo de mensagem (Content Template) do Twilio/WhatsApp.
// Telegram não exige nenhum modelo aprovado nem janela de 24h: qualquer bot
// pode mandar mensagem livre a qualquer hora pra quem já iniciou uma
// conversa com ele — por isso foi escolhido como caminho mais simples.
//
// Configuração (feita pelo usuário, fora daqui):
//   1. Criar um bot conversando com @BotFather no Telegram (/newbot).
//   2. Mandar qualquer mensagem pro bot novo, pra ele "conhecer" o chat.
//   3. TELEGRAM_BOT_TOKEN = o token que o @BotFather devolveu.
//   4. TELEGRAM_CHAT_ID = o id numérico do chat que vai receber os avisos
//      (descoberto automaticamente por routes/telegram.js#GET /descobrir-chat-id,
//      lendo as mensagens recentes que o bot recebeu).
//
// Mesmo contrato de retorno de lib/whatsapp.js — NUNCA lança pra quem chamou,
// sempre devolve { enviado, motivo?, detalhe? }, pra nunca travar o Radar/
// Daily por causa de uma falha de notificação.
const REQUEST_TIMEOUT_MS = 15000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const LIMITE_CARACTERES = 4096; // limite real da API do Telegram por mensagem

function telegramConfigurado() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function fetchComTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Tempo limite (${REQUEST_TIMEOUT_MS / 1000}s) excedido ao chamar a API do Telegram.`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Envia UMA mensagem de texto pro chat configurado em TELEGRAM_CHAT_ID.
// NUNCA grava o token do bot em nenhum log ou retorno (mesma regra já usada
// pro Auth Token da Twilio/token do Mercado Livre/Shopee neste ERP).
async function enviarMensagemTelegram(texto, opts = {}) {
  const fetchFn = opts.fetchFn || fetchComTimeout;
  if (!telegramConfigurado()) {
    return { enviado: false, motivo: 'nao_configurado' };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  // O texto vem formatado com asteriscos de negrito no padrão do WhatsApp
  // (mesma mensagem de lib/ia/radar.js#formatarMensagemWhatsapp e
  // lib/ia/dailyCiclo.js#formatarMensagemWhatsappDaily, reaproveitada pros
  // dois canais). Manda sem `parse_mode` (texto puro) de propósito — o modo
  // Markdown do Telegram rejeita a mensagem inteira se o texto tiver algum
  // caractere especial não escapado (ex.: "_", "[", "]"), o que poderia vir
  // de uma recomendação da IA sem a gente prever. Por isso só remove os
  // asteriscos em vez de tentar formatar: nunca vale a pena arriscar uma
  // mensagem não entregue por causa de negrito.
  const semAsteriscos = texto.replace(/\*/g, '');
  const corpo = semAsteriscos.length > LIMITE_CARACTERES
    ? semAsteriscos.slice(0, LIMITE_CARACTERES - 20) + '\n…(mensagem cortada)'
    : semAsteriscos;

  try {
    const res = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: corpo }),
    });
    let dataBody = null;
    try { dataBody = await res.json(); } catch (e) { /* resposta sem corpo JSON — segue com dataBody null */ }
    if (!res.ok || !(dataBody && dataBody.ok)) {
      const mensagemErro = (dataBody && dataBody.description) || `HTTP ${res.status}`;
      return { enviado: false, motivo: 'erro_api', detalhe: mensagemErro };
    }
    return { enviado: true, messageId: dataBody.result && dataBody.result.message_id };
  } catch (err) {
    return { enviado: false, motivo: err && err.status === 504 ? 'tempo_esgotado' : 'erro_rede', detalhe: err && err.message };
  }
}

// Lê as atualizações recentes que o bot recebeu (getUpdates) e devolve os
// chats que já mandaram mensagem pra ele — usado só por
// routes/telegram.js#GET /descobrir-chat-id, pra o usuário achar o
// TELEGRAM_CHAT_ID sem precisar mexer em nada técnico.
async function listarChatsRecentes(opts = {}) {
  const fetchFn = opts.fetchFn || fetchComTimeout;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, motivo: 'nao_configurado' };
  }
  try {
    const res = await fetchFn(`${TELEGRAM_API_BASE}/bot${token}/getUpdates?limit=20`, { method: 'GET' });
    let dataBody = null;
    try { dataBody = await res.json(); } catch (e) { /* segue com null */ }
    if (!res.ok || !(dataBody && dataBody.ok)) {
      const mensagemErro = (dataBody && dataBody.description) || `HTTP ${res.status}`;
      return { ok: false, motivo: 'erro_api', detalhe: mensagemErro };
    }
    const vistos = new Map();
    for (const upd of dataBody.result || []) {
      const chat = upd.message && upd.message.chat;
      if (chat && chat.id != null) {
        vistos.set(chat.id, {
          chatId: chat.id,
          nome: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || chat.username || 'sem nome',
        });
      }
    }
    return { ok: true, chats: Array.from(vistos.values()) };
  } catch (err) {
    return { ok: false, motivo: err && err.status === 504 ? 'tempo_esgotado' : 'erro_rede', detalhe: err && err.message };
  }
}

module.exports = { telegramConfigurado, enviarMensagemTelegram, listarChatsRecentes };
