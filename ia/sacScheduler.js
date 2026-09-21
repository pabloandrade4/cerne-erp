// SAC (Mercado Livre + Shopee) — ciclo automático no BACKEND, 15/09/2026,
// pedido explícito do usuário: "nao quero ter que ficar sincronizando nada
// quero tudo automatico". Mesmo padrão já usado por lib/syncScheduler.js,
// lib/adsScheduler.js e lib/ia/promocoesScheduler.js — um setInterval
// dentro do próprio processo Node do servidor, nunca um timer no
// navegador (roda mesmo que ninguém esteja com o ERP aberto).
//
// Continua 100% MODO SUPERVISIONADO: este ciclo automático só faz a mesma
// coisa que o botão "Gerar agora" já fazia manualmente — sincronizar
// perguntas/mensagens/reclamações (ML) e conversas/devoluções (Shopee) e
// gerar SUGESTÕES de resposta pendentes de aprovação humana. Nada aqui
// envia mensagem nenhuma ao Mercado Livre/Shopee (sac_respostas.enviado
// continua sempre false nesta fase) — ver lib/ia/sacRespostaIa.js e
// routes/sac.js.
//
// Mercado Livre e Shopee rodam em ciclos ISOLADOS (Promise.allSettled) —
// uma falha total de um marketplace (ex.: API fora do ar) nunca atrasa
// nem impede o outro.
//
// Intervalo padrão: 10 minutos. Diferente de Ads (15min) e Promoções
// (60min) porque SAC é atendimento ao cliente — quanto mais rápido uma
// sugestão de resposta fica pronta pro humano aprovar, melhor pro
// comprador — mas cada ciclo pode gastar uma chamada de IA por
// atendimento novo, então não faz sentido ser mais agressivo que isso.
// Configurável via SAC_IA_INTERVALO_MS.
const { executarCicloSacMercadoLivre, executarCicloSacShopee } = require('./sacCiclo');

const INTERVALO_MS = Number(process.env.SAC_IA_INTERVALO_MS) || 10 * 60 * 1000;

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  mercadoLivre: { empresasProcessadas: 0, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] },
  shopee: { empresasProcessadas: 0, atendimentosNovos: 0, sugestoesGeradas: 0, comErro: [] },
};

function obterStatusScheduler() {
  return {
    ...estado,
    mercadoLivre: { ...estado.mercadoLivre, comErro: estado.mercadoLivre.comErro.map((e) => ({ ...e })) },
    shopee: { ...estado.shopee, comErro: estado.shopee.comErro.map((e) => ({ ...e })) },
  };
}

async function executarCiclo({
  executarCicloSacMercadoLivreFn = executarCicloSacMercadoLivre,
  executarCicloSacShopeeFn = executarCicloSacShopee,
} = {}) {
  if (estado.emExecucao) {
    console.warn(`[SAC ia] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`);
    return null;
  }
  estado.emExecucao = true;
  try {
    const [resultadoMl, resultadoShopee] = await Promise.allSettled([
      executarCicloSacMercadoLivreFn(),
      executarCicloSacShopeeFn(),
    ]);

    if (resultadoMl.status === 'fulfilled') {
      estado.mercadoLivre = resultadoMl.value;
    } else {
      console.error('[SAC ia][Mercado Livre] ciclo inteiro falhou: ' + (resultadoMl.reason && resultadoMl.reason.message));
      estado.mercadoLivre = { ...estado.mercadoLivre, comErro: [{ erro: String((resultadoMl.reason && resultadoMl.reason.message) || resultadoMl.reason) }] };
    }

    if (resultadoShopee.status === 'fulfilled') {
      estado.shopee = resultadoShopee.value;
    } else {
      console.error('[SAC ia][Shopee] ciclo inteiro falhou: ' + (resultadoShopee.reason && resultadoShopee.reason.message));
      estado.shopee = { ...estado.shopee, comErro: [{ erro: String((resultadoShopee.reason && resultadoShopee.reason.message) || resultadoShopee.reason) }] };
    }

    estado.ultimoCicloOk = estado.mercadoLivre.comErro.length === 0 && estado.shopee.comErro.length === 0;
  } catch (err) {
    // Não deveria acontecer (Promise.allSettled nunca rejeita), mas nunca
    // derruba o processo nem impede o próximo ciclo.
    console.error('[SAC ia] ciclo inteiro falhou: ' + (err && err.message));
    estado.ultimoCicloOk = false;
  } finally {
    estado.ultimaExecucaoEm = new Date();
    estado.emExecucao = false;
  }
  return obterStatusScheduler();
}

let timer = null;

function iniciarSacScheduler() {
  if (timer) return;
  estado.ativo = true;
  console.log(`[SAC ia] iniciado — verificando novos atendimentos (Mercado Livre + Shopee) e gerando sugestões a cada ${Math.round(estado.intervaloMs / 1000)}s.`);

  const rodarCiclo = () => {
    executarCiclo().catch((err) => {
      console.error('[SAC ia] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo — não espera o intervalo todo pra ter dado na tela
}

function pararSacScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = { iniciarSacScheduler, pararSacScheduler, executarCiclo, obterStatusScheduler };
