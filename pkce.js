// Geração de state (proteção CSRF) e do par PKCE (code_verifier/code_challenge)
// exigidos pelo fluxo OAuth do Mercado Livre.
const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateState() {
  return base64url(crypto.randomBytes(24));
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

module.exports = { generateState, generatePkce };
