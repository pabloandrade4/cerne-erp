const { Pool } = require('pg');

// Render (e a maioria dos provedores gerenciados) exige SSL para o Postgres
// externo. Em desenvolvimento local (DATABASE_URL apontando para
// localhost) o SSL fica desligado automaticamente.
const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

module.exports = pool;
