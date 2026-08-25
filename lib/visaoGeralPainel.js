// Visão Geral — blocos "Evolução diária / Por marketplace", "Fluxo de
// Caixa / Conexões & Empresas" e "Alertas & IA", ativados em 26/08/2026
// (pedido do usuário, em 3 passos — ver docs/02-decisoes.md e
// docs/04-alteracoes.md).
//
// Regras centrais do usuário, repetidas aqui de propósito:
//   1) NUNCA inventar dado — quando algo não pode ser calculado com certeza
//      (custo faltando, saldo bancário não cadastrado, API sem retorno),
//      o campo vem `null` com um motivo, nunca um número estimado.
//   2) NUNCA criar um cálculo financeiro diferente do que Visão Geral,
//      Pedidos, Financeiro e Relatórios já usam. Por isso este arquivo não
//      soma nada com fórmula própria — só reaproveita
//      lib/relatorioVendas.js (buscarPedidosDoPeriodo/resumirPeriodo/
//      buscarItensDoPeriodo — a MESMA fonte única de sempre),
//      lib/contasPagar.js, lib/contasReceber.js e lib/recebimentosMl.js,
//      além das tabelas ml_contas/ml_estoque_itens/empresas já existentes,
//      só filtrando/agrupando o que elas já calculam.
//   3) Empresa e período respeitam SEMPRE o filtro do header — nenhum
//      destes blocos tem filtro próprio.
const pool = require('../db/pool');
const { calcularPeriodo, periodoParaDatasBRT } = require('./periodo');
const { buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo } = require('./relatorioVendas');
const { resumoContasPagar } = require('./contasPagar');
const { resumoContasReceber } = require('./contasReceber');
const { elegivel, serializeRecebimento } = require('./recebimentosMl');
const { round2 } = require('./resultadoVenda');
// Radar da IA (25/08/2026) — leitura só (SELECT) do que o ciclo periódico
// já persistiu em segundo plano (ver lib/ia/radar.js/radarScheduler.js).
// Puramente ADITIVO: nenhuma regra/alerta já existente neste arquivo foi
// alterada — o campo `radar` é só mais uma chave no retorno de
// painelVisaoGeral, pro painel "Alertas & IA" mostrar os dois lados.
//
// require() feito DENTRO da função (lazy), não aqui no topo do arquivo, de
// propósito: lib/ia/radar.js -> lib/ia/radarNegocio.js -> este arquivo (pra
// reusar resumoRecebimentos/fluxoDeCaixa) fecha uma dependência circular
// com este módulo. Um require() no topo pegaria os exports de radar.js
// ainda incompletos nesse ciclo (obterRadarParaEmpresa viraria undefined,
// silenciosamente). Adiar o require pra dentro da função evita isso: por
// essa altura (execução em runtime, não em tempo de carregar módulos)
// todos os módulos já terminaram de carregar.

// "Muito baixo" — um limiar simples e declarado (não é previsão de demanda,
// é só o ponto de partida da central de alertas pedida pelo usuário:
// "não precisa criar ainda uma IA complexa"). Documentado em
// docs/02-decisoes.md — pode virar configurável numa etapa futura.
const ESTOQUE_BAIXO_LIMITE = 5;

function formatMoney(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------- Por marketplace ----------------
// Todo pedido hoje vem de ml_pedidos (join com ml_contas) — não existe
// nenhuma outra origem de pedido no ERP ainda, então o canal é sempre
// "Mercado Livre". Centralizado numa função só pra que, quando uma segunda
// integração existir (ex: Shopee), baste os pedidos dela informarem seu
// próprio canal aqui — sem alterar mais nada desta tela (pedido explícito
// do usuário: "quando houver outras integrações, elas devem entrar
// automaticamente").
function identificarCanal(pedido) {
  return 'Mercado Livre';
}

function porCanal(pedidos) {
  // MESMA função (resumirPeriodo) usada em Visão Geral/Pedidos/Financeiro/
  // Relatórios — nunca uma soma nova. Chamada uma vez pro total geral, e de
  // novo por canal (mesma ideia já usada em relatoriosAgregados.relatorioMarketplaces,
  // só que agrupando por canal em vez de por loja).
  const resumoGeral = resumirPeriodo(pedidos);
  const totalFaturamento = resumoGeral.faturamento.valor;

  const naoCancelados = pedidos.filter((p) => !p.cancelado);
  const grupos = new Map();
  naoCancelados.forEach((p) => {
    const canal = identificarCanal(p);
    if (!grupos.has(canal)) grupos.set(canal, []);
    grupos.get(canal).push(p);
  });

  const linhas = [...grupos.entries()].map(([canal, pedidosDoCanal]) => {
    const resumo = resumirPeriodo(pedidosDoCanal);
    const participacaoPercentual = (totalFaturamento !== null && totalFaturamento !== 0 && resumo.faturamento.valor !== null)
      ? round2((resumo.faturamento.valor / totalFaturamento) * 100)
      : null;
    return { canal, qtdPedidos: resumo.qtdPedidos, faturamento: resumo.faturamento, participacaoPercentual };
  }).sort((a, b) => (b.faturamento.valor || 0) - (a.faturamento.valor || 0));

  return { linhas, totalFaturamento };
}

// ---------------- Fluxo de caixa ----------------
// "Recebimentos" aqui reaproveita os MESMOS pedidos elegíveis já buscados
// pra esta chamada (nunca uma segunda consulta) — é o mesmo dado mostrado
// na tela Recebimentos (lib/recebimentosMl.js), só somado.
function resumoRecebimentos(pedidos) {
  const recebimentos = pedidos.filter(elegivel).map(serializeRecebimento);
  let soma = 0, temValor = false, pendentes = 0;
  recebimentos.forEach((r) => {
    if (r.valorLiquidoEsperado === null) pendentes++;
    else { soma += r.valorLiquidoEsperado; temValor = true; }
  });
  return {
    quantidade: recebimentos.length,
    valorLiquidoEsperado: temValor ? round2(soma) : null,
    pendentes,
  };
}

async function fluxoDeCaixa({ empresaId, desdeStr, ateStr, pedidos }) {
  const [contasAPagar, contasAReceber] = await Promise.all([
    resumoContasPagar({ empresaId, desde: desdeStr, ate: ateStr }),
    resumoContasReceber({ empresaId, desde: desdeStr, ate: ateStr }),
  ]);
  const recebimentosMl = resumoRecebimentos(pedidos);

  return {
    contasAPagar,
    contasAReceber,
    recebimentosMl,
    // O ERP ainda não tem nenhum cadastro de saldo bancário real — sem um
    // saldo inicial de verdade, "saldo projetado" nunca pode ser calculado
    // com segurança. Regra explícita do usuário: "se ainda não existir
    // saldo bancário real cadastrado, NÃO invente um saldo em banco".
    // Por isso este campo fica sempre `null` com o motivo, nunca um número.
    saldoProjetado: { valor: null, motivo: 'sem_saldo_bancario_cadastrado' },
  };
}

// ---------------- Conexões & empresas ----------------
async function conexoesEEmpresas(empresaId) {
  const [{ rows: totalEmpresasRows }, { rows: contasRows }, { rows: contasShopeeRows }] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM empresas'),
    pool.query(
      `SELECT id, nickname, status, ultimo_erro, ultima_sincronizacao_em
       FROM ml_contas WHERE empresa_id = $1 ORDER BY created_at DESC`,
      [empresaId]
    ),
    pool.query(
      `SELECT id, shop_name, shopee_shop_id, status, ultimo_erro, ultima_sincronizacao_em
       FROM shopee_contas WHERE empresa_id = $1 ORDER BY created_at DESC`,
      [empresaId]
    ),
  ]);

  const ultimaSincronizacao = contasRows.reduce((max, c) => {
    if (!c.ultima_sincronizacao_em) return max;
    return !max || c.ultima_sincronizacao_em > max ? c.ultima_sincronizacao_em : max;
  }, null);

  let status = 'sem_conta';
  if (contasRows.some((c) => c.status === 'ativa')) status = 'ativa';
  else if (contasRows.some((c) => c.status === 'erro')) status = 'erro';
  else if (contasRows.length) status = 'desconectada';

  // Shopee (25/08/2026) — mesma lógica de status acima, agora com dado real
  // (shopee_contas). "ultimaSincronizacao" aqui fica sempre null: esta etapa
  // só conecta a loja (OAuth + renovação de token), pedidos da Shopee ainda
  // não são importados (fora do escopo pedido) — nunca inventamos essa data.
  let statusShopee = 'sem_conta';
  if (contasShopeeRows.some((c) => c.status === 'ativa')) statusShopee = 'ativa';
  else if (contasShopeeRows.some((c) => c.status === 'erro')) statusShopee = 'erro';
  else if (contasShopeeRows.length) statusShopee = 'desconectada';

  return {
    empresas: { total: totalEmpresasRows[0].total },
    mercadoLivre: {
      contasConectadas: contasRows.length,
      status,
      ultimaSincronizacao,
      contas: contasRows.map((c) => ({
        id: c.id, nickname: c.nickname, status: c.status, ultimoErro: c.ultimo_erro, ultimaSincronizacao: c.ultima_sincronizacao_em,
      })),
    },
    shopee: {
      contasConectadas: contasShopeeRows.length,
      status: statusShopee,
      contas: contasShopeeRows.map((c) => ({
        id: c.id, shopName: c.shop_name, shopId: String(c.shopee_shop_id), status: c.status, ultimoErro: c.ultimo_erro, ultimaSincronizacao: c.ultima_sincronizacao_em,
      })),
    },
  };
}

// ---------------- Alertas & IA (regras simples, sobre dado real) ----------------
async function gerarAlertas({ empresaId, pedidos, itens, fluxoCaixa, conexoes }) {
  const alertas = [];

  // 1) SKU sem custo cadastrado — a partir dos ITENS vendidos no período
  // (mesmo dado de Relatórios > Produtos: pr.custo IS NULL por causa do
  // LEFT JOIN, ou seja, nenhum produto cadastrado com esse SKU).
  const skusSemCusto = [...new Set(
    itens.filter((it) => it.sku && it.custoProduto === null).map((it) => it.sku)
  )];
  if (skusSemCusto.length === 1) {
    alertas.push({
      id: 'sku-sem-custo', tipo: 'sku_sem_custo', severidade: 'warning',
      titulo: 'SKU ' + skusSemCusto[0] + ' está sem custo cadastrado',
      descricao: 'Sem o custo cadastrado, a margem de contribuição das vendas desse SKU não pode ser calculada.',
      pagina: 'products',
    });
  } else if (skusSemCusto.length > 1) {
    const exemplos = skusSemCusto.slice(0, 3).join(', ') + (skusSemCusto.length > 3 ? '…' : '');
    alertas.push({
      id: 'sku-sem-custo', tipo: 'sku_sem_custo', severidade: 'warning',
      titulo: skusSemCusto.length + ' SKUs vendidos no período estão sem custo cadastrado',
      descricao: 'Incluindo ' + exemplos + '. Sem custo cadastrado, a margem dessas vendas não pode ser calculada.',
      pagina: 'products',
    });
  }

  // 2) Pedido sem custo, impedindo cálculo correto da margem (nível do
  // PEDIDO — buscarPedidosDoPeriodo já expõe custoProduto null quando
  // algum item dele não bate com nenhum SKU cadastrado).
  const pedidosSemCusto = pedidos.filter((p) => !p.cancelado && p.custoProduto === null);
  if (pedidosSemCusto.length) {
    alertas.push({
      id: 'pedido-sem-custo', tipo: 'pedido_sem_custo', severidade: 'warning',
      titulo: pedidosSemCusto.length === 1
        ? '1 pedido no período está sem custo de produto, impedindo o cálculo da margem'
        : pedidosSemCusto.length + ' pedidos no período estão sem custo de produto, impedindo o cálculo da margem',
      descricao: 'Cadastre o custo do(s) SKU(s) desses pedidos em Produtos para a margem de contribuição ser calculada.',
      pagina: 'orders',
    });
  }

  // 3) Margem negativa em alguma venda (pedido com cálculo completo e
  // resultado negativo — nunca inferido de um cálculo incompleto).
  const margemNegativa = pedidos.filter((p) => !p.cancelado && p.calculoCompleto && p.margemContribuicao < 0);
  if (margemNegativa.length) {
    alertas.push({
      id: 'margem-negativa', tipo: 'margem_negativa', severidade: 'danger',
      titulo: margemNegativa.length === 1
        ? '1 venda no período com margem de contribuição negativa'
        : margemNegativa.length + ' vendas no período com margem de contribuição negativa',
      descricao: 'Taxas, frete, imposto e custo somados superaram o valor da venda em pelo menos um pedido.',
      pagina: 'orders',
    });
  }

  // 4) Erro de sincronização do Mercado Livre (mesmo status já mostrado em
  // Marketplaces — ml_contas.status/ultimo_erro).
  (conexoes.mercadoLivre.contas || []).filter((c) => c.status === 'erro').forEach((c) => {
    alertas.push({
      id: 'ml-sync-erro-' + c.id, tipo: 'ml_sync_erro', severidade: 'danger',
      titulo: 'Conta do Mercado Livre "' + (c.nickname || ('ID ' + c.id)) + '" está com erro de sincronização',
      descricao: c.ultimoErro || 'Reconecte a conta em Marketplaces para corrigir.',
      pagina: 'marketplaces',
    });
  });

  // 5) Conta a pagar vencida (mesmo "vencidas" já mostrado em Contas a
  // Pagar — saldo em aberto, independente do período, ver
  // lib/contasPagar.js/resumoContasPagar).
  if (fluxoCaixa.contasAPagar.vencidas > 0) {
    alertas.push({
      id: 'contas-pagar-vencidas', tipo: 'contas_pagar_vencidas', severidade: 'danger',
      titulo: 'Contas a pagar vencidas',
      descricao: formatMoney(fluxoCaixa.contasAPagar.vencidas) + ' em aberto, já vencido(s).',
      pagina: 'payable',
    });
  }

  // 6) Recebimento (conta a receber) atrasado — mesmo "atrasado" já
  // mostrado em Contas a Receber (lib/contasReceber.js/resumoContasReceber).
  // A tela "Recebimentos" (repasses do Mercado Livre) ainda não tem uma
  // data prevista real (ver lib/recebimentosMl.js) — por isso "atraso" só
  // existe hoje no lançamento manual de Contas a Receber.
  if (fluxoCaixa.contasAReceber.atrasado > 0) {
    alertas.push({
      id: 'contas-receber-atrasadas', tipo: 'recebimento_atrasado', severidade: 'warning',
      titulo: 'Recebimentos atrasados',
      descricao: formatMoney(fluxoCaixa.contasAReceber.atrasado) + ' em contas a receber com previsão já vencida.',
      pagina: 'receivable',
    });
  }

  // 7) Estoque zerado ou muito baixo — só itens JÁ sincronizados
  // (pendente = FALSE e quantidade não nula — nunca alerta em cima de um
  // dado que a API do Mercado Livre não retornou).
  const { rows: estoqueBaixo } = await pool.query(
    `SELECT tipo, titulo, sku, quantidade FROM ml_estoque_itens
     WHERE empresa_id = $1 AND pendente = FALSE AND quantidade IS NOT NULL AND quantidade <= $2`,
    [empresaId, ESTOQUE_BAIXO_LIMITE]
  );
  const zerados = estoqueBaixo.filter((r) => Number(r.quantidade) === 0);
  const baixos = estoqueBaixo.filter((r) => Number(r.quantidade) > 0);
  if (zerados.length) {
    alertas.push({
      id: 'estoque-zerado', tipo: 'estoque_zerado', severidade: 'danger',
      titulo: zerados.length === 1 ? '1 anúncio com estoque zerado' : zerados.length + ' anúncios com estoque zerado',
      descricao: 'Estoque sincronizado do Mercado Livre mostra 0 unidade(s) disponível(is).',
      pagina: 'stock',
    });
  }
  if (baixos.length) {
    alertas.push({
      id: 'estoque-baixo', tipo: 'estoque_baixo', severidade: 'warning',
      titulo: baixos.length === 1 ? '1 anúncio com estoque muito baixo' : baixos.length + ' anúncios com estoque muito baixo',
      descricao: 'Estoque sincronizado do Mercado Livre com ' + ESTOQUE_BAIXO_LIMITE + ' unidades ou menos.',
      pagina: 'stock',
    });
  }

  const ordemSeveridade = { danger: 0, warning: 1, info: 2 };
  alertas.sort((a, b) => ordemSeveridade[a.severidade] - ordemSeveridade[b.severidade]);
  return alertas;
}

// ---------------- Função principal ----------------
async function painelVisaoGeral({ empresaId, periodoChave }) {
  const periodoCalc = calcularPeriodo(periodoChave);
  const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);

  const [{ pedidos }, { itens }, conexoes] = await Promise.all([
    buscarPedidosDoPeriodo({ empresaId, desde: periodoCalc.desde, ate: periodoCalc.ate }),
    buscarItensDoPeriodo({ empresaId, desde: periodoCalc.desde, ate: periodoCalc.ate }),
    conexoesEEmpresas(empresaId),
  ]);

  const canalResultado = porCanal(pedidos);
  const fluxoCaixa = await fluxoDeCaixa({ empresaId, desdeStr, ateStr, pedidos });
  const alertas = await gerarAlertas({ empresaId, pedidos, itens, fluxoCaixa, conexoes });

  // Radar da IA — nunca quebra o resto da Visão Geral se algo falhar aqui
  // (ex.: tabela ainda não migrada num banco muito antigo); some da
  // resposta com um aviso claro em vez de derrubar a tela inteira.
  let radar = null, radarError = null;
  try {
    const { obterRadarParaEmpresa } = require('./ia/radar');
    radar = await obterRadarParaEmpresa(empresaId);
  } catch (e) {
    radarError = 'Não foi possível carregar o Radar da IA agora.';
    console.error('[visão geral] falha ao carregar o Radar da IA: ' + e.message);
  }

  return {
    periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
    porCanal: canalResultado,
    fluxoCaixa,
    conexoes,
    alertas,
    radar,
    radarError,
  };
}

module.exports = {
  painelVisaoGeral,
  identificarCanal,
  porCanal,
  resumoRecebimentos,
  fluxoDeCaixa,
  conexoesEEmpresas,
  gerarAlertas,
  formatMoney,
  ESTOQUE_BAIXO_LIMITE,
};
