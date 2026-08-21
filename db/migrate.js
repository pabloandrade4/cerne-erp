// Aplica o schema mínimo. Seguro rodar mais de uma vez (tudo usa
// CREATE TABLE IF NOT EXISTS) — é o que roda automaticamente ao iniciar
// o servidor, e pode também ser chamado manualmente com `npm run migrate`.
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema aplicado com sucesso.');
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[migrate] falhou:', err);
      process.exit(1);
    });
}

module.exports = migrate;
