// Agente de Envio Full — 23/09/2026, pedido explícito do usuário. O agente
// NUNCA envia nada sozinho — toda recomendação passa por aprovação humana
// aqui (PUT /decisoes/:id) antes de virar um registro de envio. Mesmo
// padrão de routes/comprasIa.js.
const express = require('express');
const pool = require('../db/pool');
const { montarLinhasParaEmpresa, executarCicloEnvioFullEmpresa } = require('../lib/ia/envioFullCiclo');
const { STATUS_LABEL } = require('../lib/ia/envioFullMotor');

const router = express.Router();

function round2(n) { return Math.round(n * 100) / 100; }

function linhaParaApi({ produtoBase, calc, motivo }) {
  return {
    produtoBaseId: produtoBase.id,
    codigo: produtoBase.codigo,
    nome: produtoBase.nome,
    estoqueGalpao: calc.estoqueGalpao,
    estoqueFull: calc.estoqueFull,
    venda7d: round2(calc.mediaDiaria7 * 7),
    mediaDiariaProjetada: calc.mediaDiariaProjetada,
    acelerando: calc.acelerando,
    desacelerando: calc.desacelerando,
    diasCoberturaFull: calc.diasCoberturaFull,
    dataRupturaFullPrevista: calc.dataRupturaFullPrevista,
    prazoEnvioFullDias: calc.prazoEnvioFullDias,
    estoqueSegurancaDias: calc.estoqueSegurancaDias,
    quantidadeSugeridaEnvio: calc.quantidadeSugeridaEnvio,
    semEstoqueGalpaoSuficiente: calc.semEstoqueGalpaoSuficiente,
    status: calc.status,
    statusEmoji: STATUS_LABEL[calc.status].emoji,
    statusLabel: STATUS_LABEL[calc.status].label,
    semHistoricoDeVendas: calc.semHistoricoDeVendas,
    motivo,
  };
}

// GET /api/envio-full/linhas?empresaId=ID — tabela principal (todos os
// modelos ativos, calculado ao vivo com o mesmo motor do ciclo automático).
router.get('/linhas', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const linhas = await montarLinhasParaEmpresa(Number(empresaId));
    res.json({ linhas: linhas.map(linhaParaApi) });
  } catch (err) { next(err); }
});

// GET /api/envio-full/resumo?empresaId=ID — cards do topo.
router.get('/resumo', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const linhas = await montarLinhasParaEmpresa(Number(empresaId));

    let enviarAgora = 0;
    let programar = 0;
    let segurar = 0; // saudável/atenção — sem necessidade de enviar agora
    let acabando = 0; // ruptura
    let semEstoqueGalpao = 0;

    linhas.forEach(({ calc }) => {
      if (calc.status === 'ruptura') acabando++;
      if (calc.status === 'ruptura' || calc.status === 'enviar_agora') enviarAgora++;
      else if (calc.status === 'programar_envio') programar++;
      else segurar++;
      if (calc.semEstoqueGalpaoSuficiente) semEstoqueGalpao++;
    });

    res.json({
      enviarAgora, programar, segurar, acabando, semEstoqueGalpao,
      totalModelos: linhas.length,
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
    semEstoqueGalpaoSuficiente: row.sem_estoque_galpao_suficiente,
    motivo: row.motivo,
    snapshot: {
      estoqueGalpao: row.snapshot_estoque_galpao === null ? null : Number(row.snapshot_estoque_galpao),
      estoqueFull: row.snapshot_estoque_full === null ? null : Number(row.snapshot_estoque_full),
      venda7d: row.snapshot_venda_7d === null ? null : Number(row.snapshot_venda_7d),
      venda14d: row.snapshot_venda_14d === null ? null : Number(row.snapshot_venda_14d),
      venda30d: row.snapshot_venda_30d === null ? null : Number(row.snapshot_venda_30d),
      mediaDiariaProjetada: row.snapshot_media_dia_projetada === null ? null : Number(row.snapshot_media_dia_projetada),
      acelerando: row.snapshot_acelerando,
      diasCoberturaFull: row.snapshot_dias_cobertura_full === null ? null : Number(row.snapshot_dias_cobertura_full),
      dataRupturaFullPrevista: row.snapshot_data_ruptura_full_prevista,
      prazoEnvioFullDias: row.snapshot_prazo_envio_full_dias,
      estoqueSegurancaDias: row.snapshot_estoque_seguranca_dias,
    },
    quantidadeSugeridaEnvio: Number(row.quantidade_sugerida_envio),
    quantidadeDecidida: row.quantidade_decidida === null ? null : Number(row.quantidade_decidida),
    statusDecisao: row.status_decisao,
    decididoEm: row.decidido_em,
    decididoPor: row.decidido_por,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

// GET /api/envio-full/decisoes?empresaId=&status=pendente|aprovada|alterada|ignorada|expirada|decidida|todas
router.get('/decisoes', async (req, res, next) => {
  try {
    const { empresaId, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtroStatus = '';
    if (status === 'decidida') {
      filtroStatus = " AND status_decisao <> 'pendente'";
    } else if (status && status !== 'todas') {
      params.push(status);
      filtroStatus = ' AND status_decisao = $2';
    }
    const { rows } = await pool.query(
      `SELECT * FROM ia_decisoes_envio_full
        WHERE empresa_id = $1 ${filtroStatus}
        ORDER BY (status_decisao = 'pendente') DESC, atualizado_em DESC
        LIMIT 300`,
      params
    );
    res.json({ decisoes: rows.map(linhaDecisaoParaApi) });
  } catch (err) { next(err); }
});

// POST /api/envio-full/gerar-agora { empresaId } — roda o ciclo na hora.
router.post('/gerar-agora', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await executarCicloEnvioFullEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

async function gerarNumeroEnvio(client) {
  const { rows } = await client.query("SELECT nextval('envio_full_pedido_numero_seq') AS n");
  return 'EF-' + String(rows[0].n).padStart(6, '0');
}

// PUT /api/envio-full/decisoes/:id
// { statusDecisao: 'aprovada'|'alterada'|'ignorada', quantidadeDecidida?, previsaoChegada?, decididoPor? }
// 'aprovada'/'alterada' criam o registro de envio (envio_full_pedidos).
// Nunca envia nada sozinho — o registro nasce em status 'aprovado', o
// envio físico ao Full é uma ação manual do usuário fora do sistema.
router.put('/decisoes/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { statusDecisao, quantidadeDecidida, previsaoChegada, decididoPor } = req.body || {};
    if (!['aprovada', 'alterada', 'ignorada'].includes(statusDecisao)) {
      return res.status(400).json({ error: 'statusDecisao inválido — use aprovada, alterada ou ignorada.' });
    }

    await client.query('BEGIN');
    const { rows: decisaoRows } = await client.query(
      `SELECT * FROM ia_decisoes_envio_full WHERE id = $1 AND status_decisao = 'pendente' FOR UPDATE`,
      [id]
    );
    if (!decisaoRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recomendação não encontrada, ou já foi decidida antes.' });
    }
    const decisao = decisaoRows[0];

    const quantidadeFinal = (statusDecisao === 'alterada' && quantidadeDecidida !== undefined && quantidadeDecidida !== null)
      ? Number(quantidadeDecidida)
      : Number(decisao.quantidade_sugerida_envio);
    if (statusDecisao !== 'ignorada' && (!Number.isFinite(quantidadeFinal) || quantidadeFinal <= 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: { quantidadeDecidida: 'Informe uma quantidade válida, maior que zero.' } });
    }

    let envio = null;
    if (statusDecisao === 'aprovada' || statusDecisao === 'alterada') {
      const numeroEnvio = await gerarNumeroEnvio(client);
      let previsaoChegadaFinal = previsaoChegada || null;
      if (!previsaoChegadaFinal && decisao.snapshot_prazo_envio_full_dias !== null && decisao.snapshot_prazo_envio_full_dias !== undefined) {
        const d = new Date();
        d.setDate(d.getDate() + Number(decisao.snapshot_prazo_envio_full_dias));
        previsaoChegadaFinal = d.toISOString().slice(0, 10);
      }
      const { rows: envioRows } = await client.query(
        `INSERT INTO envio_full_pedidos (
           empresa_id, numero_envio, produto_base_id, recomendacao_id, origem,
           quantidade, status, previsao_chegada
         ) VALUES ($1,$2,$3,$4,'recomendacao_ia',$5,'aprovado',$6)
         RETURNING *`,
        [decisao.empresa_id, numeroEnvio, decisao.produto_base_id, decisao.id, quantidadeFinal, previsaoChegadaFinal]
      );
      envio = envioRows[0];
    }

    await client.query(
      `UPDATE ia_decisoes_envio_full
          SET status_decisao = $1, quantidade_decidida = $2, decidido_em = now(), decidido_por = $3, atualizado_em = now()
        WHERE id = $4`,
      [statusDecisao, statusDecisao === 'ignorada' ? null : quantidadeFinal, decididoPor || null, id]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      envio: envio ? {
        id: envio.id,
        numeroEnvio: envio.numero_envio,
        produtoBaseId: envio.produto_base_id,
        quantidade: Number(envio.quantidade),
        status: envio.status,
        previsaoChegada: envio.previsao_chegada,
      } : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

function serializeEnvio(row) {
  return {
    id: row.id,
    numeroEnvio: row.numero_envio,
    produtoBaseId: row.produto_base_id,
    produtoBaseCodigo: row.produto_base_codigo,
    produtoBaseNome: row.produto_base_nome,
    origem: row.origem,
    quantidade: Number(row.quantidade),
    status: row.status,
    previsaoChegada: row.previsao_chegada,
    recebidoEm: row.recebido_em,
    observacao: row.observacao,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

const STATUS_ENVIO_VALIDOS = ['aprovado', 'enviado', 'recebido_no_full', 'cancelado'];

// GET /api/envio-full/pedidos?empresaId=&status= — histórico de envios.
router.get('/pedidos', async (req, res, next) => {
  try {
    const { empresaId, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const params = [empresaId];
    let filtro = '';
    if (status && STATUS_ENVIO_VALIDOS.includes(status)) { params.push(status); filtro = ' AND ep.status = $2'; }

    const { rows } = await pool.query(
      `SELECT ep.*, pb.codigo AS produto_base_codigo, pb.nome AS produto_base_nome
         FROM envio_full_pedidos ep
         JOIN produtos_base pb ON pb.id = ep.produto_base_id
        WHERE ep.empresa_id = $1 ${filtro}
        ORDER BY ep.created_at DESC
        LIMIT 500`,
      params
    );
    res.json({ pedidos: rows.map(serializeEnvio) });
  } catch (err) { next(err); }
});

// PATCH /api/envio-full/pedidos/:id/status { status }
router.patch('/pedidos/:id/status', async (req, res, next) => {
  try {
    const status = String((req.body || {}).status || '');
    if (!STATUS_ENVIO_VALIDOS.includes(status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    const recebidoEmSql = status === 'recebido_no_full' ? ', recebido_em = now()' : '';
    const { rows } = await pool.query(
      `UPDATE envio_full_pedidos SET status = $1, updated_at = now() ${recebidoEmSql} WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Envio não encontrado.' });

    const { rows: completo } = await pool.query(
      `SELECT ep.*, pb.codigo AS produto_base_codigo, pb.nome AS produto_base_nome
         FROM envio_full_pedidos ep
         JOIN produtos_base pb ON pb.id = ep.produto_base_id
        WHERE ep.id = $1`,
      [req.params.id]
    );
    res.json({ pedido: serializeEnvio(completo[0]) });
  } catch (err) { next(err); }
});

// PATCH /api/envio-full/produtos-base/:id/config
// { estoqueSegurancaDias?, prazoEnvioFullDias? } — config mínima editável
// direto na tela, mesmo padrão de PATCH /api/compras-ia/produtos-base/:id/config.
router.patch('/produtos-base/:id/config', async (req, res, next) => {
  try {
    const { estoqueSegurancaDias, prazoEnvioFullDias } = req.body || {};

    if (estoqueSegurancaDias !== undefined) {
      const valor = estoqueSegurancaDias === null || estoqueSegurancaDias === '' ? null : Number(estoqueSegurancaDias);
      if (valor !== null && (!Number.isInteger(valor) || valor < 0)) {
        return res.status(400).json({ errors: { estoqueSegurancaDias: 'Informe um número inteiro de dias, maior ou igual a zero.' } });
      }
      await pool.query('UPDATE produtos_base SET estoque_seguranca_dias = $1, updated_at = now() WHERE id = $2', [valor, req.params.id]);
    }
    if (prazoEnvioFullDias !== undefined) {
      const valor = prazoEnvioFullDias === null || prazoEnvioFullDias === '' ? null : Number(prazoEnvioFullDias);
      if (valor !== null && (!Number.isInteger(valor) || valor < 0)) {
        return res.status(400).json({ errors: { prazoEnvioFullDias: 'Informe um número inteiro de dias, maior ou igual a zero.' } });
      }
      await pool.query('UPDATE produtos_base SET prazo_envio_full_dias = $1, updated_at = now() WHERE id = $2', [valor, req.params.id]);
    }

    const { rows } = await pool.query(
      `SELECT id, codigo, nome, estoque_seguranca_dias, prazo_envio_full_dias FROM produtos_base WHERE id = $1`,
      [req.params.id]
    );
    res.json({
      produtoBase: rows[0] ? {
        id: rows[0].id, codigo: rows[0].codigo, nome: rows[0].nome,
        estoqueSegurancaDias: rows[0].estoque_seguranca_dias,
        prazoEnvioFullDias: rows[0].prazo_envio_full_dias,
      } : null,
    });
  } catch (err) { next(err); }
});

// ---- Custo mensal de envio Full (lançamento manual, ver comentário na
// tabela em db/schema.sql sobre por que não é automático ainda) ----

// GET /api/envio-full/custos?empresaId=&ano=&mes= — valor de um mês; sem
// ano/mes, devolve o mês atual.
router.get('/custos', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const agora = new Date();
    const ano = req.query.ano ? Number(req.query.ano) : agora.getFullYear();
    const mes = req.query.mes ? Number(req.query.mes) : (agora.getMonth() + 1);

    const { rows } = await pool.query(
      `SELECT * FROM envio_full_custos_mensais WHERE empresa_id = $1 AND ano = $2 AND mes = $3`,
      [empresaId, ano, mes]
    );
    res.json({
      ano, mes,
      valor: rows.length ? Number(rows[0].valor) : null,
      observacao: rows.length ? rows[0].observacao : null,
      lancadoPor: rows.length ? rows[0].lancado_por : null,
      atualizadoEm: rows.length ? rows[0].updated_at : null,
    });
  } catch (err) { next(err); }
});

// GET /api/envio-full/custos/historico?empresaId=&limite= — últimos meses
// lançados, pra tela mostrar um histórico simples.
router.get('/custos/historico', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const limite = Math.min(Number(req.query.limite) || 12, 60);
    const { rows } = await pool.query(
      `SELECT ano, mes, valor, observacao, lancado_por, updated_at
         FROM envio_full_custos_mensais
        WHERE empresa_id = $1
        ORDER BY ano DESC, mes DESC
        LIMIT $2`,
      [empresaId, limite]
    );
    res.json({ historico: rows.map((r) => ({ ano: r.ano, mes: r.mes, valor: Number(r.valor), observacao: r.observacao, lancadoPor: r.lancado_por, atualizadoEm: r.updated_at })) });
  } catch (err) { next(err); }
});

// PUT /api/envio-full/custos { empresaId, ano, mes, valor, observacao?, lancadoPor? }
// Upsert — um único valor por (empresa, ano, mês), sempre o mais recente
// lançado à mão pelo usuário (nunca somado/acumulado sozinho).
router.put('/custos', async (req, res, next) => {
  try {
    const { empresaId, ano, mes, valor, observacao, lancadoPor } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const anoNum = Number(ano);
    const mesNum = Number(mes);
    const valorNum = Number(valor);
    if (!Number.isInteger(anoNum) || anoNum < 2000) {
      return res.status(400).json({ errors: { ano: 'Informe um ano válido.' } });
    }
    if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
      return res.status(400).json({ errors: { mes: 'Informe um mês entre 1 e 12.' } });
    }
    if (!Number.isFinite(valorNum) || valorNum < 0) {
      return res.status(400).json({ errors: { valor: 'Informe um valor válido, maior ou igual a zero.' } });
    }

    const { rows } = await pool.query(
      `INSERT INTO envio_full_custos_mensais (empresa_id, ano, mes, valor, observacao, lancado_por)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (empresa_id, ano, mes) DO UPDATE
         SET valor = EXCLUDED.valor, observacao = EXCLUDED.observacao, lancado_por = EXCLUDED.lancado_por, updated_at = now()
       RETURNING *`,
      [empresaId, anoNum, mesNum, valorNum, observacao || null, lancadoPor || null]
    );
    const row = rows[0];
    res.json({ ano: row.ano, mes: row.mes, valor: Number(row.valor), observacao: row.observacao, lancadoPor: row.lancado_por, atualizadoEm: row.updated_at });
  } catch (err) { next(err); }
});

module.exports = router;
