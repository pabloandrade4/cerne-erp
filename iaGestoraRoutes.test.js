// Testes HTTP de /api/ia-gestora (Express real + Postgres real, provedor de
// IA mockado) — Passo 1 (histórico salvo no banco, por usuário) e Passo 3
// (planilha XLSX com os MESMOS dados da conversa) da tarefa "IA Gestora —
// central de análise" (ver docs/02-decisoes.md). Passo 2 (estrutura visual
// em si) já tem sua própria suíte, test/iaEstrutura.test.js — aqui o que
// importa é: login real funciona e isola por usuário, a conversa sobrevive
// a um "reinício do servidor" (é só Postgres — nunca em memória), e a
// planilha baixada bate byte a byte com o que a conversa mostrou.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { hashSenha } = require('../lib/auth/senha');
const { calcularPeriodo } = require('../lib/periodo');
const { resumirPeriodo, buscarPedidosDoPeriodo } = require('../lib/relatorioVendas');

function textoBlock(texto) { return { type: 'text', text: texto }; }
function toolUseBlock(id, name, input) { return { type: 'tool_use', id, name, input: input || {} }; }
function anthropicResposta(conteudo, pararPor) {
  return { content: conteudo, stop_reason: pararPor || 'end_turn', usage: null };
}

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900; // mesma empresa real (11 pedidos) já usada por test/iaOrchestrator.test.js

describe(
  'Rotas HTTP de /api/ia-gestora (Express real + Postgres real, provedor de IA mockado)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, server, baseUrl;
    let fetchOriginal;
    const USUARIO_A = { id: 981, email: 'usuaria-a@cerne.local', senha: 'SenhaDaUsuariaA1' };
    const USUARIO_B = { id: 982, email: 'usuario-b@cerne.local', senha: 'SenhaDoUsuarioB2' };

    function montarApp() {
      delete require.cache[require.resolve('../routes/iaGestora')];
      const express = require('express');
      const iaGestoraRouter = require('../routes/iaGestora');
      const app = express();
      app.use(express.json());
      app.use('/api/ia-gestora', iaGestoraRouter);
      return app;
    }

    before(async () => {
      if (!process.env.IA_API_KEY) process.env.IA_API_KEY = 'chave-de-teste-fake';
      pool = require('../db/pool');
      const app = montarApp();
      server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      await pool.query(
        `INSERT INTO users (id, email, password_hash, name, ativo) VALUES
           ($1, $2, $3, 'Usuária A', TRUE), ($4, $5, $6, 'Usuário B', TRUE)
         ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, ativo = TRUE`,
        [USUARIO_A.id, USUARIO_A.email, hashSenha(USUARIO_A.senha), USUARIO_B.id, USUARIO_B.email, hashSenha(USUARIO_B.senha)]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM ia_conversas WHERE usuario_id = ANY($1)', [[USUARIO_A.id, USUARIO_B.id]]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [[USUARIO_A.id, USUARIO_B.id]]);
      server.close();
      await pool.end();
    });

    beforeEach(() => { fetchOriginal = global.fetch; });
    afterEach(() => { global.fetch = fetchOriginal; });

    // fetch "roteador": chamada pra api.anthropic.com usa o mock (uma
    // resposta por chamada, em ordem); tudo mais (o servidor de teste local)
    // passa pro fetch real — mesmo padrão já usado em test/shopee.test.js.
    function mockAnthropic(respostas) {
      let i = 0;
      global.fetch = async (url, opts) => {
        const urlStr = String(url);
        if (urlStr.includes('api.anthropic.com')) {
          const corpo = respostas[Math.min(i, respostas.length - 1)];
          i++;
          return { ok: true, json: async () => corpo };
        }
        return fetchOriginal(url, opts);
      };
    }

    function extrairCookie(res) {
      const raw = res.headers.get('set-cookie') || '';
      return raw.split(';')[0];
    }

    async function login(usuario) {
      const res = await fetch(baseUrl + '/api/ia-gestora/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: usuario.email, senha: usuario.senha }),
      });
      assert.equal(res.status, 200);
      return extrairCookie(res);
    }

    test('login com senha errada e com e-mail inexistente: 401, mesma mensagem nos dois casos (nunca revela se o e-mail existe)', async () => {
      const r1 = await fetch(baseUrl + '/api/ia-gestora/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: USUARIO_A.email, senha: 'senha-errada' }) });
      const r2 = await fetch(baseUrl + '/api/ia-gestora/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nao-existe@cerne.local', senha: 'qualquer123' }) });
      assert.equal(r1.status, 401);
      assert.equal(r2.status, 401);
      const b1 = await r1.json(); const b2 = await r2.json();
      assert.equal(b1.error, b2.error);
    });

    test('login certo: seta cookie httpOnly; GET /me devolve o usuário; sem cookie, /me é 401', async () => {
      const meSemCookie = await fetch(baseUrl + '/api/ia-gestora/me');
      assert.equal(meSemCookie.status, 401);

      const cookie = await login(USUARIO_A);
      assert.match(cookie, /^cerne_ia_sessao=/);
      const me = await fetch(baseUrl + '/api/ia-gestora/me', { headers: { Cookie: cookie } });
      assert.equal(me.status, 200);
      const body = await me.json();
      assert.equal(body.usuario.email, USUARIO_A.email);
    });

    test('POST /perguntar sem login: 401, nunca chega a consultar a IA', async () => {
      mockAnthropic([anthropicResposta([textoBlock('nunca deveria chegar aqui')])]);
      const res = await fetch(baseUrl + '/api/ia-gestora/perguntar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Quanto vendi?' }),
      });
      assert.equal(res.status, 401);
    });

    test('pergunta simples (sem apresentar_analise): cria conversa, salva as 2 mensagens, estrutura fica null', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([anthropicResposta([textoBlock('Olá! Como posso ajudar?')])]);

      const res = await fetch(baseUrl + '/api/ia-gestora/perguntar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Oi' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.conversaId);
      assert.equal(body.estrutura, null);
      assert.equal(body.resposta, 'Olá! Como posso ajudar?');

      const { rows } = await pool.query('SELECT papel, texto FROM ia_mensagens WHERE conversa_id = $1 ORDER BY criado_em', [body.conversaId]);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].papel, 'usuario');
      assert.equal(rows[0].texto, 'Oi');
      assert.equal(rows[1].papel, 'assistente');
    });

    test('análise completa (produtos_por_caixa_desempenho + apresentar_analise): card visual, título vira o da conversa, e a PLANILHA baixada bate exatamente com os números da conversa', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([
        anthropicResposta([toolUseBlock('t1', 'produtos_por_caixa_desempenho', { ordenarPor: 'faturamento', limite: 5 })], 'tool_use'),
        anthropicResposta([
          toolUseBlock('t2', 'apresentar_analise', { tituloConversa: 'Análise de caixas', insights: ['Ranking consultado com sucesso.'] }),
        ], 'tool_use'),
        anthropicResposta([textoBlock('Segue a análise das caixas mais vendidas.')]),
      ]);

      const res = await fetch(baseUrl + '/api/ia-gestora/perguntar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Quais caixas mais faturaram?' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.estrutura, 'deveria ter card visual — apresentar_analise foi chamada');
      assert.equal(body.tituloConversa, 'Análise de caixas');

      // Confere a conversa salva no banco tem o título certo.
      const { rows: conv } = await pool.query('SELECT titulo FROM ia_conversas WHERE id = $1', [body.conversaId]);
      assert.equal(conv[0].titulo, 'Análise de caixas');

      // Baixa a planilha da mensagem do assistente e confere PARIDADE total
      // com o que veio na resposta da conversa — nunca uma segunda consulta
      // com números diferentes.
      const xlsxRes = await fetch(baseUrl + `/api/ia-gestora/conversas/${body.conversaId}/mensagens/${body.mensagemId}/xlsx`, { headers: { Cookie: cookie } });
      assert.equal(xlsxRes.status, 200);
      assert.equal(xlsxRes.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const disposition = xlsxRes.headers.get('content-disposition');
      assert.match(disposition, /^attachment; filename="relatorio-caixas-.*\.xlsx"$/);

      // O corpo (neste ambiente de dev, um retrato JSON — ver
      // node_modules/exceljs/index.js) tem que refletir exatamente a mesma
      // tabela mostrada na conversa.
      const bytes = await xlsxRes.arrayBuffer();
      const retrato = JSON.parse(Buffer.from(bytes).toString());
      const abaDados = retrato.find((s) => s.nome === 'Dados');
      assert.ok(abaDados, 'aba Dados deveria existir (a tabela tinha linhas)');
      // A primeira coluna de dados é "produtoBase" — confere que os mesmos
      // produtos/valores do card visual aparecem na planilha.
      const produtosDaTabela = body.estrutura.tabela.linhas.map((l) => l.produtoBase);
      const produtosDaPlanilha = abaDados.linhas.map((l) => l[0]);
      assert.deepEqual(produtosDaPlanilha, produtosDaTabela);
      const faturamentosDaTabela = body.estrutura.tabela.linhas.map((l) => l.faturamento);
      const faturamentosDaPlanilha = abaDados.linhas.map((l) => l[2]);
      assert.deepEqual(faturamentosDaPlanilha, faturamentosDaTabela);
    });

    test('pergunta sobre resumo_vendas: número na conversa é EXATAMENTE o mesmo já calculado por resumirPeriodo (fonte única — nunca um valor diferente)', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([
        anthropicResposta([toolUseBlock('t1', 'resumo_vendas', {})], 'tool_use'),
        anthropicResposta([
          toolUseBlock('t2', 'apresentar_analise', { insights: ['Faturamento consultado.'] }),
        ], 'tool_use'),
        anthropicResposta([textoBlock('Faturamento consultado com sucesso.')]),
      ]);
      const res = await fetch(baseUrl + '/api/ia-gestora/perguntar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Quanto faturei?' }),
      });
      const body = await res.json();
      const periodoCalc = calcularPeriodo('30d');
      const { pedidos } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde: periodoCalc.desde, ate: periodoCalc.ate });
      const esperado = resumirPeriodo(pedidos);
      const faturamentoKpi = body.estrutura.kpis.find((k) => k.label === 'Faturamento');
      assert.equal(faturamentoKpi.valor, esperado.faturamento.valor);
    });

    test('listar conversas: só as da empresa pedida, mais recente primeiro; abrir conversa antiga traz as mensagens em ordem ("continuar de onde parou")', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([anthropicResposta([textoBlock('Resposta 1')]), anthropicResposta([textoBlock('Resposta 2')])]);
      await fetch(baseUrl + '/api/ia-gestora/perguntar', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Primeira pergunta' }) });

      const listaRes = await fetch(baseUrl + '/api/ia-gestora/conversas?empresaId=' + EMPRESA_ID, { headers: { Cookie: cookie } });
      const lista = await listaRes.json();
      assert.ok(lista.conversas.length >= 1);
      const conversaId = lista.conversas[0].id;

      // Continua a MESMA conversa (conversaId), pergunta de novo.
      const res2 = await fetch(baseUrl + '/api/ia-gestora/perguntar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Segunda pergunta', conversaId }),
      });
      const body2 = await res2.json();
      assert.equal(body2.conversaId, conversaId, 'deveria continuar a mesma conversa, não criar outra');

      const abrirRes = await fetch(baseUrl + '/api/ia-gestora/conversas/' + conversaId, { headers: { Cookie: cookie } });
      const conversaAberta = await abrirRes.json();
      assert.equal(conversaAberta.mensagens.length, 4); // 2 perguntas + 2 respostas
      assert.equal(conversaAberta.mensagens[0].texto, 'Primeira pergunta');
      assert.equal(conversaAberta.mensagens[2].texto, 'Segunda pergunta');
    });

    test('isolamento por usuário: usuário B nunca vê, abre ou apaga conversa do usuário A', async () => {
      const cookieA = await login(USUARIO_A);
      mockAnthropic([anthropicResposta([textoBlock('Resposta privada da usuária A')])]);
      const resPerguntar = await fetch(baseUrl + '/api/ia-gestora/perguntar', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieA }, body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Pergunta privada' }) });
      const { conversaId } = await resPerguntar.json();

      const cookieB = await login(USUARIO_B);
      const listaB = await fetch(baseUrl + '/api/ia-gestora/conversas?empresaId=' + EMPRESA_ID, { headers: { Cookie: cookieB } }).then((r) => r.json());
      assert.ok(!listaB.conversas.some((c) => c.id === conversaId), 'a conversa da usuária A nunca pode aparecer na listagem do usuário B');

      const abrirB = await fetch(baseUrl + '/api/ia-gestora/conversas/' + conversaId, { headers: { Cookie: cookieB } });
      assert.equal(abrirB.status, 404, 'abrir a conversa de outro usuário direto pelo ID também tem que falhar');

      const apagarB = await fetch(baseUrl + '/api/ia-gestora/conversas/' + conversaId, { method: 'DELETE', headers: { Cookie: cookieB } });
      assert.equal(apagarB.status, 404);

      // A conversa da usuária A continua existindo (o usuário B não conseguiu apagar).
      const { rows } = await pool.query('SELECT id FROM ia_conversas WHERE id = $1', [conversaId]);
      assert.equal(rows.length, 1);
    });

    test('excluir conversa: a dona consegue apagar, e as mensagens somem junto (ON DELETE CASCADE)', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([anthropicResposta([textoBlock('Conversa que vai ser apagada')])]);
      const resPerguntar = await fetch(baseUrl + '/api/ia-gestora/perguntar', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Vou apagar essa' }) });
      const { conversaId } = await resPerguntar.json();

      const del = await fetch(baseUrl + '/api/ia-gestora/conversas/' + conversaId, { method: 'DELETE', headers: { Cookie: cookie } });
      assert.equal(del.status, 200);

      const abrir = await fetch(baseUrl + '/api/ia-gestora/conversas/' + conversaId, { headers: { Cookie: cookie } });
      assert.equal(abrir.status, 404);
      const { rows } = await pool.query('SELECT id FROM ia_mensagens WHERE conversa_id = $1', [conversaId]);
      assert.equal(rows.length, 0);
    });

    test('reconexão após "reiniciar o servidor": a conversa continua acessível num processo novo, só com o Postgres (nunca em memória)', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([anthropicResposta([textoBlock('Antes do reinício')])]);
      const resPerguntar = await fetch(baseUrl + '/api/ia-gestora/perguntar', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Antes de reiniciar' }) });
      const { conversaId } = await resPerguntar.json();

      // Simula reinício: fecha o servidor de teste, recarrega o módulo da
      // rota do zero (delete require.cache) e sobe outro — a sessão de
      // login (cookie) e a conversa continuam valendo porque nada estava em
      // memória, só no Postgres.
      await new Promise((resolve) => server.close(resolve));
      const appNovo = montarApp();
      server = await new Promise((resolve) => { const s = appNovo.listen(0, () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;

      const abrir = await fetch(baseUrl + '/api/ia-gestora/conversas/' + conversaId, { headers: { Cookie: cookie } });
      assert.equal(abrir.status, 200);
      const conversa = await abrir.json();
      assert.equal(conversa.mensagens[0].texto, 'Antes de reiniciar');
    });

    test('mensagem sem card visual não tem planilha pra baixar (404, nunca uma planilha vazia inventada)', async () => {
      const cookie = await login(USUARIO_A);
      mockAnthropic([anthropicResposta([textoBlock('Resposta simples, sem análise')])]);
      const resPerguntar = await fetch(baseUrl + '/api/ia-gestora/perguntar', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ empresaId: EMPRESA_ID, periodo: '30d', pergunta: 'Pergunta simples' }) });
      const { conversaId, mensagemId } = await resPerguntar.json();
      const xlsxRes = await fetch(baseUrl + `/api/ia-gestora/conversas/${conversaId}/mensagens/${mensagemId}/xlsx`, { headers: { Cookie: cookie } });
      assert.equal(xlsxRes.status, 404);
    });

    test('GET /radar-resumo: exige login e devolve o formato do Radar já persistido (nunca dispara um ciclo novo aqui)', async () => {
      const semLogin = await fetch(baseUrl + '/api/ia-gestora/radar-resumo?empresaId=' + EMPRESA_ID);
      assert.equal(semLogin.status, 401);

      const cookie = await login(USUARIO_A);
      const semEmpresaId = await fetch(baseUrl + '/api/ia-gestora/radar-resumo', { headers: { Cookie: cookie } });
      assert.equal(semEmpresaId.status, 400);

      const res = await fetch(baseUrl + '/api/ia-gestora/radar-resumo?empresaId=' + EMPRESA_ID, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.alertas));
      assert.ok(body.porSeveridade && 'critico' in body.porSeveridade && 'atencao' in body.porSeveridade && 'oportunidade' in body.porSeveridade && 'informativo' in body.porSeveridade);
      assert.ok(body.contagem && typeof body.contagem.total === 'number');
      assert.ok(Array.isArray(body.resumoHoje));
    });

    test('logout: cookie deixa de funcionar (sessão revogada de verdade, não só apagada no navegador)', async () => {
      const cookie = await login(USUARIO_A);
      const antes = await fetch(baseUrl + '/api/ia-gestora/me', { headers: { Cookie: cookie } });
      assert.equal(antes.status, 200);

      const logoutRes = await fetch(baseUrl + '/api/ia-gestora/logout', { method: 'POST', headers: { Cookie: cookie } });
      assert.equal(logoutRes.status, 200);

      const depois = await fetch(baseUrl + '/api/ia-gestora/me', { headers: { Cookie: cookie } });
      assert.equal(depois.status, 401);
    });
  }
);
