// Fonte única dos números de vendas usados em Visão Geral, Pedidos e
// Financeiro — as três telas chamam estas mesmas funções, com a mesma regra
// de cálculo (lib/resultadoVenda.js), pro mesmo período nunca aparecer com
// valores diferentes em telas diferentes.
//
// Regra combinada com o usuário: pedido com status "cancelled" no Mercado
// Livre (ou "CANCELLED" na Shopee — ver STATUS_CANCELADO_SHOPEE abaixo) não
// é venda de verdade — não entra no faturamento, taxas, frete, imposto,
// custo nem margem. Ele é contado à parte, só como "pedidos cancelados"
// (quantidade e valor), pra não ficar escondido nem misturado com o
// resultado financeiro real.
//
// Shopee (14/09/2026, pedido explícito do usuário: "tudo que foi aplicado
// no mercado livre pode e deve ser aplicado na shopee") — pedidos da Shopee
// (shopee_pedidos) entram nesta MESMA fonte única, unidos por UNION ALL com
// os do Mercado Livre (ver SQL_UNIAO_PEDIDOS abaixo), então Visão Geral,
// Pedidos e Financeiro passam a somar as duas lojas juntas automaticamente,
// sem nenhuma fórmula nova.
//
// Fase 2b (mesmo dia, pedido explícito do usuário: "quero igual ao mercado
// livre, mas com as taxas e comissões da shopee") — taxaVenda/pagamentoTaxas/
// pagamentoTaxaMarketplace da Shopee agora vêm dos campos reais de repasse
// (shopee_pedidos.comissao_venda/taxa_transacao_pagamento/taxa_servico —
// preenchidos por lib/shopeeSync.js via payment/get_escrow_detail_batch,
// numa chamada separada de get_order_detail porque a Shopee não devolve
// esse dado junto do pedido). Continua NUNCA inventado: um pedido cujo
// repasse a Shopee ainda não processou/liberou mantém esses três campos
// NULL até a sincronização conseguir capturar (mesmo mecanismo que já
// deixa `calculoCompleto`/margem como "pendente" pra um pedido do Mercado
// Livre sem custo de SKU cadastrado — ver lib/resultadoVenda.js).
// IMPORTANTE: esta é a primeira vez que este projeto lê esse dado — ainda
// não confirmado contra um repasse real desta conta (ver comentário em
// lib/shopee.js sobre a limitação deste ambiente de não conseguir abrir
// open.shopee.com direto pra conferir a documentação byte a byte).
//
// Frete do vendedor da Shopee: usamos `shopee_pedidos.frete_real`
// (actual_shipping_fee da API) como equivalente ao `frete_vendedor` do
// Mercado Livre (senders[].cost) — é a leitura mais direta do nome do campo
// documentado pela Shopee, mas ainda NÃO conferida contra um repasse real
// desta conta (mesma limitação de não ter acesso à documentação oficial
// nem, por enquanto, a um pagamento liquidado da Shopee pra comparar — ver
// lib/shopee.js). Se a Fase 2b (repasse/escrow) mostrar que esse campo
// significa outra coisa, é só um lugar pra corrigir (aqui).
//
// Item da Shopee (shopee_pedido_itens) nunca entra em buscarItensDoPeriodo
// (usada por Relatórios de produto e pela margem de Ads) — Ads é uma
// integração exclusiva do Mercado Livre (Product Ads) sem equivalente na
// Shopee, e o repasse da Shopee só existe no nível do PEDIDO (a Shopee não
// decompõe comissão por item como o Mercado Livre faz em ml_pedido_itens.
// taxa_venda) — misturar as duas granularidades na mesma função Ads-only
// arriscaria contaminar um relatório exclusivo do Mercado Livre.
// buscarItensDoPeriodoTodosCanais (mais abaixo) é a versão que INCLUI a
// Shopee (usada só por Relatórios > Produtos, nunca por Ads) — ver o filtro
// explícito dentro de cada função.
const pool = require('../db/pool');
const { calcularResultadoVenda, round2 } = require('./resultadoVenda');
const { diaBRT } = require('./periodo');

const STATUS_CANCELADO = 'cancelled';
// Vocabulário de status da Shopee Open Platform v2 (order_status): CANCELLED
// é o valor documentado para pedido cancelado (mesma grafia em todas as
// integrações de terceiros consultadas nesta etapa — ver lib/shopee.js
// sobre a limitação de não ter conseguido abrir open.shopee.com direto
// neste ambiente pra conferir byte a byte). Se algum pedido cancelado da
// Shopee aparecer contado como venda de verdade, este é o primeiro lugar a
// conferir.
const STATUS_CANCELADO_SHOPEE = 'CANCELLED';

// Bug 4 da reconciliação PF ERP x Mercado Turbo (24/08/2026, ver
// docs/04-alteracoes.md): todo filtro/ordenação de PERÍODO usava só
// data_criacao (order.date_created — quando o pedido foi criado), nunca
// quando ele foi realmente fechado/pago. Um pedido criado num dia mas só
// aprovado/fechado no dia seguinte (ex: 2000018066590190 — 3 tentativas de
// pagamento, criado 22/08, aprovado e fechado só 23/08) ficava sempre no
// período de quando foi CRIADO, mesmo que o Mercado Turbo (e o bom senso
// financeiro) considere a venda como tendo acontecido quando foi
// fechada/paga. data_fechamento (order.date_closed) já era salva pela
// sincronização, só não era usada em nenhum filtro — não precisa de
// migração de schema nem nova sincronização, só passar a usar o dado que já
// existe. Pedidos ainda não fechados (data_fechamento NULL — ex: em
// aberto/pendente) continuam usando data_criacao, sem regressão nenhuma.
const SQL_DATA_EFETIVA = 'COALESCE(p.data_fechamento, p.data_criacao)';

// Bug 3 da reconciliação PF ERP x Mercado Turbo (24/08/2026, ver
// docs/04-alteracoes.md e lib/resultadoVenda.js): soma coupon_amount dos
// pagamentos APROVADOS do pedido — usa a coluna nova (ml_pedido_pagamentos.
// coupon_amount) quando já veio da sincronização, e cai pro raw_pagamento
// (sempre completo, desde o início da integração) pros pagamentos
// sincronizados antes da coluna existir, então nenhum pedido antigo fica
// com o desconto "pendente" por causa disso. COALESCE(...,0) porque não ter
// cupom é 0 de verdade, não dado faltando.
const SQL_DESCONTO_CUPOM = `(
     SELECT COALESCE(SUM(COALESCE(pg.coupon_amount, (pg.raw_pagamento->>'coupon_amount')::numeric)), 0)
     FROM ml_pedido_pagamentos pg
     WHERE pg.pedido_id = p.id AND pg.status = 'approved'
   )`;

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

function serializarPedido(row, aliquotaImposto) {
  const valorVenda = toNum(row.valor_total);
  const custoProduto = toNum(row.custo_produto_total);
  const desconto = toNum(row.desconto_cupom) || 0;
  const calc = calcularResultadoVenda({
    valorVenda,
    taxaVenda: toNum(row.taxa_venda_total),
    pagamentoTaxas: toNum(row.pagamento_taxas),
    pagamentoTaxaMarketplace: toNum(row.pagamento_taxa_marketplace),
    freteVendedor: toNum(row.frete_vendedor),
    custoProduto,
    aliquotaImposto,
    desconto,
  });
  const margemPercentual = calc.resultado !== null && valorVenda
    ? round2((calc.resultado / valorVenda) * 100)
    : null;

  return {
    // `id` continua sendo o id BRUTO da tabela de origem (ml_pedidos.id ou
    // shopee_pedidos.id) — NUNCA globalmente único sozinho (as duas tabelas
    // têm sequências SERIAL independentes, então um pedido do Mercado Livre
    // e um da Shopee podem ter o mesmo `id`). Continua existindo só pra não
    // quebrar nada que já lia `.id` esperando o id real da tabela do
    // Mercado Livre (ex.: buscarItensDoPeriodo abaixo, que exclui Shopee
    // antes de usar `.id`, exatamente por causa disso). Pra abrir o
    // detalhe de UM pedido específico sem ambiguidade entre as duas lojas,
    // use sempre `detailKey`, nunca `id` sozinho.
    id: row.id,
    marketplace: row.marketplace, // 'mercado_livre' | 'shopee'
    detailKey: `${row.marketplace}:${row.id}`,
    empresaId: row.empresa_id,
    // contaMlId/contaShopeeId (14/09/2026): `conta_id` sozinho tem o MESMO
    // problema de colisão do `id` (ml_contas.id e shopee_contas.id são
    // sequências SERIAL independentes — a loja Shopee #3 e a conta ML #3
    // podem coexistir). Por isso cada marketplace só preenche o SEU próprio
    // campo — o outro fica null — em vez de um `contaId` genérico que
    // poderia colidir. Qualquer filtro/agrupamento por loja PRECISA usar
    // `contaKey` (abaixo) quando precisa distinguir as duas lojas sem
    // ambiguidade; contaMlId sozinho continua seguro pros usos antigos,
    // ML-only, porque nunca é preenchido com um id de loja Shopee.
    contaMlId: row.marketplace === 'mercado_livre' ? row.conta_id : null,
    contaShopeeId: row.marketplace === 'shopee' ? row.conta_id : null,
    // Chave de loja genérica e sem colisão (`marketplace:conta_id`) — usar
    // pra agrupar/filtrar pedidos por loja quando as duas lojas precisam
    // conviver no mesmo relatório (ex.: relatoriosAgregados.relatorioMarketplaces,
    // routes/pedidos.js).
    contaKey: `${row.marketplace}:${row.conta_id}`,
    loja: row.conta_nickname,
    // Número do pedido na própria loja — numérico no Mercado Livre
    // (ml_order_id), alfanumérico na Shopee (order_sn, ex.:
    // "2609142W61QNKJ"). O campo continua se chamando `mlOrderId` (em vez
    // de renomear pra algo genérico) só pra não obrigar a trocar nome em
    // todo lugar que já lê esse campo há meses — o VALOR já é genérico
    // (pedido_ref, unificado na consulta abaixo) desde 14/09/2026.
    mlOrderId: row.pedido_ref,
    dataCriacao: row.data_criacao,
    dataEfetiva: row.data_efetiva,
    status: row.status,
    cancelado: row.marketplace === 'shopee' ? row.status === STATUS_CANCELADO_SHOPEE : row.status === STATUS_CANCELADO,
    // Adicionado em 24/08/2026 (tela Recebimentos — ver
    // lib/recebimentosMl.js e docs/04-alteracoes.md): status do primeiro
    // pagamento do pedido (payments[0].status, já salvo desde sempre em
    // ml_pedidos.pagamento_status — nunca usado em nenhum campo serializado
    // até agora). Campo puramente aditivo: não muda nenhum valor já
    // calculado/retornado por esta função, só expõe um dado que já
    // existia no banco.
    pagamentoStatus: row.pagamento_status,
    compradorNickname: row.comprador_nickname,
    valorTotal: valorVenda,
    moeda: row.moeda,
    produtoResumo: row.item_resumo,
    skuResumo: row.sku_resumo,
    qtdItens: Number(row.qtd_itens) || 0,
    qtdUnidades: Number(row.qtd_unidades) || 0,
    freteComprador: toNum(row.frete_comprador),
    freteVendedor: toNum(row.frete_vendedor),
    envioLogisticType: row.envio_logistic_type,
    tarifasMl: calc.tarifasTotal,
    desconto: calc.desconto,
    imposto: calc.imposto,
    custoProduto,
    margemContribuicao: calc.resultado,
    margemPercentual,
    calculoCompleto: calc.calculoCompleto,
  };
}

// Consulta base do Mercado Livre — mesma de sempre, só reorganizada em CTE
// (WITH) pra poder ser unida (UNION ALL) com a da Shopee logo abaixo, sem
// duplicar nenhuma subquery/regra já existente. Nenhum campo/cálculo do
// Mercado Livre mudou — só o formato de como a consulta é montada.
const SQL_ML_PEDIDOS_UNIFICADOS = `
  SELECT
    'mercado_livre'::text AS marketplace,
    p.id,
    c.empresa_id,
    p.conta_ml_id AS conta_id,
    c.nickname AS conta_nickname,
    p.ml_order_id::text AS pedido_ref,
    p.data_criacao,
    ${SQL_DATA_EFETIVA} AS data_efetiva,
    p.status,
    p.pagamento_status,
    p.comprador_nickname,
    p.valor_total,
    p.moeda,
    p.frete_comprador,
    p.frete_vendedor,
    p.envio_logistic_type,
    p.taxa_venda_total,
    p.pagamento_taxas,
    p.pagamento_taxa_marketplace,
    (SELECT string_agg(titulo, ' + ' ORDER BY id) FROM (
       SELECT titulo, id FROM ml_pedido_itens WHERE pedido_id = p.id ORDER BY id LIMIT 3
     ) t) AS item_resumo,
    (SELECT string_agg(DISTINCT sku, ', ') FROM ml_pedido_itens WHERE pedido_id = p.id AND sku IS NOT NULL) AS sku_resumo,
    (SELECT count(*) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_itens,
    (SELECT COALESCE(SUM(quantidade), 0) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_unidades,
    -- Custo do produto vem da tabela produtos (tela Produtos, desde
    -- 24/08/2026 — ver db/schema.sql e docs/02-decisoes.md). Não filtra por
    -- produtos.ativo de propósito: desativar um produto é só uma flag de
    -- catálogo, não apaga o custo histórico usado no cálculo de vendas já
    -- feitas ou futuras desse SKU.
    (SELECT CASE WHEN bool_and(pr.custo IS NOT NULL) THEN SUM(pr.custo * pi.quantidade) ELSE NULL END
       FROM ml_pedido_itens pi
       LEFT JOIN produtos pr ON pr.empresa_id = $1 AND pr.sku = pi.sku
       WHERE pi.pedido_id = p.id
    ) AS custo_produto_total,
    ${SQL_DESCONTO_CUPOM} AS desconto_cupom
  FROM ml_pedidos p
  JOIN ml_contas c ON c.id = p.conta_ml_id
  WHERE c.empresa_id = $1
`;

// Consulta base da Shopee (14/09/2026) — mesma estrutura de colunas da
// consulta do Mercado Livre acima (union-compatível), mapeando cada campo
// pro equivalente mais direto que a Shopee já devolve hoje (ver comentário
// no topo do arquivo sobre comissão/tarifas — Fase 2b, agora real).
const SQL_SHOPEE_PEDIDOS_UNIFICADOS = `
  SELECT
    'shopee'::text AS marketplace,
    p.id,
    c.empresa_id,
    p.conta_shopee_id AS conta_id,
    c.shop_name AS conta_nickname,
    p.order_sn AS pedido_ref,
    p.data_criacao,
    p.data_criacao AS data_efetiva, -- Shopee ainda não distingue "criado" de "fechado" nesta etapa (Fase 1, ver lib/shopeeSync.js)
    p.order_status AS status,
    NULL::varchar(30) AS pagamento_status, -- Shopee não tem o mesmo conceito de payments[0].status do Mercado Livre nesta etapa
    p.comprador_username AS comprador_nickname,
    p.valor_total,
    p.moeda,
    NULL::numeric(12,2) AS frete_comprador, -- a Shopee não separa frete pago pelo comprador nos campos já buscados
    p.frete_real AS frete_vendedor, -- leitura mais direta de actual_shipping_fee — ainda não conferida contra um repasse real (ver comentário no topo do arquivo)
    p.transportadora AS envio_logistic_type,
    -- Fase 2b (14/09/2026): comissão/tarifas reais, vindas de
    -- payment/get_escrow_detail_batch (lib/shopeeSync.js) — NULL até a
    -- Shopee liberar o repasse daquele pedido (nunca inventado).
    p.comissao_venda AS taxa_venda_total,
    p.taxa_transacao_pagamento AS pagamento_taxas,
    p.taxa_servico AS pagamento_taxa_marketplace,
    (SELECT string_agg(nome, ' + ' ORDER BY id) FROM (
       SELECT nome, id FROM shopee_pedido_itens WHERE pedido_id = p.id ORDER BY id LIMIT 3
     ) t) AS item_resumo,
    (SELECT string_agg(DISTINCT sku, ', ') FROM shopee_pedido_itens WHERE pedido_id = p.id AND sku IS NOT NULL) AS sku_resumo,
    (SELECT count(*) FROM shopee_pedido_itens WHERE pedido_id = p.id) AS qtd_itens,
    (SELECT COALESCE(SUM(quantidade), 0) FROM shopee_pedido_itens WHERE pedido_id = p.id) AS qtd_unidades,
    -- Mesma regra de custo do Mercado Livre acima: SKU (produtos.sku) é o
    -- mesmo cadastro de Custos pras duas lojas, nunca duplicado.
    (SELECT CASE WHEN bool_and(pr.custo IS NOT NULL) THEN SUM(pr.custo * pi.quantidade) ELSE NULL END
       FROM shopee_pedido_itens pi
       LEFT JOIN produtos pr ON pr.empresa_id = $1 AND pr.sku = pi.sku
       WHERE pi.pedido_id = p.id
    ) AS custo_produto_total,
    -- Desconto/cupom da Shopee ainda não é buscado (Fase 1 não captura esse
    -- dado) — 0, mesma regra já documentada em lib/resultadoVenda.js pra
    -- "sem cupom" (fato real conhecido, não dado faltando).
    0::numeric(12,2) AS desconto_cupom
  FROM shopee_pedidos p
  JOIN shopee_contas c ON c.id = p.conta_shopee_id
  WHERE c.empresa_id = $1
`;

const SQL_UNIAO_PEDIDOS = `${SQL_ML_PEDIDOS_UNIFICADOS} UNION ALL ${SQL_SHOPEE_PEDIDOS_UNIFICADOS}`;

// Busca os pedidos de uma empresa dentro do período [desde, ate), já com o
// resultado financeiro calculado (mesma fórmula do detalhe do pedido) —
// Mercado Livre e Shopee juntos (ver SQL_UNIAO_PEDIDOS acima).
async function buscarPedidosDoPeriodo({ empresaId, desde, ate, limit }) {
  const { rows: configRows } = await pool.query(
    'SELECT aliquota_imposto FROM config_financeiro WHERE empresa_id = $1',
    [empresaId]
  );
  const aliquotaImposto = configRows.length ? Number(configRows[0].aliquota_imposto) : 0;

  const { rows: totalRows } = await pool.query(
    `SELECT count(*) FROM (${SQL_UNIAO_PEDIDOS}) unificados WHERE data_efetiva >= $2 AND data_efetiva < $3`,
    [empresaId, desde, ate]
  );
  const totalNoPeriodo = Number(totalRows[0].count);

  const { rows } = await pool.query(
    `SELECT * FROM (${SQL_UNIAO_PEDIDOS}) unificados
     WHERE data_efetiva >= $2 AND data_efetiva < $3
     ORDER BY data_efetiva DESC NULLS LAST
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [empresaId, desde, ate]
  );

  return {
    pedidos: rows.map((r) => serializarPedido(r, aliquotaImposto)),
    aliquotaImposto,
    totalNoPeriodo,
  };
}

function somarComPendencia(pedidos, campo) {
  let soma = 0;
  let temValor = false;
  let pendentes = 0;
  for (const p of pedidos) {
    if (p[campo] === null) pendentes++;
    else {
      soma += p[campo];
      temValor = true;
    }
  }
  return { valor: temValor ? round2(soma) : null, pendentes };
}

// Resume um conjunto de pedidos (já filtrado pro período) nos totais usados
// por Visão Geral e Financeiro. Pedidos cancelados ficam de fora de todo
// esse resumo — eles aparecem só em `cancelados`.
function resumirPeriodo(pedidosComCancelados) {
  const cancelados = pedidosComCancelados.filter((p) => p.cancelado);
  const pedidos = pedidosComCancelados.filter((p) => !p.cancelado);

  const qtdPedidos = pedidos.length;
  const faturamento = somarComPendencia(pedidos, 'valorTotal');
  const desconto = somarComPendencia(pedidos, 'desconto');
  const tarifas = somarComPendencia(pedidos, 'tarifasMl');
  const freteVendedor = somarComPendencia(pedidos, 'freteVendedor');
  const imposto = somarComPendencia(pedidos, 'imposto');
  const custoProduto = somarComPendencia(pedidos, 'custoProduto');

  const completos = pedidos.filter((p) => p.calculoCompleto);
  const margemContribuicao = {
    valor: completos.length ? round2(completos.reduce((s, p) => s + p.margemContribuicao, 0)) : null,
    pendentes: qtdPedidos - completos.length,
  };
  const margemPercentual = margemContribuicao.valor !== null && faturamento.valor
    ? round2((margemContribuicao.valor / faturamento.valor) * 100)
    : null;

  const cancelamentoValor = somarComPendencia(cancelados, 'valorTotal');

  return {
    qtdPedidos,
    faturamento,
    desconto,
    tarifas,
    freteVendedor,
    imposto,
    custoProduto,
    margemContribuicao,
    margemPercentual,
    cancelados: { quantidade: cancelados.length, valor: cancelamentoValor.valor },
  };
}

// Série diária (faturamento e margem de contribuição por dia, em horário de
// Brasília) pro gráfico de Visão Geral. Pedidos cancelados ficam de fora,
// mesma regra do resumo. Dias com algum pedido sem custo de SKU cadastrado
// somam só a margem que já é conhecida (nunca inventa o que falta).
function serieDiaria(pedidosComCancelados) {
  const pedidos = pedidosComCancelados.filter((p) => !p.cancelado);
  const porDia = new Map();
  for (const p of pedidos) {
    // Usa a mesma data efetiva (data_fechamento, com fallback pra
    // data_criacao) usada pro filtro de período (Bug 4 — ver
    // SQL_DATA_EFETIVA acima), senão um pedido que entrou no período pela
    // data de fechamento podia cair fora do gráfico, ou num dia errado.
    if (!p.dataEfetiva) continue;
    const dia = diaBRT(p.dataEfetiva);
    if (!porDia.has(dia)) porDia.set(dia, { dia, faturamento: 0, margemContribuicao: 0 });
    const acc = porDia.get(dia);
    if (p.valorTotal !== null) acc.faturamento += p.valorTotal;
    if (p.calculoCompleto) acc.margemContribuicao += p.margemContribuicao;
  }
  return [...porDia.values()]
    .sort((a, b) => (a.dia < b.dia ? -1 : 1))
    .map((d) => ({ dia: d.dia, faturamento: round2(d.faturamento), margemContribuicao: round2(d.margemContribuicao) }));
}

// Busca os ITENS (linhas de produto/SKU) dos pedidos não cancelados de uma
// empresa no período, com o mesmo cálculo financeiro de
// calcularResultadoVenda (lib/resultadoVenda.js) aplicado por item — nunca
// uma terceira fórmula. Usada por Relatórios (categoria Produtos) e por Ads
// (margem por anúncio), ativados em 25/08/2026 — ver docs/02-decisoes.md.
//
// O Mercado Livre entrega comissão (sale_fee) e custo do produto já
// decompostos por item de verdade: `ml_pedido_itens.taxa_venda` é
// sale_fee×quantidade DAQUELA linha (não do pedido inteiro), e o custo vem
// de `produtos.custo × quantidade` daquela linha — nenhum dos dois é
// rateado, os dois são exatos.
//
// Frete do vendedor, desconto (cupom) e as tarifas de pagamento (além da
// comissão) só existem no nível do PEDIDO — o Mercado Livre não informa
// esses três separados por item. Quando um pedido tem só 1 item, isso não
// importa (100% do pedido pertence a esse item, sem rateio nenhum).
// Quando tem mais de 1 item, essas três partes são RATEADAS
// proporcionalmente ao valor do item dentro do pedido
// (valorTotalItem / valorTotal do pedido) — é um rateio declarado, nunca um
// valor inventado: a soma dos itens de um mesmo pedido sempre volta a bater
// exatamente com o valor real daquele pedido (o mesmo já mostrado em
// Pedidos/DRE/Financeiro).
async function buscarItensDoPeriodo({ empresaId, desde, ate }) {
  const { pedidos, aliquotaImposto } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  // Shopee (14/09/2026) fica de fora daqui, de propósito: 1) esta função
  // consulta ml_pedido_itens por `pedido.id` diretamente — como `id` NÃO é
  // globalmente único entre as duas lojas (ver comentário em
  // serializarPedido), misturar um `id` de pedido da Shopee nessa consulta
  // arriscaria trazer os itens de um pedido ERRADO do Mercado Livre que por
  // acaso tenha o mesmo id; 2) Ads (Product Ads) é uma integração exclusiva
  // do Mercado Livre, sem equivalente na Shopee; 3) a Shopee ainda não tem
  // comissão própria por pedido pra ratear por item (Fase 2b, futura) — não
  // haveria o que calcular de diferente do resumo por pedido já mostrado em
  // Pedidos/Visão Geral.
  const pedidosNaoCancelados = pedidos.filter((p) => !p.cancelado && p.marketplace === 'mercado_livre');
  if (!pedidosNaoCancelados.length) return { itens: [] };

  const pedidoIds = pedidosNaoCancelados.map((p) => p.id);
  const { rows } = await pool.query(
    `SELECT pi.pedido_id, pi.ml_item_id, pi.sku, pi.titulo, pi.quantidade,
            pi.valor_total_item, pi.taxa_venda,
            pr.custo AS produto_custo
     FROM ml_pedido_itens pi
     LEFT JOIN produtos pr ON pr.empresa_id = $1 AND pr.sku = pi.sku
     WHERE pi.pedido_id = ANY($2::int[])
     ORDER BY pi.pedido_id, pi.id`,
    [empresaId, pedidoIds]
  );

  const pedidosPorId = new Map(pedidosNaoCancelados.map((p) => [p.id, p]));
  const linhasPorPedido = new Map();
  rows.forEach((r) => {
    if (!linhasPorPedido.has(r.pedido_id)) linhasPorPedido.set(r.pedido_id, []);
    linhasPorPedido.get(r.pedido_id).push(r);
  });

  const itens = [];
  for (const [pedidoId, linhas] of linhasPorPedido) {
    const pedido = pedidosPorId.get(pedidoId);
    if (!pedido) continue;

    const multiItem = linhas.length > 1;
    // "Restante" de tarifas fora da comissão por item (taxas/tarifa de
    // marketplace do pagamento) — só existe rateado quando dá pra confiar
    // na soma das comissões por item batendo com a tarifa total do pedido.
    const somaComissaoItens = linhas.reduce((s, l) => {
      const v = toNum(l.taxa_venda);
      return v === null ? s : s + v;
    }, 0);
    const algumaComissaoFaltando = linhas.some((l) => toNum(l.taxa_venda) === null);
    const restanteTarifas = (pedido.tarifasMl !== null && !algumaComissaoFaltando)
      ? round2(pedido.tarifasMl - somaComissaoItens)
      : null;

    linhas.forEach((linha) => {
      const valorItem = toNum(linha.valor_total_item);
      const ratio = (!multiItem)
        ? 1
        : (pedido.valorTotal && valorItem !== null ? valorItem / pedido.valorTotal : null);

      const custoUnitario = toNum(linha.produto_custo);
      const custoProdutoItem = custoUnitario !== null ? round2(custoUnitario * (Number(linha.quantidade) || 0)) : null;

      const comissaoItem = toNum(linha.taxa_venda);
      const pagamentoTaxasItem = (ratio !== null && restanteTarifas !== null) ? round2(restanteTarifas * ratio) : null;
      const freteVendedorItem = (ratio !== null && pedido.freteVendedor !== null) ? round2(pedido.freteVendedor * ratio) : null;
      // Ausência de cupom é 0 de verdade (mesma regra de resultadoVenda.js),
      // então o rateio do desconto nunca fica null — sem ratio confiável
      // (valor do pedido zerado/pendente), fica 0 em vez de indisponível.
      const descontoItem = (ratio !== null) ? round2((pedido.desconto || 0) * ratio) : 0;

      const calc = calcularResultadoVenda({
        valorVenda: valorItem,
        taxaVenda: comissaoItem,
        pagamentoTaxas: pagamentoTaxasItem,
        pagamentoTaxaMarketplace: null,
        freteVendedor: freteVendedorItem,
        custoProduto: custoProdutoItem,
        aliquotaImposto,
        desconto: descontoItem,
      });

      itens.push({
        pedidoId,
        marketplace: 'mercado_livre',
        mlOrderId: pedido.mlOrderId,
        dataEfetiva: pedido.dataEfetiva,
        contaMlId: pedido.contaMlId,
        contaKey: pedido.contaKey, // aditivo (14/09/2026) — ver buscarItensDoPeriodoTodosCanais abaixo
        loja: pedido.loja,
        mlItemId: linha.ml_item_id,
        titulo: linha.titulo,
        sku: linha.sku,
        quantidade: Number(linha.quantidade) || 0,
        valorTotalItem: valorItem,
        rateado: multiItem,
        tarifas: calc.tarifasTotal,
        freteVendedor: freteVendedorItem,
        desconto: calc.desconto,
        imposto: calc.imposto,
        custoProduto: custoProdutoItem,
        margemContribuicao: calc.resultado,
        calculoCompleto: calc.calculoCompleto,
      });
    });
  }

  return { itens };
}

// Versão de buscarItensDoPeriodo que TAMBÉM inclui os itens da Shopee —
// usada EXCLUSIVAMENTE por Relatórios > Produtos (14/09/2026, pedido
// explícito do usuário: "quero relatórios também igual ao mercado livre").
// NUNCA use esta função em nada relacionado a Ads/Anúncios (Product Ads é
// exclusivo do Mercado Livre, sem equivalente na Shopee) — para isso,
// continue usando buscarItensDoPeriodo (acima, intocada, só Mercado Livre).
//
// Diferença importante do rateio: no Mercado Livre, a comissão
// (taxa_venda) já vem EXATA por item da própria API — só o restante
// (tarifas de pagamento/frete/desconto) é rateado quando o pedido tem mais
// de 1 item. Na Shopee, o repasse (payment/get_escrow_detail_batch) só
// existe no nível do PEDIDO inteiro — não há nenhuma parte "exata" por
// item — por isso aqui TUDO (comissão inclusive) é sempre rateado
// proporcionalmente ao valor do item dentro do pedido, mesmo quando o
// pedido tem só 1 item. `rateado: true` é sempre marcado pra deixar isso
// visível (nunca disfarçado de valor exato).
async function buscarItensDoPeriodoTodosCanais({ empresaId, desde, ate }) {
  const [{ itens: itensMl }, { pedidos }] = await Promise.all([
    buscarItensDoPeriodo({ empresaId, desde, ate }),
    buscarPedidosDoPeriodo({ empresaId, desde, ate }),
  ]);

  const pedidosShopee = pedidos.filter((p) => !p.cancelado && p.marketplace === 'shopee');
  if (!pedidosShopee.length) return { itens: itensMl };

  const { rows: configRows } = await pool.query(
    'SELECT aliquota_imposto FROM config_financeiro WHERE empresa_id = $1',
    [empresaId]
  );
  const aliquotaImposto = configRows.length ? Number(configRows[0].aliquota_imposto) : 0;

  const pedidoIds = pedidosShopee.map((p) => p.id);
  const { rows } = await pool.query(
    `SELECT pi.pedido_id, pi.item_id, pi.sku, pi.nome AS titulo, pi.quantidade, pi.valor_total_item,
            pr.custo AS produto_custo
     FROM shopee_pedido_itens pi
     LEFT JOIN produtos pr ON pr.empresa_id = $1 AND pr.sku = pi.sku
     WHERE pi.pedido_id = ANY($2::int[])
     ORDER BY pi.pedido_id, pi.id`,
    [empresaId, pedidoIds]
  );

  const pedidosPorId = new Map(pedidosShopee.map((p) => [p.id, p]));
  const linhasPorPedido = new Map();
  rows.forEach((r) => {
    if (!linhasPorPedido.has(r.pedido_id)) linhasPorPedido.set(r.pedido_id, []);
    linhasPorPedido.get(r.pedido_id).push(r);
  });

  const itensShopee = [];
  for (const [pedidoId, linhas] of linhasPorPedido) {
    const pedido = pedidosPorId.get(pedidoId);
    if (!pedido) continue;

    linhas.forEach((linha) => {
      const valorItem = toNum(linha.valor_total_item);
      const ratio = pedido.valorTotal && valorItem !== null ? valorItem / pedido.valorTotal : null;

      const custoUnitario = toNum(linha.produto_custo);
      const custoProdutoItem = custoUnitario !== null ? round2(custoUnitario * (Number(linha.quantidade) || 0)) : null;

      // pedido.tarifasMl já é o total combinado (comissão + taxas de
      // pagamento + taxa de serviço) calculado no nível do pedido — passa
      // tudo como `taxaVenda` sozinho (os outros dois null) só pra
      // calcularResultadoVenda somar o mesmo total, sem duplicar.
      const tarifasItem = (ratio !== null && pedido.tarifasMl !== null) ? round2(pedido.tarifasMl * ratio) : null;
      const freteVendedorItem = (ratio !== null && pedido.freteVendedor !== null) ? round2(pedido.freteVendedor * ratio) : null;
      const descontoItem = (ratio !== null) ? round2((pedido.desconto || 0) * ratio) : 0;

      const calc = calcularResultadoVenda({
        valorVenda: valorItem,
        taxaVenda: tarifasItem,
        pagamentoTaxas: null,
        pagamentoTaxaMarketplace: null,
        freteVendedor: freteVendedorItem,
        custoProduto: custoProdutoItem,
        aliquotaImposto,
        desconto: descontoItem,
      });

      itensShopee.push({
        pedidoId,
        marketplace: 'shopee',
        mlOrderId: pedido.mlOrderId, // valor já genérico (order_sn) — ver serializarPedido
        dataEfetiva: pedido.dataEfetiva,
        contaMlId: null,
        contaShopeeId: pedido.contaShopeeId,
        contaKey: pedido.contaKey,
        loja: pedido.loja,
        mlItemId: null,
        itemId: linha.item_id ? String(linha.item_id) : null,
        titulo: linha.titulo,
        sku: linha.sku,
        quantidade: Number(linha.quantidade) || 0,
        valorTotalItem: valorItem,
        rateado: true, // sempre — ver comentário acima da função
        tarifas: calc.tarifasTotal,
        freteVendedor: freteVendedorItem,
        desconto: calc.desconto,
        imposto: calc.imposto,
        custoProduto: custoProdutoItem,
        margemContribuicao: calc.resultado,
        calculoCompleto: calc.calculoCompleto,
      });
    });
  }

  return { itens: [...itensMl, ...itensShopee] };
}

module.exports = {
  buscarPedidosDoPeriodo,
  resumirPeriodo,
  serieDiaria,
  buscarItensDoPeriodo,
  buscarItensDoPeriodoTodosCanais,
  STATUS_CANCELADO,
  STATUS_CANCELADO_SHOPEE,
  SQL_DATA_EFETIVA,
  SQL_DESCONTO_CUPOM,
};
