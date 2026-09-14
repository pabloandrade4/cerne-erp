// Envio de avisos por WhatsApp via Twilio — pedido explícito do usuário em
// 11/09/2026 ("quero receber os avisos do financeiro até estoque no meu
// WhatsApp"). Entre os 3 métodos oferecidos (Twilio / WhatsApp Business
// oficial da Meta / WhatsApp pessoal via QR code) o usuário escolheu Twilio.
// Quem CHAMA este arquivo é lib/ia/radar.js, sempre a partir do ciclo
// periódico do Radar da IA (nunca por ação manual na tela) — ver
// notificarWhatsapp lá.
//
// Limitação real da API do WhatsApp (não é bug daqui — é regra do próprio
// WhatsApp/Meta, documentada pela Twilio): uma mensagem iniciada pela
// EMPRESA (nunca em resposta a uma mensagem do destinatário) só é entregue
// livremente dentro de uma "janela de 24h" contada a partir da ÚLTIMA
// mensagem que o destinatário mandou pro número configurado. Fora dessa
// janela, a entrega exige um "modelo de mensagem" pré-aprovado pela Meta.
// No sandbox gratuito da Twilio (bom pra testar sem custo), isso na prática
// significa: reenviar "join <palavra-do-sandbox>" pro número de teste da
// Twilio sempre que passar mais de 24h sem receber nenhum aviso — sem isso,
// a Twilio devolve erro e o envio falha (nunca quebra o Radar por causa
// disso, ver enviarMensagemWhatsapp abaixo).
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

  const corpo = new URLSearchParams({
    From: comPrefixoWhatsapp(process.env.TWILIO_WHATSAPP_FROM),
    To: comPrefixoWhatsapp(process.env.TWILIO_WHATSAPP_TO),
    Body: texto,
  });

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

module.exports = { whatsappConfigurado, enviarMensagemWhatsapp };
