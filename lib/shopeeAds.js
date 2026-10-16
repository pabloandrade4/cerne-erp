// Ads da Shopee (16/10/2026). Puxa a série DIÁRIA de gasto/cliques/vendas dos
// anúncios pagos (Shopee Ads CPC) de cada loja conectada e grava em
// shopee_ads_diario; a tela só lê do banco. Honestidade: se a Shopee recusar
// (app sem permissão de Ads, token sem escopo de Ads, loja sem Ads), o
// motivo REAL fica em shopee_ads_status e é mostrado na tela — nunca um
// número inventado. Reaproveita a assinatura/renovação de token já usadas
// no restante da integração Shopee (lib/shopee.js, lib/shopeeTokenScheduler.js).
const pool = require('../db/pool');
const shopee = require('./shopee');
const { decrypt } = require('./shopeeCrypto');
const { credencialShopee } = require('./shopeeCredenciais');
const { renovarTokenDaConta } = require('./shopeeTokenScheduler');
const { calcularPeriodo, periodoParaDatasBRT } = require('./periodo');

const JANELA_API_DIAS = 30; // a API limita o intervalo por chamada
const DIAS_SINCRONIZADOS = 60;
const DIA_MS = 24 * 60 * 60 * 1000;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function ddmmyyyy(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}
// "dd-mm-yyyy" -> "yyyy-mm-dd"
function paraISO(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// A resposta pode vir como {response:[...]} ou {response:{...}} dependendo da
// versão; aceita as duas formas.
function extrairLinhas(resp) {
  const r = resp && resp.response;
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.data)) return r.data;
  if (r && Array.isArray(r.result)) return r.result;
  return [];
}

function mensagemAmigavel(err) {
  const bruto = String((err && err.message) || err || '');
  const d = err && err.data ? JSON.stringify(err.data) : '';
  if (/permission|auth|scope|access|forbid/i.test(bruto + d)) {
    return 'A Shopee não liberou o acesso a Ads para este app/loja. Confirme que o app tem a permissão "Ads" no Shopee Open Platform e reconecte a loja em Integrações.';
  }
  return bruto || 'Erro ao consultar o Ads da Shopee.';
}

async function sincronizarAdsConta(contaId) {
  const conta = await renovarTokenDaConta(contaId, { forcar: false });
  const accessToken = decrypt(conta.access_token_enc);
  const base = {
    partnerId: credencialShopee('SHOPEE_PARTNER_ID'),
    partnerKey: credencialShopee('SHOPEE_PARTNER_KEY'),
    accessToken,
    shopId: conta.shopee_shop_id,
  };

  let ok = true;
  let mensagem = null;
  let detalhe = null;
  let saldo = null;
  let gravados = 0;

  try {
    // Saldo (opcional — se falhar, não impede a série diária).
    try {
      const b = await shopee.apiShopGet('/api/v2/ads/get_total_balance', base);
      saldo = num(b && b.response && b.response.total_balance);
    } catch (_) { /* opcional */ }

    const hoje = new Date();
    const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
    for (let off = 0; off < DIAS_SINCRONIZADOS; off += JANELA_API_DIAS) {
      const fimJanela = new Date(fim.getTime() - off * DIA_MS);
      const iniJanela = new Date(fimJanela.getTime() - (JANELA_API_DIAS - 1) * DIA_MS);
      const resp = await shopee.apiShopGet('/api/v2/ads/get_all_cpc_ads_daily_performance', {
        ...base,
        params: { start_date: ddmmyyyy(iniJanela), end_date: ddmmyyyy(fimJanela) },
      });
      const linhas = extrairLinhas(resp);
      if (off === 0) detalhe = { amostra: linhas[0] || null, qtdLinhas: linhas.length, requestId: resp && resp.request_id };
      for (const l of linhas) {
        const data = paraISO(l.date);
        if (!data) continue;
        await pool.query(
          `INSERT INTO shopee_ads_diario
             (shopee_conta_id, data, gasto, impressoes, cliques, pedidos_diretos, pedidos_amplos, gmv_direto, gmv_amplo, atualizado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
           ON CONFLICT (shopee_conta_id, data) DO UPDATE SET
             gasto=EXCLUDED.gasto, impressoes=EXCLUDED.impressoes, cliques=EXCLUDED.cliques,
             pedidos_diretos=EXCLUDED.pedidos_diretos, pedidos_amplos=EXCLUDED.pedidos_amplos,
             gmv_direto=EXCLUDED.gmv_direto, gmv_amplo=EXCLUDED.gmv_amplo, atualizado_em=now()`,
          [contaId, data, num(l.expense), num(l.impression), num(l.clicks),
            num(l.direct_order), num(l.broad_order), num(l.direct_gmv), num(l.broad_gmv)]
        );
        gravados++;
      }
    }
  } catch (err) {
    ok = false;
    mensagem = mensagemAmigavel(err);
    detalhe = { erro: String((err && err.message) || err), resposta: err && err.data ? err.data : null };
  }

  await pool.query(
    `INSERT INTO shopee_ads_status (shopee_conta_id, disponivel, mensagem, detalhe_api, saldo, ultima_sincronizacao_em, ultima_sincronizacao_ok, updated_at)
     VALUES ($1,$2,$3,$4,$5, now(), $2, now())
     ON CONFLICT (shopee_conta_id) DO UPDATE SET
       disponivel=EXCLUDED.disponivel, mensagem=EXCLUDED.mensagem, detalhe_api=EXCLUDED.detalhe_api,
       saldo=COALESCE(EXCLUDED.saldo, shopee_ads_status.saldo),
       ultima_sincronizacao_em=now(), ultima_sincronizacao_ok=EXCLUDED.disponivel, updated_at=now()`,
    [contaId, ok, mensagem, detalhe ? JSON.stringify(detalhe) : null, saldo]
  );
  return { contaId, ok, gravados, mensagem };
}

async function sincronizarTodasAsContasAdsShopee() {
  const { rows } = await pool.query(`SELECT id FROM shopee_contas WHERE status = 'ativa' ORDER BY id`);
  const resultados = await Promise.allSettled(rows.map((r) => sincronizarAdsConta(r.id)));
  return resultados.map((r, i) => (r.status === 'fulfilled' ? r.value : { contaId: rows[i].id, ok: false, mensagem: String(r.reason && r.reason.message || r.reason) }));
}

function somar(l, c) {
  const g = num(l.gasto) || 0, v = num(l.gmv_amplo) || 0;
  return { gasto: g, receita: v, cliques: num(l.cliques) || 0, impressoes: num(l.impressoes) || 0, pedidos: num(l.pedidos_amplos) || 0 };
}

function fechar(t) {
  return {
    ...t,
    roas: t.gasto > 0 ? Math.round((t.receita / t.gasto) * 100) / 100 : null,
    acos: t.receita > 0 ? Math.round((t.gasto / t.receita) * 10000) / 100 : null,
    ctr: t.impressoes > 0 ? Math.round((t.cliques / t.impressoes) * 10000) / 100 : null,
    cpc: t.cliques > 0 ? Math.round((t.gasto / t.cliques) * 100) / 100 : null,
  };
}

async function resumoShopee({ empresaId, periodo, desde, ate }) {
  const p = calcularPeriodo(periodo, { desde, ate });
  const { desde: d0, ate: d1 } = periodoParaDatasBRT(p);
  const { rows: dias } = await pool.query(
    `SELECT a.data::text AS data, SUM(a.gasto) AS gasto, SUM(a.impressoes) AS impressoes, SUM(a.cliques) AS cliques,
            SUM(a.pedidos_amplos) AS pedidos_amplos, SUM(a.gmv_amplo) AS gmv_amplo, SUM(a.gmv_direto) AS gmv_direto
       FROM shopee_ads_diario a JOIN shopee_contas c ON c.id = a.shopee_conta_id
      WHERE c.empresa_id = $1 AND a.data BETWEEN $2 AND $3
      GROUP BY a.data ORDER BY a.data`,
    [empresaId, d0, d1]
  );
  const { rows: lojas } = await pool.query(
    `SELECT c.id, c.shop_name, s.disponivel, s.mensagem, s.saldo, s.ultima_sincronizacao_em,
            COALESCE((SELECT SUM(gasto) FROM shopee_ads_diario WHERE shopee_conta_id=c.id AND data BETWEEN $2 AND $3),0) AS gasto,
            COALESCE((SELECT SUM(gmv_amplo) FROM shopee_ads_diario WHERE shopee_conta_id=c.id AND data BETWEEN $2 AND $3),0) AS receita
       FROM shopee_contas c LEFT JOIN shopee_ads_status s ON s.shopee_conta_id = c.id
      WHERE c.empresa_id = $1 ORDER BY c.shop_name`,
    [empresaId, d0, d1]
  );
  const tot = dias.reduce((a, l) => {
    const s = somar(l);
    return { gasto: a.gasto + s.gasto, receita: a.receita + s.receita, cliques: a.cliques + s.cliques, impressoes: a.impressoes + s.impressoes, pedidos: a.pedidos + s.pedidos };
  }, { gasto: 0, receita: 0, cliques: 0, impressoes: 0, pedidos: 0 });
  return {
    periodo: { chave: p.chave, label: p.label, desde: d0, ate: d1 },
    totais: fechar(tot),
    dias: dias.map((l) => ({ data: l.data, gasto: num(l.gasto) || 0, receita: num(l.gmv_amplo) || 0, cliques: num(l.cliques) || 0 })),
    lojas: lojas.map((l) => ({
      id: l.id, nome: l.shop_name, disponivel: !!l.disponivel, mensagem: l.mensagem, saldo: num(l.saldo),
      ultimaSincronizacaoEm: l.ultima_sincronizacao_em, gasto: num(l.gasto) || 0, receita: num(l.receita) || 0,
      roas: Number(l.gasto) > 0 ? Math.round((Number(l.receita) / Number(l.gasto)) * 100) / 100 : null,
    })),
  };
}

// ML: ads_diario (investimento / receita_atribuida), por empresa.
async function resumoMercadoLivre({ empresaId, d0, d1 }) {
  const { rows } = await pool.query(
    `SELECT a.data::text AS data, SUM(a.investimento) AS gasto, SUM(a.receita_atribuida) AS receita
       FROM ads_diario a JOIN ml_contas c ON c.id = a.conta_id
      WHERE c.empresa_id = $1 AND a.data BETWEEN $2 AND $3 GROUP BY a.data ORDER BY a.data`,
    [empresaId, d0, d1]
  );
  const dias = rows.map((r) => ({ data: r.data, gasto: num(r.gasto) || 0, receita: num(r.receita) || 0 }));
  const tot = dias.reduce((a, l) => ({ ...a, gasto: a.gasto + l.gasto, receita: a.receita + l.receita }), { gasto: 0, receita: 0, cliques: 0, impressoes: 0, pedidos: 0 });
  return { totais: fechar(tot), dias };
}

async function resumoUnificado({ empresaId, periodo, desde, ate }) {
  const sp = await resumoShopee({ empresaId, periodo, desde, ate });
  const ml = await resumoMercadoLivre({ empresaId, d0: sp.periodo.desde, d1: sp.periodo.ate });
  const mapa = new Map();
  for (const l of ml.dias) mapa.set(l.data, { data: l.data, gastoMl: l.gasto, receitaMl: l.receita, gastoShopee: 0, receitaShopee: 0 });
  for (const l of sp.dias) {
    const x = mapa.get(l.data) || { data: l.data, gastoMl: 0, receitaMl: 0, gastoShopee: 0, receitaShopee: 0 };
    x.gastoShopee = l.gasto; x.receitaShopee = l.receita; mapa.set(l.data, x);
  }
  const total = fechar({
    gasto: ml.totais.gasto + sp.totais.gasto, receita: ml.totais.receita + sp.totais.receita,
    cliques: sp.totais.cliques, impressoes: sp.totais.impressoes, pedidos: sp.totais.pedidos,
  });
  return {
    periodo: sp.periodo, total, mercadoLivre: ml.totais, shopee: sp.totais,
    dias: [...mapa.values()].sort((a, b) => a.data.localeCompare(b.data)),
  };
}

module.exports = { sincronizarAdsConta, sincronizarTodasAsContasAdsShopee, resumoShopee, resumoUnificado };
