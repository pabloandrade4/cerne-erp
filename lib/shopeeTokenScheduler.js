// Renovação automática (BACKEND) do token das lojas Shopee conectadas —
// pedido explícito do usuário ("implemente também a renovação do token
// conforme as regras atuais da Shopee para que a conexão não pare quando o
// access token expirar"). Roda um ciclo periódico, sempre dentro do
// processo Node do servidor (nunca no navegador), verificando TODAS as
// lojas com status 'ativa'.
//
// Por que um ciclo PROATIVO (diferente do Mercado Livre, que renova o token
// só sob demanda, na hora de usá-lo — ver lib/mlSync.js#getContaComTokenValido):
// o ML já é chamado o tempo todo pela sincronização de pedidos de 1 em 1
// minuto, então o token nunca fica muito tempo sem uso. A Shopee, nesta
// etapa, NÃO importa pedidos ainda (pedido explícito do usuário) — sem
// nenhuma outra chamada periódica à API, um token só renovado "sob demanda"
// poderia nunca ser usado, e o refresh_token da Shopee também expira depois
// de um tempo (renová-lo com regularidade é o que mantém a conexão viva
// indefinidamente, sem exigir que o usuário reconecte manualmente). Por
// isso a renovação aqui é sempre proativa, baseada só no relógio.
//
// access_token da Shopee vale 4h (ver lib/shopee.js) — o ciclo roda a cada
// 30 minutos por padrão e renova qualquer loja cujo token vença em menos de
// 60 minutos, com folga confortável pra nunca deixar passar (30min de
// intervalo < 60min de margem).
const pool = require('../db/pool');
const { encrypt, decrypt } = require('./shopeeCrypto');
const shopee = require('./shopee');

const INTERVALO_MS = Number(process.env.SHOPEE_TOKEN_RENOVACAO_INTERVALO_MS) || 30 * 60 * 1000; // 30 minutos
const MARGEM_RENOVACAO_MS = Number(process.env.SHOPEE_TOKEN_RENOVACAO_MARGEM_MS) || 60 * 60 * 1000; // 60 minutos

const estado = {
  ativo: false,
  intervaloMs: INTERVALO_MS,
  margemMs: MARGEM_RENOVACAO_MS,
  emExecucao: false,
  ultimaExecucaoEm: null,
  ultimoCicloOk: null,
  contasVerificadas: 0,
  contasRenovadas: 0,
  contasComErro: [], // [{ contaId, empresaId, erro }]
  ultimoErroGeral: null,
};

function obterStatusRenovacao() {
  return { ...estado, contasComErro: estado.contasComErro.map((c) => ({ ...c })) };
}

// Renova o token de UMA loja. `forcar: true` ignora a margem e renova na
// hora (usado pelo botão manual de emergência); sem isso, só renova se o
// token estiver dentro da margem de vencimento (evita gastar chamada à API
// da Shopee/rotacionar o refresh_token à toa a cada ciclo).
async function renovarTokenDaConta(contaId, { forcar = false } = {}) {
  const { rows } = await pool.query('SELECT * FROM shopee_contas WHERE id = $1', [contaId]);
  if (!rows.length) {
    const err = new Error('Loja da Shopee não encontrada.');
    err.status = 404;
    throw err;
  }
  const conta = rows[0];
  const expiraEm = new Date(conta.token_expires_at).getTime();
  if (!forcar && expiraEm - Date.now() > estado.margemMs) {
    return conta; // ainda longe do vencimento — nada a fazer
  }

  try {
    const refreshTokenValue = decrypt(conta.refresh_token_enc);
    const tokenData = await shopee.refreshAccessToken({
      partnerId: process.env.SHOPEE_PARTNER_ID,
      partnerKey: process.env.SHOPEE_PARTNER_KEY,
      refreshToken: refreshTokenValue,
      shopId: conta.shopee_shop_id,
    });
    const { rows: updated } = await pool.query(
      `UPDATE shopee_contas
       SET access_token_enc = $1, refresh_token_enc = $2, token_expires_at = $3,
           status = 'ativa', ultimo_erro = NULL, updated_at = now()
       WHERE id = $4
       RETURNING *`,
      [
        encrypt(tokenData.access_token),
        encrypt(tokenData.refresh_token),
        new Date(Date.now() + tokenData.expire_in * 1000),
        contaId,
      ]
    );
    return updated[0];
  } catch (err) {
    await pool.query(
      `UPDATE shopee_contas SET status = 'erro', ultimo_erro = $1, updated_at = now() WHERE id = $2`,
      [String(err.message || err).slice(0, 500), contaId]
    );
    const wrapped = new Error('Não foi possível renovar o token da Shopee. A conexão precisa ser refeita.');
    wrapped.status = 401;
    throw wrapped;
  }
}

// renovarTokenDaContaFn é injetável só pra teste automatizado conseguir
// simular lojas que falham sem precisar de credenciais reais da Shopee —
// em produção é sempre renovarTokenDaConta (acima), mesmo padrão de
// lib/syncScheduler.js para o Mercado Livre.
async function executarCicloDeRenovacao({ renovarTokenDaContaFn = renovarTokenDaConta } = {}) {
  if (estado.emExecucao) {
    console.warn(
      `[renovação Shopee] ciclo anterior ainda em andamento — pulando este disparo (próximo em até ${Math.round(estado.intervaloMs / 1000)}s).`
    );
    return null;
  }
  estado.emExecucao = true;

  const contasComErro = [];
  let contasVerificadas = 0;
  let contasRenovadas = 0;
  let erroGeral = null;

  try {
    const { rows: contas } = await pool.query(
      `SELECT id, empresa_id, token_expires_at FROM shopee_contas WHERE status = 'ativa' ORDER BY id`
    );

    const resultados = await Promise.allSettled(
      contas.map(async (conta) => {
        const expiraEm = new Date(conta.token_expires_at).getTime();
        const precisaRenovar = expiraEm - Date.now() <= estado.margemMs;
        if (!precisaRenovar) return { renovado: false };
        try {
          await renovarTokenDaContaFn(conta.id);
          return { renovado: true };
        } catch (err) {
          const wrapped = new Error(String((err && err.message) || err));
          wrapped.contaId = conta.id;
          wrapped.empresaId = conta.empresa_id;
          throw wrapped;
        }
      })
    );

    for (const r of resultados) {
      contasVerificadas++;
      if (r.status === 'rejected') {
        const reason = r.reason || {};
        const info = { contaId: reason.contaId ?? null, empresaId: reason.empresaId ?? null, erro: reason.message || String(reason) };
        contasComErro.push(info);
        console.error(`[renovação Shopee] conta ${info.contaId} (empresa ${info.empresaId}) falhou: ${info.erro}`);
      } else if (r.value && r.value.renovado) {
        contasRenovadas++;
      }
    }
  } catch (err) {
    erroGeral = String((err && err.message) || err);
    console.error(`[renovação Shopee] ciclo inteiro falhou: ${erroGeral}`);
  }

  estado.contasVerificadas = contasVerificadas;
  estado.contasRenovadas = contasRenovadas;
  estado.contasComErro = contasComErro;
  estado.ultimoErroGeral = erroGeral;
  estado.ultimoCicloOk = !erroGeral && contasComErro.length === 0;
  estado.ultimaExecucaoEm = new Date();
  estado.emExecucao = false;

  return obterStatusRenovacao();
}

let timer = null;

function iniciarRenovacaoAutomatica() {
  if (timer) return;
  estado.ativo = true;
  console.log(
    `[renovação Shopee] iniciada — verificando lojas ativas a cada ${Math.round(estado.intervaloMs / 1000)}s (renova quando faltar menos de ${Math.round(estado.margemMs / 60000)}min pro vencimento do token).`
  );

  const rodarCiclo = () => {
    executarCicloDeRenovacao().catch((err) => {
      console.error('[renovação Shopee] erro inesperado no ciclo:', err);
    });
  };

  timer = setInterval(rodarCiclo, estado.intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();

  rodarCiclo(); // primeiro ciclo dispara logo, não espera 30min
}

function pararRenovacaoAutomatica() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  estado.ativo = false;
}

module.exports = {
  iniciarRenovacaoAutomatica,
  pararRenovacaoAutomatica,
  executarCicloDeRenovacao,
  obterStatusRenovacao,
  renovarTokenDaConta,
};
