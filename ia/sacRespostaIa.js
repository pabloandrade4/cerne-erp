// Geração da sugestão de resposta dos agentes de SAC — 14/09/2026, pedido
// explícito do usuário. Diferente de Ads/Promoções (lib/ia/adsDecisor.js,
// 100% regra fixa — sem chamar nenhum modelo de IA), SAC precisa de texto
// em linguagem natural de verdade, então chama o provedor de IA configurado
// (lib/ia/providers/index.js — mesma infraestrutura da IA Gestora).
//
// MODO SUPERVISIONADO — FASE 1 (pedido explícito do usuário): esta função
// só GERA a sugestão de texto. Nunca envia nada a lugar nenhum — quem
// decide aprovar/editar/recusar é sempre o usuário (ver routes/sac.js).
//
// SEGURANÇA (regra do usuário que este prompt NUNCA pode violar): o agente
// nunca pode automaticamente oferecer reembolso, aprovar devolução,
// cancelar pedido, dar desconto, enviar cupom, assumir culpa da empresa, ou
// prometer prazo que não esteja confirmado nos dados reais do pedido —
// essas situações sempre pedem aprovação humana (o texto sugerido só pode
// dizer que vai verificar/escalar, nunca prometer o resultado).
const { obterProvedorConfigurado } = require('./providers');
const { mensagemAmigavel } = require('./orchestrator');

const CLASSIFICACOES_VALIDAS = ['duvida_simples', 'info_pedido', 'problema_entrega', 'reclamacao', 'insatisfeito', 'devolucao'];

const NOME_EMPRESA = 'PF Embalagens'; // mesma empresa citada pelo usuário no pedido original do agente de SAC

function montarSystemPrompt() {
  return [
    `Você ajuda o time de atendimento ao cliente (SAC) da ${NOME_EMPRESA} a responder clientes do Mercado Livre e da Shopee. Você escreve em português do Brasil, num tom curto, educado, profissional e objetivo.`,
    '',
    'REGRAS QUE VOCÊ NUNCA PODE QUEBRAR:',
    '1. Você NUNCA promete algo que não está confirmado nos dados reais fornecidos (prazo de entrega, disponibilidade de estoque, reembolso, etc.). Se um dado não foi fornecido, diga que vai verificar — nunca invente ou "chute".',
    '2. Você NUNCA, em hipótese alguma, oferece reembolso, aprova devolução, cancela pedido, dá desconto, envia cupom, ou assume culpa da empresa no texto da resposta. Se a situação pedir uma dessas coisas, sua resposta deve reconhecer o problema e dizer que a equipe vai analisar/confirmar — nunca decidir isso sozinha.',
    '3. Se a mensagem do cliente não tiver contexto suficiente para uma resposta seguros (ex.: falta o número do pedido, a pergunta é ambígua), responda pedindo o dado que falta, nunca invente uma resposta genérica que possa estar errada.',
    '4. Se você não conseguir gerar uma resposta seguindo estas regras, escreva SEM_SUGESTAO no lugar do texto e explique o motivo — nunca force uma resposta ruim só para preencher o campo.',
    '',
    'Você também classifica cada atendimento (campo CLASSIFICACAO) em um destes códigos:',
    '- duvida_simples: pergunta simples sobre o produto (medida, cor, uso, etc.)',
    '- info_pedido: pergunta sobre status/rastreio/prazo de um pedido já feito',
    '- problema_entrega: atraso, pedido não chegou, endereço errado',
    '- reclamacao: reclamação formal ou cliente insatisfeito com o produto/atendimento',
    '- insatisfeito: cliente visivelmente irritado ou fazendo ameaça de avaliação negativa/denúncia (risco de reputação)',
    '- devolucao: pedido de devolução/troca/reembolso',
    '',
    'E se o atendimento é URGENTE (campo URGENTE: sim/nao) — considere urgente quando o cliente está muito insatisfeito, há risco de reclamação formal, ou é uma devolução/reclamação já aberta.',
    '',
    'Responda SEMPRE exatamente neste formato, sem nenhum texto antes ou depois:',
    'CLASSIFICACAO: <um dos códigos acima>',
    'URGENTE: <sim ou nao>',
    'RESPOSTA:',
    '<o texto da resposta sugerida ao cliente, ou SEM_SUGESTAO seguido do motivo>',
  ].join('\n');
}

function montarMensagemUsuario(atendimento) {
  const linhas = [
    `Marketplace: ${atendimento.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre'}`,
    `Tipo: ${atendimento.tipoOrigem}`,
  ];
  if (atendimento.produtoTitulo) linhas.push(`Produto: ${atendimento.produtoTitulo}`);
  if (atendimento.sku) linhas.push(`SKU: ${atendimento.sku}`);
  if (atendimento.pedidoRef) linhas.push(`Pedido: ${atendimento.pedidoRef}`);
  if (atendimento.clienteNome) linhas.push(`Cliente: ${atendimento.clienteNome}`);
  if (atendimento.contextoPedido) {
    linhas.push('Dados reais do pedido (use só o que está aqui — nunca invente além disso):');
    linhas.push(JSON.stringify(atendimento.contextoPedido));
  }
  linhas.push('');
  linhas.push('Mensagem do cliente:');
  linhas.push(atendimento.mensagemCliente);
  return linhas.join('\n');
}

function extrairTextoDosBlocos(conteudo) {
  return (conteudo || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Faz o parse do formato estruturado pedido no prompt. Se o texto vier fora
// do formato esperado (a IA às vezes escapa do formato pedido), tenta achar
// as 3 partes de forma tolerante; se mesmo assim não conseguir, devolve
// SEM sugestão — nunca chuta um texto de resposta a partir de um parse
// quebrado.
function parseRespostaEstruturada(texto) {
  const mClass = texto.match(/CLASSIFICACAO:\s*([a-z_]+)/i);
  const mUrgente = texto.match(/URGENTE:\s*(sim|nao|não)/i);
  const mResposta = texto.match(/RESPOSTA:\s*([\s\S]*)$/i);

  const classificacaoBruta = mClass ? mClass[1].toLowerCase() : null;
  const classificacao = CLASSIFICACOES_VALIDAS.includes(classificacaoBruta) ? classificacaoBruta : null;
  const urgente = mUrgente ? /sim/i.test(mUrgente[1]) : false;
  let respostaTexto = mResposta ? mResposta[1].trim() : null;

  if (!respostaTexto || /^SEM_SUGESTAO/i.test(respostaTexto)) {
    const motivo = respostaTexto ? respostaTexto.replace(/^SEM_SUGESTAO[:\s-]*/i, '').trim() : null;
    return {
      classificacao,
      urgente,
      respostaSugeridaIa: null,
      motivoSemSugestao: motivo || 'A IA não conseguiu gerar uma resposta segura para este atendimento.',
    };
  }

  return { classificacao, urgente, respostaSugeridaIa: respostaTexto, motivoSemSugestao: null };
}

// Fallback quando o provedor de IA não está configurado (sem IA_API_KEY) —
// nunca inventa um texto de resposta, só classifica pelo tipo de origem
// (heurística simples, sempre marcada como tal) pra o atendimento ao menos
// aparecer organizado na caixa de entrada.
function fallbackSemIa(atendimento, motivo) {
  const classificacaoPorTipo = {
    reclamacao: 'reclamacao', devolucao: 'devolucao', pergunta: 'duvida_simples', mensagem: 'info_pedido',
  };
  return {
    classificacao: classificacaoPorTipo[atendimento.tipoOrigem] || null,
    urgente: atendimento.tipoOrigem === 'reclamacao' || atendimento.tipoOrigem === 'devolucao',
    respostaSugeridaIa: null,
    motivoSemSugestao: motivo,
  };
}

async function gerarSugestaoAtendimento(atendimento) {
  const provedor = obterProvedorConfigurado();
  if (provedor.erro) {
    return fallbackSemIa(atendimento, `${provedor.erro} (sugestão de resposta não gerada — atendimento organizado por tipo apenas.)`);
  }

  try {
    const resposta = await provedor.enviarMensagem({
      system: montarSystemPrompt(),
      mensagens: [{ role: 'user', content: montarMensagemUsuario(atendimento) }],
      ferramentas: undefined,
      maxTokens: 700,
    });
    const texto = extrairTextoDosBlocos(resposta.conteudo);
    if (!texto) return fallbackSemIa(atendimento, 'O provedor de IA devolveu uma resposta vazia.');
    return parseRespostaEstruturada(texto);
  } catch (err) {
    const motivo = err.categoria ? mensagemAmigavel(err.categoria) : (err.message || 'Erro desconhecido ao chamar o provedor de IA.');
    console.error(`[SAC][IA] falha ao gerar sugestão (atendimento externo ${atendimento.idExterno}): ${err.message}`);
    return fallbackSemIa(atendimento, motivo);
  }
}

module.exports = { gerarSugestaoAtendimento, CLASSIFICACOES_VALIDAS };
