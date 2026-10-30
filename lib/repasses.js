// Repasses dos marketplaces (Mercado Livre + Shopee) — Fase 2 (30/10/2026).
//
// Responde: "quanto cada marketplace ainda vai me repassar, e mais ou menos
// quando?". SEM tabela nova: usa os pedidos já sincronizados
// (buscarPedidosDoPeriodo — a mesma fonte única do resto do sistema).
//
// HONESTIDADE: nem o Mercado Livre nem a Shopee devolvem, nos dados que o
// Cerne já busca, a data real em que o dinheiro cai. Por isso a data de
// liberação aqui é SEMPRE uma ESTIMATIVA = data da venda + N dias (N
// configurável, padrão abaixo) e é rotulada assim na tela. O valor líquido
// esperado = venda − tarifas/comissões − frete do vendedor − desconto
// (não desconta imposto nem custo do produto: isso o marketplace não retira).
//
// "Lançar previsão" transforma o repasse estimado em Contas a Receber
// (um lançamento por marketplace e por dia estimado), sem duplicar: cada
// lançamento leva uma marca [repasse:ml:AAAA-MM-DD] na observação.
const pool = require('../db/pool');
const { buscarPedidosDoPeriodo } = require('./relatorioVendas');
const { diaBRT } = require('./periodo');
const { somarDiasData } = require('./diasUtil');
const contasReceber = require('./contasReceber');

const DIAS_PADRAO = { mercado_livre: 14, shopee: 7 };
const NOME_MARKETPLACE = { mercado_livre: 'Mercado Livre', shopee: 'Shopee' };
const MARCA_RE = /\[repasse:(mercado_livre|shopee):(\d{4}-\d{2}-\d{2})\]/;

function round2(n) { return Math.round(n * 100) / 100; }

function diasValidos(v, padrao) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 90 ? n : padrao;
}

function elegivel(p) {
  if (p.cancelado) return false;
  if (p.marketplace === 'mercado_livre') return p.pagamentoStatus === 'approved';
  if (p.marketplace === 'shopee') return true;
  return false; // balcão não passa por repasse
}

function liquido(p) {
  if (p.valorTotal === null || p.tarifasMl === null || p.freteVendedor === null) return null;
  const devolvido = p.devolvido ? (p.valorReembolsado || 0) : 0;
  return round2(p.valorTotal - p.tarifasMl - p.freteVendedor - (p.desconto || 0) - devolvido);
}

async function listarRepasses({ empresaId, janelaDias = 60, diasMl, diasShopee }) {
  const dias = {
    mercado_livre: diasValidos(diasMl, DIAS_PADRAO.mercado_livre),
    shopee: diasValidos(diasShopee, DIAS_PADRAO.shopee),
  };
  const hoje = diaBRT(new Date());
  const desde = somarDiasData(hoje, -Math.max(10, Math.min(Number(janelaDias) || 60, 180)));
  const { pedidos } = await buscarPedidosDoPeriodo({ empresaId, desde, ate: hoje });

  const itens = [];
  let semDados = 0;
  for (const p of pedidos.filter(elegivel)) {
    const liq = liquido(p);
    if (liq === null) { semDados++; continue; }
    const dataVenda = diaBRT(new Date(p.dataEfetiva));
    const estimada = somarDiasData(dataVenda, dias[p.marketplace]);
    itens.push({
      marketplace: p.marketplace,
      marketplaceNome: NOME_MARKETPLACE[p.marketplace],
      loja: p.loja,
      pedidoRef: p.mlOrderId,
      dataVenda,
      valorBruto: p.valorTotal,
      taxas: round2(p.tarifasMl + p.freteVendedor + (p.desconto || 0)),
      valorLiquido: liq,
      dataLiberacaoEstimada: estimada,
      situacao: estimada < hoje ? 'provavelmente_liberado' : estimada === hoje ? 'libera_hoje' : 'a_liberar',
    });
  }
  itens.sort((a, b) => a.dataLiberacaoEstimada.localeCompare(b.dataLiberacaoEstimada));

  // Agrupa por marketplace + dia estimado
  const grupos = new Map();
  for (const it of itens) {
    const k = it.marketplace + '|' + it.dataLiberacaoEstimada;
    if (!grupos.has(k)) grupos.set(k, { marketplace: it.marketplace, marketplaceNome: it.marketplaceNome, data: it.dataLiberacaoEstimada, pedidos: 0, valor: 0, situacao: it.situacao });
    const g = grupos.get(k);
    g.pedidos++; g.valor = round2(g.valor + it.valorLiquido);
  }

  const resumo = { hoje, dias, semDados };
  for (const mk of ['mercado_livre', 'shopee']) {
    const doMk = itens.filter((i) => i.marketplace === mk);
    resumo[mk] = {
      nome: NOME_MARKETPLACE[mk],
      aLiberar: round2(doMk.filter((i) => i.situacao !== 'provavelmente_liberado').reduce((s, i) => s + i.valorLiquido, 0)),
      provavelmenteLiberado: round2(doMk.filter((i) => i.situacao === 'provavelmente_liberado').reduce((s, i) => s + i.valorLiquido, 0)),
      pedidos: doMk.length,
    };
  }
  return { resumo, grupos: [...grupos.values()], itens };
}

// Cria Contas a Receber a partir dos repasses AINDA NÃO liberados
// (libera hoje ou depois). Só para UMA empresa. Não duplica: se o grupo já
// foi lançado, atualiza o valor enquanto ainda estiver "a receber".
async function lancarPrevisao({ empresaId, diasMl, diasShopee }) {
  const id = Number(empresaId);
  if (!id) return { errors: { empresaId: 'Escolha uma empresa (não vale "Juntas").' } };
  const { grupos } = await listarRepasses({ empresaId: id, diasMl, diasShopee });
  const futuros = grupos.filter((g) => g.situacao !== 'provavelmente_liberado');

  const { rows: existentes } = await pool.query(
    `SELECT id, observacao, status, valor FROM contas_receber WHERE empresa_id = $1 AND observacao LIKE '%[repasse:%'`,
    [id]
  );
  const porMarca = new Map();
  for (const r of existentes) {
    const m = MARCA_RE.exec(r.observacao || '');
    if (m) porMarca.set(m[1] + '|' + m[2], r);
  }

  let criados = 0, atualizados = 0, mantidos = 0;
  for (const g of futuros) {
    const marca = `[repasse:${g.marketplace}:${g.data}]`;
    const ex = porMarca.get(g.marketplace + '|' + g.data);
    if (ex) {
      if (ex.status === 'a_receber' && round2(Number(ex.valor)) !== g.valor) {
        await pool.query('UPDATE contas_receber SET valor = $1, descricao = $2, updated_at = now() WHERE id = $3',
          [g.valor, `Repasse ${g.marketplaceNome} (${g.pedidos} pedido${g.pedidos > 1 ? 's' : ''})`, ex.id]);
        atualizados++;
      } else mantidos++;
      continue;
    }
    if (g.valor <= 0) continue;
    const r = await contasReceber.criarContaReceber({
      empresaId: id,
      descricao: `Repasse ${g.marketplaceNome} (${g.pedidos} pedido${g.pedidos > 1 ? 's' : ''})`,
      origem: g.marketplaceNome,
      valor: g.valor,
      dataPrevista: g.data,
      observacao: `Data ESTIMADA (venda + dias de liberação). ${marca}`,
    });
    if (r.errors) return { errors: r.errors };
    criados++;
  }
  return { criados, atualizados, mantidos };
}

module.exports = { listarRepasses, lancarPrevisao, DIAS_PADRAO };
