// Leitura/escrita de cookie sem dependência nova (mesma razão de sempre —
// sem acesso ao registro do npm neste ambiente de desenvolvimento, ver
// docs/05-problemas-conhecidos.md; não precisamos de `cookie-parser`, isso
// é só leitura/escrita de um único header HTTP). `req`/`res` aqui são o
// http.IncomingMessage/http.ServerResponse reais do Node (o Express deste
// projeto — real em produção, stub aqui — não substitui esses objetos, só
// acrescenta métodos a eles).
const NOME_COOKIE = 'cerne_ia_sessao';

function lerCookie(req, nome) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  const partes = header.split(';');
  for (const parte of partes) {
    const idx = parte.indexOf('=');
    if (idx === -1) continue;
    const chave = parte.slice(0, idx).trim();
    if (chave === nome) return decodeURIComponent(parte.slice(idx + 1).trim());
  }
  return null;
}

function setarCookie(req, res, nome, valor, { maxAgeMs } = {}) {
  const partes = [`${nome}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs) partes.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  // Secure só quando a requisição já chegou por HTTPS (produção, atrás do
  // proxy do Render) — em desenvolvimento local (http://localhost) o
  // navegador descartaria um cookie Secure, o que quebraria o login neste
  // ambiente. Mesma lógica de req.protocol já usada em routes/shopee.js.
  if (req.protocol === 'https') partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function limparCookie(req, res, nome) {
  res.setHeader('Set-Cookie', `${nome}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { NOME_COOKIE, lerCookie, setarCookie, limparCookie };
