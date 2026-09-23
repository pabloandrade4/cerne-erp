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
const { executarDecisaoAprovada } = require('../lib/ia/adsExecutor');
const { statusIntegracaoAds } = require('../lib/mlPermissoes');

const router = express.Router();

const MARGEM_MINIMA_PADRAO = 10;

async function buscarMargemMinima(empresaId) {
  const { rows } = await pool.query('SELECT margem_minima_pct FROM config_ads_ia WHERE empresa_id = $1', [empresaId]);
  return rows.length ? Number(rows[0].margem_minima_pct) : MARGEM_MINIMA_PADRAO;
}

async function buscarConfigAds(empresaId) {
  const { rows } = await pool.query('SELECT margem_minima_pct, permite_escrita_ml FROM config_ads_ia WHERE empresa_id = $1', [empresaId]);
  if (!rows.length) return { margemMinimaPct: MARGEM_MINIMA_PADRAO, permiteEscritaMl: false };
  return { margemMinimaPct: Number(rows[0].margem_minima_pct), permiteEscritaMl: !!rows[0].permite_escrita_ml };
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
    const config = await buscarConfigAds(empresaId);
    res.json({ empresaId: Number(empresaId), ...config });
  } catch (err) { next(err); }
});

// PUT /api/ads/config-ia { empresaId, margemMinimaPct, permiteEscritaMl? }
// `permiteEscritaMl` (19/09/2026, pedido explícito do usuário — ver
// lib/ia/adsExecutor.js): a trava manual que liga a execução real no
// Mercado Livre. Nasce sempre desligada; o usuário só liga depois de
// confirmar no painel do Mercado Livre Developers que o aplicativo tem
// permissão de escrita E reconectar a conta (um token já emitido não ganha
// permissão nova sozinho). Omitido no corpo = mantém o valor atual (nunca
// desliga/liga sozinho como efeito colateral de salvar só a margem).
router.put('/config-ia', async (req, res, next) => {
  try {
    const { empresaId, margemMinimaPct, permiteEscritaMl } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const valor = Number(margemMinimaPct);
    if (!Number.isFinite(valor) || valor < 0 || valor > 100) {
      return res.status(400).json({ errors: { margemMinimaPct: 'Informe um percentual entre 0 e 100.' } });
    }
    const atual = await buscarConfigAds(empresaId);
    const novoPermiteEscritaMl = permiteEscritaMl !== undefined ? !!permiteEscritaMl : atual.permiteEscritaMl;
    await pool.query(
      `INSERT INTO config_ads_ia (empresa_id, margem_minima_pct, permite_escrita_ml, atualizado_em)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (empresa_id) DO UPDATE SET
         margem_minima_pct = EXCLUDED.margem_minima_pct,
         permite_escrita_ml = EXCLUDED.permite_escrita_ml,
         atualizado_em = now()`,
      [empresaId, valor, novoPermiteEscritaMl]
    );
    res.json({ empresaId: Number(empresaId), margemMinimaPct: valor, permiteEscritaMl: novoPermiteEscritaMl });
  } catch (err) { next(err); }
});

// GET /api/ads/status-integracao?empresaId= — mesmo espírito de
// GET /api/promocoes/status-integracao (lib/mlPermissoes.js#
// statusIntegracaoAds): junta o diagnóstico informativo do escopo OAuth
// com a trava manual (config_ads_ia.permite_escrita_ml, quem decide de
// verdade) pra tela "Agentes IA → Ads e Performance" mostrar se aprovar
// uma sugestão hoje só registra ou já executa de verdade.
router.get('/status-integracao', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const [{ rows: contas }, config] = await Promise.all([
      pool.query("SELECT id, nickname, status, escopo_oauth FROM ml_contas WHERE empresa_id = $1 ORDER BY nickname", [empresaId]),
      buscarConfigAds(empresaId),
    ]);

    const contasComStatus = contas.map((c) => ({
      contaId: c.id,
      loja: c.nickname,
      statusConexao: c.status,
      ...statusIntegracaoAds({ escopoOauth: c.escopo_oauth, permiteEscritaMl: config.permiteEscritaMl }),
    }));

    // Resumo único pra tela — se a trava está ligada, escrita disponível
    // pra empresa inteira (é uma trava por empresa, não por conta).
    const resumo = statusIntegracaoAds({
      escopoOauth: contas.length ? contas[0].escopo_oauth : null,
      permiteEscritaMl: config.permiteEscritaMl,
    });

    res.json({ empresaId: Number(empresaId), permiteEscritaMl: config.permiteEscritaMl, contas: contasComStatus, resumo });
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
// (lib/ia/adsDecisor.js) → DECISÃO DO USUÁRIO (aqui) → EXECUÇÃO REAL
// (lib/ia/adsExecutor.js, "Fase E", 19/09/2026 — só quando aprovada/
// alterada, o tipo de ação tem execução direta e a escrita está liberada
// em config_ads_ia.permite_escrita_ml) → RESULTADO (ver
// lib/ia/adsDecisoesCiclo.js#avaliarResultadosAds) → aprendizado (Fase 2,
// ainda não implementada).
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
    // Relatório completo (21/09/2026, pedido explícito do usuário — ver
    // lib/ia/adsDiagnostico.js): relatorioDiagnosticoTexto é 100%
    // determinístico e sempre existe quando a decisão é 'pausar_anuncio';
    // relatorioDiagnosticoIa é a mesma informação reescrita pelo provedor
    // de IA generativa, null quando a IA não gerou (nunca bloqueia a tela).
    relatorioDiagnosticoTexto: row.relatorio_diagnostico_texto || null,
    relatorioDiagnosticoIa: row.relatorio_diagnostico_ia || null,
    relatorioDiagnosticoGeradoEm: row.relatorio_diagnostico_gerado_em || null,
    valorDecididoUsuario: row.valor_decidido_usuario,
    statusDecisao: row.status_decisao,
    decididoEm: row.decidido_em,
    decididoPor: row.decidido_por,
    executado: row.executado,
    executadoEm: row.executado_em,
    execucaoErro: row.execucao_erro,
    resultadoSnapshot: row.resultado_snapshot,
    resultadoAvaliadoEm: row.resultado_avaliado_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

// GET /api/ads/decisoes?empresaId=&status=pendente|aprovada|alterada|recusada|expirada|decidida|todas
// status=decidida = tudo que NÃO está mais pendente (usado pela aba
// "Histórico" da tela — sem isso, a tela de histórico ficava sujeita a ser
// inundada só de pendentes e a LIMIT 300 podia nem chegar nas decisões já
// tomadas quando há muita coisa pendente).
router.get('/decisoes', async (req, res, next) => {
  try {
    const { empresaId, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtroStatus = '';
    if (status === 'decidida') {
      filtroStatus = " AND d.status_decisao <> 'pendente'";
    } else if (status && status !== 'todas') {
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
// Registra a decisão e, quando ela é 'aprovada'/'alterada', tenta EXECUTAR
// de verdade no Mercado Livre (lib/ia/adsExecutor.js, "Fase E", 19/09/2026
// — pedido explícito do usuário: "eu vou aprovar, aí vai fazer"). A
// aprovação em si NUNCA falha por causa da execução — o executor nunca
// lança, sempre grava o motivo real (sucesso, sem permissão, erro da API,
// etc.) em execucao_erro/executado, e a resposta HTTP já devolve esse
// resultado atualizado pro usuário ver na hora, sem precisar recarregar a
// tela. Só permite decidir uma vez (a decisão vira histórico definitivo);
// uma situação nova no mesmo anúncio/campanha abre uma linha nova
// automaticamente no próximo ciclo.
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

    let decisaoAtualizada = rows[0];
    if (statusDecisao === 'aprovada' || statusDecisao === 'alterada') {
      await executarDecisaoAprovada(decisaoAtualizada.id);
      const { rows: releitura } = await pool.query('SELECT * FROM ia_decisoes_ads WHERE id = $1', [decisaoAtualizada.id]);
      if (releitura.length) decisaoAtualizada = releitura[0];
    }
    res.json(linhaDecisaoAdsParaApi(decisaoAtualizada));
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
