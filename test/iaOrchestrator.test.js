// Testes do orquestrador da IA Gestora (lib/ia/orchestrator.js) — o laço de
// ferramentas em si, testado com um provedor FALSO (sem depender de uma
// IA_API_KEY real de produção). A tradução HTTP real
// (lib/ia/providers/anthropic.js) tem sua própria suíte,
// test/iaAnthropicProvider.test.js — incluindo um teste de integração AO
// VIVO contra api.anthropic.com (confirmado na correção de 25/08/2026 que
// este servidor CONSEGUE alcançar a API real; só falta uma chave de
// produção válida, que só o usuário pode gerar — ver
// docs/05-problemas-conhecidos.md).
//
// O que importa testar aqui não é "a IA respondeu certo" (isso depende do
// modelo de verdade, fora do nosso controle) — é que o ORQUESTRADOR nunca
// deixa passar um número que não veio de uma ferramenta, sempre executa a
// ferramenta pedida contra o banco real (nunca confia em dado que o
// "modelo" tentar embutir no input), sempre respeita empresa/período do
// contexto (nunca o que o modelo pediria), e nunca quebra a tela de chat
// quando o provedor falha ou não está configurado.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { responderPergunta, MAX_RODADAS_FERRAMENTAS, HISTORICO_MAX_MENSAGENS } = require('../lib/ia/orchestrator');
const { resumirPeriodo, buscarPedidosDoPeriodo } = require('../lib/relatorioVendas');
const { calcularPeriodo } = require('../lib/periodo');

function textoBlock(texto) { return { type: 'text', text: texto }; }
function toolUseBlock(id, name, input) { return { type: 'tool_use', id, name, input: input || {} }; }

// Provedor falso: devolve, em ordem, uma resposta por chamada (a última
// resposta da lista se repete se o laço chamar mais vezes que o esperado —
// útil pro teste de "excedeu o limite de rodadas").
function criarProvedorFalso(respostas) {
  const chamadas = [];
  return {
    chamadas,
    async enviarMensagem(params) {
      chamadas.push(params);
      const resposta = respostas[Math.min(chamadas.length - 1, respostas.length - 1)];
      if (resposta instanceof Error) throw resposta;
      return typeof resposta === 'function' ? resposta(params) : resposta;
    },
  };
}

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_REAL_ID = 900; // já seedada por outros testes (11 pedidos reais)

describe(
  'ia/orchestrator — laço de ferramentas (provedor falso, sem rede)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado (ver relatorioVendas.integration.test.js)' },
  () => {
    let pool;
    before(async () => { pool = require('../db/pool'); });
    after(async () => { await pool.end(); });

    test('empresa inexistente: nunca chama o provedor, erro 404', async () => {
      const provider = criarProvedorFalso([{ conteudo: [textoBlock('nunca deveria chegar aqui')], pararPor: 'end_turn' }]);
      await assert.rejects(
        () => responderPergunta({ empresaId: 999999, periodoChave: '30d', pergunta: 'Quanto vendi hoje?' }, { provider }),
        (err) => { assert.equal(err.status, 404); return true; }
      );
      assert.equal(provider.chamadas.length, 0, 'nunca deveria ter chamado o provedor pra uma empresa que não existe');
    });

    test('pergunta vazia: erro 400, nunca chama o provedor', async () => {
      const provider = criarProvedorFalso([{ conteudo: [textoBlock('x')], pararPor: 'end_turn' }]);
      await assert.rejects(
        () => responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: '   ' }, { provider }),
        (err) => { assert.equal(err.status, 400); return true; }
      );
      assert.equal(provider.chamadas.length, 0);
    });

    test('resposta direta (sem ferramenta): devolve o texto final e empresa/período corretos', async () => {
      const provider = criarProvedorFalso([{ conteudo: [textoBlock('Olá! Como posso ajudar?')], pararPor: 'end_turn' }]);
      const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes', pergunta: 'Oi' }, { provider });
      assert.equal(resultado.resposta, 'Olá! Como posso ajudar?');
      assert.deepEqual(resultado.ferramentasUsadas, []);
      assert.equal(resultado.empresa.id, EMPRESA_REAL_ID);
      assert.equal(resultado.periodo.chave, 'mes');
      assert.equal(resultado.aviso, null);
    });

    test('pede 1 ferramenta e depois responde: executa de verdade contra o banco (nunca um valor inventado pelo "modelo")', async () => {
      const provider = criarProvedorFalso([
        { conteudo: [toolUseBlock('t1', 'resumo_vendas', {})], pararPor: 'tool_use' },
        { conteudo: [textoBlock('O faturamento do período foi consultado com sucesso.')], pararPor: 'end_turn' },
      ]);
      const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Quanto vendi?' }, { provider });

      assert.deepEqual(resultado.ferramentasUsadas, ['resumo_vendas']);
      assert.equal(resultado.resposta, 'O faturamento do período foi consultado com sucesso.');

      // A 2ª chamada ao provedor recebeu o tool_result — e o valor dentro
      // dele é EXATAMENTE o mesmo de resumirPeriodo (fonte única), provando
      // que o número veio do banco, não do "modelo".
      const segundaChamada = provider.chamadas[1];
      const toolResultMsg = segundaChamada.mensagens.find((m) => Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
      const conteudo = JSON.parse(toolResultMsg.content[0].content);
      const periodoCalc = calcularPeriodo('30d');
      const { pedidos } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: periodoCalc.desde, ate: periodoCalc.ate });
      const esperado = resumirPeriodo(pedidos);
      assert.equal(conteudo.faturamento.valor, esperado.faturamento.valor);
    });

    test('ignora qualquer empresaId que o "modelo" tente embutir no input da ferramenta — sempre usa a empresa do contexto', async () => {
      const OUTRA_EMPRESA_ID = 962; // empresa vazia usada por outros testes — números bem diferentes de 900
      const provider = criarProvedorFalso([
        { conteudo: [toolUseBlock('t1', 'resumo_vendas', { empresaId: OUTRA_EMPRESA_ID, periodo: 'hoje' })], pararPor: 'tool_use' },
        { conteudo: [textoBlock('ok')], pararPor: 'end_turn' },
      ]);
      const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Quanto vendi?' }, { provider });

      const segundaChamada = provider.chamadas[1];
      const toolResultMsg = segundaChamada.mensagens.find((m) => Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
      const conteudo = JSON.parse(toolResultMsg.content[0].content);
      const periodoCalc = calcularPeriodo('30d');
      const { pedidos } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: periodoCalc.desde, ate: periodoCalc.ate });
      const esperado = resumirPeriodo(pedidos);
      assert.equal(conteudo.faturamento.valor, esperado.faturamento.valor, 'deveria ter usado a empresa 900 (do header), nunca a 962 que o input tentou embutir');
      assert.equal(resultado.empresa.id, EMPRESA_REAL_ID);
    });

    test('excede o limite de rodadas de ferramentas: nunca trava, devolve aviso claro', async () => {
      const provider = criarProvedorFalso([
        { conteudo: [toolUseBlock('t1', 'resumo_vendas', {})], pararPor: 'tool_use' }, // sempre pede ferramenta, nunca conclui
      ]);
      const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Pergunta difícil' }, { provider });
      assert.equal(resultado.aviso, 'limite_rodadas');
      assert.equal(provider.chamadas.length, MAX_RODADAS_FERRAMENTAS);
      assert.equal(resultado.ferramentasUsadas.length, MAX_RODADAS_FERRAMENTAS);
    });

    test('provedor falha sem categoria (erro genérico simulado): nunca lança exceção pro chamador, devolve mensagem amigável genérica — NUNCA o texto técnico bruto', async () => {
      const erroTecnicoBruto = 'Tempo limite (45s) excedido ao chamar o provedor de IA — detalhe interno que o usuário nunca deveria ver.';
      const provider = criarProvedorFalso([new Error(erroTecnicoBruto)]);
      const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Quanto vendi?' }, { provider });
      assert.equal(resultado.aviso, 'erro_provedor');
      assert.equal(resultado.avisoCategoria, 'erro_desconhecido');
      assert.ok(resultado.resposta.toLowerCase().includes('não consegui'));
      assert.ok(!resultado.resposta.includes(erroTecnicoBruto), 'a mensagem crua do erro NUNCA pode aparecer pro usuário — só nos logs');
    });

    // Uma pra cada categoria pedida explicitamente pelo usuário (chave
    // inválida, falta de crédito, limite de uso, erro de conexão, provedor
    // indisponível) — confere que cada uma vira uma mensagem clara e
    // DIFERENTE das outras, e que o texto técnico bruto nunca vaza.
    [
      { categoria: 'chave_invalida', tecnico: 'invalid x-api-key' },
      { categoria: 'sem_credito', tecnico: 'your account has insufficient credit balance' },
      { categoria: 'limite_uso', tecnico: 'rate limit exceeded, retry after 30s' },
      { categoria: 'erro_conexao', tecnico: 'fetch failed: ECONNRESET' },
      { categoria: 'provedor_indisponivel', tecnico: 'internal server error, upstream connect error' },
    ].forEach(({ categoria, tecnico }) => {
      test(`provedor falha com categoria "${categoria}": mensagem clara e específica, nunca o texto técnico ("${tecnico}")`, async () => {
        const erro = new Error(tecnico);
        erro.categoria = categoria;
        erro.status = 500;
        const provider = criarProvedorFalso([erro]);
        const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Quanto vendi?' }, { provider });
        assert.equal(resultado.aviso, 'erro_provedor');
        assert.equal(resultado.avisoCategoria, categoria);
        assert.ok(!resultado.resposta.includes(tecnico), 'texto técnico bruto nunca pode aparecer pro usuário');
        assert.ok(resultado.resposta.length > 10);
      });
    });

    test('as 5 categorias de erro pedidas pelo usuário produzem 5 mensagens de usuário DIFERENTES entre si', () => {
      const { mensagemAmigavel } = require('../lib/ia/orchestrator');
      const categorias = ['chave_invalida', 'sem_credito', 'limite_uso', 'erro_conexao', 'provedor_indisponivel'];
      const mensagens = categorias.map(mensagemAmigavel);
      assert.equal(new Set(mensagens).size, mensagens.length, 'cada categoria deveria ter uma mensagem própria, não um texto genérico repetido');
    });

    test('sem IA_API_KEY configurada (provedor padrão real, sem injeção): avisa claramente, nunca quebra', async () => {
      const chaveOriginal = process.env.IA_API_KEY;
      delete process.env.IA_API_KEY;
      try {
        const resultado = await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Quanto vendi?' });
        assert.equal(resultado.aviso, 'nao_configurada');
        assert.ok(resultado.resposta.toLowerCase().includes('não'));
      } finally {
        if (chaveOriginal !== undefined) process.env.IA_API_KEY = chaveOriginal;
      }
    });

    test('histórico é limitado (nunca manda a conversa inteira pro provedor)', async () => {
      const historico = Array.from({ length: 20 }, (_, i) => ({ papel: i % 2 === 0 ? 'usuario' : 'assistente', texto: 'mensagem ' + i }));
      const provider = criarProvedorFalso([{ conteudo: [textoBlock('ok')], pararPor: 'end_turn' }]);
      await responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'Nova pergunta', historico }, { provider });

      const primeiraChamada = provider.chamadas[0];
      // HISTORICO_MAX_MENSAGENS do histórico + 1 (a pergunta atual).
      assert.ok(primeiraChamada.mensagens.length <= HISTORICO_MAX_MENSAGENS + 1);
    });

    test('pergunta longa demais (> 2000 caracteres): erro 400, nunca chama o provedor', async () => {
      const provider = criarProvedorFalso([{ conteudo: [textoBlock('x')], pararPor: 'end_turn' }]);
      await assert.rejects(
        () => responderPergunta({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d', pergunta: 'a'.repeat(2001) }, { provider }),
        (err) => { assert.equal(err.status, 400); return true; }
      );
      assert.equal(provider.chamadas.length, 0);
    });
  }
);
