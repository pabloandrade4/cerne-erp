// Radar de Concorrentes (21/09/2026) — pedido explícito do usuário, com um
// mockup de referência visual (pf_radar_concorrentes_v2.html): "Quero
// adicionar ao sistema a nova área Radar de Concorrentes... Preciso
// conseguir cadastrar: nome do concorrente, link do anúncio, SKU
// relacionado, marketplace. Depois de cadastrado, o sistema deve monitorar
// preço, promoção, foto de capa, título, frete e outras mudanças do
// anúncio, salvando histórico e gerando alertas."
//
// Ver comentário grande em db/schema.sql (tabela radar_concorrentes) pra
// entender por que isso é DIFERENTE de concorrentes_monitorados (só link,
// nunca busca nada) e de lib/ia/radarConcorrente.js (descoberta automática
// de OUTROS vendedores, só compara preço, sem histórico). Aqui o usuário dá
// o link de UM anúncio específico e o sistema acompanha ESSE anúncio ao
// longo do tempo.
//
// Só funciona monitoramento automático de verdade para Mercado Livre nesta
// versão — é a única plataforma onde este projeto já confirmou (ver
// lib/concorrente.js#testarListagemPorVendedor e o comentário atualizado em
// lib/mercadolivre.js#apiGetPublico) que dá pra buscar um anúncio público
// pelo ID sem bloqueio. Shopee/TikTok Shop podem ser cadastrados (o
// formulário do mockup oferece as 3 opções), mas ficam com
// monitoramento_automatico=false — nunca finge que leu um dado que não
// buscou de verdade.
const pool = require('../db/pool');
const ml = require('./mercadolivre');

const MARKETPLACES_VALIDOS = ['mercado_livre', 'shopee', 'tiktok_shop'];
const MARKETPLACE_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop' };

// Extrai um item_id do Mercado Livre (ex.: MLB4712675795) de um link ou
// texto. Cópia PROPOSITALMENTE pequena e local da mesma regra já usada em
// lib/concorrente.js#extrairItemIdDeLink — não importada de lá: este
// arquivo evita qualquer acoplamento com lib/concorrente.js, depois da
// experiência real deste projeto (21/09/2026) de um arquivo custar várias
// tentativas pra subir corretamente pro GitHub pelo fluxo manual de upload
// (ver docs/05-problemas-conhecidos.md) — copiar essas poucas linhas é bem
// mais barato do que arriscar esse acoplamento de novo.
function extrairItemIdML(urlOuTexto) {
  const texto = String(urlOuTexto || '');
  const doParam = texto.match(/[?&]item_id=(MLB-?\d+)/i);
  if (doParam) return doParam[1].replace('-', '').toUpperCase();
  const doTexto = texto.match(/\b(MLB-?\d{6,})\b/i);
  if (doTexto) return doTexto[1].replace('-', '').toUpperCase();
  return null;
}

function validarCadastro({ nomeConcorrente, linkAnuncio, sku, marketplace }) {
  if (!nomeConcorrente || !String(nomeConcorrente).trim()) {
    const err = new Error('Informe o nome do concorrente.'); err.status = 400; throw err;
  }
  if (!linkAnuncio || !String(linkAnuncio).trim()) {
    const err = new Error('Informe o link do anúncio.'); err.status = 400; throw err;
  }
  if (!sku || !String(sku).trim()) {
    const err = new Error('Informe o SKU relacionado.'); err.status = 400; throw err;
  }
  const marketplaceNormalizado = String(marketplace || '').trim();
  if (!MARKETPLACES_VALIDOS.includes(marketplaceNormalizado)) {
    const err = new Error('Marketplace inválido — use mercado_livre, shopee ou tiktok_shop.'); err.status = 400; throw err;
  }
}

// Lê o anúncio no Mercado Livre AGORA e devolve os campos reais que este
// Radar acompanha — nunca inventa nenhum deles. `sold_quantity` é campo
// real da API pública (ver db/schema.sql), mas é aproximado/arredondado
// pelo próprio Mercado Livre — não é este sistema que aproxima.
async function lerAnuncioMercadoLivre(itemId) {
  const item = await ml.apiGetPublico(`/items/${itemId}`);
  const precoOriginal = (item.original_price !== undefined && item.original_price !== null) ? Number(item.original_price) : null;
  const preco = (item.price !== undefined && item.price !== null) ? Number(item.price) : null;
  return {
    titulo: item.title || null,
    preco,
    precoOriginal,
    emPromocao: precoOriginal !== null && preco !== null && precoOriginal > preco,
    imagemUrl: item.secure_thumbnail || item.thumbnail || null,
    statusAnuncio: item.status || null,
    freteTipo: (item.shipping && item.shipping.logistic_type) || null,
    freteGratis: Boolean(item.shipping && item.shipping.free_shipping),
    vendidosTotal: (item.sold_quantity !== undefined && item.sold_quantity !== null) ? Number(item.sold_quantity) : null,
  };
}

async function ultimaLeituraOk(radarConcorrenteId) {
  const { rows } = await pool.query(
    `SELECT * FROM radar_concorrentes_leituras
      WHERE radar_concorrente_id = $1 AND ok = TRUE
      ORDER BY lido_em DESC LIMIT 1`,
    [radarConcorrenteId]
  );
  return rows.length ? rows[0] : null;
}

// Calcula "vendas/dia estimadas" comparando a leitura atual com a última
// leitura bem-sucedida anterior — NUNCA vem direto da API (ver comentário
// grande em db/schema.sql). Só calcula quando: existe leitura anterior,
// ambas trouxeram vendidosTotal, o total não caiu (o Mercado Livre não
// devolve um sold_quantity decrescente em uso normal — uma queda indica
// dado inconsistente, e aí é mais honesto não estimar nada) e já passou
// pelo menos meio dia entre as duas leituras (evita uma estimativa
// exagerada por causa de duas leituras muito próximas).
function calcularVendasDiaEstimado(leituraAnterior, vendidosTotalAgora, agora) {
  if (!leituraAnterior || leituraAnterior.vendidos_total === null || leituraAnterior.vendidos_total === undefined) return null;
  if (vendidosTotalAgora === null || vendidosTotalAgora === undefined) return null;
  const diferenca = vendidosTotalAgora - Number(leituraAnterior.vendidos_total);
  if (diferenca < 0) return null;
  const diasDecorridos = (agora.getTime() - new Date(leituraAnterior.lido_em).getTime()) / 86400000;
  if (diasDecorridos < 0.5) return null;
  return Math.round((diferenca / diasDecorridos) * 100) / 100;
}

function formatarMoedaSimples(v) {
  if (v === null || v === undefined) return '—';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Gera os alertas de diferença entre a leitura anterior e a atual (só
// quando as duas foram bem-sucedidas) — é o "gerando alertas" pedido pelo
// usuário. Cada alerta cita o dado real antes/depois, nunca um texto solto.
function gerarAlertas({ leituraAnterior, atual, nomeConcorrente }) {
  if (!leituraAnterior) return []; // primeira leitura: nada pra comparar ainda
  const alertas = [];

  if (leituraAnterior.preco !== null && atual.preco !== null && Number(leituraAnterior.preco) !== Number(atual.preco)) {
    const antes = Number(leituraAnterior.preco);
    const depois = Number(atual.preco);
    const variacaoPct = antes > 0 ? Math.round(((depois - antes) / antes) * 1000) / 10 : null;
    const caiu = depois < antes;
    alertas.push({
      tipo: 'preco',
      severidade: caiu ? 'atencao' : 'informativo',
      mensagem: `${nomeConcorrente} ${caiu ? 'reduziu' : 'aumentou'} o preço de ${formatarMoedaSimples(antes)} para ${formatarMoedaSimples(depois)}`
        + (variacaoPct !== null ? ` (${caiu ? '' : '+'}${variacaoPct}%)` : '') + '.',
    });
  }

  if (Boolean(leituraAnterior.em_promocao) !== Boolean(atual.emPromocao)) {
    alertas.push({
      tipo: 'promocao',
      severidade: atual.emPromocao ? 'atencao' : 'informativo',
      mensagem: `${nomeConcorrente} ${atual.emPromocao ? 'entrou em promoção' : 'saiu de promoção'}${atual.emPromocao && atual.preco !== null ? ` — preço promocional em ${formatarMoedaSimples(atual.preco)}` : ''}.`,
    });
  }

  if ((leituraAnterior.imagem_url || null) !== (atual.imagemUrl || null)) {
    alertas.push({ tipo: 'foto', severidade: 'informativo', mensagem: `${nomeConcorrente} trocou a foto de capa do anúncio.` });
  }

  if ((leituraAnterior.titulo || null) !== (atual.titulo || null)) {
    alertas.push({ tipo: 'titulo', severidade: 'informativo', mensagem: `${nomeConcorrente} alterou o título do anúncio.` });
  }

  const freteAnterior = { tipo: leituraAnterior.frete_tipo || null, gratis: Boolean(leituraAnterior.frete_gratis) };
  const freteAtual = { tipo: atual.freteTipo || null, gratis: Boolean(atual.freteGratis) };
  if (freteAnterior.tipo !== freteAtual.tipo || freteAnterior.gratis !== freteAtual.gratis) {
    alertas.push({
      tipo: 'frete',
      severidade: (!freteAnterior.gratis && freteAtual.gratis) ? 'atencao' : 'informativo',
      mensagem: `${nomeConcorrente} alterou o frete do anúncio${freteAtual.gratis ? ' — agora com frete grátis' : ''}.`,
    });
  }

  if ((leituraAnterior.status_anuncio || null) !== (atual.statusAnuncio || null)) {
    const critico = atual.statusAnuncio === 'closed';
    alertas.push({
      tipo: 'status',
      severidade: critico ? 'oportunidade' : 'informativo',
      mensagem: `${nomeConcorrente} mudou o status do anúncio de "${leituraAnterior.status_anuncio || '—'}" para "${atual.statusAnuncio || '—'}"${critico ? ' (anúncio encerrado)' : ''}.`,
    });
  }

  return alertas;
}

// Faz uma leitura real do anúncio de UM concorrente cadastrado, salva o
// histórico e gera os alertas de diferença — usada tanto no cadastro
// (primeira leitura) quanto no ciclo automático (lib/ia/radarConcorrentesScheduler.js).
// Nunca lança pra quem chama: erros de leitura viram uma linha ok=false no
// histórico (mesmo espírito de lib/whatsapp.js/lib/telegram.js — nunca
// derruba o resto do ciclo por causa de uma falha isolada).
async function executarLeituraDeUmConcorrente(radarConcorrente) {
  const agora = new Date();
  if (!radarConcorrente.monitoramento_automatico || !radarConcorrente.ml_item_id) {
    return { pulou: true, motivo: 'sem_monitoramento_automatico' };
  }

  const leituraAnteriorPromise = ultimaLeituraOk(radarConcorrente.id);
  let dados;
  let erro = null;
  try {
    dados = await lerAnuncioMercadoLivre(radarConcorrente.ml_item_id);
  } catch (err) {
    erro = (err && err.data && (err.data.message || err.data.error)) || (err && err.message) || 'Falha desconhecida ao consultar o Mercado Livre.';
  }

  const leituraAnterior = await leituraAnteriorPromise;

  if (erro) {
    const { rows } = await pool.query(
      `INSERT INTO radar_concorrentes_leituras (radar_concorrente_id, lido_em, ok, erro)
       VALUES ($1, $2, FALSE, $3) RETURNING *`,
      [radarConcorrente.id, agora, erro]
    );
    return { pulou: false, ok: false, leitura: rows[0], alertas: [] };
  }

  const vendasDiaEstimado = calcularVendasDiaEstimado(leituraAnterior, dados.vendidosTotal, agora);

  const { rows } = await pool.query(
    `INSERT INTO radar_concorrentes_leituras
       (radar_concorrente_id, lido_em, ok, titulo, preco, preco_original, em_promocao,
        imagem_url, status_anuncio, frete_tipo, frete_gratis, vendidos_total, vendas_dia_estimado)
     VALUES ($1,$2,TRUE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      radarConcorrente.id, agora, dados.titulo, dados.preco, dados.precoOriginal, dados.emPromocao,
      dados.imagemUrl, dados.statusAnuncio, dados.freteTipo, dados.freteGratis, dados.vendidosTotal, vendasDiaEstimado,
    ]
  );
  const leituraSalva = rows[0];

  const alertasGerados = gerarAlertas({ leituraAnterior, atual: dados, nomeConcorrente: radarConcorrente.nome_concorrente });
  for (const alerta of alertasGerados) {
    await pool.query(
      `INSERT INTO radar_concorrentes_alertas (radar_concorrente_id, leitura_id, tipo, severidade, mensagem)
       VALUES ($1,$2,$3,$4,$5)`,
      [radarConcorrente.id, leituraSalva.id, alerta.tipo, alerta.severidade, alerta.mensagem]
    );
  }

  return { pulou: false, ok: true, leitura: leituraSalva, alertas: alertasGerados };
}

// Cadastra um novo concorrente monitorado e, quando dá pra monitorar
// automaticamente (Mercado Livre com item_id reconhecido), já faz a
// primeira leitura na hora — é o que o mockup descreve: "Ao salvar, o
// sistema deve buscar a foto de capa, título, preço atual e demais dados
// públicos do anúncio e começar a registrar alterações." Se a primeira
// leitura falhar, o cadastro continua válido mesmo assim (fica registrado
// com ok=false no histórico) — nunca bloqueia o cadastro por causa disso.
async function cadastrarConcorrente({ empresaId, nomeConcorrente, linkAnuncio, sku, marketplace }) {
  validarCadastro({ nomeConcorrente, linkAnuncio, sku, marketplace });
  const itemId = marketplace === 'mercado_livre' ? extrairItemIdML(linkAnuncio) : null;
  const monitoramentoAutomatico = Boolean(itemId);

  const { rows } = await pool.query(
    `INSERT INTO radar_concorrentes (empresa_id, sku, nome_concorrente, marketplace, link_anuncio, ml_item_id, monitoramento_automatico)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [Number(empresaId), String(sku).trim(), String(nomeConcorrente).trim(), marketplace, String(linkAnuncio).trim(), itemId, monitoramentoAutomatico]
  );
  const registro = rows[0];

  let primeiraLeitura = null;
  if (monitoramentoAutomatico) {
    try { primeiraLeitura = await executarLeituraDeUmConcorrente(registro); }
    catch (e) { /* nunca derruba o cadastro por causa da primeira leitura — ver comentário acima */ }
  }

  return { ...registro, primeiraLeitura };
}

async function desativarConcorrente({ empresaId, id }) {
  const { rows } = await pool.query(
    `UPDATE radar_concorrentes SET ativo = FALSE, atualizado_em = now()
      WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    [Number(id), Number(empresaId)]
  );
  if (!rows.length) { const err = new Error('Concorrente monitorado não encontrado.'); err.status = 404; throw err; }
  return { ok: true };
}

// Lista os concorrentes cadastrados junto com a última leitura de cada um
// (LATERAL join) — é a tabela "Concorrentes cadastrados" do mockup.
async function listarConcorrentesComUltimaLeitura({ empresaId, apenasAtivos = true }) {
  const { rows } = await pool.query(
    `SELECT rc.*, l.lido_em, l.ok AS leitura_ok, l.erro AS leitura_erro, l.titulo, l.preco, l.preco_original,
            l.em_promocao, l.imagem_url, l.status_anuncio, l.frete_tipo, l.frete_gratis, l.vendidos_total, l.vendas_dia_estimado
       FROM radar_concorrentes rc
       LEFT JOIN LATERAL (
         SELECT * FROM radar_concorrentes_leituras
          WHERE radar_concorrente_id = rc.id
          ORDER BY lido_em DESC LIMIT 1
       ) l ON TRUE
      WHERE rc.empresa_id = $1 ${apenasAtivos ? 'AND rc.ativo = TRUE' : ''}
      ORDER BY rc.criado_em DESC`,
    [Number(empresaId)]
  );
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    nomeConcorrente: r.nome_concorrente,
    marketplace: r.marketplace,
    marketplaceLabel: MARKETPLACE_LABEL[r.marketplace] || r.marketplace,
    linkAnuncio: r.link_anuncio,
    mlItemId: r.ml_item_id,
    monitoramentoAutomatico: r.monitoramento_automatico,
    ativo: r.ativo,
    criadoEm: r.criado_em,
    ultimaLeitura: r.lido_em ? {
      lidoEm: r.lido_em, ok: r.leitura_ok, erro: r.leitura_erro, titulo: r.titulo,
      preco: r.preco !== null ? Number(r.preco) : null,
      precoOriginal: r.preco_original !== null ? Number(r.preco_original) : null,
      emPromocao: r.em_promocao, imagemUrl: r.imagem_url, statusAnuncio: r.status_anuncio,
      freteTipo: r.frete_tipo, freteGratis: r.frete_gratis,
      vendidosTotal: r.vendidos_total, vendasDiaEstimado: r.vendas_dia_estimado !== null ? Number(r.vendas_dia_estimado) : null,
    } : null,
  }));
}

// Últimos N preços de um concorrente (pra desenhar um histórico simples na
// tela) — só leituras bem-sucedidas, mais antiga primeiro.
async function historicoPrecos({ empresaId, id, limite = 20 }) {
  const { rows } = await pool.query(
    `SELECT l.lido_em, l.preco FROM radar_concorrentes_leituras l
       JOIN radar_concorrentes rc ON rc.id = l.radar_concorrente_id
      WHERE rc.id = $1 AND rc.empresa_id = $2 AND l.ok = TRUE AND l.preco IS NOT NULL
      ORDER BY l.lido_em DESC LIMIT $3`,
    [Number(id), Number(empresaId), limite]
  );
  return rows.reverse().map((r) => ({ lidoEm: r.lido_em, preco: Number(r.preco) }));
}

async function listarAlertas({ empresaId, limite = 20 }) {
  const { rows } = await pool.query(
    `SELECT a.*, rc.nome_concorrente, rc.sku
       FROM radar_concorrentes_alertas a
       JOIN radar_concorrentes rc ON rc.id = a.radar_concorrente_id
      WHERE rc.empresa_id = $1
      ORDER BY a.criado_em DESC LIMIT $2`,
    [Number(empresaId), limite]
  );
  return rows.map((r) => ({
    id: r.id, radarConcorrenteId: r.radar_concorrente_id, nomeConcorrente: r.nome_concorrente, sku: r.sku,
    tipo: r.tipo, severidade: r.severidade, mensagem: r.mensagem, criadoEm: r.criado_em,
  }));
}

// KPIs reais da tela (nunca inventados): total monitorado, mudanças
// detectadas nas últimas 24h, quantos estão em promoção AGORA (pela última
// leitura de cada um) e o menor preço encontrado entre os concorrentes
// monitorados comparado ao próprio preço de venda mais recente do mesmo
// SKU (quando existir uma venda registrada desse SKU — nunca inventa um
// preço próprio que não exista).
async function obterResumo({ empresaId }) {
  const [{ rows: totais }, { rows: mudancas24h }, { rows: promocoes }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE monitoramento_automatico) ::int AS automaticos
                  FROM radar_concorrentes WHERE empresa_id = $1 AND ativo = TRUE`, [Number(empresaId)]),
    pool.query(`SELECT COUNT(*)::int AS total FROM radar_concorrentes_alertas a
                  JOIN radar_concorrentes rc ON rc.id = a.radar_concorrente_id
                 WHERE rc.empresa_id = $1 AND a.criado_em >= now() - interval '24 hours'`, [Number(empresaId)]),
    pool.query(`SELECT COUNT(*)::int AS total FROM (
                  SELECT DISTINCT ON (rc.id) rc.id, l.em_promocao
                    FROM radar_concorrentes rc
                    JOIN radar_concorrentes_leituras l ON l.radar_concorrente_id = rc.id AND l.ok = TRUE
                   WHERE rc.empresa_id = $1 AND rc.ativo = TRUE
                   ORDER BY rc.id, l.lido_em DESC
                ) ult WHERE ult.em_promocao = TRUE`, [Number(empresaId)]),
  ]);

  const { rows: menorPreco } = await pool.query(
    `SELECT rc.sku, l.preco
       FROM radar_concorrentes rc
       JOIN LATERAL (
         SELECT preco FROM radar_concorrentes_leituras
          WHERE radar_concorrente_id = rc.id AND ok = TRUE AND preco IS NOT NULL
          ORDER BY lido_em DESC LIMIT 1
       ) l ON TRUE
      WHERE rc.empresa_id = $1 AND rc.ativo = TRUE
      ORDER BY l.preco ASC LIMIT 1`,
    [Number(empresaId)]
  );

  let menorPrecoInfo = null;
  if (menorPreco.length) {
    const { sku, preco } = menorPreco[0];
    const { rows: precoProprio } = await pool.query(
      `SELECT pi.preco_unitario
         FROM ml_pedido_itens pi
         JOIN ml_pedidos p ON p.id = pi.pedido_id
         JOIN ml_contas mc ON mc.id = p.conta_ml_id
        WHERE mc.empresa_id = $1 AND pi.sku = $2
        ORDER BY p.data_criacao DESC NULLS LAST LIMIT 1`,
      [Number(empresaId), sku]
    );
    menorPrecoInfo = {
      sku, preco: Number(preco),
      precoProprio: precoProprio.length ? Number(precoProprio[0].preco_unitario) : null,
    };
  }

  return {
    totalMonitorados: totais[0].total,
    totalComMonitoramentoAutomatico: totais[0].automaticos,
    mudancasUltimas24h: mudancas24h[0].total,
    emPromocaoAgora: promocoes[0].total,
    menorPreco: menorPrecoInfo,
  };
}

async function listarTodosAtivosComMonitoramentoAutomatico() {
  const { rows } = await pool.query(
    `SELECT * FROM radar_concorrentes WHERE ativo = TRUE AND monitoramento_automatico = TRUE`
  );
  return rows;
}

module.exports = {
  extrairItemIdML,
  cadastrarConcorrente,
  desativarConcorrente,
  listarConcorrentesComUltimaLeitura,
  historicoPrecos,
  listarAlertas,
  obterResumo,
  executarLeituraDeUmConcorrente,
  listarTodosAtivosComMonitoramentoAutomatico,
  calcularVendasDiaEstimado,
  gerarAlertas,
};
