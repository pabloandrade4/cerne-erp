const { Pool } = require('pg');

// Render (e a maioria dos provedores gerenciados) exige SSL para o Postgres
// externo. Em desenvolvimento local (DATABASE_URL apontando para
// localhost) o SSL fica desligado automaticamente.
const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);

// Diagnóstico de 27/08/2026 (Fluxo de Caixa travado em "Carregando..." pra
// sempre — ver docs/04-alteracoes.md): o pool NUNCA teve timeout nenhum.
// Isso, por si só, não era a causa direta encontrada (não reproduzimos o
// travamento em teste isolado), mas é uma lacuna real: o ERP tem 5 rotinas
// em background compartilhando este MESMO pool (syncScheduler, ads,
// despesasFixasScheduler, radar da IA, renovação Shopee) além do tráfego
// normal — sem limite/timeout, uma query (ex: as 8 do Promise.all de
// gerarFluxoDeCaixa) pode ficar enfileirada esperando conexão livre
// silenciosamente, pra sempre, sem nunca virar um erro. Os 3 timeouts
// abaixo transformam qualquer um desses cenários num erro claro e rápido
// (nunca escondido — ver handler central em server.js) em vez de uma
// espera infinita. Valores conservadores, ajustáveis depois de medir uso
// real (nunca otimização às cegas):
//   - connectionTimeoutMillis: quanto esperar por uma conexão livre do
//     pool antes de desistir (ataca exatamente a hipótese de exaustão).
//   - statement_timeout / query_timeout: quanto esperar uma query
//     responder no Postgres antes do servidor cancelar (ataca uma query
//     real travada/lenta).
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

// Sem isso, um erro num client OCIOSO do pool (ex: banco derrubou a
// conexão) sobe como 'error' não tratado no processo e derruba o server
// inteiro — nunca deveria travar a aplicação por causa disso.
// `typeof pool.on === 'function'` — guarda defensiva: o `pg` real (o que
// roda em produção, listado em package.json) sempre tem `.on` (Pool
// estende EventEmitter), mas o stub de teste usado neste ambiente de
// desenvolvimento (ver node_modules/pg/index.js) é minimalista e não
// implementa eventos — sem essa guarda, o servidor nem sequer subiria
// aqui em dev.
if (typeof pool.on === 'function') {
  pool.on('error', (err) => {
    console.error('[db/pool] erro em client ocioso do pool:', err.message);
  });
}

module.exports = pool;
