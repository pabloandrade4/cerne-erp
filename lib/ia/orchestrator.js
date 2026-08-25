// IA Gestora — orquestrador da conversa (o "laço de ferramentas"). Ativado
// em 2026, primeira versão só de CONSULTA E ANÁLISE (ver docs/02-decisoes.md
// e docs/04-alteracoes.md para o desenho completo pedido pelo usuário, em 3
// passos).
//
// O que este arquivo faz, e por quê:
//   1) Recebe a pergunta + empresaId + período (do header, igual todo o
//      resto do ERP) + um histórico curto da conversa.
//   2) Manda pro provedor de IA configurado (lib/ia/providers/index.js) com
//      o catálogo de ferramentas (lib/ia/ferramentas.js) — cada ferramenta é
//      só uma casca fina sobre os dados reais já calculados pelo resto do
//      sistema, nunca uma conta nova.
//   3) Quando o modelo pede pra chamar uma ferramenta ("tool_use"), executa
//      de verdade contra o banco (via lib/ia/ferramentas.js) e devolve o
//      resultado pro modelo — só então ele pode afirmar um número.
//   4) Repete até o modelo responder com texto final, ou até um limite de
//      rodadas (proteção contra laço sem fim).
//
// Nunca lança um número: se o provedor não está configurado, falhar, ou
// exceder o limite de rodadas, este arquivo devolve uma resposta de chat
// normal explicando o que aconteceu (nunca um valor inventado, nunca uma
// exceção que quebra a tela de chat) — sempre registrado no log do servidor
// (console.log/console.error, nunca a chave de API).
const pool = require('../../db/pool');
const { diaBRT } = require('../periodo');
const { obterProvedorConfigurado } = require('./providers');
const { FERRAMENTAS_SCHEMA, criarContexto, executarFerramenta } = require('./ferramentas');

const MAX_RODADAS_FERRAMENTAS = 6;
const HISTORICO_MAX_MENSAGENS = 8; // 4 trocas (pergunta+resposta) — mantém o prompt enxuto.
const PERGUNTA_MAX_CHARS = 2000;

function montarSystemPrompt({ empresa, periodoCalc }) {
  const hoje = diaBRT(new Date());
  return [
    'Você é a IA Gestora do Cerne, um ERP de e-commerce/marketplace. Você conversa com o dono/gestor da empresa, sempre em português do Brasil, num tom direto e profissional.',
    '',
    'REGRAS QUE VOCÊ NUNCA PODE QUEBRAR:',
    '1. Você NUNCA responde um número (faturamento, margem, custo, saldo, quantidade etc.) sem antes chamar a ferramenta correspondente e usar exatamente o valor que ela devolveu. Nunca estime, arredonde "de cabeça" ou calcule por conta própria — as ferramentas já fazem a conta certa.',
    '2. Quando uma ferramenta devolver um campo com "disponivel": false (ou "valor": null), isso significa que o dado não pode ser calculado com segurança agora — normalmente porque falta custo cadastrado em algum pedido/SKU. Explique isso claramente ao usuário, citando a quantidade de pedidos/SKUs pendentes quando o campo trouxer esse número (ex: "Não consigo calcular isso com segurança porque 14 pedidos ainda estão sem custo cadastrado."). Nunca finja que o valor é zero nem estime um número aproximado. Quando "temPedidoNoPeriodo"/"disponivel" vier false mas o campo de pendências vier 0, é porque simplesmente não houve nenhum pedido nesse período — diga isso ("não houve venda no período") em vez de falar em dado faltando.',
    '3. Você é só de CONSULTA E ANÁLISE nesta primeira versão. Você NUNCA altera nada no sistema: não pode alterar custo, criar compra, pagar conta, alterar estoque, alterar anúncio, emitir nota fiscal, cancelar pedido nem modificar qualquer dado. Se o usuário pedir uma dessas ações, explique com clareza que você ainda não faz isso — só consulta e análise — e indique a tela do ERP onde a ação pode ser feita manualmente, quando fizer sentido.',
    '4. A empresa e o período já estão fixos pela seleção do cabeçalho do ERP (informados abaixo) — nunca pergunte qual empresa/período usar, nunca ofereça consultar outra empresa, e nunca troque de período sozinho no meio da conversa.',
    '5. Use as ferramentas disponíveis; se nenhuma ferramenta cobrir o que foi perguntado, diga isso com honestidade em vez de inventar uma resposta, e sugira uma das perguntas que você sabe responder.',
    '6. Respostas curtas e diretas — cite os valores em reais já formatados que as ferramentas devolvem. Use uma lista curta só quando estiver comparando vários itens (ex: ranking de produtos ou lojas); no resto, escreva em frases normais.',
    '',
    `Empresa selecionada: ${empresa.nome} (ID ${empresa.id}).`,
    `Período selecionado no cabeçalho: ${periodoCalc.label} (${diaBRT(periodoCalc.desde)} a ${diaBRT(new Date(periodoCalc.ate.getTime() - 1))}).`,
    `Hoje é ${hoje} (horário de Brasília).`,
  ].join('\n');
}

async function buscarEmpresa(empresaId) {
  const id = Number(empresaId);
  if (!id) return null;
  const { rows } = await pool.query('SELECT id, razao_social, nome_fantasia FROM empresas WHERE id = $1', [id]);
  if (!rows.length) return null;
  return { id: rows[0].id, nome: rows[0].nome_fantasia || rows[0].razao_social };
}

function normalizarHistorico(historico) {
  if (!Array.isArray(historico)) return [];
  return historico
    .filter((m) => m && m.texto && (m.papel === 'usuario' || m.papel === 'assistente'))
    .slice(-HISTORICO_MAX_MENSAGENS)
    .map((m) => ({ role: m.papel === 'assistente' ? 'assistant' : 'user', content: String(m.texto).slice(0, PERGUNTA_MAX_CHARS) }));
}

// `opts.provider`, quando informado, substitui o provedor configurado por
// variável de ambiente — usado só pelos testes automatizados (ver
// test/iaOrchestrator.test.js), pra testar o laço de ferramentas sem
// depender de rede/chave de API real neste ambiente de desenvolvimento (ver
// docs/05-problemas-conhecidos.md).
async function responderPergunta({ empresaId, periodoChave, pergunta, historico }, opts = {}) {
  const t0 = Date.now();

  const empresa = await buscarEmpresa(empresaId);
  if (!empresa) {
    const err = new Error('Empresa não encontrada.');
    err.status = 404;
    throw err;
  }

  const perguntaTexto = String(pergunta || '').trim();
  if (!perguntaTexto) {
    const err = new Error('Informe a pergunta.');
    err.status = 400;
    throw err;
  }
  if (perguntaTexto.length > PERGUNTA_MAX_CHARS) {
    const err = new Error(`Pergunta muito longa (máx. ${PERGUNTA_MAX_CHARS} caracteres).`);
    err.status = 400;
    throw err;
  }

  const ctx = criarContexto({ empresaId: empresa.id, periodoChave });
  const respostaBase = { empresa, periodo: { chave: ctx.periodoCalc.chave, label: ctx.periodoCalc.label } };

  const provedor = opts.provider || obterProvedorConfigurado();
  if (provedor.erro) {
    console.error('[ia gestora] ' + provedor.erro);
    return {
      ...respostaBase,
      resposta: 'A IA Gestora ainda não está configurada neste servidor. Peça para o administrador configurar a chave do provedor de IA (variável IA_API_KEY) no servidor.',
      ferramentasUsadas: [],
      aviso: 'nao_configurada',
    };
  }

  const system = montarSystemPrompt({ empresa, periodoCalc: ctx.periodoCalc });
  const mensagens = [...normalizarHistorico(historico), { role: 'user', content: perguntaTexto }];
  const ferramentasUsadas = [];

  try {
    for (let rodada = 1; rodada <= MAX_RODADAS_FERRAMENTAS; rodada++) {
      const resultado = await provedor.enviarMensagem({ system, mensagens, ferramentas: FERRAMENTAS_SCHEMA, maxTokens: 1200 });

      if (resultado.pararPor === 'tool_use') {
        const chamadas = (resultado.conteudo || []).filter((b) => b.type === 'tool_use');
        mensagens.push({ role: 'assistant', content: resultado.conteudo });

        const toolResults = [];
        for (const chamada of chamadas) {
          const saida = await executarFerramenta(chamada.name, chamada.input, ctx);
          ferramentasUsadas.push(chamada.name);
          toolResults.push({ type: 'tool_result', tool_use_id: chamada.id, content: JSON.stringify(saida) });
        }
        mensagens.push({ role: 'user', content: toolResults });
        continue;
      }

      const textoFinal = (resultado.conteudo || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      console.log(`[ia gestora] empresa=${empresa.id} periodo=${ctx.periodoCalc.chave} ferramentas=[${ferramentasUsadas.join(',')}] rodadas=${rodada} ${Date.now() - t0}ms`);
      return {
        ...respostaBase,
        resposta: textoFinal || 'Não consegui gerar uma resposta agora — tente reformular a pergunta.',
        ferramentasUsadas,
        aviso: null,
      };
    }

    console.error(`[ia gestora] empresa=${empresa.id} excedeu ${MAX_RODADAS_FERRAMENTAS} rodadas de ferramentas sem resposta final (pergunta="${perguntaTexto.slice(0, 120)}")`);
    return {
      ...respostaBase,
      resposta: 'Essa pergunta exigiu consultas demais e eu não consegui concluir — tente perguntar de um jeito mais direto, ou dividir em partes menores.',
      ferramentasUsadas,
      aviso: 'limite_rodadas',
    };
  } catch (err) {
    console.error('[ia gestora] erro ao consultar o provedor de IA: ' + (err && err.message));
    return {
      ...respostaBase,
      resposta: 'Não consegui falar com o provedor de IA agora' + (err && err.message ? ' (' + err.message + ')' : '') + '. Tente novamente em instantes.',
      ferramentasUsadas,
      aviso: 'erro_provedor',
    };
  }
}

module.exports = { responderPergunta, montarSystemPrompt, MAX_RODADAS_FERRAMENTAS, HISTORICO_MAX_MENSAGENS };
