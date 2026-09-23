// Compras com IA — 22/09/2026, pedido explícito do usuário: substitui a
// aba Compras (routes/compras.js CONTINUA existindo e funcionando, só sem
// tela própria no menu) por uma Central Inteligente de Reposição de
// Estoque. A IA NUNCA compra sozinha — toda compra passa por aprovação
// humana aqui (PUT /decisoes/:id) antes de virar um pedido de compra.
const express = require('express');
const pool = require('../db/pool');
const { montarLinhasParaEmpresa, executarCicloComprasIaEmpresa } = require('../lib/ia/comprasCiclo');
const { STATUS_LABEL } = require('../lib/ia/comprasMotor');
const { montarRelatorioTextoBase } = require('../lib/ia/comprasDiagnostico');

const router = express.Router();

function round2(n) { return Math.round(n * 100) / 100; }

function linhaParaApi({ produtoBase, dados }) {
  const c = dados.calc;
  return {
    produtoBaseId: produtoBase.id,
    codigo: produtoBase.codigo,
    nome: produtoBase.nome,
    estoqueGalpao: dados.estoqueGalpao,
    estoqueFull: dados.estoqueFull,
    estoqueTotal: c.estoqueDisponivelReal,
    estoqueACaminho: dados.estoqueACaminho,
    venda7d: round2(c.mediaDiaria7 * 7),
    mediaDiariaProjetada: c.mediaDiariaProjetada,
    acelerando: c.acelerando,
    desacelerando: c.desacelerando,
    diasCobertura: c.diasCobertura,
    dataRupturaPrevista: c.dataRupturaPrevista,
    prazoFornecedorDias: produtoBase.prazo_entrega_dias,
    prazoFornecedorIndisponivel: c.prazoFornecedorIndisponivel,
    fornecedorPadraoId: produtoBase.fornecedor_padrao_id,
    fornecedorNome: produtoBase.fornecedor_nome,
    estoqueSegurancaDias: c.estoqueSegurancaDias,
    quantidadeRecomendada: c.quantidadeRecomendada,
    valorEstimado: c.valorEstimado,
    custoUnitario: produtoBase.custo === null ? null : Number(produtoBase.custo),
    status: c.status,
    statusEmoji: STATUS_LABEL[c.status].emoji,
    statusLabel: STATUS_LABEL[c.status].label,
    semHistoricoDeVendas: c.semHistoricoDeVendas,
  };
}

// GET /api/compras-ia/linhas?empresaId=ID — tabela principal (TODOS os
// modelos ativos, calculado ao vivo com o mesmo motor do ciclo automático —
// nunca um número diferente entre a tela e o que fica salvo em
// ia_decisoes_compras).
router.get('/linhas', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const linhas = await montarLinhasParaEmpresa(Number(empresaId));
    res.json({ linhas: linhas.map(linhaParaApi) });
  } catch (err) { next(err); }
});

// GET /api/compras-ia/resumo?empresaId=ID — cards do topo.
router.get('/resumo', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const linhas = await montarLinhasParaEmpresa(Number(empresaId));

    let recomendadoHoje = 0;
    let urgentes = 0;
    let programar = 0;
    let saudaveis = 0;
    let aCaminhoQtd = 0;
    let aCaminhoValor = 0;
    let temValorParcial = false;

    linhas.forEach(({ dados, produtoBase }) => {
      const c = dados.calc;
      if (c.status === 'ruptura' || c.status === 'comprar_agora') urgentes++;
      else if (c.status === 'programar') programar++;
      else if (c.status === 'saudavel' || c.status === 'a_caminho') saudaveis++;
      if (c.valorEstimado !== null) recomendadoHoje = round2(recomendadoHoje + c.valorEstimado);
      else if (c.quantidadeRecomendada > 0) temValorParcial = true;
      if (dados.estoqueACaminho > 0) {
        aCaminhoQtd += dados.estoqueACaminho;
        if (produtoBase.custo !== null) aCaminhoValor = round2(aCaminhoValor + dados.estoqueACaminho * Number(produtoBase.custo));
      }
    });

    res.json({
      recomendadoComprarHoje: recomendadoHoje,
      recomendadoValorParcial: temValorParcial,
      comprasUrgentes: urgentes,
      comprarEstaSemana: programar,
      estoqueSaudavel: saudaveis,
      mercadoriaACaminhoQuantidade: aCaminhoQtd,
      mercadoriaACaminhoValor: aCaminhoValor,
      totalModelos: linhas.length,
    });
  } catch (err) { next(err); }
});

// GET /api/compras-ia/detalhe/:produtoBaseId?empresaId=ID — card detalhado
// (modal). Sempre devolve o texto determinístico (calculado na hora, sem
// custo de IA); se já existir uma recomendação pendente salva pra este
// modelo, também devolve o relatório reescrito pela IA generativa (gerado
// só uma vez, na criação da recomendação — ver lib/ia/comprasCiclo.js).
router.get('/detalhe/:produtoBaseId', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const produtoBaseId = Number(req.params.produtoBaseId);

    const linhas = await montarLinhasParaEmpresa(Number(empresaId));
    const linha = linhas.find((l) => l.produtoBase.id === produtoBaseId);
    if (!linha) return res.status(404).json({ error: 'Modelo não encontrado (ou inativo) nesta empresa.' });

    const textoBase = montarRelatorioTextoBase(linha.dados);

    const { rows: recRows } = await pool.query(
      `SELECT id, relatorio_diagnostico_texto, relatorio_diagnostico_ia, relatorio_diagnostico_gerado_em
         FROM ia_decisoes_compras
        WHERE empresa_id = $1 AND produto_base_id = $2 AND status_decisao = 'pendente'
        ORDER BY criado_em DESC LIMIT 1`,
      [empresaId, produtoBaseId]
    );
    const recomendacaoPendente = recRows[0] || null;

    res.json({
      linha: linhaParaApi(linha),
      motivos: linha.dados.motivos,
      relatorioTexto: (recomendacaoPendente && recomendacaoPendente.relatorio_diagnostico_texto) || textoBase,
      relatorioIa: recomendacaoPendente ? recomendacaoPendente.relatorio_diagnostico_ia : null,
      recomendacaoId: recomendacaoPendente ? recomendacaoPendente.id : null,
    });
  } catch (err) { next(err); }
});

function linhaDecisaoParaApi(row) {
  return {
    id: row.id,
    produtoBaseId: row.produto_base_id,
    produtoBaseCodigo: row.produto_base_codigo,
    statusUrgencia: row.status_urgencia,
    statusEmoji: (STATUS_LABEL[row.status_urgencia] || {}).emoji || '',
    statusLabel: (STATUS_LABEL[row.status_urgencia] || {}).label || row.status_urgencia,
    motivo: row.motivo,
    snapshot: {
      estoqueGalpao: row.snapshot_estoque_galpao === null ? null : Number(row.snapshot_estoque_galpao),
      estoqueFull: row.snapshot_estoque_full === null ? null : Number(row.snapshot_estoque_full),
      estoqueACaminho: row.snapshot_estoque_a_caminho === null ? null : Number(row.snapshot_estoque_a_caminho),
      venda7d: row.snapshot_venda_7d === null ? null : Number(row.snapshot_venda_7d),
      venda14d: row.snapshot_venda_14d === null ? null : Number(row.snapshot_venda_14d),
      venda30d: row.snapshot_venda_30d === null ? null : Number(row.snapshot_venda_30d),
      mediaDiariaProjetada: row.snapshot_media_dia_projetada === null ? null : Number(row.snapshot_media_dia_projetada),
      acelerando: row.snapshot_acelerando,
      diasCobertura: row.snapshot_dias_cobertura === null ? null : Number(row.snapshot_dias_cobertura),
      dataRupturaPrevista: row.snapshot_data_ruptura_prevista,
      prazoFornecedorDias: row.snapshot_prazo_fornecedor_dias,
      estoqueSegurancaDias: row.snapshot_estoque_seguranca_dias,
      custoUnitario: row.snapshot_custo_unitario === null ? null : Number(row.snapshot_custo_unitario),
    },
    quantidadeSugeridaIa: Number(row.quantidade_sugerida_ia),
    valorEstimadoIa: row.valor_estimado_ia === null ? null : Number(row.valor_estimado_ia),
    fornecedorSugeridoId: row.fornecedor_sugerido_id,
    fornecedorSugeridoNome: row.fornecedor_nome || null,
    prazoFornecedorSugeridoDias: row.fornecedor_prazo_entrega_dias === undefined ? null : row.fornecedor_prazo_entrega_dias,
    quantidadeDecidida: row.quantidade_decidida === null ? null : Number(row.quantidade_decidida),
    statusDecisao: row.status_decisao,
    decididoEm: row.decidido_em,
    decididoPor: row.decidido_por,
    relatorioDiagnosticoTexto: row.relatorio_diagnostico_texto || null,
    relatorioDiagnosticoIa: row.relatorio_diagnostico_ia || null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

// GET /api/compras-ia/decisoes?empresaId=&status=pendente|aprovada|alterada|ignorada|expirada|decidida|todas
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
      `SELECT d.*, f.razao_social AS fornecedor_nome, f.prazo_entrega_dias AS fornecedor_prazo_entrega_dias
         FROM ia_decisoes_compras d
         LEFT JOIN fornecedores f ON f.id = d.fornecedor_sugerido_id
        WHERE d.empresa_id = $1 ${filtroStatus}
        ORDER BY (d.status_decisao = 'pendente') DESC, d.atualizado_em DESC
        LIMIT 300`,
      params
    );
    res.json({ decisoes: rows.map(linhaDecisaoParaApi) });
  } catch (err) { next(err); }
});

// POST /api/compras-ia/gerar-agora { empresaId } — roda o ciclo na hora.
router.post('/gerar-agora', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await executarCicloComprasIaEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

async function gerarNumeroPedido(client) {
  const { rows } = await client.query("SELECT nextval('compras_ia_pedido_numero_seq') AS n");
  return 'PC-' + String(rows[0].n).padStart(6, '0');
}

// PUT /api/compras-ia/decisoes/:id
// { statusDecisao: 'aprovada'|'alterada'|'ignorada', quantidadeDecidida?, fornecedorId?, custoUnitario?, previsaoChegada?, decididoPor? }
// 'aprovada'/'alterada' criam o pedido de compra (compras_ia_pedidos) —
// pedido explícito do usuário: "Depois que eu aprovar, o sistema deve
// montar o pedido pronto para envio ao fornecedor." Nunca envia nada
// sozinho — o pedido nasce em status 'aprovado', o envio ao fornecedor é
// uma ação separada e manual do usuário (botões "Copiar pedido"/"Gerar
// PDF"/link para WhatsApp ou e-mail do fornecedor, ver front-end).
router.put('/decisoes/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { statusDecisao, quantidadeDecidida, fornecedorId, custoUnitario, previsaoChegada, decididoPor } = req.body || {};
    if (!['aprovada', 'alterada', 'ignorada'].includes(statusDecisao)) {
      return res.status(400).json({ error: 'statusDecisao inválido — use aprovada, alterada ou ignorada.' });
    }

    await client.query('BEGIN');
    const { rows: decisaoRows } = await client.query(
      `SELECT * FROM ia_decisoes_compras WHERE id = $1 AND status_decisao = 'pendente' FOR UPDATE`,
      [id]
    );
    if (!decisaoRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recomendação não encontrada, ou já foi decidida antes.' });
    }
    const decisao = decisaoRows[0];

    const quantidadeFinal = (statusDecisao === 'alterada' && quantidadeDecidida !== undefined && quantidadeDecidida !== null)
      ? Number(quantidadeDecidida)
      : Number(decisao.quantidade_sugerida_ia);
    if (statusDecisao !== 'ignorada' && (!Number.isFinite(quantidadeFinal) || quantidadeFinal <= 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: { quantidadeDecidida: 'Informe uma quantidade válida, maior que zero.' } });
    }

    let pedido = null;
    if (statusDecisao === 'aprovada' || statusDecisao === 'alterada') {
      const fornecedorFinalId = fornecedorId ? Number(fornecedorId) : decisao.fornecedor_sugerido_id;
      if (!fornecedorFinalId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ errors: { fornecedorId: 'Este modelo não tem fornecedor padrão cadastrado — informe o fornecedor para aprovar a compra.' } });
      }
      const { rows: fornRows } = await client.query('SELECT id, razao_social FROM fornecedores WHERE id = $1', [fornecedorFinalId]);
      if (!fornRows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ errors: { fornecedorId: 'Fornecedor não encontrado.' } });
      }

      const custoFinal = (custoUnitario !== undefined && custoUnitario !== null && custoUnitario !== '')
        ? Number(custoUnitario)
        : Number(decisao.snapshot_custo_unitario || 0);
      if (!Number.isFinite(custoFinal) || custoFinal < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ errors: { custoUnitario: 'Informe um custo unitário válido — este modelo ainda não tem custo cadastrado.' } });
      }

      const numeroPedido = await gerarNumeroPedido(client);
      const valorTotal = round2(quantidadeFinal * custoFinal);
      // Sem data informada pelo usuário, sugere hoje + prazo do fornecedor
      // (o mesmo prazo usado no cálculo da recomendação) — só quando esse
      // prazo é conhecido; nunca inventa uma data sem base nenhuma.
      let previsaoChegadaFinal = previsaoChegada || null;
      if (!previsaoChegadaFinal && decisao.snapshot_prazo_fornecedor_dias !== null && decisao.snapshot_prazo_fornecedor_dias !== undefined) {
        const d = new Date();
        d.setDate(d.getDate() + Number(decisao.snapshot_prazo_fornecedor_dias));
        previsaoChegadaFinal = d.toISOString().slice(0, 10);
      }
      const { rows: pedidoRows } = await client.query(
        `INSERT INTO compras_ia_pedidos (
           empresa_id, numero_pedido, fornecedor_id, produto_base_id, recomendacao_id, origem,
           quantidade, custo_unitario, valor_total, status, previsao_chegada
         ) VALUES ($1,$2,$3,$4,$5,'recomendacao_ia',$6,$7,$8,'aprovado',$9)
         RETURNING *`,
        [
          decisao.empresa_id, numeroPedido, fornecedorFinalId, decisao.produto_base_id, decisao.id,
          quantidadeFinal, custoFinal, valorTotal,
          previsaoChegadaFinal,
        ]
      );
      pedido = pedidoRows[0];
    }

    await client.query(
      `UPDATE ia_decisoes_compras
          SET status_decisao = $1, quantidade_decidida = $2, decidido_em = now(), decidido_por = $3, atualizado_em = now()
        WHERE id = $4`,
      [statusDecisao, statusDecisao === 'ignorada' ? null : quantidadeFinal, decididoPor || null, id]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      pedido: pedido ? {
        id: pedido.id,
        numeroPedido: pedido.numero_pedido,
        fornecedorId: pedido.fornecedor_id,
        produtoBaseId: pedido.produto_base_id,
        quantidade: Number(pedido.quantidade),
        custoUnitario: Number(pedido.custo_unitario),
        valorTotal: Number(pedido.valor_total),
        status: pedido.status,
        previsaoChegada: pedido.previsao_chegada,
      } : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

function serializePedido(row) {
  return {
    id: row.id,
    numeroPedido: row.numero_pedido,
    fornecedorId: row.fornecedor_id,
    fornecedorNome: row.fornecedor_razao_social,
    fornecedorTelefone: row.fornecedor_telefone,
    fornecedorEmail: row.fornecedor_email,
    produtoBaseId: row.produto_base_id,
    produtoBaseCodigo: row.produto_base_codigo,
    produtoBaseNome: row.produto_base_nome,
    origem: row.origem,
    quantidade: Number(row.quantidade),
    custoUnitario: Number(row.custo_unitario),
    valorTotal: Number(row.valor_total),
    status: row.status,
    previsaoChegada: row.previsao_chegada,
    recebidoEm: row.recebido_em,
    observacao: row.observacao,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

const STATUS_PEDIDO_VALIDOS = ['aprovado', 'pedido_enviado', 'em_producao', 'a_caminho', 'recebido', 'cancelado'];

// GET /api/compras-ia/pedidos?empresaId=&status= — histórico.
router.get('/pedidos', async (req, res, next) => {
  try {
    const { empresaId, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtro = '';
    if (status && STATUS_PEDIDO_VALIDOS.includes(status)) { params.push(status); filtro = ' AND cp.status = $2'; }

    const { rows } = await pool.query(
      `SELECT cp.*, f.razao_social AS fornecedor_razao_social, f.telefone AS fornecedor_telefone, f.email AS fornecedor_email,
              pb.codigo AS produto_base_codigo, pb.nome AS produto_base_nome
         FROM compras_ia_pedidos cp
         JOIN fornecedores f ON f.id = cp.fornecedor_id
         JOIN produtos_base pb ON pb.id = cp.produto_base_id
        WHERE cp.empresa_id = $1 ${filtro}
        ORDER BY cp.created_at DESC
        LIMIT 500`,
      params
    );
    res.json({ pedidos: rows.map(serializePedido) });
  } catch (err) { next(err); }
});

// PATCH /api/compras-ia/pedidos/:id/status { status }
router.patch('/pedidos/:id/status', async (req, res, next) => {
  try {
    const status = String((req.body || {}).status || '');
    if (!STATUS_PEDIDO_VALIDOS.includes(status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    const recebidoEmSql = status === 'recebido' ? ', recebido_em = now()' : '';
    const { rows } = await pool.query(
      `UPDATE compras_ia_pedidos SET status = $1, updated_at = now() ${recebidoEmSql} WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const { rows: completo } = await pool.query(
      `SELECT cp.*, f.razao_social AS fornecedor_razao_social, f.telefone AS fornecedor_telefone, f.email AS fornecedor_email,
              pb.codigo AS produto_base_codigo, pb.nome AS produto_base_nome
         FROM compras_ia_pedidos cp
         JOIN fornecedores f ON f.id = cp.fornecedor_id
         JOIN produtos_base pb ON pb.id = cp.produto_base_id
        WHERE cp.id = $1`,
      [req.params.id]
    );
    res.json({ pedido: serializePedido(completo[0]) });
  } catch (err) { next(err); }
});

// GET /api/compras-ia/desempenho?empresaId= — contagens reais (nunca uma
// "IA que aprende" de verdade nesta etapa — só estatística honesta do que
// já aconteceu, ver docs/02-decisoes.md sobre essa escolha).
router.get('/desempenho', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows: contagens } = await pool.query(
      `SELECT status_decisao, COUNT(*) AS n FROM ia_decisoes_compras WHERE empresa_id = $1 GROUP BY status_decisao`,
      [empresaId]
    );
    const porStatus = Object.fromEntries(contagens.map((r) => [r.status_decisao, Number(r.n)]));
    const recomendadas = Object.values(porStatus).reduce((s, n) => s + n, 0);
    const aprovadas = (porStatus.aprovada || 0) + (porStatus.alterada || 0);
    const ignoradas = porStatus.ignorada || 0;

    // "Ruptura evitada": pedido aprovado a partir de uma recomendação com
    // urgência ruptura/comprar_agora, já recebido, cujo estoque no momento
    // do recebimento ainda não tinha zerado (aproximação honesta — não há
    // histórico dia a dia de estoque neste sistema pra confirmar o dia
    // exato, então conta pedidos recebidos ANTES da data prevista de
    // ruptura salva na recomendação original).
    const { rows: rupturaRows } = await pool.query(
      `SELECT COUNT(*) AS n
         FROM compras_ia_pedidos cp
         JOIN ia_decisoes_compras d ON d.id = cp.recomendacao_id
        WHERE cp.empresa_id = $1 AND cp.status = 'recebido'
          AND d.status_urgencia IN ('ruptura','comprar_agora')
          AND (d.snapshot_data_ruptura_prevista IS NULL OR cp.recebido_em::date <= d.snapshot_data_ruptura_prevista)`,
      [empresaId]
    );
    const rupturasEvitadas = Number(rupturaRows[0].n);

    const { rows: excessoRows } = await pool.query(
      `SELECT COALESCE(SUM(valor_total),0) AS v FROM compras_ia_pedidos
        WHERE empresa_id = $1 AND status <> 'cancelado' AND origem = 'recomendacao_ia'`,
      [empresaId]
    );

    res.json({
      comprasRecomendadas: recomendadas,
      aprovadas,
      ignoradas,
      rupturasEvitadas,
      valorTotalComprasViaIa: Number(excessoRows[0].v),
    });
  } catch (err) { next(err); }
});

// PATCH /api/compras-ia/produtos-base/:id/config
// { fornecedorPadraoId?, estoqueSegurancaDias?, prazoEntregaDiasFornecedor? }
// Config mínima necessária pra IA calcular direito, editável direto pela
// tela de Compras com IA (sem precisar abrir Produtos/Fornecedores) —
// pedido implícito: o usuário vai descobrir que falta essa config
// justamente ao ver a recomendação, então o ajuste fica ali mesmo.
router.patch('/produtos-base/:id/config', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { fornecedorPadraoId, estoqueSegurancaDias, prazoEntregaDiasFornecedor } = req.body || {};
    await client.query('BEGIN');

    if (fornecedorPadraoId !== undefined) {
      const valor = fornecedorPadraoId === null || fornecedorPadraoId === '' ? null : Number(fornecedorPadraoId);
      await client.query('UPDATE produtos_base SET fornecedor_padrao_id = $1, updated_at = now() WHERE id = $2', [valor, req.params.id]);
    }
    if (estoqueSegurancaDias !== undefined) {
      const valor = estoqueSegurancaDias === null || estoqueSegurancaDias === '' ? null : Number(estoqueSegurancaDias);
      if (valor !== null && (!Number.isInteger(valor) || valor < 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ errors: { estoqueSegurancaDias: 'Informe um número inteiro de dias, maior ou igual a zero.' } });
      }
      await client.query('UPDATE produtos_base SET estoque_seguranca_dias = $1, updated_at = now() WHERE id = $2', [valor, req.params.id]);
    }
    if (prazoEntregaDiasFornecedor !== undefined) {
      const { rows: pbRows } = await client.query('SELECT fornecedor_padrao_id FROM produtos_base WHERE id = $1', [req.params.id]);
      if (pbRows.length && pbRows[0].fornecedor_padrao_id) {
        const valor = prazoEntregaDiasFornecedor === null || prazoEntregaDiasFornecedor === '' ? null : Number(prazoEntregaDiasFornecedor);
        if (valor !== null && (!Number.isInteger(valor) || valor < 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ errors: { prazoEntregaDiasFornecedor: 'Informe um número inteiro de dias, maior ou igual a zero.' } });
        }
        await client.query('UPDATE fornecedores SET prazo_entrega_dias = $1, updated_at = now() WHERE id = $2', [valor, pbRows[0].fornecedor_padrao_id]);
      }
    }

    await client.query('COMMIT');
    const { rows } = await pool.query(
      `SELECT pb.id, pb.codigo, pb.nome, pb.fornecedor_padrao_id, pb.estoque_seguranca_dias,
              f.razao_social AS fornecedor_nome, f.prazo_entrega_dias
         FROM produtos_base pb LEFT JOIN fornecedores f ON f.id = pb.fornecedor_padrao_id
        WHERE pb.id = $1`,
      [req.params.id]
    );
    res.json({
      produtoBase: rows[0] ? {
        id: rows[0].id, codigo: rows[0].codigo, nome: rows[0].nome,
        fornecedorPadraoId: rows[0].fornecedor_padrao_id, fornecedorNome: rows[0].fornecedor_nome,
        estoqueSegurancaDias: rows[0].estoque_seguranca_dias,
        prazoEntregaDias: rows[0].prazo_entrega_dias,
      } : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
