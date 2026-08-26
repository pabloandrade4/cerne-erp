// Busca de anúncios (itens/listagens) do Mercado Livre para a tela
// Anúncios. Diferente de mlSync.js (que importa PEDIDOS pro banco), aqui os
// dados são buscados AO VIVO na API do Mercado Livre a cada carregamento da
// tela — nada é salvo no banco nesta etapa (é só visualização; "Primeiro
// quero visualizar corretamente os anúncios" foi o pedido explícito do
// usuário). Nunca inventa/estima nenhum campo: o que a API não retornar
// fica null no item (o front-end mostra "—"), e se a busca inteira falhar,
// quem chamou (routes/anuncios.js) decide mostrar que a sincronização está
// pendente — nunca um anúncio fictício.
const ml = require('./mercadolivre');
const { decrypt } = require('./crypto');
const { getContaComTokenValido } = require('./mlSync');

const PAGE_SIZE = 50;       // limite por página da busca /users/{id}/items/search
const MULTIGET_CHUNK = 20;  // limite de IDs por chamada em /items?ids=...

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Procura o SKU do vendedor no formato que a API do Mercado Livre retorna
// (atributo SELLER_SKU no nível do anúncio, campo legado seller_custom_field,
// ou — se todas as variações tiverem o mesmo SKU — o SKU da variação). Nunca
// "chuta" um SKU quando há mais de um valor possível — nesse caso fica null.
function extrairSku(item) {
  const attrs = item.attributes || [];
  const skuAttr = attrs.find((a) => a.id === 'SELLER_SKU');
  if (skuAttr && skuAttr.value_name) return skuAttr.value_name;
  if (item.seller_custom_field) return item.seller_custom_field;

  const variations = item.variations || [];
  const skusDeVariacao = new Set();
  variations.forEach((v) => {
    const vAttr = (v.attributes || []).find((a) => a.id === 'SELLER_SKU');
    if (vAttr && vAttr.value_name) skusDeVariacao.add(vAttr.value_name);
    else if (v.seller_custom_field) skusDeVariacao.add(v.seller_custom_field);
  });
  if (skusDeVariacao.size === 1) return [...skusDeVariacao][0];
  return null;
}

// Capa/foto principal do anúncio (pedido explícito do usuário, 26/08/2026:
// "quero mostrar também a CAPA/FOTO PRINCIPAL DO ANÚNCIO... a imagem deve
// vir dos dados reais do próprio anúncio no Mercado Livre"). A API devolve
// `secure_thumbnail` (https) e `thumbnail` (http, mais antigo/menos
// confiável em página https) — preferimos sempre o https; nunca inventamos
// uma URL quando os dois vêm vazios (fica null, o front-end mostra um
// placeholder discreto). Campos confirmados na documentação oficial
// (developers.mercadolivre.com.br — "Working with pictures"/"Variations"):
// thumbnail, secure_thumbnail, pictures[].
function extrairImagemUrl(item) {
  return item.secure_thumbnail || item.thumbnail || null;
}

function normalizarItem(item, conta) {
  return {
    id: item.id,
    titulo: item.title || null,
    sku: extrairSku(item),
    loja: conta.nickname || ('Usuário ' + conta.ml_user_id),
    contaId: conta.id,
    preco: item.price !== undefined && item.price !== null ? Number(item.price) : null,
    estoqueDisponivel: item.available_quantity !== undefined && item.available_quantity !== null ? Number(item.available_quantity) : null,
    status: item.status || null,
    tipoAnuncio: item.listing_type_id || null,
    imagemUrl: extrairImagemUrl(item),
  };
}

// Busca UMA página de anúncios já com conta+token resolvidos (reaproveitado
// por buscarAnunciosDaConta, abaixo, e por buscarTodosAnunciosDaConta —
// adicionada em 26/08/2026 para as telas de Análise, ver lib/anunciosBase.js
// — para nunca repetir a resolução de token a cada página).
async function buscarPaginaAnuncios(conta, accessToken, { offset = 0, limit = PAGE_SIZE } = {}) {
  const busca = await ml.apiGet(
    `/users/${conta.ml_user_id}/items/search?offset=${offset}&limit=${limit}`,
    accessToken
  );
  const ids = busca.results || [];
  const total = (busca.paging && busca.paging.total) || ids.length;

  if (!ids.length) return { itens: [], total, offset, limit };

  const lotes = chunk(ids, MULTIGET_CHUNK);
  const atributos = 'id,title,price,available_quantity,status,listing_type_id,attributes,variations,seller_custom_field,thumbnail,secure_thumbnail';
  const respostas = await Promise.all(
    lotes.map((lote) => ml.apiGet(`/items?ids=${lote.join(',')}&attributes=${atributos}`, accessToken))
  );

  const itens = [];
  respostas.forEach((lote) => {
    (lote || []).forEach((entry) => {
      if (entry && entry.code === 200 && entry.body) itens.push(normalizarItem(entry.body, conta));
    });
  });

  return { itens, total, offset, limit };
}

// Busca os anúncios de uma conta do Mercado Livre (paginado). Retorna
// { itens, total, offset, limit } — só devolve o que a API do Mercado Livre
// realmente respondeu.
async function buscarAnunciosDaConta(contaId, { offset = 0, limit = PAGE_SIZE } = {}) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);
  return buscarPaginaAnuncios(conta, accessToken, { offset, limit });
}

// Busca TODOS os anúncios de uma conta (todas as páginas), até um limite de
// segurança `limiteMax` (nunca entra em loop infinito nem traz um catálogo
// gigante inteiro para a memória) — usada pelas telas de Análise (Performance
// de Anúncios, Visitas e Conversão, Margem por Anúncio — ver
// lib/anunciosBase.js), que precisam do catálogo completo para ranking,
// nunca só a primeira página. Resolve o token uma única vez, ao contrário de
// chamar buscarAnunciosDaConta em loop. Retorna também `truncado: true`
// quando o catálogo real da conta é maior que `limiteMax`, para a tela poder
// avisar (nunca esconder isso silenciosamente).
async function buscarTodosAnunciosDaConta(contaId, { limiteMax = 500 } = {}) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);

  let offset = 0;
  let total = Infinity;
  const itens = [];
  while (offset < total && itens.length < limiteMax) {
    const pagina = await buscarPaginaAnuncios(conta, accessToken, { offset, limit: PAGE_SIZE });
    itens.push(...pagina.itens);
    total = pagina.total;
    offset += PAGE_SIZE;
    if (!pagina.itens.length) break;
  }
  return { itens, total: Number.isFinite(total) ? total : itens.length, truncado: Number.isFinite(total) && total > itens.length };
}

module.exports = { buscarAnunciosDaConta, buscarTodosAnunciosDaConta };
