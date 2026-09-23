// Ciclo automático do Radar de Concorrentes (21/09/2026) — mesmo padrão dos
// outros agentes 24h deste projeto (lib/ia/concorrenteScheduler.js,
// lib/ia/radarScheduler.js etc.): um setInterval dentro do próprio processo
// Node do servidor, nunca dependendo de ninguém com o ERP aberto no
// navegador.
//
// Intervalo mais curto que o de lib/ia/concorrenteScheduler.js (1x/dia) de
// propósito: aquele ciclo VARRE o catálogo inteiro em busca de concorrentes
// novos (1+ chamada por produto); este aqui só relê os anúncios ESPECÍFICOS
// que o usuário já cadastrou (1 chamada por concorrente cadastrado), então
// o custo de rodar mais vezes é bem menor. Padrão: a cada 3h, configurável
// via RADAR_CONCORRENTES_INTERVALO_MS. Isso não é "tempo real" — se o
// usuário quiser conferir na hora, o cadastro já faz uma leitura imediata
// (ver lib/radarConcorrentes.js#cadastrarConcorrente).
const { executarLeituraDeUmConcorrente, listarTodosAtivosComMonitoramentoAutomatico } = require('../radarConcorrentes');

const INTERVALO_MS = Number(process.env.RADAR_CONCORRENTES_INTERVALO_MS) || 3 * 60 * 60 * 1000;
// Pausa entre cada chamada real à API do Mercado Livre dentro de um mesmo
// ciclo — nunca dispara todas de uma vez (mesma preocupação de rate limit
// documentada em lib/ia/concorrenteScheduler.js).
const PAUSA_ENTRE_LEITURAS_MS = 1500;

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  concorrentesLidos: 0,
  concorrentesComErro: 0,
};

function obterStatusScheduler() {
  return { ...estado };
}

function esperar(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function executarCiclo({ listarFn = listarTodosAtivosComMonitoramentoAutomatico, lerFn = executarLeituraDeUmConcorrente } = {}) {
  if (estado.emExecucao) {
    console.warn(`[radar concorrentes] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;
  let lidos = 0;
  let comErro = 0;
  try {
    const concorrentes = await listarFn();
    for (const concorrente of concorrentes) {
      try {
        const resultado = await lerFn(concorrente);
        if (!resultado.pulou) {
          lidos += 1;
          if (!resultado.ok) comErro += 1;
        }
      } catch (err) {
        comErro += 1;
        console.error(`[radar concorrentes] falha ao reler concorrente id=${concorrente.id} (${concorrente.nome_concorrente}): ` + (err && err.message));
      }
      await esperar(PAUSA_ENTRE_LEITURAS_MS);
    }
    estado.concorrentesLidos = lidos;
    estado.concorrentesComErro = comErro;
    estado.ultimoCicloOk = true;
  } catch (err) {
    // Erro fora do loop por concorrente (ex.: banco indisponível) — nunca
    // derruba o processo nem impede o próximo ciclo.
    console.error('[radar concorrentes] ciclo inteiro falhou: ' + (err && err.message));
    estado.ultimoCicloOk = false;
  } finally {
    estado.ultimaExecucaoEm = new Date();
    estado.emExecucao = false;
  }
  return obterStatusScheduler();
}

let timer = null;

function iniciarRadarConcorrentesScheduler() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[radar concorrentes] iniciado — relendo anúncios cadastrados a cada ${Math.round(estado.intervaloMs / 1000)}s.`);

  const rodarCiclo = () => {
    executarCiclo().catch((err) => {
      console.error('[radar concorrentes] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera o intervalo inteiro pro primeiro alerta aparecer
}

function pararRadarConcorrentesScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = { iniciarRadarConcorrentesScheduler, pararRadarConcorrentesScheduler, executarCiclo, obterStatusScheduler };
