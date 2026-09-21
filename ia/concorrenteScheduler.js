// Ciclo automático da Análise de Concorrente no BACKEND (19/09/2026, pedido
// explícito do usuário: "quero que essas ia nunca pare de trabalhar...
// sempre buscar concorrentes que estão vendendo o mesmo produto que eu").
// Mesmo padrão dos outros agentes 24h deste projeto (lib/ia/radarScheduler.js,
// lib/adsScheduler.js etc.): um setInterval dentro do próprio processo Node
// do servidor, nunca dependendo de ninguém com o ERP aberto no navegador.
//
// Intervalo BEM mais longo que o Radar da IA (15min): cada produto varrido
// aqui gasta pelo menos 1 chamada real à API PÚBLICA do Mercado Livre (ver
// lib/ia/radarConcorrente.js) — rodar a cada 15min estouraria rate limit
// rápido pra qualquer empresa com catálogo de tamanho normal. Padrão: 1x
// por dia (24h), configurável via IA_CONCORRENTE_INTERVALO_MS.
const { executarCicloConcorrente } = require('./radarConcorrente');

const INTERVALO_MS = Number(process.env.IA_CONCORRENTE_INTERVALO_MS) || 24 * 60 * 60 * 1000;

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  empresasProcessadas: 0,
  produtosAnalisados: 0,
  empresasComErro: [],
};

function obterStatusScheduler() {
  return { ...estado, empresasComErro: estado.empresasComErro.map((e) => ({ ...e })) };
}

async function executarCiclo({ executarCicloConcorrenteFn = executarCicloConcorrente } = {}) {
  if (estado.emExecucao) {
    console.warn(`[concorrente ia] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;
  try {
    const resultado = await executarCicloConcorrenteFn();
    estado.empresasProcessadas = resultado.empresasProcessadas;
    estado.produtosAnalisados = resultado.produtosAnalisados;
    estado.empresasComErro = resultado.comErro || [];
    estado.ultimoCicloOk = (resultado.comErro || []).length === 0;
  } catch (err) {
    // Erro fora do loop por empresa (ex.: banco indisponível) — nunca
    // derruba o processo nem impede o próximo ciclo.
    console.error('[concorrente ia] ciclo inteiro falhou: ' + (err && err.message));
    estado.ultimoCicloOk = false;
  } finally {
    estado.ultimaExecucaoEm = new Date();
    estado.emExecucao = false;
  }
  return obterStatusScheduler();
}

let timer = null;

function iniciarConcorrenteIA() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[concorrente ia] iniciado — varrendo produtos com venda real no Mercado Livre a cada ${Math.round(estado.intervaloMs / 1000)}s, por empresa ativa.`);

  const rodarCiclo = () => {
    executarCiclo().catch((err) => {
      console.error('[concorrente ia] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 24h pro primeiro alerta aparecer
}

function pararConcorrenteIA() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = { iniciarConcorrenteIA, pararConcorrenteIA, executarCiclo, obterStatusScheduler };
