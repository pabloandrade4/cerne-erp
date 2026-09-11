// Período "anterior equivalente" — usado só pelas telas de Análise
// (Performance de Anúncios, Visitas e Conversão) para "comparação com
// período anterior" e cálculo de crescimento/queda. NÃO faz parte de
// lib/periodo.js de propósito (mesmo padrão já usado para
// lib/fluxoCaixa.js#calcularPeriodoFluxoCaixa — ver docs/02-decisoes.md):
// cada tela que precisa de uma noção de período diferente da compartilhada
// ganha seu próprio cálculo, sem arriscar quebrar Visão Geral/Pedidos/
// Financeiro, que usam lib/periodo.js sem alteração nenhuma.
//
// Definição (documentada, a mesma para as 5 chaves do filtro global):
// o período anterior é uma janela de MESMA DURAÇÃO, imediatamente anterior
// ao início do período selecionado. Para "Este mês" (que tem duração
// variável — do dia 1 até agora), isso NÃO é "o mês de calendário anterior
// inteiro": é a mesma quantidade de dias corridos imediatamente antes do
// dia 1 deste mês. É uma aproximação deliberada e simples — sempre a MESMA
// regra para as 5 chaves, nunca um cálculo especial por chave — e é
// mostrada na tela com o intervalo de datas explícito, para nunca ficar
// ambíguo o que está sendo comparado.
function periodoAnteriorEquivalente({ desde, ate }) {
  const duracaoMs = ate.getTime() - desde.getTime();
  const anteriorAte = new Date(desde.getTime());
  const anteriorDesde = new Date(desde.getTime() - duracaoMs);
  return { desde: anteriorDesde, ate: anteriorAte };
}

module.exports = { periodoAnteriorEquivalente };
