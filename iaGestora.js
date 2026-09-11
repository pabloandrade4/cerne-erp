// IA Gestora — ativada em 2026 (ver docs/02-decisoes.md e
// docs/04-alteracoes.md). Reescrita em 25/08/2026 na tarefa "IA Gestora —
// central de análise", 3 passos pedidos pelo usuário:
//   1) Histórico de conversas salvo no banco (nunca só localStorage).
//   2) Respostas visuais (resumo/KPIs/tabela/gráfico) — ver lib/ia/estrutura.js.
//   3) Geração de planilha XLSX a partir dos mesmos dados da conversa — ver
//      lib/ia/planilhaAnalise.js.
//
// LOGIN REAL — por que existe aqui e só aqui: o pedido do usuário incluía
// "cada conversa deve respeitar usuário/permissões — um usuário não pode
// acessar conversa de outro", mas o ERP inteiro nunca teve login (a tabela
// `users` existia no banco desde a etapa "Empresas", sem nenhuma tela/rota
// de uso — ver docs/00-visao-geral.md). Perguntado, o usuário escolheu
// login real (e-mail/senha, sessão de verdade — ver lib/auth/) em vez de um
// identificador informal por navegador. Para respeitar "altere SOMENTE a
// área da IA Gestora" ao mesmo tempo, o recorte foi: login real existe,
// mas só é EXIGIDO para usar a IA Gestora (conversar e ver histórico) —
// nenhuma outra tela do ERP passou a pedir login nesta tarefa. Isso é
// suficiente pra cumprir o pedido literal (nenhum usuário acessa conversa
// de outro), mas não inclui uma permissão por empresa (que empresas um
// login pode ver) — isso não existe em NENHUMA tela do sistema hoje (nem
// nesta), documentado em docs/05-problemas-conhecidos.md.
//
// Para criar o primeiro (e os próximos) login: rode
// `node db/criarUsuarioIa.js "email@empresa.com" "SenhaForte123" "Nome"` no
// servidor (ver docs/06-proximos-passos.md).
const express = require('express');
const pool = require('../db/pool');
const { responderPergunta } = require('../lib/ia/orchestrator');
const { montarPlanilhaAnalise, formatarNomeArquivo } = require('../lib/ia/planilhaAnalise');
const { obterRadarParaEmpresa } = require('../lib/ia/radar');
const { verificarSenha } = require('../lib/auth/senha');
const { criarSessao, revogarSessao, SESSAO_DIAS } = require('../lib/auth/sessoes');
const { NOME_COOKIE, lerCookie, setarCookie, limparCookie } = require('../lib/auth/cookies');
const { exigirLogin } = require('../lib/auth/middleware');

const router = express.Router();

const HISTORICO_LIMITE_BANCO = 20; // bem acima do que o orquestrador realmente usa (8) — ver lib/ia/orchestrator.js#HISTORICO_MAX_MENSAGENS
const TITULO_PADRAO = 'Nova conversa';

// ---------------- Login (login real, escopo explicado acima) ----------------

// POST /api/ia-gestora/login  Body: { email, senha }
router.post('/login', async (req, res, next) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const senha = String((req.body && req.body.senha) || '');
    if (!email || !senha) return res.status(400).json({ error: 'Informe e-mail e senha.' });

    const { rows } = await pool.query('SELECT id, email, name, password_hash, ativo FROM users WHERE email = $1', [email]);
    // Mesma mensagem tanto pra "não existe" quanto pra "senha errada" — nunca
    // revela pra quem está tentando logar se o e-mail existe ou não.
    const credenciaisInvalidas = () => res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    if (!rows.length || !rows[0].ativo) return credenciaisInvalidas();
    if (!verificarSenha(senha, rows[0].password_hash)) return credenciaisInvalidas();

    const { token } = await criarSessao(rows[0].id);
    setarCookie(req, res, NOME_COOKIE, token, { maxAgeMs: SESSAO_DIAS * 24 * 60 * 60 * 1000 });
    res.json({ usuario: { id: rows[0].id, email: rows[0].email, nome: rows[0].name } });
  } catch (err) { next(err); }
});

// POST /api/ia-gestora/logout
router.post('/logout', async (req, res, next) => {
  try {
    const token = lerCookie(req, NOME_COOKIE);
    await revogarSessao(token);
    limparCookie(req, res, NOME_COOKIE);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/ia-gestora/me — usado pelo front-end pra saber, ao carregar a
// tela, se já existe uma sessão válida (cookie), sem forçar login de novo.
// Chama exigirLogin manualmente (em vez de como segundo argumento de
// router.get) de propósito — nenhuma outra rota deste projeto precisava,
// até agora, de mais de um handler por rota.
router.get('/me', (req, res, next) => {
  exigirLogin(req, res, () => res.json({ usuario: req.usuario })).catch(next);
});

// A partir daqui, TODA rota exige login — ver lib/auth/middleware.js.
router.use(exigirLogin);

async function buscarConversaDoUsuario(conversaId, usuarioId) {
  const { rows } = await pool.query(
    'SELECT id, empresa_id, usuario_id, titulo, criado_em, atualizado_em FROM ia_conversas WHERE id = $1',
    [conversaId]
  );
  if (!rows.length) return null;
  if (rows[0].usuario_id !== usuarioId) return 'proibido'; // existe, mas é de outro usuário — nunca revelar detalhe (ver rotas abaixo)
  return rows[0];
}

function serializeConversa(row) {
  return { id: row.id, titulo: row.titulo, empresaId: row.empresa_id, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em };
}

function serializeMensagem(row) {
  return {
    id: row.id,
    papel: row.papel,
    texto: row.texto,
    estrutura: row.estruturado || null,
    ferramentasUsadas: row.ferramentas_usadas || [],
    aviso: row.aviso || null,
    criadoEm: row.criado_em,
  };
}

// ---------------- Conversas ----------------

// GET /api/ia-gestora/conversas?empresaId=ID — lista as conversas do
// usuário LOGADO para a empresa selecionada, mais recente primeiro (mesmo
// índice de db/schema.sql#ia_conversas). Nunca traz conversa de outro
// usuário — o WHERE usuario_id abaixo não é opcional.
router.get('/conversas', async (req, res, next) => {
  try {
    const empresaId = Number(req.query.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query(
      `SELECT id, empresa_id, usuario_id, titulo, criado_em, atualizado_em
       FROM ia_conversas WHERE usuario_id = $1 AND empresa_id = $2
       ORDER BY atualizado_em DESC LIMIT 100`,
      [req.usuario.id, empresaId]
    );
    res.json({ conversas: rows.map(serializeConversa) });
  } catch (err) { next(err); }
});

// GET /api/ia-gestora/conversas/:id — conversa + todas as mensagens, na
// ordem em que aconteceram (pra "abrir uma conversa antiga e continuar de
// onde parou").
router.get('/conversas/:id', async (req, res, next) => {
  try {
    const conversa = await buscarConversaDoUsuario(Number(req.params.id), req.usuario.id);
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (conversa === 'proibido') return res.status(404).json({ error: 'Conversa não encontrada.' });

    const { rows: mensagens } = await pool.query(
      'SELECT id, papel, texto, estruturado, ferramentas_usadas, aviso, criado_em FROM ia_mensagens WHERE conversa_id = $1 ORDER BY criado_em ASC',
      [conversa.id]
    );
    res.json({ ...serializeConversa(conversa), mensagens: mensagens.map(serializeMensagem) });
  } catch (err) { next(err); }
});

// DELETE /api/ia-gestora/conversas/:id — apaga a conversa e (por ON DELETE
// CASCADE, ver db/schema.sql) todas as mensagens dela. Só o dono apaga —
// mesma checagem de ownership das outras rotas.
router.delete('/conversas/:id', async (req, res, next) => {
  try {
    const conversa = await buscarConversaDoUsuario(Number(req.params.id), req.usuario.id);
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (conversa === 'proibido') return res.status(404).json({ error: 'Conversa não encontrada.' });
    await pool.query('DELETE FROM ia_conversas WHERE id = $1', [conversa.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------- Radar da IA (acompanhamento contínuo — ver lib/ia/radar.js) ----------------

// GET /api/ia-gestora/radar-resumo?empresaId=ID — expõe pra tela da IA
// Gestora o resultado já PERSISTIDO do Radar (radar_alertas/radar_estado),
// gerado em background pelo ciclo automático (lib/ia/radarScheduler.js).
// Esta rota NUNCA dispara uma análise nova nem chama IA — só lê o que o
// último ciclo já calculou e salvou, exatamente como o painel de Visão
// Geral faz (lib/visaoGeralPainel.js). Mesmo formato de resposta de
// obterRadarParaEmpresa: { alertas, porSeveridade, contagem, resumoHoje,
// ultimaExecucaoEm, ultimaExecucaoOk }.
router.get('/radar-resumo', async (req, res, next) => {
  try {
    const empresaId = Number(req.query.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const radar = await obterRadarParaEmpresa(empresaId);
    res.json(radar);
  } catch (err) { next(err); }
});

// ---------------- Perguntar (cria conversa na primeira pergunta) ----------------

// POST /api/ia-gestora/perguntar
// Body: { empresaId, periodo, pergunta, conversaId? }
// `empresaId` e `periodo` são sempre os do cabeçalho (window.CerneFiltro no
// front-end) — nunca uma escolha do modelo de IA (ver comentário em
// lib/ia/ferramentas.js). Sem `conversaId`, cria uma conversa nova; com
// `conversaId`, continua a conversa existente — o histórico enviado ao
// modelo vem do BANCO (nunca de um array que o cliente mandou no corpo da
// requisição), pra nenhuma mensagem de outra conversa/usuário conseguir se
// misturar no contexto só porque o front-end mandou um `historico`
// adulterado.
router.post('/perguntar', async (req, res, next) => {
  try {
    const { empresaId, periodo, pergunta, conversaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!pergunta || !String(pergunta).trim()) return res.status(400).json({ error: 'Informe a pergunta.' });
    const perguntaTexto = String(pergunta).trim();

    let conversa = null;
    let historico = [];
    if (conversaId) {
      conversa = await buscarConversaDoUsuario(Number(conversaId), req.usuario.id);
      if (!conversa || conversa === 'proibido') return res.status(404).json({ error: 'Conversa não encontrada.' });
      if (conversa.empresa_id !== Number(empresaId)) {
        return res.status(400).json({ error: 'Esta conversa pertence a outra empresa selecionada.' });
      }
      const { rows: msgsAnteriores } = await pool.query(
        'SELECT papel, texto FROM ia_mensagens WHERE conversa_id = $1 ORDER BY criado_em DESC LIMIT $2',
        [conversa.id, HISTORICO_LIMITE_BANCO]
      );
      historico = msgsAnteriores.reverse();
    }

    const resultado = await responderPergunta({ empresaId, periodoChave: periodo, pergunta: perguntaTexto, historico });

    if (!conversa) {
      const tituloInicial = (resultado.estrutura && resultado.estrutura.titulo) || perguntaTexto.slice(0, 60);
      const { rows } = await pool.query(
        'INSERT INTO ia_conversas (empresa_id, usuario_id, titulo) VALUES ($1, $2, $3) RETURNING id, empresa_id, usuario_id, titulo, criado_em, atualizado_em',
        [Number(empresaId), req.usuario.id, tituloInicial || TITULO_PADRAO]
      );
      conversa = rows[0];
    } else if (resultado.estrutura && resultado.estrutura.titulo && conversa.titulo === TITULO_PADRAO) {
      // Conversa já existia com o título provisório (raro: primeira pergunta
      // não gerou card visual, a segunda gerou) — aproveita o título melhor
      // assim que a IA sugerir um.
      await pool.query('UPDATE ia_conversas SET titulo = $1 WHERE id = $2', [resultado.estrutura.titulo, conversa.id]);
      conversa.titulo = resultado.estrutura.titulo;
    }

    await pool.query('INSERT INTO ia_mensagens (conversa_id, papel, texto) VALUES ($1, $2, $3)', [conversa.id, 'usuario', perguntaTexto]);
    const { rows: assistenteRows } = await pool.query(
      `INSERT INTO ia_mensagens (conversa_id, papel, texto, estruturado, ferramentas_usadas, aviso)
       VALUES ($1, 'assistente', $2, $3, $4, $5) RETURNING id, criado_em`,
      [conversa.id, resultado.resposta, resultado.estrutura ? JSON.stringify(resultado.estrutura) : null, JSON.stringify(resultado.ferramentasUsadas || []), resultado.aviso || null]
    );
    await pool.query('UPDATE ia_conversas SET atualizado_em = now() WHERE id = $1', [conversa.id]);

    res.json({
      ...resultado,
      conversaId: conversa.id,
      tituloConversa: conversa.titulo,
      mensagemId: assistenteRows[0].id,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---------------- Planilha XLSX ----------------

// GET /api/ia-gestora/conversas/:id/mensagens/:mensagemId/xlsx — gera a
// planilha a partir do MESMO payload estruturado salvo junto da mensagem
// (nunca uma nova consulta ao ERP — ver comentário no topo de
// lib/ia/planilhaAnalise.js). 404 quando a mensagem não tem card visual
// (pergunta simples, sem apresentar_analise — nada pra exportar).
router.get('/conversas/:id/mensagens/:mensagemId/xlsx', async (req, res, next) => {
  try {
    const conversa = await buscarConversaDoUsuario(Number(req.params.id), req.usuario.id);
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (conversa === 'proibido') return res.status(404).json({ error: 'Conversa não encontrada.' });

    const { rows } = await pool.query(
      'SELECT id, estruturado FROM ia_mensagens WHERE id = $1 AND conversa_id = $2',
      [Number(req.params.mensagemId), conversa.id]
    );
    if (!rows.length || !rows[0].estruturado) {
      return res.status(404).json({ error: 'Esta mensagem não tem uma planilha disponível.' });
    }

    const estruturado = rows[0].estruturado;
    const workbook = montarPlanilhaAnalise(estruturado);
    const nomeArquivo = formatarNomeArquivo(estruturado.ferramentas, estruturado.periodo);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
