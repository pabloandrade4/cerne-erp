// Radar da IA — ciclo automático no BACKEND (Passo 3 do pedido do usuário,
// ver docs/02-decisoes.md): "não dependa de eu abrir o chat" / "não use um
// timer apenas no navegador". Mesmo padrão já usado por
// lib/syncScheduler.js (ML) e lib/shopeeTokenScheduler.js (Shopee) — um
// setInterval dentro do próprio processo Node do servidor, nunca no
// navegador do usuário.
//
// Intervalo mais longo que a sincronização de pedidos (1 min): o ciclo do
// Radar chama a API de Ads do Mercado Livre (rate limit real) e roda vários
// cálculos agregados por empresa — não faz sentido nem é seguro repetir
// isso a cada 60s. Os alertas em si também não mudam minuto a minuto (são
// tendências de dias, não de segundos). Configurável via
// IA_RADAR_INTERVALO_MS — padrão 15 minutos.
const { executarCicloRadar } = require('./radar');

const INTERVALO_MS = Number(process.env.IA_RADAR_INTERVALO_MS) || 15 * 60 * 1000;

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

async function executarCiclo({ executarCicloRadarFn = executarCicloRadar } = {}) {
  if (estado.emExecucao) {
    console.warn(`[radar da ia] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;
  try {
    const resultado = await executarCicloRadarFn();
    estado.empresasProcessadas = resultado.empresasProcessadas;
    estado.empresasComErro = resultado.comErro || [];
    estado.ultimoCicloOk = (resultado.comErro || []).length === 0;
  } catch (err) {
    // Erro fora do loop por empresa (ex.: banco indisponível) — nunca
    // derruba o processo nem impede o próximo ciclo.
    console.error('[radar da ia] ciclo inteiro falhou: ' + (err && err.message));
    estado.ultimoCicloOk = false;
  } finally {
    estado.ultimaExecucaoEm = new Date();
    estado.emExecucao = false;
  }
  return obterStatusScheduler();
}

let timer = null;

function iniciarRadarDaIA() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[radar da ia] iniciado — analisando anúncios e o negócio de cada empresa ativa a cada ${Math.round(estado.intervaloMs / 1000)}s.`);

  const rodarCiclo = () => {
    executarCiclo().catch((err) => {
      console.error('[radar da ia] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera o intervalo inteiro pro primeiro alerta aparecer
}

function pararRadarDaIA() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = { iniciarRadarDaIA, pararRadarDaIA, executarCiclo, obterStatusScheduler };
