// IA de Promoções — ciclo automático no BACKEND (pedido explícito do
// usuário, 13/09/2026: "a cada uma hora a ia tem que busca novas
// promoções"). Mesmo padrão já usado por lib/syncScheduler.js,
// lib/adsScheduler.js e lib/ia/radarScheduler.js — um setInterval dentro do
// próprio processo Node do servidor, nunca um timer no navegador (sempre
// roda, mesmo que ninguém esteja com o ERP aberto).
//
// Intervalo padrão: 1 hora (pedido explícito do usuário). Configurável via
// IA_PROMOCOES_INTERVALO_MS, caso um dia precise ser diferente.
const { executarCicloPromocoes } = require('./promocoesCiclo');

const INTERVALO_MS = Number(process.env.IA_PROMOCOES_INTERVALO_MS) || 60 * 60 * 1000;

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  empresasProcessadas: 0,
  empresasComErro: [],
};

function obterStatusScheduler() {
  return { ...estado, empresasComErro: estado.empresasComErro.map((e) => ({ ...e })) };
}

async function executarCiclo({ executarCicloPromocoesFn = executarCicloPromocoes } = {}) {
  if (estado.emExecucao) {
    console.warn(`[promoções ia] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;
  try {
    const resultado = await executarCicloPromocoesFn();
    estado.empresasProcessadas = resultado.empresasProcessadas;
    estado.empresasComErro = resultado.comErro || [];
    estado.ultimoCicloOk = (resultado.comErro || []).length === 0;
  } catch (err) {
    // Erro fora do loop por empresa (ex.: banco indisponível) — nunca
    // derruba o processo nem impede o próximo ciclo.
    console.error('[promoções ia] ciclo inteiro falhou: ' + (err && err.message));
    estado.ultimoCicloOk = false;
  } finally {
    estado.ultimaExecucaoEm = new Date();
    estado.emExecucao = false;
  }
  return obterStatusScheduler();
}

let timer = null;

function iniciarPromocoesIA() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[promoções ia] iniciado — buscando promoções e recalculando margem a cada ${Math.round(estado.intervaloMs / 1000)}s.`);

  const rodarCiclo = () => {
    executarCiclo().catch((err) => {
      console.error('[promoções ia] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 1h pra ter dado na tela
}

function pararPromocoesIA() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = { iniciarPromocoesIA, pararPromocoesIA, executarCiclo, obterStatusScheduler };
