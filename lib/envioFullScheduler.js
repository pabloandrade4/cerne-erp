// Ciclo automático (BACKEND) do "Agente de Envio Full" — 23/09/2026. Mesmo
// padrão de lib/comprasIaScheduler.js: roda dentro do processo Node do
// servidor, nunca um setInterval no navegador — funciona mesmo com o ERP
// fechado. Mesmo intervalo padrão (1h) e mesmo raciocínio: este ciclo
// NUNCA chama nenhuma API externa — só relê estoque e vendas já
// sincronizados. Configurável via ENVIO_FULL_SYNC_INTERVALO_MS.
const { executarCicloEnvioFull } = require('./ia/envioFullCiclo');

const INTERVALO_MS = Number(process.env.ENVIO_FULL_SYNC_INTERVALO_MS) || 60 * 60 * 1000; // 1 hora

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  empresasProcessadas: 0,
  empresasComErro: [],
};

function obterStatusEnvioFull() {
  return { ...estado, empresasComErro: estado.empresasComErro.map((e) => ({ ...e })) };
}

async function executarCicloDeEnvioFull() {
  if (estado.emExecucao) {
    console.warn(`[Envio Full] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;

  let erroGeral = null;
  let empresasProcessadas = 0;
  let empresasComErro = [];
  try {
    const resultado = await executarCicloEnvioFull();
    empresasProcessadas = resultado.empresasProcessadas;
    empresasComErro = resultado.comErro || [];
  } catch (err) {
    erroGeral = String((err && err.message) || err);
    console.error('[Envio Full] ciclo inteiro falhou:', erroGeral);
  }

  estado.empresasProcessadas = empresasProcessadas;
  estado.empresasComErro = empresasComErro;
  estado.ultimoCicloOk = !erroGeral && empresasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusEnvioFull();
}

let timer = null;

function iniciarEnvioFullAutomatico() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[Envio Full] ciclo automático iniciado — a cada ${Math.round(estado.intervaloMs / 1000)}s, para todas as empresas ativas.`);

  const rodarCiclo = () => {
    executarCicloDeEnvioFull().catch((err) => {
      console.error('[Envio Full] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 1h pro primeiro dado real aparecer
}

function pararEnvioFullAutomatico() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarEnvioFullAutomatico,
  pararEnvioFullAutomatico,
  executarCicloDeEnvioFull,
  obterStatusEnvioFull,
};
