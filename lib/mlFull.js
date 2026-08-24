// Estoque Full — busca ao vivo, na API do Mercado Livre, os anúncios com
// logística "fulfillment" (Full) e a quantidade real no centro de
// distribuição do Mercado Livre, quando a API disponibilizar esse dado.
// Mesma filosofia de lib/mlAnuncios.js (Anúncios): nada é salvo no banco,
// nada é inventado — o que a API não retornar fica marcado como pendente,
// nunca um número calculado/estimado. Deliberadamente um arquivo separado
// de mlAnuncios.js (mesmo com alguma duplicação de código) para não
// arriscar alterar a lógica de Anúncios, que ainda está pendente de teste
// ao vivo em produção.
const ml = require('./mercadolivre');
const { decrypt } = require('./crypto');
const { getContaComTokenValido } = require('./mlSync');

const PAGE_SIZE = 50;       // quantos anúncios são verificados por carregamento
const MULTIGET_CHUNK = 20;  // limite de IDs por chamada em /items?ids=...

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Mesma lógica de extração de SKU usada em Anúncios (ver lib/mlAnuncios.js)
// — nunca escolhe um SKU "no chute" quando há mais de um possível.
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

// Busca a quantidade em estoque Full de um item pelo inventory_id (só
// existe para itens com logística fulfillment). A API do Mercado Livre não
// documenta um jeito de buscar vários de uma vez — uma chamada por item.
async function buscarQuantidadeFull(inventoryId, accessToken) {
  if (!inventoryId) return { quantidade: null, pendente: true, motivo: 'sem_inventory_id' };
  try {
    const stock = await ml.apiGet(`/inventories/${inventoryId}/stock/fulfillment`, accessToken);
    const qtd = stock && (stock.available_quantity !== undefined ? stock.available_quantity : stock.total);
    if (qtd === undefined || qtd === null) return { quantidade: null, pendente: true, motivo: 'sem_dado_na_api' };
    return { quantidade: Number(qtd), pendente: false };
  } catch (err) {
    return { quantidade: null, pendente: true, motivo: 'erro_api' };
  }
}

// Busca os anúncios com logística Full de uma conta do Mercado Livre,
// dentro da janela verificada (offset/limit sobre TODOS os anúncios da
// conta — Full ou não). Retorna:
// { itens (só os Full, com a quantidade quando disponível), verificados
//   (quantos anúncios foram varridos nesta chamada), totalContaGeral
//   (total de anúncios da conta, de qualquer tipo), offset, limit }
async function buscarEstoqueFullDaConta(contaId, { offset = 0, limit = PAGE_SIZE } = {}) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);

  const busca = await ml.apiGet(
    `/users/${conta.ml_user_id}/items/search?offset=${offset}&limit=${limit}`,
    accessToken
  );
  const ids = busca.results || [];
  const totalContaGeral = (busca.paging && busca.paging.total) || ids.length;

  if (!ids.length) return { itens: [], verificados: 0, totalContaGeral, offset, limit };

  const lotes = chunk(ids, MULTIGET_CHUNK);
  const atributos = 'id,title,status,shipping,inventory_id,attributes,variations,seller_custom_field';
  const respostas = await Promise.all(
    lotes.map((lote) => ml.apiGet(`/items?ids=${lote.join(',')}&attributes=${atributos}`, accessToken))
  );

  const itensFull = [];
  respostas.forEach((lote) => {
    (lote || []).forEach((entry) => {
      if (!entry || entry.code !== 200 || !entry.body) return;
      const item = entry.body;
      const logisticType = item.shipping && item.shipping.logistic_type;
      if (logisticType === 'fulfillment') itensFull.push(item);
    });
  });

  const itens = await Promise.all(itensFull.map(async (item) => {
    const resultado = await buscarQuantidadeFull(item.inventory_id, accessToken);
    return {
      id: item.id,
      titulo: item.title || null,
      sku: extrairSku(item),
      loja: conta.nickname || ('Usuário ' + conta.ml_user_id),
      quantidadeFull: resultado.quantidade,
      pendenteQuantidade: resultado.pendente,
      motivoPendenciaQuantidade: resultado.motivo || null,
      status: item.status || null,
    };
  }));

  return { itens, verificados: ids.length, totalContaGeral, offset, limit };
}

// Mesma busca acima, mas percorrendo TODAS as páginas da conta (não só uma
// janela offset/limit) — usado pela tela Estoque, que precisa do total real
// de itens Full para agregar por produto base. Limitada por `maxPaginas`
// como proteção defensiva (evita loop sem fim se a API do Mercado Livre
// devolver um total inconsistente); quando o limite é atingido antes de
// terminar, `truncado: true` avisa que a varredura ficou incompleta — nunca
// finge ter visto tudo.
const MAX_PAGINAS_PADRAO = 200; // 200 x 50 = até 10.000 anúncios verificados

async function buscarEstoqueFullCompletoDaConta(contaId, { maxPaginas = MAX_PAGINAS_PADRAO } = {}) {
  let offset = 0;
  let totalContaGeral = 0;
  let verificadosTotal = 0;
  const itens = [];
  let paginas = 0;
  let truncado = false;

  while (paginas < maxPaginas) {
    const resultado = await buscarEstoqueFullDaConta(contaId, { offset, limit: PAGE_SIZE });
    itens.push(...resultado.itens);
    verificadosTotal += resultado.verificados;
    totalContaGeral = resultado.totalContaGeral;
    paginas += 1;

    if (!resultado.verificados || offset + resultado.verificados >= totalContaGeral) break;
    offset += resultado.verificados;
  }

  if (paginas >= maxPaginas && offset < totalContaGeral) truncado = true;

  return { itens, verificadosTotal, totalContaGeral, truncado };
}

module.exports = { buscarEstoqueFullDaConta, buscarEstoqueFullCompletoDaConta };
