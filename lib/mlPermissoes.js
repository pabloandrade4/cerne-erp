// IA de Promoções — Fase A (13/09/2026): verificação de permissão de
// escrita na integração com o Mercado Livre.
//
// POR QUE ISSO EXISTE: o usuário pediu explicitamente que NENHUMA ação de
// escrita (aceitar promoção, remover, alterar preço) seja tentada enquanto
// o aplicativo cadastrado no Mercado Livre Developers só tiver permissão de
// LEITURA — e que isso seja verificado no backend, nunca assumido.
//
// COMO VERIFICAMOS, E POR QUE NÃO CONFIAMOS SÓ NISSO:
// O Mercado Livre devolve um campo `scope` (ex.: "offline_access read
// write") toda vez que o token é emitido ou renovado — isso é passado de
// graça, sem chamada nova (ver routes/integracoes.js#/callback e
// lib/mlSync.js#getContaComTokenValido, que agora gravam esse texto em
// ml_contas.escopo_oauth). Só que esse `scope` é uma permissão GERAL da
// conta do desenvolvedor — não fica claro na documentação pública que ele
// reflita, produto por produto, se a Central de Promoções específica
// aceita escrita (o usuário relatou ver "somente leitura" numa tela
// separada do painel do Mercado Livre Developers, referente a essa API
// específica). Por isso o `escopo_oauth` aqui é tratado como
// INFORMATIVO/diagnóstico, nunca como a fonte da verdade.
//
// A fonte da verdade real é `config_promocoes.permite_escrita_ml`: uma
// trava manual, que começa sempre desligada, e só o usuário liga (pela
// tela) depois de confirmar a liberação no painel do Mercado Livre E
// reconectar a conta (reautorizar — um token já emitido não ganha
// permissão nova sozinho, ver aviso em routes/promocoes.js). Enquanto essa
// trava estiver desligada, NENHUM código deste ERP tenta uma chamada de
// escrita na API de Promoções — nem esta função, nem nenhuma outra.

// Interpreta o texto de `scope` devolvido pelo Mercado Livre. Só serve de
// pista pro diagnóstico mostrado na tela — nunca decide sozinho se a
// escrita está liberada (ver comentário acima).
function escopoIndicaEscrita(escopoOauth) {
  if (!escopoOauth || typeof escopoOauth !== 'string') return null; // null = "ainda não sabemos" (nunca token nenhum capturado)
  return escopoOauth
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .includes('write');
}

// Junta o diagnóstico (informativo) com a trava manual (a que realmente
// manda) num objeto único pra tela e pras rotas de ação usarem — sempre a
// mesma regra, nunca duas fontes de verdade divergentes. GENERALIZADA
// (19/09/2026, mesmo pedido do usuário que ativou a execução real de Ads —
// ver lib/ia/adsExecutor.js) pra servir qualquer agente, não só Promoções:
// quem chama passa as duas frases prontas (uma pra "escrita disponível",
// outra pra "só leitura"), nunca um texto genérico que não diga o que a IA
// específica pode ou não fazer.
function statusIntegracaoAgente({ escopoOauth, permiteEscritaMl, mensagemComEscrita, mensagemSemEscrita }) {
  const escopoSugere = escopoIndicaEscrita(escopoOauth);
  const escritaDisponivel = !!permiteEscritaMl; // a trava manual é soberana — de propósito
  return {
    escopoOauth: escopoOauth || null,
    escopoSugereEscrita: escopoSugere, // true | false | null (desconhecido)
    permiteEscritaMl: !!permiteEscritaMl,
    escritaDisponivel,
    statusLabel: escritaDisponivel ? 'leitura_e_escrita' : 'somente_leitura',
    mensagem: escritaDisponivel ? mensagemComEscrita : mensagemSemEscrita,
  };
}

// Wrapper com o texto original da IA de Promoções (13/09/2026) — mantido
// com o mesmo nome/comportamento de sempre pra nunca quebrar quem já
// chama esta função (rotas, testes).
function statusIntegracaoPromocoes({ escopoOauth, permiteEscritaMl }) {
  return statusIntegracaoAgente({
    escopoOauth,
    permiteEscritaMl,
    mensagemComEscrita: 'Seu aplicativo Mercado Livre tem leitura e escrita liberadas nesta integração. A IA pode analisar, recomendar e (quando você confirmar) aplicar promoções.',
    mensagemSemEscrita: 'Seu aplicativo Mercado Livre possui atualmente acesso de leitura. A IA pode analisar e recomendar promoções, mas não pode alterá-las automaticamente.',
  });
}

// Wrapper equivalente pra IA de Ads e Performance (19/09/2026, pedido
// explícito do usuário: "eu vou aprovar, aí vai fazer" — ver
// lib/ia/adsExecutor.js/routes/ads.js#/status-integracao).
function statusIntegracaoAds({ escopoOauth, permiteEscritaMl }) {
  return statusIntegracaoAgente({
    escopoOauth,
    permiteEscritaMl,
    mensagemComEscrita: 'Seu aplicativo Mercado Livre tem leitura e escrita liberadas nesta integração. Ao aprovar uma sugestão de Ads, a IA já aplica a mudança de verdade (pausar/ativar campanha, mudar orçamento).',
    mensagemSemEscrita: 'Seu aplicativo Mercado Livre possui atualmente acesso de leitura. A IA continua analisando e recomendando normalmente, mas aprovar uma sugestão só registra a decisão — nada é alterado de verdade no Mercado Livre até você liberar a escrita aqui.',
  });
}

// Mensagem padrão pra qualquer rota de ação de escrita (aceitar promoção,
// remover, alterar preço) quando a trava está desligada — nunca um erro
// genérico, sempre esta explicação (pedido explícito do usuário).
const MENSAGEM_ACAO_INDISPONIVEL =
  'Esta ação exige permissão de escrita na API do Mercado Livre. Atualmente sua aplicação possui apenas permissão de leitura.';

module.exports = {
  escopoIndicaEscrita,
  statusIntegracaoAgente,
  statusIntegracaoPromocoes,
  statusIntegracaoAds,
  MENSAGEM_ACAO_INDISPONIVEL,
};
