// Central de Promoções (Mercado Livre) — primeira etapa (12/09/2026):
// SÓ DIAGNÓSTICO. Não aplica, entra ou sai de nenhuma promoção — só
// consulta o que a API do Mercado Livre devolve de verdade pras contas já
// conectadas, pra sabermos (a) se o aplicativo já tem permissão pra essa
// API e (b) qual é o formato real dos dados, antes de desenhar qualquer
// automação em cima (mesma lição já aprendida neste projeto com a API de
// Ads: nunca desenhar automação em cima de um formato adivinhado).
const express = require('express');
const pool = require('../db/pool');
const { decrypt } = require('../lib/crypto');
const { getContaComTokenValido } = require('../lib/mlSync');
const { buscarPromocoesDaConta, buscarItensDaPromocao } = require('../lib/mlPromocoes');
const { statusIntegracaoPromocoes } = require('../lib/mlPermissoes');
const { executarCicloPromocoesEmpresa } = require('../lib/ia/promocoesCiclo');

const router = express.Router();

const MODOS_IA_VALIDOS = ['somente_analisar', 'sugerir_aprovar', 'automatico'];

// Linha padrão (empresa ainda sem configuração salva) — mesmos valores do
// DEFAULT da tabela (db/schema.sql), só que sem precisar de round-trip ao
// banco pra empresa nova.
function configPadrao(empresaId) {
  return {
    empresaId: Number(empresaId),
    margemMinimaPct: 14,
    descontoMaximoPct: null,
    estoqueMinimo: null,
    vendasMinimas30d: null,
    permiteFull: true,
    permiteProprio: true,
    modoIa: 'somente_analisar',
    permiteEscritaMl: false,
  };
}

function linhaParaConfig(row) {
  return {
    empresaId: row.empresa_id,
    margemMinimaPct: Number(row.margem_minima_pct),
    descontoMaximoPct: row.desconto_maximo_pct === null ? null : Number(row.desconto_maximo_pct),
    estoqueMinimo: row.estoque_minimo,
    vendasMinimas30d: row.vendas_minimas_30d,
    permiteFull: row.permite_full,
    permiteProprio: row.permite_proprio,
    modoIa: row.modo_ia,
    permiteEscritaMl: row.permite_escrita_ml,
  };
}

// POST /api/promocoes/diagnostico  { empresaId }
// Roda pra cada conta ATIVA do Mercado Livre da empresa, grava o resultado
// completo (sucesso ou erro real da API) no log do servidor — prefixado
// "[Promoções][diagnóstico]" pra achar fácil nos logs do Render — e também
// devolve na resposta, pra conseguir ver direto sem precisar abrir o log.
router.post('/diagnostico', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: contas } = await pool.query(
      "SELECT * FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY nickname",
      [empresaId]
    );

    if (!contas.length) {
      return res.json({ contas: [], mensagem: 'Nenhuma conta do Mercado Livre ativa para esta empresa.' });
    }

    const resultados = [];
    for (const conta of contas) {
      let linha = { contaId: conta.id, loja: conta.nickname, mlUserId: conta.ml_user_id };
      try {
        const contaComTokenValido = await getContaComTokenValido(conta.id);
        const accessToken = decrypt(contaComTokenValido.access_token_enc);
        const resultado = await buscarPromocoesDaConta(accessToken, conta.ml_user_id);
        linha = { ...linha, ...resultado };
      } catch (e) {
        linha.ok = false;
        linha.erro = e.message || 'Falha ao obter token válido desta conta.';
      }
      console.log('[Promoções][diagnóstico] conta=' + conta.id + ' (' + conta.nickname + '):', JSON.stringify(linha));
      resultados.push(linha);
    }

    res.json({ contas: resultados });
  } catch (e) {
    next(e);
  }
});

// POST /api/promocoes/diagnostico-itens  { empresaId, contaId, promotionId, promotionType }
// Segunda etapa do diagnóstico: olha os ITENS de UMA promoção específica
// (já encontrada via /diagnostico) — pra saber o formato real de preço,
// desconto e identificação do produto antes de desenhar o cálculo de
// margem. Também só lê, nunca aplica nada.
router.post('/diagnostico-itens', async (req, res, next) => {
  try {
    const { empresaId, contaId, promotionId, promotionType } = req.body || {};
    if (!empresaId || !contaId || !promotionId || !promotionType) {
      return res.status(400).json({ error: 'Informe empresaId, contaId, promotionId e promotionType.' });
    }

    const { rows } = await pool.query('SELECT * FROM ml_contas WHERE id = $1 AND empresa_id = $2', [contaId, empresaId]);
    const conta = rows[0];
    if (!conta) return res.status(404).json({ error: 'Conta do Mercado Livre não encontrada para esta empresa.' });

    let resultado;
    try {
      const contaComTokenValido = await getContaComTokenValido(conta.id);
      const accessToken = decrypt(contaComTokenValido.access_token_enc);
      resultado = await buscarItensDaPromocao(accessToken, conta.ml_user_id, promotionId, promotionType);
    } catch (e) {
      resultado = { ok: false, erro: e.message || 'Falha ao obter token válido desta conta.' };
    }

    console.log('[Promoções][diagnóstico-itens] conta=' + conta.id + ' promotionId=' + promotionId + ' type=' + promotionType + ':', JSON.stringify(resultado));
    res.json(resultado);
  } catch (e) {
    next(e);
  }
});

// GET /api/promocoes/config?empresaId=  — configuração da IA de Promoções
// (margem mínima etc). Empresa sem linha salva ainda devolve os padrões
// (nunca 404 — a tela sempre tem o que mostrar).
router.get('/config', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query('SELECT * FROM config_promocoes WHERE empresa_id = $1', [empresaId]);
    res.json(rows.length ? linhaParaConfig(rows[0]) : configPadrao(empresaId));
  } catch (e) { next(e); }
});

// PUT /api/promocoes/config  { empresaId, margemMinimaPct, descontoMaximoPct?,
//   estoqueMinimo?, vendasMinimas30d?, permiteFull?, permiteProprio?, modoIa?,
//   permiteEscritaMl? }
// `permiteEscritaMl` É SÓ A TRAVA (ver lib/mlPermissoes.js) — nesta fase,
// ligá-la aqui não faz o ERP executar nenhuma escrita de verdade, porque
// ainda não existe nenhum código de escrita implementado (Fase E). Ligar
// antes da hora não quebra nada, mas só faz sentido depois de: 1) liberar
// escrita no painel do Mercado Livre Developers e 2) reconectar a conta
// (reautorizar) pra pegar um token com a permissão nova.
router.put('/config', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const atual = (await pool.query('SELECT * FROM config_promocoes WHERE empresa_id = $1', [empresaId])).rows[0];
    const base = atual ? linhaParaConfig(atual) : configPadrao(empresaId);
    const corpo = req.body || {};

    const margemMinimaPct = corpo.margemMinimaPct !== undefined ? Number(corpo.margemMinimaPct) : base.margemMinimaPct;
    if (!Number.isFinite(margemMinimaPct) || margemMinimaPct < 0 || margemMinimaPct > 100) {
      return res.status(400).json({ errors: { margemMinimaPct: 'Informe um percentual entre 0 e 100.' } });
    }
    const modoIa = corpo.modoIa !== undefined ? corpo.modoIa : base.modoIa;
    if (!MODOS_IA_VALIDOS.includes(modoIa)) {
      return res.status(400).json({ errors: { modoIa: 'Modo inválido.' } });
    }
    if (modoIa !== 'somente_analisar') {
      // Trava de arquitetura pedida pelo usuário: os outros modos só podem
      // ser LIGADOS quando a escrita já estiver disponível — nunca por
      // engano, nunca só porque alguém marcou a opção na tela.
      const permiteEscritaMl = corpo.permiteEscritaMl !== undefined ? !!corpo.permiteEscritaMl : base.permiteEscritaMl;
      if (!permiteEscritaMl) {
        return res.status(409).json({
          error: 'Este modo exige permissão de escrita na integração com o Mercado Livre, que ainda não está liberada. Mantendo "Somente analisar".',
        });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO config_promocoes (
         empresa_id, margem_minima_pct, desconto_maximo_pct, estoque_minimo, vendas_minimas_30d,
         permite_full, permite_proprio, modo_ia, permite_escrita_ml, atualizado_em
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (empresa_id) DO UPDATE SET
         margem_minima_pct = EXCLUDED.margem_minima_pct,
         desconto_maximo_pct = EXCLUDED.desconto_maximo_pct,
         estoque_minimo = EXCLUDED.estoque_minimo,
         vendas_minimas_30d = EXCLUDED.vendas_minimas_30d,
         permite_full = EXCLUDED.permite_full,
         permite_proprio = EXCLUDED.permite_proprio,
         modo_ia = EXCLUDED.modo_ia,
         permite_escrita_ml = EXCLUDED.permite_escrita_ml,
         atualizado_em = now()
       RETURNING *`,
      [
        empresaId,
        margemMinimaPct,
        corpo.descontoMaximoPct !== undefined ? corpo.descontoMaximoPct : base.descontoMaximoPct,
        corpo.estoqueMinimo !== undefined ? corpo.estoqueMinimo : base.estoqueMinimo,
        corpo.vendasMinimas30d !== undefined ? corpo.vendasMinimas30d : base.vendasMinimas30d,
        corpo.permiteFull !== undefined ? !!corpo.permiteFull : base.permiteFull,
        corpo.permiteProprio !== undefined ? !!corpo.permiteProprio : base.permiteProprio,
        modoIa,
        corpo.permiteEscritaMl !== undefined ? !!corpo.permiteEscritaMl : base.permiteEscritaMl,
      ]
    );
    res.json(linhaParaConfig(rows[0]));
  } catch (e) { next(e); }
});

// GET /api/promocoes/status-integracao?empresaId=
// Alimenta o card "Integração Mercado Livre" (seção 0 do pedido do
// usuário): pra cada conta ativa, diz se hoje dá pra ir além de
// consultar/recomendar — nunca decide isso sozinho a partir de heurística,
// só junta o diagnóstico (escopo OAuth, informativo) com a trava manual
// (config_promocoes.permite_escrita_ml, quem manda de verdade — ver
// lib/mlPermissoes.js).
router.get('/status-integracao', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const [{ rows: contas }, configRow] = await Promise.all([
      pool.query("SELECT id, nickname, status, escopo_oauth FROM ml_contas WHERE empresa_id = $1 ORDER BY nickname", [empresaId]),
      pool.query('SELECT permite_escrita_ml FROM config_promocoes WHERE empresa_id = $1', [empresaId]),
    ]);
    const permiteEscritaMl = configRow.rows.length ? configRow.rows[0].permite_escrita_ml : false;

    const contasComStatus = contas.map((c) => ({
      contaId: c.id,
      loja: c.nickname,
      statusConexao: c.status,
      ...statusIntegracaoPromocoes({ escopoOauth: c.escopo_oauth, permiteEscritaMl }),
    }));

    // Resumo único pra tela (o card do pedido do usuário é por empresa, não
    // por conta) — se QUALQUER conta ativa tem escrita disponível, mostra
    // verde; sem conta nenhuma ativa, mostra a mensagem de leitura mesmo
    // assim (nunca "indisponível" genérico).
    const ativas = contasComStatus.filter((c) => c.statusConexao === 'ativa');
    const escritaDisponivel = ativas.length > 0 && ativas.every((c) => c.escritaDisponivel);
    res.json({
      contas: contasComStatus,
      resumo: {
        escritaDisponivel,
        statusLabel: escritaDisponivel ? 'leitura_e_escrita' : 'somente_leitura',
        mensagem: escritaDisponivel
          ? 'Seu aplicativo Mercado Livre tem leitura e escrita liberadas nesta integração. A IA pode analisar, recomendar e (quando você confirmar) aplicar promoções.'
          : 'Seu aplicativo Mercado Livre possui atualmente acesso de leitura. A IA pode analisar e recomendar promoções, mas não pode alterá-las automaticamente.',
      },
    });
  } catch (e) { next(e); }
});

function linhaAnaliseParaApi(row) {
  return {
    contaId: row.conta_id,
    loja: row.loja,
    promotionId: row.promotion_id,
    promotionType: row.promotion_type,
    promotionLabel: row.promotion_label,
    mlItemId: row.ml_item_id,
    statusItemMl: row.status_item_ml,
    titulo: row.titulo,
    imagemUrl: row.imagem_url,
    sku: row.sku,
    precoNormal: row.preco_normal === null ? null : Number(row.preco_normal),
    precoPromo: row.preco_promo === null ? null : Number(row.preco_promo),
    origemPrecoPromo: row.origem_preco_promo,
    descontoPct: row.desconto_pct === null ? null : Number(row.desconto_pct),
    descontoBancadoMeliPct: row.desconto_bancado_meli_pct === null ? null : Number(row.desconto_bancado_meli_pct),
    descontoBancadoVendedorPct: row.desconto_bancado_vendedor_pct === null ? null : Number(row.desconto_bancado_vendedor_pct),
    custoProduto: row.custo_produto === null ? null : Number(row.custo_produto),
    tarifasEstimadas: row.tarifas_estimadas === null ? null : Number(row.tarifas_estimadas),
    freteVendedorEstimado: row.frete_vendedor_estimado === null ? null : Number(row.frete_vendedor_estimado),
    impostoEstimado: row.imposto_estimado === null ? null : Number(row.imposto_estimado),
    margemReal: row.margem_real === null ? null : Number(row.margem_real),
    margemRealPct: row.margem_real_pct === null ? null : Number(row.margem_real_pct),
    margemMinimaPctUsada: row.margem_minima_pct_usada === null ? null : Number(row.margem_minima_pct_usada),
    margemIncompleta: row.margem_incompleta,
    motivoIncompleto: row.motivo_incompleto,
    classificacaoCodigo: row.classificacao_codigo,
    classificacaoLabel: row.classificacao_label,
    atualizadoEm: row.atualizado_em,
  };
}

// GET /api/promocoes/analise?empresaId=&contaId=
// Lê o resultado já calculado (gravado pelo ciclo automático — a cada 1h —
// ou pelo botão "Atualizar agora" abaixo). Nunca calcula nada AO VIVO nesta
// rota — ler é rápido e não depende da API do Mercado Livre responder na
// hora; quem recalcula é sempre o mesmo ciclo (lib/ia/promocoesCiclo.js),
// pra tela e automação nunca mostrarem números diferentes.
router.get('/analise', async (req, res, next) => {
  try {
    const { empresaId, contaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const params = [empresaId];
    let filtroConta = '';
    if (contaId) {
      params.push(contaId);
      filtroConta = ' AND pa.conta_id = $2';
    }

    const { rows } = await pool.query(
      `SELECT pa.*, c.nickname AS loja
         FROM promocoes_analises pa
         JOIN ml_contas c ON c.id = pa.conta_id
        WHERE pa.empresa_id = $1 ${filtroConta}
        ORDER BY pa.margem_incompleta ASC, pa.margem_real_pct ASC NULLS LAST, pa.atualizado_em DESC`,
      params
    );

    const ultimaAtualizacaoEm = rows.reduce((max, r) => (!max || r.atualizado_em > max ? r.atualizado_em : max), null);

    res.json({
      empresaId: Number(empresaId),
      linhas: rows.map(linhaAnaliseParaApi),
      ultimaAtualizacaoEm,
      totalItens: rows.length,
    });
  } catch (e) { next(e); }
});

// POST /api/promocoes/analisar  { empresaId }
// Roda o mesmo ciclo automático (lib/ia/promocoesCiclo.js) na hora, pro
// botão "Atualizar agora" da tela — sem precisar esperar o próximo disparo
// da hora em hora. Só leitura na API do Mercado Livre, nunca escreve nada.
router.post('/analisar', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await executarCicloPromocoesEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (e) { next(e); }
});

// ============================================================
// Agente de IA "Promoções" — Fase 1 (14/09/2026)
// ============================================================
// Histórico de decisões: DADOS → ANÁLISE (já existia) → RECOMENDAÇÃO
// (lib/ia/promocoesDecisor.js) → DECISÃO DO USUÁRIO (aqui) → RESULTADO (ver
// lib/ia/promocoesDecisoesStore.js#avaliarResultadosPromocoes) →
// aprendizado (Fase 2, ainda não implementada). NUNCA executa nada no
// Mercado Livre — só registra a decisão do usuário, mesmo quando aprovada.
function linhaDecisaoPromocaoParaApi(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    contaId: row.conta_id,
    loja: row.loja || null,
    promotionId: row.promotion_id,
    promotionType: row.promotion_type,
    promotionLabel: row.promotion_label,
    mlItemId: row.ml_item_id,
    sku: row.sku,
    titulo: row.titulo,
    tipoAcao: row.tipo_acao,
    motivo: row.motivo,
    snapshot: {
      precoNormal: row.snapshot_preco_normal === null ? null : Number(row.snapshot_preco_normal),
      precoPromo: row.snapshot_preco_promo === null ? null : Number(row.snapshot_preco_promo),
      descontoPct: row.snapshot_desconto_pct === null ? null : Number(row.snapshot_desconto_pct),
      custoProduto: row.snapshot_custo_produto === null ? null : Number(row.snapshot_custo_produto),
      tarifasEstimadas: row.snapshot_tarifas_estimadas === null ? null : Number(row.snapshot_tarifas_estimadas),
      freteVendedorEstimado: row.snapshot_frete_vendedor_estimado === null ? null : Number(row.snapshot_frete_vendedor_estimado),
      impostoEstimado: row.snapshot_imposto_estimado === null ? null : Number(row.snapshot_imposto_estimado),
      margemReal: row.snapshot_margem_real === null ? null : Number(row.snapshot_margem_real),
      margemRealPct: row.snapshot_margem_real_pct === null ? null : Number(row.snapshot_margem_real_pct),
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

// GET /api/promocoes/decisoes?empresaId=&status=pendente|aprovada|alterada|recusada|expirada|decidida|todas
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
         FROM ia_decisoes_promocoes d
         JOIN ml_contas c ON c.id = d.conta_id
        WHERE d.empresa_id = $1 ${filtroStatus}
        ORDER BY (d.status_decisao = 'pendente') DESC, d.atualizado_em DESC
        LIMIT 300`,
      params
    );
    res.json({ decisoes: rows.map(linhaDecisaoPromocaoParaApi) });
  } catch (e) { next(e); }
});

// PUT /api/promocoes/decisoes/:id  { statusDecisao, valorDecididoUsuario?, decididoPor? }
// Só registra a decisão — NUNCA chama a API do Mercado Livre.
router.put('/decisoes/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { statusDecisao, valorDecididoUsuario, decididoPor } = req.body || {};
    if (!['aprovada', 'alterada', 'recusada'].includes(statusDecisao)) {
      return res.status(400).json({ error: 'statusDecisao inválido — use aprovada, alterada ou recusada.' });
    }
    const { rows } = await pool.query(
      `UPDATE ia_decisoes_promocoes
          SET status_decisao = $1, valor_decidido_usuario = $2, decidido_em = now(), decidido_por = $3, atualizado_em = now()
        WHERE id = $4 AND status_decisao = 'pendente'
        RETURNING *`,
      [statusDecisao, valorDecididoUsuario ? JSON.stringify(valorDecididoUsuario) : null, decididoPor || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Decisão não encontrada, ou já foi decidida antes.' });
    res.json(linhaDecisaoPromocaoParaApi(rows[0]));
  } catch (e) { next(e); }
});

module.exports = router;
