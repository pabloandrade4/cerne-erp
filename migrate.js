// Aplica o schema mínimo. Seguro rodar mais de uma vez (tudo usa
// CREATE TABLE IF NOT EXISTS) — é o que roda automaticamente ao iniciar
// o servidor, e pode também ser chamado manualmente com `npm run migrate`.
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

// Nome da migração de dados abaixo, usado como chave em `migracoes_aplicadas`
// pra ela rodar só uma vez neste banco (nunca de novo a cada boot).
const NOME_MIGRACAO_CUSTOS = 'custos_produto_para_produtos_2026_08_24';

// Migração de DADOS (não de schema): copia SKU + custo de `custos_produto`
// (antiga tela "Custo & Margem", removida) para `produtos` (tela unificada
// "Produtos"), preservando os dados originais em custos_produto (nunca
// apagados). Roda só uma vez, guardada por `migracoes_aplicadas`:
//   - Se já existe um produto com o mesmo SKU (empresa+sku), o custo dele é
//     sobrescrito pelo valor de custos_produto — porque era essa a fonte
//     que já estava sendo usada de verdade no cálculo de margem até aqui;
//     preservar o valor antigo, não usado, de `produtos.custo` produziria
//     uma mudança silenciosa no resultado calculado das vendas.
//   - Se não existe produto nenhum com aquele SKU, cria um novo, usando o
//     próprio SKU como nome (não existe nome cadastrado em custos_produto
//     pra reaproveitar, e nome é obrigatório) — o usuário pode editar o
//     nome depois pela tela Produtos.
async function migrarCustosParaProdutos() {
  const { rows } = await pool.query(
    'SELECT 1 FROM migracoes_aplicadas WHERE nome = $1',
    [NOME_MIGRACAO_CUSTOS]
  );
  if (rows.length) return; // já aplicada neste banco — nunca repetir

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: custos } = await client.query('SELECT empresa_id, sku, custo FROM custos_produto');
    for (const c of custos) {
      await client.query(
        `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo)
         VALUES ($1, $2, $2, $3, TRUE)
         ON CONFLICT (empresa_id, sku) DO UPDATE SET custo = EXCLUDED.custo, updated_at = now()`,
        [c.empresa_id, c.sku, c.custo]
      );
    }
    await client.query('INSERT INTO migracoes_aplicadas (nome) VALUES ($1)', [NOME_MIGRACAO_CUSTOS]);
    await client.query('COMMIT');
    console.log(`[migrate] migração de dados aplicada: ${custos.length} SKU(s) de custos_produto migrados/atualizados em produtos.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema aplicado com sucesso.');
  await migrarCustosParaProdutos();
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
