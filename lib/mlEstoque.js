// Estoque com o Mercado Livre como fonte oficial das quantidades (pedido
// explícito do usuário: ele faz todos os lançamentos e ajustes de estoque
// direto no Mercado Livre, o ERP nunca mais aceita ajuste manual — ver
// docs/01-regras-de-negocio.md e docs/02-decisoes.md).
//
// Para cada anúncio/variação de uma conta conectada+ativa, busca a
// quantidade real disponível e grava (upsert, nunca duplica) em
// ml_estoque_itens, separando explicitamente:
//   tipo='full'    -> quantidade armazenada no Full (mesmo recurso já usado
//                      por lib/mlFull.js: /inventories/{inventory_id}/stock/fulfillment).
//   tipo='proprio' -> estoque disponível FORA do Full. Usa o recurso certo
//                      conforme a conta/anúncio:
//                        - se o item/variação tiver user_product_id (conta com
//                          estoque multi-origem / User Products), consulta
//                          GET /user-products/{user_product_id} e tenta ler a
//                          quantidade por location;
//                        - senão, usa available_quantity do item/variação
//                          (recurso simples, documentado, sempre disponível).
//
// IMPORTANTE (ver docs/05-problemas-conhecidos.md): a Devsite oficial do
// Mercado Livre bloqueou a maioria das tentativas de leitura automatizada
// da documentação de User Products/estoque multi-origem nesta etapa (erro
// 403 em quase toda tentativa). Foi confirmado que GET /items/{id} pode
// retornar um campo `user_product_id`, e que existe um recurso de "estoque
// distribuído" para consultar/enviar estoque por User Product — mas o
// FORMATO EXATO da resposta de GET /user-products/{id} (nomes de campo de
// quantidade/locations) não pôde ser confirmado contra a documentação nem
// contra uma conta real. Por isso o parsing abaixo é defensivo: tenta
// alguns formatos plausíveis e, se nenhum bater, cai pro available_quantity
// (quando existir) ou marca pendente — nunca inventa um número. Precisa de
// validação com uma conta real que use esse modelo (ver checklist em
// docs/06-proximos-passos.md).
const pool = require('../db/pool');
const ml = require('./mercadolivre');
const { decrypt } = require('./crypto');
const { getContaComTokenValido } = require('./mlSync');

const PAGE_SIZE = 50;
const MULTIGET_CHUNK = 20;
const MAX_PAGINAS_PADRAO = 200; // mesma proteção defensiva de lib/mlFull.js

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function skuDoItem(item) {
  const attrs = item.attributes || [];
  const skuAttr = attrs.find((a) => a.id === 'SELLER_SKU');
  if (skuAttr && skuAttr.value_name) return skuAttr.value_name;
  if (item.seller_custom_field) return item.seller_custom_field;
  return null;
}

function skuDaVariacao(variation) {
  if (!variation) return null;
  const vAttr = (variation.attributes || []).find((a) => a.id === 'SELLER_SKU');
  if (vAttr && vAttr.value_name) return vAttr.value_name;
  if (variation.seller_custom_field) return variation.seller_custom_field;
  return null;
}

// SKU por variação (nunca o "SKU agregado do item" quando o item tem mais
// de uma variação com SKUs diferentes) — se a própria variação não tiver
// SKU, cai pro SKU do item (caso de item com 1 variação só, sem SKU
// duplicado nela).
function resolverSku(item, variation) {
  if (variation) return skuDaVariacao(variation) || skuDoItem(item);
  return skuDoItem(item);
}

// Quantidade Full de um item (mesma lógica de lib/mlFull.js — arquivo
// deliberadamente separado daquele, mesma razão documentada lá: não
// arriscar alterar uma lógica que já foi validada).
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

// Quantidade via User Products (estoque multi-origem) — ver aviso no topo
// do arquivo sobre o formato de resposta não confirmado. Tenta, em ordem,
// os formatos mais plausíveis descritos/insinuados pela documentação
// (quantidade direta, quantidade dentro de "stock", soma por "locations")
// e só usa o primeiro que encontrar um número de verdade.
async function buscarQuantidadeUserProduct(userProductId, accessToken) {
  if (!userProductId) return { quantidade: null, pendente: true, motivo: 'sem_user_product_id' };
  let resposta;
  try {
    resposta = await ml.apiGet(`/user-products/${userProductId}`, accessToken);
  } catch (err) {
    return { quantidade: null, pendente: true, motivo: 'erro_api_user_products' };
  }

  if (resposta) {
    if (typeof resposta.available_quantity === 'number') {
      return { quantidade: resposta.available_quantity, pendente: false, recurso: 'user_products' };
    }
    if (resposta.stock && typeof resposta.stock.available_quantity === 'number') {
      return { quantidade: resposta.stock.available_quantity, pendente: false, recurso: 'user_products' };
    }
    if (Array.isArray(resposta.locations) && resposta.locations.length) {
      const todasComQuantidade = resposta.locations.every((l) => typeof l.available_quantity === 'number');
      if (todasComQuantidade) {
        const soma = resposta.locations.reduce((s, l) => s + l.available_quantity, 0);
        return { quantidade: soma, pendente: false, recurso: 'user_products' };
      }
    }
  }
  return { quantidade: null, pendente: true, motivo: 'formato_resposta_nao_reconhecido' };
}

// Resolve a quantidade "própria" (fora do Full) de um item/variação,
// escolhendo o recurso certo conforme a conta/anúncio tiver ou não
// user_product_id. Nunca inventa: se o recurso de User Products falhar ou
// vier num formato não reconhecido, tenta o available_quantity como
// segurança (quando a API pelo menos respondeu esse campo básico) antes de
// desistir e marcar pendente.
async function resolverQuantidadeNaoFull(item, variation, accessToken) {
  const userProductId = (variation && variation.user_product_id) || item.user_product_id || null;
  const disponivelSimples = variation
    ? (typeof variation.available_quantity === 'number' ? variation.available_quantity : null)
    : (typeof item.available_quantity === 'number' ? item.available_quantity : null);

  if (userProductId) {
    const resultado = await buscarQuantidadeUserProduct(userProductId, accessToken);
    if (!resultado.pendente) return { ...resultado, userProductId };
    if (disponivelSimples !== null) {
      return {
        quantidade: disponivelSimples,
        pendente: false,
        recurso: 'available_quantity_fallback',
        motivoUserProducts: resultado.motivo,
        userProductId,
      };
    }
    return { ...resultado, userProductId };
  }

  if (disponivelSimples !== null) {
    return { quantidade: disponivelSimples, pendente: false, recurso: 'available_quantity', userProductId: null };
  }
  return { quantidade: null, pendente: true, motivo: 'sem_dado_na_api', userProductId: null };
}

async function upsertLinha(client, linha) {
  await client.query(
    `INSERT INTO ml_estoque_itens
       (conta_ml_id, empresa_id, tipo, ml_item_id, ml_variation_id, titulo, sku, loja, status,
        quantidade, pendente, motivo_pendencia, user_product_id, recurso_usado, sincronizado_em, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now())
     ON CONFLICT (conta_ml_id, ml_item_id, (COALESCE(ml_variation_id, 0)), tipo)
     DO UPDATE SET
       titulo = EXCLUDED.titulo,
       sku = EXCLUDED.sku,
       loja = EXCLUDED.loja,
       status = EXCLUDED.status,
       quantidade = EXCLUDED.quantidade,
       pendente = EXCLUDED.pendente,
       motivo_pendencia = EXCLUDED.motivo_pendencia,
       user_product_id = EXCLUDED.user_product_id,
       recurso_usado = EXCLUDED.recurso_usado,
       sincronizado_em = now(),
       updated_at = now()`,
    [
      linha.contaId, linha.empresaId, linha.tipo, linha.mlItemId, linha.mlVariationId,
      linha.titulo, linha.sku, linha.loja, linha.status,
      linha.quantidade, linha.pendente, linha.motivoPendencia, linha.userProductId, linha.recursoUsado,
    ]
  );
}

async function processarItem(client, item, conta, accessToken) {
  const logisticType = item.shipping && item.shipping.logistic_type;
  const isFull = logisticType === 'fulfillment';
  const variacoes = item.variations && item.variations.length ? item.variations : [null];
  const loja = conta.nickname || ('Usuário ' + conta.ml_user_id);

  for (const variacao of variacoes) {
    const sku = resolverSku(item, variacao);
    let resultado;
    if (isFull) {
      const r = await buscarQuantidadeFull(item.inventory_id, accessToken);
      resultado = {
        quantidade: r.quantidade,
        pendente: r.pendente,
        motivoPendencia: r.motivo || null,
        recursoUsado: r.pendente ? null : 'full_inventory',
        userProductId: null,
      };
    } else {
      const r = await resolverQuantidadeNaoFull(item, variacao, accessToken);
      resultado = {
        quantidade: r.quantidade,
        pendente: r.pendente,
        motivoPendencia: r.motivo || null,
        recursoUsado: r.pendente ? null : r.recurso,
        userProductId: r.userProductId || null,
      };
    }

    await upsertLinha(client, {
      contaId: conta.id,
      empresaId: conta.empresa_id,
      tipo: isFull ? 'full' : 'proprio',
      mlItemId: item.id,
      mlVariationId: variacao ? variacao.id : null,
      titulo: item.title || null,
      sku,
      loja,
      status: item.status || null,
      ...resultado,
    });
  }
}

// Varre TODOS os anúncios da conta (paginado, mesma proteção defensiva de
// lib/mlFull.js — maxPaginas evita loop sem fim) e grava/atualiza cada
// linha em ml_estoque_itens. Nunca mistura contas/empresas: cada linha
// carrega o conta_ml_id/empresa_id da própria conta sincronizada.
async function sincronizarEstoqueConta(contaId, { maxPaginas = MAX_PAGINAS_PADRAO } = {}) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);

  let offset = 0;
  let totalContaGeral = 0;
  let verificadosTotal = 0;
  let paginas = 0;
  let truncado = false;
  const client = await pool.connect();

  try {
    while (paginas < maxPaginas) {
      const busca = await ml.apiGet(
        `/users/${conta.ml_user_id}/items/search?offset=${offset}&limit=${PAGE_SIZE}`,
        accessToken
      );
      const ids = busca.results || [];
      totalContaGeral = (busca.paging && busca.paging.total) || ids.length;
      paginas += 1;
      if (!ids.length) break;

      const lotes = chunk(ids, MULTIGET_CHUNK);
      const atributos = 'id,title,status,shipping,inventory_id,attributes,variations,seller_custom_field,available_quantity,user_product_id';
      const respostas = await Promise.all(
        lotes.map((lote) => ml.apiGet(`/items?ids=${lote.join(',')}&attributes=${atributos}`, accessToken))
      );

      const itensDaPagina = [];
      respostas.forEach((lote) => {
        (lote || []).forEach((entry) => {
          if (entry && entry.code === 200 && entry.body) itensDaPagina.push(entry.body);
        });
      });

      for (const item of itensDaPagina) {
        await processarItem(client, item, conta, accessToken);
      }

      verificadosTotal += ids.length;
      if (offset + ids.length >= totalContaGeral) break;
      offset += ids.length;
    }
  } finally {
    client.release();
  }

  if (paginas >= maxPaginas && offset < totalContaGeral) truncado = true;

  return { verificadosTotal, totalContaGeral, truncado };
}

module.exports = {
  sincronizarEstoqueConta,
  // exportadas só para teste automatizado (sem precisar de banco/API real)
  resolverQuantidadeNaoFull,
  buscarQuantidadeUserProduct,
  buscarQuantidadeFull,
  resolverSku,
};
