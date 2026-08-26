// Cliente da API de Visitas (item visits) do Mercado Livre — criado em
// 26/08/2026 para a aba "Visitas e Conversão" (Análise). Endpoint real
// pesquisado na documentação oficial (global-selling.mercadolibre.com/
// devsite/visits, espelhado em developers.mercadolivre.com.br/pt_br/
// recurso-visits — ver docs/02-decisoes.md):
//
//   GET /items/visits?ids=ID1,ID2,...&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//
// Devolve o total de visitas de cada anúncio no intervalo de datas pedido.
// Limitação documentada: janela de datas de até 150 dias, dado com até 48h
// de atraso (o dia de hoje pode não estar completo ainda).
//
// Regra do usuário (explícita, verbatim): "Não invente número de visitas.
// Se o Mercado Livre não disponibilizar determinada métrica para algum
// anúncio/período, mostrar: Dado não disponível." Por isso: (1) toda falha
// de rede/autorização devolve um motivo estruturado, nunca um número; (2) o
// formato exato da resposta da API NÃO foi verificado contra uma conta real
// nesta sessão (as contas de teste disponíveis no ambiente de
// desenvolvimento estão com token expirado — ver docs/05-problemas-
// conhecidos.md) — por isso o parsing abaixo é defensivo e tenta os formatos
// documentados; se a resposta real vier em um formato inesperado, o anúncio
// fica marcado como indisponível (nunca um valor adivinhado). Quando este
// ERP rodar com uma conta com token válido, reconferir o formato real da
// resposta e ajustar `interpretarResposta` abaixo se necessário.
const ml = require('./mercadolivre');

const MULTIGET_CHUNK = 20; // mesmo tamanho de lote usado em lib/mlAnuncios.js

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
    Object.entries(data).forEach(([chave, valor]) => {
      if (typeof valor === 'number') { porItem.set(chave, valor); return; }
      if (valor && typeof valor === 'object' && typeof valor.total_visits === 'number') porItem.set(chave, valor.total_visits);
    });
  }
  return porItem;
}

// Busca o total de visitas de uma lista de anúncios num intervalo de datas.
// NUNCA lança erro solto. Cada lote (até 20 IDs) é tentado independente dos
// demais — um lote com erro não derruba os outros, os itens daquele lote
// simplesmente ficam de fora do Map devolvido (indisponíveis: "Dado não
// disponível" pra quem chamou). Devolve sempre
// { disponivel, porItem: Map<mlItemId, visitas>, parcial, motivo?, mensagem?, detalheApi? } —
// `disponivel: false` só quando NENHUM lote teve sucesso (nem um anúncio
// com dado); `parcial: true` quando pelo menos um lote falhou mas outro deu
// certo.
async function buscarVisitasPorPeriodo({ accessToken, itemIds, desde, ate }) {
  const ids = [...new Set((itemIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { disponivel: true, porItem: new Map(), parcial: false };

  const lotes = [];
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) lotes.push(ids.slice(i, i + MULTIGET_CHUNK));

  const porItem = new Map();
  let algumSucesso = false;
  let ultimoErro = null;
  for (const lote of lotes) {
    const qs = new URLSearchParams({ ids: lote.join(','), date_from: desde, date_to: ate });
    try {
      const data = await ml.apiGet(`/items/visits?${qs.toString()}`, accessToken);
      interpretarResposta(data).forEach((v, k) => porItem.set(k, v));
      algumSucesso = true;
    } catch (err) {
      ultimoErro = err;
    }
  }

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
