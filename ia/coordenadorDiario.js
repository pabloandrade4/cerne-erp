// Agente Coordenador da Daily dos Agentes — Etapa 3 (20/09/2026, pedido
// explícito do usuário): "preciso que o analista analise a conta toda...
// pode ser ads pode ser o concorrente entre outras coisas, como podemos
// fazer com que os agentes analise a conta por completo e coloque pontual
// oque deve ser feito, lembrando que nao pode ser no chute ou inventado tem
// que ser com base em metricas e numeros da conta".
//
// Este módulo NÃO calcula nada novo e NÃO consulta o banco nem a API do
// Mercado Livre — é uma função PURA que recebe os achados que os 6
// especialistas JÁ produziram na Daily (lib/ia/dailyCiclo.js chama
// gerarCorrelacoes depois de coletar todos os achados de todos os agentes,
// ver "Etapa 3" no header daquele arquivo) e cruza achados de agentes
// DIFERENTES pro MESMO SKU, seguindo regras determinísticas e auditáveis —
// nunca um "a IA decidiu" sem explicação, nunca um número que não veio de
// dentro de algum achado real. `regraCodigo` em cada correlação existe
// exatamente pra isso: qualquer conclusão pode ser rastreada até a regra
// exata que a gerou e até os `achadosRelacionados` (ids reais de
// ia_achados_diarios) que a embasam.
//
// A tabela ia_correlacoes_diarias (ver db/schema.sql) já existia, desenhada
// pra isso desde antes — o comentário dela já trazia o exemplo que o
// usuário deu na prática: "Ads acusa margem baixa num SKU + Promoções acusa
// desconto ativo no mesmo SKU + Buy Box confirma preço competitivo -> 'reduza
// o desconto antes de reduzir Ads'". Esta é a primeira implementação real
// dela.
//
// Regras hoje (todas ancoradas em SKU — sem SKU, nenhuma regra cruza nada):
//   R1 — anúncio em queda de vendas (agente Anúncios) + Ads sugerindo
//        pausar o mesmo SKU (agente Ads) -> a queda pode estar ligada à
//        redução/pausa do investimento em Ads, não só a demanda/concorrência.
//   R2 — anúncio com estoque zerado (o próprio achado do agente Anúncios já
//        traz esse número) -> não é bem um "cruzamento" entre agentes, mas
//        é o motivo mais óbvio e mais rápido de descartar antes de qualquer
//        outra hipótese (Ads, concorrente etc.) — por isso entra aqui.
//   R3 — anúncio em queda de vendas + Promoções sugerindo sair de uma
//        promoção no mesmo SKU (margem comprometida) -> a queda pode estar
//        ligada ao preço promocional atual, não a Ads nem a concorrência.
//   R4 — anúncio em queda de vendas + um concorrente CADASTRADO PELO
//        USUÁRIO pra esse SKU (ver lib/concorrente.js#cadastrarConcorrente
//        — resposta direta dele ao bloqueio da busca automática pela API:
//        "sobre o concorrente eu vou mandar o link do anuncio do concorrente
//        para ficar mais facil") -> nunca afirma que o concorrente é a
//        causa (a API não permite confirmar preço automaticamente), só
//        aponta o link real cadastrado pra conferência manual.
//
// Honestidade: um SKU sem nenhum cruzamento possível não gera correlação
// nenhuma — "sem causa provável identificada" nunca vira uma linha na tela
// nem uma frase inventada. Também nunca combina achados do MESMO agente
// entre si (isso já seria trabalho de dentro do próprio agente, não do
// Coordenador).

const AGENTE_ANUNCIOS = 'anuncios_radar';
const AGENTE_ADS = 'ads_performance';
const AGENTE_PROMOCOES = 'promocoes';

const TIPOS_ACAO_ADS_PAUSAR = ['pausar_anuncio', 'pausar_campanha'];
const MAX_ITENS_CITADOS = 3;

function formatMoney(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

// "A, B e C" / "A, B, C e mais 2" — nunca uma lista crua sem limite, mesmo
// espírito de dailyCiclo.js#formatarMensagemWhatsappDaily.
function formatarLista(itens) {
  const nomes = itens.slice(0, MAX_ITENS_CITADOS).map((i) => `"${i}"`);
  const excedente = itens.length - nomes.length;
  if (!nomes.length) return '';
  let texto = nomes.length === 1 ? nomes[0] : nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
  if (excedente > 0) texto += ` (e mais ${excedente})`;
  return texto;
}

const ORDEM_PRIORIDADE = { critica: 0, alta: 1, media: 2, baixa: 3 };

// A correlação herda a prioridade mais alta entre os achados que ela
// cruza — nunca inventa uma prioridade própria desconectada dos achados
// reais que a sustentam.
function maiorPrioridade(achados) {
  let melhor = null;
  for (const a of achados) {
    if (!a.prioridade) continue;
    if (melhor === null || ORDEM_PRIORIDADE[a.prioridade] < ORDEM_PRIORIDADE[melhor]) melhor = a.prioridade;
  }
  return melhor;
}

function agruparPorSku(achados) {
  const mapa = {};
  for (const a of achados) {
    if (!a.sku) continue; // sem SKU, nenhuma regra deste Coordenador consegue cruzar nada
    if (!mapa[a.sku]) mapa[a.sku] = [];
    mapa[a.sku].push(a);
  }
  return mapa;
}

// R1 — anúncio em queda + Ads pausando o mesmo SKU.
function regraAdsPausadoEQuedaDeVendas(sku, anunciosProblema, adsPausados) {
  const tituloAnuncios = formatarLista(anunciosProblema.map((a) => a.titulo));
  const tituloAds = formatarLista(adsPausados.map((a) => a.titulo));

  const diasSemVenda = anunciosProblema
    .map((a) => a.dados && a.dados.diasSemVenda)
    .filter((d) => d !== null && d !== undefined);
  const variacoes = anunciosProblema
    .map((a) => a.dados && a.dados.variacaoQuantidade7dPct)
    .filter((v) => v !== null && v !== undefined);

  const partesNumeros = [];
  if (diasSemVenda.length) partesNumeros.push(`${Math.max(...diasSemVenda)} dia(s) sem venda`);
  if (variacoes.length) partesNumeros.push(`variação de ${formatPct(Math.min(...variacoes))} em quantidade vendida (7d vs. 7d anteriores)`);

  const orcamentos = adsPausados
    .map((a) => a.dados && a.dados.orcamentoAtual)
    .filter((v) => v !== null && v !== undefined);
  const partesAds = [];
  if (orcamentos.length) partesAds.push(`orçamento atual ${orcamentos.map(formatMoney).filter(Boolean).join(', ')}`);

  return {
    regraCodigo: 'r1_ads_pausado_correlaciona_queda_anuncio',
    sku,
    achadosRelacionados: [...anunciosProblema, ...adsPausados].map((a) => a.id),
    prioridade: maiorPrioridade([...anunciosProblema, ...adsPausados]),
    conclusao: `SKU ${sku}: o anúncio ${tituloAnuncios} está com desempenho baixo`
      + (partesNumeros.length ? ` (${partesNumeros.join('; ')})` : '') + `. No mesmo período, o agente de Ads recomendou pausar ${tituloAds}`
      + (partesAds.length ? ` (${partesAds.join('; ')})` : '') + `. É provável que a queda esteja relacionada à redução/pausa do investimento em Ads pra este SKU — vale confirmar se isso foi intencional antes de investigar outras causas (concorrência, estoque, preço).`,
  };
}

// R2 — estoque zerado (dado já dentro do próprio achado de anúncio).
function regraEstoqueZerado(sku, anunciosSemEstoque) {
  const titulos = formatarLista(anunciosSemEstoque.map((a) => a.titulo));
  const diasSemVenda = anunciosSemEstoque
    .map((a) => a.dados && a.dados.diasSemVenda)
    .filter((d) => d !== null && d !== undefined);

  let complemento = '';
  if (diasSemVenda.length) complemento = ` (já há ${Math.max(...diasSemVenda)} dia(s) sem venda registrada)`;

  return {
    regraCodigo: 'r2_estoque_zerado_anuncio',
    sku,
    achadosRelacionados: anunciosSemEstoque.map((a) => a.id),
    prioridade: maiorPrioridade(anunciosSemEstoque),
    conclusao: `SKU ${sku}: o anúncio ${titulos} está com estoque sincronizado ZERADO${complemento}. Antes de investigar Ads, promoção ou concorrência, reponha o estoque — sem estoque disponível, nenhuma outra causa explica a queda de vendas.`,
  };
}

// R3 — anúncio em queda + Promoções sugerindo sair de uma promoção (margem
// comprometida) no mesmo SKU.
function regraPromocaoComprometeMargem(sku, anunciosProblema, promocoesSaida) {
  const tituloAnuncios = formatarLista(anunciosProblema.map((a) => a.titulo));
  const tituloPromocoes = formatarLista(promocoesSaida.map((a) => a.titulo));

  const descontos = promocoesSaida.map((a) => a.dados && a.dados.descontoPct).filter((v) => v !== null && v !== undefined);
  const margens = promocoesSaida.map((a) => a.dados && a.dados.margemRealPct).filter((v) => v !== null && v !== undefined);
  const partes = [];
  if (descontos.length) partes.push(`desconto de ${descontos.map(formatPct).filter(Boolean).join(', ')}`);
  if (margens.length) partes.push(`margem real de ${margens.map(formatPct).filter(Boolean).join(', ')}`);

  return {
    regraCodigo: 'r3_promocao_compromete_margem_anuncio',
    sku,
    achadosRelacionados: [...anunciosProblema, ...promocoesSaida].map((a) => a.id),
    prioridade: maiorPrioridade([...anunciosProblema, ...promocoesSaida]),
    conclusao: `SKU ${sku}: o anúncio ${tituloAnuncios} está com desempenho baixo, e o agente de Promoções identificou que ${tituloPromocoes} está com a margem comprometida`
      + (partes.length ? ` (${partes.join('; ')})` : '') + `, recomendando sair da promoção. Vale rever o preço promocional antes de reduzir investimento em Ads ou buscar outra causa.`,
  };
}

// R4 — anúncio em queda + concorrente cadastrado manualmente pra esse SKU.
// NUNCA afirma que o concorrente é a causa — só surfa o link real pro
// usuário conferir preço ele mesmo (a API do Mercado Livre bloqueia
// confirmação automática, ver lib/concorrente.js).
function regraConcorrenteCadastrado(sku, anunciosProblema, concorrentes) {
  const tituloAnuncios = formatarLista(anunciosProblema.map((a) => a.titulo));
  const links = concorrentes.slice(0, MAX_ITENS_CITADOS).map((c) => c.apelido ? `${c.apelido} (${c.url})` : c.url);
  const excedente = concorrentes.length - links.length;
  let listaLinks = links.join(' | ');
  if (excedente > 0) listaLinks += ` (e mais ${excedente} cadastrado(s))`;

  return {
    regraCodigo: 'r4_concorrente_cadastrado_anuncio',
    sku,
    achadosRelacionados: anunciosProblema.map((a) => a.id),
    prioridade: maiorPrioridade(anunciosProblema),
    conclusao: `SKU ${sku}: o anúncio ${tituloAnuncios} está com desempenho baixo. Você tem concorrente(s) cadastrado(s) pra este SKU: ${listaLinks} — vale abrir o link e comparar o preço manualmente (a API do Mercado Livre não permite confirmar automaticamente o preço do concorrente).`,
  };
}

// Função principal — pura, sem I/O. `achados` é a lista FLAT de todos os
// achados de todos os agentes da reunião do dia (cada um já com o `id` real
// gravado em ia_achados_diarios — ver lib/ia/dailyCiclo.js#inserirAchados).
// `concorrentesMonitoradosPorSku` vem de
// lib/concorrente.js#mapaConcorrentesMonitoradosPorSku.
function gerarCorrelacoes({ achados = [], concorrentesMonitoradosPorSku = {} } = {}) {
  const porSku = agruparPorSku(achados);
  const correlacoes = [];

  for (const [sku, achadosDoSku] of Object.entries(porSku)) {
    const anunciosProblema = achadosDoSku.filter((a) => a.agenteCodigo === AGENTE_ANUNCIOS && a.tipo === 'problema');
    const anunciosTodos = achadosDoSku.filter((a) => a.agenteCodigo === AGENTE_ANUNCIOS);
    const adsPausados = achadosDoSku.filter(
      (a) => a.agenteCodigo === AGENTE_ADS && a.dados && TIPOS_ACAO_ADS_PAUSAR.includes(a.dados.tipoAcao)
    );
    const promocoesSaida = achadosDoSku.filter(
      (a) => a.agenteCodigo === AGENTE_PROMOCOES && a.dados && a.dados.tipoAcao === 'sair_promocao'
    );
    const anunciosSemEstoque = anunciosTodos.filter(
      (a) => a.dados && a.dados.estoqueDisponivel === 0 && a.dados.estoqueSincronizado === true
    );
    const concorrentes = concorrentesMonitoradosPorSku[sku] || [];

    if (anunciosProblema.length && adsPausados.length) {
      correlacoes.push(regraAdsPausadoEQuedaDeVendas(sku, anunciosProblema, adsPausados));
    }
    if (anunciosSemEstoque.length) {
      correlacoes.push(regraEstoqueZerado(sku, anunciosSemEstoque));
    }
    if (anunciosProblema.length && promocoesSaida.length) {
      correlacoes.push(regraPromocaoComprometeMargem(sku, anunciosProblema, promocoesSaida));
    }
    if (anunciosProblema.length && concorrentes.length) {
      correlacoes.push(regraConcorrenteCadastrado(sku, anunciosProblema, concorrentes));
    }
  }

  return correlacoes;
}

module.exports = { gerarCorrelacoes };
