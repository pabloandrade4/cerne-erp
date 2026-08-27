// Recebimentos de marketplace — reescrito na tarefa "Recebimentos + Fluxo
// de Caixa + IA Gestora" (27/08/2026, ver docs/02-decisoes.md, Passo 1).
//
// ANTES (24/08/2026): lista calculada só na hora, sem tabela própria —
// nunca guardava estado nenhum (ver histórico em db/schema.sql, acima da
// tabela nova). AGORA: os recebimentos são PERSISTIDOS em
// `recebimentos_marketplace`, porque a conciliação bancária (Passo 2,
// lib/conciliacaoBancaria.js) precisa de uma linha de verdade pra apontar
// e atualizar de status — "A RECEBER" só vira "RECEBIDO" quando alguma
// fonte real confirma (extrato bancário ou uma confirmação manual
// explícita), nunca porque o marketplace marcou como liberado.
//
// NENHUMA fórmula financeira nova: valor bruto/taxas/líquido esperado
// continuam vindo exatamente do mesmo cálculo de sempre
// (lib/relatorioVendas.js#buscarPedidosDoPeriodo/serializePedido) — este
// arquivo só MATERIALIZA (upsert) esses números numa tabela e organiza os
// status. `materializarRecebimentos` nunca sobrescreve status/datas
// efetivas/valor recebido — só os campos recalculados a partir do pedido
// (valor bruto, taxas, líquido esperado, loja, pack_id) — uma vez
// conciliado, materializar de novo nunca desfaz a conciliação.
//
// STATUS FINANCEIROS (pedido explícito do usuário — nunca confundidos):
//   a_receber  — venda já realizada, dinheiro ainda não disponível.
//   disponivel — marketplace já liberou o dinheiro, mas isso ainda não
//                significa necessariamente que foi confirmado no banco.
//   recebido   — valor efetivamente identificado no extrato bancário
//                (conciliação, ver lib/conciliacaoBancaria.js) OU
//                confirmado manualmente pelo usuário nesta tela.
//
// PREMISSA registrada, não um fato (ver docs/05-problemas-conhecidos.md):
// o Mercado Livre não retorna, nos dados de pedido/pagamento que esta
// integração já busca (order.payments[]), nenhum campo de liberação/
// repasse (confirmado lendo o payload real de produção em 24/08/2026) —
// por isso `dataPrevistaLiberacao` sempre nasce `null` pra cada recebimento
// novo, nunca uma data inventada. O usuário pode informá-la manualmente
// (quando souber pelo próprio painel do marketplace) via
// `definirPrevisaoLiberacao` — só assim os recortes "a receber nos
// próximos 7/15/30 dias" conseguem classificar aquele recebimento; sem
// isso, ele aparece separadamente em "sem previsão de liberação
// informada" (nunca soma escondido dentro de um recorte de dias).
const pool = require('../db/pool');
const { buscarPedidosDoPeriodo } = require('./relatorioVendas');
const { diaBRT, inicioDoDiaBRTDeString } = require('./periodo');
const { round2 } = require('./resultadoVenda');

const STATUS_PAGAMENTO_APROVADO = 'approved';
const MARKETPLACE_ML = 'Mercado Livre';
const STATUS_VALIDOS = ['a_receber', 'disponivel', 'recebido'];

// Janela de materialização: os pedidos elegíveis dos últimos N dias são
// sempre revistos/atualizados a cada consulta (upsert idempotente — nunca
// duplica, ver UNIQUE em db/schema.sql). Cobre folgadamente os recortes
// pedidos (hoje/mês/7/15/30 dias) sem precisar varrer o histórico inteiro
// da conta a cada requisição. Documentado como decisão deliberada de
// escopo (não uma sincronização "pra sempre" como Estoque).
const JANELA_MATERIALIZACAO_DIAS = 400;

function elegivel(pedido) {
  return !pedido.cancelado && pedido.pagamentoStatus === STATUS_PAGAMENTO_APROVADO;
}

// taxasDescontos = comissão do ML + frete cobrado do vendedor + desconto de
// cupom — os três descontos que o PRÓPRIO marketplace aplica antes de
// repassar. NUNCA inclui imposto nem custo do produto (isso não é
// descontado pelo Mercado Livre, é responsabilidade do vendedor depois) —
// mesma regra de sempre, só movida pra cá sem alteração.
function calcularValores(p) {
  const taxasDescontos = (p.tarifasMl === null || p.freteVendedor === null)
    ? null
    : round2(p.tarifasMl + p.freteVendedor + p.desconto);
  const valorLiquidoEsperado = (p.valorTotal === null || taxasDescontos === null)
    ? null
    : round2(p.valorTotal - taxasDescontos);
  return { taxasDescontos, valorLiquidoEsperado };
}

// ---- Função PURA legada, preservada por compatibilidade ----
// lib/visaoGeralPainel.js#resumoRecebimentos (usada pelo card "Fluxo de
// Caixa" de Visão Geral E pelas ferramentas JÁ VALIDADAS da IA Gestora
// handleContasAReceber/handleFluxoDeCaixa, em lib/ia/ferramentas.js) ainda
// chama `pedidos.filter(elegivel).map(serializeRecebimento)` — um cálculo
// simples, sem tocar o banco, só a partir da lista de pedidos que a própria
// chamada já tinha em mãos. Preservada INTOCADA (mesmo formato de sempre,
// nunca lida com status persistido) pra não alterar nenhuma regra
// financeira já validada nem re-testar módulos fora do escopo desta
// tarefa — a nova capacidade (Passo 1) vive só nas funções novas abaixo,
// que leem a tabela persistida `recebimentos_marketplace`.
function serializeRecebimento(p) {
  const taxasDescontos = (p.tarifasMl === null || p.freteVendedor === null)
    ? null
    : round2(p.tarifasMl + p.freteVendedor + p.desconto);
  const valorLiquidoEsperado = (p.valorTotal === null || taxasDescontos === null)
    ? null
    : round2(p.valorTotal - taxasDescontos);

  return {
    marketplace: MARKETPLACE_ML,
    loja: p.loja,
    pedidoRef: p.mlOrderId,
    dataVenda: p.dataEfetiva,
    valorBruto: p.valorTotal,
    taxasDescontos,
    valorLiquidoEsperado,
    dataPrevistaLiberacao: null,
    valorRecebido: null,
    dataRecebimento: null,
    status: 'a_receber',
  };
}

function somarDiasData(dataStr, dias) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

function serialize(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    marketplace: row.marketplace,
    loja: row.loja,
    referenciaExterna: row.referencia_externa,
    pedidoRef: row.referencia_externa, // nome antigo mantido — mesma tela/coluna de sempre
    packId: row.pack_id,
    dataVenda: row.data_venda,
    valorBruto: row.valor_bruto === null ? null : Number(row.valor_bruto),
    taxasDescontos: row.taxas_descontos === null ? null : Number(row.taxas_descontos),
    valorLiquidoEsperado: row.valor_liquido_esperado === null ? null : Number(row.valor_liquido_esperado),
    dataPrevistaLiberacao: row.data_prevista_liberacao ? String(row.data_prevista_liberacao).slice(0, 10) : null,
    dataEfetivaLiberacao: row.data_efetiva_liberacao ? String(row.data_efetiva_liberacao).slice(0, 10) : null,
    valorRecebido: row.valor_recebido === null ? null : Number(row.valor_recebido),
    dataRecebimento: row.data_efetiva_recebimento ? String(row.data_efetiva_recebimento).slice(0, 10) : null,
    status: row.status,
    origemConfirmacao: row.origem_confirmacao,
  };
}

// Materializa (upsert) os recebimentos elegíveis da janela em
// recebimentos_marketplace. Mesmo espírito de "sincronização" das outras
// telas (Estoque etc.), só que feito NA LEITURA em vez de um ciclo próprio
// em segundo plano — não existe uma segunda chamada de API aqui: os
// pedidos já estão sincronizados em ml_pedidos (lib/mlSync.js, inalterado),
// isto só reorganiza o que já existe.
async function materializarRecebimentos(empresaId) {
  const hoje = diaBRT(new Date());
  const desdeStr = somarDiasData(hoje, -JANELA_MATERIALIZACAO_DIAS);
  const desde = inicioDoDiaBRTDeString(desdeStr);
  const ate = inicioDoDiaBRTDeString(somarDiasData(hoje, 1));

  const { pedidos } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const elegiveis = pedidos.filter(elegivel);
  if (!elegiveis.length) return;

  // pack_id (ml_pedidos.pack_id — "conjunto de pedidos relacionado", pedido
  // explícito do usuário no Passo 1) não é exposto por
  // buscarPedidosDoPeriodo (campo não usado em nenhum outro lugar do
  // sistema) — busca direta e pontual, só pelos ml_order_id já elegíveis,
  // sem tocar nem duplicar lib/relatorioVendas.js.
  const orderIds = elegiveis.map((p) => p.mlOrderId);
  const { rows: pedidoRows } = await pool.query(
    `SELECT ml_order_id, pack_id, id FROM ml_pedidos WHERE ml_order_id = ANY($1::bigint[])`,
    [orderIds]
  );
  const infoPorOrderId = new Map(pedidoRows.map((r) => [String(r.ml_order_id), { packId: r.pack_id ? String(r.pack_id) : null, pedidoId: r.id }]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of elegiveis) {
      const { taxasDescontos, valorLiquidoEsperado } = calcularValores(p);
      const extra = infoPorOrderId.get(p.mlOrderId) || {};
      await client.query(
        `INSERT INTO recebimentos_marketplace
           (empresa_id, marketplace, loja, conta_ml_id, pedido_id, referencia_externa, pack_id,
            data_venda, valor_bruto, taxas_descontos, valor_liquido_esperado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (empresa_id, marketplace, referencia_externa) DO UPDATE SET
           loja = EXCLUDED.loja,
           conta_ml_id = EXCLUDED.conta_ml_id,
           pedido_id = EXCLUDED.pedido_id,
           pack_id = EXCLUDED.pack_id,
           data_venda = EXCLUDED.data_venda,
           valor_bruto = EXCLUDED.valor_bruto,
           taxas_descontos = EXCLUDED.taxas_descontos,
           valor_liquido_esperado = EXCLUDED.valor_liquido_esperado,
           updated_at = now()`,
        [
          empresaId, MARKETPLACE_ML, p.loja, p.contaMlId, extra.pedidoId || null, p.mlOrderId, extra.packId || null,
          p.dataEfetiva, p.valorTotal, taxasDescontos, valorLiquidoEsperado,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Lista filtrada por período de VENDA (data_venda) — mesma tela de sempre,
// agora lendo a tabela persistida (materializa antes, pra nunca mostrar
// dado desatualizado).
async function listarRecebimentosMl({ empresaId, desde, ate }) {
  await materializarRecebimentos(empresaId);
  const { rows } = await pool.query(
    `SELECT * FROM recebimentos_marketplace
     WHERE empresa_id = $1 AND data_venda >= $2 AND data_venda < $3
     ORDER BY data_venda DESC NULLS LAST`,
    [empresaId, desde, ate]
  );
  return rows.map(serialize);
}

// Recebimentos MARCADOS COMO RECEBIDOS dentro de [desde, ate], filtrando
// pela data EFETIVA de recebimento (não pela data da venda) — usado pelo
// Fluxo de Caixa (lib/fluxoCaixa.js) pra jogar esses valores no bucket
// REALIZADO do período certo, exatamente como já é feito com
// contas_receber (status='recebido' AND data_recebida BETWEEN). Sem isso,
// gerarFluxoDeCaixa somava TODO recebimento (de qualquer status) do
// período de VENDA como "previsto" — contando de novo um valor que já
// virou "recebido" (double count previsto+realizado, proibido pelo
// pedido do usuário). `desde`/`ate` aqui são strings 'YYYY-MM-DD'
// (data_efetiva_recebimento é DATE, não TIMESTAMPTZ).
async function listarRecebimentosMlRecebidosNoPeriodo({ empresaId, desde, ate }) {
  await materializarRecebimentos(empresaId);
  const { rows } = await pool.query(
    `SELECT * FROM recebimentos_marketplace
     WHERE empresa_id = $1 AND status = 'recebido'
       AND data_efetiva_recebimento BETWEEN $2 AND $3`,
    [empresaId, desde, ate]
  );
  return rows.map(serialize);
}

// Resumo SEMPRE atual (independe do período do header) — mesma decisão já
// tomada em contas_a_pagar/contas_a_receber: "recebido hoje/mês" olham a
// data efetiva real; "a receber" é o saldo em aberto agora. Também usado
// pela IA Gestora (lib/ia/ferramentas.js).
async function resumoRecebimentosMarketplace(empresaId) {
  await materializarRecebimentos(empresaId);
  const hoje = diaBRT(new Date());
  const mesAtual = hoje.slice(0, 7);
  const limite7 = somarDiasData(hoje, 7);
  const limite15 = somarDiasData(hoje, 15);
  const limite30 = somarDiasData(hoje, 30);

  const { rows } = await pool.query(
    `SELECT marketplace, loja, status, valor_liquido_esperado, valor_recebido,
            data_prevista_liberacao::text AS data_prevista_liberacao,
            data_efetiva_recebimento::text AS data_efetiva_recebimento
     FROM recebimentos_marketplace WHERE empresa_id = $1`,
    [empresaId]
  );

  let recebidoHoje = 0, recebidoMes = 0;
  let aReceberTotal = 0, aReceberSemValorCalculavel = 0;
  let aReceberAtrasado = 0, aReceber7 = 0, aReceber15 = 0, aReceber30 = 0;
  let semPrevisaoQtd = 0, semPrevisaoValor = 0;
  const porMarketplace = new Map();
  const porLoja = new Map();

  function acumular(mapa, chave, campo, valor) {
    if (!chave) return;
    if (!mapa.has(chave)) mapa.set(chave, { recebido: 0, aReceber: 0 });
    mapa.get(chave)[campo] = round2(mapa.get(chave)[campo] + valor);
  }

  for (const r of rows) {
    if (r.status === 'recebido') {
      const v = r.valor_recebido !== null ? Number(r.valor_recebido) : 0;
      if (r.data_efetiva_recebimento === hoje) recebidoHoje = round2(recebidoHoje + v);
      if (r.data_efetiva_recebimento && r.data_efetiva_recebimento.slice(0, 7) === mesAtual) recebidoMes = round2(recebidoMes + v);
      acumular(porMarketplace, r.marketplace, 'recebido', v);
      acumular(porLoja, r.loja, 'recebido', v);
      continue;
    }
    // a_receber ou disponivel — ainda não é dinheiro confirmado no banco.
    if (r.valor_liquido_esperado === null) { aReceberSemValorCalculavel++; continue; }
    const v = Number(r.valor_liquido_esperado);
    aReceberTotal = round2(aReceberTotal + v);
    acumular(porMarketplace, r.marketplace, 'aReceber', v);
    acumular(porLoja, r.loja, 'aReceber', v);

    if (!r.data_prevista_liberacao) { semPrevisaoQtd++; semPrevisaoValor = round2(semPrevisaoValor + v); continue; }
    if (r.data_prevista_liberacao < hoje) { aReceberAtrasado = round2(aReceberAtrasado + v); continue; }
    if (r.data_prevista_liberacao <= limite7) aReceber7 = round2(aReceber7 + v);
    if (r.data_prevista_liberacao <= limite15) aReceber15 = round2(aReceber15 + v);
    if (r.data_prevista_liberacao <= limite30) aReceber30 = round2(aReceber30 + v);
  }

  return {
    recebidoHoje: round2(recebidoHoje),
    recebidoMes: round2(recebidoMes),
    aReceberTotal: round2(aReceberTotal),
    aReceberSemValorCalculavel,
    aReceberAtrasado: round2(aReceberAtrasado),
    aReceberProximos7Dias: round2(aReceber7),
    aReceberProximos15Dias: round2(aReceber15),
    aReceberProximos30Dias: round2(aReceber30),
    aReceberSemPrevisaoDeLiberacao: { quantidade: semPrevisaoQtd, valor: round2(semPrevisaoValor) },
    porMarketplace: [...porMarketplace.entries()].map(([marketplace, v]) => ({ marketplace, recebido: v.recebido, aReceber: v.aReceber })).sort((a, b) => b.aReceber - a.aReceber),
    porLoja: [...porLoja.entries()].map(([loja, v]) => ({ loja, recebido: v.recebido, aReceber: v.aReceber })).sort((a, b) => b.aReceber - a.aReceber),
  };
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM recebimentos_marketplace WHERE id = $1', [id]);
  return rows[0] || null;
}

// ---- Ações manuais (mesma disciplina de contas_receber/contas_pagar:
// nunca anda pra trás, nunca sobrescreve um estado já mais avançado) ----

async function marcarComoDisponivel(id, { dataEfetivaLiberacao } = {}) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status !== 'a_receber') return { errors: { geral: 'Só é possível marcar como disponível um recebimento que ainda está "a receber".' } };
  const data = /^\d{4}-\d{2}-\d{2}$/.test(dataEfetivaLiberacao || '') ? dataEfetivaLiberacao : diaBRT(new Date());
  const { rows } = await pool.query(
    `UPDATE recebimentos_marketplace SET status='disponivel', data_efetiva_liberacao=$1, origem_confirmacao='manual', updated_at=now() WHERE id=$2 RETURNING *`,
    [data, id]
  );
  return { recebimento: serialize(rows[0]) };
}

async function marcarComoRecebido(id, { dataEfetivaRecebimento, valorRecebido } = {}) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'recebido') return { errors: { geral: 'Este recebimento já está marcado como recebido.' } };
  const data = /^\d{4}-\d{2}-\d{2}$/.test(dataEfetivaRecebimento || '') ? dataEfetivaRecebimento : diaBRT(new Date());
  const valor = Number.isFinite(Number(valorRecebido)) ? round2(Number(valorRecebido)) : (atual.valor_liquido_esperado === null ? null : Number(atual.valor_liquido_esperado));
  if (valor === null) return { errors: { valorRecebido: 'Informe o valor recebido — este recebimento não tem um valor líquido esperado calculado.' } };
  const { rows } = await pool.query(
    `UPDATE recebimentos_marketplace SET status='recebido', valor_recebido=$1, data_efetiva_recebimento=$2, origem_confirmacao='manual', updated_at=now() WHERE id=$3 RETURNING *`,
    [valor, data, id]
  );
  return { recebimento: serialize(rows[0]) };
}

async function definirPrevisaoLiberacao(id, dataPrevistaLiberacao) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'recebido') return { errors: { geral: 'Este recebimento já foi recebido — não faz sentido informar previsão de liberação.' } };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPrevistaLiberacao || '')) return { errors: { dataPrevistaLiberacao: 'Informe uma data válida.' } };
  const { rows } = await pool.query(
    `UPDATE recebimentos_marketplace SET data_prevista_liberacao=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [dataPrevistaLiberacao, id]
  );
  return { recebimento: serialize(rows[0]) };
}

// Usado pela conciliação bancária (lib/conciliacaoBancaria.js) — nunca
// chamado diretamente pela tela. `origem` sempre 'conciliacao_extrato'
// aqui (a diferença de rótulo em relação às ações manuais acima é o que
// permite a IA/telas dizerem COMO se sabe que foi recebido).
async function marcarComoRecebidoPorConciliacao(client, id, { valorRecebido, dataEfetivaRecebimento }) {
  const { rows } = await client.query(
    `UPDATE recebimentos_marketplace
     SET status='recebido', valor_recebido=$1, data_efetiva_recebimento=$2, origem_confirmacao='conciliacao_extrato', updated_at=now()
     WHERE id=$3 AND status <> 'recebido' RETURNING *`,
    [round2(valorRecebido), dataEfetivaRecebimento, id]
  );
  return rows[0] ? serialize(rows[0]) : null;
}

module.exports = {
  MARKETPLACE_ML,
  STATUS_VALIDOS,
  STATUS_PAGAMENTO_APROVADO,
  elegivel,
  serialize,
  serializeRecebimento,
  materializarRecebimentos,
  listarRecebimentosMl,
  listarRecebimentosMlRecebidosNoPeriodo,
  resumoRecebimentosMarketplace,
  buscarPorId,
  marcarComoDisponivel,
  marcarComoRecebido,
  definirPrevisaoLiberacao,
  marcarComoRecebidoPorConciliacao,
};
