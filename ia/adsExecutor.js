// Executor real de decisões de Ads — "Fase E" (19/09/2026), pedido
// explícito do usuário: "e sobre as ia elas não vão fazer sozinho mas eu
// sou vou aprovar, aí vai fazer... por enquanto só vai precisar da minha
// permissão". Até aqui, aprovar uma sugestão de Ads só gravava
// status_decisao='aprovada' em ia_decisoes_ads (ver routes/ads.js) — nunca
// chamava o Mercado Livre de verdade. A partir de agora, quando o usuário
// aprova (ou aprova com valor alterado), este módulo tenta aplicar a ação
// de verdade via lib/mlAds.js#atualizarCampanha.
//
// DUAS TRAVAS, as duas têm que estar liberadas pra executar algo:
//   1) config_ads_ia.permite_escrita_ml — trava manual por empresa, nasce
//      SEMPRE desligada. Só o usuário liga (ver routes/ads.js#/config-ia),
//      depois de conferir no Mercado Livre Developers que o aplicativo tem
//      permissão de escrita e RECONECTAR a conta (um token já emitido não
//      ganha permissão nova sozinho). Mesmo desenho já usado pela IA de
//      Promoções (lib/mlPermissoes.js) — nada aqui muda o comportamento de
//      Promoções.
//   2) ia_permissoes_acao.nivel_permissao — por tipo de ação (pedido
//      explícito do usuário, 14/09/2026: "cada tipo de ação deverá possuir
//      sua própria permissão"). Hoje todo tipo_acao executável de Ads já
//      está seedado como 'approval_required' (db/schema.sql) — só executa
//      DEPOIS que o usuário aprovou; 'recommend_only' (colocar_sku_em_
//      campanha) nunca executa nada, aprovado ou não.
//
// ESCOPO DESTA ETAPA: só ações de CAMPANHA (pausar/ativar/orçamento) — são
// as que o Mercado Livre expõe hoje por um único PUT direto (ver
// lib/mlAds.js#atualizarCampanha). "pausar_anuncio" (item individual
// dentro de uma campanha) e "colocar_sku_em_campanha" (sugestão sem
// campanha concreta pra aplicar) continuam só recomendação nesta fase —
// nunca fingem uma execução que não aconteceu.
//
// NUNCA lança pra quem chamou (routes/ads.js) — aprovar a decisão já
// aconteceu e tem que ficar registrado mesmo se a execução falhar. Toda
// falha (sem token, sem permissão, erro real da API) vira uma explicação
// legível gravada em execucao_erro, nunca um "nada aconteceu" silencioso.
const pool = require('../../db/pool');
const { decrypt } = require('../crypto');
const { getContaComTokenValido } = require('../mlSync');
const mlAds = require('../mlAds');

const AGENTE_CODIGO = 'ads_performance';

// Só estes 4 tipos têm, hoje, uma ação de CAMPANHA direta e sem ambiguidade
// no Mercado Livre. `pausar_anuncio` seria por ITEM (endpoint diferente,
// ainda não integrado) e `colocar_sku_em_campanha` é uma sugestão pro
// usuário avaliar manualmente (o ERP não escolhe em qual campanha entrar).
const ACOES_EXECUTAVEIS = new Set(['pausar_campanha', 'ativar_campanha', 'diminuir_orcamento', 'aumentar_orcamento']);

async function nivelPermissaoDaAcao(tipoAcao) {
  const { rows } = await pool.query(
    `SELECT nivel_permissao FROM ia_permissoes_acao WHERE agente_codigo = $1 AND tipo_acao = $2`,
    [AGENTE_CODIGO, tipoAcao]
  );
  // Tipo de ação sem linha cadastrada em ia_permissoes_acao: trata como
  // 'recommend_only' por segurança — nunca executa algo que a tabela de
  // permissões nem conhece.
  return rows.length ? rows[0].nivel_permissao : 'recommend_only';
}

// Monta o corpo real do PUT a partir do tipo_acao + do valor já decidido
// (o que o usuário efetivamente decidiu — o valor alterado por ele tem
// prioridade sobre o que a IA sugeriu originalmente). Devolve null quando
// não há valor suficiente pra executar (nunca inventa um número).
function montarPayloadExecucao(decisao) {
  const valorDecidido = decisao.valor_decidido_usuario || {};
  const valorSugerido = decisao.valor_sugerido_ia || {};

  if (decisao.tipo_acao === 'pausar_campanha') return { status: 'paused' };
  if (decisao.tipo_acao === 'ativar_campanha') return { status: 'active' };

  if (decisao.tipo_acao === 'diminuir_orcamento' || decisao.tipo_acao === 'aumentar_orcamento') {
    const orcamento = valorDecidido.orcamentoDecidido ?? valorDecidido.orcamentoSugerido
      ?? valorSugerido.orcamentoSugerido ?? null;
    if (orcamento === null || orcamento === undefined || !Number.isFinite(Number(orcamento)) || Number(orcamento) <= 0) {
      return null;
    }
    return { budget: Number(orcamento) };
  }
  return null;
}

// Ponto único de entrada, chamado por routes/ads.js logo depois de uma
// decisão virar 'aprovada'/'alterada'. NUNCA lança — sempre devolve um
// objeto { executado, motivo?, erro? } e já grava o resultado em
// ia_decisoes_ads (quem chamou só usa o retorno pra responder a requisição
// HTTP com a informação real, sem precisar gravar nada de novo).
async function executarDecisaoAprovada(decisaoId) {
  const { rows } = await pool.query('SELECT * FROM ia_decisoes_ads WHERE id = $1', [decisaoId]);
  if (!rows.length) return { executado: false, motivo: 'decisao_nao_encontrada' };
  const decisao = rows[0];

  if (decisao.tipo_referencia !== 'campanha' || !ACOES_EXECUTAVEIS.has(decisao.tipo_acao)) {
    await marcarNaoExecutado(decisaoId, 'Este tipo de sugestão ainda não tem execução automática nesta fase — continua só recomendação.');
    return { executado: false, motivo: 'sem_execucao_direta' };
  }

  const [nivel, configRow] = await Promise.all([
    nivelPermissaoDaAcao(decisao.tipo_acao),
    pool.query('SELECT permite_escrita_ml FROM config_ads_ia WHERE empresa_id = $1', [decisao.empresa_id]),
  ]);

  if (nivel === 'recommend_only') {
    await marcarNaoExecutado(decisaoId, 'Este tipo de ação está configurado como "somente recomendação" — nunca executa sozinho, mesmo aprovado.');
    return { executado: false, motivo: 'recommend_only' };
  }

  const permiteEscritaMl = configRow.rows.length ? !!configRow.rows[0].permite_escrita_ml : false;
  if (!permiteEscritaMl) {
    await marcarNaoExecutado(decisaoId, 'Execução não tentada: a permissão de escrita no Mercado Livre ainda não está liberada (Agentes IA → Ads e Performance → Configurações). A decisão fica aprovada e registrada normalmente.');
    return { executado: false, motivo: 'escrita_desligada' };
  }

  const payload = montarPayloadExecucao(decisao);
  if (!payload) {
    await marcarNaoExecutado(decisaoId, 'Não foi possível montar a execução: faltou um valor de orçamento decidido.');
    return { executado: false, motivo: 'sem_valor_para_executar' };
  }

  let siteId;
  try {
    const { rows: adsContaRows } = await pool.query('SELECT site_id FROM ads_contas WHERE conta_id = $1', [decisao.conta_id]);
    siteId = adsContaRows.length ? adsContaRows[0].site_id : null;
  } catch (e) { siteId = null; }
  if (!siteId) {
    await marcarNaoExecutado(decisaoId, 'Não foi possível executar: esta conta ainda não tem o site do Mercado Livre sincronizado (aguarde a próxima sincronização de Ads e aprove novamente).');
    return { executado: false, motivo: 'sem_site_id' };
  }

  let accessToken;
  try {
    const conta = await getContaComTokenValido(decisao.conta_id);
    accessToken = decrypt(conta.access_token_enc);
  } catch (err) {
    await marcarNaoExecutado(decisaoId, 'Não foi possível executar: ' + (err.message || 'token do Mercado Livre indisponível.'));
    return { executado: false, motivo: 'sem_token' };
  }

  try {
    const resposta = await mlAds.atualizarCampanha({ accessToken, siteId, campanhaId: decisao.campanha_id, ...payload });
    await pool.query(
      `UPDATE ia_decisoes_ads
          SET executado = true, executado_em = now(), execucao_resposta = $1, execucao_erro = NULL, atualizado_em = now()
        WHERE id = $2`,
      [JSON.stringify(resposta || {}), decisaoId]
    );
    return { executado: true, resposta };
  } catch (err) {
    const mensagemApi = (err && err.data && (err.data.message || err.data.error)) || err.message || 'Erro desconhecido ao chamar a API do Mercado Livre.';
    await marcarNaoExecutado(decisaoId, 'O Mercado Livre recusou a execução: ' + mensagemApi);
    return { executado: false, motivo: 'erro_api', erro: mensagemApi };
  }
}

async function marcarNaoExecutado(decisaoId, mensagem) {
  await pool.query(
    `UPDATE ia_decisoes_ads SET executado = false, execucao_erro = $1, atualizado_em = now() WHERE id = $2`,
    [mensagem, decisaoId]
  );
}

module.exports = {
  AGENTE_CODIGO,
  ACOES_EXECUTAVEIS,
  nivelPermissaoDaAcao,
  montarPayloadExecucao,
  executarDecisaoAprovada,
};
