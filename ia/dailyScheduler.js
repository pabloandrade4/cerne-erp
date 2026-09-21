// Agendamento automático da "Daily dos Agentes" — Etapa 4 (19/09/2026,
// pedido explícito do usuário: "quero que atualize... e quero... me enviar
// relatórios... pelo WhatsApp, tudo integrado com o Mercado Livre"). Mesmo
// padrão dos outros agentes 24h (lib/adsScheduler.js, lib/despesasFixasScheduler.js
// etc.): roda dentro do próprio processo Node do servidor, nunca dependendo
// de ninguém com o ERP aberto no navegador.
//
// Diferente dos outros schedulers (que fazem algo a CADA ciclo), a Daily só
// faz sentido rodar 1 VEZ por dia por empresa — mas "1 vez por dia" não é um
// intervalo fixo em milissegundos (a hora de boot do servidor varia, e um
// deploy no meio do dia não pode fazer o resumo sumir ou duplicar). Por isso
// o padrão aqui é: verifica com frequência (a cada DAILY_CHECK_INTERVALO_MS,
// padrão 15min) se já passou da hora configurada (DAILY_HORA_ENVIO, padrão
// 9h, fuso de Brasília — ver lib/periodo.js#horaBRT) — e só quando já
// passou, chama lib/ia/dailyCiclo.js#executarDailyComNotificacao, que por
// sua vez NUNCA envia 2 vezes no mesmo dia pra mesma empresa (marca
// ia_reunioes_diarias.whatsapp_enviado_em na 1ª tentativa) — repetir a
// verificação a cada 15min o resto do dia é seguro e nunca gera WhatsApp
// duplicado, mesmo que o servidor reinicie no meio do dia.
const pool = require('../../db/pool');
const { horaBRT } = require('../periodo');
const { executarDailyComNotificacao } = require('./dailyCiclo');

const INTERVALO_MS = Number(process.env.DAILY_CHECK_INTERVALO_MS) || 15 * 60 * 1000; // 15 minutos
const HORA_ENVIO = Number.isFinite(Number(process.env.DAILY_HORA_ENVIO)) ? Number(process.env.DAILY_HORA_ENVIO) : 9; // 09:00 em Brasília, configurável

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  horaEnvio: HORA_ENVIO,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  horaJaChegouHoje: false,
  empresasProcessadas: 0,
  empresasNotificadas: 0,
  ultimoErroGeral: null,
};

function obterStatusDaily() {
  return { ...estado };
}

async function buscarEmpresasAtivas() {
  const { rows } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  return rows.map((r) => r.id);
}

async function executarCicloDaily({
  agora = new Date(),
  executarDailyComNotificacaoFn = executarDailyComNotificacao,
  buscarEmpresasAtivasFn = buscarEmpresasAtivas,
} = {}) {
  if (estado.emExecucao) {
    console.warn(`[Daily] verificação anterior ainda em andamento — pulando este disparo (próxima em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;

  let erroGeral = null;
  let empresasProcessadas = 0;
  let empresasNotificadas = 0;
  const horaAtual = horaBRT(agora);
  const horaJaChegou = horaAtual >= estado.horaEnvio;

  if (horaJaChegou) {
    try {
      const empresaIds = await buscarEmpresasAtivasFn();
      const resultados = await Promise.allSettled(empresaIds.map((id) => executarDailyComNotificacaoFn(id, { agora })));
      resultados.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          empresasProcessadas += 1;
          if (r.value && !r.value.pulado && r.value.whatsapp && r.value.whatsapp.enviado) empresasNotificadas += 1;
        } else {
          console.error(`[Daily] empresa ${empresaIds[i]} falhou: ${String((r.reason && r.reason.message) || r.reason)}`);
        }
      });
    } catch (err) {
      erroGeral = String((err && err.message) || err);
      console.error(`[Daily] ciclo inteiro falhou: ${erroGeral}`);
    }
  }

  estado.horaJaChegouHoje = horaJaChegou;
  estado.empresasProcessadas = empresasProcessadas;
  estado.empresasNotificadas = empresasNotificadas;
  estado.ultimoErroGeral = erroGeral;
  estado.ultimoCicloOk = !erroGeral;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusDaily();
}

let timer = null;

function iniciarDailyAutomatico() {
  if (timer) return; // já iniciado — evita registrar 2 intervals se chamado 2x
  estado.ativo = true;
  console.log(`[Daily] agendamento automático iniciado — verifica a cada ${Math.round(estado.intervaloMs / 1000)}s se já são ${estado.horaEnvio}h (Brasília) pra rodar a Daily e enviar o resumo por WhatsApp.`);

  const rodarCiclo = () => {
    executarCicloDaily().catch((err) => {
      console.error('[Daily] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // já verifica assim que o servidor sobe — não espera 15min pro 1º check
}

function pararDailyAutomatico() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  obterStatusDaily,
  executarCicloDaily,
  iniciarDailyAutomatico,
  pararDailyAutomatico,
};
