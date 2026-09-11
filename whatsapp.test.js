// Avisos por WhatsApp (Twilio) — pedido do usuário em 11/09/2026. Testes
// SEM banco e SEM rede real: lib/whatsapp.js#enviarMensagemWhatsapp aceita
// um `fetchFn` injetado (mesmo padrão de injeção já usado em
// test/syncScheduler.test.js/test/ads.test.js para os watchdogs), então
// nenhum destes testes chama a Twilio de verdade.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { whatsappConfigurado, enviarMensagemWhatsapp } = require('../lib/whatsapp');
const { formatarMensagemWhatsapp } = require('../lib/ia/radar');

const ENV_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'TWILIO_WHATSAPP_TO'];

describe('lib/whatsapp — configuração e envio (Twilio, sem rede real)', () => {
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

  test('whatsappConfigurado(): false enquanto faltar QUALQUER uma das 4 variáveis', () => {
    assert.equal(whatsappConfigurado(), false);
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'tokenxxx';
    process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
    assert.equal(whatsappConfigurado(), false); // falta TWILIO_WHATSAPP_TO
    process.env.TWILIO_WHATSAPP_TO = '+5511999999999';
    assert.equal(whatsappConfigurado(), true);
  });

  test('enviarMensagemWhatsapp: sem configuração, devolve motivo="nao_configurado" e NUNCA chama a rede', async () => {
    let chamouFetch = false;
    const resultado = await enviarMensagemWhatsapp('teste', { fetchFn: async () => { chamouFetch = true; } });
    assert.equal(resultado.enviado, false);
    assert.equal(resultado.motivo, 'nao_configurado');
    assert.equal(chamouFetch, false);
  });

  test('enviarMensagemWhatsapp: configurado + Twilio responde 201 — devolve enviado=true e sid, monta a chamada certa (Basic Auth, From/To com prefixo whatsapp:, Body)', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'segredo123';
    process.env.TWILIO_WHATSAPP_FROM = '+14155238886'; // sem o prefixo — a função deve adicionar
    process.env.TWILIO_WHATSAPP_TO = 'whatsapp:+5511999999999'; // já com o prefixo — não deve duplicar

    let chamadaCapturada = null;
    const fetchFn = async (url, options) => {
      chamadaCapturada = { url, options };
      return {
        ok: true,
        status: 201,
        json: async () => ({ sid: 'SM_teste_123' }),
      };
    };

    const resultado = await enviarMensagemWhatsapp('🔴 Aviso de teste', { fetchFn });
    assert.equal(resultado.enviado, true);
    assert.equal(resultado.sid, 'SM_teste_123');

    assert.equal(chamadaCapturada.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(chamadaCapturada.options.method, 'POST');
    const authEsperado = 'Basic ' + Buffer.from('AC123:segredo123').toString('base64');
    assert.equal(chamadaCapturada.options.headers.Authorization, authEsperado);
    const params = new URLSearchParams(chamadaCapturada.options.body);
    assert.equal(params.get('From'), 'whatsapp:+14155238886');
    assert.equal(params.get('To'), 'whatsapp:+5511999999999'); // não duplicou o prefixo
    assert.equal(params.get('Body'), '🔴 Aviso de teste');
  });

  test('enviarMensagemWhatsapp: Twilio devolve erro (ex: número inválido) — nunca lança, devolve enviado=false com o motivo da Twilio', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'segredo123';
    process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
    process.env.TWILIO_WHATSAPP_TO = '+5511999999999';

    const fetchFn = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'The From phone number is not a valid, SMS-capable inbound phone number.' }),
    });

    const resultado = await enviarMensagemWhatsapp('teste', { fetchFn });
    assert.equal(resultado.enviado, false);
    assert.equal(resultado.motivo, 'erro_api');
    assert.match(resultado.detalhe, /From phone number/);
  });

  test('enviarMensagemWhatsapp: falha de rede (fetch lança) — nunca quebra quem chamou, devolve enviado=false', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'segredo123';
    process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
    process.env.TWILIO_WHATSAPP_TO = '+5511999999999';

    const fetchFn = async () => { throw new Error('ECONNRESET'); };
    const resultado = await enviarMensagemWhatsapp('teste', { fetchFn });
    assert.equal(resultado.enviado, false);
    assert.equal(resultado.motivo, 'erro_rede');
  });
});

describe('lib/ia/radar — formatarMensagemWhatsapp (montagem da mensagem, sem banco)', () => {
  test('junta todos os itens novos/escalados numa única mensagem, com prioridade, valor e recomendação', () => {
    const empresa = { id: 999, nome: 'Loja Teste LTDA' };
    const itens = [
      {
        severidade: 'critico', titulo: 'Conta vencida', descricao: 'R$ 1.234,56 em atraso.',
        dados: { valorEnvolvido: 1234.56 }, recomendacaoPadrao: 'Regularize o quanto antes.',
      },
      {
        severidade: 'oportunidade', titulo: 'Produto X crescendo', descricao: 'Vendas subiram 20%.',
        dados: {}, recomendacaoIA: 'Considere aumentar o estoque deste SKU.',
      },
    ];
    const texto = formatarMensagemWhatsapp(empresa, itens);

    assert.match(texto, /2 novos avisos/);
    assert.match(texto, /Loja Teste LTDA/);
    assert.match(texto, /Conta vencida/);
    assert.match(texto, /R\$ 1\.234,56/);
    assert.match(texto, /Regularize o quanto antes\./);
    assert.match(texto, /Produto X crescendo/);
    assert.match(texto, /Considere aumentar o estoque deste SKU\./); // usa recomendacaoIA quando existir, não a padrão
    assert.match(texto, /#alerts/);
  });

  test('singular correto quando é só 1 item', () => {
    const empresa = { id: 999, nome: 'Loja Teste LTDA' };
    const itens = [{ severidade: 'atencao', titulo: 'X', descricao: 'Y', dados: {}, recomendacaoPadrao: 'Z' }];
    const texto = formatarMensagemWhatsapp(empresa, itens);
    assert.match(texto, /1 novo aviso para/);
  });
});
