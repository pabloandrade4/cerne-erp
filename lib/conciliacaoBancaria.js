// Conciliação bancária (Passo 2 da tarefa "Recebimentos + Fluxo de Caixa +
// IA Gestora", 27/08/2026, ver docs/02-decisoes.md).
//
// Relaciona AUTOMATICAMENTE movimentações do extrato importado (lib/
// extratoBancario.js) com recebimentos de marketplace (lib/recebimentosMl.js),
// Contas a Receber (lib/contasReceber.js) e Contas a Pagar (lib/contasPagar.js)
// — mas SÓ COMO SUGESTÃO ("Possível conciliação encontrada"). Pedido
// explícito do usuário: "não pode conciliar automaticamente sem regra
// segura" — este módulo NUNCA muda status sozinho; toda confirmação exige
// uma chamada explícita de `confirmarConciliacao`, sempre iniciada pelo
// usuário na tela.
//
// Critério de sugestão (regra segura, nunca "quase igual"): valor do
// movimento e valor do candidato batem em até R$0,01 (arredondamento) — e
// só isso é OBRIGATÓRIO. A proximidade de data (dataReferencia do
// candidato x data do movimento no extrato) NUNCA elimina um candidato
// (marketplaces liberam dinheiro dias depois da venda, sem data prevista
// conhecida — ver lib/recebimentosMl.js), só ORDENA as sugestões (mais
// perto primeiro) e é exposta pra o usuário decidir.
//
// Quando confirmado: MUITO IMPORTANTE (pedido do usuário) — "PREVISTO"
// vira "REALIZADO", nunca os dois somados. Por isso a confirmação faz, na
// MESMA transação: 1) marca o movimento do extrato como conciliado; 2)
// muda o status do alvo (recebimento/conta) pra RECEBIDO — nunca cria um
// segundo lançamento nem soma o valor duas vezes.
const pool = require('../db/pool');
const { diaBRT } = require('./periodo');
const extratoBancario = require('./extratoBancario');
const recebimentosMl = require('./recebimentosMl');
const contasReceber = require('./contasReceber');
const contasPagar = require('./contasPagar');

const TOLERANCIA_VALOR = 0.01;
const MAX_CANDIDATOS_POR_MOVIMENTO = 5;
const JANELA_DIAS_DESCARTE = 120; // candidato com diferença de data maior que isso nem aparece — filtro de sanidade, nunca elimina por proximidade normal

function diasEntre(dataA, dataB) {
  if (!dataA || !dataB) return null;
  const a = new Date(dataA + 'T00:00:00Z');
  const b = new Date(dataB + 'T00:00:00Z');
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86400000);
}

async function candidatosRecebimentosMarketplace(empresaId, mov) {
  const { rows } = await pool.query(
    `SELECT id, marketplace, loja, referencia_externa, data_venda, valor_liquido_esperado
     FROM recebimentos_marketplace
     WHERE empresa_id = $1 AND status IN ('a_receber','disponivel')
       AND valor_liquido_esperado BETWEEN $2 AND $3
     ORDER BY data_venda DESC LIMIT 20`,
    [empresaId, mov.valor - TOLERANCIA_VALOR, mov.valor + TOLERANCIA_VALOR]
  );
  return rows.map((r) => {
    const dataReferencia = r.data_venda ? diaBRT(r.data_venda) : null; // TIMESTAMPTZ -> dia de calendário BRT (mesmo critério de sempre, ver lib/periodo.js)
    return {
      tipo: 'recebimento_marketplace',
      id: r.id,
      descricao: `${r.marketplace}${r.loja ? ' — ' + r.loja : ''} — pedido ${r.referencia_externa}`,
      valor: Number(r.valor_liquido_esperado),
      dataReferencia,
      diferencaDias: diasEntre(mov.data, dataReferencia),
    };
  });
}

async function candidatosContasReceber(empresaId, mov) {
  const { rows } = await pool.query(
    `SELECT id, descricao, origem, valor, data_prevista
     FROM contas_receber
     WHERE empresa_id = $1 AND status = 'a_receber'
       AND valor BETWEEN $2 AND $3
     ORDER BY data_prevista DESC LIMIT 20`,
    [empresaId, mov.valor - TOLERANCIA_VALOR, mov.valor + TOLERANCIA_VALOR]
  );
  return rows.map((r) => {
    const dataReferencia = r.data_prevista ? String(r.data_prevista).slice(0, 10) : null;
    return {
      tipo: 'conta_receber',
      id: r.id,
      descricao: r.descricao + (r.origem ? ` (${r.origem})` : ''),
      valor: Number(r.valor),
      dataReferencia,
      diferencaDias: diasEntre(mov.data, dataReferencia),
    };
  });
}

async function candidatosContasPagar(empresaId, mov) {
  const { rows } = await pool.query(
    `SELECT id, descricao, categoria, valor, vencimento
     FROM contas_pagar
     WHERE empresa_id = $1 AND status = 'pendente'
       AND valor BETWEEN $2 AND $3
     ORDER BY vencimento DESC LIMIT 20`,
    [empresaId, mov.valor - TOLERANCIA_VALOR, mov.valor + TOLERANCIA_VALOR]
  );
  return rows.map((r) => {
    const dataReferencia = r.vencimento ? String(r.vencimento).slice(0, 10) : null;
    return {
      tipo: 'conta_pagar',
      id: r.id,
      descricao: r.descricao + (r.categoria ? ` (${r.categoria})` : ''),
      valor: Number(r.valor),
      dataReferencia,
      diferencaDias: diasEntre(mov.data, dataReferencia),
    };
  });
}

// Sugestões pra TODOS os movimentos ainda não conciliados de uma conta
// bancária — cada um com até MAX_CANDIDATOS_POR_MOVIMENTO candidatos,
// ordenados pelo mais próximo em data. Nunca decide sozinho: é só isso,
// uma lista de "Possível conciliação encontrada" pro usuário revisar.
async function sugerirConciliacoes({ empresaId, contaBancariaId }) {
  const movimentos = await extratoBancario.listarMovimentos({ empresaId, contaBancariaId, statusConciliacao: 'nao_conciliado' });
  const sugestoes = [];

  for (const mov of movimentos) {
    let candidatos = [];
    if (mov.tipo === 'entrada') {
      const [ml, receber] = await Promise.all([
        candidatosRecebimentosMarketplace(empresaId, mov),
        candidatosContasReceber(empresaId, mov),
      ]);
      candidatos = [...ml, ...receber];
    } else {
      candidatos = await candidatosContasPagar(empresaId, mov);
    }

    candidatos = candidatos.filter((c) => c.diferencaDias === null || c.diferencaDias <= JANELA_DIAS_DESCARTE);
    candidatos.sort((a, b) => (a.diferencaDias ?? 9999) - (b.diferencaDias ?? 9999));
    candidatos = candidatos.slice(0, MAX_CANDIDATOS_POR_MOVIMENTO);

    if (candidatos.length) sugestoes.push({ movimento: mov, candidatos });
  }

  return sugestoes;
}

// Confirma UMA conciliação — sempre uma ação explícita do usuário (nunca
// automática). Faz, na MESMA transação: marca o movimento do extrato como
// conciliado + muda o status do alvo pra RECEBIDO/PAGO. Se qualquer um dos
// dois falhar (ex: alvo já foi conciliado por outro movimento nesse
// meio-tempo — condição de corrida coberta pelo WHERE atômico dos
// marcarComoXPorConciliacao), a transação inteira desfaz — nunca fica
// "movimento conciliado" sem o alvo atualizado, ou vice-versa.
async function confirmarConciliacao({ movimentoId, tipo, alvoId }) {
  const TIPOS_VALIDOS = ['recebimento_marketplace', 'conta_receber', 'conta_pagar'];
  if (!TIPOS_VALIDOS.includes(tipo)) return { errors: { tipo: 'Tipo de conciliação inválido.' } };

  const movimento = await extratoBancario.buscarMovimentoPorId(movimentoId);
  if (!movimento) return { notFound: true };
  if (movimento.status_conciliacao !== 'nao_conciliado') {
    return { errors: { geral: 'Este movimento já foi conciliado ou ignorado.' } };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let alvoAtualizado = null;
    if (tipo === 'recebimento_marketplace') {
      alvoAtualizado = await recebimentosMl.marcarComoRecebidoPorConciliacao(client, alvoId, {
        valorRecebido: movimento.valor,
        dataEfetivaRecebimento: movimento.data,
      });
    } else if (tipo === 'conta_receber') {
      alvoAtualizado = await contasReceber.marcarComoRecebidoPorConciliacao(client, alvoId, movimento.data);
    } else if (tipo === 'conta_pagar') {
      alvoAtualizado = await contasPagar.marcarComoPagoPorConciliacao(client, alvoId, movimento.data);
    }

    if (!alvoAtualizado) {
      await client.query('ROLLBACK');
      return { errors: { geral: 'Não foi possível conciliar — o registro alvo já não está mais disponível (pode já ter sido conciliado por outro movimento).' } };
    }

    const { rows } = await client.query(
      `UPDATE extrato_movimentos
       SET status_conciliacao='conciliado', conciliado_com_tipo=$1, conciliado_com_id=$2, conciliado_em=now()
       WHERE id=$3 AND status_conciliacao='nao_conciliado' RETURNING *`,
      [tipo, alvoId, movimentoId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { errors: { geral: 'Este movimento já foi conciliado por outra ação — nada foi alterado duas vezes.' } };
    }

    await client.query('COMMIT');
    return { movimento: extratoBancario.serializeMovimento(rows[0]), alvo: alvoAtualizado };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Marca um movimento como "ignorado" — não é conciliação nenhuma (nunca
// muda um recebimento/conta), só tira da lista de pendências quando o
// usuário sabe que aquele movimento não corresponde a nada rastreado no
// ERP (ex: tarifa bancária, transferência entre contas próprias).
async function ignorarMovimento(movimentoId) {
  const { rows } = await pool.query(
    `UPDATE extrato_movimentos SET status_conciliacao='ignorado' WHERE id=$1 AND status_conciliacao='nao_conciliado' RETURNING *`,
    [movimentoId]
  );
  if (!rows.length) return { errors: { geral: 'Movimento não encontrado ou já não está mais pendente de conciliação.' } };
  return { movimento: extratoBancario.serializeMovimento(rows[0]) };
}

module.exports = {
  sugerirConciliacoes,
  confirmarConciliacao,
  ignorarMovimento,
};
