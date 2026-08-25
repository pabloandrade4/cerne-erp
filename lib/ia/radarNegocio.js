// Radar da IA — análise contínua do NEGÓCIO INTEIRO (Passo 2 do pedido do
// usuário, ver docs/02-decisoes.md): custos, Ads agregado, estoque,
// financeiro, fluxo de caixa e compras. Só regras/cálculos determinísticos
// aqui (nenhuma chamada ao modelo de IA neste arquivo) — sempre em cima das
// MESMAS fontes já usadas pelo resto do ERP (lib/relatoriosAgregados.js,
// lib/contasPagar.js, lib/contasReceber.js, lib/visaoGeralPainel.js,
// lib/compras.js) — nenhum cálculo financeiro novo é criado aqui.
const pool = require('../../db/pool');
const { relatorioProdutos } = require('../relatoriosAgregados');
const { resumoContasPagar } = require('../contasPagar');
const { resumoContasReceber } = require('../contasReceber');
const { resumoRecebimentos, fluxoDeCaixa } = require('../visaoGeralPainel');
const { resumoComprasPorFornecedor } = require('../compras');
const { buscarPedidosDoPeriodo } = require('../relatorioVendas');
const { round2 } = require('../resultadoVenda');
const { diaBRT } = require('../periodo');
const CFG = require('./radarConfig');

const UM_DIA_MS = 24 * 60 * 60 * 1000;

function formatMoney(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------- 1) Custos: impacto de alteração no cadastro ----------------
// Compara o custo ATUAL de cada produto com o último valor conhecido
// (radar_snapshot_custos) — só existe alerta quando o custo realmente MUDOU
// desde o ciclo anterior (nunca um alerta "a toa" todo ciclo). A margem
// "antes"/"depois" são duas leituras REAIS separadas no tempo (nunca um
// recálculo hipotético) — ver comentário da tabela em db/schema.sql.
async function analisarCustos({ empresaId, agora }) {
  const situacoes = [];
  const desde30 = new Date(agora.getTime() - 30 * UM_DIA_MS);

  const [{ rows: produtos }, { linhas: produtosDesempenho }, { rows: snapshots }] = await Promise.all([
    pool.query('SELECT sku, custo FROM produtos WHERE empresa_id = $1 AND ativo = TRUE', [empresaId]),
    relatorioProdutos({ empresaId, desde: desde30, ate: agora }),
    pool.query('SELECT sku, custo, margem_percentual_30d FROM radar_snapshot_custos WHERE empresa_id = $1', [empresaId]),
  ]);

  const margemPorSku = new Map();
  produtosDesempenho.forEach((l) => {
    if (l.faturamento && l.margemContribuicao !== null) margemPorSku.set(l.sku, round2((l.margemContribuicao / l.faturamento) * 100));
  });
  const snapshotPorSku = new Map(snapshots.map((s) => [s.sku, { custo: Number(s.custo), margem: s.margem_percentual_30d !== null ? Number(s.margem_percentual_30d) : null }]));

  for (const p of produtos) {
    const custoAtual = Number(p.custo);
    const margemAtual = margemPorSku.has(p.sku) ? margemPorSku.get(p.sku) : null;
    const anterior = snapshotPorSku.get(p.sku);

    if (anterior && round2(anterior.custo) !== round2(custoAtual) && anterior.margem !== null && margemAtual !== null) {
      const subiu = custoAtual > anterior.custo;
      situacoes.push({
        chave: 'custo_alterado:' + p.sku, categoria: 'custo_alterado', severidade: margemAtual < anterior.margem ? 'atencao' : 'informativo',
        titulo: `O custo de ${p.sku} ${subiu ? 'aumentou' : 'diminuiu'} e sua margem foi de ${anterior.margem.toLocaleString('pt-BR')}% para ${margemAtual.toLocaleString('pt-BR')}%`,
        descricao: `O custo cadastrado de ${p.sku} ${subiu ? 'subiu' : 'caiu'} de ${formatMoney(anterior.custo)} para ${formatMoney(custoAtual)}. A margem de contribuição sobre as vendas dos últimos 30 dias foi de ${anterior.margem.toLocaleString('pt-BR')}% para ${margemAtual.toLocaleString('pt-BR')}%.`,
        recomendacaoPadrao: margemAtual < anterior.margem
          ? 'A margem caiu depois dessa mudança de custo. Vale revisar o preço de venda deste produto para recuperar a margem, se possível.'
          : 'A margem melhorou depois dessa mudança de custo — nenhuma ação necessária.',
        pagina: 'products', dados: { sku: p.sku, custoAnterior: anterior.custo, custoAtual, margemPercentualAnterior: anterior.margem, margemPercentualAtual: margemAtual }, valorEnvolvido: null,
      });
    }

    // Sempre grava o snapshot mais recente (upsert) — mesmo sem alerta —
    // pra o PRÓXIMO ciclo sempre ter algo pra comparar.
    await pool.query(
      `INSERT INTO radar_snapshot_custos (empresa_id, sku, custo, margem_percentual_30d, capturado_em)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (empresa_id, sku) DO UPDATE SET custo = EXCLUDED.custo, margem_percentual_30d = EXCLUDED.margem_percentual_30d, capturado_em = now()`,
      [empresaId, p.sku, custoAtual, margemAtual]
    );
  }

  return situacoes;
}

// ---------------- 2) Ads agregado: gastando sem vender / consumindo margem ----------------
function analisarAdsAgregado({ adsResultado30 }) {
  const situacoes = [];
  if (!adsResultado30 || adsResultado30.semConta) return situacoes;

  (adsResultado30.linhas || []).forEach((l) => {
    const chaveBase = l.mlItemId ? ('ml:' + l.mlItemId) : (l.sku ? ('sku:' + l.sku) : null);
    if (!chaveBase) return;
    const nome = l.sku ? (l.anuncio ? `${l.sku} (${l.anuncio})` : l.sku) : (l.anuncio || chaveBase);

    if (l.investimento && l.investimento > 0 && (!l.quantidadeVendidaReal || l.quantidadeVendidaReal === 0)) {
      situacoes.push({
        chave: 'ads_gastando_sem_vender:' + chaveBase, categoria: 'ads_gastando_sem_vender', severidade: 'atencao',
        titulo: `${nome} está gastando em Ads sem gerar venda real`,
        descricao: `Nos últimos 30 dias, ${formatMoney(l.investimento)} foram investidos em Ads neste anúncio, mas nenhuma venda real foi registrada no período.`,
        recomendacaoPadrao: 'Revise se este anúncio ainda vale o investimento em Ads — considere pausar a campanha ou revisar segmentação/criativo (a IA não altera o Ads, essa ação é sua).',
        pagina: 'ads', dados: { sku: l.sku, mlItemId: l.mlItemId, investimento30d: l.investimento, quantidadeVendida30d: l.quantidadeVendidaReal || 0 }, valorEnvolvido: l.investimento,
      });
    } else if (l.investimento && l.margemAntesDoAds && l.margemAntesDoAds > 0 && (l.investimento / l.margemAntesDoAds) >= 0.5) {
      const pctConsumido = round2((l.investimento / l.margemAntesDoAds) * 100);
      situacoes.push({
        chave: 'ads_consumindo_margem:' + chaveBase, categoria: 'ads_consumindo_margem', severidade: 'atencao',
        titulo: `Ads está consumindo ${pctConsumido.toLocaleString('pt-BR')}% da margem de ${nome}`,
        descricao: `Nos últimos 30 dias, o investimento em Ads (${formatMoney(l.investimento)}) consumiu ${pctConsumido.toLocaleString('pt-BR')}% da margem de contribuição gerada por este anúncio antes do Ads (${formatMoney(l.margemAntesDoAds)}).`,
        recomendacaoPadrao: 'O Ads está tomando uma fatia grande da margem deste anúncio. Vale revisar o quanto está sendo investido versus o retorno real gerado.',
        pagina: 'ads', dados: { sku: l.sku, mlItemId: l.mlItemId, investimento30d: l.investimento, margemAntesDoAds30d: l.margemAntesDoAds, percentualConsumido: pctConsumido }, valorEnvolvido: l.investimento,
      });
    }
  });

  return situacoes;
}

// ---------------- 3) Estoque: cobertura estimada, zerado, excesso ----------------
async function analisarEstoque({ empresaId, agora }) {
  const situacoes = [];
  const desde30 = new Date(agora.getTime() - 30 * UM_DIA_MS);

  const [{ rows: estoqueRows }, { linhas: produtosDesempenho }] = await Promise.all([
    pool.query(
      `SELECT sku, SUM(quantidade) AS quantidade, bool_and(NOT pendente) AS sincronizado
       FROM ml_estoque_itens WHERE empresa_id = $1 AND sku IS NOT NULL GROUP BY sku`,
      [empresaId]
    ),
    relatorioProdutos({ empresaId, desde: desde30, ate: agora }),
  ]);

  const qtdVendidaPorSku = new Map(produtosDesempenho.map((l) => [l.sku, l.quantidade || 0]));

  for (const r of estoqueRows) {
    if (!r.sincronizado || r.quantidade === null) continue;
    const estoqueAtual = Number(r.quantidade);
    const qtd30 = qtdVendidaPorSku.get(r.sku) || 0;
    const velocidadeDiaria = qtd30 / 30;

    if (estoqueAtual === 0) continue; // já coberto pelo alerta "estoque zerado" existente (Visão Geral > Alertas & IA) — nunca duplicar aqui.

    if (velocidadeDiaria > 0) {
      const coberturaDias = Math.floor(estoqueAtual / velocidadeDiaria);
      if (coberturaDias <= CFG.ESTOQUE_COBERTURA_CRITICA_DIAS) {
        situacoes.push({
          chave: 'estoque_cobertura_critica:' + r.sku, categoria: 'estoque_cobertura_critica', severidade: 'critico',
          titulo: `Estoque de ${r.sku} cobre só ${coberturaDias} dia(s) no ritmo atual`,
          descricao: `No ritmo atual de vendas (${qtd30} unidades nos últimos 30 dias), o estoque de ${estoqueAtual} unidade(s) de ${r.sku} cobre aproximadamente ${coberturaDias} dia(s).`,
          recomendacaoPadrao: 'Estoque crítico pelo ritmo atual de vendas — vale providenciar reposição o quanto antes para não perder venda por falta de produto.',
          pagina: 'purchases', dados: { sku: r.sku, estoqueAtual, quantidadeVendida30d: qtd30, coberturaEstimadaDias: coberturaDias }, valorEnvolvido: null,
        });
      } else if (coberturaDias <= CFG.ESTOQUE_COBERTURA_BAIXA_DIAS) {
        situacoes.push({
          chave: 'estoque_cobertura_baixa:' + r.sku, categoria: 'estoque_cobertura_baixa', severidade: 'atencao',
          titulo: `Estoque de ${r.sku} cobre aproximadamente ${coberturaDias} dias`,
          descricao: `No ritmo atual de vendas, o estoque da ${r.sku} cobre aproximadamente ${coberturaDias} dias.`,
          recomendacaoPadrao: 'Vale planejar a reposição deste produto nas próximas semanas, antes que o estoque fique crítico.',
          pagina: 'purchases', dados: { sku: r.sku, estoqueAtual, quantidadeVendida30d: qtd30, coberturaEstimadaDias: coberturaDias }, valorEnvolvido: null,
        });
      } else if (coberturaDias >= CFG.ESTOQUE_COBERTURA_EXCESSO_DIAS) {
        situacoes.push({
          chave: 'estoque_excesso:' + r.sku, categoria: 'estoque_excesso', severidade: 'informativo',
          titulo: `${r.sku} possui estoque alto para o ritmo atual de vendas`,
          descricao: `No ritmo atual de vendas, o estoque de ${estoqueAtual} unidade(s) de ${r.sku} cobre aproximadamente ${coberturaDias} dias — bem mais do que o normal.`,
          recomendacaoPadrao: 'Estoque alto para o ritmo de vendas atual — pode valer considerar uma promoção ou reforço de exposição para girar esse produto.',
          pagina: 'stock', dados: { sku: r.sku, estoqueAtual, quantidadeVendida30d: qtd30, coberturaEstimadaDias: coberturaDias }, valorEnvolvido: null,
        });
      }
    }
  }

  return { situacoes, coberturaPorSku: new Map(estoqueRows.filter((r) => r.sincronizado && r.quantidade !== null).map((r) => {
    const qtd30 = qtdVendidaPorSku.get(r.sku) || 0;
    const velocidadeDiaria = qtd30 / 30;
    return [r.sku, { estoqueAtual: Number(r.quantidade), coberturaDias: velocidadeDiaria > 0 ? Math.floor(Number(r.quantidade) / velocidadeDiaria) : null }];
  })) };
}

// ---------------- 4) Financeiro + 5) Fluxo de caixa (risco) ----------------
async function analisarFinanceiroEFluxo({ empresaId, agora }) {
  const situacoes = [];
  const hojeStr = diaBRT(agora);
  const [contasAPagar, contasAReceber, { pedidos }] = await Promise.all([
    resumoContasPagar({ empresaId, desde: hojeStr, ate: hojeStr }),
    resumoContasReceber({ empresaId, desde: hojeStr, ate: hojeStr }),
    buscarPedidosDoPeriodo({ empresaId, desde: new Date(agora.getTime() - 7 * UM_DIA_MS), ate: agora }),
  ]);

  if (contasAPagar.vencidas > 0) {
    situacoes.push({
      chave: 'financeiro_contas_vencidas', categoria: 'financeiro_contas_vencidas', severidade: 'critico',
      titulo: `${formatMoney(contasAPagar.vencidas)} em contas a pagar vencidas`,
      descricao: `Existem ${formatMoney(contasAPagar.vencidas)} em contas a pagar já vencidas e ainda em aberto.`,
      recomendacaoPadrao: 'Vale regularizar essas contas o quanto antes para evitar juros, multas ou problemas com fornecedores.',
      pagina: 'payable', dados: { valorVencido: contasAPagar.vencidas }, valorEnvolvido: contasAPagar.vencidas,
    });
  }
  if (contasAPagar.vencendoProximos7Dias > 0) {
    situacoes.push({
      chave: 'financeiro_contas_vencendo_semana', categoria: 'financeiro_contas_vencendo_semana', severidade: 'atencao',
      titulo: `${formatMoney(contasAPagar.vencendoProximos7Dias)} em contas vencem esta semana`,
      descricao: `${formatMoney(contasAPagar.vencendoProximos7Dias)} em contas a pagar vencem nos próximos 7 dias.`,
      recomendacaoPadrao: 'Organize o caixa para cobrir esses pagamentos nos próximos dias.',
      pagina: 'payable', dados: { valorVencendoProximos7Dias: contasAPagar.vencendoProximos7Dias }, valorEnvolvido: contasAPagar.vencendoProximos7Dias,
    });
  }
  if (contasAReceber.previstoProximos7Dias > 0) {
    situacoes.push({
      chave: 'financeiro_recebimentos_semana', categoria: 'financeiro_recebimentos_semana', severidade: 'informativo',
      titulo: `${formatMoney(contasAReceber.previstoProximos7Dias)} devem ser recebidos nos próximos dias`,
      descricao: `${formatMoney(contasAReceber.previstoProximos7Dias)} em contas a receber estão previstas para os próximos 7 dias.`,
      recomendacaoPadrao: 'Informativo — nenhuma ação necessária.',
      pagina: 'receivable', dados: { valorPrevistoProximos7Dias: contasAReceber.previstoProximos7Dias }, valorEnvolvido: contasAReceber.previstoProximos7Dias,
    });
  }

  // Fluxo de caixa (risco) — NUNCA um saldo bancário (o ERP não tem esse
  // cadastro, ver docs/01-regras-de-negocio.md): compara só valores
  // PREVISTOS reais (contas a pagar vencendo em breve vs. contas a receber
  // + recebimentos do Mercado Livre esperados no mesmo prazo).
  const recebimentosMl = resumoRecebimentos(pedidos.filter((p) => !p.cancelado));
  const aPagarProximos = round2(contasAPagar.vencendoProximos7Dias + contasAPagar.vencidas);
  const aReceberProximos = round2(contasAReceber.previstoProximos7Dias + (recebimentosMl.valorLiquidoEsperado || 0));
  if (aPagarProximos > 0 && aReceberProximos >= 0 && (aReceberProximos === 0 || aPagarProximos / aReceberProximos >= CFG.FLUXO_CAIXA_RISCO_MULTIPLO)) {
    situacoes.push({
      chave: 'fluxo_caixa_risco', categoria: 'fluxo_caixa_risco', severidade: 'critico',
      titulo: `Risco de aperto no caixa nos próximos ${CFG.FLUXO_CAIXA_JANELA_DIAS} dias`,
      descricao: `Nos próximos ${CFG.FLUXO_CAIXA_JANELA_DIAS} dias há ${formatMoney(aPagarProximos)} em contas a pagar (vencidas + vencendo) contra ${formatMoney(aReceberProximos)} previstos para entrar (contas a receber + recebimentos esperados do Mercado Livre).`,
      recomendacaoPadrao: 'Os pagamentos previstos superam bastante os recebimentos previstos no mesmo prazo. Vale planejar como cobrir essa diferença (negociar prazos, antecipar recebíveis, ou adiar despesas não essenciais).',
      pagina: 'payable', dados: { aPagarProximos7Dias: aPagarProximos, aReceberProximos7Dias: aReceberProximos }, valorEnvolvido: round2(aPagarProximos - aReceberProximos),
    });
  }

  return situacoes;
}

// ---------------- 6) Compras: o que precisa ser comprado ----------------
async function analisarCompras({ empresaId, agora, coberturaPorSku }) {
  const situacoes = [];
  const { rows: produtos } = await pool.query('SELECT sku, custo FROM produtos WHERE empresa_id = $1 AND ativo = TRUE', [empresaId]);
  const custoPorSku = new Map(produtos.map((p) => [p.sku, Number(p.custo)]));

  const [{ rows: comprasAbertas }, contasAPagar, contasAReceber] = await Promise.all([
    pool.query(`SELECT ci.produto_id, p.sku FROM compras c JOIN compra_itens ci ON ci.compra_id = c.id JOIN produtos p ON p.id = ci.produto_id WHERE c.empresa_id = $1 AND c.status IN ('em_aberto','pedido_realizado')`, [empresaId]),
    resumoContasPagar({ empresaId, desde: diaBRT(agora), ate: diaBRT(agora) }),
    resumoContasReceber({ empresaId, desde: diaBRT(agora), ate: diaBRT(agora) }),
  ]);
  const skusComCompraAberta = new Set(comprasAbertas.map((c) => c.sku));
  const folgaProximosDias = round2(contasAReceber.previstoProximos7Dias - contasAPagar.vencendoProximos7Dias - contasAPagar.vencidas);

  for (const [sku, info] of coberturaPorSku) {
    if (info.coberturaDias === null || info.coberturaDias > CFG.ESTOQUE_COBERTURA_BAIXA_DIAS) continue;
    if (skusComCompraAberta.has(sku)) continue; // já existe compra em andamento — nunca sugerir de novo
    const custo = custoPorSku.get(sku);
    if (custo === undefined) continue;

    // Estimativa simples de quanto comprar: cobrir 30 dias de venda no
    // ritmo atual, descontando o que já existe em estoque — nunca um
    // número negativo/zero.
    const qtdVenda30 = info.coberturaDias > 0 ? Math.round((info.estoqueAtual / info.coberturaDias) * 30) : 0;
    const qtdSugerida = Math.max(qtdVenda30 - info.estoqueAtual, 0);
    if (qtdSugerida <= 0) continue;
    const valorEstimado = round2(qtdSugerida * custo);

    const apertaOCaixa = valorEstimado > folgaProximosDias;
    situacoes.push({
      chave: 'compra_necessaria:' + sku, categoria: 'compra_necessaria', severidade: apertaOCaixa ? 'atencao' : 'informativo',
      titulo: `${sku} precisa de reposição — estoque cobre só ${info.coberturaDias} dia(s)`,
      descricao: `Comprar aproximadamente ${qtdSugerida} unidade(s) de ${sku} (${formatMoney(valorEstimado)}, pelo custo cadastrado) cobriria cerca de 30 dias no ritmo atual de vendas.`
        + (apertaOCaixa ? ` Fazer essa compra agora deixaria o caixa apertado antes dos próximos recebimentos: nos próximos ${CFG.FLUXO_CAIXA_JANELA_DIAS} dias há ${formatMoney(contasAPagar.vencendoProximos7Dias + contasAPagar.vencidas)} em contas a pagar previstas contra ${formatMoney(contasAReceber.previstoProximos7Dias)} de recebimentos previstos.` : ''),
      recomendacaoPadrao: apertaOCaixa
        ? 'Você precisa comprar este produto, mas fazer essa compra agora pode deixar o caixa apertado antes dos próximos recebimentos. Vale avaliar o momento certo ou negociar prazo com o fornecedor.'
        : 'Vale providenciar essa compra para não ficar sem estoque deste produto.',
      pagina: 'purchases', dados: { sku, estoqueAtual: info.estoqueAtual, coberturaDiasAtual: info.coberturaDias, quantidadeSugerida: qtdSugerida, valorEstimado, folgaDeCaixaProximos7Dias: folgaProximosDias }, valorEnvolvido: valorEstimado,
    });
  }

  return situacoes;
}

async function analisarNegocio({ empresaId, adsResultado30 }) {
  const agora = new Date();
  const [custos, ads, estoqueResultado, financeiro] = await Promise.all([
    analisarCustos({ empresaId, agora }),
    Promise.resolve(analisarAdsAgregado({ adsResultado30 })),
    analisarEstoque({ empresaId, agora }),
    analisarFinanceiroEFluxo({ empresaId, agora }),
  ]);
  const compras = await analisarCompras({ empresaId, agora, coberturaPorSku: estoqueResultado.coberturaPorSku });

  return [...custos, ...ads, ...estoqueResultado.situacoes, ...financeiro, ...compras];
}

module.exports = { analisarNegocio };
