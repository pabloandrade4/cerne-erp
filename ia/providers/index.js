// Registro de provedores de IA — ponto único de troca de provedor/modelo,
// pedido explícito do usuário ("deixe a integração preparada para que o
// provedor/modelo possa ser trocado futuramente sem precisar reconstruir
// toda a IA").
//
// Como trocar de provedor no futuro (ex: adicionar OpenAI):
//   1) criar server/lib/ia/providers/openai.js exportando a mesma forma
//      { nome, enviarMensagem({apiKey, modelo, system, mensagens, ferramentas, maxTokens}) }
//      que server/lib/ia/providers/anthropic.js já exporta (a tradução pro
//      formato de content blocks — texto/tool_use/tool_result — fica só
//      dentro do arquivo do provedor);
//   2) registrar em PROVEDORES abaixo;
//   3) trocar a variável de ambiente IA_PROVEDOR — nenhuma linha de
//      lib/ia/orchestrator.js, lib/ia/ferramentas.js ou routes/iaGestora.js
//      precisa mudar.
const anthropic = require('./anthropic');

const PROVEDORES = {
  anthropic,
};

// Modelo padrão por provedor — só usado quando IA_MODELO não está
// configurada no ambiente. Documentado em .env.example: o usuário deve
// conferir o identificador de modelo atual em docs.claude.com antes de ir
// pra produção, já que os modelos disponíveis mudam com o tempo.
const MODELO_PADRAO = {
  anthropic: 'claude-sonnet-4-5-20250929',
};

// Devolve o provedor configurado (via IA_PROVEDOR, padrão "anthropic") já
// com a chave de API e o modelo resolvidos das variáveis de ambiente —
// ou `null` quando a IA não está configurada no servidor (sem chave), pra
// o orquestrador conseguir avisar o usuário claramente em vez de quebrar.
function obterProvedorConfigurado() {
  const nomeProvedor = (process.env.IA_PROVEDOR || 'anthropic').trim();
  const provedor = PROVEDORES[nomeProvedor];
  if (!provedor) return { erro: `Provedor de IA "${nomeProvedor}" não é suportado.` };

  const apiKey = (process.env.IA_API_KEY || '').trim();
  if (!apiKey) return { erro: 'IA_API_KEY não configurada no servidor — a IA Gestora ainda não pode responder.' };

  const modelo = (process.env.IA_MODELO || '').trim() || MODELO_PADRAO[nomeProvedor];

  return {
    nome: provedor.nome,
    modelo,
    // Assinatura fixa (system/mensagens/ferramentas/maxTokens) — apiKey e
    // modelo já vêm presos aqui, o chamador (orchestrator) nunca lida com a
    // chave diretamente.
    enviarMensagem: (params) => provedor.enviarMensagem({ ...params, apiKey, modelo }),
  };
}

module.exports = { obterProvedorConfigurado, PROVEDORES, MODELO_PADRAO };
