// Criptografia dos tokens da Shopee antes de salvar no banco. Mesmo
// algoritmo já usado para o Mercado Livre (lib/crypto.js — AES-256-GCM),
// mas com uma CHAVE PRÓPRIA (SHOPEE_TOKEN_KEY, nunca ML_TOKEN_KEY): assim,
// uma chave nunca depende da outra, e nenhum segredo de um marketplace fica
// exposto se o outro precisar ser rotacionado. Nunca guardamos access_token/
// refresh_token em texto puro, e o front-end nunca recebe esses valores —
// só metadados (status, expiração, última atualização).
//
// Este arquivo é uma cópia deliberada de lib/crypto.js (não uma dependência
// dele) — por pedido do usuário de "preservar tudo que já está funcionando
// com Mercado Livre", lib/crypto.js não foi tocado nesta etapa.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const raw = process.env.SHOPEE_TOKEN_KEY;
  if (!raw) {
    throw new Error('SHOPEE_TOKEN_KEY não configurada no ambiente — necessária para criptografar tokens da Shopee.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SHOPEE_TOKEN_KEY inválida: esperado 32 bytes em base64.');
  }
  return key;
}

function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decrypt(payloadBase64) {
  const key = getKey();
  const buf = Buffer.from(payloadBase64, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Gera uma chave nova (32 bytes em base64) — usado só para provisionar SHOPEE_TOKEN_KEY uma vez. */
function generateKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { encrypt, decrypt, generateKey };
