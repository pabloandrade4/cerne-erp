// Hash de senha — login real da IA Gestora (25/08/2026, ver docs/02-decisoes.md
// para o porquê deste recorte: login existe hoje só pra dar suporte ao
// histórico de conversas por usuário pedido pelo usuário nesta tarefa).
//
// Por que scrypt e não bcrypt: este ambiente de desenvolvimento não consegue
// instalar pacotes npm novos (sem acesso ao registro — ver
// docs/05-problemas-conhecidos.md); scrypt já vem embutido no módulo `crypto`
// do próprio Node desde a v10, então nenhuma dependência nova precisa entrar
// em package.json. É o mesmo algoritmo recomendado pelo próprio guia OWASP de
// hashing de senha quando bcrypt não está disponível.
//
// Formato armazenado em users.password_hash: "saltHex:hashHex" — nunca a
// senha original, nunca um hash reversível. O salt é único por senha
// (gerado a cada hashSenha) — duas contas com a mesma senha nunca produzem o
// mesmo password_hash.
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

function hashSenha(senhaPura) {
  if (!senhaPura || typeof senhaPura !== 'string') {
    throw new Error('Senha inválida.');
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(senhaPura, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

// Comparação em tempo constante (crypto.timingSafeEqual) — nunca um === de
// string, que vaza timing e poderia, em teoria, ajudar um ataque a adivinhar
// a senha certa byte a byte.
function verificarSenha(senhaPura, hashArmazenado) {
  if (!senhaPura || !hashArmazenado || typeof hashArmazenado !== 'string') return false;
  const partes = hashArmazenado.split(':');
  if (partes.length !== 2) return false;
  const [salt, hashEsperado] = partes;
  let hashCalculado;
  try {
    hashCalculado = crypto.scryptSync(senhaPura, salt, SCRYPT_KEYLEN).toString('hex');
  } catch (e) {
    return false;
  }
  const bufEsperado = Buffer.from(hashEsperado, 'hex');
  const bufCalculado = Buffer.from(hashCalculado, 'hex');
  if (bufEsperado.length !== bufCalculado.length) return false;
  return crypto.timingSafeEqual(bufEsperado, bufCalculado);
}

module.exports = { hashSenha, verificarSenha };
