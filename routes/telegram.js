// Avisos por Telegram — alternativa ao WhatsApp (routes/whatsapp.js), pedida
// pelo usuário em 21/09/2026. Router bem fino: quem manda de verdade é
// lib/telegram.js, disparado automaticamente pelo Radar da IA
// (lib/ia/radar.js#notificarTelegram) e pela Daily dos Agentes
// (lib/ia/dailyCiclo.js#executarDailyComNotificacao) — mesmo padrão já usado
// pro WhatsApp, lado a lado (os dois podem ficar configurados ao mesmo
// tempo, ou só um dos dois — nenhum depende do outro).
const express = require('express');
const { telegramConfigurado, enviarMensagemTelegram, listarChatsRecentes, registrarWebhook } = require('../lib/telegram');
const { responderPergunta } = require('../lib/ia/orchestrator');
const { resolverPeriodoDoTexto } = require('../lib/ia/telegramPeriodo');
const pool = require('../db/pool');

const router = express.Router();

// ---------------------------------------------------------------------
// Conversa de verdade pelo Telegram (pedido do usuário em 21/09/2026:
// "queria eu de pra mim pedir as coisas por lá, mesma coisa quando converso
// com a AI Gestora, é possível??"). Reaproveita o MESMO motor da IA Gestora
// (`responderPergunta`, lib/ia/orchestrator.js) — nenhuma regra financeira
// nova, nenhum cálculo novo, só um jeito diferente de entrar (Telegram em
// vez do site).
//
// Duas decisões tomadas com o usuário (AskUserQuestion, 21/09/2026):
//   1) Período: o Telegram não tem a telinha de escolher mês/período do
//      site — o usuário disse "EU SEMPRE VOU FALAR A DATA QUE QUERO
//      RELATÓRIOS", então lib/ia/telegramPeriodo.js lê a própria mensagem
//      pra descobrir o período (nunca inventa: quando não reconhece
//      nenhuma data, avisa isso na resposta e usa o mês atual).
//   2) Empresa: o usuário confirmou que usa só uma empresa no sistema — por
//      isso `buscarEmpresaUnica` abaixo pega sempre a primeira empresa
//      ativa cadastrada, sem precisar de nenhuma tela de escolha no
//      Telegram.
//
// Segurança: como o Telegram não tem login, a única trava é o próprio
// `TELEGRAM_CHAT_ID` já configurado (o mesmo usado pra mandar os avisos) —
// só mensagens vindas exatamente desse chat são respondidas; qualquer outro
// chat é ignorado (ver função `podeConversar` abaixo).
//
// Histórico da conversa: guardado só em memória (Map por chatId, reinicia a
// cada deploy/reinício do servidor) — de propósito, pra não duplicar o
// sistema de conversas por usuário logado da IA Gestora (`ia_conversas`),
// que não faz sentido aqui (Telegram não tem login). Suficiente pra
// perguntas de acompanhamento na mesma sessão (ex: "e comparado ao mês
// passado?").
const HISTORICO_MAX_MENSAGENS = 8;
const historicoPorChat = new Map();

function empurrarHistorico(chatId, papel, texto) {
  const lista = historicoPorChat.get(chatId) || [];
  lista.push({ papel, texto });
  while (lista.length > HISTORICO_MAX_MENSAGENS) lista.shift();
  historicoPorChat.set(chatId, lista);
}

function podeConversar(chatId) {
  const configurado = process.env.TELEGRAM_CHAT_ID;
  return Boolean(configurado) && String(chatId) === String(configurado);
}

// A única empresa ativa cadastrada (decisão confirmada com o usuário — ver
// comentário acima). Se um dia existir mais de uma empresa ativa, pega
// sempre a mais antiga (menor id) — nunca escolhe aleatoriamente.
async function buscarEmpresaUnica() {
  const { rows } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id ASC LIMIT 1');
  return rows.length ? rows[0].id : null;
}

const MENSAGEM_BOAS_VINDAS = 'Oi! Pode me perguntar sobre vendas, margem, estoque, contas a pagar/receber, Ads e outros números do sistema — igual você já faz na IA Gestora do site. Sempre diga o período que quer (ex: "hoje", "essa semana", "agosto", "de 01/08 a 15/08") — se eu não entender a data, eu aviso e uso o mês atual.';

// POST /api/integracoes/telegram/webhook — o Telegram chama esta rota toda
// vez que alguém manda mensagem pro bot (depois de GET /ativar-conversa ser
// chamada uma vez). Responde 200 pro Telegram IMEDIATAMENTE (antes de
// processar a pergunta) — a resposta de verdade é mandada à parte, via
// enviarMensagemTelegram, pra nunca depender do tempo que a IA demora pra
// responder nem arriscar o Telegram reenviar a mesma mensagem por timeout.
router.post('/webhook', (req, res) => {
  res.sendStatus(200);
  processarMensagemRecebida(req.body).catch((err) => {
    console.error('[telegram webhook] erro inesperado ao processar mensagem recebida: ' + (err && err.message));
  });
});

async function processarMensagemRecebida(update) {
  const msg = update && update.message;
  if (!msg || !msg.chat || msg.chat.id == null) return; // outro tipo de update (ex: edição de mensagem) — ignora
  const chatId = String(msg.chat.id);
  if (!podeConversar(chatId)) {
    // Não é o chat configurado pro dono do sistema — nunca responde com
    // dado nenhum da empresa pra ninguém fora desse chat.
    return;
  }

  const texto = (msg.text || '').trim();
  if (!texto) {
    await enviarMensagemTelegram('Por enquanto eu só entendo mensagens de texto — manda sua pergunta escrita, tipo "quanto vendi hoje?".');
    return;
  }
  if (texto === '/start' || texto.toLowerCase() === '/ajuda' || texto.toLowerCase() === '/help') {
    await enviarMensagemTelegram(MENSAGEM_BOAS_VINDAS);
    return;
  }

  try {
    const empresaId = await buscarEmpresaUnica();
    if (!empresaId) {
      await enviarMensagemTelegram('Não encontrei nenhuma empresa ativa cadastrada no sistema — cadastre uma empresa primeiro na tela Empresas do site.');
      return;
    }

    const periodo = resolverPeriodoDoTexto(texto);
    const historico = historicoPorChat.get(chatId) || [];
    empurrarHistorico(chatId, 'usuario', texto);

    const resultado = await responderPergunta({
      empresaId,
      periodoChave: periodo.periodoChave,
      desde: periodo.desde,
      ate: periodo.ate,
      pergunta: texto,
      historico,
    });

    empurrarHistorico(chatId, 'assistente', resultado.resposta);

    const respostaFinal = periodo.reconhecido
      ? resultado.resposta
      : `(não identifiquei uma data na sua mensagem, então usei ${periodo.descricaoUsada.replace(' (padrão, nenhuma data foi identificada na mensagem)', '')} — se quiser outro período, diga algo como "agosto" ou "de 01/08 a 15/08")\n\n${resultado.resposta}`;

    await enviarMensagemTelegram(respostaFinal);
  } catch (err) {
    console.error('[telegram webhook] erro ao responder pergunta: ' + (err && err.message));
    try {
      await enviarMensagemTelegram('Tive um problema pra responder agora — tenta de novo em instantes.');
    } catch (e2) { /* nunca deixa uma falha de envio derrubar o processamento */ }
  }
}

// GET /api/integracoes/telegram/ativar-conversa — registra a URL deste
// servidor no Telegram (setWebhook), pra ele passar a avisar o servidor
// sempre que alguém escrever pro bot. Só precisa ser aberta uma vez (e de
// novo só se o domínio do serviço mudar, o que não é o caso normalmente).
router.get('/ativar-conversa', async (req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return res.status(400).json({ ok: false, motivo: 'nao_configurado', mensagem: 'Configure TELEGRAM_BOT_TOKEN nas variáveis de ambiente do servidor antes de usar esta rota.' });
  }
  const urlWebhook = `${req.protocol}://${req.get('host')}/api/integracoes/telegram/webhook`;
  const resultado = await registrarWebhook(urlWebhook);
  res.status(resultado.ok ? 200 : 502).json(resultado);
});

// GET /api/integracoes/telegram/status — se TELEGRAM_BOT_TOKEN e
// TELEGRAM_CHAT_ID já foram configurados neste ambiente (nunca devolve os
// valores em si, só se existem).
router.get('/status', (req, res) => {
  res.json({ configurado: telegramConfigurado() });
});

// GET /api/integracoes/telegram/descobrir-chat-id — passo intermediário pra
// configurar: o usuário cria o bot, manda "oi" pra ele, e chama esta rota só
// com TELEGRAM_BOT_TOKEN já configurado (antes ainda de saber o CHAT_ID) —
// ela lê as mensagens recentes que o bot recebeu e devolve os chats
// encontrados, pra copiar o chatId certo.
router.get('/descobrir-chat-id', async (req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return res.status(400).json({ ok: false, motivo: 'nao_configurado', mensagem: 'Configure TELEGRAM_BOT_TOKEN nas variáveis de ambiente do servidor antes de usar esta rota.' });
  }
  const resultado = await listarChatsRecentes();
  if (!resultado.ok) return res.status(502).json(resultado);
  if (!resultado.chats.length) {
    return res.json({ ok: true, chats: [], mensagem: 'Nenhuma mensagem recebida ainda. Mande qualquer mensagem (ex: "oi") pro seu bot no Telegram e chame esta rota de novo.' });
  }
  res.json(resultado);
});

// GET /api/integracoes/telegram/testar — manda uma mensagem de teste pro
// chat configurado em TELEGRAM_CHAT_ID. Mesmo espírito de conveniência de
// GET /api/integracoes/whatsapp/testar (dá pra testar só abrindo o link no
// navegador).
router.get('/testar', async (req, res) => {
  if (!telegramConfigurado()) {
    return res.status(400).json({ enviado: false, motivo: 'nao_configurado', mensagem: 'Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nas variáveis de ambiente do servidor antes de testar.' });
  }
  const resultado = await enviarMensagemTelegram('✅ Teste do PF Embalagens: se você recebeu esta mensagem, os avisos automáticos do Radar da IA (Financeiro, Estoque, Ads, Margem) vão chegar por aqui a partir de agora.');
  res.status(resultado.enviado ? 200 : 502).json(resultado);
});

module.exports = router;
