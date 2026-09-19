// Sincronização automática (BACKEND) dos pedidos da Shopee — pedido
// explícito do usuário depois de ver a sincronização manual (botão
// "Sincronizar agora") funcionar de verdade em produção (14/09/2026: "pode
// construir isso na Shopee igual ao mercado livre"). Mesmo desenho de
// lib/syncScheduler.js (Mercado Livre): um ciclo periódico, sempre dentro
// do processo Node do servidor (nunca setInterval no navegador),
// verificando TODAS as lojas Shopee conectadas e ATIVAS (status = 'ativa')
// — cada loja sincronizada isoladamente (Promise.allSettled, nunca
// Promise.all), então uma loja com erro nunca trava as demais nem os
// próximos ciclos. Reaproveita a MESMA função do botão manual
// (lib/shopeeSync.js#sincronizarConta), só que com uma janela mais curta
// (ver RECONCILIACAO_DIAS abaixo) — nunca duplica lógica de importação.
//
// Diferença importante do Mercado Livre: o ML tem webhook (tempo real,
// routes/integracoes.js POST /webhook) e este tipo de ciclo é só a rede de
// segurança dele. A Shopee, nesta etapa, NÃO tem webhook configurado — este
// ciclo periódico é hoje o ÚNICO jeito de pegar pedido novo/mudança de
// status sem clicar em "Sincronizar agora" manualmente. Um webhook de
// verdade da Shopee (Shopee Push/Webhook, configurado no painel da própria
// Shopee) é possível no futuro, mas é outra etapa — não construído aqui.
//
// Intervalo mais longo que o do Mercado Livre (5min, não 1min) e janela de
// reconciliação mais curta que a do botão manual (poucos dias, não 60):
// mesma cautela já registrada em lib/shopee.js/lib/shopeeSync.js — esta é a
// PRIMEIRA vez que a sincronização de pedidos da Shopee roda de forma
// automática e repetida neste projeto, e não há confirmação (documentação
// oficial da Shopee não pôde ser aberta neste ambiente sandbox) de qual
// limite de chamadas por minuto a Shopee aceita pra esta conta/app. Melhor
// começar conservador e o usuário encurtar depois de ver rodando estável
// por um tempo do que arriscar a Shopee bloquear a conta por excesso de
// chamada. Intervalo/janela/timeout configuráveis por variável de ambiente.
const pool = require('../db/pool');
const { sincronizarConta } = require('./shopeeSync');

const INTERVALO_MS = Number(process.env.SHOPEE_SYNC_INTERVALO_MS) || 5 * 60 * 1000; // 5 minutos
const RECONCILIACAO_DIAS = Number(process.env.SHOPEE_SYNC_RECONCILIACAO_DIAS) || 3;
const TIMEOUT_POR_CONTA_MS = Number(process.env.SHOPEE_SYNC_TIMEOUT_POR_CONTA_MS) || 4 * 60 * 1000; // 4 min

// Mesmo watchdog de lib/syncScheduler.js (correção documentada lá,
// 01/09/2026): sem isto, UMA loja cuja chamada trave (rede lenta, Shopee
// sem responder) travaria o ciclo inteiro pra sempre, e todo ciclo seguinte
// seria pulado pelo guard `emExecucao` logo abaixo.
function comTimeout(promessa, ms, mensagemTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(mensagemTimeout)), ms);
  });
  return Promise.race([promessa, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Estado em memória do último ciclo — cada loja já grava seu próprio
// status/último erro/última sincronização em shopee_contas (usado pela
// tela Marketplaces); isto aqui é só o "batimento cardíaco" do job
// automático em si.
const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  reconciliacaoDias: RECONCILIACAO_DIAS,
  emExecucao: false,
  ultimaExecucaoEm: null, // Date — quando o último ciclo TERMINOU (com ou sem erro)
  ultimoCicloOk: null, // null até o 1º ciclo terminar; depois true/false
  contasProcessadas: 0,
  contasComErro: [], // [{ contaId, empresaId, erro }] do último ciclo (nunca interrompe os demais)
  ultimoErroGeral: null, // erro que impediu o ciclo inteiro de rodar (ex.: banco fora do ar) — raro
};

function obterStatusSincronizacaoAutomatica() {
  return { ...estado, contasComErro: estado.contasComErro.map((c) => ({ ...c })) };
}

// sincronizarContaFn é injetável só pra teste automatizado conseguir
// simular lojas que falham sem precisar de credenciais reais da Shopee —
// em produção é sempre sincronizarConta (lib/shopeeSync.js), mesmo padrão
// de lib/syncScheduler.js.
async function executarCicloDeSincronizacao({ sincronizarContaFn = sincronizarConta } = {}) {
  if (estado.emExecucao) {
    console.warn(
      `[sync automático Shopee] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`
    );
    return null;
  }
  estado.emExecucao = true;

  const contasComErro = [];
  let contasProcessadas = 0;
  let erroGeral = null;

  try {
    const { rows: contas } = await pool.query(
      `SELECT id, empresa_id FROM shopee_contas WHERE status = 'ativa' ORDER BY id`
    );

    // Promise.allSettled (nunca Promise.all): uma loja falhar nunca impede
    // as demais nem os próximos ciclos.
    const resultados = await Promise.allSettled(
      contas.map(async (conta) => {
        try {
          await comTimeout(
            sincronizarContaFn(conta.id, { diasAtras: estado.reconciliacaoDias }),
            TIMEOUT_POR_CONTA_MS,
            `Sincronização Shopee excedeu ${Math.round(TIMEOUT_POR_CONTA_MS / 1000)}s — abortada para não travar o ciclo (conta ${conta.id}).`
          );
        } catch (err) {
          const wrapped = new Error(String((err && err.message) || err));
          wrapped.contaId = conta.id;
          wrapped.empresaId = conta.empresa_id;
          throw wrapped;
        }
      })
    );

    for (const r of resultados) {
      contasProcessadas++;
      if (r.status === 'rejected') {
        const reason = r.reason || {};
        const info = { contaId: reason.contaId ?? null, empresaId: reason.empresaId ?? null, erro: reason.message || String(reason) };
        contasComErro.push(info);
        console.error(`[sync automático Shopee] conta ${info.contaId} (empresa ${info.empresaId}) falhou: ${info.erro}`);
      }
    }
  } catch (err) {
    // Erro fora do loop por conta (ex.: banco indisponível pra listar as
    // lojas) — nunca derruba o processo nem impede o próximo ciclo.
    erroGeral = String((err && err.message) || err);
    console.error(`[sync automático Shopee] ciclo inteiro falhou: ${erroGeral}`);
  }

  estado.contasProcessadas = contasProcessadas;
  estado.contasComErro = contasComErro;
  estado.ultimoErroGeral = erroGeral;
  estado.ultimoCicloOk = !erroGeral && contasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusSincronizacaoAutomatica();
}

let timer = null;

function iniciarSincronizacaoAutomaticaShopee() {
  if (timer) return; // já iniciado — evita registrar 2 intervals se chamado 2x
  estado.ativo = true;
  console.log(
    `[sync automático Shopee] iniciado — verificando lojas ativas a cada ${Math.round(estado.intervaloMs / 1000)}s (janela de reconciliação: ${estado.reconciliacaoDias} dia(s)).`
  );

  const rodarCiclo = () => {
    executarCicloDeSincronizacao().catch((err) => {
      // Segurança extra: executarCicloDeSincronizacao já captura tudo
      // internamente, mas nunca deixar uma rejeição não tratada aqui.
      console.error('[sync automático Shopee] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref(); // não prende o processo vivo só por causa do timer (relevante em testes)

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 5min pro primeiro pedido novo aparecer
}

function pararSincronizacaoAutomaticaShopee() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarSincronizacaoAutomaticaShopee,
  pararSincronizacaoAutomaticaShopee,
  executarCicloDeSincronizacao,
  obterStatusSincronizacaoAutomatica,
};
