// Clientes Novos e Recorrentes — 26/09/2026, pedido explícito do usuário.
//
// Definição escolhida pelo usuário (AskUserQuestion desta etapa, respondida
// por ele mesmo, não assumida por nós):
//   "recorrente" = 2ª compra (ou mais) DENTRO de uma janela de tempo — 90
//   dias por padrão — contados a partir da compra anterior daquele mesmo
//   cliente. Se a compra anterior foi há mais de 90 dias, o cliente entra
//   como "reativado" (categoria adicionada aqui pra nunca forçar um cliente
//   antigo, que sumiu e voltou, a virar "novo" de novo — o que seria
//   inventar que ele nunca comprou antes).
//
// LIMITAÇÃO CONHECIDA, documentada porque o usuário escolheu essa opção
// mesmo depois do aviso: os 3 canais (Mercado Livre, Shopee, Balcão) são
// calculados de forma TOTALMENTE INDEPENDENTE, cada um com o seu próprio
// identificador de cliente (ml_pedidos.comprador_id, shopee_pedidos.
// comprador_user_id, vendas_balcao.cliente_nome normalizado). NUNCA são
// cruzados: hoje não existe nenhum dado confiável (CPF, telefone, e-mail)
// que prove que o "João Silva" do Mercado Livre é a mesma pessoa que o
// "João Silva" da Shopee ou do balcão — cruzar por nome/nickname geraria
// falso positivo (duas pessoas diferentes com nome parecido) e falso
// negativo (a mesma pessoa com nicknames diferentes em cada canal). Por
// isso "total" abaixo é só a SOMA dos 3 canais, nunca uma contagem de
// clientes únicos de verdade — ver docs/05-problemas-conhecidos.md.
// O identificador da Venda de Balcão (nome normalizado) é, dos 3, o mais
// fraco — duas pessoas diferentes com o mesmo nome contam como uma só.
//
// Reaproveita 100% a fonte única de pedidos (buscarPedidosDoPeriodo, já
// com comprador_ref exposto — ver lib/relatorioVendas.js) — nenhuma consulta
// SQL nova. Cancelados nunca contam (nunca chegaram a virar cliente de
// verdade); devolvidos CONTAM (a compra aconteceu, o produto só voltou
// depois — a pessoa continua sendo, de fato, alguém que comprou).
const { buscarPedidosDoPeriodo } = require('./relatorioVendas');

const JANELA_RECORRENCIA_DIAS_PADRAO = 90;
const UM_DIA_MS = 24 * 60 * 60 * 1000;
// "Desde sempre" — nenhum pedido deste sistema é anterior a isso; usado só
// pra buscar o HISTÓRICO COMPLETO de cada cliente (a compra anterior pode
// ter sido há anos, não só dentro do período analisado).
const INICIO_HISTORICO = new Date('2015-01-01T00:00:00Z');

// Classificação PURA (testável sem banco): recebe a lista de pedidos NÃO
// CANCELADOS (histórico completo até `ate`, com marketplace/compradorRef/
// dataEfetiva) e devolve uma classificação por CLIENTE (marketplace +
// compradorRef), usando só a PRIMEIRA compra de cada cliente dentro do
// período — depois disso ele já é "cliente ativo" no período, comprar de
// novo não muda a classificação.
function classificarClientesPorPeriodo(pedidos, { desde, ate, janelaDias = JANELA_RECORRENCIA_DIAS_PADRAO }) {
  const janelaMs = janelaDias * UM_DIA_MS;

  // Agrupa por canal+cliente, nunca cruzando canais (ver cabeçalho do
  // arquivo) — cada cliente é a chave `marketplace::compradorRef`.
  const historico = new Map();
  for (const p of pedidos) {
    if (!p.compradorRef || !p.dataEfetiva) continue;
    const key = `${p.marketplace}::${p.compradorRef}`;
    if (!historico.has(key)) historico.set(key, []);
    historico.get(key).push(new Date(p.dataEfetiva));
  }

  const resultado = [];
  for (const [key, datasBrutas] of historico.entries()) {
    const [marketplace, compradorRef] = key.split('::');
    const datas = [...datasBrutas].sort((a, b) => a - b);

    const idxPrimeiraNoPeriodo = datas.findIndex((d) => d >= desde && d < ate);
    if (idxPrimeiraNoPeriodo === -1) continue; // cliente não comprou neste período

    const compraNoPeriodo = datas[idxPrimeiraNoPeriodo];
    const compraAnterior = idxPrimeiraNoPeriodo > 0 ? datas[idxPrimeiraNoPeriodo - 1] : null;

    let classificacao;
    if (!compraAnterior) {
      classificacao = 'novo';
    } else if (compraNoPeriodo.getTime() - compraAnterior.getTime() <= janelaMs) {
      classificacao = 'recorrente';
    } else {
      classificacao = 'reativado';
    }

    resultado.push({ marketplace, compradorRef, classificacao, dataPrimeiraCompraNoPeriodo: compraNoPeriodo.toISOString() });
  }
  return resultado;
}

function resumoVazio() {
  return { novos: 0, recorrentes: 0, reativados: 0 };
}

function agregarPorCanal(classificacoes) {
  const porCanal = {};
  for (const c of classificacoes) {
    if (!porCanal[c.marketplace]) porCanal[c.marketplace] = resumoVazio();
    const bucket = c.classificacao === 'novo' ? 'novos' : c.classificacao === 'recorrente' ? 'recorrentes' : 'reativados';
    porCanal[c.marketplace][bucket]++;
  }
  const total = resumoVazio();
  for (const resumo of Object.values(porCanal)) {
    total.novos += resumo.novos;
    total.recorrentes += resumo.recorrentes;
    total.reativados += resumo.reativados;
  }
  return { porCanal, total };
}

// Orquestração (precisa de Postgres): busca o histórico completo de pedidos
// não cancelados da empresa (até `ate`) e devolve o resumo pronto pra tela.
async function analisarClientesNovosRecorrentes({ empresaId, desde, ate, janelaDias = JANELA_RECORRENCIA_DIAS_PADRAO }) {
  const { pedidos } = await buscarPedidosDoPeriodo({ empresaId, desde: INICIO_HISTORICO, ate });
  const naoCancelados = pedidos.filter((p) => !p.cancelado);
  const classificacoes = classificarClientesPorPeriodo(naoCancelados, { desde, ate, janelaDias });
  const { porCanal, total } = agregarPorCanal(classificacoes);

  return {
    janelaDias,
    porCanal,
    total,
    limitacao: 'Mercado Livre, Shopee e Venda no Balcão são contados separadamente — não é possível hoje confirmar que o mesmo cliente comprou em mais de um canal, então o total é apenas a soma dos 3, não uma contagem de pessoas únicas.',
  };
}

module.exports = {
  JANELA_RECORRENCIA_DIAS_PADRAO,
  classificarClientesPorPeriodo,
  agregarPorCanal,
  analisarClientesNovosRecorrentes,
};
