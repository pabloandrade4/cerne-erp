// Orquestrador do ciclo automático da IA de Promoções (Fase B, 13/09/2026) —
// pedido explícito do usuário: "a cada uma hora a ia tem que busca novas
// promoções". Mesmo padrão de lib/ia/radar.js: um ciclo por empresa ativa,
// nunca deixa uma empresa com erro derrubar as outras (Promise.allSettled).
//
// O que o ciclo faz, por empresa:
//  1. Busca o catálogo de anúncios AO VIVO (título/imagem/SKU/preço) de cada
//     conta Mercado Livre ativa — lib/mlAnuncios.js (mesma fonte de sempre).
//  2. Busca o histórico de vendas dos últimos 90 dias (comissão/frete reais
//     por SKU) — lib/relatorioVendas.js (mesma fonte de "Margem por
//     Anúncio").
//  3. Busca o custo cadastrado de cada produto (tabela produtos) e a
//     configuração de margem mínima/imposto da empresa.
//  4. Para cada conta ativa: busca as promoções da conta e os itens de cada
//     promoção (lib/mlPromocoes.js) e calcula a margem real de cada item
//     (lib/promocoesMotor.js) — nunca escreve/altera nada no Mercado Livre,
//     só leitura.
//  5. Grava tudo em `promocoes_analises` (upsert por conta+promoção+item —
//     nunca duplica) e remove itens que já não aparecem mais como
//     candidatos/ativos (promoção encerrada ou item removido dela).
const pool = require('../../db/pool');
const { decrypt } = require('../crypto');
const { getContaComTokenValido } = require('../mlSync');
const { buscarTodosAnunciosDaConta } = require('../mlAnuncios');
const { buscarItensDoPeriodo } = require('../relatorioVendas');
const { buscarPromocoesDaConta, buscarItensDaPromocao } = require('../mlPromocoes');
const { calcularHistoricoPorSku, analisarItemPromocao, DIAS_HISTORICO_PADRAO } = require('../promocoesMotor');

async function buscarConfigPromocoes(empresaId) {
  const { rows } = await pool.query('SELECT margem_minima_pct FROM config_promocoes WHERE empresa_id = $1', [empresaId]);
  return rows.length ? Number(rows[0].margem_minima_pct) : 14;
}

async function buscarAliquotaImposto(empresaId) {
  const { rows } = await pool.query('SELECT aliquota_imposto FROM config_financeiro WHERE empresa_id = $1', [empresaId]);
  return rows.length ? Number(rows[0].aliquota_imposto) : 0;
}

async function buscarCustoPorSku(empresaId) {
  const { rows } = await pool.query('SELECT sku, custo FROM produtos WHERE empresa_id = $1 AND sku IS NOT NULL', [empresaId]);
  const mapa = new Map();
  rows.forEach((r) => mapa.set(r.sku, r.custo));
  return mapa;
}

async function upsertAnalise(linha) {
  await pool.query(
    `INSERT INTO promocoes_analises (
       empresa_id, conta_id, promotion_id, promotion_type, promotion_label,
       ml_item_id, status_item_ml, titulo, imagem_url, sku,
       preco_normal, preco_promo, origem_preco_promo,
       desconto_pct, desconto_bancado_meli_pct, desconto_bancado_vendedor_pct,
       custo_produto, tarifas_estimadas, frete_vendedor_estimado, imposto_estimado,
       margem_real, margem_real_pct, margem_minima_pct_usada,
       margem_incompleta, motivo_incompleto,
       classificacao_codigo, classificacao_label, atualizado_em
     ) VALUES (
       $1,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13, $14,$15,$16,
       $17,$18,$19,$20, $21,$22,$23, $24,$25, $26,$27, now()
     )
     ON CONFLICT (conta_id, promotion_id, ml_item_id) DO UPDATE SET
       empresa_id = EXCLUDED.empresa_id,
       promotion_type = EXCLUDED.promotion_type,
       promotion_label = EXCLUDED.promotion_label,
       status_item_ml = EXCLUDED.status_item_ml,
       titulo = EXCLUDED.titulo,
       imagem_url = EXCLUDED.imagem_url,
       sku = EXCLUDED.sku,
       preco_normal = EXCLUDED.preco_normal,
       preco_promo = EXCLUDED.preco_promo,
       origem_preco_promo = EXCLUDED.origem_preco_promo,
       desconto_pct = EXCLUDED.desconto_pct,
       desconto_bancado_meli_pct = EXCLUDED.desconto_bancado_meli_pct,
       desconto_bancado_vendedor_pct = EXCLUDED.desconto_bancado_vendedor_pct,
       custo_produto = EXCLUDED.custo_produto,
       tarifas_estimadas = EXCLUDED.tarifas_estimadas,
       frete_vendedor_estimado = EXCLUDED.frete_vendedor_estimado,
       imposto_estimado = EXCLUDED.imposto_estimado,
       margem_real = EXCLUDED.margem_real,
       margem_real_pct = EXCLUDED.margem_real_pct,
       margem_minima_pct_usada = EXCLUDED.margem_minima_pct_usada,
       margem_incompleta = EXCLUDED.margem_incompleta,
       motivo_incompleto = EXCLUDED.motivo_incompleto,
       classificacao_codigo = EXCLUDED.classificacao_codigo,
       classificacao_label = EXCLUDED.classificacao_label,
       atualizado_em = now()`,
    [
      linha.empresaId, linha.contaId, linha.promotionId, linha.promotionType, linha.promotionLabel,
      linha.mlItemId, linha.statusItemMl, linha.titulo, linha.imagemUrl, linha.sku,
      linha.precoNormal, linha.precoPromo, linha.origemPrecoPromo,
      linha.descontoPct, linha.descontoBancadoMeliPct, linha.descontoBancadoVendedorPct,
      linha.custoProduto, linha.tarifasEstimadas, linha.freteVendedorEstimado, linha.impostoEstimado,
      linha.margemReal, linha.margemRealPct, linha.margemMinimaPctUsada,
      linha.margemIncompleta, linha.motivoIncompleto,
      linha.classificacaoCodigo, linha.classificacaoLabel,
    ]
  );
}

// Remove da tabela os itens que já não aparecem mais como candidatos/ativos
// nas promoções atuais dessa conta (promoção encerrada, item removido dela)
// — evita a tela mostrar pra sempre um item que o Mercado Livre já não está
// mais oferecendo.
async function removerAnalisesForaDaLista(contaId, chavesAtuais) {
  if (!chavesAtuais.length) {
    await pool.query('DELETE FROM promocoes_analises WHERE conta_id = $1', [contaId]);
    return;
  }
  await pool.query(
    `DELETE FROM promocoes_analises
     WHERE conta_id = $1
       AND (promotion_id || '::' || ml_item_id) <> ALL($2::text[])`,
    [contaId, chavesAtuais]
  );
}

async function executarCicloPromocoesConta({ conta, custoPorSku, historicoPorSku, aliquotaImposto, margemMinimaPct }) {
  const contaComToken = await getContaComTokenValido(conta.id);
  const accessToken = decrypt(contaComToken.access_token_enc);

  const { itens: catalogo } = await buscarTodosAnunciosDaConta(conta.id);
  const catalogoPorItemId = new Map(catalogo.map((it) => [String(it.id), it]));

  const respostaPromocoes = await buscarPromocoesDaConta(accessToken, contaComToken.ml_user_id);
  if (!respostaPromocoes.ok) {
    throw new Error('Não foi possível buscar as promoções desta conta: ' + (respostaPromocoes.erro || 'erro na API do Mercado Livre'));
  }
  const promocoes = (respostaPromocoes.data && respostaPromocoes.data.results) || [];

  // Diagnóstico temporário (14/09/2026, pedido do usuário: a tela estava
  // trazendo anúncios de promoções que já não estão mais rodando) — loga o
  // formato REAL que a API devolve pra cada promoção antes de decidir, com
  // dado real (nunca adivinhado), qual campo representa "redução de
  // tarifa"/comissão (pedido separado do usuário, ainda não implementado).
  // Remover assim que confirmado.
  console.log(
    `[promoções ia][diagnóstico] conta ${conta.id} — ${promocoes.length} promoção(ões):`,
    JSON.stringify(promocoes.map((p) => ({
      id: p.id, type: p.type, status: p.status, name: p.name, title: p.title,
      start_date: p.start_date, finish_date: p.finish_date, deadline: p.deadline,
      benefits: p.benefits, fee: p.fee, commission: p.commission,
    })))
  );

  // Regra pedida pelo usuário (14/09/2026): só analisar promoções que estão
  // DE FATO rodando agora — nunca uma que já terminou (a API do Mercado
  // Livre continua listando promoções antigas/encerradas junto das ativas,
  // sempre com o `status` de cada uma). Toda promoção que não está mais
  // "started" fica de fora do laço abaixo — e como `removerAnalisesForaDaLista`
  // só mantém as chaves dos itens realmente processados aqui, o efeito
  // prático é exatamente o pedido: assim que uma promoção para, os itens
  // dela somem desta tela (voltam a ficar "sem promoção").
  const promocoesRodando = promocoes.filter((p) => p.status === 'started');

  const chavesAtuais = [];
  let itensAnalisados = 0;

  for (const promocao of promocoesRodando) {
    const promotionId = promocao.id;
    const promotionType = promocao.type;
    const promotionLabel = promocao.name || promocao.title || null;
    if (!promotionId || !promotionType) continue;

    let respostaItens;
    try {
      respostaItens = await buscarItensDaPromocao(accessToken, contaComToken.ml_user_id, promotionId, promotionType);
    } catch (err) {
      console.error(`[promoções ia] falha ao buscar itens da promoção ${promotionId} (conta ${conta.id}): ${err.message}`);
      continue;
    }
    if (!respostaItens.ok) {
      console.error(`[promoções ia] falha ao buscar itens da promoção ${promotionId} (conta ${conta.id}): ${respostaItens.erro || 'erro na API'}`);
      continue;
    }

    const itensDaPromocao = (respostaItens.data && respostaItens.data.results) || [];
    for (const item of itensDaPromocao) {
      if (!item.id) continue;
      const catalogEntry = catalogoPorItemId.get(String(item.id)) || null;
      const linha = analisarItemPromocao({
        item,
        catalogEntry,
        historicoPorSku,
        custoPorSku,
        aliquotaImposto,
        margemMinimaPct,
        contexto: {
          empresaId: conta.empresa_id,
          contaId: conta.id,
          promotionId,
          promotionType,
          promotionLabel,
        },
      });
      await upsertAnalise(linha);
      chavesAtuais.push(promotionId + '::' + item.id);
      itensAnalisados += 1;
    }
  }

  await removerAnalisesForaDaLista(conta.id, chavesAtuais);
  return { promocoesEncontradas: promocoesRodando.length, itensAnalisados };
}

async function executarCicloPromocoesEmpresa(empresaId) {
  const empresaRow = await pool.query('SELECT id FROM empresas WHERE id = $1 AND ativo = TRUE', [empresaId]);
  if (!empresaRow.rows.length) return { empresaId, ignorado: true };

  const { rows: contas } = await pool.query(
    "SELECT * FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY id",
    [empresaId]
  );
  if (!contas.length) return { empresaId, contasProcessadas: 0, itensAnalisados: 0, comErro: [] };

  const [margemMinimaPct, aliquotaImposto, custoPorSku] = await Promise.all([
    buscarConfigPromocoes(empresaId),
    buscarAliquotaImposto(empresaId),
    buscarCustoPorSku(empresaId),
  ]);

  const agora = new Date();
  const desde = new Date(agora.getTime() - DIAS_HISTORICO_PADRAO * 24 * 60 * 60 * 1000);
  const { itens: itensPeriodo } = await buscarItensDoPeriodo({ empresaId, desde, ate: agora });
  const historicoPorSku = calcularHistoricoPorSku(itensPeriodo);

  let itensAnalisados = 0;
  const comErro = [];
  for (const conta of contas) {
    try {
      const resultadoConta = await executarCicloPromocoesConta({ conta, custoPorSku, historicoPorSku, aliquotaImposto, margemMinimaPct });
      itensAnalisados += resultadoConta.itensAnalisados;
    } catch (err) {
      comErro.push({ contaId: conta.id, erro: err.message });
      console.error(`[promoções ia] conta ${conta.id} (empresa ${empresaId}) falhou: ${err.message}`);
    }
  }

  return { empresaId, contasProcessadas: contas.length, itensAnalisados, comErro };
}

async function executarCicloPromocoes() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloPromocoesEmpresa(e.id)));

  const comErro = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      const empresaId = empresas[i].id;
      comErro.push({ empresaId, erro: String((r.reason && r.reason.message) || r.reason) });
      console.error(`[promoções ia] empresa ${empresaId} falhou: ${comErro[comErro.length - 1].erro}`);
    }
  });

  return { empresasProcessadas: empresas.length, comErro };
}

module.exports = {
  executarCicloPromocoesEmpresa,
  executarCicloPromocoes,
};
