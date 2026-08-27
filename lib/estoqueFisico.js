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

function montarBlocoVazio() {
  return {
    valorTotalACusto: null,
    unidadesFisicas: 0,
    itens: [],
    produtosBase: [],
    unidadesFisicasSemCustoCadastrado: 0,
    unidadesSemProdutoBaseIdentificado: 0,
    itensPendentesDeSincronizacao: 0,
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
  const resolucoes = await resolverProdutosBasePorSku(empresaId, skusValidos);

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
  const foraDoFull = processarTipo('proprio');

  const valorTotalGeral = (full.valorTotalACusto !== null || foraDoFull.valorTotalACusto !== null)
    ? round2((full.valorTotalACusto || 0) + (foraDoFull.valorTotalACusto || 0))
    : null;

  return { marketplace: MARKETPLACE_FULL, full, foraDoFull, valorTotalGeral };
}

module.exports = { calcularEstoqueFisico, MARKETPLACE_FULL };
