// Middleware de login — usado só pelas rotas da IA Gestora (ver comentário
// no topo de routes/iaGestora.js e docs/02-decisoes.md para o porquê desse
// recorte: o ERP não tem login em nenhuma outra tela ainda, e esta tarefa
// pediu para alterar SOMENTE a área da IA Gestora).
const { validarSessao } = require('./sessoes');
const { NOME_COOKIE, lerCookie } = require('./cookies');

// Preenche req.usuario = { id, email, nome } quando a sessão é válida, ou
// responde 401 (nunca deixa passar sem usuário) quando não é. Mensagem
// sempre em português, amigável — o front-end usa exatamente esse
// `codigo` pra decidir mostrar a tela de login, nunca um erro genérico.
async function exigirLogin(req, res, next) {
  try {
    const token = lerCookie(req, NOME_COOKIE);
    const usuario = await validarSessao(token);
    if (!usuario) {
      return res.status(401).json({ error: 'Faça login para usar a IA Gestora.', codigo: 'nao_autenticado' });
    }
    req.usuario = usuario;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { exigirLogin };
