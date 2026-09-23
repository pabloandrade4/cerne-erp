// Orquestrador da "Compras com IA" — 22/09/2026, pedido explícito do
// usuário: substituir a aba Compras por uma Central Inteligente de
// Reposição de Estoque, que analisa cada MODELO FÍSICO (produto_base) e
// recomenda quanto comprar — nunca compra sozinha, toda compra passa pela
// aprovação do usuário (ver routes/comprasIa.js).
//
// Mesmo padrão de lib/ia/adsDecisoesCiclo.js/lib/ia/promocoesCiclo.js: cada
// produto base mantém NO MÁXIMO uma recomendação "pendente" por vez (índice
// único parcial em db/schema.sql) — se a mesma situação persistir de um
// ciclo pro outro, só atualiza os números da linha já existente; se deixar
// de fazer sentido (estoque resolvido, por exemplo), a recomendação pendente
// é marcada "expirada", nunca apagada.
//
// NUNCA busca dado novo em API nenhuma — reaproveita, sem nenhum cálculo
// paralelo:
//   • Estoque físico (Full e fora do Full): lib/estoqueFisico.js — mesma
//     fonte das telas Estoque e Estoque Full.
//   • Vendas por período, já em unidade física: lib/relatoriosAgregados.js
//     #relatorioProdutosPorCaixa — mesma fonte do Relatório de Produtos.
const pool = require('../../db/pool');
const { calcularEstoqueFisico } = require('../estoqueFisico');
const { relatorioProdutosPorCaixa } = require('../relatoriosAgregados');
const { converterItens } = require('../produtoBaseConversao');
const { montarDadosDiagnostico, montarRelatorioTextoBase, gerarDiagnosticoCompra } = require('./comprasDiagnostico');

const UM_DIA_MS = 24 * 60 * 60 * 1000;

// Status que geram uma recomendação PENDENTE pro usuário aprovar — os
// demais (saudável/atenção/a caminho) aparecem só como linha informativa na
// tabela principal, sem virar um "pedido de aprovação".
const STATUS_QUE_GERAM_RECOMENDACAO = new Set(['ruptura', 'comprar_agora', 'programar']);

function janela(dias, agora) {
  return { desde: new Date(agora.getTime() - dias * UM_DIA_MS), ate: agora };
}

async function buscarProdutosBaseAtivos(empresaId) {
  const { rows } = await pool.query(
    `SELECT pb.id, pb.codigo, pb.nome, pb.custo, pb.estoque_seguranca_dias,
            pb.fornecedor_padrao_id, f.razao_social AS fornecedor_nome, f.prazo_entrega_dias
       FROM produtos_base pb
       LEFT JOIN fornecedores f ON f.id = pb.fornecedor_padrao_id
      WHERE pb.empresa_id = $1 AND pb.ativo = TRUE
      ORDER BY pb.codigo`,
    [empresaId]
  );
  return rows;
}

// Mercadoria "a caminho" por produto base: soma os pedidos desta tela ainda
// não recebidos/cancelados + (dobra de propósito) os itens do módulo antigo
// de Compras (`compras`/`compra_itens`, ligado a `produtos`/SKU) ainda em
// aberto — convertidos pra unidade física com a MESMA função já usada pra
// vendas e estoque (produto_base_skus). Isso evita a IA recomendar comprar
// de novo algo que o usuário já tinha pedido pela tela antiga, sem precisar
// tocar em nenhuma linha/rota do módulo antigo (ver docs/02-decisoes.md).
async function buscarACaminhoPorProdutoBase(empresaId) {
  const mapa = new Map();

  const { rows: novos } = await pool.query(
    `SELECT produto_base_id, COALESCE(SUM(quantidade),0) AS quantidade
       FROM compras_ia_pedidos
      WHERE empresa_id = $1 AND status NOT IN ('recebido','cancelado')
      GROUP BY produto_base_id`,
    [empresaId]
  );
  novos.forEach((r) => mapa.set(r.produto_base_id, Number(r.quantidade)));

  const { rows: itensAntigos } = await pool.query(
    `SELECT p.sku, ci.quantidade
       FROM compra_itens ci
       JOIN compras c ON c.id = ci.compra_id
       JOIN produtos p ON p.id = ci.produto_id
      WHERE c.empresa_id = $1 AND c.status IN ('em_aberto','pedido_realizado')`,
    [empresaId]
  );
  if (itensAntigos.length) {
    const conversao = await converterItens(empresaId, itensAntigos.map((r) => ({ sku: r.sku, quantidade: Number(r.quantidade) })));
    conversao.porProdutoBase.forEach((pb) => {
      mapa.set(pb.produtoBaseId, (mapa.get(pb.produtoBaseId) || 0) + pb.quantidadeFisica);
    });
  }
  return mapa;
}

// Vendas físicas (todas as lojas/canais) nas 3 janelas, por CÓDIGO de
// produto base (relatorioProdutosPorCaixa agrupa por código, não por id —
// mesma chave usada em todo o resto do sistema pra este agrupamento).
async function buscarVendasPorJanelas(empresaId, agora) {
  const j7 = janela(7, agora);
  const j14 = janela(14, agora);
  const j30 = janela(30, agora);

  const [r7, r14, r30] = await Promise.all([
    relatorioProdutosPorCaixa({ empresaId, contaId: null, desde: j7.desde, ate: j7.ate }),
    relatorioProdutosPorCaixa({ empresaId, contaId: null, desde: j14.desde, ate: j14.ate }),
    relatorioProdutosPorCaixa({ empresaId, contaId: null, desde: j30.desde, ate: j30.ate }),
  ]);

  const porCodigo = (resultado) => new Map(resultado.linhas.map((l) => [l.produtoBase, l.quantidadeCaixas]));
  return { v7: porCodigo(r7), v14: porCodigo(r14), v30: porCodigo(r30) };
}

async function buscarRecomendacaoPendente(empresaId, produtoBaseId) {
  const { rows } = await pool.query(
    `SELECT id FROM ia_decisoes_compras
      WHERE empresa_id = $1 AND produto_base_id = $2 AND tipo_acao = 'comprar_estoque' AND status_decisao = 'pendente'`,
    [empresaId, produtoBaseId]
  );
  return rows.length ? rows[0].id : null;
}

async function upsertRecomendacao({ empresaId, produtoBase, dados, motivo, relatorioTexto, relatorioIa }) {
  const c = dados.calc;
  const idExistente = await buscarRecomendacaoPendente(empresaId, produtoBase.id);

  const params = [
    dados.calc.status, motivo,
    dados.estoqueGalpao, dados.estoqueFull, dados.estoqueACaminho,
    c.mediaDiaria7 * 7, c.mediaDiaria14 * 14, c.mediaDiaria30 * 30,
    c.mediaDiariaProjetada, c.acelerando,
    c.diasCobertura, c.dataRupturaPrevista,
    produtoBase.prazo_entrega_dias, c.estoqueSegurancaDias, produtoBase.custo,
    c.quantidadeRecomendada, c.valorEstimado, produtoBase.fornecedor_padrao_id,
  ];

  if (idExistente) {
    await pool.query(
      `UPDATE ia_decisoes_compras SET
         status_urgencia=$1, motivo=$2,
         snapshot_estoque_galpao=$3, snapshot_estoque_full=$4, snapshot_estoque_a_caminho=$5,
         snapshot_venda_7d=$6, snapshot_venda_14d=$7, snapshot_venda_30d=$8,
         snapshot_media_dia_projetada=$9, snapshot_acelerando=$10,
         snapshot_dias_cobertura=$11, snapshot_data_ruptura_prevista=$12,
         snapshot_prazo_fornecedor_dias=$13, snapshot_estoque_seguranca_dias=$14, snapshot_custo_unitario=$15,
         quantidade_sugerida_ia=$16, valor_estimado_ia=$17, fornecedor_sugerido_id=$18,
         atualizado_em = now()
       WHERE id = $19`,
      [...params, idExistente]
    );
    return { id: idExistente, novo: false };
  }

  const { rows } = await pool.query(
    `INSERT INTO ia_decisoes_compras (
       empresa_id, produto_base_id, produto_base_codigo, tipo_acao,
       status_urgencia, motivo,
       snapshot_estoque_galpao, snapshot_estoque_full, snapshot_estoque_a_caminho,
       snapshot_venda_7d, snapshot_venda_14d, snapshot_venda_30d,
       snapshot_media_dia_projetada, snapshot_acelerando,
       snapshot_dias_cobertura, snapshot_data_ruptura_prevista,
       snapshot_prazo_fornecedor_dias, snapshot_estoque_seguranca_dias, snapshot_custo_unitario,
       quantidade_sugerida_ia, valor_estimado_ia, fornecedor_sugerido_id,
       relatorio_diagnostico_texto, relatorio_diagnostico_ia, relatorio_diagnostico_gerado_em
     ) VALUES ($1,$2,$3,'comprar_estoque',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     RETURNING id`,
    [
      empresaId, produtoBase.id, produtoBase.codigo,
      ...params,
      relatorioTexto || null, relatorioIa || null, relatorioTexto ? new Date() : null,
    ]
  );
  return { id: rows[0].id, novo: true };
}

async function expirarNaoTocadas(empresaId, idsTocados) {
  if (!idsTocados.length) {
    await pool.query(
      `UPDATE ia_decisoes_compras SET status_decisao='expirada', atualizado_em=now()
        WHERE empresa_id=$1 AND status_decisao='pendente'`,
      [empresaId]
    );
    return;
  }
  await pool.query(
    `UPDATE ia_decisoes_compras SET status_decisao='expirada', atualizado_em=now()
      WHERE empresa_id=$1 AND status_decisao='pendente' AND id <> ALL($2::int[])`,
    [empresaId, idsTocados]
  );
}

// Monta os dados calculados (motor + motivos) de TODOS os produtos base
// ativos de uma empresa, de uma vez — reaproveitado tanto pelo ciclo
// automático (que só persiste os que viram recomendação) quanto pela rota
// de leitura ao vivo da tela (que mostra TODOS, incluindo saudável/atenção),
// pra nunca existir dois cálculos diferentes pro mesmo número.
async function montarLinhasParaEmpresa(empresaId, { agora = new Date() } = {}) {
  const produtosBase = await buscarProdutosBaseAtivos(empresaId);
  if (!produtosBase.length) return [];

  const [estoqueFisico, vendas, aCaminhoPorId] = await Promise.all([
    calcularEstoqueFisico(empresaId),
    buscarVendasPorJanelas(empresaId, agora),
    buscarACaminhoPorProdutoBase(empresaId),
  ]);

  const galpaoPorCodigo = new Map(estoqueFisico.foraDoFull.produtosBase.map((p) => [p.produtoBase, p.quantidadeFisica]));
  const fullPorCodigo = new Map(estoqueFisico.full.produtosBase.map((p) => [p.produtoBase, p.quantidadeFisica]));

  return produtosBase.map((produtoBase) => {
    const estoqueGalpao = galpaoPorCodigo.get(produtoBase.codigo) || 0;
    const estoqueFull = fullPorCodigo.get(produtoBase.codigo) || 0;
    const estoqueACaminho = aCaminhoPorId.get(produtoBase.id) || 0;
    const venda7d = vendas.v7.get(produtoBase.codigo) || 0;
    const venda14d = vendas.v14.get(produtoBase.codigo) || 0;
    const venda30d = vendas.v30.get(produtoBase.codigo) || 0;

    const dados = montarDadosDiagnostico({
      produtoBaseCodigo: produtoBase.codigo, produtoBaseNome: produtoBase.nome,
      estoqueGalpao, estoqueFull, estoqueACaminho,
      venda7d, venda14d, venda30d,
      prazoFornecedorDias: produtoBase.prazo_entrega_dias,
      estoqueSegurancaDiasConfigurado: produtoBase.estoque_seguranca_dias,
      custoUnitario: produtoBase.custo === null ? null : Number(produtoBase.custo),
      fornecedorNome: produtoBase.fornecedor_nome,
      agora,
    });

    return { produtoBase, dados };
  });
}

async function executarCicloComprasIaEmpresa(empresaId, { agora = new Date() } = {}) {
  const empresaRow = await pool.query('SELECT id FROM empresas WHERE id = $1 AND ativo = TRUE', [empresaId]);
  if (!empresaRow.rows.length) return { empresaId, ignorado: true };

  const linhas = await montarLinhasParaEmpresa(empresaId, { agora });
  if (!linhas.length) return { empresaId, produtosAnalisados: 0, recomendacoesGeradas: 0 };

  const idsTocados = [];
  let recomendacoesGeradas = 0;

  for (const { produtoBase, dados } of linhas) {
    const { estoqueGalpao, estoqueFull, estoqueACaminho } = dados;
    const venda7d = dados.calc.mediaDiaria7 * 7;
    const venda14d = dados.calc.mediaDiaria14 * 14;
    const venda30d = dados.calc.mediaDiaria30 * 30;

    if (!STATUS_QUE_GERAM_RECOMENDACAO.has(dados.calc.status) || dados.calc.quantidadeRecomendada <= 0) continue;

    const motivo = dados.motivos.join(' ') || dados.statusInfo.label;

    // Relatório completo (mesma lógica de custo de lib/ia/adsDiagnostico.js):
    // só gerado quando a recomendação está virando PENDENTE NOVA, nunca a
    // cada ciclo pra uma situação que já estava pendente.
    let relatorioTexto = null;
    let relatorioIa = null;
    const jaPendente = await buscarRecomendacaoPendente(empresaId, produtoBase.id);
    if (!jaPendente) {
      try {
        const diagnostico = await gerarDiagnosticoCompra({
          produtoBaseCodigo: produtoBase.codigo, produtoBaseNome: produtoBase.nome,
          estoqueGalpao, estoqueFull, estoqueACaminho,
          venda7d, venda14d, venda30d,
          prazoFornecedorDias: produtoBase.prazo_entrega_dias,
          estoqueSegurancaDiasConfigurado: produtoBase.estoque_seguranca_dias,
          custoUnitario: produtoBase.custo === null ? null : Number(produtoBase.custo),
          fornecedorNome: produtoBase.fornecedor_nome,
          agora,
        });
        relatorioTexto = diagnostico.textoBase;
        relatorioIa = diagnostico.textoIa;
      } catch (err) {
        console.error(`[Compras IA][ciclo] falha ao gerar relatório do modelo ${produtoBase.codigo}: ${err.message}`);
        relatorioTexto = montarRelatorioTextoBase(dados);
      }
    }

    const { id } = await upsertRecomendacao({ empresaId, produtoBase, dados, motivo, relatorioTexto, relatorioIa });
    idsTocados.push(id);
    recomendacoesGeradas++;
  }

  try {
    await expirarNaoTocadas(empresaId, idsTocados);
  } catch (err) {
    console.error(`[Compras IA][ciclo] falha ao expirar recomendações antigas da empresa ${empresaId}: ${err.message}`);
  }

  return { empresaId, produtosAnalisados: linhas.length, recomendacoesGeradas };
}

async function executarCicloComprasIa() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloComprasIaEmpresa(e.id)));
  const comErro = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      comErro.push({ empresaId: empresas[i].id, erro: String((r.reason && r.reason.message) || r.reason) });
      console.error(`[Compras IA][ciclo] empresa ${empresas[i].id} falhou: ${comErro[comErro.length - 1].erro}`);
    }
  });
  return { empresasProcessadas: empresas.length, comErro };
}

module.exports = {
  executarCicloComprasIaEmpresa,
  executarCicloComprasIa,
  montarLinhasParaEmpresa,
  buscarProdutosBaseAtivos,
  buscarACaminhoPorProdutoBase,
  buscarVendasPorJanelas,
};
