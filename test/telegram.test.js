// Avisos por Telegram — alternativa ao WhatsApp, pedida pelo usuário em
// 21/09/2026. Mesmo padrão de test/whatsapp.test.js: testes SEM banco e SEM
// rede real, injetando `fetchFn` em lib/telegram.js.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { telegramConfigurado, enviarMensagemTelegram, listarChatsRecentes } = require('../lib/telegram');

const ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

describe('lib/telegram — configuração e envio (sem rede real)', () => {
  let backup;

  beforeEach(() => {
    backup = {};
    ENV_VARS.forEach((k) => { backup[k] = process.env[k]; delete process.env[k]; });
  });

  afterEach(() => {
    ENV_VARS.forEach((k) => {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    });
  });

  test('telegramConfigurado(): false enquanto faltar QUALQUER uma das 2 variáveis', () => {
    assert.equal(telegramConfigurado(), false);
    process.env.TELEGRAM_BOT_TOKEN = '123456:AAtoken';
    assert.equal(telegramConfigurado(), false); // falta TELEGRAM_CHAT_ID
    process.env.TELEGRAM_CHAT_ID = '987654321';
    assert.equal(telegramConfigurado(), true);
  });

  test('enviarMensagemTelegram: sem configuração, devolve motivo="nao_configurado" e NUNCA chama a rede', async () => {
    let chamouFetch = false;
    const resultado = await enviarMensagemTelegram('teste', { fetchFn: async () => { chamouFetch = true; } });
    assert.equal(resultado.enviado, false);
    assert.equal(resultado.motivo, 'nao_configurado');
    assert.equal(chamouFetch, false);
  });

  test('enviarMensagemTelegram: configurado + Telegram responde ok — devolve enviado=true, monta a chamada certa (URL com token, chat_id, texto sem asteriscos)', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:AAtoken';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    let chamadaCapturada = null;
    const fetchFn = async (url, options) => {
      chamadaCapturada = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    };

    const resultado = await enviarMensagemTelegram('🔴 *Aviso* de teste', { fetchFn });
    assert.equal(resultado.enviado, true);
    assert.equal(resultado.messageId, 42);

    assert.equal(chamadaCapturada.url, 'https://api.telegram.org/bot123456:AAtoken/sendMessage');
    assert.equal(chamadaCapturada.options.method, 'POST');
    const corpo = JSON.parse(chamadaCapturada.options.body);
    assert.equal(corpo.chat_id, '987654321');
    assert.equal(corpo.text, '🔴 Aviso de teste'); // asteriscos de negrito do WhatsApp removidos
  });

  test('enviarMensagemTelegram: Telegram devolve ok=false (ex: chat não encontrado) — nunca lança, devolve enviado=false com o motivo', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:AAtoken';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    });

    const resultado = await enviarMensagemTelegram('teste', { fetchFn });
    assert.equal(resultado.enviado, false);
    assert.equal(resultado.motivo, 'erro_api');
    assert.match(resultado.detalhe, /chat not found/);
  });

  test('enviarMensagemTelegram: falha de rede (fetch lança) — nunca quebra quem chamou, devolve enviado=false', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:AAtoken';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    const fetchFn = async () => { throw new Error('ECONNRESET'); };
    const resultado = await enviarMensagemTelegram('teste', { fetchFn });
    assert.equal(resultado.enviado, false);
    assert.equal(resultado.motivo, 'erro_rede');
  });

  test('enviarMensagemTelegram: mensagem maior que o limite do Telegram é cortada, nunca falha por tamanho', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:AAtoken';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    let corpoCapturado = null;
    const fetchFn = async (url, options) => {
      corpoCapturado = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };

    const textoGigante = 'A'.repeat(5000);
    const resultado = await enviarMensagemTelegram(textoGigante, { fetchFn });
    assert.equal(resultado.enviado, true);
    assert.ok(corpoCapturado.text.length <= 4096);
    assert.match(corpoCapturado.text, /mensagem cortada/);
  });
});

describe('lib/telegram — listarChatsRecentes (descobrir o TELEGRAM_CHAT_ID, sem rede real)', () => {
  let backup;
  beforeEach(() => { backup = process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_BOT_TOKEN; });
  afterEach(() => {
    if (backup === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = backup;
  });

  test('sem TELEGRAM_BOT_TOKEN configurado, devolve ok=false sem chamar rede', async () => {
    let chamouFetch = false;
    const resultado = await listarChatsRecentes({ fetchFn: async () => { chamouFetch = true; } });
    assert.equal(resultado.ok, false);
    assert.equal(resultado.motivo, 'nao_configurado');
    assert.equal(chamouFetch, false);
  });

  test('devolve os chats únicos encontrados nas mensagens recentes recebidas pelo bot', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:AAtoken';
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        result: [
          { message: { chat: { id: 111, first_name: 'Pablo' } } },
          { message: { chat: { id: 111, first_name: 'Pablo' } } }, // repetido, não deve duplicar
          { message: { chat: { id: 222, title: 'Grupo Vendas' } } },
        ],
      }),
    });
    const resultado = await listarChatsRecentes({ fetchFn });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.chats.length, 2);
    assert.deepEqual(resultado.chats[0], { chatId: 111, nome: 'Pablo' });
    assert.deepEqual(resultado.chats[1], { chatId: 222, nome: 'Grupo Vendas' });
  });
});
