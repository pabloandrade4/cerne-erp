// Relatório de diagnóstico por modelo físico — "Compras com IA", 22/09/2026.
// Mesmo desenho de lib/ia/adsDiagnostico.js (Ads, 21/09/2026): TODOS os
// números e a recomendação vêm de lib/ia/comprasMotor.js (100%
// determinístico) — a IA generativa (mesmo provedor da IA Gestora/SAC/Ads,
// ver lib/ia/providers) entra só pra reescrever esse texto já pronto em
// prosa mais natural, nunca pra decidir um número ou mudar a quantidade
// recomendada. Sem IA configurada/disponível, `textoBase` já é completo e
// legível sozinho.
const { obterProvedorConfigurado } = require('./providers');
const { calcularStatusCompra, STATUS_LABEL } = require('./comprasMotor');

function moeda(v) {
  if (v === null || v === undefined) return 'dado indisponível';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function inteiro(v) {
  if (v === null || v === undefined) return 'dado indisponível';
  return Math.round(Number(v)).toLocaleString('pt-BR');
}
function dataBr(d) {
  if (!d) return 'dado indisponível';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
}

// Monta a lista de "por que a IA está recomendando essa compra" — pedido
// explícito do usuário no mockup (vendas aceleraram / estoque cobre só X
// dias / fornecedor leva X dias / já existem X a caminho / necessidade
// projetada é X) — cada linha só aparece quando o dado por trás dela existe
// de verdade (nunca um motivo genérico sem número).
function montarMotivos(calc, { produtoBaseCodigo, prazoFornecedorDias }) {
  const motivos = [];
  if (calc.acelerando) {
    motivos.push(`As vendas aceleraram: a média dos últimos 7 dias (${calc.mediaDiaria7}/dia) está ${calc.variacaoPct}% acima da média dos últimos 30 dias (${calc.mediaDiaria30}/dia).`);
  } else if (calc.desacelerando) {
    motivos.push(`As vendas desaceleraram: a média dos últimos 7 dias (${calc.mediaDiaria7}/dia) está ${Math.abs(calc.variacaoPct)}% abaixo da média dos últimos 30 dias (${calc.mediaDiaria30}/dia).`);
  }
  if (calc.diasCobertura !== null) {
    motivos.push(`O estoque disponível hoje (${inteiro(calc.estoqueDisponivelReal)} unidades) cobre apenas ${calc.diasCobertura} dia(s) no ritmo atual de venda.`);
  }
  if (calc.prazoFornecedorIndisponivel) {
    motivos.push('O fornecedor padrão deste modelo ainda não tem prazo de entrega cadastrado — o cálculo abaixo usou 0 dia de prazo (leitura conservadora) até isso ser preenchido.');
  } else if (prazoFornecedorDias !== null && prazoFornecedorDias !== undefined) {
    motivos.push(`O fornecedor cadastrado leva ${prazoFornecedorDias} dia(s) para entregar.`);
  }
  if (calc.estoqueFuturo > calc.estoqueDisponivelReal) {
    motivos.push(`Já existem ${inteiro(calc.estoqueFuturo - calc.estoqueDisponivelReal)} unidade(s) a caminho (compras aprovadas ainda não recebidas).`);
  }
  if (calc.estoqueDesejadoUnidades !== null) {
    motivos.push(`A necessidade projetada para manter o estoque saudável é de ${inteiro(calc.estoqueDesejadoUnidades)} unidades (modelo "${produtoBaseCodigo}").`);
  }
  return motivos;
}

// Reúne o cálculo do motor com os textos do relatório — usado tanto pelo
// ciclo automático (lib/ia/comprasCiclo.js) quanto pelos testes.
function montarDadosDiagnostico({
  produtoBaseCodigo, produtoBaseNome,
  estoqueGalpao, estoqueFull, estoqueACaminho,
  venda7d, venda14d, venda30d,
  prazoFornecedorDias, estoqueSegurancaDiasConfigurado, custoUnitario,
  fornecedorNome,
  agora = new Date(),
}) {
  const calc = calcularStatusCompra({
    estoqueGalpao, estoqueFull, estoqueACaminho,
    venda7d, venda14d, venda30d,
    prazoFornecedorDias, estoqueSegurancaDiasConfigurado, custoUnitario,
    agora,
  });
  const motivos = montarMotivos(calc, { produtoBaseCodigo, prazoFornecedorDias });
  const statusInfo = STATUS_LABEL[calc.status];

  return {
    produtoBaseCodigo, produtoBaseNome, fornecedorNome, calc, motivos, statusInfo,
    estoqueGalpao: Number(estoqueGalpao) || 0,
    estoqueFull: Number(estoqueFull) || 0,
    estoqueACaminho: Number(estoqueACaminho) || 0,
  };
}

function montarRelatorioTextoBase(dados) {
  const { calc, motivos, statusInfo } = dados;
  const linhas = [];
  const nomeModelo = dados.produtoBaseNome ? `${dados.produtoBaseCodigo} — ${dados.produtoBaseNome}` : dados.produtoBaseCodigo;
  linhas.push(`Diagnóstico de reposição de estoque — modelo ${nomeModelo}.`);
  linhas.push(`Status atual: ${statusInfo.emoji} ${statusInfo.label}.`);
  linhas.push('');

  linhas.push('| Indicador | Valor |');
  linhas.push('|---|---|');
  linhas.push(`| Estoque no Galpão (fora do Full) | ${inteiro(dados.estoqueGalpao)} un. |`);
  linhas.push(`| Estoque no Full | ${inteiro(dados.estoqueFull)} un. |`);
  linhas.push(`| Estoque disponível total | ${inteiro(calc.estoqueDisponivelReal)} un. |`);
  linhas.push(`| Mercadoria a caminho | ${inteiro(dados.estoqueACaminho)} un. |`);
  linhas.push(`| Venda média projetada | ${calc.mediaDiariaProjetada} un./dia |`);
  linhas.push(`| Cobertura atual | ${calc.diasCobertura === null ? 'dado indisponível' : calc.diasCobertura + ' dia(s)'} |`);
  linhas.push(`| Ruptura prevista | ${dataBr(calc.dataRupturaPrevista)} |`);
  linhas.push(`| Estoque de segurança configurado | ${calc.estoqueSegurancaDias} dia(s) |`);
  linhas.push(`| Quantidade recomendada de compra | ${inteiro(calc.quantidadeRecomendada)} un. |`);
  linhas.push(`| Valor estimado da compra | ${moeda(calc.valorEstimado)} |`);
  if (dados.fornecedorNome) linhas.push(`| Fornecedor sugerido | ${dados.fornecedorNome} |`);
  linhas.push('');

  if (motivos.length) {
    linhas.push('Por que a IA está recomendando essa compra:');
    motivos.forEach((m) => linhas.push(`- ${m}`));
    linhas.push('');
  }

  if (calc.status === 'ruptura') {
    linhas.push(`Recomendação: comprar ${inteiro(calc.quantidadeRecomendada)} unidades o quanto antes — no ritmo atual, o estoque some antes do prazo mínimo de entrega do fornecedor.`);
  } else if (calc.status === 'comprar_agora') {
    linhas.push(`Recomendação: aprovar a compra de ${inteiro(calc.quantidadeRecomendada)} unidades agora, para não deixar o estoque cair abaixo do colchão de segurança.`);
  } else if (calc.status === 'programar') {
    linhas.push(`Recomendação: programar a compra de ${inteiro(calc.quantidadeRecomendada)} unidades nos próximos dias — ainda não é urgente, mas está se aproximando do ponto de recompra.`);
  }

  return linhas.join('\n');
}

function montarSystemPromptReescrita() {
  return [
    'Você reescreve um relatório de diagnóstico de reposição de estoque (compras) em português do Brasil, em prosa natural e direta — no tom de um analista de operações explicando a recomendação para o dono de uma loja não-técnico.',
    '',
    'REGRAS QUE VOCÊ NUNCA PODE QUEBRAR:',
    '1. O relatório que você vai receber já tem TODOS os números corretos (indicadores, motivos, quantidade recomendada, valor estimado). Você NUNCA muda, arredonda diferente, soma ou recalcula nenhum número — copie exatamente como está.',
    '2. Você NUNCA sugere uma quantidade ou uma ação diferente da que já está no relatório.',
    '3. Você pode reorganizar e explicar melhor os números, como um analista de operações faria — mas sempre a partir dos números que já foram dados, nunca inventando um novo.',
    '4. Mantenha a tabela de indicadores em formato de tabela Markdown, exatamente com os mesmos valores recebidos.',
    '5. Se algum dado vier como "dado indisponível", mantenha essa frase — nunca invente um valor no lugar.',
    '6. Responda só com o relatório final, sem introdução nem comentário fora dele.',
  ].join('\n');
}

function extrairTextoDosBlocos(conteudo) {
  return (conteudo || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Gera o relatório completo de um modelo físico: sempre devolve, no mínimo,
// o relatório determinístico (`textoBase`) — a reescrita pela IA generativa
// (`textoIa`) é um extra, null quando o provedor não está configurado, a
// chamada falha, ou devolve algo vazio. Nunca lança.
async function gerarDiagnosticoCompra(params) {
  const dados = montarDadosDiagnostico(params);
  const textoBase = montarRelatorioTextoBase(dados);

  const provedor = obterProvedorConfigurado();
  if (provedor.erro) {
    return { dados, textoBase, textoIa: null, motivoSemIa: provedor.erro };
  }

  try {
    const resposta = await provedor.enviarMensagem({
      system: montarSystemPromptReescrita(),
      mensagens: [{ role: 'user', content: textoBase }],
      ferramentas: undefined,
      maxTokens: 1200,
    });
    const texto = extrairTextoDosBlocos(resposta.conteudo);
    if (!texto) return { dados, textoBase, textoIa: null, motivoSemIa: 'O provedor de IA devolveu uma resposta vazia.' };
    return { dados, textoBase, textoIa: texto, motivoSemIa: null };
  } catch (err) {
    console.error(`[Compras IA][diagnóstico] falha ao reescrever relatório do modelo ${params.produtoBaseCodigo || ''}: ${err.message}`);
    return { dados, textoBase, textoIa: null, motivoSemIa: err.message || 'Erro desconhecido ao chamar o provedor de IA.' };
  }
}

module.exports = {
  montarDadosDiagnostico,
  montarRelatorioTextoBase,
  gerarDiagnosticoCompra,
};
