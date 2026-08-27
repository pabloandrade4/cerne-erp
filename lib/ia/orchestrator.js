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
const { montarEstrutura } = require('./estrutura');

// Aumentado de 6 pra 10 na tarefa "IA Gestora como inteligência central"
// (docs/02-decisoes.md): um "resumo executivo"/relatório completo agora
// pode precisar combinar bem mais ferramentas de uma vez (vendas + DRE +
// produtos + Ads + contas a pagar/receber + alertas) — cada RODADA já
// permite várias chamadas de ferramenta em paralelo (o modelo pode pedir
// vários tool_use num único turno), então isso é uma proteção contra laço
// sem fim, não um limite realista de quantas ferramentas uma pergunta usa.
const MAX_RODADAS_FERRAMENTAS = 10;
// Aumentado de 8 pra 12 na Etapa (b) da tarefa "IA Gestora que conhece o
// negócio" (27/08/2026, ver docs/02-decisoes.md): com o novo mecanismo de
// "produto em foco" (ver `produtoEmFoco` abaixo), uma conversa de
// acompanhamento sobre o mesmo produto tende a durar mais rodadas — 12
// mensagens (6 trocas) ainda cabe folgadamente dentro do que
// HISTORICO_LIMITE_BANCO (routes/iaGestora.js, 20) já busca do banco, então
// nenhuma mudança é necessária ali.
const HISTORICO_MAX_MENSAGENS = 12;
const PERGUNTA_MAX_CHARS = 2000;

// Mensagem amigável por categoria de erro (nunca o texto técnico bruto do
// provedor — esse vai só pro log, ver catch abaixo). Categoria vem de
// `err.categoria`, atribuída em lib/ia/providers/anthropic.js a partir do
// status HTTP real (tabela oficial da API de Mensagens da Anthropic).
const MENSAGEM_POR_CATEGORIA = {
  chave_invalida: 'Não consegui falar com o provedor de IA — a chave configurada parece inválida, revogada ou sem permissão para este recurso. Peça para o administrador conferir a variável IA_API_KEY no servidor.',
  sem_credito: 'Não consegui falar com o provedor de IA — a conta está com um problema de cobrança ou saldo insuficiente. Peça para o administrador verificar o faturamento da conta do provedor de IA.',
  limite_uso: 'Não consegui falar com o provedor de IA agora — o limite de uso foi atingido. Tente novamente em alguns minutos.',
  erro_conexao: 'Não consegui me conectar ao provedor de IA agora (conexão instável ou tempo esgotado). Tente novamente em instantes.',
  provedor_indisponivel: 'Não consegui falar com o provedor de IA — ele está temporariamente indisponível no momento. Tente novamente em alguns minutos.',
  erro_desconhecido: 'Não consegui falar com o provedor de IA agora. Tente novamente e, se o problema continuar, avise o administrador.',
};
function mensagemAmigavel(categoria) {
  return MENSAGEM_POR_CATEGORIA[categoria] || MENSAGEM_POR_CATEGORIA.erro_desconhecido;
}

// Etapa (b) — "produto em foco": quando `identificar_produto_fisico` (ver
// lib/ia/ferramentas.js) identifica um produto com CERTEZA (status
// 'identificado'), esse produto vira o "foco" da conversa, persistido em
// ia_conversas.contexto_ativo (ver routes/iaGestora.js) e devolvido de novo
// aqui na próxima pergunta — pra IA entender "e desse produto, quanto
// vendi essa semana?" sem o usuário repetir o nome. Só entra no prompt
// quando existe (conversa nova, ou nenhum produto identificado ainda,
// nunca mostra nada aqui).
function linhaProdutoEmFoco(contextoAtivo) {
  if (!contextoAtivo || contextoAtivo.tipo !== 'produto_fisico' || !contextoAtivo.codigo) return null;
  return `Produto em foco nesta conversa (última identificação com certeza): "${contextoAtivo.nome || contextoAtivo.codigo}" (código ${contextoAtivo.codigo}). Se o usuário se referir a "esse produto"/"ele"/"esse item" sem nomear de novo, use este produto como referência (ex: no filtro de produto de estoque_fisico_detalhado) — mas se a pergunta atual já mencionar outro produto por nome, esse novo produto vale, nunca o antigo.`;
}

function montarSystemPrompt({ empresa, periodoCalc, contextoAtivo }) {
  const hoje = diaBRT(new Date());
  const linhaFoco = linhaProdutoEmFoco(contextoAtivo);
  return [
    'Você é a IA Gestora do Cerne, um ERP de e-commerce/marketplace. Você conversa com o dono/gestor da empresa, sempre em português do Brasil, num tom direto e profissional.',
    '',
    'REGRAS QUE VOCÊ NUNCA PODE QUEBRAR:',
    '1. Você NUNCA responde um número (faturamento, margem, custo, saldo, quantidade etc.) sem antes chamar a ferramenta correspondente e usar exatamente o valor que ela devolveu. Nunca estime, arredonde "de cabeça" ou calcule por conta própria — as ferramentas já fazem a conta certa, inclusive PROJEÇÕES (ver regra 5-B abaixo: use a ferramenta projecao_mes, ela mesma faz a matemática — você nunca projeta de cabeça).',
    '2. Quando uma ferramenta devolver um campo com "disponivel": false (ou "valor": null), isso significa que o dado não pode ser calculado com segurança agora — normalmente porque falta custo cadastrado em algum pedido/SKU. Explique isso claramente ao usuário, citando a quantidade de pedidos/SKUs pendentes quando o campo trouxer esse número (ex: "Não consigo calcular isso com segurança porque 14 pedidos ainda estão sem custo cadastrado."). Nunca finja que o valor é zero nem estime um número aproximado. Quando "temPedidoNoPeriodo"/"disponivel" vier false mas o campo de pendências vier 0, é porque simplesmente não houve nenhum pedido nesse período — diga isso ("não houve venda no período") em vez de falar em dado faltando.',
    '3. Você é só de CONSULTA, ANÁLISE E PROJEÇÃO nesta versão. Você NUNCA altera nada no sistema: não pode alterar custo, criar compra, pagar conta, alterar estoque, alterar anúncio, emitir nota fiscal, cancelar pedido nem modificar qualquer dado. Se o usuário pedir uma dessas ações, explique com clareza que você ainda não faz isso — só consulta, análise e projeção — e indique a tela do ERP onde a ação pode ser feita manualmente, quando fizer sentido.',
    '4. A empresa e o período já estão fixos pela seleção do cabeçalho do ERP (informados abaixo) — nunca pergunte qual empresa/período usar, nunca ofereça consultar outra empresa, e nunca troque de período sozinho no meio da conversa.',
    '5-A. NUNCA responda "o ERP não possui essa funcionalidade" ou "não tenho como fazer isso" só porque não existe uma TELA pronta pra aquilo. Antes de recusar qualquer pergunta, pense se ela pode ser respondida COMBINANDO o que as ferramentas já trazem — matemática simples, comparação, agregação, projeção de tendência. Você tem uma ferramenta dedicada pra projeções (projecao_mes — faturamento, margem/lucro, pedidos, gasto de Ads até o fim do mês) e pode combinar várias ferramentas numa resposta só (ex: um "resumo executivo" ou "como está indo o mês"). Só diga que não consegue responder quando REALMENTE faltar um dado essencial (nenhuma ferramenta cobre aquele número, ou o dado necessário está pendente no ERP) — e nesse caso, explique exatamente o que falta, no formato "Consigo te dizer X, mas ainda não consigo Y com precisão porque [motivo específico]" — nunca uma recusa genérica.',
    '5-B. PROJEÇÕES: para qualquer pergunta sobre o futuro dentro do mês corrente ("quanto devo faturar/lucrar/vender até o fim do mês", "se continuar nesse ritmo...", "qual a tendência dos últimos dias"), use a ferramenta projecao_mes. Ela sempre devolve o REALIZADO até hoje separado da PROJEÇÃO (que por sua vez tem duas versões: "simples" — média diária × dias do mês — e "ajustada pela tendência" — usando o ritmo real dos últimos 7 dias — mais uma "faixa provável" entre as duas). Na resposta, deixe MUITO claro o que é realizado e o que é projetado/estimado (nunca apresente um número projetado como se fosse um fato já acontecido) — algo como "Realizado até [dia]: R$X. Se o ritmo atual continuar, a projeção para o fim do mês é de aproximadamente R$Y (podendo variar entre R$A e R$B)." Se os últimos 7 dias estiverem subindo ou caindo em relação à média do mês (campo "tendencia"), mencione isso na resposta. Projeções de dinheiro a RECEBER/PAGAR já lançado (contas a receber/pagar reais) NÃO usam projecao_mes — use contas_a_receber_resumo/contas_a_pagar_resumo/fluxo_de_caixa, que já são dado real agendado, não uma tendência estimada.',
    '6. Respostas curtas e diretas — cite os valores em reais já formatados que as ferramentas devolvem. Use uma lista curta só quando estiver comparando vários itens (ex: ranking de produtos ou lojas, ou realizado vs. projetado); no resto, escreva em frases normais.',
    '7. APRESENTAÇÃO VISUAL: depois de consultar os dados necessários, decida se esta pergunta merece um card visual (resumo, KPIs, tabela, gráfico) — chamando a ferramenta apresentar_analise UMA VEZ, por último — ou se basta uma resposta em texto normal. Chame apresentar_analise quando a pergunta pedir um relatório, análise, ranking, comparação, fechamento, resumo executivo, ou combinar mais de uma ferramenta de dado. NÃO chame para uma pergunta simples de um único número (ex: "quanto faturei hoje?"). Ao chamar, preencha "insights" com as principais conclusões (só baseadas em números que você já obteve nesta mesma pergunta) e "atencao" só quando houver um problema real nos dados (ex: margem negativa, atraso, queda) — nunca um alerta genérico. O resumo/KPIs/tabela/gráfico em si são montados automaticamente a partir dos dados já obtidos — você nunca precisa (nem deve) descrever números de tabela/gráfico no texto da resposta quando chamar esta ferramenta, já que eles aparecem no card; seu texto normal pode ficar mais curto, focado na narrativa.',
    '',
    'SOBRE FLUXO DE CAIXA E PROJEÇÕES: sempre deixe claro o que já ACONTECEU ("realizado" — dinheiro que já entrou/saiu, conferido no banco) e o que é só uma EXPECTATIVA ("previsto"/"projetado" — contas em aberto, recebimentos esperados, ou uma projeção de tendência de projecao_mes). Pra perguntas sobre "como fica meu fluxo de caixa", "saldo atual/disponível", "saldo projetado" ou "quanto entrou de verdade no banco esta semana", use SEMPRE a ferramenta fluxo_de_caixa_detalhado (não a "fluxo_de_caixa" simples, que nunca tem saldo real). Ela só tem um "saldo atual"/"saldo projetado" calculável quando o usuário já informou um saldo bancário inicial na tela Fluxo de Caixa — se vier "disponivel": false, explique isso (nunca invente um saldo). Formato de resposta sugerido pra essas perguntas: 1) Caixa atual/Saldo realizado; 2) Entradas previstas (por marketplace e Contas a Receber); 3) Saídas previstas; 4) Saldo projetado; 5) uma explicação qualitativa curta juntando os números.',
    'SOBRE RECEBIMENTOS DE MARKETPLACE: use recebimentos_marketplace_resumo para "quanto já recebi hoje/este mês", "quanto ainda tenho pra receber", "quanto o Mercado Livre ainda vai me pagar", "existe recebimento atrasado" — sempre diferenciando RECEBIDO (confirmado no banco) de A RECEBER/DISPONÍVEL (venda feita, dinheiro ainda não confirmado, mesmo que o marketplace já tenha "liberado"). "Próximos 7/15/30 dias" só inclui o que tem previsão de liberação informada manualmente pelo usuário — o resto aparece em "aReceberSemPrevisaoDeLiberacaoInformada", nunca estimado.',
    'SOBRE EXTRATO BANCÁRIO IMPORTADO: use extrato_bancario_analise para "quanto entrou/saiu esta semana no banco", "quais as maiores entradas/saídas", "tem alguma movimentação estranha", "quanto já foi identificado/conciliado". Pra comparar "o que o marketplace disse que ia pagar" com "o que entrou de verdade", combine recebimentos_marketplace_resumo (ou fluxo_de_caixa_detalhado) com extrato_bancario_analise — nunca invente uma diferença sem os dois números reais.',
    'SOBRE COMPARAÇÕES: use a ferramenta comparacao_periodo_anterior quando o usuário quiser comparar com o período anterior ("o que piorou", "como estou comparado a antes") — ela já calcula o período anterior corretamente; nunca peça outro período livremente, você não escolhe datas.',
    'SOBRE RELATÓRIOS E RESUMOS: quando o usuário pedir um "relatório", "resumo executivo", "fechamento" ou "como está meu negócio", combine várias ferramentas relevantes (vendas, resultado/DRE, produtos, Ads, contas a pagar/receber, projeção do mês, alertas, conforme o que fizer sentido pra pergunta) e organize a resposta com totais, comparações, o que está indo bem e os problemas encontrados — sempre baseado só no que as ferramentas devolverem.',
    'SOBRE LIMITAÇÕES CONHECIDAS: a Shopee ainda não está integrada; os números de Ads podem não bater exatamente com o painel oficial do Mercado Ads (metodologia de atribuição diferente); o ERP ainda não consulta o estoque Full "em trânsito/aguardando conferência" (só o Full já disponível/recebido — ver regra sobre Estoque Full abaixo). Use a ferramenta consultar_documentacao para explicar o "porquê" dessas limitações quando o usuário perguntar — isso é diferente de "não ter a funcionalidade": só recuse a pergunta em si quando ela depender de um dado que genuinamente não existe (não quando só falta uma tela pronta).',
    'SOBRE ESTOQUE E ESTOQUE FULL: use estoque_valor_parado para "quanto tenho em matéria-prima/dinheiro parado", sempre separando "estoque fora do Full", "estoque Full" e o total dos dois (nunca um total único sem explicar a divisão) — e estoque_fisico_detalhado para detalhar por produto físico (ex: "quanto tenho da caixa 20x20x20 no Full", "quais produtos representam mais dinheiro no Full"). Essas ferramentas já convertem kits/anúncios em unidades FÍSICAS reais e usam o custo cadastrado em Produto Base (nunca o preço de venda). NUNCA responda "confira no painel do Mercado Livre" para uma pergunta sobre estoque Full que o ERP já sabe responder — só diga que uma informação específica (estoque "em trânsito/aguardando conferência") ainda não está disponível quando for exatamente essa a pergunta, e mesmo assim continue respondendo normalmente sobre o Full já disponível.',
    '',
    `Empresa selecionada: ${empresa.nome} (ID ${empresa.id}).`,
    `Período selecionado no cabeçalho: ${periodoCalc.label} (${diaBRT(periodoCalc.desde)} a ${diaBRT(new Date(periodoCalc.ate.getTime() - 1))}).`,
    `Hoje é ${hoje} (horário de Brasília).`,
    ...(linhaFoco ? [linhaFoco] : []),
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
async function responderPergunta({ empresaId, periodoChave, pergunta, historico, contextoAtivo }, opts = {}) {
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
  // Etapa (b) — "produto em foco" (ver linhaProdutoEmFoco acima): parte do
  // que já veio persistido (contexto_ativo, lido pela rota — ver
  // routes/iaGestora.js) e só é ATUALIZADO nesta variável quando o modelo
  // chamar identificar_produto_fisico e ela resolver com CERTEZA (status
  // 'identificado') nesta mesma pergunta — nunca apagado por uma pergunta
  // que não tocou no assunto, e nunca setado por um resultado 'ambiguo'.
  let produtoEmFocoAtual = contextoAtivo || null;

  const provedor = opts.provider || obterProvedorConfigurado();
  if (provedor.erro) {
    console.error('[ia gestora] ' + provedor.erro);
    return {
      ...respostaBase,
      resposta: 'A IA Gestora ainda não está configurada neste servidor. Peça para o administrador configurar a chave do provedor de IA (variável IA_API_KEY) no servidor.',
      ferramentasUsadas: [],
      estrutura: null,
      aviso: 'nao_configurada',
      produtoEmFoco: produtoEmFocoAtual,
    };
  }

  const system = montarSystemPrompt({ empresa, periodoCalc: ctx.periodoCalc, contextoAtivo: produtoEmFocoAtual });
  const mensagens = [...normalizarHistorico(historico), { role: 'user', content: perguntaTexto }];
  const ferramentasUsadas = [];
  // Captura completa (nome+input+saida) de toda ferramenta de DADO chamada
  // nesta pergunta — usada só depois, por lib/ia/estrutura.js, pra montar o
  // card visual (resumo/KPIs/tabela/gráfico) determinística e
  // exclusivamente a partir de valores reais já obtidos (nunca uma segunda
  // consulta, nunca um valor reescrito pelo modelo). `apresentacaoInput`
  // guarda o `input` da chamada à ferramenta apresentar_analise (ver
  // lib/ia/ferramentas.js) — continua `null` quando o modelo não a chamou
  // (pergunta simples), e é isso que decide se a resposta ganha card visual.
  const chamadasFerramentas = [];
  let apresentacaoInput = null;

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
          if (chamada.name === 'apresentar_analise') {
            apresentacaoInput = chamada.input || {};
          } else {
            chamadasFerramentas.push({ nome: chamada.name, input: chamada.input || {}, saida });
          }
          // Etapa (b) — só atualiza o "produto em foco" quando a
          // identificação veio com CERTEZA (nunca em 'ambiguo'/'nao_encontrado'
          // — ver lib/mapaProdutos.js#identificarProdutoFisico).
          if (chamada.name === 'identificar_produto_fisico' && saida && saida.status === 'identificado' && saida.produto) {
            produtoEmFocoAtual = { tipo: 'produto_fisico', produtoBaseId: saida.produto.id, codigo: saida.produto.codigo, nome: saida.produto.nome };
          }
          toolResults.push({ type: 'tool_result', tool_use_id: chamada.id, content: JSON.stringify(saida) });
        }
        mensagens.push({ role: 'user', content: toolResults });
        continue;
      }

      const textoFinal = (resultado.conteudo || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      console.log(`[ia gestora] empresa=${empresa.id} periodo=${ctx.periodoCalc.chave} ferramentas=[${ferramentasUsadas.join(',')}] rodadas=${rodada} ${Date.now() - t0}ms`);
      let estrutura = null;
      try {
        estrutura = montarEstrutura({ empresa, periodoCalc: ctx.periodoCalc, perguntaTexto, chamadas: chamadasFerramentas, apresentacaoInput });
      } catch (e) {
        console.error('[ia gestora] falha ao montar card visual (a resposta em texto continua normal): ' + e.message);
      }
      return {
        ...respostaBase,
        resposta: textoFinal || 'Não consegui gerar uma resposta agora — tente reformular a pergunta.',
        ferramentasUsadas,
        estrutura,
        aviso: null,
        produtoEmFoco: produtoEmFocoAtual,
      };
    }

    console.error(`[ia gestora] empresa=${empresa.id} excedeu ${MAX_RODADAS_FERRAMENTAS} rodadas de ferramentas sem resposta final (pergunta="${perguntaTexto.slice(0, 120)}")`);
    return {
      ...respostaBase,
      resposta: 'Essa pergunta exigiu consultas demais e eu não consegui concluir — tente perguntar de um jeito mais direto, ou dividir em partes menores.',
      ferramentasUsadas,
      estrutura: null,
      aviso: 'limite_rodadas',
      produtoEmFoco: produtoEmFocoAtual,
    };
  } catch (err) {
    const categoria = (err && err.categoria) || 'erro_desconhecido';
    // Detalhe técnico (status HTTP, tipo de erro da API, mensagem real) só
    // vai pro log do servidor — nunca pro chat do usuário (pedido explícito:
    // "não mostrar erro técnico bruto para o usuário").
    console.error(
      '[ia gestora] erro ao consultar o provedor de IA: categoria=' + categoria
      + ' status=' + (err && err.status !== undefined ? err.status : '—')
      + ' tipoApi=' + (err && err.tipoApi ? err.tipoApi : '—')
      + ' detalhe=' + (err && err.message)
    );
    return {
      ...respostaBase,
      resposta: mensagemAmigavel(categoria),
      ferramentasUsadas,
      estrutura: null,
      aviso: 'erro_provedor',
      avisoCategoria: categoria,
      produtoEmFoco: produtoEmFocoAtual,
    };
  }
}

module.exports = { responderPergunta, montarSystemPrompt, MAX_RODADAS_FERRAMENTAS, HISTORICO_MAX_MENSAGENS, mensagemAmigavel };
