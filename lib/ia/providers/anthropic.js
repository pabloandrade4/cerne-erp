// Provedor de IA — Anthropic (Claude), via chamada HTTP direta à API de
// Mensagens (https://docs.claude.com/en/api/messages) usando o fetch nativo
// do Node — sem SDK/dependência nova no projeto (este ambiente de
// desenvolvimento não consegue instalar pacotes npm, ver
// docs/05-problemas-conhecidos.md; o fetch nativo já existe desde o Node 18,
// mesma engine mínima do projeto).
//
// Regra central do usuário (Ativação da IA Gestora, 3 passos):
//   "Toda comunicação com o provedor de IA deve acontecer pelo backend.
//    Nunca exponha a chave da API no frontend." — por isso este arquivo só
//    é importado por lib/ia/orchestrator.js (backend), nunca referenciado
//    em server/public/index.html.
//   "Deixe a integração preparada para que o provedor/modelo possa ser
//    trocado futuramente sem precisar reconstruir toda a IA." — por isso
//    este arquivo implementa só a tradução Anthropic <-> o formato interno
//    comum (ver lib/ia/providers/index.js), nunca é chamado diretamente
//    pelo orquestrador.
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Mesma filosofia defensiva já usada em lib/mercadolivre.js: sem timeout, uma
// chamada travada (rede instável, provedor fora do ar) prenderia a pergunta
// do usuário para sempre, já que o Node não aplica timeout nenhum por padrão
// no fetch(). IA pode demorar mais que a API do Mercado Livre (geração de
// texto), por isso um limite maior (45s) por chamada.
const REQUEST_TIMEOUT_MS = 45000;

async function fetchComTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Tempo limite (${REQUEST_TIMEOUT_MS / 1000}s) excedido ao chamar o provedor de IA.`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Formato interno comum (ver lib/ia/providers/index.js para o contrato
// completo): mensagens no mesmo formato de "content blocks" já usado pela
// API de Mensagens da Anthropic (texto, tool_use, tool_result) — escolhido
// de propósito por já ser o formato mais próximo de um padrão comum entre
// provedores de IA com chamada de ferramentas hoje. Um provedor futuro
// diferente (ex: OpenAI) implementaria só a tradução desse mesmo formato
// para o dele dentro do arquivo dele — nunca mexendo no orquestrador.
async function enviarMensagem({ apiKey, modelo, system, mensagens, ferramentas, maxTokens }) {
  if (!apiKey) {
    const err = new Error('IA_API_KEY não configurada no servidor.');
    err.semChave = true;
    throw err;
  }

  const res = await fetchComTimeout(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens || 1024,
      system,
      messages: mensagens,
      tools: ferramentas,
    }),
  });

  let body = null;
  try { body = await res.json(); } catch (e) { /* resposta sem corpo JSON válido */ }

  if (!res.ok) {
    const motivo = (body && body.error && body.error.message) || `Erro HTTP ${res.status} do provedor de IA.`;
    const err = new Error(motivo);
    err.status = res.status;
    throw err;
  }
  if (!body) {
    const err = new Error('Resposta vazia/inválida do provedor de IA.');
    throw err;
  }

  // Normaliza pro formato interno comum: { conteudo, pararPor, uso }.
  // `conteudo` continua no formato de content blocks (a Anthropic já usa
  // esse formato nativamente — nenhuma tradução necessária aqui), pronto
  // pra ser reenviado como histórico na próxima rodada do laço de
  // ferramentas em lib/ia/orchestrator.js.
  return {
    conteudo: body.content || [],
    pararPor: body.stop_reason,
    uso: body.usage || null,
  };
}

module.exports = { nome: 'anthropic', enviarMensagem };
