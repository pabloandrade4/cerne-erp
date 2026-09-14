// Agente de IA "Promoções" — Fase 1 (14/09/2026), mesmo conceito do agente
// de Ads (ver lib/ia/adsDecisor.js): transforma a classificação que já
// existe (lib/promocoesMotor.js#classificar) numa AÇÃO concreta e
// explicável, que o usuário aprova, altera ou recusa (ver
// lib/ia/promocoesDecisoesStore.js, chamado de dentro do ciclo automático
// em lib/ia/promocoesCiclo.js). Nunca chama a API do Mercado Livre.
//
// Pedido explícito do usuário: "recomenda entrar, não entrar ou alterar
// preço". Para "alterar preço" (item já ativo com margem perto do mínimo —
// classificação "risco_margem"), esta primeira versão NÃO calcula um preço
// exato sugerido — calcular isso exigiria inverter a fórmula de
// lib/resultadoVenda.js com premissas adicionais, o que arriscaria uma
// sugestão numérica não verificada num contexto financeiro. Em vez disso,
// a sugestão é qualitativa (revisar/negociar um preço mais alto) e o campo
// `valorDecididoUsuario` (preenchido quando o usuário decide) é exatamente
// o dado que a Fase 2 vai usar para aprender qual preço o usuário
// realmente escolhe nesses casos.
function sugerirAcaoPromocao(linha) {
  if (!linha) return null;
  const codigo = linha.classificacaoCodigo;
  const jaAtiva = !!linha.statusItemMl && linha.statusItemMl !== 'candidate';
  const margemTxt = linha.margemRealPct !== null && linha.margemRealPct !== undefined ? Number(linha.margemRealPct).toFixed(1) + '%' : 'indisponível';
  const minimoTxt = linha.margemMinimaPctUsada !== null && linha.margemMinimaPctUsada !== undefined ? Number(linha.margemMinimaPctUsada).toFixed(1) + '%' : 'indisponível';

  if (!jaAtiva) {
    if (codigo === 'entrar' || codigo === 'oportunidade') {
      return {
        tipoAcao: 'entrar_promocao',
        motivo: `Margem real estimada de ${margemTxt} no preço promocional — ${codigo === 'oportunidade' ? 'bem acima do' : 'dentro do'} mínimo configurado (${minimoTxt}).`,
        valorSugeridoIa: { acao: 'entrar', precoPromoAtual: linha.precoPromo },
      };
    }
    if (codigo === 'nao_recomendado') {
      return {
        tipoAcao: 'nao_entrar_promocao',
        motivo: `Margem real estimada de ${margemTxt} ficaria abaixo do mínimo configurado (${minimoTxt}) no preço promocional sugerido pelo Mercado Livre.`,
        valorSugeridoIa: { acao: 'nao_entrar', precoPromoAtual: linha.precoPromo },
      };
    }
    return null; // dados_insuficientes: sem ação
  }

  if (codigo === 'sair') {
    return {
      tipoAcao: 'sair_promocao',
      motivo: `Margem real estimada caiu para ${margemTxt}, abaixo do mínimo configurado (${minimoTxt}).`,
      valorSugeridoIa: { acao: 'sair' },
    };
  }
  if (codigo === 'risco_margem') {
    return {
      tipoAcao: 'revisar_preco',
      motivo: `Margem real estimada (${margemTxt}) está próxima do mínimo configurado (${minimoTxt}) — considere negociar um preço promocional um pouco mais alto antes que a margem fique negativa.`,
      valorSugeridoIa: { acao: 'revisar_preco', precoPromoAtual: linha.precoPromo, margemAtualPct: linha.margemRealPct },
    };
  }
  return null; // manter / dados_insuficientes: sem ação
}

module.exports = { sugerirAcaoPromocao };
