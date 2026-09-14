// Envio de avisos por WhatsApp via Twilio — pedido explícito do usuário em
// 11/09/2026 ("quero receber os avisos do financeiro até estoque no meu
// WhatsApp"). Entre os 3 métodos oferecidos (Twilio / WhatsApp Business
// oficial da Meta / WhatsApp pessoal via QR code) o usuário escolheu Twilio.
// Quem CHAMA este arquivo é lib/ia/radar.js, sempre a partir do ciclo
// periódico do Radar da IA (nunca por ação manual na tela) — ver
// notificarWhatsapp lá.
//
// Limitação real da API do WhatsApp (não é bug daqui — é regra do próprio
// WhatsApp/Meta, documentada pela Twilio, e que vale igual se a empresa usar
// a API da Meta direto, sem Twilio no meio): uma mensagem iniciada pela
// EMPRESA (nunca em resposta a uma mensagem do destinatário) só é entregue
// livremente dentro de uma "janela de 24h" contada a partir da ÚLTIMA
// mensagem que o destinatário mandou pro número configurado. Fora dessa
// janela, a entrega exige um "modelo de mensagem" (template) pré-aprovado
// pela Meta.
//
// Correção (14/09/2026, pedido do usuário: "não conseguimos fazer com que a
// IA mande mensagens diretas sem esse Twilio" — a resposta é que a janela de
// 24h é regra do WhatsApp, não da Twilio, mas dá pra evitar ela com um
// modelo aprovado): quando a variável TWILIO_WHATSAPP_CONTENT_SID está
// configurada (o "Content SID" que a Twilio dá depois que a Meta aprova um
// modelo de mensagem — feito em Twilio Console > Content Template Builder),
// toda mensagem passa a ser enviada POR ESSE MODELO em vez de texto livre, e
// passa a ser entregue a qualquer hora, sem depender da janela de 24h nem de
// reenviar "join <palavra>" no sandbox. O modelo aprovado precisa ter
// exatamente 1 variável ({{1}}) — é nela que entra o texto do aviso inteiro
// (ex.: corpo do modelo = "🔔 Aviso do Cerne ERP: {{1}}"). Sem essa variável
// configurada, o comportamento continua exatamente como antes (texto livre,
// preso à janela de 24h) — nada quebra pra quem ainda não configurou o
// modelo.
const REQUEST_TIMEOUT_MS = 15000;
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

// GET config-status usa isto pra dizer à tela se o WhatsApp já foi
// configurado neste ambiente — mesmo padrão já usado pra Shopee
// (routes/shopee.js#shopeeConfigurado).
function whatsappConfigurado() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_WHATSAPP_FROM
    && process.env.TWILIO_WHATSAPP_TO
  );
}

// Se true, todo envio usa o modelo aprovado (ver comentário acima) em vez de
// texto livre — nunca depende da janela de 24h.
function whatsappModeloAprovadoConfigurado() {
  return Boolean(process.env.TWILIO_WHATSAPP_CONTENT_SID);
}

async function fetchComTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Tempo limite (${REQUEST_TIMEOUT_MS / 1000}s) excedido ao chamar a API da Twilio.`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

function comPrefixoWhatsapp(numero) {
  const limpo = String(numero || '').trim();
  return limpo.startsWith('whatsapp:') ? limpo : `whatsapp:${limpo}`;
}

// Envia UMA mensagem de texto pro número configurado em TWILIO_WHATSAPP_TO.
// NUNCA lança pra quem chamou — sempre devolve { enviado, motivo?, detalhe? }
// pra o chamador decidir o que fazer (o Radar da IA só loga e segue: uma
// falha de WhatsApp nunca pode travar a geração/persistência de alertas).
// NUNCA grava o Auth Token da Twilio em nenhum log ou retorno (mesma regra
// já usada pro token do Mercado Livre/Shopee neste ERP).
async function enviarMensagemWhatsapp(texto, opts = {}) {
  const fetchFn = opts.fetchFn || fetchComTimeout;
  if (!whatsappConfigurado()) {
    return { enviado: false, motivo: 'nao_configurado' };
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const contentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID;

  const params = {
    From: comPrefixoWhatsapp(process.env.TWILIO_WHATSAPP_FROM),
    To: comPrefixoWhatsapp(process.env.TWILIO_WHATSAPP_TO),
  };
  if (contentSid) {
    // Modelo aprovado pela Meta — ver comentário no topo do arquivo. Nunca
    // manda Body junto: a API da Twilio rejeita a mensagem se os dois
    // vierem ao mesmo tempo.
    params.ContentSid = contentSid;
    params.ContentVariables = JSON.stringify({ '1': texto });
  } else {
    // Sem modelo configurado ainda: texto livre — só entregue dentro da
    // janela de 24h (ver comentário no topo do arquivo).
    params.Body = texto;
  }
  const corpo = new URLSearchParams(params);

  try {
    const res = await fetchFn(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: corpo.toString(),
    });
    let dataBody = null;
    try { dataBody = await res.json(); } catch (e) { /* resposta sem corpo JSON — segue com dataBody null */ }
    if (!res.ok) {
      const mensagemErro = (dataBody && dataBody.message) || `HTTP ${res.status}`;
      return { enviado: false, motivo: 'erro_api', detalhe: mensagemErro };
    }
    return { enviado: true, sid: dataBody && dataBody.sid };
  } catch (err) {
    return { enviado: false, motivo: err && err.status === 504 ? 'tempo_esgotado' : 'erro_rede', detalhe: err && err.message };
  }
}

module.exports = { whatsappConfigurado, whatsappModeloAprovadoConfigurado, enviarMensagemWhatsapp };
