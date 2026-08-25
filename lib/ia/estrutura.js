// Monta a "apresentação visual" de uma resposta da IA Gestora — resumo,
// KPIs, tabela, gráficos, insights e atenção (Passo 2 da tarefa "IA Gestora
// — central de análise", ver docs/02-decisoes.md).
//
// Regra estrutural (a mesma "nunca inventar número" de sempre, aplicada
// aqui): TODO valor numérico (kpi, célula de tabela, ponto de gráfico) vem
// só do que as ferramentas de dados já devolveram nesta mesma pergunta —
// nunca recalculado, nunca reformulado pelo modelo. Este arquivo é código
// determinístico, sem nenhuma chamada ao provedor de IA: cada "adaptador"
// abaixo só pega um pedaço já pronto da saída de UMA ferramenta (ver
// lib/ia/ferramentas.js) e o reorganiza num formato que a tela sabe
// desenhar (e que lib/ia/planilhaAnalise.js sabe exportar pra XLSX — o
// MESMO objeto, nunca uma segunda consulta).
//
// Só as duas coisas realmente interpretativas — "insights" (conclusões) e
// "atencao" (alerta) — vêm do modelo, através da ferramenta
// `apresentar_analise` (ver final de lib/ia/ferramentas.js): não são
// números, são a leitura da IA sobre números que ela já obteve de forma
// segura. Quando o modelo NÃO chama `apresentar_analise` (perguntas
// simples, de um único número — ver a descrição da ferramenta no catálogo),
// esta função devolve `null`: a resposta continua só texto, exatamente como
// era antes desta tarefa.
function numOrNull(campo) {
  if (campo === null || campo === undefined) return null;
  return campo.valor === undefined ? null : campo.valor;
}

function kpi(label, valor, valorFormatado, extra) {
  return { label, valor: valor === undefined ? null : valor, valorFormatado: valorFormatado || null, ...(extra || {}) };
}

// ---------------- Adaptadores por ferramenta ----------------

function adResumoVendas(s) {
  if (!s) return null;
  return {
    kpis: [
      kpi('Faturamento', numOrNull(s.faturamento), s.faturamento && s.faturamento.valorFormatado),
      kpi('Margem de contribuição', numOrNull(s.margemContribuicao), s.margemContribuicao && s.margemContribuicao.valorFormatado, { percentual: s.margemContribuicaoPercentual }),
      kpi('Pedidos', s.quantidadePedidos, s.quantidadePedidos === undefined || s.quantidadePedidos === null ? null : String(s.quantidadePedidos)),
    ],
  };
}

function adResultadoPeriodo(s) {
  if (!s) return null;
  return {
    kpis: [
      kpi('Margem de contribuição', numOrNull(s.margemContribuicao), s.margemContribuicao && s.margemContribuicao.valorFormatado),
      kpi('Despesas pagas no período', numOrNull(s.despesasPagasNoPeriodo), s.despesasPagasNoPeriodo && s.despesasPagasNoPeriodo.valorFormatado),
      kpi('Resultado final', numOrNull(s.resultadoFinal), s.resultadoFinal && s.resultadoFinal.valorFormatado),
    ],
  };
}

function maiorPor(lista, campo) {
  return lista.reduce((max, l) => (max === null || (l[campo] || 0) > (max[campo] || 0) ? l : max), null);
}

function adProdutosDesempenho(s) {
  if (!s || !Array.isArray(s.produtos) || !s.produtos.length) return null;
  const maiorFaturamento = maiorPor(s.produtos, 'faturamento');
  const maiorQtd = maiorPor(s.produtos, 'quantidadeVendida');
  const top = [...s.produtos].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0)).slice(0, 8);
  return {
    kpis: [
      maiorFaturamento && kpi('Maior faturamento', maiorFaturamento.faturamento, maiorFaturamento.faturamentoFormatado, { destaque: maiorFaturamento.sku }),
      maiorQtd && kpi('Maior volume', maiorQtd.quantidadeVendida, `${maiorQtd.quantidadeVendida} un.`, { destaque: maiorQtd.sku }),
    ].filter(Boolean),
    tabela: {
      titulo: 'Produtos (SKU)',
      colunas: [
        { header: 'SKU', key: 'sku', tipo: 'texto' },
        { header: 'Quantidade vendida', key: 'quantidade', tipo: 'int' },
        { header: 'Faturamento', key: 'faturamento', tipo: 'money' },
        { header: 'Margem de contribuição', key: 'margem', tipo: 'money' },
      ],
      linhas: s.produtos.map((p) => ({ sku: p.sku, quantidade: p.quantidadeVendida, faturamento: p.faturamento, margem: p.margemContribuicao })),
    },
    graficos: [{
      tipo: 'barras',
      titulo: 'Ranking de produtos por faturamento',
      categorias: top.map((p) => p.sku),
      series: [{ nome: 'Faturamento', tipo: 'money', valores: top.map((p) => p.faturamento || 0) }],
    }],
  };
}

function adProdutosPorCaixa(s) {
  if (!s || !Array.isArray(s.produtosBase) || !s.produtosBase.length) return null;
  const maiorFaturamento = maiorPor(s.produtosBase, 'faturamento');
  const maiorCaixas = maiorPor(s.produtosBase, 'caixasFisicasVendidas');
  const top = [...s.produtosBase].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0)).slice(0, 8);
  return {
    kpis: [
      maiorFaturamento && kpi('Maior faturamento', maiorFaturamento.faturamento, maiorFaturamento.faturamentoFormatado, { destaque: maiorFaturamento.produtoBase }),
      maiorCaixas && kpi('Maior volume', maiorCaixas.caixasFisicasVendidas, `${maiorCaixas.caixasFisicasVendidas} caixas`, { destaque: maiorCaixas.produtoBase }),
    ].filter(Boolean),
    tabela: {
      titulo: 'Produtos (caixa física)',
      colunas: [
        { header: 'Produto (caixa)', key: 'produtoBase', tipo: 'texto' },
        { header: 'Caixas vendidas', key: 'caixas', tipo: 'int' },
        { header: 'Faturamento', key: 'faturamento', tipo: 'money' },
        { header: 'Pedidos', key: 'pedidos', tipo: 'int' },
      ],
      linhas: s.produtosBase.map((p) => ({ produtoBase: p.produtoBase, caixas: p.caixasFisicasVendidas, faturamento: p.faturamento, pedidos: p.quantidadePedidos })),
    },
    graficos: [{
      tipo: 'barras',
      titulo: 'Ranking de caixas por faturamento',
      categorias: top.map((p) => p.produtoBase),
      series: [{ nome: 'Faturamento', tipo: 'money', valores: top.map((p) => p.faturamento || 0) }],
    }],
  };
}

function adDesempenhoPorLoja(s) {
  if (!s || !Array.isArray(s.contasMercadoLivre) || !s.contasMercadoLivre.length) return null;
  const top = [...s.contasMercadoLivre].slice(0, 8);
  return {
    tabela: {
      titulo: 'Vendas por loja',
      colunas: [
        { header: 'Loja', key: 'loja', tipo: 'texto' },
        { header: 'Pedidos', key: 'pedidos', tipo: 'int' },
        { header: 'Faturamento', key: 'faturamento', tipo: 'money' },
        { header: 'Margem (%)', key: 'margemPct', tipo: 'percent' },
      ],
      linhas: s.contasMercadoLivre.map((l) => ({ loja: l.loja, pedidos: l.quantidadePedidos, faturamento: numOrNull(l.faturamento), margemPct: l.margemContribuicaoPercentual })),
    },
    graficos: [{
      tipo: 'barras',
      titulo: 'Faturamento por loja',
      categorias: top.map((l) => l.loja),
      series: [{ nome: 'Faturamento', tipo: 'money', valores: top.map((l) => numOrNull(l.faturamento) || 0) }],
    }],
  };
}

function adFluxoDeCaixa(s) {
  if (!s) return null;
  const recebidoRealizado = numOrNull(s.realizado.recebidoDeContasAReceberNoPeriodo);
  const pagoRealizado = numOrNull(s.realizado.pagoDeContasAPagarNoPeriodo);
  const aReceberAberto = numOrNull(s.previstoOuProjetado.contasAReceberEmAberto);
  const aPagarAberto = numOrNull(s.previstoOuProjetado.contasAPagarEmAberto);
  return {
    kpis: [
      kpi('Recebido (realizado)', recebidoRealizado, s.realizado.recebidoDeContasAReceberNoPeriodo.valorFormatado, { grupo: 'REALIZADO' }),
      kpi('Pago (realizado)', pagoRealizado, s.realizado.pagoDeContasAPagarNoPeriodo.valorFormatado, { grupo: 'REALIZADO' }),
      kpi('A receber em aberto', aReceberAberto, s.previstoOuProjetado.contasAReceberEmAberto.valorFormatado, { grupo: 'PROJETADO' }),
      kpi('A pagar em aberto', aPagarAberto, s.previstoOuProjetado.contasAPagarEmAberto.valorFormatado, { grupo: 'PROJETADO' }),
    ],
    graficos: [{
      tipo: 'barras',
      titulo: 'Contas a receber x contas a pagar — realizado x projetado',
      categorias: ['Realizado', 'Em aberto (projetado)'],
      series: [
        { nome: 'A receber', tipo: 'money', valores: [recebidoRealizado || 0, aReceberAberto || 0] },
        { nome: 'A pagar', tipo: 'money', valores: [pagoRealizado || 0, aPagarAberto || 0] },
      ],
    }],
  };
}

function adContasAReceber(s) {
  if (!s) return null;
  return {
    kpis: [
      kpi('Total a receber em aberto', numOrNull(s.totalAReceberEmAberto), s.totalAReceberEmAberto.valorFormatado),
      kpi('Previsto próximos 7 dias', numOrNull(s.previstoProximos7Dias), s.previstoProximos7Dias.valorFormatado),
      kpi('Atrasado', numOrNull(s.atrasado), s.atrasado.valorFormatado),
      kpi('Recebido no período', numOrNull(s.recebidoNoPeriodoSelecionado), s.recebidoNoPeriodoSelecionado.valorFormatado, { grupo: 'REALIZADO' }),
    ],
  };
}

function adContasAPagar(s) {
  if (!s) return null;
  return {
    kpis: [
      kpi('Total a pagar em aberto', numOrNull(s.totalAPagarEmAberto), s.totalAPagarEmAberto.valorFormatado),
      kpi('Vencendo próximos 7 dias', numOrNull(s.vencendoProximos7Dias), s.vencendoProximos7Dias.valorFormatado),
      kpi('Vencidas', numOrNull(s.vencidas), s.vencidas.valorFormatado),
      kpi('Pago no período', numOrNull(s.pagoNoPeriodoSelecionado), s.pagoNoPeriodoSelecionado.valorFormatado, { grupo: 'REALIZADO' }),
    ],
  };
}

function adDreCompleta(s) {
  if (!s || !s.linhas) return null;
  const l = s.linhas;
  const linhasTabela = [
    ['Receita bruta', l.receitaBruta], ['Cancelamentos/devoluções', l.cancelamentosDevolucoes],
    ['Descontos de cupom', l.descontosCupom], ['Receita líquida', l.receitaLiquida],
    ['Custo dos produtos', l.custoDosProdutos], ['Taxas e comissões', l.taxasEComissoes],
    ['Frete do vendedor', l.freteDoVendedor], ['Impostos', l.impostos],
    ['Margem de contribuição', l.margemDeContribuicao], ['Despesas pagas no período', l.despesasPagasNoPeriodo],
    ['Resultado final', l.resultadoFinal],
  ];
  return {
    kpis: [
      kpi('Receita líquida', numOrNull(l.receitaLiquida), l.receitaLiquida.valorFormatado),
      kpi('Margem de contribuição', numOrNull(l.margemDeContribuicao), l.margemDeContribuicao.valorFormatado),
      kpi('Resultado final', numOrNull(l.resultadoFinal), l.resultadoFinal.valorFormatado),
    ],
    tabela: {
      titulo: 'DRE',
      colunas: [{ header: 'Linha', key: 'linha', tipo: 'texto' }, { header: 'Valor', key: 'valor', tipo: 'money' }],
      linhas: linhasTabela.map(([linha, campo]) => ({ linha, valor: numOrNull(campo) })),
    },
  };
}

function adAdsDesempenho(s) {
  if (!s || s.disponivel === false) return null;
  const melhores = Array.isArray(s.melhoresAnunciosAposAds) ? s.melhoresAnunciosAposAds : [];
  const linhasTabela = melhores.slice(0, 8);
  return {
    kpis: [
      kpi('Investimento no período', numOrNull(s.investimentoNoPeriodoSelecionado), s.investimentoNoPeriodoSelecionado.valorFormatado),
      kpi('Receita atribuída', numOrNull(s.receitaAtribuidaNoPeriodoSelecionado), s.receitaAtribuidaNoPeriodoSelecionado.valorFormatado),
      kpi('ROAS', s.roasNoPeriodoSelecionado, s.roasNoPeriodoSelecionado === null ? null : String(s.roasNoPeriodoSelecionado)),
      kpi('ACOS', s.acosNoPeriodoSelecionado, s.acosNoPeriodoSelecionado === null ? null : s.acosNoPeriodoSelecionado + '%'),
    ],
    tabela: linhasTabela.length ? {
      titulo: 'Ads — melhores anúncios após Ads',
      colunas: [
        { header: 'Anúncio', key: 'anuncio', tipo: 'texto' }, { header: 'SKU', key: 'sku', tipo: 'texto' },
        { header: 'Investimento', key: 'investimento', tipo: 'money' }, { header: 'Faturamento', key: 'faturamento', tipo: 'money' },
        { header: 'Margem depois do Ads', key: 'margem', tipo: 'money' },
      ],
      linhas: linhasTabela.map((a) => ({ anuncio: a.anuncio, sku: a.sku, investimento: numOrNull(a.investimentoAds), faturamento: numOrNull(a.faturamentoRealDoSku), margem: numOrNull(a.margemDepoisDoAds) })),
    } : null,
    graficos: linhasTabela.length ? [{
      tipo: 'barras',
      titulo: 'Investimento em Ads x faturamento por anúncio',
      categorias: linhasTabela.map((a) => a.anuncio || a.sku),
      series: [
        { nome: 'Investimento', tipo: 'money', valores: linhasTabela.map((a) => numOrNull(a.investimentoAds) || 0) },
        { nome: 'Faturamento', tipo: 'money', valores: linhasTabela.map((a) => numOrNull(a.faturamentoRealDoSku) || 0) },
      ],
    }] : [],
  };
}

function adComparacaoPeriodoAnterior(s) {
  if (!s) return null;
  return {
    kpis: [
      kpi('Faturamento — período atual', numOrNull(s.faturamento.atual), s.faturamento.atual.valorFormatado, { variacaoPercentual: s.faturamento.variacaoPercentual }),
      kpi('Faturamento — período anterior', numOrNull(s.faturamento.anterior), s.faturamento.anterior.valorFormatado),
      kpi('Margem — período atual', numOrNull(s.margemContribuicao.atual), s.margemContribuicao.atual.valorFormatado, { variacaoPercentual: s.margemContribuicao.variacaoPercentual }),
    ],
    graficos: [{
      tipo: 'barras',
      titulo: 'Faturamento — período atual x anterior',
      categorias: [s.periodoAtual.label, s.periodoAnterior.label],
      series: [{ nome: 'Faturamento', tipo: 'money', valores: [numOrNull(s.faturamento.atual) || 0, numOrNull(s.faturamento.anterior) || 0] }],
    }],
  };
}

function adProjecaoMes(s) {
  if (!s || s.disponivel === false) return null;
  if (s.metrica === 'pedidos') {
    const proj = s.projecaoPedidos;
    if (!proj || !proj.disponivel) return { kpis: [kpi('Pedidos realizados no mês', s.pedidosRealizadosNoMesAteHoje, String(s.pedidosRealizadosNoMesAteHoje), { grupo: 'REALIZADO' })] };
    return {
      kpis: [
        kpi('Pedidos realizados no mês', s.pedidosRealizadosNoMesAteHoje, String(s.pedidosRealizadosNoMesAteHoje), { grupo: 'REALIZADO' }),
        kpi('Projeção (tendência)', proj.projecaoAjustadaPelaTendencia, String(proj.projecaoAjustadaPelaTendencia), { grupo: 'PROJETADO' }),
      ],
      graficos: [{ tipo: 'barras', titulo: 'Pedidos — realizado x projetado (fim do mês)', categorias: ['Realizado até hoje', 'Projeção (fim do mês)'], series: [{ nome: 'Pedidos', tipo: 'int', valores: [s.pedidosRealizadosNoMesAteHoje, proj.projecaoAjustadaPelaTendencia] }] }],
    };
  }
  if (s.metrica === 'ads') {
    const proj = s.projecaoGastoAds;
    if (!proj || !proj.disponivel) return { kpis: [kpi('Gasto Ads realizado no mês', numOrNull(s.gastoRealizadoNoMesAteHoje), s.gastoRealizadoNoMesAteHoje.valorFormatado, { grupo: 'REALIZADO' })] };
    return {
      kpis: [
        kpi('Gasto Ads realizado no mês', numOrNull(s.gastoRealizadoNoMesAteHoje), s.gastoRealizadoNoMesAteHoje.valorFormatado, { grupo: 'REALIZADO' }),
        kpi('Projeção de gasto (tendência)', proj.projecaoAjustadaPelaTendencia, proj.projecaoAjustadaPelaTendenciaFormatada, { grupo: 'PROJETADO' }),
      ],
      graficos: [{ tipo: 'barras', titulo: 'Gasto em Ads — realizado x projetado (fim do mês)', categorias: ['Realizado até hoje', 'Projeção (fim do mês)'], series: [{ nome: 'Gasto Ads', tipo: 'money', valores: [numOrNull(s.gastoRealizadoNoMesAteHoje) || 0, proj.projecaoAjustadaPelaTendencia || 0] }] }],
    };
  }
  // faturamento (padrão) e margem_e_lucro compartilham faturamentoRealizadoNoMesAteHoje/projecaoFaturamento
  const proj = s.projecaoFaturamento;
  const kpis = [
    kpi('Faturamento realizado no mês', numOrNull(s.faturamentoRealizadoNoMesAteHoje), s.faturamentoRealizadoNoMesAteHoje.valorFormatado, { grupo: 'REALIZADO' }),
  ];
  if (proj && proj.disponivel) {
    kpis.push(kpi('Projeção de faturamento (tendência)', proj.projecaoAjustadaPelaTendencia, proj.projecaoAjustadaPelaTendenciaFormatada, { grupo: 'PROJETADO' }));
  }
  if (s.metrica === 'margem_e_lucro' && s.margemEProjecaoDisponivel) {
    kpis.push(kpi('Margem de contribuição realizada', numOrNull(s.margemContribuicaoRealizadaNoMesAteHoje), s.margemContribuicaoRealizadaNoMesAteHoje.valorFormatado, { grupo: 'REALIZADO' }));
    if (s.projecaoMargemDeContribuicao && s.projecaoMargemDeContribuicao.disponivel) {
      kpis.push(kpi('Projeção de margem/lucro (tendência)', s.projecaoMargemDeContribuicao.projecaoAjustadaPelaTendencia, s.projecaoMargemDeContribuicao.projecaoAjustadaPelaTendenciaFormatada, { grupo: 'PROJETADO' }));
    }
  }
  const graficos = (proj && proj.disponivel) ? [{
    tipo: 'barras',
    titulo: 'Faturamento — realizado x projetado (fim do mês)',
    categorias: ['Realizado até hoje', 'Projeção (fim do mês)'],
    series: [{ nome: 'Faturamento', tipo: 'money', valores: [numOrNull(s.faturamentoRealizadoNoMesAteHoje) || 0, proj.projecaoAjustadaPelaTendencia || 0] }],
  }] : [];
  return { kpis, graficos };
}

function adVendasComPrejuizo(s) {
  if (!s || !Array.isArray(s.vendas) || !s.vendas.length) return { kpis: [kpi('Vendas com prejuízo', s.quantidadeVendasComPrejuizo || 0, String(s.quantidadeVendasComPrejuizo || 0))] };
  return {
    kpis: [kpi('Vendas com prejuízo', s.quantidadeVendasComPrejuizo, String(s.quantidadeVendasComPrejuizo))],
    tabela: {
      titulo: 'Vendas com prejuízo',
      colunas: [
        { header: 'Pedido', key: 'pedido', tipo: 'texto' }, { header: 'Loja', key: 'loja', tipo: 'texto' },
        { header: 'Produto/SKU', key: 'produto', tipo: 'texto' }, { header: 'Valor da venda', key: 'valor', tipo: 'money' },
        { header: 'Margem de contribuição', key: 'margem', tipo: 'money' },
      ],
      linhas: s.vendas.map((v) => ({ pedido: v.numeroPedido, loja: v.loja, produto: v.produtoOuSku, valor: v.valorVenda, margem: v.margemContribuicao })),
    },
  };
}

const ADAPTADORES = {
  resumo_vendas: adResumoVendas,
  resultado_periodo: adResultadoPeriodo,
  produtos_desempenho: adProdutosDesempenho,
  produtos_por_caixa_desempenho: adProdutosPorCaixa,
  desempenho_por_loja: adDesempenhoPorLoja,
  fluxo_de_caixa: adFluxoDeCaixa,
  contas_a_receber_resumo: adContasAReceber,
  contas_a_pagar_resumo: adContasAPagar,
  dre_completa: adDreCompleta,
  ads_desempenho: adAdsDesempenho,
  comparacao_periodo_anterior: adComparacaoPeriodoAnterior,
  projecao_mes: adProjecaoMes,
  vendas_com_prejuizo: adVendasComPrejuizo,
};

function dedupKpis(lista) {
  const vistos = new Set();
  const saida = [];
  for (const k of lista) {
    if (!k || vistos.has(k.label)) continue;
    vistos.add(k.label);
    saida.push(k);
  }
  return saida;
}

// `chamadas`: [{ nome, input, saida }] — todas as ferramentas executadas
// nesta pergunta (na ordem em que foram chamadas). `apresentacaoInput`: o
// `input` da chamada à ferramenta `apresentar_analise`, ou null quando o
// modelo não chamou (pergunta simples — ver descrição da ferramenta).
// `perguntaTexto`/`empresa`/`periodoCalc` só viajam pra dentro do payload
// guardado (usados depois por lib/ia/planilhaAnalise.js — nome do arquivo e
// cabeçalho da aba Resumo — nunca uma segunda consulta ao ERP).
function montarEstrutura({ empresa, periodoCalc, perguntaTexto, chamadas, apresentacaoInput }) {
  if (!apresentacaoInput) return null;

  const kpis = [];
  const tabelas = [];
  const graficos = [];

  (chamadas || []).forEach((c) => {
    const adaptador = ADAPTADORES[c.nome];
    if (!adaptador) return;
    let r;
    try { r = adaptador(c.saida, c.input); } catch (e) { r = null; }
    if (!r) return;
    if (Array.isArray(r.kpis)) kpis.push(...r.kpis);
    if (r.tabela) tabelas.push(r.tabela);
    if (Array.isArray(r.graficos)) graficos.push(...r.graficos);
  });

  const tabela = tabelas.sort((a, b) => (b.linhas.length - a.linhas.length))[0] || null;
  const kpisFinal = dedupKpis(kpis).slice(0, 8);
  const graficosFinal = graficos.slice(0, 3);

  // Nada de numérico foi produzido (ex: o modelo chamou apresentar_analise
  // numa pergunta cujas outras ferramentas não têm adaptador visual, como
  // consultar_documentacao) — ainda assim devolve insights/atenção/título,
  // só sem resumo/kpis/tabela/gráfico (nunca inventa um número pra
  // preencher a seção).
  return {
    titulo: (apresentacaoInput.tituloConversa || '').trim().slice(0, 80) || null,
    pergunta: perguntaTexto || null,
    empresa: { id: empresa.id, nome: empresa.nome },
    periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
    resumo: kpisFinal.length ? { periodo: periodoCalc.label, empresa: empresa.nome, itens: kpisFinal.slice(0, 4) } : null,
    kpis: kpisFinal,
    tabela,
    graficos: graficosFinal,
    insights: Array.isArray(apresentacaoInput.insights) ? apresentacaoInput.insights.filter((s) => s && String(s).trim()).slice(0, 6).map(String) : [],
    atencao: apresentacaoInput.atencao ? String(apresentacaoInput.atencao).trim().slice(0, 400) : null,
    ferramentas: (chamadas || []).map((c) => c.nome),
  };
}

module.exports = { montarEstrutura, ADAPTADORES };
