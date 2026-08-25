// Script de linha de comando pra criar (ou trocar a senha de) um login da
// IA Gestora — não existe tela de "criar usuário" nesta etapa (fora do
// escopo pedido: só a IA Gestora, não um módulo de gestão de usuários), por
// isso o jeito de criar o primeiro (e os próximos) login é rodando este
// script direto no servidor, o mesmo padrão já usado neste projeto pra
// gerar a chave de criptografia (ex: SHOPEE_TOKEN_KEY em
// docs/06-proximos-passos.md).
//
// Uso (no shell do Render, ou localmente com DATABASE_URL configurada):
//   node db/criarUsuarioIa.js "email@empresa.com" "SenhaForte123" "Nome da pessoa"
//
// Rodar de novo com o mesmo e-mail troca a senha (upsert) — não cria um
// segundo usuário duplicado.
const pool = require('./pool');
const { hashSenha } = require('../lib/auth/senha');

async function main() {
  const [, , email, senha, nome] = process.argv;
  if (!email || !senha) {
    console.error('Uso: node db/criarUsuarioIa.js "email@empresa.com" "SenhaForte123" "Nome (opcional)"');
    process.exitCode = 1;
    return;
  }
  if (senha.length < 8) {
    console.error('A senha precisa ter pelo menos 8 caracteres.');
    process.exitCode = 1;
    return;
  }
  const emailNormalizado = String(email).trim().toLowerCase();
  const hash = hashSenha(senha);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, ativo)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = COALESCE(EXCLUDED.name, users.name), ativo = TRUE
     RETURNING id, email, name`,
    [emailNormalizado, hash, nome || null]
  );
  console.log(`Login pronto: #${rows[0].id} ${rows[0].email}${rows[0].name ? ' (' + rows[0].name + ')' : ''}`);
  await pool.end();
}

main().catch((err) => {
  console.error('Falha ao criar usuário:', err.message);
  process.exitCode = 1;
});
