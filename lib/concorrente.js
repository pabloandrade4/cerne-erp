// Análise de Concorrente — pedido explícito do usuário (19/09/2026):
// "quero que pesquise os modelos de produtos que eu vendo e me entregue um
// relatório de preços mas só quero daqueles concorrentes que estão
// vendendo".
//
// PRIMEIRA integração deste projeto contra a busca pública do Mercado
// Livre — ainda NÃO testada contra a API de verdade (este ambiente de
// desenvolvimento não tem acesso à internet para api.mercadolibre.com, só
// pôde ser escrita seguindo a documentação pública,
// developers.mercadolivre.com.br). Se algum nome de campo tiver mudado, o
// erro aparece no resultado da busca (`err.status`/`err.message`, ver
// lib/mercadolivre.js#apiGet) — nunca falha silenciosamente nem inventa um
// concorrente/preço que a API não devolveu. Mesmo espírito de
// lib/ia/sacMercadoLivre.js (primeira integração daquele agente também foi
// assim).
//
// Como funciona, pra cada produto seu:
//   1) Nunca inventa um termo de busca: usa o ANÚNCIO REAL mais recente que
//      já vendeu esse SKU (ml_pedido_itens) — sem venda nenhuma registrada
//      por esse SKU, não tem base pra pesquisar nada (modo 'sem_dado').
//   2) Se esse anúncio pertencer a um CATÁLOGO do Mercado Livre
//      (catalog_product_id), busca os outros vendedores do MESMO catálogo —
//      é o próprio Mercado Livre garantindo que é o mesmo produto, não uma
//      aproximação (modo 'catalogo', confiança alta).
//   3) Sem catálogo (o mais comum pra caixa de papelão sob medida, que não
//      tem código de barras/GTIN) — busca pelo TÍTULO real do seu anúncio e
//      devolve os resultados como CANDIDATOS, nunca como certeza: você
//      confirma quais são de fato o mesmo produto antes de considerar
//      "concorrente" de verdade (modo 'busca_por_titulo', confiança
//      candidato_a_confirmar).
// Em qualquer modo, só entram vendedores REALMENTE vendendo agora
// (status ativo + estoque disponível > 0, e nunca o seu próprio anúncio) —
// "só quero daqueles concorrentes que estão vendendo" (pedido explícito).
const pool = require('../db/pool');
const { decrypt } = require('./crypto');
const ml = require('./mercadolivre');
const { getContaComTokenValido } = require('./mlSync');

const MAX_CANDIDATOS = 10;
const SITE_ID = 'MLB';

// Anúncio real mais recente que já vendeu esse SKU — join até ml_contas
// porque ml_pedidos não guarda empresa_id direto (só via a conta).
async function buscarItemBaseDoProduto(empresaId, sku) {
  const { rows } = await pool.query(
    `SELECT pi.ml_item_id, pi.titulo, pi.preco_unitario, mc.id AS conta_id, mc.ml_user_id
       FROM ml_pedido_itens pi
       JOIN ml_pedidos p ON p.id = pi.pedido_id
       JOIN ml_contas mc ON mc.id = p.conta_ml_id
      WHERE mc.empresa_id = $1 AND pi.sku = $2 AND pi.ml_item_id IS NOT NULL
      ORDER BY p.data_criacao DESC NULLS LAST
      LIMIT 1`,
    [empresaId, sku]
  );
  return rows.length ? rows[0] : null;
}

// Produtos elegíveis pra varredura AUTOMÁTICA de concorrente (19/09/2026,
// pedido explícito do usuário: "quero que essas ia nunca pare de
// trabalhar... sempre buscar concorrentes que estão vendendo o mesmo
// produto que eu" — ver lib/ia/radarConcorrente.js, que chama a rota
// GET /api/concorrente/buscar internamente pra cada um destes produtos,
// 1x por dia). Mesmo critério do modo 'sem_dado' desta rota: só entra quem
// JÁ tem pelo menos 1 venda real registrada pelo Mercado Livre (sem isso
// não haveria termo de busca real pra usar, e o próprio
// buscarConcorrentesPorProduto devolveria 'sem_dado' de qualquer jeito) —
// aqui já filtramos ANTES pra nunca gastar uma chamada de API à toa. Limite
// (`limite`) existe só pra nunca deixar uma empresa com catálogo enorme
// estourar o rate limit do Mercado Livre num único ciclo — prioriza quem
// vendeu mais recentemente (mais relevante agora).
async function listarProdutosElegiveisParaVarredura(empresaId, { limite = 40 } = {}) {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.sku, MAX(pe.data_criacao) AS ultima_venda_em
       FROM produtos p
       JOIN ml_pedido_itens pi ON pi.sku = p.sku
       JOIN ml_pedidos pe ON pe.id = pi.pedido_id
       JOIN ml_contas mc ON mc.id = pe.conta_ml_id AND mc.empresa_id = p.empresa_id
      WHERE p.empresa_id = $1 AND p.ativo = TRUE AND pi.ml_item_id IS NOT NULL
      GROUP BY p.id, p.nome, p.sku
      ORDER BY ultima_venda_em DESC NULLS LAST
      LIMIT $2`,
    [empresaId, limite]
  );
  return rows;
}

function estaRealmenteVendendo(item) {
  const status = item && (item.status || (item.item && item.item.status));
  const disponivel = item && (item.available_quantity !== undefined ? item.available_quantity : (item.item && item.item.available_quantity));
  if (status !== undefined && status !== null && status !== 'active') return false;
  if (disponivel !== undefined && disponivel !== null && Number(disponivel) <= 0) return false;
  return true;
}

// Modo 1: outros vendedores do MESMO produto de catálogo — maior confiança
// possível, porque quem garante "é o mesmo produto" é o próprio Mercado
// Livre, não uma aproximação de texto. Formato da resposta desta rota
// (/products/{id}/items) segue a documentação pública; se vier diferente do
// esperado, devolve lista vazia (nunca um dado inventado) e quem chamou cai
// pro modo de busca por título.
async function buscarCandidatosPorCatalogo({ catalogProductId, accessToken, meuMlUserId }) {
  try {
    const resposta = await ml.apiGet(`/products/${catalogProductId}/items?site_id=${SITE_ID}`, accessToken);
    const resultados = (resposta && (resposta.results || resposta.items)) || [];
    return resultados
      .filter((r) => String((r && (r.seller_id || (r.seller && r.seller.id))) || '') !== String(meuMlUserId))
      .filter(estaRealmenteVendendo)
      .slice(0, MAX_CANDIDATOS)
      .map((r) => ({
        titulo: r.title || null,
        preco: r.price !== undefined && r.price !== null ? Number(r.price) : null,
        vendedorNickname: (r.seller && r.seller.nickname) || null,
        estoqueDisponivel: r.available_quantity !== undefined && r.available_quantity !== null ? Number(r.available_quantity) : null,
        permalink: r.permalink || null,
        confianca: 'catalogo',
      }));
  } catch (err) {
    console.error('[Concorrente] catálogo falhou, caindo pra busca por título:', err && err.message);
    return [];
  }
}

// Modo 2: busca pública por texto — candidatos, nunca certeza. Formato de
// /sites/{site}/search segue a documentação pública.
async function buscarCandidatosPorTitulo({ termoBusca, accessToken, meuMlUserId }) {
  const resposta = await ml.apiGet(`/sites/${SITE_ID}/search?q=${encodeURIComponent(termoBusca)}&limit=${MAX_CANDIDATOS * 2}`, accessToken);
  const resultados = (resposta && resposta.results) || [];
  return resultados
    .filter((r) => String((r && (r.seller_id || (r.seller && r.seller.id))) || '') !== String(meuMlUserId))
    .filter(estaRealmenteVendendo)
    .slice(0, MAX_CANDIDATOS)
    .map((r) => ({
      titulo: r.title || null,
      preco: r.price !== undefined && r.price !== null ? Number(r.price) : null,
      vendedorNickname: (r.seller && r.seller.nickname) || null,
      estoqueDisponivel: r.available_quantity !== undefined && r.available_quantity !== null ? Number(r.available_quantity) : null,
      permalink: r.permalink || null,
      confianca: 'candidato_a_confirmar',
    }));
}

async function buscarConcorrentesPorProduto({ empresaId, produtoId }) {
  const { rows: produtoRows } = await pool.query(
    'SELECT id, nome, sku FROM produtos WHERE id = $1 AND empresa_id = $2',
    [produtoId, empresaId]
  );
  if (!produtoRows.length) {
    const err = new Error('Produto não encontrado.');
    err.status = 404;
    throw err;
  }
  const produto = produtoRows[0];

  const itemBase = await buscarItemBaseDoProduto(empresaId, produto.sku);
  if (!itemBase) {
    return {
      modo: 'sem_dado', motivo: 'nunca_vendido_no_ml',
      mensagem: 'Este produto ainda não tem nenhuma venda registrada pelo Mercado Livre — sem um anúncio real pra usar de referência, não dá pra pesquisar concorrente sem inventar um termo de busca.',
      produto, concorrentes: [], buscadoEm: new Date().toISOString(),
    };
  }

  let accessToken;
  try {
    const contaComTokenValido = await getContaComTokenValido(itemBase.conta_id);
    accessToken = decrypt(contaComTokenValido.access_token_enc);
  } catch (err) {
    return {
      modo: 'sem_dado', motivo: 'token_invalido',
      mensagem: 'Não foi possível renovar/ler o token de acesso da conta do Mercado Livre — a conexão pode precisar ser refeita em Integrações.',
      produto, concorrentes: [], buscadoEm: new Date().toISOString(),
    };
  }

  // Detalhe AO VIVO do anúncio (título atual + se é de catálogo) — nunca só
  // o que ficou salvo em ml_pedido_itens na época da venda, que pode estar
  // desatualizado ou o anúncio já ter sido encerrado.
  let catalogProductId = null;
  let tituloAtual = itemBase.titulo;
  try {
    const itemAtual = await ml.apiGet(`/items/${itemBase.ml_item_id}`, accessToken);
    if (itemAtual) {
      catalogProductId = itemAtual.catalog_product_id || null;
      tituloAtual = itemAtual.title || tituloAtual;
    }
  } catch (err) {
    console.error('[Concorrente] não foi possível buscar o anúncio atual, seguindo com o título salvo na venda:', err && err.message);
  }

  if (!tituloAtual) {
    return {
      modo: 'sem_dado', motivo: 'sem_titulo_de_referencia',
      mensagem: 'Não foi possível obter um título real de anúncio pra usar como referência de busca.',
      produto, concorrentes: [], buscadoEm: new Date().toISOString(),
    };
  }

  let concorrentes = [];
  let modo = 'busca_por_titulo';
  if (catalogProductId) {
    concorrentes = await buscarCandidatosPorCatalogo({ catalogProductId, accessToken, meuMlUserId: itemBase.ml_user_id });
    if (concorrentes.length) modo = 'catalogo';
  }
  if (!concorrentes.length) {
    modo = 'busca_por_titulo';
    // Correção (20/09/2026, o usuário reportou "erro interno do servidor"
    // na tela — log real de produção confirmou: era exatamente este ponto
    // que não tinha try/catch, e o 403 do Mercado Livre subia sem ser
    // pego, virando um 500 genérico pro usuário, sem explicar nada). O
    // endpoint /sites/{site}/search está bloqueado pra aplicativos de
    // terceiros de forma ampla (não é um bug daqui — ver 02-decisoes.md
    // (46) e 04-alteracoes.md (49)); enquanto isso não muda, a tela
    // precisa mostrar isso com clareza em vez de quebrar.
    try {
      concorrentes = await buscarCandidatosPorTitulo({ termoBusca: tituloAtual, accessToken, meuMlUserId: itemBase.ml_user_id });
    } catch (err) {
      const bloqueadoPeloMl = err && err.status === 403;
      return {
        modo: 'busca_bloqueada',
        motivo: bloqueadoPeloMl ? 'busca_por_titulo_bloqueada_pelo_ml' : 'erro_ao_buscar',
        mensagem: bloqueadoPeloMl
          ? 'O Mercado Livre está recusando (403 Forbidden) a busca por título pra aplicativos de terceiros no momento — não é um problema deste sistema, é uma restrição da própria plataforma. Enquanto isso não muda do lado do Mercado Livre, essa forma de buscar concorrente não funciona.'
          : 'Não foi possível concluir a busca de concorrentes agora.',
        erroOriginal: (err && err.data) || (err && err.message) || null,
        produto,
        itemBase: {
          mlItemId: itemBase.ml_item_id, titulo: tituloAtual,
          precoUltimaVenda: itemBase.preco_unitario !== null && itemBase.preco_unitario !== undefined ? Number(itemBase.preco_unitario) : null,
        },
        concorrentes: [],
        buscadoEm: new Date().toISOString(),
      };
    }
  }

  return {
    modo,
    produto,
    // `precoUltimaVenda` (19/09/2026, pedido explícito do usuário: varredura
    // automática precisa comparar com ALGUM preço seu real — nunca uma
    // estimativa) vem do ÚLTIMO PEDIDO de verdade (ml_pedido_itens), nunca
    // do preço atual do anúncio (que esta rota não tem acesso de escrita
    // nem motivo pra consultar de novo aqui) — por isso o rótulo em
    // qualquer tela sempre precisa deixar claro que é "sua última venda",
    // não "seu preço atual".
    itemBase: {
      mlItemId: itemBase.ml_item_id, titulo: tituloAtual,
      precoUltimaVenda: itemBase.preco_unitario !== null && itemBase.preco_unitario !== undefined ? Number(itemBase.preco_unitario) : null,
    },
    concorrentes,
    buscadoEm: new Date().toISOString(),
  };
}

// ============================================================================
// TESTE de viabilidade — monitorar concorrente pelo link da LOJA (20/09/2026)
// ============================================================================
// Pedido explícito do usuário, depois do bloqueio de /sites/{site}/search
// (ver comentário no topo do arquivo): "eu posso te passar o link da loja
// dos concorrentes mas você não tem que ir sempre olhando pra me avisar não
// tem como eu te manda[r] o link" — ou seja, ele quer dar o link da loja UMA
// VEZ e o sistema acompanhar sozinho depois, não ficar mandando link de
// anúncio toda vez.
//
// Antes de construir essa funcionalidade inteira, esta função só TESTA, com
// uma chamada real, se o caminho técnico proposto funciona:
//   1) GET /items/{item_id} — pega o seller_id (dono da loja) a partir de UM
//      anúncio real dessa loja (link que o usuário mandou já trazia um
//      item_id na URL). Este endpoint já é usado em produção (linha ~181
//      acima), então sabemos que funciona.
//   2) GET /users/{seller_id}/items/search — lista os anúncios ATIVOS desse
//      vendedor pelo ID dele. Esse é o endpoint DIFERENTE do que está
//      bloqueado (/sites/{site}/search) — ainda não confirmado contra a API
//      de verdade, por isso este teste existe.
// Só leitura, nunca escreve nada. Se qualquer etapa falhar, devolve o motivo
// exato (nunca esconde o erro real da API) — é assim que vamos saber se dá
// pra construir o monitoramento automático em cima disso ou não.
function extrairItemIdDeLink(urlOuTexto) {
  const texto = String(urlOuTexto || '');
  const doParam = texto.match(/[?&]item_id=(MLB-?\d+)/i);
  if (doParam) return doParam[1].replace('-', '').toUpperCase();
  const doTexto = texto.match(/\b(MLB-?\d{6,})\b/i);
  if (doTexto) return doTexto[1].replace('-', '').toUpperCase();
  return null;
}

async function buscarContaMlAtivaDaEmpresa(empresaId) {
  const { rows } = await pool.query(
    "SELECT id FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1",
    [empresaId]
  );
  return rows.length ? rows[0].id : null;
}

async function testarListagemPorVendedor({ empresaId, url }) {
  const itemId = extrairItemIdDeLink(url);
  if (!itemId) {
    return { ok: false, etapa: 'extrair_item_id', mensagem: 'Não encontrei um item_id (ex.: MLB4712675795) no link informado — cole o link completo do anúncio ou da loja, com o item_id na URL.' };
  }

  const contaId = await buscarContaMlAtivaDaEmpresa(empresaId);
  if (!contaId) {
    return { ok: false, etapa: 'conta_ml', mensagem: 'Nenhuma conta do Mercado Livre ativa encontrada pra essa empresa.' };
  }

  let accessToken;
  try {
    const conta = await getContaComTokenValido(contaId);
    accessToken = decrypt(conta.access_token_enc);
  } catch (err) {
    return { ok: false, etapa: 'token', mensagem: 'Não foi possível obter um token válido da conta do Mercado Livre — pode ser necessário reconectar em Integrações.', erro: err && err.message };
  }

  let item;
  try {
    item = await ml.apiGet(`/items/${itemId}`, accessToken);
  } catch (err) {
    return { ok: false, etapa: 'buscar_item', itemId, mensagem: 'A API do Mercado Livre recusou a consulta desse anúncio.', status: err && err.status, erro: (err && err.data) || (err && err.message) };
  }

  const sellerId = (item && item.seller_id) || (item && item.seller && item.seller.id) || null;
  if (!sellerId) {
    return { ok: false, etapa: 'seller_id', itemId, mensagem: 'O anúncio foi encontrado, mas a resposta não trouxe o ID do vendedor.', itemBruto: item };
  }

  let listagem;
  try {
    listagem = await ml.apiGet(`/users/${sellerId}/items/search?status=active&limit=20`, accessToken);
  } catch (err) {
    return {
      ok: false, etapa: 'listar_itens_do_vendedor', itemId, sellerId,
      mensagem: 'Deu pra identificar o vendedor, mas o Mercado Livre recusou listar os anúncios dele por esse caminho.',
      status: err && err.status, erro: (err && err.data) || (err && err.message),
    };
  }

  const idsRetornados = (listagem && listagem.results) || [];
  return {
    ok: true,
    itemId,
    sellerId,
    vendedorNickname: (item.seller && item.seller.nickname) || null,
    totalAnunciosAtivos: (listagem && listagem.paging && listagem.paging.total) || idsRetornados.length,
    quantidadeRetornadaNestaChamada: idsRetornados.length,
    algunsIdsRetornados: idsRetornados.slice(0, 10),
    mensagem: 'Funcionou: deu pra listar os anúncios ativos desse vendedor só a partir do ID dele — esse caminho não depende da busca por título que está bloqueada.',
  };
}

module.exports = {
  buscarConcorrentesPorProduto, listarProdutosElegiveisParaVarredura,
  testarListagemPorVendedor,
};
