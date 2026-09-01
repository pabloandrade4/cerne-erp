// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026, CORRIGIDO EM
// 25/08/2026 (pedido explícito do usuário — ver docs/02-decisoes.md e
// docs/04-alteracoes.md, entrada "Ads: diagnóstico real + endpoints atuais
// + sincronização em banco"): endpoints/diagnóstico corrigidos em
// lib/mlAds.js, e a tela PAROU de consultar a API de Advertising ao vivo
// dentro da requisição HTTP — agora lê sempre de tabelas próprias
// (ads_contas/ads_campanhas/ads_metricas_anuncio/ads_diario, ver
// db/schema.sql), sincronizadas em BACKGROUND por lib/adsScheduler.js
// (mesmo padrão de lib/syncScheduler.js — nunca depende do navegador
// aberto).
//
// Duas fontes bem separadas, NUNCA misturadas numa fórmula nova:
// 1) Métricas de publicidade (investimento, vendas/receita atribuída, ROAS,
//    ACOS, série diária) vêm SEMPRE da API de Advertising do Mercado Livre
//    (lib/mlAds.js), nunca calculadas pelo ERP — se a conta não tiver
//    acesso a Product Ads, ou a sincronização ainda não rodou, aparecem
//    como indisponíveis (nunca um número inventado). ROAS/ACOS por anúncio
//    são a única conta feita aqui em cima desses números — divisão de dois
//    valores reais (receita atribuída ÷ investimento), não uma estimativa.
// 2) Lucro/margem "antes do Ads" vem da mesma fonte única de sempre
//    (lib/relatorioVendas.js → buscarItensDoPeriodo, que reaproveita
//    lib/resultadoVenda.js) — a margem de contribuição REAL das vendas
//    daquele anúncio no período, idêntica à filosofia de Pedidos/DRE/
//    Financeiro. "Depois do Ads" = essa margem real menos o investimento
//    real em Ads (fonte 1). TACOS = investimento em Ads (fonte 1) dividido
//    pelo faturamento REAL das vendas daquele anúncio no período (fonte 2)
//    — só calculado quando os dois números existem, nunca estimado.
//
// IMPORTANTE (pedido explícito do usuário): a API de Advertising do
// Mercado Livre não identifica QUAIS PEDIDOS pertencem à publicidade —
// só devolve totais agregados atribuídos por anúncio/período. Por isso
// nunca chamamos "vendas atribuídas" (fonte 1) de "lucro gerado pelo Ads":
// a tela mostra duas visões SEPARADAS (window.Ads no frontend) —
// "Performance atribuída Mercado Ads" (só fonte 1) e "Resultado real do
// SKU após Ads" (fonte 2 menos o investimento da fonte 1, deixando
// explícito que pode incluir venda orgânica).
const pool = require('../db/pool');
const { decrypt } = require('./crypto');
const { buscarDadosAdsDaConta } = require('./mlAds');
const { buscarItensDoPeriodo } = require('./relatorioVendas');
// CORREÇÃO (01/09/2026, diagnóstico do Ads não sincronizar — ver
// docs/04-alteracoes.md): antes, sincronizarContaAds lia
// ml_contas.access_token_enc direto, sem NUNCA checar/renovar o
// vencimento do token — só a sincronização de PEDIDOS (lib/mlSync.js,
// ciclo de 1min) fazia essa renovação. Isso deixava o Ads inteiramente
// dependente de um processo separado só pra manter o token vivo — e
// confirmado em produção que esse processo ficou travado por mais de 34h
// seguidas (`[sync automático] ciclo anterior ainda em andamento`),
// deixando os tokens vencerem sem ninguém renovar. Agora o Ads renova seu
// próprio token (mesma função usada pela sincronização de pedidos/
// estoque), então continua funcionando mesmo que o ciclo de pedidos
// esteja com problema.
const { getContaComTokenValido } = require('./mlSync');
const { round2 } = require('./resultadoVenda');
const { PERIODOS, calcularPeriodo, periodoParaDatasBRT, diaBRT } = require('./periodo');

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

function somarSeAmbos(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return round2(Number(a) + Number(b));
}

// Agrupa nossos itens de pedido (já com margem real calculada, um por
// linha/pedido) por anúncio (ml_item_id) — soma vendas/faturamento/margem
// de todos os pedidos daquele anúncio no período.
function agruparVendasPorAnuncio(itensPedidos) {
  const porAnuncio = new Map();
  itensPedidos.forEach((it) => {
    const chave = it.mlItemId || `sem-id:${it.sku || 's-sku'}:${it.contaMlId}`;
    if (!porAnuncio.has(chave)) {
      porAnuncio.set(chave, {
        mlItemId: it.mlItemId,
        sku: it.sku,
        titulo: it.titulo,
        loja: it.loja,
        contaMlId: it.contaMlId,
        quantidade: 0,
        faturamento: 0,
        margemContribuicao: 0,
        pendentes: 0,
        rateado: false,
      });
    }
    const acc = porAnuncio.get(chave);
    acc.quantidade += it.quantidade || 0;
    if (it.valorTotalItem !== null) acc.faturamento = round2(acc.faturamento + it.valorTotalItem);
    if (it.calculoCompleto) acc.margemContribuicao = round2(acc.margemContribuicao + it.margemContribuicao);
    else acc.pendentes += 1;
    if (it.rateado) acc.rateado = true;
    if (!acc.titulo && it.titulo) acc.titulo = it.titulo;
    if (!acc.sku && it.sku) acc.sku = it.sku;
  });
  return porAnuncio;
}

// Extrai investimento/receita atribuída/qtd atribuída de um objeto de
// métricas cru da API (item, ou linha diária) — mesma regra de fallback
// nos dois casos: total_amount quando existe, senão a soma de
// direct+indirect (só quando os dois vierem, nunca metade estimada). Usada
// no SYNC (lib/adsScheduler.js via sincronizarContaAds abaixo), não mais na
// leitura — os valores já resolvidos ficam gravados em
// ads_metricas_anuncio.
function extrairInvestimentoEReceita(metrics) {
  const investimento = toNum(metrics.cost);
  const receita = toNum(metrics.total_amount) !== null
    ? toNum(metrics.total_amount)
    : somarSeAmbos(metrics.direct_amount, metrics.indirect_amount);
  const qtd = toNum(metrics.units_quantity) !== null
    ? toNum(metrics.units_quantity)
    : somarSeAmbos(metrics.direct_units_quantity, metrics.indirect_units_quantity);
  return { investimento, receita, qtd };
}

// Soma duas séries diárias {data, investimento, receitaAtribuida} numa só,
// somando os valores dos mesmos dias — usado pra combinar a série de
// várias contas/lojas da mesma empresa. Um dia ausente numa conta não
// derruba o dia inteiro: soma só o que existir.
function somarSeriesDiarias(destino, origem) {
  origem.forEach((dia) => {
    let alvo = destino.find((d) => d.data === dia.data);
    if (!alvo) { alvo = { data: dia.data, investimento: null, receitaAtribuida: null }; destino.push(alvo); }
    if (dia.investimento !== null) alvo.investimento = round2((alvo.investimento || 0) + dia.investimento);
    if (dia.receitaAtribuida !== null) alvo.receitaAtribuida = round2((alvo.receitaAtribuida || 0) + dia.receitaAtribuida);
  });
}

function converterDiasCrus(diasCrus) {
  if (!diasCrus) return [];
  return diasCrus.map((d) => {
    const metrics = d.metrics_summary || d.metrics || d;
    const { investimento, receita } = extrairInvestimentoEReceita(metrics);
    return { data: d.date, investimento, receitaAtribuida: receita };
  }).filter((d) => d.data);
}

// ---------------------------------------------------------------------
// SINCRONIZAÇÃO (background — chamada por lib/adsScheduler.js, nunca pelo
// carregamento da tela). Grava em ads_contas/ads_campanhas/
// ads_metricas_anuncio/ads_diario — ver db/schema.sql pro desenho completo.
// ---------------------------------------------------------------------

async function upsertAdsConta(contaId, { advertiserId, siteId, disponivel, motivo, mensagem, detalheApi }) {
  await pool.query(
    `INSERT INTO ads_contas (conta_id, advertiser_id, site_id, disponivel, motivo, mensagem, detalhe_api, ultima_sincronizacao_em, ultima_sincronizacao_ok, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$4,now())
     ON CONFLICT (conta_id) DO UPDATE SET
       advertiser_id = EXCLUDED.advertiser_id,
       site_id = EXCLUDED.site_id,
       disponivel = EXCLUDED.disponivel,
       motivo = EXCLUDED.motivo,
       mensagem = EXCLUDED.mensagem,
       detalhe_api = EXCLUDED.detalhe_api,
       ultima_sincronizacao_em = now(),
       ultima_sincronizacao_ok = EXCLUDED.disponivel,
       updated_at = now()`,
    [contaId, advertiserId || null, siteId || null, !!disponivel, motivo || null, mensagem || null, detalheApi ? JSON.stringify(detalheApi) : null]
  );
}

async function gravarCampanhas(contaId, campanhas) {
  for (const c of campanhas || []) {
    if (c.id === undefined || c.id === null) continue;
    await pool.query(
      `INSERT INTO ads_campanhas (conta_id, campanha_id, nome, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (conta_id, campanha_id) DO UPDATE SET nome = EXCLUDED.nome, updated_at = now()`,
      [contaId, String(c.id), c.name || null]
    );
  }
}

async function gravarMetricasAnuncio(contaId, periodoChave, itens) {
  for (const item of itens || []) {
    if (item.item_id === undefined && item.id === undefined) continue;
    const metrics = item.metrics_summary || item.metrics || {};
    const { investimento, receita, qtd } = extrairInvestimentoEReceita(metrics);
    const mlItemId = String(item.item_id || item.id);
    const campanhaId = item.campaign_id !== undefined && item.campaign_id !== null ? String(item.campaign_id) : null;
    await pool.query(
      `INSERT INTO ads_metricas_anuncio
         (conta_id, periodo_chave, ml_item_id, campanha_id, titulo, cliques, impressoes, cpc, investimento, acos_api, ctr_api, cvr_api, roas_api, faturamento_atribuido, qtd_atribuida, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (conta_id, periodo_chave, ml_item_id) DO UPDATE SET
         campanha_id = EXCLUDED.campanha_id, titulo = EXCLUDED.titulo, cliques = EXCLUDED.cliques,
         impressoes = EXCLUDED.impressoes, cpc = EXCLUDED.cpc, investimento = EXCLUDED.investimento,
         acos_api = EXCLUDED.acos_api, ctr_api = EXCLUDED.ctr_api, cvr_api = EXCLUDED.cvr_api,
         roas_api = EXCLUDED.roas_api, faturamento_atribuido = EXCLUDED.faturamento_atribuido,
         qtd_atribuida = EXCLUDED.qtd_atribuida, atualizado_em = now()`,
      [
        contaId, periodoChave, mlItemId, campanhaId, item.title || null,
        toNum(metrics.clicks), toNum(metrics.prints), toNum(metrics.cpc), investimento, toNum(metrics.acos),
        toNum(metrics.ctr), toNum(metrics.cvr), toNum(metrics.roas), receita, qtd,
      ]
    );
  }
}

async function gravarDiario(contaId, diasCrus) {
  const dias = converterDiasCrus(diasCrus);
  for (const dia of dias) {
    await pool.query(
      `INSERT INTO ads_diario (conta_id, data, investimento, receita_atribuida, atualizado_em)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (conta_id, data) DO UPDATE SET investimento = EXCLUDED.investimento, receita_atribuida = EXCLUDED.receita_atribuida, atualizado_em = now()`,
      [contaId, dia.data, dia.investimento, dia.receitaAtribuida]
    );
  }
}

// Sincroniza UMA conta: resolve advertiser, busca os anúncios pra cada uma
// das 5 janelas do filtro global (lib/periodo.js — a própria API de
// Advertising exige um intervalo de datas por chamada, então replicamos
// aqui as mesmas janelas que a tela pode pedir, pra nunca precisar de uma
// chamada ao vivo depois — ver db/schema.sql), mais uma janela larga fixa
// só pra série diária (gráfico + cards "Gasto hoje"/"Gasto no mês").
// Nunca lança erro solto — uma conta com problema não impede a
// sincronização das demais (ver sincronizarTodasAsContasAds).
async function sincronizarContaAds(contaId) {
  const { rows } = await pool.query('SELECT * FROM ml_contas WHERE id = $1', [contaId]);
  const conta = rows[0];
  if (!conta) throw new Error('Conta do Mercado Livre não encontrada: ' + contaId);
  if (conta.status !== 'ativa') return { pulou: true };

  let accessToken;
  try {
    // Renova o token se estiver a menos de 5min do vencimento (mesma regra
    // usada pela sincronização de pedidos/estoque, ver comentário acima do
    // require) — nunca lê access_token_enc direto do SELECT acima, que pode
    // estar desatualizado/vencido.
    const contaComTokenValido = await getContaComTokenValido(contaId);
    accessToken = decrypt(contaComTokenValido.access_token_enc);
  } catch (e) {
    await upsertAdsConta(contaId, {
      disponivel: false,
      motivo: 'token_invalido',
      mensagem: 'Não foi possível renovar/ler o token de acesso desta conta: ' + (e && e.message ? e.message : 'erro desconhecido') + '. A conexão com o Mercado Livre pode precisar ser refeita em Integrações.',
    });
    return { ok: false };
  }

  const chaves = Object.keys(PERIODOS);
  let advertiserId = null, siteId = null, disponivelGeral = false;
  let ultimoMotivo = null, ultimaMensagem = null, ultimoDetalhe = null;

  for (const chave of chaves) {
    const periodoCalc = calcularPeriodo(chave);
    const { desde, ate } = periodoParaDatasBRT(periodoCalc);

    let resultado;
    try {
      resultado = await buscarDadosAdsDaConta({ accessToken, mlUserId: conta.ml_user_id, siteId: conta.site_id, desde, ate, comSerieDiaria: false });
    } catch (e) {
      ultimoMotivo = 'erro_api'; ultimaMensagem = 'Falha inesperada ao sincronizar Ads: ' + (e && e.message);
      continue;
    }

    if (!resultado.disponivel) {
      ultimoMotivo = resultado.motivo; ultimaMensagem = resultado.mensagem; ultimoDetalhe = resultado.detalheApi;
      advertiserId = advertiserId || resultado.advertiserId;
      siteId = siteId || resultado.siteId;
      if (!resultado.advertiserId) break; // sem anunciante — as outras janelas dariam o mesmo erro, não adianta insistir
      continue; // essa janela específica falhou — tenta as outras
    }

    disponivelGeral = true;
    advertiserId = resultado.advertiserId;
    siteId = resultado.siteId;
    await gravarCampanhas(contaId, resultado.campanhas);
    await gravarMetricasAnuncio(contaId, chave, resultado.itens);
  }

  // Série diária — janela larga fixa (independente das 5 chaves acima), só
  // pra garantir que qualquer período do filtro (inclusive "Este mês" perto
  // do fim de um mês de 31 dias) tenha dia suficiente sincronizado.
  if (disponivelGeral) {
    const diasJanela = Number(process.env.ADS_SYNC_DIARIO_DIAS) || 40;
    const agora = new Date();
    const desdeDiario = diaBRT(new Date(agora.getTime() - diasJanela * 24 * 60 * 60 * 1000));
    const ateDiario = diaBRT(agora);
    try {
      const resultadoDiario = await buscarDadosAdsDaConta({ accessToken, mlUserId: conta.ml_user_id, siteId: conta.site_id, desde: desdeDiario, ate: ateDiario, comSerieDiaria: true });
      if (resultadoDiario.disponivel && resultadoDiario.diario) {
        await gravarDiario(contaId, resultadoDiario.diario);
      }
    } catch (e) { /* melhor-esforço — o gráfico/cards ficam com o que já tinha sincronizado neste ciclo */ }
  }

  await upsertAdsConta(contaId, {
    advertiserId, siteId,
    disponivel: disponivelGeral,
    motivo: disponivelGeral ? null : ultimoMotivo,
    mensagem: disponivelGeral ? null : ultimaMensagem,
    detalheApi: disponivelGeral ? null : ultimoDetalhe,
  });

  return { ok: disponivelGeral };
}

// CORREÇÃO (01/09/2026, ver comentário equivalente em lib/syncScheduler.js
// e docs/04-alteracoes.md): watchdog por conta — Promise.allSettled só
// resolve quando TODAS as promises terminam, então uma única conta travada
// (ex.: numa query sem timeout) travaria este ciclo inteiro pra sempre,
// como confirmado em produção no ciclo de pedidos/estoque.
const TIMEOUT_POR_CONTA_ADS_MS = Number(process.env.ADS_SYNC_TIMEOUT_POR_CONTA_MS) || 3 * 60 * 1000; // 3 min
function comTimeoutAds(promessa, ms, mensagemTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(mensagemTimeout)), ms);
  });
  return Promise.race([promessa, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Sincroniza TODAS as contas ativas — Promise.allSettled (mesmo padrão de
// lib/syncScheduler.js): uma conta com erro nunca impede as demais.
async function sincronizarTodasAsContasAds() {
  const { rows: contas } = await pool.query(`SELECT id FROM ml_contas WHERE status = 'ativa' ORDER BY id`);
  const resultados = await Promise.allSettled(
    contas.map((c) =>
      comTimeoutAds(
        sincronizarContaAds(c.id),
        TIMEOUT_POR_CONTA_ADS_MS,
        `Sincronização de Ads excedeu ${Math.round(TIMEOUT_POR_CONTA_ADS_MS / 1000)}s — abortada para não travar o ciclo (conta ${c.id}).`
      )
    )
  );
  const comErro = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      comErro.push({ contaId: contas[i].id, erro: String((r.reason && r.reason.message) || r.reason) });
    }
  });
  return { contasProcessadas: contas.length, comErro };
}

// ---------------------------------------------------------------------
// LEITURA (usada por routes/ads.js) — lê SEMPRE das tabelas já
// sincronizadas, nunca chama a API do Mercado Livre.
// ---------------------------------------------------------------------

// Cards de topo: Gasto hoje / Gasto no mês vêm da série diária (janela
// fixa dia-1-do-mês-até-hoje, independente do período escolhido no filtro
// da tela). Receita atribuída/ROAS/ACOS do período vêm da soma das linhas
// (mesma fonte da tabela — nunca um segundo cálculo que possa divergir).
function calcularCards({ diarioMes, hojeStr, linhas, situacaoPorConta }) {
  const algumaDisponivel = situacaoPorConta.some((s) => s.disponivel);
  const todasIndisponiveis = situacaoPorConta.length > 0 && !algumaDisponivel;

  let gastoHoje = null, gastoMes = null;
  if (diarioMes && diarioMes.length) {
    const diasComInvestimento = diarioMes.filter((d) => d.investimento !== null);
    gastoMes = diasComInvestimento.length ? round2(diasComInvestimento.reduce((s, d) => s + d.investimento, 0)) : null;
    const hoje = diarioMes.find((d) => d.data === hojeStr);
    gastoHoje = hoje && hoje.investimento !== null ? hoje.investimento : null;
  }

  const linhasComInvestimento = linhas.filter((l) => l.investimento !== null);
  const investimentoPeriodo = linhasComInvestimento.length ? round2(linhasComInvestimento.reduce((s, l) => s + l.investimento, 0)) : null;
  const linhasComReceita = linhas.filter((l) => l.faturamentoAtribuido !== null);
  const receitaAtribuidaPeriodo = linhasComReceita.length ? round2(linhasComReceita.reduce((s, l) => s + l.faturamentoAtribuido, 0)) : null;

  const roasPeriodo = (investimentoPeriodo && investimentoPeriodo > 0 && receitaAtribuidaPeriodo !== null)
    ? round2(receitaAtribuidaPeriodo / investimentoPeriodo) : null;
  const acosPeriodo = (investimentoPeriodo !== null && receitaAtribuidaPeriodo)
    ? round2((investimentoPeriodo / receitaAtribuidaPeriodo) * 100) : null;

  return {
    disponivel: !todasIndisponiveis,
    parcial: situacaoPorConta.some((s) => !s.disponivel) && algumaDisponivel,
    gastoHoje,
    gastoMes,
    investimentoPeriodo,
    receitaAtribuidaPeriodo,
    roasPeriodo,
    acosPeriodo,
  };
}

const CARDS_VAZIO = { disponivel: false, parcial: false, gastoHoje: null, gastoMes: null, investimentoPeriodo: null, receitaAtribuidaPeriodo: null, roasPeriodo: null, acosPeriodo: null };

async function buscarSituacaoPorConta(contasFiltradas) {
  const ids = contasFiltradas.map((c) => c.id);
  const porConta = new Map();
  if (ids.length) {
    const { rows } = await pool.query('SELECT * FROM ads_contas WHERE conta_id = ANY($1)', [ids]);
    rows.forEach((r) => porConta.set(r.conta_id, r));
  }

  return contasFiltradas.map((conta) => {
    if (conta.status !== 'ativa') {
      return {
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: 'conta_com_erro',
        mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada. Reconecte em Marketplaces.',
      };
    }
    const registro = porConta.get(conta.id);
    if (!registro) {
      return {
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: 'nao_sincronizado',
        mensagem: 'Esta conta ainda não foi sincronizada com a API de Publicidade do Mercado Livre — aguarde o próximo ciclo automático em segundo plano.',
      };
    }
    if (!registro.disponivel) {
      const status = registro.detalhe_api && registro.detalhe_api.status;
      const prefixo = status ? `[HTTP ${status}] ` : '';
      return {
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: registro.motivo,
        mensagem: prefixo + (registro.mensagem || 'Dados de Ads indisponíveis para esta conta.'),
        ultimaSincronizacaoEm: registro.ultima_sincronizacao_em,
      };
    }
    return { contaId: conta.id, loja: conta.nickname, disponivel: true, ultimaSincronizacaoEm: registro.ultima_sincronizacao_em };
  });
}

async function buscarMetricasPorAnuncio(contaIds, periodoChave) {
  const metricasPorAnuncio = new Map();
  if (!contaIds.length) return metricasPorAnuncio;
  const { rows } = await pool.query(
    `SELECT m.*, c.nickname AS loja, camp.nome AS campanha_nome
       FROM ads_metricas_anuncio m
       JOIN ml_contas c ON c.id = m.conta_id
       LEFT JOIN ads_campanhas camp ON camp.conta_id = m.conta_id AND camp.campanha_id = m.campanha_id
      WHERE m.conta_id = ANY($1) AND m.periodo_chave = $2`,
    [contaIds, periodoChave]
  );
  rows.forEach((r) => {
    metricasPorAnuncio.set(String(r.ml_item_id), {
      contaMlId: r.conta_id,
      loja: r.loja,
      titulo: r.titulo,
      campanha: r.campanha_nome || null,
      investimento: toNum(r.investimento),
      faturamentoAtribuido: toNum(r.faturamento_atribuido),
      qtdVendasAtribuidas: toNum(r.qtd_atribuida),
      clicks: toNum(r.cliques),
      prints: toNum(r.impressoes),
      cpc: toNum(r.cpc),
      acosApi: toNum(r.acos_api),
      ctrApi: toNum(r.ctr_api),
      cvrApi: toNum(r.cvr_api),
      roasApi: toNum(r.roas_api),
    });
  });
  return metricasPorAnuncio;
}

async function buscarDiario(contaIds, desdeStr, ateStr) {
  if (!contaIds.length) return [];
  const { rows } = await pool.query(
    `SELECT data::text AS data, investimento, receita_atribuida
       FROM ads_diario
      WHERE conta_id = ANY($1) AND data BETWEEN $2 AND $3
      ORDER BY data`,
    [contaIds, desdeStr, ateStr]
  );
  const acumulado = [];
  somarSeriesDiarias(acumulado, rows.map((r) => ({ data: r.data, investimento: toNum(r.investimento), receitaAtribuida: toNum(r.receita_atribuida) })));
  acumulado.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  return acumulado;
}

// GET principal usado por routes/ads.js — devolve linha por anúncio
// (união do que existe em vendas reais e/ou em métricas de Ads já
// sincronizadas, pra nunca esconder um anúncio que só aparece de um dos
// dois lados), os cards de topo, a série diária do gráfico e a situação de
// sincronização por loja. `periodoChave` é uma das chaves de PERIODOS
// (lib/periodo.js) — a mesma janela que foi sincronizada em
// ads_metricas_anuncio (ver sincronizarContaAds acima).
async function listarAds({ empresaId, contaId, periodoChave, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr }) {
  const { rows: contasTodas } = await pool.query(
    'SELECT * FROM ml_contas WHERE empresa_id = $1 ORDER BY nickname',
    [empresaId]
  );
  if (!contasTodas.length) {
    return {
      semConta: true,
      lojas: [],
      situacaoPorConta: [],
      linhas: [],
      cards: CARDS_VAZIO,
      diario: [],
    };
  }

  const contasFiltradas = contaId ? contasTodas.filter((c) => String(c.id) === String(contaId)) : contasTodas;
  const contaIdsAtivas = contasFiltradas.filter((c) => c.status === 'ativa').map((c) => c.id);

  const { itens: itensPedidos } = await buscarItensDoPeriodo({ empresaId, desde, ate });
  const itensPedidosFiltrados = contaId ? itensPedidos.filter((it) => String(it.contaMlId) === String(contaId)) : itensPedidos;
  const vendasPorAnuncio = agruparVendasPorAnuncio(itensPedidosFiltrados);

  const situacaoPorConta = await buscarSituacaoPorConta(contasFiltradas);
  const metricasPorAnuncio = await buscarMetricasPorAnuncio(contaIdsAtivas, periodoChave || '30d');
  const diarioPeriodo = await buscarDiario(contaIdsAtivas, desdeStr, ateStr);
  const diarioMes = (mesDesdeStr === desdeStr && mesAteStr === ateStr) ? diarioPeriodo : await buscarDiario(contaIdsAtivas, mesDesdeStr, mesAteStr);

  const chaves = new Set([...vendasPorAnuncio.keys(), ...metricasPorAnuncio.keys()]);
  const linhas = [...chaves].map((chave) => {
    const venda = vendasPorAnuncio.get(chave) || null;
    const ads = metricasPorAnuncio.get(chave) || null;

    const investimento = ads ? ads.investimento : null;
    const faturamentoAtribuido = ads ? ads.faturamentoAtribuido : null;
    const qtdVendasAtribuidas = ads ? ads.qtdVendasAtribuidas : null;

    // ROAS não é uma métrica sempre presente no endpoint de anúncios — quando
    // ausente, calculado aqui em cima de dois números reais (receita
    // atribuída ÷ investimento), nunca uma estimativa.
    const roas = investimento && investimento > 0 && faturamentoAtribuido !== null
      ? round2(faturamentoAtribuido / investimento)
      : null;
    const acos = ads && ads.acosApi !== null
      ? ads.acosApi
      : (investimento !== null && faturamentoAtribuido ? round2((investimento / faturamentoAtribuido) * 100) : null);

    const faturamentoRealAnuncio = venda ? venda.faturamento : null;
    // TACOS = investimento em Ads / faturamento REAL do anúncio no período
    // (não o "atribuído" pelo Mercado Livre) — só quando os dois existem.
    const tacos = (investimento !== null && faturamentoRealAnuncio) ? round2((investimento / faturamentoRealAnuncio) * 100) : null;

    const margemAntesDoAds = venda ? (venda.pendentes > 0 ? null : venda.margemContribuicao) : null;
    const margemDepoisDoAds = (margemAntesDoAds !== null && investimento !== null) ? round2(margemAntesDoAds - investimento) : null;
    const margemDepoisDoAdsPct = (margemDepoisDoAds !== null && faturamentoRealAnuncio) ? round2((margemDepoisDoAds / faturamentoRealAnuncio) * 100) : null;

    let status = 'pendente';
    if (margemDepoisDoAds !== null) status = margemDepoisDoAds >= 0 ? 'lucrativo' : 'prejuizo';
    else if (venda && venda.pendentes === 0 && investimento === null) status = 'sem_dado_ads';

    return {
      mlItemId: (venda && venda.mlItemId) || (chave.startsWith('sem-id:') ? null : chave),
      anuncio: (venda && venda.titulo) || (ads && ads.titulo) || null,
      sku: venda ? venda.sku : null,
      campanha: ads ? ads.campanha : null,
      loja: (venda && venda.loja) || (ads && ads.loja) || null,
      contaMlId: (venda && venda.contaMlId) || (ads && ads.contaMlId) || null,
      investimento,
      vendasAtribuidas: faturamentoAtribuido,
      qtdVendasAtribuidas,
      faturamentoAtribuido,
      cliques: ads ? ads.clicks : null,
      impressoes: ads ? ads.prints : null,
      cpc: ads ? ads.cpc : null,
      roas,
      acos,
      tacos,
      quantidadeVendidaReal: venda ? venda.quantidade : 0,
      faturamentoReal: faturamentoRealAnuncio,
      margemAntesDoAds,
      custoAds: investimento,
      margemDepoisDoAds,
      margemDepoisDoAdsPct,
      status,
      rateado: venda ? venda.rateado : false,
      semMetricasAds: !ads,
      semVendaReal: !venda,
    };
  });

  linhas.sort((a, b) => {
    const va = a.faturamentoReal || 0;
    const vb = b.faturamentoReal || 0;
    return vb - va;
  });

  const cards = calcularCards({ diarioMes, hojeStr, linhas, situacaoPorConta });

  return {
    semConta: false,
    lojas: contasTodas.map((c) => ({ id: c.id, nickname: c.nickname })),
    situacaoPorConta,
    linhas,
    cards,
    diario: diarioPeriodo || [],
  };
}

module.exports = {
  listarAds,
  calcularCards,
  sincronizarContaAds,
  sincronizarTodasAsContasAds,
  // Exportado em 26/08/2026 para a aba "Margem por Anúncio" (Análise —
  // ver lib/margemAnuncio.js), que precisa do investimento em Ads por
  // anúncio já sincronizado — mesma fonte única da tela Ads, nunca uma
  // segunda leitura da API. Puramente aditivo: não muda nada do
  // comportamento já existente deste arquivo/da tela Ads.
  buscarMetricasPorAnuncio,
};
