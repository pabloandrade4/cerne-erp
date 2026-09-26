// Ciclo automático (BACKEND) de Devoluções — 26/09/2026. Mesmo padrão de
// lib/ia/sacScheduler.js: setInterval dentro do processo Node, sempre no
// servidor, nunca dependendo de alguém abrir a tela. Intervalo padrão 30min
// (mais espaçado que SAC/10min porque devolução muda de status bem mais
// devagar que uma conversa nova) — configurável via
// DEVOLUCOES_SYNC_INTERVALO_MS.
const { executarCicloDevolucoes } = require('./devolucoes');

const INTERVALO_MS = Number(process.env.DEVOLUCOES_SYNC_INTERVALO_MS) || 30 * 60 * 1000;

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  empresasProcessadas: 0,
  devolucoesGravadas: 0,
  empresasComErro: [],
};

function obterStatusDevolucoes() {
  return { ...estado, empresasComErro: estado.empresasComErro.map((e) => ({ ...e })) };
}

async function executarCicloDeDevolucoes() {
  if (estado.emExecucao) {
    console.warn(`[Devoluções] ciclo anterior ainda em andamento — pulando este disparo.`);
    return null;
  }
  estado.emExecucao = true;
  let erroGeral = null;
  let empresasProcessadas = 0;
  let devolucoesGravadas = 0;
  let empresasComErro = [];
  try {
    const resultado = await executarCicloDevolucoes();
    empresasProcessadas = resultado.empresasProcessadas;
    devolucoesGravadas = resultado.devolucoesGravadas;
    empresasComErro = resultado.comErro || [];
  } catch (err) {
    erroGeral = String((err && err.message) || err);
    console.error('[Devoluções] ciclo inteiro falhou:', erroGeral);
  }
  estado.empresasProcessadas = empresasProcessadas;
  estado.devolucoesGravadas = devolucoesGravadas;
  estado.empresasComErro = empresasComErro;
  estado.ultimoCicloOk = !erroGeral && empresasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;
  return obterStatusDevolucoes();
}

let timer = null;

function iniciarDevolucoesAutomatico() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[Devoluções] ciclo automático iniciado — a cada ${Math.round(estado.intervaloMs / 1000)}s, para todas as empresas ativas.`);
  const rodarCiclo = () => {
    executarCicloDeDevolucoes().catch((err) => console.error('[Devoluções] erro inesperado no ciclo:', err));
  };
  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();
  rodarCiclo();
}

function pararDevolucoesAutomatico() {
  if (timer) { clearInterval(timer); timer = null; }
  estado.ativo = false;
}

module.exports = {
  iniciarDevolucoesAutomatico,
  pararDevolucoesAutomatico,
  executarCicloDeDevolucoes,
  obterStatusDevolucoes,
};
