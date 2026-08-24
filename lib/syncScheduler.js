// Sincronização automática (BACKEND) dos pedidos do Mercado Livre — pedida
// pelo usuário pra parar de depender do botão manual "Sincronizar" (ver
// docs/01-regras-de-negocio.md e docs/04-alteracoes.md). Roda um ciclo a
// cada 1 minuto, sempre dentro do processo Node do servidor (nunca
// setInterval no navegador), verificando TODAS as contas do Mercado Livre
// conectadas e ATIVAS (status = 'ativa') — cada conta é sincronizada
// isoladamente, exatamente como o botão manual já faz, então pedidos nunca
// se misturam entre empresas/lojas (o vínculo é sempre conta_ml_id).
//
// Estratégia (pedida pelo usuário):
//   - Webhook (routes/integracoes.js POST /webhook, já existente) →
//     atualização em tempo real de QUALQUER pedido notificado pelo Mercado
//     Livre, não importa a idade do pedido.
//   - Este ciclo de 1 em 1 minuto → segurança/reconciliação: garante que um
//     pedido novo (ou uma mudança de status/pagamento/cancelamento/
//     devolução/envio/frete/taxa) entra no ERP mesmo que, por qualquer
//     motivo, o webhook não tenha avisado (nunca configurado no painel do
//     Mercado Livre, notificação perdida, falha temporária de rede).
//
// Por que a janela de reconciliação é de poucos dias (não os mesmos 30 dias
// do botão manual): sincronizar UMA conta com muitos pedidos pode levar
// minutos (documentado em docs/05-problemas-conhecidos.md — 2370 pedidos
// ≈ 14min); repetir uma busca de 30 dias inteira a cada 60s não é viável
// nem necessário. A grande maioria das mudanças de status/pagamento/envio
// acontece nos primeiros dias de vida do pedido — pedidos mais antigos que
// mudam depois (ex.: devolução tardia) continuam cobertos pelo webhook, que
// não tem esse limite de janela. Tamanho configurável via
// ML_SYNC_RECONCILIACAO_DIAS caso o usuário queira ajustar depois.
const pool = require('../db/pool');
const { sincronizarConta } = require('./mlSync');

const INTERVALO_MS = Number(process.env.ML_SYNC_INTERVALO_MS) || 60 * 1000; // 1 minuto
const RECONCILIACAO_DIAS = Number(process.env.ML_SYNC_RECONCILIACAO_DIAS) || 2;

// Estado em memória do último ciclo — não precisa ir pro banco: cada conta
// já grava seu próprio status/último erro/última sincronização em
// ml_contas (usado pela tela Marketplaces); isto aqui é só o "batimento
// cardíaco" do job automático em si, usado pelo indicador discreto do
// header ("Sincronizado há Xs" — ver public/index.html, window fetch a
// GET /api/integracoes/mercadolivre/status-automatico).
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

function obterStatusSincronizacao() {
  return { ...estado, contasComErro: estado.contasComErro.map((c) => ({ ...c })) };
}

// sincronizarContaFn é injetável só pra teste automatizado (server/test/
// syncScheduler.test.js) conseguir simular contas que falham sem precisar
// de credenciais reais do Mercado Livre — em produção é sempre
// sincronizarConta de lib/mlSync.js.
async function executarCicloDeSincronizacao({ sincronizarContaFn = sincronizarConta } = {}) {
  if (estado.emExecucao) {
    console.warn(
      `[sync automático] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`
    );
    return null;
  }
  estado.emExecucao = true;

  const contasComErro = [];
  let contasProcessadas = 0;
  let erroGeral = null;

  try {
    const { rows: contas } = await pool.query(
      `SELECT id, empresa_id FROM ml_contas WHERE status = 'ativa' ORDER BY id`
    );

    // Promise.allSettled (nunca Promise.all): uma conta falhar nunca
    // impede as demais nem os próximos ciclos — requisito explícito do
    // usuário ("um erro em uma sincronização não pode interromper
    // permanentemente as próximas").
    const resultados = await Promise.allSettled(
      contas.map(async (conta) => {
        try {
          await sincronizarContaFn(conta.id, { diasAtras: estado.reconciliacaoDias });
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
        console.error(`[sync automático] conta ${info.contaId} (empresa ${info.empresaId}) falhou: ${info.erro}`);
      }
    }
  } catch (err) {
    // Erro fora do loop por conta (ex.: banco indisponível pra listar as
    // contas) — nunca derruba o processo nem impede o próximo ciclo.
    erroGeral = String((err && err.message) || err);
    console.error(`[sync automático] ciclo inteiro falhou: ${erroGeral}`);
  }

  estado.contasProcessadas = contasProcessadas;
  estado.contasComErro = contasComErro;
  estado.ultimoErroGeral = erroGeral;
  estado.ultimoCicloOk = !erroGeral && contasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusSincronizacao();
}

let timer = null;

function iniciarSincronizacaoAutomatica() {
  if (timer) return; // já iniciado — evita registrar 2 intervals se chamado 2x
  estado.ativo = true;
  console.log(
    `[sync automático] iniciado — verificando contas ativas do Mercado Livre a cada ${Math.round(estado.intervaloMs / 1000)}s (janela de reconciliação: ${estado.reconciliacaoDias} dia(s)).`
  );

  const rodarCiclo = () => {
    executarCicloDeSincronizacao().catch((err) => {
      // Segurança extra: executarCicloDeSincronizacao já captura tudo
      // internamente, mas nunca deixar uma rejeição não tratada aqui — uma
      // promise rejeitada sem .catch pode derrubar o processo Node inteiro
      // (e com ele, TODAS as sincronizações futuras) por causa de 1 ciclo.
      console.error('[sync automático] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref(); // não prende o processo vivo só por causa do timer (relevante em testes)

  rodarCiclo(); // primeiro ciclo dispara logo — não espera 1 minuto pro primeiro pedido novo aparecer
}

function pararSincronizacaoAutomatica() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarSincronizacaoAutomatica,
  pararSincronizacaoAutomatica,
  executarCicloDeSincronizacao,
  obterStatusSincronizacao,
};
