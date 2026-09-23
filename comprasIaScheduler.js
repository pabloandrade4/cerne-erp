// Ciclo automático (BACKEND) da "Compras com IA" — 22/09/2026. Mesmo padrão
// de lib/adsScheduler.js: roda dentro do processo Node do servidor, nunca
// um setInterval no navegador — funciona mesmo com o ERP fechado.
//
// Intervalo bem mais espaçado que o de Ads (15 min) ou pedidos/estoque (1
// min): este ciclo NUNCA chama nenhuma API externa — só relê estoque e
// vendas já sincronizados (lib/estoqueFisico.js/lib/relatoriosAgregados.js).
// Estoque e vendas de um dia pra outro não mudam tão rápido a ponto de
// precisar recalcular a cada minuto; um intervalo mais longo evita reprocessar
// à toa. Configurável via COMPRAS_IA_SYNC_INTERVALO_MS.
const { executarCicloComprasIa } = require('./ia/comprasCiclo');

const INTERVALO_MS = Number(process.env.COMPRAS_IA_SYNC_INTERVALO_MS) || 60 * 60 * 1000; // 1 hora

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  empresasProcessadas: 0,
  empresasComErro: [],
};

function obterStatusComprasIa() {
  return { ...estado, empresasComErro: estado.empresasComErro.map((e) => ({ ...e })) };
}

async function executarCicloDeComprasIa() {
  if (estado.emExecucao) {
    console.warn(`[Compras IA] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;

  let erroGeral = null;
  let empresasProcessadas = 0;
  let empresasComErro = [];
  try {
    const resultado = await executarCicloComprasIa();
    empresasProcessadas = resultado.empresasProcessadas;
    empresasComErro = resultado.comErro || [];
  } catch (err) {
    erroGeral = String((err && err.message) || err);
    console.error('[Compras IA] ciclo inteiro falhou:', erroGeral);
  }

  estado.empresasProcessadas = empresasProcessadas;
  estado.empresasComErro = empresasComErro;
  estado.ultimoCicloOk = !erroGeral && empresasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusComprasIa();
}

let timer = null;

function iniciarComprasIaAutomatico() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[Compras IA] ciclo automático iniciado — a cada ${Math.round(estado.intervaloMs / 1000)}s, para todas as empresas ativas.`);

  const rodarCiclo = () => {
    executarCicloDeComprasIa().catch((err) => {
      console.error('[Compras IA] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 1h pro primeiro dado real aparecer
}

function pararComprasIaAutomatico() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarComprasIaAutomatico,
  pararComprasIaAutomatico,
  executarCicloDeComprasIa,
  obterStatusComprasIa,
};
