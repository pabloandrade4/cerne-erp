// Sincronização automática (BACKEND) do Product Ads do Mercado Livre —
// adicionada em 25/08/2026, pedido explícito do usuário (Passo 2: "Armazene
// os dados no banco para não depender de consultar toda a API toda vez que
// eu abrir a página"). Mesmo padrão de lib/syncScheduler.js (pedidos/
// estoque) e lib/ia/radarScheduler.js: roda dentro do processo Node do
// servidor, nunca um setInterval no navegador — funciona mesmo com o ERP
// fechado.
//
// Intervalo bem mais espaçado que o de pedidos (1 min): a API de
// Advertising é uma agregação de métricas, que não muda a cada segundo, e
// cada ciclo já faz várias chamadas por conta (advertiser + 5 janelas de
// período + campanhas + série diária, ver lib/ads.js#sincronizarContaAds) —
// rodar de 1 em 1 minuto seria desperdício e risco de rate limit. Intervalo
// configurável via ADS_SYNC_INTERVALO_MS caso o usuário queira ajustar.
const { sincronizarTodasAsContasAds } = require('./ads');

const INTERVALO_MS = Number(process.env.ADS_SYNC_INTERVALO_MS) || 15 * 60 * 1000; // 15 minutos

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  contasProcessadas: 0,
  contasComErro: [],
  ultimoErroGeral: null,
};

function obterStatusSincronizacaoAds() {
  return { ...estado, contasComErro: estado.contasComErro.map((c) => ({ ...c })) };
}

async function executarCicloDeSincronizacaoAds({ sincronizarTodasAsContasAdsFn = sincronizarTodasAsContasAds } = {}) {
  if (estado.emExecucao) {
    console.warn(`[Ads] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;

  let erroGeral = null;
  let contasProcessadas = 0;
  let contasComErro = [];
  try {
    const resultado = await sincronizarTodasAsContasAdsFn();
    contasProcessadas = resultado.contasProcessadas;
    contasComErro = resultado.comErro || [];
    contasComErro.forEach((c) => console.error(`[Ads] conta ${c.contaId} falhou ao sincronizar: ${c.erro}`));
  } catch (err) {
    erroGeral = String((err && err.message) || err);
    console.error(`[Ads] ciclo inteiro falhou: ${erroGeral}`);
  }

  estado.contasProcessadas = contasProcessadas;
  estado.contasComErro = contasComErro;
  estado.ultimoErroGeral = erroGeral;
  estado.ultimoCicloOk = !erroGeral && contasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusSincronizacaoAds();
}

let timer = null;

function iniciarSincronizacaoAutomaticaAds() {
  if (timer) return; // já iniciado — evita registrar 2 intervals se chamado 2x
  estado.ativo = true;
  console.log(`[Ads] sincronização automática iniciada — a cada ${Math.round(estado.intervaloMs / 1000)}s, para todas as contas ativas do Mercado Livre.`);

  const rodarCiclo = () => {
    executarCicloDeSincronizacaoAds().catch((err) => {
      console.error('[Ads] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera o intervalo inteiro pro primeiro dado real aparecer
}

function pararSincronizacaoAutomaticaAds() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarSincronizacaoAutomaticaAds,
  pararSincronizacaoAutomaticaAds,
  executarCicloDeSincronizacaoAds,
  obterStatusSincronizacaoAds,
};
