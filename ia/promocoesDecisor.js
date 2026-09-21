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
const { round2 } = require('../resultadoVenda');
const { TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT } = require('../promocoesMotor');

function sugerirAcaoPromocao(linha) {
  if (!linha) return null;
  const codigo = linha.classificacaoCodigo;
  const jaAtiva = !!linha.statusItemMl && linha.statusItemMl !== 'candidate';
  const margemTxt = linha.margemRealPct !== null && linha.margemRealPct !== undefined ? Number(linha.margemRealPct).toFixed(1) + '%' : 'indisponível';
  const minimoTxt = linha.margemMinimaPctUsada !== null && linha.margemMinimaPctUsada !== undefined ? Number(linha.margemMinimaPctUsada).toFixed(1) + '%' : 'indisponível';
  // Margem de conforto (15/09/2026, pedido explícito do usuário — ver
  // lib/promocoesMotor.js#classificar): só entra na explicação quando de
  // fato foi exigida (tem desconto real E o usuário configurou um valor
  // > 0) — pra nunca confundir quem não usa essa opção com um mínimo
  // "diferente" do que configurou.
  const temConforto = !!linha.temDesconto && Number(linha.margemConfortoPctUsada) > 0;
  const minimoExigidoTxt = temConforto
    ? (Number(linha.margemMinimaPctUsada) + Number(linha.margemConfortoPctUsada)).toFixed(1) + '%'
    : minimoTxt;

  // Margem normal do produto (20/09/2026, pedido explícito do usuário — ver
  // lib/promocoesMotor.js#TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT): só entra na
  // explicação quando dá pra calcular (precoNormal utilizável).
  const temMargemNormal = linha.margemNormalPct !== null && linha.margemNormalPct !== undefined;
  const margemNormalTxt = temMargemNormal ? Number(linha.margemNormalPct).toFixed(1) + '%' : null;
  const quedaMargemNormalPct = temMargemNormal ? round2(Number(linha.margemNormalPct) - Number(linha.margemRealPct)) : null;
  const respeitaQuedaMargemNormal = !temMargemNormal || quedaMargemNormalPct <= TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT;
  const explicacaoMargemNormal = temMargemNormal
    ? ` Margem normal deste produto no preço cheio: ${margemNormalTxt} (queda máxima aceita pra recomendar entrar: ${TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT} pontos percentuais).`
    : '';

  // Estoque alto (20/09/2026, pedido explícito do usuário: "sobre, meu
  // estoque daquele produto estiver alto, quero que me avise" — ver
  // lib/promocoesMotor.js#calcularCoberturaEstoque). Sinal INDEPENDENTE da
  // margem — nunca muda a classificação nem o tipoAcao decidido pela
  // margem, só soma contexto na explicação, exceto no caso "manter" logo
  // abaixo, onde vira o próprio motivo de haver uma sugestão.
  const explicacaoEstoqueAlto = linha.estoqueAlto
    ? ` ${linha.motivoEstoqueAlto || 'Estoque deste produto está alto.'}`
    : '';

  if (!jaAtiva) {
    if (codigo === 'entrar' || codigo === 'oportunidade') {
      return {
        tipoAcao: 'entrar_promocao',
        motivo: `Margem real estimada de ${margemTxt} no preço promocional — ${codigo === 'oportunidade' ? 'bem acima do' : 'dentro do'} mínimo exigido (${minimoExigidoTxt}${temConforto ? `, sendo ${minimoTxt} o mínimo configurado + ${Number(linha.margemConfortoPctUsada).toFixed(1)}% de margem de conforto por ter desconto` : ' configurado'}).${explicacaoMargemNormal}${explicacaoEstoqueAlto}`,
        valorSugeridoIa: { acao: 'entrar', precoPromoAtual: linha.precoPromo },
      };
    }
    if (codigo === 'nao_recomendado') {
      const motivoMinimo = temConforto
        ? `Margem real estimada de ${margemTxt} fica acima do mínimo puro (${minimoTxt}), mas abaixo do mínimo exigido pra promoções com desconto (${minimoTxt} + ${Number(linha.margemConfortoPctUsada).toFixed(1)}% de margem de conforto = ${minimoExigidoTxt}).`
        : `Margem real estimada de ${margemTxt} ficaria abaixo do mínimo configurado (${minimoTxt}) no preço promocional sugerido pelo Mercado Livre.`;
      return {
        tipoAcao: 'nao_entrar_promocao',
        motivo: (!respeitaQuedaMargemNormal
          ? `Margem real estimada de ${margemTxt} cairia ${quedaMargemNormalPct.toFixed(1)} pontos percentuais abaixo da margem normal deste produto no preço cheio (${margemNormalTxt}) — mais do que a queda máxima aceita (${TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT} pontos), mesmo estando acima do mínimo configurado (${minimoTxt}).`
          : motivoMinimo + explicacaoMargemNormal) + explicacaoEstoqueAlto,
        valorSugeridoIa: { acao: 'nao_entrar', precoPromoAtual: linha.precoPromo },
      };
    }
    return null; // dados_insuficientes: sem ação
  }

  if (codigo === 'sair') {
    return {
      tipoAcao: 'sair_promocao',
      motivo: `Margem real estimada caiu para ${margemTxt}, abaixo do mínimo configurado (${minimoTxt}).${explicacaoEstoqueAlto}`,
      valorSugeridoIa: { acao: 'sair' },
    };
  }
  if (codigo === 'risco_margem') {
    // Distingue os dois motivos possíveis (20/09/2026, ver
    // lib/promocoesMotor.js#classificar — mesma regra dos 3 pontos agora
    // também vale pra promoção já ativa, confirmado pelo usuário): perto do
    // mínimo absoluto, OU já caiu mais que o aceito abaixo da margem normal
    // do produto (mesmo estando longe do mínimo absoluto).
    const motivoPelaMargemNormal = temMargemNormal && !respeitaQuedaMargemNormal;
    return {
      tipoAcao: 'revisar_preco',
      motivo: (motivoPelaMargemNormal
        ? `Margem real estimada de ${margemTxt} já caiu ${quedaMargemNormalPct.toFixed(1)} pontos percentuais abaixo da margem normal deste produto no preço cheio (${margemNormalTxt}) — mais do que a queda máxima aceita (${TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT} pontos), mesmo ainda estando acima do mínimo configurado (${minimoTxt}). Vale considerar sair ou negociar um preço melhor.`
        : `Margem real estimada (${margemTxt}) está próxima do mínimo configurado (${minimoTxt}) — considere negociar um preço promocional um pouco mais alto antes que a margem fique negativa.`) + explicacaoEstoqueAlto,
      valorSugeridoIa: { acao: 'revisar_preco', precoPromoAtual: linha.precoPromo, margemAtualPct: linha.margemRealPct },
    };
  }
  // "Manter" com estoque alto (20/09/2026, pedido explícito do usuário):
  // a margem está de boa, mas ainda assim vale AVISAR que o estoque deste
  // produto está alto — é um motivo pra CONSIDERAR uma promoção mais forte
  // pra girar esse estoque, nunca uma ação automática (a margem que rege
  // se entrar/sair continua sendo decidida só pelas regras de margem
  // acima). Sem estoque alto, "manter" continua sem gerar sugestão nenhuma
  // — nada a avisar quando está tudo normal.
  if (codigo === 'manter' && linha.estoqueAlto) {
    return {
      tipoAcao: 'estoque_alto',
      motivo: `Margem real estimada (${margemTxt}) está de boa —${explicacaoEstoqueAlto} Pode valer a pena considerar uma promoção mais forte pra girar esse estoque, sempre respeitando a margem mínima.`,
      valorSugeridoIa: { acao: 'considerar_promocao_por_estoque', coberturaDiasEstoque: linha.coberturaDiasEstoque, estoqueAtual: linha.estoqueAtual },
    };
  }
  return null; // manter (sem estoque alto) / dados_insuficientes: sem ação
}

module.exports = { sugerirAcaoPromocao };
