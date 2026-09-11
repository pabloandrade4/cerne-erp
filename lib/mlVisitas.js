// Cliente da API de Visitas (item visits) do Mercado Livre — criado em
// 26/08/2026 para a aba "Visitas e Conversão" (Análise). Endpoint real:
//
//   GET /items/visits?ids=ID1,ID2,...&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//
// Devolve o total de visitas de cada anúncio no intervalo de datas pedido.
// Limitação documentada: janela de datas de até 150 dias, dado com até 48h
// de atraso (o dia de hoje pode não estar completo ainda).
//
// CORREÇÃO IMPORTANTE (11/09/2026, evidência real em produção — conta
// PFEMBALAGEMS): a versão original deste arquivo assumia (sem ter testado
// contra uma conta real, já que as contas de teste disponíveis então tinham
// token expirado) que `ids` aceita vários anúncios por chamada, em lotes de
// 20. Testado agora ao vivo, a API respondeu HTTP 400
// "maximum amount of items to query is 1" — ou seja, `ids` só aceita UM ID
// por chamada de verdade. O código foi corrigido para uma chamada por
// anúncio (ver `buscarVisitasPorPeriodo`/`mapComConcorrenciaLimitada`
// abaixo), com um limite de chamadas simultâneas pra não ficar lento nem
// estourar rate limit.
//
// Regra do usuário (explícita, verbatim): "Não invente número de visitas.
// Se o Mercado Livre não disponibilizar determinada métrica para algum
// anúncio/período, mostrar: Dado não disponível." Por isso toda falha de
// rede/autorização devolve um motivo estruturado, nunca um número; o
// parsing em `interpretarResposta` continua defensivo (aceita o formato de
// um item só confirmado agora, e mantém o parsing de mapa/lista como
// segurança) — se a resposta real vier em um formato inesperado, o anúncio
// fica marcado como indisponível, nunca um valor adivinhado.
const ml = require('./mercadolivre');

function extrairMensagemApi(err) {
  const d = err && err.data;
  if (!d) return null;
  if (d.message) return String(d.message);
  if (d.error) return String(d.error);
  return null;
}

// Mesmo espírito de lib/mlAds.js#motivoDeErro: nunca um texto genérico solto,
// sempre citando a causa real quando a API responde uma.
function motivoDeErro(err) {
  const status = err && err.status;
  const mensagemApi = extrairMensagemApi(err);
  const citarApi = mensagemApi ? ` Resposta do Mercado Livre: "${mensagemApi}".` : '';
  const detalheApi = { status: status || null, corpoResposta: (err && err.data) || null, mensagemOriginal: (err && err.message) || null };

  if (status === 401 || status === 403) {
    return { motivo: 'sem_acesso_visitas', mensagem: `Esta conta do Mercado Livre não tem acesso liberado à API de Visitas.${citarApi} Verifique a conexão em Marketplaces.`, detalheApi };
  }
  if (status === 404) {
    return { motivo: 'sem_dado', mensagem: `O Mercado Livre não retornou visitas para estes anúncios/período.${citarApi}`, detalheApi };
  }
  return { motivo: 'erro_api', mensagem: `Não foi possível consultar a API de Visitas do Mercado Livre agora${status ? ` (HTTP ${status})` : ''}.${citarApi || ` (${(err && err.message) || 'erro desconhecido'})`}`, detalheApi };
}

// Interpreta a resposta de GET /items/visits — a documentação descreve o ID
// do anúncio como chave e o total de visitas como valor, mas alguns
// clientes da mesma família de endpoints do Mercado Livre devolvem uma
// lista de objetos {item_id, total_visits} em vez de um mapa. Tenta os dois
// formatos, nunca inventa um valor para um item que não aparece na
// resposta (esse item fica de fora do Map devolvido — quem chamar trata
// como indisponível).
// CORREÇÃO (11/09/2026, evidência real em produção — conta PFEMBALAGEMS): a
// suposição original de que `/items/visits` aceita vários IDs por chamada
// (MULTIGET_CHUNK=20) estava ERRADA — testado ao vivo contra uma conta real,
// a API respondeu HTTP 400 "maximum amount of items to query is 1" pra
// qualquer chamada com mais de um ID em `ids`. Por isso `interpretarResposta`
// agora também entende a resposta de UM item só, que pode vir como objeto
// único no topo (`{item_id, total_visits}`/`{id, visits}`), além dos formatos
// de mapa/lista já tratados (mantidos por segurança, caso a API aceite lote
// em algum outro contexto/conta).
function interpretarResposta(data) {
  const porItem = new Map();
  if (!data) return porItem;

  if (Array.isArray(data)) {
    data.forEach((entry) => {
      const id = entry && (entry.item_id || entry.id);
      const visitas = entry && (entry.total_visits !== undefined ? entry.total_visits : entry.visits);
      if (id !== undefined && id !== null && typeof visitas === 'number') porItem.set(String(id), visitas);
    });
    return porItem;
  }

  if (typeof data === 'object') {
    // Resposta de um único item: {item_id|id, total_visits|visits} no topo —
    // nunca teria uma chave dessas dentro do formato "mapa" (que usa o
    // próprio ID do anúncio como chave), então checar isso primeiro é seguro.
    const idUnico = data.item_id || data.id;
    const visitasUnico = data.total_visits !== undefined ? data.total_visits : data.visits;
    if (idUnico !== undefined && idUnico !== null && typeof visitasUnico === 'number') {
      porItem.set(String(idUnico), visitasUnico);
      return porItem;
    }
    Object.entries(data).forEach(([chave, valor]) => {
      if (typeof valor === 'number') { porItem.set(chave, valor); return; }
      if (valor && typeof valor === 'object' && typeof valor.total_visits === 'number') porItem.set(chave, valor.total_visits);
    });
  }
  return porItem;
}

// Roda `fn` para cada item de `itens`, no máximo `limite` chamadas
// simultâneas por vez (nunca todas de uma vez — evitaria rate limit da API
// do Mercado Livre — nem uma de cada vez — ficaria lento demais quando há
// dezenas de anúncios, já que agora cada anúncio precisa da própria chamada,
// ver correção acima). NUNCA lança: cada resultado vem como
// {ok:true,valor} ou {ok:false,erro}, na mesma ordem de `itens`.
async function mapComConcorrenciaLimitada(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  async function worker() {
    while (proximo < itens.length) {
      const i = proximo++;
      try { resultados[i] = { ok: true, valor: await fn(itens[i]) }; }
      catch (err) { resultados[i] = { ok: false, erro: err }; }
    }
  }
  const workers = Array.from({ length: Math.min(limite, itens.length) }, worker);
  await Promise.all(workers);
  return resultados;
}

const VISITAS_CONCORRENCIA_MAX = 6; // chamadas simultâneas à API de Visitas

// Busca o total de visitas de uma lista de anúncios num intervalo de datas —
// uma chamada por anúncio (ver correção acima), com até
// VISITAS_CONCORRENCIA_MAX chamadas simultâneas. NUNCA lança erro solto. Um
// anúncio com erro não derruba os outros — fica de fora do Map devolvido
// (indisponível: "Dado não disponível" pra quem chamou). Devolve sempre
// { disponivel, porItem: Map<mlItemId, visitas>, parcial, motivo?, mensagem?, detalheApi? } —
// `disponivel: false` só quando NENHUM anúncio teve sucesso; `parcial: true`
// quando pelo menos um anúncio falhou mas outro deu certo.
async function buscarVisitasPorPeriodo({ accessToken, itemIds, desde, ate }) {
  const ids = [...new Set((itemIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { disponivel: true, porItem: new Map(), parcial: false };

  const resultados = await mapComConcorrenciaLimitada(ids, VISITAS_CONCORRENCIA_MAX, async (id) => {
    const qs = new URLSearchParams({ ids: id, date_from: desde, date_to: ate });
    const data = await ml.apiGet(`/items/visits?${qs.toString()}`, accessToken);
    return interpretarResposta(data);
  });

  const porItem = new Map();
  let algumSucesso = false;
  let ultimoErro = null;
  resultados.forEach((r) => {
    if (r.ok) { r.valor.forEach((v, k) => porItem.set(k, v)); algumSucesso = true; }
    else { ultimoErro = r.erro; }
  });

  if (!algumSucesso) return { disponivel: false, porItem, parcial: false, ...motivoDeErro(ultimoErro || new Error('Falha desconhecida ao consultar visitas.')) };
  return { disponivel: true, porItem, parcial: !!ultimoErro };
}

// Interpreta a resposta de GET /users/$USER_ID/items_visits/time_window —
// documentada como agrupada em `results`, um item por unidade de tempo
// (dia). Parsing defensivo pelo mesmo motivo de interpretarResposta acima:
// formato exato não verificado contra uma conta real nesta sessão.
function interpretarSerieDiaria(data) {
  const linhas = (data && Array.isArray(data.results)) ? data.results : (Array.isArray(data) ? data : []);
  return linhas.map((r) => {
    const data_ = r.date || r.day || r.data;
    const visitas = typeof r.total_visits === 'number' ? r.total_visits
      : (typeof r.visits === 'number' ? r.visits
      : (typeof r.total === 'number' ? r.total : null));
    return { data: data_ ? String(data_).slice(0, 10) : null, visitas };
  }).filter((r) => r.data && r.visitas !== null);
}

// Série diária de visitas de TODA a conta (não por anúncio — a API do
// Mercado Livre não oferece visitas diárias por anúncio individual sem uma
// chamada por anúncio, o que não escala para um catálogo inteiro; ver
// docs/02-decisoes.md). Usada só pelo gráfico "Visitas x Vendas" da aba
// Visitas e Conversão, somando a série de todas as contas filtradas. NUNCA
// lança erro solto — mesmo formato de retorno de buscarVisitasPorPeriodo.
async function buscarVisitasDiariasPorConta({ accessToken, mlUserId, dias, endingStr }) {
  const qs = new URLSearchParams({ last: String(Math.max(1, dias)), unit: 'day' });
  if (endingStr) qs.set('ending', endingStr);
  try {
    const data = await ml.apiGet(`/users/${mlUserId}/items_visits/time_window?${qs.toString()}`, accessToken);
    return { disponivel: true, dias: interpretarSerieDiaria(data) };
  } catch (err) {
    return { disponivel: false, dias: [], ...motivoDeErro(err) };
  }
}

module.exports = { buscarVisitasPorPeriodo, buscarVisitasDiariasPorConta, motivoDeErro };
