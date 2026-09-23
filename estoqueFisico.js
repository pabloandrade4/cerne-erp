// Estoque FÍSICO (Full + fora do Full) por produto base — Passo 1 da tarefa
// "IA Gestora: corrigir análise do Estoque Full" (ver docs/02-decisoes.md).
//
// Por que este módulo existe: as ferramentas da IA Gestora (lib/ia/
// ferramentas.js) precisavam responder "quanto tenho no Full em matéria-
// prima" e não conseguiam, porque a única conta que existia
// (handleEstoqueValorParado, antes desta correção) somava quantidade de
// ANÚNCIO/KIT × produtos.custo (custo por SKU exato) — nunca convertia kit
// em unidade física (ex: um anúncio "100CX-20X20X20" tem 1 unidade
// disponível = 100 caixas físicas) e nunca separava Full de fora do Full no
// resultado.
//
// Duas decisões importantes, ambas pedidas explicitamente pelo usuário:
//   1) FONTE DE DADOS: lê exatamente a mesma tabela que as telas Estoque e
//      Estoque Full leem (`ml_estoque_itens`, espelho de somente leitura
//      sincronizado a cada 1 minuto por lib/mlEstoque.js — ver routes/
//      estoque.js e routes/estoqueFull.js). Nunca busca ao vivo na API do
//      Mercado Livre (isso pertence a lib/mlFull.js, usado só pela rota
//      legada/desativada routes/estoqueProdutoBase.js) — garante que os
//      números da IA batem exatamente com os das duas telas.
//   2) CONVERSÃO KIT -> FÍSICO: reaproveita EXATAMENTE a mesma regra
//      normalizada já usada pelo Relatório de Produtos > "Por Caixa"
//      (lib/relatoriosAgregados.js#resolverProdutosBasePorSku) — vínculo
//      salvo em produto_base_skus tem prioridade; sem vínculo, interpreta o
//      padrão do próprio texto do SKU (dígitos no início = multiplicador);
//      SKU que não segue nenhum padrão nunca é chutado. NENHUMA segunda
//      lógica de conversão de kits é criada aqui.
//
// CUSTO: usa produtos_base.custo — o custo cadastrado POR UNIDADE FÍSICA do
// produto base (ex: R$ 0,91 por caixa 20x20x20) — nunca produtos.custo
// (custo por SKU/kit exato, usado em outro lugar do sistema para a margem
// de venda) e nunca o preço de venda. Um produto base sem custo cadastrado
// nunca entra na soma financeira — a quantidade física continua conhecida e
// aparece à parte, nunca com custo zero fingindo ser um valor real.
//
// ESTOQUE COMPARTILHADO ENTRE ANÚNCIOS: `ml_estoque_itens` não guarda o
// `inventory_id` do Mercado Livre (só o `ml_item_id`/`ml_variation_id`), e
// quando um anúncio tem múltiplas variações Full, lib/mlEstoque.js grava a
// MESMA quantidade Full (de nível de anúncio) em cada linha de variação —
// exatamente como a tela Estoque Full já mostra hoje. Este módulo NÃO tenta
// uma deduplicação própria: ele soma exatamente as mesmas linhas que
// Estoque/Estoque Full mostram, porque o requisito do usuário de "os
// valores da IA precisam bater exatamente com as páginas Estoque e Estoque
// Full" pesa mais do que uma correção de deduplicação que mudaria esse
// dado (fora do escopo desta tarefa — ver docs/05-problemas-conhecidos.md).
const pool = require('../db/pool');
const { resolverProdutosBasePorSku } = require('./relatoriosAgregados');
const { round2 } = require('./resultadoVenda');

// Hoje "Full" só existe como conceito do Mercado Livre neste ERP (não há
// coluna/tabela de Full da Shopee) — valor estrutural, nunca inventado.
const MARKETPLACE_FULL = 'Mercado Livre';

// ============================================================
// Baixa de estoque por Venda de Balcão (22/09/2026 — ver lib/vendaBalcao.js)
// ============================================================
// O usuário pediu explicitamente que uma venda de balcão "baixe o estoque
// exibido" automaticamente. Como o estoque físico só existe hoje como
// espelho do Mercado Livre (`ml_estoque_itens`, sincronizado a cada 1
// minuto — ver cabeçalho do arquivo), NUNCA escrevemos nessa tabela: em vez
// disso, subtraímos a quantidade vendida no balcão (convertida pra unidade
// física pela MESMA regra de produtos_base já usada em todo o resto —
// resolverProdutosBasePorSku) SÓ do bloco "fora do Full" (produto guardado
// na própria empresa — nunca do Full, que fisicamente fica no centro de
// distribuição do Mercado Livre e nunca é vendido no balcão).
//
// LIMITAÇÃO CONHECIDA (documentada de propósito, não escondida): esta baixa
// é cumulativa e permanente (soma TODAS as vendas de balcão não canceladas
// desde sempre) — se o usuário também corrigir manualmente o anúncio no
// Mercado Livre por causa da mesma venda (ex.: reduzir a quantidade lá por
// fora), o sistema vai descontar duas vezes (uma vez pela correção manual
// no ML, que já reflete na sincronização, e de novo aqui). Não existe hoje
// nenhum mecanismo de "zerar"/reconciliar essa baixa — foi uma escolha
// consciente por causa do tempo disponível nesta etapa, e fica registrada
// em docs/05-problemas-conhecidos.md. Quando a venda de balcão aponta pra
// um produto base que não tem NENHUM item físico "fora do Full" hoje (ex.:
// o usuário nunca cadastrou esse produto como anúncio próprio), a baixa não
// tem de onde ser descontada — nesse caso ela aparece à parte, em
// `foraDoFull.vendasBalcaoSemEstoqueParaBaixar`, nunca escondida nem
// descontada de outro produto por engano.
async function buscarVendaBalcaoPorProdutoBase(empresaId, resolucoes) {
  const { rows } = await pool.query(
    `SELECT vbi.sku, SUM(vbi.quantidade) AS quantidade_vendida
     FROM vendas_balcao_itens vbi
     JOIN vendas_balcao vb ON vb.id = vbi.venda_id
     WHERE vb.empresa_id = $1 AND vb.status = 'concluida'
     GROUP BY vbi.sku`,
    [empresaId]
  );
  if (!rows.length) return { porProdutoBase: new Map(), semResolucao: [] };

  const porProdutoBase = new Map();
  const semResolucao = [];
  rows.forEach((r) => {
    const resolucao = resolucoes[r.sku];
    const quantidadeVendida = Number(r.quantidade_vendida);
    if (!resolucao) { semResolucao.push({ sku: r.sku, quantidadeVendida }); return; }
    const fisica = quantidadeVendida * resolucao.multiplicador;
    porProdutoBase.set(resolucao.codigoBase, round2((porProdutoBase.get(resolucao.codigoBase) || 0) + fisica));
  });
  return { porProdutoBase, semResolucao };
}

// Aplica a baixa (já calculada por produto base, em unidade física) só no
// bloco "fora do Full" — nunca toca em `full`. Nunca deixa a quantidade
// negativa (trava em 0); o que não coube em nenhum produto físico existente
// entra em `vendasBalcaoSemEstoqueParaBaixar`, à parte, pra nunca sumir do
// relatório nem descontar do produto errado.
function aplicarBaixaVendaBalcao(bloco, vendaBalcao) {
  const { porProdutoBase, semResolucao } = vendaBalcao;
  if (!porProdutoBase.size && !semResolucao.length) return bloco;

  const naoAplicadas = semResolucao.map((s) => ({ ...s, motivo: 'sku_sem_produto_base_identificado' }));
  const pendentes = new Map(porProdutoBase);

  const produtosBase = bloco.produtosBase.map((p) => {
    const vendida = pendentes.get(p.produtoBase);
    if (!vendida) return p;
    pendentes.delete(p.produtoBase);
    const baixaAplicada = Math.min(p.quantidadeFisica, vendida);
    const restanteNaoAplicado = round2(vendida - baixaAplicada);
    const novaQuantidade = round2(p.quantidadeFisica - baixaAplicada);
    const novoValor = p.custoUnitario !== null ? round2(novaQuantidade * p.custoUnitario) : null;
    if (restanteNaoAplicado > 0) {
      naoAplicadas.push({ produtoBase: p.produtoBase, quantidadeVendida: restanteNaoAplicado, motivo: 'estoque_fora_do_full_insuficiente' });
    }
    return { ...p, quantidadeFisica: novaQuantidade, valorEmEstoque: novoValor, baixaVendaBalcao: baixaAplicada };
  });

  // Produto base vendido no balcão mas sem NENHUM item "fora do Full" hoje
  // — nada pra descontar, entra só na lista de transparência.
  pendentes.forEach((quantidadeVendida, produtoBase) => {
    naoAplicadas.push({ produtoBase, quantidadeVendida, motivo: 'sem_item_fora_do_full' });
  });

  const unidadesFisicas = produtosBase.reduce((acc, p) => acc + p.quantidadeFisica, 0);
  const unidadesFisicasSemCustoCadastrado = produtosBase
    .filter((p) => p.custoUnitario === null)
    .reduce((acc, p) => acc + p.quantidadeFisica, 0);
  const comCusto = produtosBase.filter((p) => p.custoUnitario !== null);
  const valorTotalACusto = comCusto.length
    ? round2(comCusto.reduce((acc, p) => acc + (p.valorEmEstoque || 0), 0))
    : null;

  return {
    ...bloco,
    produtosBase: produtosBase.sort((a, b) => (b.valorEmEstoque || 0) - (a.valorEmEstoque || 0)),
    unidadesFisicas,
    unidadesFisicasSemCustoCadastrado,
    valorTotalACusto,
    vendasBalcaoSemEstoqueParaBaixar: naoAplicadas,
  };
}

function montarBlocoVazio() {
  return {
    valorTotalACusto: null,
    unidadesFisicas: 0,
    itens: [],
    produtosBase: [],
    unidadesFisicasSemCustoCadastrado: 0,
    unidadesSemProdutoBaseIdentificado: 0,
    itensPendentesDeSincronizacao: 0,
    // Presente em todo bloco (full e fora do Full) mesmo quando vazio, pra
    // nunca faltar o campo pro front — só é preenchido de verdade dentro de
    // aplicarBaixaVendaBalcao, e só no bloco "fora do Full".
    vendasBalcaoSemEstoqueParaBaixar: [],
  };
}

// Calcula o estoque físico (Full e fora do Full, sempre separados) de uma
// empresa: por item de estoque (nível de anúncio/variação) e agregado por
// produto base — para responder tanto "quanto tenho no total" quanto
// "quanto tenho da caixa 20x20x20" ou "quais produtos representam mais
// dinheiro".
async function calcularEstoqueFisico(empresaId) {
  const { rows } = await pool.query(
    `SELECT tipo, ml_item_id, sku, loja, titulo, quantidade, pendente
     FROM ml_estoque_itens
     WHERE empresa_id = $1`,
    [empresaId]
  );

  if (!rows.length) {
    return { marketplace: MARKETPLACE_FULL, full: montarBlocoVazio(), foraDoFull: montarBlocoVazio(), valorTotalGeral: null };
  }

  const skusValidos = rows.filter((r) => r.sku && !r.pendente && r.quantidade !== null).map((r) => r.sku);

  // SKUs de vendas de balcão (concluídas) entram na MESMA resolução de SKU
  // -> produto base que o estoque do Mercado Livre já usa (uma única
  // chamada, evita resolver o mesmo SKU duas vezes quando ele também
  // aparece em ml_estoque_itens).
  const { rows: skusBalcaoRows } = await pool.query(
    `SELECT DISTINCT vbi.sku
     FROM vendas_balcao_itens vbi
     JOIN vendas_balcao vb ON vb.id = vbi.venda_id
     WHERE vb.empresa_id = $1 AND vb.status = 'concluida'`,
    [empresaId]
  );
  const skusParaResolver = [...new Set([...skusValidos, ...skusBalcaoRows.map((r) => r.sku)])];
  const resolucoes = await resolverProdutosBasePorSku(empresaId, skusParaResolver);
  const vendaBalcao = await buscarVendaBalcaoPorProdutoBase(empresaId, resolucoes);

  const codigosBase = [...new Set(Object.values(resolucoes).filter(Boolean).map((r) => r.codigoBase))];
  let custos = {};
  if (codigosBase.length) {
    const { rows: custoRows } = await pool.query(
      `SELECT codigo, custo FROM produtos_base WHERE empresa_id = $1 AND codigo = ANY($2::text[])`,
      [empresaId, codigosBase]
    );
    custos = Object.fromEntries(custoRows.map((r) => [r.codigo, r.custo === null ? null : Number(r.custo)]));
  }

  function processarTipo(tipo) {
    const doTipo = rows.filter((r) => r.tipo === tipo);
    if (!doTipo.length) return montarBlocoVazio();

    const itens = [];
    const porProdutoBase = new Map();
    let valorTotal = 0;
    let temValor = false;
    let unidadesFisicas = 0;
    let unidadesFisicasSemCusto = 0;
    let unidadesSemProdutoBase = 0;
    let itensPendentes = 0;

    doTipo.forEach((r) => {
      if (r.pendente || r.quantidade === null) {
        itensPendentes++;
        return;
      }
      const quantidadeDisponivel = Number(r.quantidade);
      const resolucao = r.sku ? resolucoes[r.sku] : null;

      if (!resolucao) {
        unidadesSemProdutoBase += quantidadeDisponivel;
        itens.push({
          empresaId,
          loja: r.loja,
          marketplace: MARKETPLACE_FULL,
          itemId: r.ml_item_id,
          sku: r.sku,
          tituloAnuncio: r.titulo,
          produtoBase: null,
          quantidadeDisponivel,
          quantidadeFisica: null,
          custoUnitario: null,
          valorEmEstoque: null,
        });
        return;
      }

      const quantidadeFisica = quantidadeDisponivel * resolucao.multiplicador;
      const custoUnitario = custos[resolucao.codigoBase] === undefined ? null : custos[resolucao.codigoBase];
      const valorItem = custoUnitario !== null ? round2(quantidadeFisica * custoUnitario) : null;

      unidadesFisicas += quantidadeFisica;
      if (custoUnitario === null) {
        unidadesFisicasSemCusto += quantidadeFisica;
      } else {
        valorTotal = round2(valorTotal + valorItem);
        temValor = true;
      }

      itens.push({
        empresaId,
        loja: r.loja,
        marketplace: MARKETPLACE_FULL,
        itemId: r.ml_item_id,
        sku: r.sku,
        tituloAnuncio: r.titulo,
        produtoBase: resolucao.codigoBase,
        quantidadeDisponivel,
        quantidadeFisica,
        custoUnitario,
        valorEmEstoque: valorItem,
      });

      const chave = resolucao.codigoBase;
      if (!porProdutoBase.has(chave)) {
        porProdutoBase.set(chave, { produtoBase: chave, quantidadeFisica: 0, custoUnitario, valorEmEstoque: custoUnitario !== null ? 0 : null });
      }
      const acc = porProdutoBase.get(chave);
      acc.quantidadeFisica += quantidadeFisica;
      if (valorItem !== null) acc.valorEmEstoque = round2((acc.valorEmEstoque || 0) + valorItem);
    });

    return {
      valorTotalACusto: temValor ? valorTotal : null,
      unidadesFisicas,
      itens,
      produtosBase: [...porProdutoBase.values()].sort((a, b) => (b.valorEmEstoque || 0) - (a.valorEmEstoque || 0)),
      unidadesFisicasSemCustoCadastrado: unidadesFisicasSemCusto,
      unidadesSemProdutoBaseIdentificado: unidadesSemProdutoBase,
      itensPendentesDeSincronizacao: itensPendentes,
    };
  }

  const full = processarTipo('full');
  // Baixa de venda de balcão SÓ no "fora do Full" — nunca no Full (ver
  // comentário grande acima de aplicarBaixaVendaBalcao).
  const foraDoFull = aplicarBaixaVendaBalcao(processarTipo('proprio'), vendaBalcao);

  const valorTotalGeral = (full.valorTotalACusto !== null || foraDoFull.valorTotalACusto !== null)
    ? round2((full.valorTotalACusto || 0) + (foraDoFull.valorTotalACusto || 0))
    : null;

  return { marketplace: MARKETPLACE_FULL, full, foraDoFull, valorTotalGeral };
}

module.exports = { calcularEstoqueFisico, MARKETPLACE_FULL };
