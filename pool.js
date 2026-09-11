const { Pool } = require('pg');

// Render (e a maioria dos provedores gerenciados) exige SSL para o Postgres
// externo. Em desenvolvimento local (DATABASE_URL apontando para
// localhost) o SSL fica desligado automaticamente.
const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);

// CORREÇÃO (01/09/2026, diagnóstico do Ads não sincronizar — ver
// docs/04-alteracoes.md): o Pool não tinha NENHUM limite/timeout
// configurado. Isso permitia que:
//   1) uma única query travada (ex.: esperando um lock de linha) ficasse
//      pendurada PARA SEMPRE — confirmado em produção via
//      `[sync automático] ciclo anterior ainda em andamento` repetindo por
//      34+ horas seguidas, porque o ciclo de sincronização usa
//      Promise.allSettled, que só resolve quando TODAS as promises
//      terminarem (nem que seja com erro) — uma única query sem timeout
//      travava o ciclo inteiro pra sempre, e todo ciclo seguinte era
//      pulado pelo guard `estado.emExecucao`.
//   2) o app pudesse tentar abrir mais conexões simultâneas do que o
//      Postgres do plano free aceita — confirmado em produção via
//      `[Ads] ciclo inteiro falhou: (EMAXCONNSESSION) max clients reached
//      in session mode - max clients are limited to pool_size: 15` e
//      `[radar da ia] falha ao consultar Ads (30d) — seguindo sem dado de
//      Ads: Query read timeout` (este último repetindo a cada ~15min por
//      dias). `max` abaixo do limite do banco evita estourar esse teto;
//      `idleTimeoutMillis`/`connectionTimeoutMillis` evitam que uma
//      conexão obtida via pool.connect() (usada por
//      lib/mlEstoque.js/lib/contasBancarias.js) fique presa
//      indefinidamente; `statement_timeout`/`query_timeout` fazem
//      qualquer query individual desistir sozinha em vez de travar o
//      processo pra sempre.
// Configurável por variável de ambiente para não travar o app se o plano
// do banco mudar (ex.: Postgres pago com mais conexões liberadas).
const POOL_MAX = Number(process.env.DB_POOL_MAX) || 8; // < 15 (teto observado no plano free do Render)
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30 * 1000;
const IDLE_TIMEOUT_MS = Number(process.env.DB_IDLE_TIMEOUT_MS) || 10 * 1000;
const CONN_TIMEOUT_MS = Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 15 * 1000;

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: CONN_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  query_timeout: STATEMENT_TIMEOUT_MS,
});

// Uma conexão do pool que trava/erra em segundo plano (ex.: o próprio
// Postgres derrubando a sessão) não pode virar um `unhandledRejection` que
// mata o processo Node inteiro — só loga e deixa o pool substituir a
// conexão sozinho. `pool.on` só existe no driver `pg` real (produção) — o
// stub de teste usado neste ambiente de desenvolvimento (ver comentário no
// topo de node_modules/pg/index.js) não é um EventEmitter, então o guard
// abaixo evita quebrar os testes locais.
if (typeof pool.on === 'function') {
  pool.on('error', (err) => {
    console.error('[db pool] erro numa conexão ociosa do pool:', err && err.message);
  });
}

module.exports = pool;
