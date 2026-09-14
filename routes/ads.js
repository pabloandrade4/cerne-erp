// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026, CORRIGIDO EM
// 25/08/2026. Ver lib/ads.js e lib/mlAds.js para o desenho completo (dado
// real quando a API permitir, nunca inventado). A partir desta correção o
// GET abaixo NUNCA mais consulta a API do Mercado Livre ao vivo — lê
// sempre do que lib/adsScheduler.js já sincronizou em background.
const express = require('express');
const pool = require('../db/pool');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { listarAds, sincronizarTodasAsContasAds } = require('../lib/ads');
const { obterStatusSincronizacaoAds } = require('../lib/adsScheduler');
const { classificarLinhasEAgregarCampanhas } = require('../lib/ia/adsMotor');
const { executarCicloDecisoesAdsEmpresa } = require('../lib/ia/adsDecisoesCiclo');

const router = express.Router();

const MARGEM_MINIMA_PADRAO = 10;

async function buscarMargemMinima(empresaId) {
  const { rows } = await pool.query('SELECT margem_minima_pct FROM config_ads_ia WHERE empresa_id = $1', [empresaId]);
  return rows.length ? Number(rows[0].margem_minima_pct) : MARGEM_MINIMA_PADRAO;
}

// GET /api/ads?empresaId=ID&periodo=30d&contaId=&desde=&ate=
// `desde`/`ate` (YYYY-MM-DD) só valem quando periodo=personalizado (ver
// lib/periodo.js) — pedido explícito do usuário (12/09/2026) pra poder
// escolher qualquer intervalo de datas nesta tela também. Os cards/gráfico
// continuam vindo de ads_diario (já é dado dia a dia, cobre qualquer
// intervalo sem mudança nenhuma); a tabela por anúncio, quando o período é
// personalizado, busca a métrica AO VIVO na API do Mercado Livre pro
// intervalo exato pedido (ver lib/ads.js#buscarMetricasPorAnuncio) — única
// exceção deliberada à regra acima de nunca consultar a API dentro da
// requisição HTTP, porque não dá pra pré-sincronizar em segundo plano todo
// intervalo de datas possível que o usuário decida escolher.
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
    const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);

    // Cards "Gasto hoje"/"Gasto no mês" são sempre a data real de hoje em
    // BRT — janela fixa, independente do período escolhido no filtro da
    // tela (mesmo padrão de fuso de lib/periodo.js usado em todo o ERP).
    const hojeCalc = calcularPeriodo('hoje');
    const { desde: hojeStr } = periodoParaDatasBRT(hojeCalc);
    const mesCalc = calcularPeriodo('mes');
    const { desde: mesDesdeStr, ate: mesAteStr } = periodoParaDatasBRT(mesCalc);

    const resultado = await listarAds({
      empresaId,
      contaId: contaId || null,
      periodoChave: periodoCalc.chave,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      desdeStr,
      ateStr,
      mesDesdeStr,
      mesAteStr,
      hojeStr,
    });

    // IA de Ads e Performance — Fase A (14/09/2026): classificação por
    // anúncio (mesma regra usada no resumo por campanha abaixo) e o resumo
    // agregado por campanha, pedido explícito do usuário ("identificar
    // campanhas boas e ruins"). Nunca recalcula nenhum número — só
    // classifica/soma o que `listarAds` já trouxe (ver lib/ia/adsMotor.js).
    const margemMinimaPct = await buscarMargemMinima(empresaId);
    const { linhas: linhasComClassificacao, campanhas } = classificarLinhasEAgregarCampanhas(resultado.linhas, margemMinimaPct);

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      sincronizacaoAutomatica: obterStatusSincronizacaoAds(),
      ...resultado,
      linhas: linhasComClassificacao,
      campanhas,
      margemMinimaPct,
    });
  } catch (err) { next(err); }
});

// GET /api/ads/config-ia?empresaId= — configuração da IA de Ads e
// Performance (só a margem mínima, por enquanto — mesmo espírito de
// GET /api/promocoes/config). Empresa sem linha salva ainda devolve o
// padrão (nunca 404 — a tela sempre tem o que mostrar).
router.get('/config-ia', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    res.json({ empresaId: Number(empresaId), margemMinimaPct: await buscarMargemMinima(empresaId) });
  } catch (err) { next(err); }
});

// PUT /api/ads/config-ia { empresaId, margemMinimaPct }
router.put('/config-ia', async (req, res, next) => {
  try {
    const { empresaId, margemMinimaPct } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const valor = Number(margemMinimaPct);
    if (!Number.isFinite(valor) || valor < 0 || valor > 100) {
      return res.status(400).json({ errors: { margemMinimaPct: 'Informe um percentual entre 0 e 100.' } });
    }
    await pool.query(
      `INSERT INTO config_ads_ia (empresa_id, margem_minima_pct, atualizado_em)
       VALUES ($1, $2, now())
       ON CONFLICT (empresa_id) DO UPDATE SET margem_minima_pct = EXCLUDED.margem_minima_pct, atualizado_em = now()`,
      [empresaId, valor]
    );
    res.json({ empresaId: Number(empresaId), margemMinimaPct: valor });
  } catch (err) { next(err); }
});

// POST /api/ads/sincronizar — força um ciclo de sincronização imediato
// (além do automático em background), pra quem acabou de corrigir a
// integração (Marketplaces → Advertising habilitado etc.) não precisar
// esperar o próximo ciclo pra ver o resultado real.
router.post('/sincronizar', async (req, res, next) => {
  try {
    const resultado = await sincronizarTodasAsContasAds();
    res.json(resultado);
  } catch (err) { next(err); }
});

// ============================================================
// Agente de IA "Ads e Performance" — Fase 1 (14/09/2026)
// ============================================================
// Histórico de decisões: DADOS → ANÁLISE (já existia) → RECOMENDAÇÃO
// (lib/ia/adsDecisor.js) → DECISÃO DO USUÁRIO (aqui) → RESULTADO (ver
// lib/ia/adsDecisoesCiclo.js#avaliarResultadosAds) → aprendizado (Fase 2,
// ainda não implementada). NUNCA executa nada no Mercado Livre — só
// registra a decisão do usuário, mesmo quando aprovada.
function linhaDecisaoAdsParaApi(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    contaId: row.conta_id,
    loja: row.loja || null,
    tipoReferencia: row.tipo_referencia,
    mlItemId: row.ml_item_id,
    campanhaId: row.campanha_id,
    campanhaNome: row.campanha_nome,
    sku: row.sku,
    titulo: row.titulo,
    tipoAcao: row.tipo_acao,
    motivo: row.motivo,
    snapshot: {
      investimento: row.snapshot_investimento === null ? null : Number(row.snapshot_investimento),
      faturamentoReal: row.snapshot_faturamento_real === null ? null : Number(row.snapshot_faturamento_real),
      roas: row.snapshot_roas === null ? null : Number(row.snapshot_roas),
      acos: row.snapshot_acos === null ? null : Number(row.snapshot_acos),
      margemAntesDoAds: row.snapshot_margem_antes_ads === null ? null : Number(row.snapshot_margem_antes_ads),
      margemDepoisDoAds: row.snapshot_margem_depois_ads === null ? null : Number(row.snapshot_margem_depois_ads),
      margemDepoisDoAdsPct: row.snapshot_margem_depois_ads_pct === null ? null : Number(row.snapshot_margem_depois_ads_pct),
      qtdVendas: row.snapshot_qtd_vendas === null ? null : Number(row.snapshot_qtd_vendas),
      orcamentoAtual: row.snapshot_orcamento_atual === null ? null : Number(row.snapshot_orcamento_atual),
      acosAlvoAtual: row.snapshot_acos_alvo_atual === null ? null : Number(row.snapshot_acos_alvo_atual),
    },
    valorSugeridoIa: row.valor_sugerido_ia,
    valorDecididoUsuario: row.valor_decidido_usuario,
    statusDecisao: row.status_decisao,
    decididoEm: row.decidido_em,
    decididoPor: row.decidido_por,
    executado: row.executado,
    resultadoSnapshot: row.resultado_snapshot,
    resultadoAvaliadoEm: row.resultado_avaliado_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

// GET /api/ads/decisoes?empresaId=&status=pendente|aprovada|alterada|recusada|expirada|todas
router.get('/decisoes', async (req, res, next) => {
  try {
    const { empresaId, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtroStatus = '';
    if (status && status !== 'todas') {
      params.push(status);
      filtroStatus = ' AND d.status_decisao = $2';
    }
    const { rows } = await pool.query(
      `SELECT d.*, c.nickname AS loja
         FROM ia_decisoes_ads d
         JOIN ml_contas c ON c.id = d.conta_id
        WHERE d.empresa_id = $1 ${filtroStatus}
        ORDER BY (d.status_decisao = 'pendente') DESC, d.atualizado_em DESC
        LIMIT 300`,
      params
    );
    res.json({ decisoes: rows.map(linhaDecisaoAdsParaApi) });
  } catch (err) { next(err); }
});

// PUT /api/ads/decisoes/:id  { statusDecisao: 'aprovada'|'alterada'|'recusada', valorDecididoUsuario?, decididoPor? }
// Só registra a decisão — NUNCA chama a API do Mercado Livre (ver
// cabeçalho do bloco acima). Só permite decidir uma vez (a decisão vira
// histórico definitivo); uma situação nova no mesmo anúncio/campanha abre
// uma linha nova automaticamente no próximo ciclo.
router.put('/decisoes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { statusDecisao, valorDecididoUsuario, decididoPor } = req.body || {};
    if (!['aprovada', 'alterada', 'recusada'].includes(statusDecisao)) {
      return res.status(400).json({ error: 'statusDecisao inválido — use aprovada, alterada ou recusada.' });
    }
    const { rows } = await pool.query(
      `UPDATE ia_decisoes_ads
          SET status_decisao = $1, valor_decidido_usuario = $2, decidido_em = now(), decidido_por = $3, atualizado_em = now()
        WHERE id = $4 AND status_decisao = 'pendente'
        RETURNING *`,
      [statusDecisao, valorDecididoUsuario ? JSON.stringify(valorDecididoUsuario) : null, decididoPor || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Decisão não encontrada, ou já foi decidida antes.' });
    res.json(linhaDecisaoAdsParaApi(rows[0]));
  } catch (err) { next(err); }
});

// POST /api/ads/decisoes/gerar-agora { empresaId } — roda o mesmo ciclo
// automático na hora (mesmo padrão de POST /api/promocoes/analisar), pra
// não precisar esperar a próxima sincronização de Ads.
router.post('/decisoes/gerar-agora', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await executarCicloDecisoesAdsEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
