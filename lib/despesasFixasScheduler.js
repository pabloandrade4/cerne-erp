// Geração automática (BACKEND) das Contas a Pagar a partir das Despesas
// Fixas — ativado em 25/08/2026, pedido explícito do usuário ("não quero
// lançar a mesma despesa manualmente todo mês"). Mesmo padrão de
// lib/adsScheduler.js/lib/syncScheduler.js: roda dentro do processo Node do
// servidor, nunca dependendo de ninguém com o ERP aberto no navegador.
//
// Intervalo bem mais espaçado que o de pedidos: a "novidade" aqui é só o
// calendário virar de mês/semana/ano, não algo que muda a cada minuto — 1
// ciclo por hora é mais que suficiente pra "assim que o novo período
// chegar" a conta já aparecer em Contas a Pagar. Configurável via
// DESPESAS_FIXAS_SYNC_INTERVALO_MS.
const { gerarContasPagarAutomaticas } = require('./despesasFixas');

const INTERVALO_MS = Number(process.env.DESPESAS_FIXAS_SYNC_INTERVALO_MS) || 60 * 60 * 1000; // 1 hora

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  ultimoTotalGeradas: 0,
  ultimoErro: null,
};

function obterStatusGeracaoDespesasFixas() {
  return { ...estado };
}

async function executarCicloDeGeracao({ gerarContasPagarAutomaticasFn = gerarContasPagarAutomaticas } = {}) {
  if (estado.emExecucao) {
    console.warn(`[DespesasFixas] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;

  let erro = null;
  let resultado = null;
  try {
    resultado = await gerarContasPagarAutomaticasFn();
  } catch (err) {
    erro = String((err && err.message) || err);
    console.error(`[DespesasFixas] ciclo de geração falhou: ${erro}`);
  }

  estado.ultimoTotalGeradas = resultado ? resultado.totalGeradas : 0;
  estado.ultimoErro = erro;
  estado.ultimoCicloOk = !erro;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  if (resultado && resultado.totalGeradas) {
    console.log(`[DespesasFixas] ciclo gerou ${resultado.totalGeradas} conta(s) a pagar (horizonte até ${resultado.horizonte}).`);
  }

  return obterStatusGeracaoDespesasFixas();
}

let timer = null;

function iniciarGeracaoAutomaticaDeDespesasFixas() {
  if (timer) return; // já iniciado — evita registrar 2 intervals se chamado 2x
  estado.ativo = true;
  console.log(`[DespesasFixas] geração automática de Contas a Pagar iniciada — a cada ${Math.round(estado.intervaloMs / 1000)}s, para todas as despesas fixas ativas.`);

  const rodarCiclo = () => {
    executarCicloDeGeracao().catch((err) => {
      console.error('[DespesasFixas] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 1h pro primeiro dado real aparecer
}

function pararGeracaoAutomaticaDeDespesasFixas() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarGeracaoAutomaticaDeDespesasFixas,
  pararGeracaoAutomaticaDeDespesasFixas,
  executarCicloDeGeracao,
  obterStatusGeracaoDespesasFixas,
};
