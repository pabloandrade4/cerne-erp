# Alterações Importantes (Changelog)

Registro cronológico de mudanças relevantes no projeto (mais recente no topo).

## 2026-08-25 (24) — Relatórios → Produtos: nova visão "Por Caixa" (agrupada por produto físico)
- **Pedido do usuário, em 3 passos:** (1) manter a visão "Por SKU" já
  existente; (2) criar a visão "Por Caixa", juntando todos os SKUs/kit
  que representam a mesma medida física, com quantidade de caixas físicas
  vendidas, faturamento total (nunca dividido), quantidade de pedidos e
  quantidade de kits vendidos; (3) identificação de produto base
  centralizada no backend, reaproveitando a estrutura já existente no
  banco. Ver causa/decisões completas em `02-decisoes.md` (24).
- **`server/lib/relatoriosAgregados.js`:** nova função
  `resolverProdutosBasePorSku` (resolve produto base + multiplicador de
  um conjunto de SKUs, priorizando vínculo salvo em `produto_base_skus`
  e caindo pro padrão automático do SKU quando não há vínculo) e nova
  função `relatorioProdutosPorCaixa` (agrupa os mesmos itens de
  `buscarItensDoPeriodo` usados por `relatorioProdutos`, pelo produto
  base em vez do SKU).
- **`server/routes/relatorios.js`:** nova rota
  `GET /api/relatorios/produtos-por-caixa?empresaId=&periodo=&contaId=`.
- **`server/public/index.html` (módulo `Relatorios`):** novo alternador
  "Por SKU" / "Por Caixa" dentro da categoria Produtos; nova função
  `renderProdutosPorCaixa` (tabela por produto base + detalhamento dos
  SKUs que compõem cada linha + seção separada "SKUs sem produto base
  identificado"); busca por SKU e botões de exportar ficam ocultos na
  visão Por Caixa (busca não faz sentido pra esse agrupamento; exportação
  não foi estendida pra esta visão nesta etapa).
- **Nenhuma tabela nova no banco** — reaproveitadas `produtos_base` e
  `produto_base_skus` (já existiam, criadas na etapa `ml15`/`ml16` e sem
  uso desde que Estoque passou a ler direto do Mercado Livre).
- **Testes:** 8 testes novos em `server/test/relatorios.test.js` — o
  agrupamento batendo número a número com os SKUs reais do fixture
  (empresa 900: `25CX-19X12X12`/`50CX-19X12X12` → `CX-19X12X12`,
  `100CX-16X11X8`/`50CX-16X11X8` → `CX-16X11X8`, etc., calculados à mão e
  conferidos contra o resultado da função); soma de faturamento batendo
  com `resumirPeriodo`; detalhamento por SKU; SKU fora do padrão nunca
  chutado (aparece em "sem produto base identificado"); vínculo salvo
  vencendo sobre o padrão automático; período "hoje" calculando só vendas
  de hoje; filtro de loja; isolamento entre empresas. Suíte completa do
  projeto: 160 testes, 28 suítes, 0 falhas.
- **Testado também de ponta a ponta com servidor real + Postgres real via
  HTTP**, com os multiplicadores pedidos pelo usuário (25/50/75/100/200):
  5 pedidos de teste, 1 kit cada, resultaram em 450 caixas físicas
  (25+50+75+100+200), 5 kits vendidos, 5 pedidos, R$ 50,00 de faturamento
  — conferido via `GET /api/relatorios/produtos-por-caixa`. Período
  "hoje" corretamente vazio (pedidos de teste datados de outro dia);
  filtro de loja (`contaId`) restringindo corretamente.

## 2026-08-25 (23) — Correção de bug: Contas a Pagar não listava contas com vencimento futuro
- **Bug relatado pelo usuário:** ao lançar uma conta a pagar, ela não
  aparecia corretamente na lista — nem em Pendente, nem em Vencido. Ver
  causa raiz completa em `02-decisoes.md` (23).
- **`server/lib/contasPagar.js`:** `listarContasPagar` não filtra mais
  TODA a lista por vencimento dentro do período do header — só contas já
  PAGAS respeitam o período agora (pela `data_pagamento`). Pendentes/
  vencidas/canceladas aparecem sempre, qualquer que seja o período
  selecionado.
- **`server/routes/contasPagar.js`:** comentário do endpoint
  `GET /api/contas-pagar` atualizado pra refletir a regra nova.
- **`server/public/index.html` (módulo `ContasPagar`):** nova função
  `hojeBRT()` local ao módulo (fuso fixo America/Sao_Paulo, UTC-3) —
  substitui `new Date().toISOString().slice(0,10)` (data em UTC) nos 2
  pontos que calculavam "hoje" nesta tela: a data padrão sugerida ao
  abrir "Nova conta a pagar" e a data enviada ao marcar uma conta como
  paga. Sem a correção, entre 21h e 23h59 (horário de Brasília) essas
  datas ficavam adiantadas em 1 dia.
- **Testes:** 3 testes novos em `server/test/financeiro.test.js` —
  conta com vencimento futuro aparece na lista mesmo com o período mais
  estreito do header ("hoje"); conta paga só aparece na lista quando a
  data de pagamento está dentro do período selecionado; e uma regressão
  direta do cenário relatado (futura/hoje/vencida/paga, todas juntas,
  cada uma na categoria certa, sob o período padrão da tela). Suíte
  completa do projeto: 152 testes, 27 suítes, 0 falhas. Testado também
  de ponta a ponta com servidor real + Postgres real via HTTP (as 4
  contas criadas de verdade via `POST /api/contas-pagar`, conferidas via
  `GET /api/contas-pagar` com o período padrão e com o período "hoje", e
  os filtros `status=pendente|vencido|pago`).
- Nenhum outro módulo foi alterado (pedido explícito do usuário). Contas
  a Receber e Compras têm o mesmo padrão de cálculo de "hoje" em UTC —
  registrado como candidato a correção futura em `06-proximos-passos.md`,
  não corrigido agora.

## 2026-08-28 (22) — IA Gestora: ativação do chat de consulta e análise, conectado a dados reais
- **Pedido do usuário, em 3 passos:** (1) ativar a aba/chat "IA Gestora" no
  ERP, com o mesmo padrão visual do resto do sistema, respondendo perguntas
  em linguagem natural; (2) conectar a IA aos dados reais do ERP,
  respeitando SEMPRE empresa/período do header (nunca um filtro próprio) e
  nunca criando uma segunda regra financeira só para ela — se faltar dado,
  ela diz claramente o que falta, nunca estima; (3) primeira versão só de
  CONSULTA E ANÁLISE — ainda não altera custo, estoque, compras, contas,
  notas fiscais, anúncios nem pedidos. Ver `01-regras-de-negocio.md` e
  `02-decisoes.md` (22) para as regras e decisões completas.
- **`server/lib/ia/providers/anthropic.js` (novo):** tradução HTTP com a
  API de Mensagens da Anthropic (`fetch` nativo do Node — sem SDK/
  dependência nova, este ambiente não instala pacotes npm), com o mesmo
  padrão defensivo de timeout já usado em `lib/mercadolivre.js` (aqui,
  45s). Nunca é importado fora de `lib/ia/`.
- **`server/lib/ia/providers/index.js` (novo):** registro de provedor —
  `obterProvedorConfigurado()` lê `IA_PROVEDOR`/`IA_API_KEY`/`IA_MODELO`
  do ambiente e devolve o provedor certo já com a chave presa (o chamador
  nunca lida com ela diretamente), ou `{erro}` quando não configurado
  (nunca quebra, só avisa). Ponto único de troca de provedor/modelo no
  futuro.
- **`server/lib/ia/ferramentas.js` (novo):** o catálogo de 9 ferramentas
  (`resumo_vendas`, `resultado_periodo`, `produtos_desempenho`,
  `skus_sem_custo`, `contas_a_receber_resumo`, `contas_a_pagar_resumo`,
  `estoque_resumo`, `desempenho_por_loja`, `alertas_operacionais`), cada
  uma uma casca fina sobre uma função já existente
  (`lib/relatorioVendas.js`, `lib/dre.js`, `lib/relatoriosAgregados.js`,
  `lib/contasPagar.js`, `lib/contasReceber.js`, `lib/visaoGeralPainel.js`,
  `ml_estoque_itens`) — nenhum cálculo financeiro novo. `criarContexto`
  fixa empresa/período (do header) e faz cache de pedidos/itens do
  período por pergunta, pra nunca buscar duas vezes nem mandar mais dado
  que o necessário pro modelo.
- **`server/lib/ia/orchestrator.js` (novo):** `responderPergunta` — o laço
  de ferramentas (pergunta → provedor → `tool_use`? executa a ferramenta
  de verdade : responde com texto), com teto de 6 rodadas e histórico
  limitado a 8 mensagens. Nunca lança um número: sem `IA_API_KEY`, com
  erro do provedor, ou excedendo o limite de rodadas, devolve uma
  resposta de chat normal explicando o que houve (nunca uma exceção que
  quebra a tela), sempre registrado em log (`[ia gestora]`, nunca a
  chave).
- **`server/routes/iaGestora.js` (novo):** `POST /api/ia-gestora/perguntar`
  — router fino, valida `empresaId`/`pergunta` e delega pro orquestrador.
- **`server/server.js`:** monta o novo router
  (`app.use('/api/ia-gestora', iaGestoraRouter)`) — só isso, aditivo.
- **`server/public/index.html`:** novo item de menu "IA Gestora" (grupo
  Geral, entre Visão Geral e Alertas & IA, ícone novo `messageCircle`);
  novo módulo `window.IAGestora` — chat com bolhas de mensagem, indicador
  "consultando os dados…", legenda de quais ferramentas foram usadas em
  cada resposta, 5 chips de pergunta sugerida na tela vazia, caixa de
  texto com auto-resize e Enter para enviar, sempre mostrando a
  empresa/período atual acima do campo de digitar. Reaproveita só CSS
  nova (`.ia-*`, com os mesmos tokens de cor/tipografia do resto do
  ERP — nenhuma biblioteca externa) e o `window.CerneFiltro` já
  existente; trocar empresa/período reinicia a conversa. Nenhuma outra
  tela foi alterada.
- **`.env.example`:** acrescentadas `IA_PROVEDOR`, `IA_API_KEY`,
  `IA_MODELO` (todas opcionais/documentadas — sem elas, a IA Gestora só
  avisa que não está configurada).
- **Testes:** `server/test/iaFerramentas.test.js` (catálogo de
  ferramentas — forma do schema, `criarContexto`/`executarFerramenta`, e
  cada ferramenta comparada número a número com a função de origem contra
  a empresa 900, já seedada por outros testes, e uma empresa nova de
  teste para Contas a Pagar/Receber/Estoque) e
  `server/test/iaOrchestrator.test.js` (o laço de ferramentas com um
  PROVEDOR FALSO — nunca chama rede real; cobre: empresa inexistente,
  pergunta vazia/longa demais, resposta direta, pede 1 ferramenta e
  conclui, ignora `empresaId` que o "modelo" tenta embutir no input,
  excede o limite de rodadas, provedor falha, sem `IA_API_KEY`
  configurada, histórico limitado). Total: 26 testes novos, 149 no total
  no projeto (27 suítes), 0 falhas. Testado também de ponta a ponta com
  servidor real + Postgres real: `POST /api/ia-gestora/perguntar` contra
  a empresa 900 devolve a mensagem de "não configurada" (sem
  `IA_API_KEY`), e os erros 404 (empresa inexistente)/400 (pergunta
  vazia/faltando) na rota — a chamada de rede real ao provedor Anthropic
  segue sem confirmação neste ambiente, ver `05-problemas-conhecidos.md`.

## 2026-08-26 (21) — Visão Geral: ativação da parte inferior da tela (Evolução diária/Por marketplace, Fluxo de Caixa/Conexões & Empresas, Alertas & IA)
- **Pedido do usuário, em 3 passos:** (1) ativar os gráficos "Evolução
  diária" (faturamento + margem de contribuição por dia, respeitando o
  período do header) e "Por marketplace" (faturamento, quantidade de
  pedidos e participação % no faturamento por canal, começando só com
  Mercado Livre e entrando automaticamente quando houver outra
  integração) com dado real, nunca inventado; (2) ativar "Fluxo de Caixa"
  (contas a receber, contas a pagar, recebimentos, saldo projetado só
  quando houver dado suficiente — nunca inventar saldo bancário) e
  "Conexões & Empresas" (contagem real de empresas e contas do Mercado
  Livre/Shopee, removendo os textos fictícios de demonstração); (3)
  ativar "Alertas & IA" como uma central de alertas por regras simples
  sobre dado real (produto/SKU sem custo, pedido sem custo, margem
  negativa, erro de sincronização do Mercado Livre, conta a pagar
  vencida, recebimento atrasado, estoque zerado/muito baixo), cada
  alerta levando o usuário pra tela relacionada ao clicar. Regra
  repetida pelo usuário em todos os 3 passos: empresa e período do
  header sempre, nenhum filtro próprio dentro desses blocos, e nunca um
  cálculo financeiro diferente do que Visão Geral/Pedidos/Financeiro/
  Relatórios já usam. Ver `01-regras-de-negocio.md` e `02-decisoes.md`
  (21) para as regras e decisões completas.
- **`server/lib/visaoGeralPainel.js` (novo):** toda a regra de negócio dos
  4 blocos novos (Evolução diária reaproveita o `serieDiaria` já existente
  de `/api/relatorios/resumo-vendas`, sem precisar de código novo).
  Exporta `painelVisaoGeral` (função principal) e as peças testáveis
  isoladamente: `identificarCanal`/`porCanal` (agrupamento por canal —
  hoje sempre "Mercado Livre", já preparado para uma segunda integração),
  `resumoRecebimentos`/`fluxoDeCaixa` (contas a pagar/receber via
  `lib/contasPagar.js`/`lib/contasReceber.js`, recebimentos via
  `lib/recebimentosMl.js` — sem nenhuma consulta nova ao banco além da
  estritamente necessária), `conexoesEEmpresas` (contagem de empresas +
  contas `ml_contas` da empresa selecionada, com status/última
  sincronização), `gerarAlertas` (as 7 regras de alerta, cada uma citada
  acima — a de estoque zerado/baixo é a única que consulta o banco
  diretamente aqui, as outras 6 usam só o que já foi buscado).
- **`server/routes/visaoGeral.js` (novo):** `GET /api/visao-geral/painel`
  — router fino, só valida `empresaId` e chama `painelVisaoGeral`. Montado
  em `server.js` como `/api/visao-geral`.
- **`server/public/index.html`:** as 3 funções que antes só desenhavam
  placeholder (`secondaryChartsHTML`, `connectionsPanelHTML`,
  `alertsPanelHTML`) foram movidas pra dentro do módulo `window.Overview`
  e reescritas pra usar dado real — precisavam do `state`/formatação que
  só existem lá. `chartHTML` (o SVG do gráfico principal) ganhou um
  parâmetro `opts` opcional (`heightPx`/`emptyClass`/`emptyMsg`) só pra
  permitir uma versão compacta no card "Evolução diária" — o desenho e o
  cálculo continuam exatamente os mesmos. `loadResumo` agora busca
  `/api/relatorios/resumo-vendas` e `/api/visao-geral/painel` em paralelo
  (`Promise.allSettled`) com erro isolado: se o painel novo falhar, os
  indicadores/gráfico principal (que não dependem dele) continuam
  aparecendo normalmente. Alertas viraram linhas clicáveis
  (`.alert-row`, `data-page`) que chamam a função `navigate()` já
  existente — mesma navegação de clicar num item do menu.
- **Testes automatizados novos** (`server/test/visaoGeralPainel.test.js`,
  13 testes): 7 sem banco (funções puras — `porCanal`/`resumoRecebimentos`
  com pedidos fabricados, confirmando a matemática de agrupamento/
  porcentagem/pendência) e 6 contra Postgres real (os 7 tipos de alerta
  disparando juntos numa empresa fabricada, nenhum alerta inventado numa
  empresa limpa, `conexoesEEmpresas` com e sem conta conectada, e
  `painelVisaoGeral` de ponta a ponta contra a empresa 900 — 11 pedidos
  reais já seedados — e contra uma empresa vazia). Suíte completa do
  projeto (123 testes) rodada sem falhas depois da mudança. Testado
  também manualmente com Playwright contra um servidor real: troca de
  empresa (uma com dado real, outra fabricada com conta em erro e conta a
  pagar vencida) e troca de período (Hoje/Este mês) atualizando os 5
  blocos corretamente, e clique num alerta navegando pra Marketplaces e
  para Contas a Pagar como esperado.

## 2026-08-26 (20) — Estoque: Mercado Livre vira a fonte oficial, ajuste manual removido
- **Pedido do usuário, em 3 ajustes:** (1) o estoque exibido no ERP deve vir
  sempre dos anúncios/variações da conta do Mercado Livre conectada
  (consultando o recurso certo conforme o tipo de conta — `user_product_id`
  + endpoint de User Products para contas com estoque multi-origem, nunca
  só `available_quantity`); (2) a tela Estoque deve mostrar
  produto/anúncio, SKU, loja, ID do anúncio, estoque disponível, status e
  última sincronização, com a quantidade **somente leitura** — o ajuste
  manual de estoque no ERP foi **removido**; (3) separar por completo
  Estoque (fora do Full) de Estoque Full, sem somar nem misturar os dois
  saldos. Regra central, repetida pelo usuário: **nunca inventar
  quantidade** quando a API não devolve o dado, e **nunca dar baixa manual
  de estoque numa venda** — o Mercado Livre já é quem controla o saldo, o
  ERP só espelha. Ver `01-regras-de-negocio.md` e `02-decisoes.md` (20)
  para as regras e a decisão de arquitetura completas.
- **Reescrita completa da lógica de Estoque**, abandonando o modelo
  anterior de "produto base + multiplicador, agrupado" (etapas `ml15`/
  `ml16`) para a tela de Estoque — ele foi descontinuado **só para fins de
  estoque** (as tabelas/rotas de produto base continuam existindo, sem uso
  por nenhuma tela; ver seção "Produto base" em `03-funcionalidades.md`).
  No lugar, uma linha por anúncio/variação, sempre somente leitura,
  persistida e sincronizada — não mais um cálculo ao vivo a cada
  carregamento de página.
- **`server/db/schema.sql` (aditivo):** nova tabela `ml_estoque_itens`
  (uma linha por conta + anúncio + variação + `tipo` `proprio`/`full`),
  com índice único (usando `COALESCE(ml_variation_id, 0)` porque o
  Postgres trata `NULL` como sempre distinto numa constraint `UNIQUE`) que
  garante upsert idempotente. Tabelas antigas de estoque (`estoque`,
  `estoque_movimentos`, `estoque_produto_base`,
  `estoque_produto_base_movimentos`) foram preservadas, só deixaram de ser
  escritas.
- **`server/lib/mlEstoque.js` (novo):** a lógica de sincronização.
  `sincronizarEstoqueConta(contaId)` pagina todos os anúncios da conta,
  busca detalhes em lote (incluindo `user_product_id`), e para cada
  item/variação resolve a quantidade: se houver `user_product_id`, tenta
  primeiro o endpoint de User Products (`buscarQuantidadeUserProduct`,
  que testa 3 formatos plausíveis de resposta, já que a documentação do
  Mercado Livre não confirma o formato exato — ver `05-problemas-conhecidos.md`),
  caindo para `available_quantity` só se o formato não for reconhecido;
  sem `user_product_id`, usa `available_quantity` direto. Estoque Full
  usa o mesmo endpoint de inventário já validado em `lib/mlFull.js`
  (`/inventories/{id}/stock/fulfillment`). Quando nenhum dado é
  retornado, o item fica marcado `pendente` com o motivo — **nunca** um
  valor inventado. SKU agora é resolvido por variação (antes só existia
  no agregado por produto base).
- **`server/lib/syncScheduler.js` (aditivo, reaproveitando a automação da
  etapa 19):** o mesmo ciclo de 1 em 1 minuto agora também roda um
  segundo laço `Promise.allSettled`, independente do laço de pedidos,
  chamando `sincronizarEstoqueConta` por conta ativa — erro isolado por
  conta, num estado separado (`estoqueUltimaExecucaoEm`,
  `estoqueUltimoCicloOk`, `estoqueContasProcessadas`, `estoqueComErro`),
  sem alterar em nada o comportamento/estado já existente da
  sincronização de pedidos.
- **`server/routes/estoque.js` e `server/routes/estoqueFull.js`
  (reescritos):** `GET /` de cada um agora lê só o cache persistido em
  `ml_estoque_itens` (filtrado por `tipo='proprio'` ou `tipo='full'`),
  em vez de consultar a API do Mercado Livre a cada carregamento de
  página. Novo `POST /api/estoque/sincronizar` (botão "Sincronizar
  agora", compartilhado pelas duas telas) dispara a sincronização de
  todas as contas ativas da empresa na hora.
- **`server/routes/estoqueProdutoBase.js`:** o `PUT` de ajuste manual do
  Galpão foi **desativado** — responde sempre `410` com a mensagem
  explicando que o ajuste agora é feito direto no Mercado Livre. O corpo
  original do handler foi preservado comentado, para referência
  histórica. O `GET` (não usado pela tela) continua funcional.
- **`server/public/index.html`:** a tela "Estoque" (com o filtro
  Todos/Galpão/Full e o modal "Ajustar Galpão") foi substituída por uma
  fábrica `criarTelaEstoqueSomenteLeitura()` compartilhada, instanciada
  duas vezes — uma para a tela **Estoque** (`window.Estoque`, aba nova no
  menu, fora do Full) e outra para a tela nova **Estoque Full**
  (`window.EstoqueFull`, item novo no menu). As duas mostram a mesma
  tabela somente leitura (produto/anúncio, SKU, loja, ID do anúncio,
  estoque disponível, status, última sincronização), com seletor de
  empresa, aviso de pendência quando aplicável, e o botão "Sincronizar
  agora" que chama o `POST` novo.
- **Confirmação por auditoria de código:** nem `lib/mlSync.js`
  (sincronização de pedidos) nem `routes/pedidos.js` nunca tiveram lógica
  de baixa de estoque numa venda — a regra "nunca dar baixa duplicada" já
  estava estruturalmente satisfeita antes desta etapa; nenhuma lógica
  nova desse tipo foi introduzida agora.
- **Testes automatizados novos** (29 testes, todos contra Postgres real):
  `server/test/mlEstoque.test.js` (24 — unitários de resolução de SKU/
  quantidade e integração com os 3 formatos de resposta de User Products,
  Full vs. não-Full nunca misturados, e o cenário exato pedido pelo
  usuário: sincronizar com 500, sincronizar de novo com 800, confirmar
  que o valor final é 800 sem duplicar linha, rodar uma 3ª vez para
  confirmar idempotência) e `server/test/estoqueRoutes.test.js` (5 — as
  rotas HTTP novas, incluindo o `410` do ajuste manual desativado). Suíte
  completa do projeto (110 testes) rodada sem falhas depois da mudança.
- **Pendente (precisa de ambiente de produção, fora do alcance deste
  ambiente de teste):** confirmar ao vivo que uma mudança de quantidade
  no Mercado Livre aparece no ERP após a sincronização, e validar o
  caminho de User Products com uma conta real de estoque multi-origem —
  ver `06-proximos-passos.md`.

## 2026-08-24 (19) — Sincronização automática do Mercado Livre (backend, 1 em 1 minuto)
- **Pedido do usuário, em 3 passos:** (1) sincronização automática no
  BACKEND a cada 1 minuto, funcionando mesmo sem ninguém com o ERP aberto,
  nunca via `setInterval` no navegador; (2) cobrir pedidos novos, mudança
  de status, pagamentos, cancelamentos, devoluções, envio, taxas/comissões
  e frete (vendedor e comprador), nunca duplicando (idempotência pelo ID
  do Mercado Livre), combinando webhook (atualização rápida) com o ciclo
  de 1 minuto (segurança/reconciliação); (3) indicador discreto de status
  no ERP ("Sincronizado há Xs" / "Erro na sincronização"), com log do
  erro, sem que um erro trave as próximas sincronizações. Antes de
  implementar, o usuário pediu para verificar o ambiente do Render e
  avisar antes de qualquer solução improvisada — ver `02-decisoes.md`
  (19) para a investigação completa e a decisão tomada (upgrade do plano
  Free → Starter, escolhida pelo próprio usuário depois do relatório).
- **`server/lib/syncScheduler.js` (novo):** o coração da automação.
  `iniciarSincronizacaoAutomatica()` é chamada uma vez, em
  `server/server.js`, depois do `app.listen` — registra um `setInterval`
  de 1 minuto (`ML_SYNC_INTERVALO_MS`, configurável, padrão 60000ms) e já
  dispara o primeiro ciclo na hora (não espera 1 minuto pro primeiro
  pedido aparecer). Cada ciclo (`executarCicloDeSincronizacao`): busca
  `ml_contas` com `status = 'ativa'`, chama
  `sincronizarConta(contaId, { diasAtras: ML_SYNC_RECONCILIACAO_DIAS })`
  (padrão 2 dias — ver `02-decisoes.md` para o motivo da janela menor)
  para cada uma via `Promise.allSettled`, isolando erro por conta, e
  registra o resultado num objeto de estado em memória (usado pelo
  indicador de status). Trava contra ciclos sobrepostos (se o ciclo
  anterior ainda está rodando, o próximo disparo é pulado, com log de
  aviso) e nunca deixa uma rejeição de promise sem `.catch` (poderia
  derrubar o processo Node inteiro e travar todas as sincronizações
  futuras). **Nenhuma regra de importação/cálculo nova** — chama
  exatamente `lib/mlSync.js#sincronizarConta`, o mesmo código que o botão
  manual sempre usou.
- **`server/routes/integracoes.js` (novo endpoint, aditivo):** `GET
  /api/integracoes/mercadolivre/status-automatico` expõe o estado do
  ciclo automático (última execução, se deu erro, quais contas falharam)
  — usado só pelo indicador do header. Nada nos endpoints existentes
  (webhook, sincronizar manual, sincronizar-historico) foi alterado.
- **`server/public/index.html` (aditivo):** novo indicador discreto no
  header (`#mlSyncStatus`, ao lado dos seletores de empresa/período),
  mostrando "Sincronizado há Xs/Xmin" (relativo) ou "Última
  sincronização: HH:MM" (depois de 1h), virando "Erro na sincronização"
  (motivo no tooltip) quando o último ciclo falhou. Só aparece quando a
  integração com o Mercado Livre está configurada no servidor
  (`config-status`). Relê o status pronto do servidor a cada ~20s e
  recalcula o texto relativo a cada ~5s — sem nenhuma chamada de
  sincronização de verdade a partir do navegador (só leitura de um status
  já calculado no servidor), respeitando a proibição explícita do usuário
  de usar `setInterval` no front-end para sincronizar.
- **Testes automatizados novos** (`server/test/syncScheduler.test.js` e
  `server/test/mlSync.reconciliacao.integration.test.js`, 8 testes, todos
  contra Postgres real): confirmam que só contas com `status='ativa'`
  entram no ciclo (nunca `erro`/`desconectada`); que uma conta falhando
  nunca impede outra nem o próximo ciclo, e o erro reportado nunca mistura
  `contaId`/`empresaId`; que a trava contra sobreposição funciona (um 2º
  disparo enquanto o 1º ainda roda é pulado); e, usando
  `sincronizarConta` de verdade contra os 11 pedidos reais da conta
  PFEMBALAGEMS (API do Mercado Livre mockada, já que este ambiente não
  tem credenciais/internet reais): um pedido novo entra sozinho (mesma
  função chamada pelo ciclo automático), rodar a sincronização de novo
  nunca duplica, e uma mudança de status num pedido existente vira UPDATE
  da mesma linha (nunca um pedido novo).
- **`server/node_modules/pg|dotenv|express|exceljs` recriados** (stubs de
  teste, gitignored, nunca vão pro deploy — precisaram ser recriados
  porque foram removidos na empacotagem da etapa anterior). O stub do
  `express` foi reescrito como um servidor HTTP real (módulo `http` do
  Node), não só um capturador de rotas — permitiu testar o servidor de
  ponta a ponta neste ambiente (`node server.js` respondendo requisições
  HTTP de verdade), incluindo o endpoint novo de status.

## 2026-08-25 (18) — Ativação de Ads e Relatórios
- **Pedido do usuário:** ativar mais 2 áreas do ERP que já existiam como
  placeholder no menu — Ads (dado real de Product Ads do Mercado Livre
  "quando a integração/API permitir", nunca inventado) e Relatórios
  (categorias usando só dado real que já existe no ERP, com as MESMAS
  regras de Visão Geral/Pedidos/Financeiro — "nunca crie cálculos
  separados"). Regras explícitas: nunca inventar valor (mostrar "Pendente
  de sincronização"/"Dado não disponível" em vez disso); filtros de
  empresa/loja/período (e SKU em Relatórios) precisam funcionar; não
  implementar Shopee Ads ainda; não alterar outras áreas nesta etapa;
  parar depois dessas duas áreas.
- **`buscarItensDoPeriodo` (novo, em `lib/relatorioVendas.js`) — a fonte
  única desce ao nível de item/anúncio.** Até aqui a fonte única
  (`buscarPedidosDoPeriodo`/`resumirPeriodo`) só decompunha por pedido;
  Ads e o relatório de Produtos precisam de margem por SKU/anúncio, não só
  por pedido. A nova função decompõe cada pedido em suas linhas
  (`ml_pedido_itens`), reaproveitando `calcularResultadoVenda` por item.
  Comissão (`taxa_venda`, já é sale_fee × quantidade da linha) e custo do
  produto (`produtos.custo × quantidade`) são **sempre exatos por item,
  nunca rateados** — são genuinamente itemizáveis no dado já salvo. Frete
  do vendedor, desconto (cupom) e tarifas de pagamento além da comissão
  **são rateados proporcionalmente ao valor de cada item** só quando o
  pedido tem mais de 1 item (Mercado Livre não itemiza esses três campos)
  — um pedido de item único tem rateio 100% exato (ratio=1). Testado:
  soma dos itens de cada pedido bate exatamente com o valor/frete do
  pedido inteiro (reconciliação automatizada, ver `server/test/ads.test.js`).
- **Ads — duas fontes bem separadas, nunca misturadas numa fórmula
  nova.** `lib/mlAds.js` é o cliente da API de Advertising (Product Ads)
  do Mercado Livre — pesquisada na documentação pública em 25/08/2026
  (endpoints `/advertising/advertisers`,
  `/advertising/product_ads/items`, headers `Api-Version`) já que o
  projeto nunca tinha integrado essa API antes (só a API de
  pedidos/anúncios). Toda chamada é protegida (try/catch): qualquer falha
  (conta sem acesso a Ads, app sem o produto habilitado, erro de rede)
  devolve um motivo estruturado, nunca um número estimado. `lib/ads.js`
  agrega por anúncio: investimento, vendas atribuídas, faturamento
  atribuído, ROAS e ACOS vêm sempre da API de Ads (nativos quando a API
  já devolve o campo, calculados a partir dos números brutos da própria
  API só quando ela omite o campo pronto — nunca de uma fonte externa);
  faturamento real e margem "antes do Ads" vêm de
  `buscarItensDoPeriodo`, agrupado por `ml_item_id`. TACOS = investimento
  em Ads ÷ **faturamento real** do anúncio no período (não o "atribuído"
  pelo Mercado Livre) — só calculado quando os dois números existem.
  Margem depois do Ads = margem real de contribuição − investimento em
  Ads (ou seja, venda − taxas/comissões − frete do vendedor − imposto −
  custo do produto − Ads), respondendo diretamente ao pedido do usuário
  de "não analisar só ROAS" e ver se o anúncio é REALMENTE lucrativo
  depois do Ads. `lib/mercadolivre.js` ganhou um terceiro parâmetro
  opcional em `apiGet` (`extraHeaders`, aditivo — chamadas existentes não
  mudam) só pra suportar o header `Api-Version` exigido pela API de
  Advertising.
- **Relatórios — 3 categorias, nenhum cálculo novo.**
  `lib/relatoriosAgregados.js` só filtra/agrupa o que
  `lib/relatorioVendas.js` e `lib/ads.js` já calculam: **Vendas e
  Margem** chama `resumirPeriodo` depois de filtrar pedidos por loja
  (igual ao Relatório de Pedidos já existente) e soma o investimento em
  Ads (mesma fonte da tela Ads) numa linha própria; **Produtos** agrupa
  por SKU os itens de `buscarItensDoPeriodo`; **Marketplaces/Lojas**
  agrupa pedidos por conta e chama `resumirPeriodo` por loja (nenhum
  rateio aqui — cada pedido pertence inteiro a 1 loja). Testado
  automaticamente que os totais de cada categoria batem, até o centavo,
  com o que `resumirPeriodo`/`buscarPedidosDoPeriodo` já mostram em Visão
  Geral/Pedidos/Financeiro para o mesmo período — a exigência central do
  usuário. Exportação (XLSX/CSV) acrescentada em `routes/relatorios.js`
  (`GET /api/relatorios/exportar?categoria=...&formato=xlsx|csv`), no
  mesmo padrão já usado no Relatório de Pedidos (ExcelJS, cabeçalho em
  negrito, "pendente" pra dado faltando, nunca um valor calculado à
  parte) — sempre respeita os filtros da tela (empresa, loja, período,
  SKU), nunca exporta outra empresa/período.
- **Arquivos novos:** `server/lib/mlAds.js`, `server/lib/ads.js`,
  `server/lib/relatoriosAgregados.js` (regra de negócio);
  `server/routes/ads.js` (API); `server/test/ads.test.js`,
  `server/test/relatorios.test.js` (12 testes automatizados novos, 0
  falhas — total do projeto: 72 testes, 0 falhas); 2 módulos novos em
  `server/public/index.html` (`window.Ads`, `window.Relatorios`).
- **Arquivos alterados (aditivo, sem regressão):**
  `server/lib/relatorioVendas.js` (nova função `buscarItensDoPeriodo`,
  funções existentes intocadas), `server/lib/mercadolivre.js` (parâmetro
  opcional novo em `apiGet`), `server/routes/relatorios.js` (4 rotas
  novas somadas à já existente `/resumo-vendas`, que não mudou),
  `server/server.js` (1 rota nova registrada — `/api/ads`).
- Nenhuma tabela nova no banco — Ads e Relatórios seguem o mesmo padrão
  "sem tabela própria, sempre ao vivo" já usado em Anúncios/Recebimentos/
  DRE.

## 2026-08-24 (17) — Ativação de DRE, Faturamento e Notas Fiscais
- **Pedido do usuário:** ativar mais 3 áreas do ERP que já existiam como
  placeholder no menu — DRE (visão por período em R$ e %, usando dado
  real já existente, sem inventar valor), Faturamento (hub de pedidos a
  faturar, com status e ações em lote, sem emissão real de NF-e) e Notas
  Fiscais (estrutura de registro/acompanhamento vinculada ao pedido, sem
  integração com a SEFAZ). Regras explícitas: nunca duplicar pedido;
  nunca misturar empresas/CNPJs; nunca inventar valor, número de NF-e ou
  chave de acesso; não implementar SEFAZ ainda; não alterar outras áreas
  nesta etapa; parar depois dessas três áreas.
- **DRE — demonstrativo por período, sem fórmula financeira nova.**
  Reorganiza em forma de waterfall os mesmos números já calculados por
  `lib/relatorioVendas.js` (`buscarPedidosDoPeriodo` + `resumirPeriodo`,
  intocado) e `lib/contasPagar.js` (`resumoContasPagar`, intocado): Receita
  Bruta, (-) Cancelamentos/Devoluções, (-) Descontos concedidos, = Receita
  Líquida, (-) Custo dos Produtos, (-) Taxas e Comissões dos marketplaces,
  (-) Frete do vendedor, (-) Impostos, = Margem de Contribuição (sempre
  lida direto de `resumirPeriodo`, nunca recalculada), (-) Despesas/Contas
  pagas do período, = Resultado Final. Cada linha mostra R$ e % sobre o
  faturamento. Período sem nenhum pedido mostra "Sem dados" em toda linha
  de receita (nunca R$ 0,00); informação faltando numa parte específica
  (ex: custo de SKU) mostra "Pendente" só ali.
- **Faturamento — situação de faturamento por pedido, sem emissão real.**
  Tabela nova (`faturamento_pedidos`, 1:1 com `ml_pedidos` via `pedido_id`
  único), reaproveitando a mesma fonte única de pedidos (left join — um
  pedido sem linha registrada aparece como "Aguardando faturamento" por
  padrão). Lista data, número do pedido, marketplace, loja, cliente,
  valor, status do pedido e situação de faturamento (Aguardando
  faturamento/Faturado/Erro/Cancelado). Suporta pesquisar pedido, filtrar
  por empresa/período (header) e por situação, seleção múltipla com ação
  em lote (Marcar como Faturado/Erro/Cancelado — nomeada assim de
  propósito, nunca "Emitir NF-e", já que a emissão real está fora do
  escopo). Mudar a situação nunca duplica linha — sempre upsert por
  `pedido_id`.
- **Notas Fiscais — 1 nota por pedido, sem inventar número/chave.**
  Tabela nova (`notas_fiscais`, 1:1 com `ml_pedidos` via `pedido_id`
  único, upsert). Campos: número, série, pedido, empresa/CNPJ (via JOIN,
  nunca duplicado), cliente (via JOIN), valor, data de emissão, chave de
  acesso (quando existir), status (Pendente/Emitida/Cancelada/Rejeitada).
  Marcar como "Emitida" **exige** número, série, data de emissão e chave
  de acesso (44 dígitos, validado) — sem os 4 campos o backend recusa a
  mudança, nunca aceita uma emissão incompleta. Um pedido sem nota
  registrada aparece corretamente como "Pendente", com todos os campos da
  nota em branco. Abrir uma nota mostra os dados do pedido relacionado
  (data, cliente, loja, status, itens), reaproveitando o mesmo endpoint de
  detalhe já usado em Pedidos.
- **`ON DELETE CASCADE`** adicionado nas duas novas FKs para
  `ml_pedidos(id)` — a sincronização real nunca apaga pedido (é sempre
  upsert), então isso não deveria disparar em produção; existe pra nunca
  deixar uma situação de faturamento/nota órfã, e pra não travar o teste
  de idempotência já existente (que apaga e recria os pedidos seedados a
  cada execução).
- **Arquivos novos:** `server/lib/dre.js`, `server/lib/faturamento.js`,
  `server/lib/notasFiscais.js` (regra de negócio); `server/routes/dre.js`,
  `server/routes/faturamento.js`, `server/routes/notasFiscais.js` (API);
  `server/test/dre.test.js`, `server/test/faturamento.test.js`,
  `server/test/notasFiscais.test.js` (26 testes automatizados novos, 0
  falhas); 3 módulos novos em `server/public/index.html`
  (`window.DRE`, `window.Faturamento`, `window.NotasFiscais`).
- **Arquivos alterados (aditivo, sem regressão):** `server/db/schema.sql`
  (2 tabelas novas: `faturamento_pedidos`, `notas_fiscais`),
  `server/server.js` (3 rotas novas registradas).
- **Correção incidental no stub de teste local do driver `pg`
  (`server/node_modules/pg/index.js`, não vai pro deploy — está no
  `.gitignore`):** um array JS num parâmetro de query estava sendo
  codificado como JSON (`'[...]'::jsonb`), o que quebrava qualquer query
  no padrão `= ANY($N::int[])`/`= ANY($N::text[])` — incluindo código já
  existente antes desta etapa (`routes/pedidos.js`,
  `lib/produtoBaseConversao.js`), só nunca exercitado num teste de
  integração até agora. Corrigido para emitir literal de array nativo do
  Postgres (`'{a,b,c}'`), igual ao driver `pg` real faz.
- **Testado:** 26 testes novos + os 34 já existentes (Financeiro +
  correção de margem) = 60 testes, 0 falhas. Testado também de ponta a
  ponta com o servidor real rodando localmente (Postgres local, com os 11
  pedidos reais da conta PFEMBALAGEMS): as três telas carregam com dado
  real via requisição HTTP direta e navegador real (Playwright); DRE
  mostra "Sem dados" pra empresa sem pedido e valores reais pra empresa
  com pedido, e reage à troca de empresa no filtro do header;
  Faturamento — pesquisa, filtro por status, ação em lote pela interface
  (seleção múltipla) e mudança individual de situação, tudo persistindo
  no banco; Notas Fiscais — preenchimento e emissão de uma nota completa
  pela interface (número, série, data, chave de 44 dígitos), validação
  rejeitando emissão incompleta e chave inválida, e o pedido aparecendo
  corretamente como "Pendente" antes da emissão. Um bug real foi achado e
  corrigido durante o teste manual pela interface: o modal de Notas
  Fiscais mostrava "Valor do pedido" sempre em branco porque lia
  `pedido.valorTotal` (campo que não existe na resposta de
  `GET /api/pedidos/:id`) em vez do `valorPedido` já retornado pela
  própria listagem de Notas Fiscais — corrigido em
  `server/public/index.html`. Dados de teste (linhas de
  `faturamento_pedidos`/`notas_fiscais` criadas durante os testes) foram
  removidos do banco local ao final.

## 2026-08-24 (16) — Ativação do módulo Financeiro: Contas a Pagar, Contas a Receber e Recebimentos
- **Pedido do usuário:** ativar 3 áreas do Financeiro que já existiam como
  placeholder no menu — Contas a Pagar, Contas a Receber (as duas com
  lançamento manual) e Recebimentos (conciliação de repasse de marketplace
  — hoje só Mercado Livre está integrado — com dado real da API, nunca
  inventado). Regras explícitas: o filtro de empresa/período do HEADER
  precisa funcionar nas três telas; nunca misturar dados entre CNPJs;
  nunca usar dado fictício; não alterar DRE, Faturamento ou Notas Fiscais
  nesta etapa; parar depois dessas três áreas.
- **Contas a Pagar e Contas a Receber — cadastro manual, com status
  calculado.** Duas tabelas novas (`contas_pagar`, `contas_receber`), CRUD
  completo (cadastrar, editar, excluir, cancelar, marcar como pago/
  recebido, pesquisar, filtrar por status/empresa/período), campos
  exatamente como pedido (descrição, empresa, fornecedor — opcional, só em
  Contas a Pagar —, categoria/origem em texto livre com sugestões, valor,
  datas, status, observação). KPIs no topo: total em aberto, vencendo/
  previsto hoje, vencidas/atrasadas (sempre o saldo atual da empresa, sem
  filtro de período — respondem "quanto tem em aberto agora"), e pago/
  recebido no período (esse sim filtrado pelo período do header). A lista
  de contas é filtrada pelo período selecionado (por vencimento/data
  prevista).
- **"Vencido"/"Atrasado" nunca é um valor gravado no banco** — é sempre
  calculado no momento da consulta, comparando o vencimento com a data de
  hoje em fuso BRT. Evita depender de uma tarefa agendada rodando todo dia
  só pra "promover" status.
- **Imutabilidade:** uma conta marcada como paga/recebida não pode mais
  ser editada nem excluída (fica só de histórico). Uma conta pendente pode
  ser editada, cancelada ou excluída livremente; uma cancelada não pode
  mais ser editada, mas ainda pode ser excluída.
- **Recebimentos — conciliação com o Mercado Livre, sem inventar dado.**
  Não é lançamento manual: mostra, ao vivo, os pedidos com pagamento
  aprovado no período, reaproveitando a mesma fonte única de dados já
  usada em Pedidos/Visão Geral/Financeiro (`lib/relatorioVendas.js`, nada
  duplicado) — valor bruto, taxas/descontos (comissão do ML + frete do
  vendedor + desconto do cupom) e o valor líquido que o ERP esperava
  receber. **Conferido direto no banco de produção (Supabase) que a
  integração atual com a API do Mercado Livre não traz nenhum dado de
  liberação/repasse** (sem `money_release_date` ou equivalente no payload
  de pagamento salvo) — por isso "previsão de liberação", "valor
  recebido" e "data do recebimento" aparecem sempre como "Informação não
  disponível", nunca um valor calculado ou chutado, e o status sempre
  como "A liberar" (única opção honesta possível hoje). A tela já está
  pronta para, no futuro, comparar valor esperado x valor realmente
  repassado assim que essa informação existir na integração.
- **Filtro do header:** as três telas leem o filtro de empresa/período
  direto de `window.CerneFiltro` (mesmo padrão já usado pela Visão Geral)
  — nunca um seletor próprio da tela — e recarregam sozinhas quando o
  usuário troca empresa ou período no topo.
- **Arquivos novos:** `server/lib/contasPagar.js`, `server/lib/contasReceber.js`,
  `server/lib/recebimentosMl.js` (regra de negócio); `server/routes/contasPagar.js`,
  `server/routes/contasReceber.js`, `server/routes/recebimentos.js` (API);
  `server/test/financeiro.test.js` (13 testes automatizados, 0 falhas);
  3 módulos novos em `server/public/index.html` (`window.ContasPagar`,
  `window.ContasReceber`, `window.Recebimentos`).
- **Arquivos alterados (aditivo, sem regressão):** `server/db/schema.sql`
  (2 tabelas novas), `server/lib/relatorioVendas.js` (1 campo novo
  exposto, `pagamentoStatus` — não muda nenhum valor já calculado),
  `server/lib/periodo.js` (nova função `periodoParaDatasBRT`),
  `server/server.js` (3 rotas novas registradas).
- **Testado:** 13 testes novos + os 21 já existentes da correção de
  margem = 34 testes, 0 falhas. Testado também de ponta a ponta com o
  servidor real rodando localmente (Postgres local, com os 11 pedidos
  reais da conta PFEMBALAGEMS já usados na correção de margem) via
  requisição HTTP direta e navegador real (Playwright): as três telas
  carregam com dado real, os filtros de empresa do header funcionam,
  cadastro/edição/marcar como pago persistem no banco entre requisições.

## 2026-08-24 (15) — Correção da margem: 4 bugs achados na reconciliação PF ERP x Mercado Turbo
- **Pedido do usuário:** o usuário conferiu, pedido a pedido, os 73 pedidos
  pagos em comum entre o ERP e uma ferramenta de referência externa
  ("Mercado Turbo") em 23/08/2026, e achou o ERP superestimando a margem em
  R$2,74 no total (R$624,92 no ERP vs R$622,18 no Mercado Turbo — com erros
  positivos e negativos se compensando, e um 74º pedido faltando
  inteiramente). Pediu correção na causa raiz (nunca só na tela), dados
  reais da API pra decidir cada bug (nunca escolher um campo só pelo nome),
  testes automatizados com os pedidos reais, e um relatório final
  pedido-a-pedido — não só os totais.
- **Diagnóstico (Etapa 1) feito por leitura de código**, formando hipóteses
  pra cada bug; **investigação (Etapa 2)** confirmou todas com dados reais
  do banco de produção (Supabase, MCP conectado pelo usuário durante a
  sessão) pros 11 pedidos que o usuário apontou como exemplo — `raw_pedido`,
  `raw_envio`, `raw_custos_envio` e `raw_pagamento` (sempre guardados
  íntegros desde o início da integração) foram a fonte, nunca suposição.
- **Bug 1 — frete duplicado em pedidos do mesmo carrinho.** Quando o
  comprador fecha, no mesmo checkout, mais de um pedido do mesmo vendedor
  (mesmo `pack_id`), o Mercado Livre gera um envio ÚNICO pros dois — mas
  `/shipments/{id}/costs` devolve o custo do ENVIO inteiro, não do pedido.
  A sincronização gravava esse valor cheio em CADA pedido, duplicando o
  frete somado. Confirmado com os pedidos reais 2000018075073530 e
  2000018075078724: mesmo `ml_shipping_id`, mesmíssimo `raw_custos_envio`
  (`senders[0].cost = 15.90`). **Regra anterior:** cada pedido gravava o
  `senders[].cost` inteiro. **Regra nova:** depois de gravar um pedido com
  `ml_shipping_id`, o frete (comprador e vendedor) é rateado IGUALMENTE
  entre todos os pedidos da conta que compartilham esse mesmo
  `ml_shipping_id` — sempre recalculado a partir do valor BRUTO da API
  (nunca a partir de um valor já rateado), e reaplicado a TODOS os pedidos
  do envio toda vez que um novo pedido daquele mesmo envio é sincronizado
  (se resolve sozinho quando o segundo pedido do carrinho chega antes ou
  depois do primeiro). Os dois pedidos reais acima: R$15,90 → R$7,95 cada,
  batendo exatamente o valor que o usuário esperava.
- **Bug 2 — comissão (sale_fee) não multiplicada pela quantidade.**
  `order_items[].sale_fee` vem da API POR UNIDADE, não pela linha inteira —
  a sincronização gravava o valor cru, subestimando a comissão (e
  superestimando a margem) em pedidos com quantidade > 1, na mesma
  proporção da quantidade. Confirmado com 4 pedidos reais (incluindo um
  CANCELADO, prova de que não é ligado ao status): 2000018078185798
  (qtd 2, sale_fee 5.66 → comissão real 11.32), 2000018081695020 (qtd 2,
  2.36 → 4.72), 2000018082412310 (qtd 2, 3.45 → 6.90), 2000018086572830
  (cancelado, qtd 2, 2.12 → 4.24). **Regra anterior:** `taxa_venda` /
  `taxa_venda_total` = soma direta de `sale_fee`. **Regra nova:** cada
  linha usa `sale_fee × quantity`; o total do pedido soma essas linhas.
- **Bug 3 — desconto de cupom do pagamento não capturado em lugar
  nenhum.** O único mecanismo de desconto que já existia (preço "de"
  `full_unit_price` vs preço pago `unit_price`, no relatório de Pedidos)
  vinha sempre NULL nos 4 pedidos reais da investigação — o desconto de
  verdade estava em `payments[].coupon_amount` (cupom Mercado
  Livre/PIX), nunca gravado nem usado no cálculo. Confirmado nos 4 pedidos
  reais: 2000018077005362 (R$1,77), 2000018078186456 (R$1,67),
  2000018082460366 (R$1,77), 2000018086627042 (2 pagamentos, R$0,86 +
  R$1,81 = R$2,67) — batendo exatamente as diferenças que o usuário
  reportou. **Regra anterior:** nenhum desconto de cupom entrava no
  cálculo — a receita da venda usada era sempre o valor bruto do pedido.
  **Regra nova:** soma-se `coupon_amount` dos pagamentos APROVADOS do
  pedido (nova coluna `ml_pedido_pagamentos.coupon_amount`, com fallback
  pro `raw_pagamento` já existente pros pagamentos sincronizados antes
  dessa coluna existir — nenhum pedido antigo fica com o cálculo errado); a
  receita líquida (valor da venda − desconto) passa a ser a base tanto da
  margem quanto do imposto.
- **Bug 4 — pedido pago não aparecia no dia certo.** Todo filtro de
  período (Visão Geral, Pedidos, Financeiro, Relatório) usava só
  `data_criacao` (`order.date_created` — quando o pedido foi criado),
  nunca quando foi realmente fechado/pago. O pedido real 2000018066590190
  foi criado em 22/08 (2 tentativas de pagamento recusadas), mas só foi
  aprovado e fechado em 23/08 — ficava sempre no período de 22/08, sumindo
  da reconciliação de 23/08 que o usuário fez. **Regra anterior:** filtro
  de período comparava só `data_criacao`. **Regra nova:** usa
  `COALESCE(data_fechamento, data_criacao)` — `data_fechamento`
  (`order.date_closed`) já era salva pela sincronização, só não era usada
  em filtro nenhum; pedido ainda não fechado (em aberto) continua usando
  `data_criacao`, sem regressão. Vale pros 3 lugares que filtravam por
  período (`lib/relatorioVendas.js`, e o filtro de Status disponível em
  `routes/pedidos.js`) e pro agrupamento por dia do gráfico de Visão Geral.
- **Arquivos e funções alterados** (raiz do cálculo, não a tela):
  `lib/mlSync.js` (`importarPedidoInterno` — extraídas em funções puras
  testáveis: `extrairFreteDoCustosEnvio`, `ratearValor`,
  `calcularTaxaVendaItem`, `calcularTaxaVendaTotal`; novo bloco de rateio
  de frete depois do UPSERT do pedido; `coupon_amount` gravado em
  `ml_pedido_pagamentos`); `lib/resultadoVenda.js` (`calcularResultadoVenda`
  ganhou o parâmetro `desconto`, nunca bloqueia `calculoCompleto` — ausência
  de cupom é 0 de verdade, não "pendente" — e passou a basear o imposto na
  receita líquida); `lib/relatorioVendas.js` (`SQL_DATA_EFETIVA` e
  `SQL_DESCONTO_CUPOM`, reaproveitados também em `routes/pedidos.js` pro
  filtro de Status e pro detalhe do pedido); `db/schema.sql` (coluna nova
  `ml_pedido_pagamentos.coupon_amount`, sem migração de dados retroativa —
  desnecessária, o `raw_pagamento` já tinha o valor completo desde sempre).
  `routes/pedidos.js` perdeu o cálculo de desconto próprio do relatório
  Excel/CSV (`buscarDescontosPorPedido`, baseado só no preço "de" que
  vinha sempre NULL) — agora usa o mesmo `desconto` da fonte única.
  Frontend (`public/index.html`): linha "Desconto (cupom)" nova no detalhe
  do pedido, no card de Visão Geral e no resumo de Financeiro.
- **Testes automatizados** em `server/test/` (`node --test`), usando os 11
  pedidos reais buscados no Supabase de produção durante a investigação
  (`server/test/fixtures/real-orders.json`, nunca hardcoded na lógica de
  cálculo — só como dado de teste): `mlSync.test.js` (Bugs 1 e 2, funções
  puras, sem banco), `resultadoVenda.test.js` (Bug 3, fórmula pura),
  `relatorioVendas.integration.test.js` (Bugs 3 e 4 e o Teste 6 de
  idempotência — pedido pra rodar contra um Postgres local, ver
  instruções no topo do arquivo). Rodados manualmente nesta sessão contra
  um Postgres local seedado com os 11 pedidos reais (mesma lógica de
  produção, via `server/test/fixtures/gerar-seed-sql.js`): todos os
  valores batem exatamente com os esperados (R$7,95/R$7,95 de frete,
  comissões corretas, R$1,77/R$1,67/R$1,77/R$2,67 de desconto, pedido
  faltante aparecendo no dia certo); resincronizar duas vezes não duplicou
  nem mudou nenhum total (idempotência confirmada). A suíte formal rodou
  completa via `node --test` (21 testes, 5 suítes, 0 falhas) contra o
  Postgres local seedado com os 11 pedidos reais — confirmação final
  registrada em 24/08/2026.
- **Não corrigido nesta etapa (fora do escopo dos 4 bugs reportados):**
  reconciliação completa dos 73/74 pedidos do dia 23/08 contra o Mercado
  Turbo (só os 11 pedidos-exemplo foram testados, os outros ~62 pedidos
  pagos em comum não foram conferidos pedido a pedido); nenhuma mudança em
  Ads, nem em custo de produto/estoque.
- **Aviso de segurança encontrado, não corrigido:** o Supabase reportou
  Row Level Security desligada em todas as 21 tabelas do banco de produção
  (qualquer um com a chave `anon` consegue ler/editar tudo) — informado ao
  usuário no chat, SQL de correção não aplicado automaticamente (decisão
  do usuário, ver `05-problemas-conhecidos.md`).

## 2026-08-24 (14) — Unificação Produtos + Custo & Margem (aba Custo & Margem removida)
- **Aba "Custo & Margem" removida do menu.** Cadastro de custo por SKU e a
  alíquota de imposto da empresa agora ficam só na tela **Produtos**, que
  passa a servir para cadastrar/editar: nome, SKU, custo do produto,
  status (ativo/inativo) e a alíquota de imposto da empresa. **Esta tela
  nunca mostra margem** — pedido explícito do usuário.
- **Dados preservados e migrados:** a tabela antiga `custos_produto`
  continua no banco, intocada (histórico) — seus dados (SKU + custo) foram
  copiados pra dentro de `produtos` numa migração automática que roda uma
  única vez no primeiro boot após o deploy (nunca de novo, pra não
  sobrescrever edições futuras do usuário — ver `02-decisoes.md` (14) para
  o desenho completo e o porquê). SKU que só existia na Custo & Margem
  virou um produto novo (nome = SKU, editável depois); SKU que já existia
  também em Produtos teve o custo atualizado para o valor que estava
  realmente em uso no cálculo (o de `custos_produto`), preservando o nome
  já cadastrado.
- **Cálculo de margem não mudou — só a fonte do custo.** A fórmula
  continua exatamente a mesma (valor da venda − taxas/comissões − frete do
  vendedor − imposto − custo do produto = margem de contribuição), usada
  nas mesmas telas de sempre (Pedidos, Visão Geral, Financeiro,
  Relatórios). `lib/relatorioVendas.js` e a rota de detalhe do pedido
  (`routes/pedidos.js GET /:id`, que tinha sua própria busca de custo
  separada) passaram a ler o custo de `produtos` em vez de
  `custos_produto` — as duas fontes de cálculo continuam idênticas entre
  si (lista de Pedidos e detalhe do pedido nunca divergem).
- **Imposto continua uma alíquota única por empresa** (não virou um campo
  por produto) — confirmado com o usuário antes de implementar, pra não
  mudar o resultado financeiro calculado sem ele ter pedido isso de
  propósito. Só a tela onde essa alíquota é configurada mudou.
- **Backend:** `routes/custos.js` perdeu as rotas de custo por SKU
  (`/api/custos-produto`), mantendo só `/api/config-financeiro` (alíquota
  de imposto). `routes/produtos.js` não ganhou rota nova — já tinha CRUD
  completo de SKU/custo. `db/migrate.js` ganhou a migração de dados
  guardada por uma tabela nova `migracoes_aplicadas` (evita repetir a
  migração a cada boot).
- **Frontend:** módulo `window.Custos` removido inteiro; sua seção
  "Imposto configurado" foi incorporada ao módulo `window.Produtos`
  (topo da tela, acima da lista de produtos). Item "Custos & Margem"
  removido do menu (grupo Análise).
- **Testado localmente** (Postgres local): migração cria produto novo pra
  SKU só em `custos_produto`; SKU já existente em ambos tem o custo
  atualizado sem perder o nome; migração rodada de novo não repete (nem
  reverte edição feita depois); rotas de Produtos (criar/editar/listar,
  SKU duplicado rejeitado) e de imposto (`config-financeiro`) funcionando;
  Pedidos (lista e detalhe) e o Relatório de Pedidos (CSV) calculando
  custo/margem corretamente a partir de `produtos`, com os totais batendo
  entre lista, detalhe e relatório. **Não testado contra o banco de
  produção (Supabase)** — ver `05-problemas-conhecidos.md`.
- Nenhum outro módulo foi alterado nesta tarefa.
- **Onde está:** `server/routes/produtos.js`, `server/routes/custos.js`,
  `server/routes/pedidos.js` (`GET /:id`), `server/lib/relatorioVendas.js`,
  `server/db/schema.sql` (comentários + tabela `migracoes_aplicadas`),
  `server/db/migrate.js` (migração de dados), `server/public/index.html`
  (módulo `window.Produtos`, menu).

## 2026-08-24 (13) — Relatório de Pedidos (Excel/CSV) + filtros de Loja/Status/Produto na tela Pedidos
- **Novos filtros na tela Pedidos:** além de empresa e período (já
  existentes), agora tem filtro por **loja** (conta do Mercado Livre),
  **status** do pedido e busca livre por **produto/SKU**. As opções de
  loja vêm das contas ML cadastradas na empresa (`GET` simples, sem custo
  de performance); as opções de status vêm dos status **reais** achados
  nos pedidos do período (`SELECT DISTINCT`, nunca uma lista fixa
  adivinhada). Os três filtros são aplicados em memória sobre o resultado
  já calculado por `buscarPedidosDoPeriodo`/`resumirPeriodo`
  (`server/lib/relatorioVendas.js`, **não alterado** nesta tarefa) — a
  forma de calcular cada pedido continua exatamente a mesma.
- **Botão "Gerar relatório" (Excel e CSV):** exporta exatamente os pedidos
  que batem com os filtros selecionados na tela no momento do clique
  (empresa, período, loja, status, produto/SKU) — nunca mistura empresas,
  nunca inclui pedido fora do filtro escolhido. Uma linha por pedido:
  data, número do pedido, loja, produto, SKU, quantidade, valor da venda,
  descontos, taxas/comissões do Mercado Livre, frete do comprador, frete
  do vendedor (em colunas separadas, como pedido), imposto, custo do
  produto, margem de contribuição em R$ e %, logística e status. No fim,
  um resumo com: total faturado, total de pedidos, total de unidades,
  total de taxas/comissões, total de frete do vendedor, total de imposto,
  total de custo dos produtos, margem de contribuição total em R$, margem
  média em %, e os pedidos cancelados à parte (fora dos totais acima, como
  em Visão Geral/Financeiro). Nome do arquivo com a data ou o intervalo do
  período filtrado (ex: `relatorio-pedidos-2026-08-24.xlsx`,
  `relatorio-pedidos-2026-08-01-a-2026-08-24.xlsx`).
- O relatório reaproveita **exatamente** os mesmos cálculos já usados no
  ERP — não existe uma regra financeira separada criada só para a
  exportação. O **desconto** de cada pedido é derivado do preço original
  informado pelo Mercado Livre na API (`preco_unitario_original`, coluna
  já existente e já preenchida com dado real) quando diferente do preço
  cobrado — não é um número inventado nem uma regra nova.
- **"Pendente" vs. zero real:** quando falta um dado (ex: tarifa que o
  Mercado Livre não retornou), o relatório mostra "pendente", nunca um
  número parcial. Quando a soma de um grupo é legitimamente zero (ex:
  filtrar só por pedidos cancelados deixa zero pedidos não-cancelados para
  somar), o relatório mostra "R$ 0,00" — corrigido um bug encontrado no
  teste local em que esse caso mostrava "pendente" incorretamente (ver
  `05-problemas-conhecidos.md` se aplicável, e detalhe abaixo em "Testado
  localmente").
- **Exportação em Excel (XLSX)** via nova dependência `exceljs` (adicionada
  em `server/package.json`; não instalável neste sandbox — `npm install`
  retorna 403 — mas instala normalmente no build do Render) — planilha com
  2 abas ("Pedidos" com cabeçalho fixo/negrito e formatação de moeda/
  percentual, "Resumo" com os totais). **Exportação em CSV** com separador
  `;` e BOM UTF-8 (padrão esperado pelo Excel em português, já que vírgula
  é separador decimal aqui). **PDF não foi implementado nesta etapa** —
  pedido explícito do usuário foi deixar isso pra depois, sem ser
  prioridade agora (ver `06-proximos-passos.md`).
- **Desempenho preservado:** a listagem da tela Pedidos continua limitada a
  500 pedidos por página (`LIMIT` no SQL) quando nenhum filtro novo
  (loja/status/busca) está ativo — sem regressão na consulta já lenta
  (`buscarPedidosDoPeriodo` roda 4 subqueries correlacionadas por linha,
  ver `05-problemas-conhecidos.md`). Só quando um filtro novo está em uso a
  listagem busca sem limite, pra garantir que nenhum pedido que bate o
  filtro fique de fora dos primeiros 500 por data. O endpoint de relatório
  (`GET /api/pedidos/relatorio`) **sempre** busca sem limite, porque a
  exportação precisa estar completa.
- **Testado localmente** (Postgres local, harness que chama as funções das
  rotas diretamente, já que `pg`/`express`/`exceljs` não instalam neste
  sandbox): totais do relatório conferem, um a um, com a soma manual dos
  dados sintéticos inseridos (faturamento, taxas, frete vendedor, imposto,
  custo produto, margem R$/%, unidades, cancelados qtd./valor); filtro por
  loja, por status e por produto/SKU testados isoladamente e combinados;
  caso `status=pedidos cancelados` testado (confirma "R$ 0,00" nos totais
  normais, não "pendente"); caso sem nenhum resultado testado (confirma
  "R$ 0,00"/"pendente" nas linhas certas, nunca um número inventado);
  `node --check` em todos os arquivos alterados (`server/routes/pedidos.js`,
  `server/public/index.html`). **Geração real do arquivo `.xlsx`/`.csv`
  não pôde ser executada de ponta a ponta neste sandbox** (sem `exceljs`
  instalado) — testado por leitura de código e por um stub que reproduz a
  API do ExcelJS usada, mas a confirmação final da abertura do arquivo no
  Excel depende do usuário testar após o próximo deploy.
- Nenhum outro módulo foi alterado nesta tarefa (só a aba Pedidos).
- **Onde está:** `server/routes/pedidos.js` (`GET /`, `GET /relatorio`,
  `filtrarPedidos`, `buscarLojasDaEmpresa`, `buscarStatusDoPeriodo`,
  `buscarDescontosPorPedido`, `gerarXlsx`, `gerarCsv`), `server/public/
  index.html` (módulo `window.Pedidos`: novos selects de loja/status,
  campo de busca, botões "Gerar relatório (Excel)"/"CSV"), `server/
  package.json` (dependência `exceljs`).

## 2026-08-24 (12) — Tela Estoque: Galpão + Full juntos, agrupados por produto base
- Reescrita a tela Estoque, que passa a ser a única tela de estoque físico
  do ERP (a antiga "Estoque Full" separada foi retirada do menu e o
  módulo de frontend `window.EstoqueFull` foi removido — o backend
  `server/routes/estoqueFull.js`/`server/lib/mlFull.js` continua existindo
  e agora é reaproveitado pela nova tela, não descartado).
- **Filtro Todos / Galpão / Full**, **uma linha por produto base** (nunca
  mais por SKU de kit) e **valor financeiro** (quantidade física × custo
  do produto base), exatamente como pedido — ver exemplo testado abaixo.
- Nova tabela `estoque_produto_base` (+ `estoque_produto_base_movimentos`
  para o histórico do ajuste manual) para o estoque físico do Galpão, e
  nova coluna `produtos_base.custo`. Estoque do Full continua sendo uma
  busca ao vivo na API do Mercado Livre (nada persistido), agora
  percorrendo **todas as páginas** da conta (`buscarEstoqueFullCompletoDaConta`
  em `server/lib/mlFull.js`, com um teto defensivo de 200 páginas) e
  convertida para quantidade física com a mesma lógica de
  `produto_base_skus`/multiplicador usada na conversão de vendas (função
  `converterItens`, extraída para `server/lib/produtoBaseConversao.js` e
  compartilhada entre as duas).
- Nova API `server/routes/estoqueProdutoBase.js`: `GET
  /api/estoque-produto-base?empresaId=&filtro=todos|galpao|full` (Galpão
  sempre um número real; Full com `pendente`/`motivo`/`mensagem` quando não
  há conta conectada, a conta está com erro, ou a API falha — os cards do
  topo ficam "Pendente" nesse caso, nunca somam um total que ignoraria o
  Full em silêncio) e `PUT /api/estoque-produto-base/:produtoBaseId`
  (ajuste manual do Galpão, mesmo padrão transacional — `BEGIN` + `SELECT
  ... FOR UPDATE` + upsert + histórico + `COMMIT` — da tela antiga).
- **Testado localmente** (Postgres local, com dados sintéticos batendo o
  exemplo do pedido do usuário: produto base `CX-19X12X12`, custo R$ 0,50,
  Galpão 5.000 → depois ajustado para 5.200 via `PUT` e confirmado de volta
  pelo `GET`; Full simulado com dois SKUs vinculados — `50CX-19X12X12`
  quantidade 40 e `25CX-19X12X12` quantidade 8 — convertendo para 2.200
  unidades físicas de Full, um SKU sem vínculo (`VARAL-DESCONHECIDO`, 10
  kits) e dois anúncios pendentes (um sem SKU, um com erro de API na
  quantidade) corretamente separados em `pendentes`, nunca somados):
  - Filtro Galpão: 5.200 caixas, R$ 2.600,00.
  - Filtro Full: 2.200 caixas, R$ 1.100,00.
  - Filtro Todos: 7.400 caixas, R$ 3.700,00 (= 5.200 + 2.200).
  - Sem conta do Mercado Livre conectada (ou conta com erro): filtro Full/
    Todos mostra "Pendente" nos cards, com a mensagem explicando o motivo —
    confirmado com a conta de teste local marcada como `erro`.
  - `node --check` em todos os arquivos alterados; teste rodado direto
    contra os handlers das rotas (sem o driver `pg`, que continua não
    instalável neste ambiente — ver `05-problemas-conhecidos.md`), usando
    o mesmo Postgres local via `psql` das etapas anteriores.
  - **Ainda não testado contra produção** — depende do usuário subir o
    próximo pacote de código (ver `06-proximos-passos.md`).
- Por instrução explícita do usuário, não foi mexido em relatórios,
  compras ou IA nesta etapa.

## 2026-08-24 (11) — Produto base + SKU de venda + Multiplicador
- Criado o conceito de **produto base**, separando o produto físico
  guardado no Galpão do SKU do "kit" vendido no Mercado Livre. Três peças
  novas no banco: `produtos_base` (o produto físico), `produto_base_skus`
  (vínculo SKU → produto base, com um `multiplicador` e uma `origem`
  `manual`/`automatico`) — ver detalhes em `03-funcionalidades.md`.
- Interpretação automática do padrão "dígitos no início do SKU"
  (`server/lib/skuProdutoBase.js`) só **sugere** um vínculo — nunca decide
  sozinha. O vínculo que vale é sempre o salvo no banco, corrigível
  manualmente a qualquer momento pela API (`PUT
  /api/produtos-base/vinculos/:id`), e o SKU original recebido do Mercado
  Livre nunca é alterado no pedido.
- Conversão de venda para quantidade física (`POST
  /api/produtos-base/conversao` e `GET
  /api/produtos-base/conversao/pedido/:pedidoId`): soma `quantidade vendida
  × multiplicador` por produto base; SKU sem vínculo salvo nunca é somado
  como zero — fica separado em `pendentes`.
- **Testado com SKUs reais da conta "PFEMBALAGEMS"** (20 de 21 SKUs
  interpretados corretamente pelo padrão automático, 1 corretamente
  rejeitado por não seguir o padrão) e com o exemplo exato do pedido do
  usuário (10 kits de 25 + 5 kits de 50 + 3 kits de 100 + 1 vínculo
  manual = 804 unidades físicas, batendo a conta esperada). Um pedido real
  (#20909) convertido corretamente de ponta a ponta.
- **Testado e confirmado ao vivo em produção** (deploy `ml15`, serviço
  `cerne-erp` no Render) — API testada direto na URL pública com dados
  reais depois do usuário subir o pacote de código.
- Por instrução explícita do usuário, não foi mexido em estoque, Full,
  compras, relatórios, margem ou financeiro nesta etapa.

## 2026-08-24 (10) — Supabase como banco principal + sincronização histórica desde 01/07/2026
- Criado projeto no Supabase (com ajuda do usuário: reset de senha do
  banco até conseguir uma connection string do **Session pooler**
  funcionando — a conexão direta só aceita IPv6, incompatível com o
  Render). Aplicado o schema completo (`server/db/schema.sql`) no Supabase.
- Migrados todos os dados existentes do Postgres antigo (Render) para o
  Supabase, preservando IDs: empresas, conta do Mercado Livre (tokens
  continuam criptografados), custos por SKU, configuração financeira e os
  **10.136 pedidos** (+ itens) já sincronizados antes desta etapa. Migração
  feita por uma rota administrativa temporária, protegida por token —
  removida do projeto depois de confirmada (ver `02-decisoes.md` (12)).
- Trocado o `DATABASE_URL` de produção do Render para a connection string
  do Supabase — novo deploy automático, confirmado `live`.
- **Teste ao vivo confirmando o passo 3 do pedido (Visão Geral sem depender
  do Mercado Livre em tempo real):** com o app já rodando no Supabase,
  chamados os 5 filtros de período (Hoje, Ontem, 7 dias, 30 dias, Este mês)
  direto na API (`/api/relatorios/resumo-vendas`) e conferido, pela aba de
  rede do navegador, que **nenhuma chamada foi feita a `api.mercadolibre.com`**
  — todos os 5 responderam 200 com dados vindos só do banco.
- **Sincronização histórica desde 01/07/2026, conta "PFEMBALAGEMS"**
  (`POST /api/integracoes/mercadolivre/1/sincronizar-historico`, `{desde:
  "2026-07-01"}`): rodou em segundo plano, dia a dia, do dia 01/07/2026 até
  hoje (23/08/2026) — **3.604 pedidos encontrados e importados, 0 erros**.
  Levou cerca de 37 minutos. Guardado, para cada pedido: dados gerais,
  itens, todos os pagamentos (tabela nova `ml_pedido_pagamentos`), envio/
  logística, frete do comprador e do vendedor, taxas/comissão e status
  (incluindo cancelamento) — exatamente como a API do Mercado Livre
  retornou, sem custo de produto nem imposto (fora do escopo desta etapa).
- **Confirmação de que rodar de novo não duplica** (testado ao vivo): a
  sincronização histórica foi disparada uma segunda vez com o mesmo
  `desde`, logo depois de terminar a primeira. Terminou com **3.608
  pedidos encontrados/importados, 0 erros** — 4 a mais que a primeira
  execução (3.604), e não o dobro: os 4 são pedidos novos que entraram de
  verdade nos ~40 minutos entre uma execução e outra (confirmado batendo
  com a contagem de pedidos dos últimos 30 dias em `/api/relatorios/
  resumo-vendas`, que subiu de 2.440 para 2.444 no mesmo intervalo — a
  mesma diferença de 4). Prova, na prática, que o `INSERT ... ON CONFLICT
  (conta_ml_id, ml_order_id) DO UPDATE` funciona: reprocessar pedido que já
  existe atualiza a linha, nunca cria uma segunda.
- Removida a rota administrativa temporária de migração
  (`server/routes/adminMigracao.js` e as 2 linhas que a registravam em
  `server.js`) — não faz mais parte do projeto.
- Conforme pedido, nenhum outro módulo foi avançado, e custo/imposto não
  foram implementados nesta etapa.

## 2026-08-23 (9) — Teste ao vivo em produção de Estoque, Estoque Full e Compras + correção
- Depois do usuário subir o zip anterior pro GitHub e o Render fazer o
  deploy automático, testei as 3 telas novas direto em produção
  (https://cerne-erp.onrender.com), pela empresa real "pf embalegens".
- **Estoque:** carregou normalmente (estado vazio correto, já que a
  empresa ainda não tem produtos cadastrados em Produtos). Sem erros no
  console.
- **Estoque Full:** funcionou com dados reais da API do Mercado Livre —
  20 anúncios Full carregados com quantidade real, nenhum caiu em
  "Pendente". Ver `05-problemas-conhecidos.md` para o detalhe.
- **Compras:** encontrado um bug real — o botão "Nova compra" do topo da
  tela não abria o formulário (faltava o `addEventListener` de clique,
  presente em todos os outros botões equivalentes). **Corrigido** no
  próprio código (`server/public/index.html`) e reconferido com
  `node --check`. Como a correção veio depois do primeiro upload, precisa
  de um novo upload do zip de código + novo deploy para valer em produção,
  e uma nova conferência ao vivo do botão depois disso. Ver
  `05-problemas-conhecidos.md`.
- Nenhuma outra área foi tocada nesta rodada — só a correção pontual do
  botão de Compras.

## 2026-08-23 (8) — Ativação de Estoque, Estoque Full e Compras
- Pedido pelo usuário: ativar 3 áreas novas, mantendo o design atual e sem
  mexer em nenhuma outra área — Estoque, Estoque Full (renomeado de
  "Full") e Compras.
- **Estoque:** tela que lista os produtos cadastrados (Produtos) com
  estoque atual, custo unitário, valor total em estoque e status. Ajuste
  manual de quantidade, com observação opcional. Cada ajuste grava
  quantidade anterior, nova, diferença e observação numa tabela de
  movimentação nova (`estoque_movimentos`), preparando o histórico mesmo
  sem uma tela própria pra vê-lo ainda. Nunca misturado com o Estoque Full.
- **Estoque Full (menu renomeado de "Full" para "Estoque Full"):** mostra
  os anúncios com logística Full das contas do Mercado Livre conectadas —
  produto, SKU, ID do anúncio, loja, quantidade no Full e status —
  buscados ao vivo a cada carregamento, sem tabela no banco. Quando a
  quantidade de um anúncio específico não está disponível na API, a linha
  mostra "Pendente" — nunca um número inventado.
- **Compras:** primeira versão simples de pedido de compra — criar,
  listar, editar, pesquisar por fornecedor e mudar status (Em aberto,
  Pedido realizado, Recebido, Cancelado). Cada compra tem um ou mais itens
  (produto, quantidade, custo unitário); valor de cada item e valor total
  da compra sempre calculados pelo servidor, nunca aceitos prontos do
  front-end. Marcar como "Recebido" não mexe no Estoque ainda (não
  automatizado, por pedido explícito do usuário). Sem IA de compras.
- **Testado localmente:** `node --check` em todos os arquivos de backend
  novos/alterados e no bloco de script do front-end; schema aplicado no
  Postgres local confirmando criação das 4 tabelas novas (`estoque`,
  `estoque_movimentos`, `compras`, `compra_itens`) sem alterar nenhuma
  tabela existente; ajuste de estoque testado via `psql` dentro de uma
  transação, nos dois casos (produto sem estoque ainda, e produto com
  ajuste anterior), confirmando quantidade, movimentação gravada e valor
  total em estoque corretos; Compras testado via `psql` (criar com itens e
  valor total calculado certo, editar substituindo itens, mudar status,
  filtrar por status, buscar por fornecedor). **Ainda não foi possível
  testar a chamada real ao endpoint de estoque Full do Mercado Livre**
  neste ambiente — depende do teste ao vivo em produção, junto com o teste
  (ainda pendente da etapa anterior) de Anúncios.
- Nenhuma outra área foi alterada (Empresas, Marketplaces, Custos,
  Pedidos, Visão Geral, Financeiro, Produtos, Anúncios e Fornecedores
  continuam exatamente como estavam).

## 2026-08-22 (7) — Ativação de Produtos, Anúncios e Fornecedores
- Pedido pelo usuário: ativar 3 áreas novas, mantendo o design atual e sem
  mexer em nenhuma outra área — Produtos, Anúncios (nova) e Fornecedores.
- **Produtos:** cadastro simples e funcional, salvo no banco — nome, SKU,
  custo, status. Cadastrar, listar, editar, pesquisar (nome/SKU) e
  ativar/desativar. Ainda sem kits, composição ou estoque automático (não
  pedido). Tabela nova (`produtos`), separada da já existente
  `custos_produto` usada no cálculo de margem — ver `02-decisoes.md`.
- **Anúncios (aba nova, ao lado de Produtos no menu):** mostra os anúncios
  reais das contas do Mercado Livre conectadas — ID, título, SKU, loja,
  preço, estoque disponível, status e tipo — buscados ao vivo na API a
  cada carregamento da tela (nenhum anúncio é salvo no banco nesta etapa,
  nem inventado). Se a empresa não tiver conta conectada, a conexão
  estiver com erro, ou a API falhar, a tela avisa que a sincronização está
  pendente. Ainda não edita preço nem estoque pelo Mercado Livre (só
  visualização, como pedido).
- **Fornecedores:** cadastro por empresa — razão social/nome, nome
  fantasia, CNPJ ou CPF (validação nova de CPF, mesma lógica que já existia
  para CNPJ), telefone, e-mail, observação e status. Cadastrar, listar,
  editar, pesquisar e ativar/desativar. Estrutura pronta para relacionar a
  produtos e compras futuramente (relação em si ainda não existe).
- **Testado localmente:** `node --check` em todos os arquivos de backend
  novos/alterados e no bloco de script do front-end; schema aplicado no
  Postgres local confirmando criação das 2 tabelas novas (`produtos`,
  `fornecedores`) sem alterar nenhuma tabela existente; CRUD completo de
  Produtos e Fornecedores testado via `psql` com as mesmas queries das
  rotas (criar, listar, buscar por nome/SKU/CNPJ/CPF, filtrar por status,
  editar, ativar/desativar, e a rejeição de SKU/documento duplicado por
  empresa); validação de CPF testada com números válidos e inválidos
  conhecidos; extração de SKU de anúncio testada nos 5 cenários possíveis
  (atributo do anúncio, campo legado, sem SKU, variações com SKU igual,
  variações com SKU diferente — neste último caso mostra "—", nunca chuta);
  máscara de CNPJ/CPF do formulário de Fornecedores testada digitando os
  dois formatos progressivamente. **Ainda não foi possível testar a
  chamada real à API de anúncios do Mercado Livre nem rodar o servidor
  completo neste ambiente** (sem acesso a pacotes npm aqui) — depende do
  teste ao vivo em produção depois do deploy.
- Nenhuma outra área foi alterada (Empresas, Marketplaces, Custos, Pedidos,
  Visão Geral e Financeiro continuam exatamente como estavam).

## 2026-08-22 (6) — Correções: filtro único da Visão Geral, tabela de Pedidos mais estreita, fuso horário do período
- Pedido pelo usuário: corrigir 3 problemas específicos nas telas já
  ativadas na etapa anterior, sem mudar o design geral nem criar
  funcionalidade nova.
- **Visão Geral tinha filtro duplicado:** existia um seletor de
  empresa/período dentro da própria página E outro (decorativo, sem
  função) no header. Removido o seletor de dentro da página — agora o
  header é a única fonte de verdade da empresa e do período da Visão
  Geral, e os dois dropdowns do header passaram a funcionar de verdade
  (empresas reais buscadas da API, e trocar a seleção atualiza os dados na
  hora).
- **Tabela de Pedidos larga demais:** reorganizada pra caber na largura
  normal de uma tela desktop sem precisar rolar pro lado. Ficaram: Data,
  Pedido, Produto/SKU (uma coluna, em duas linhas), Qtd., Venda, Taxas,
  Frete vendedor, Custo, Margem R$, Margem %, Logística e Status — nessa
  ordem de prioridade. Loja e Imposto saíram da tabela (continuam no
  detalhe do pedido). Margem R$ e Margem % continuam sempre visíveis, sem
  precisar rolar.
- **Filtro de "Hoje"/"Ontem" agora usa início e fim exatos do dia, em
  `America/Sao_Paulo`:** antes, "Hoje" ia de 00:00 (Brasília) até o
  instante da consulta — na prática não deixava pedido de outro dia
  entrar, mas não era literalmente "00:00:00 até 23:59:59" como pedido, e
  não existia jeito de isolar só "ontem". Agora existe o período **"Ontem"**
  (novo) e tanto "Hoje" quanto "Ontem" usam o dia inteiro, início e fim
  explícitos — validado com pedido de teste no último segundo de ontem e
  no primeiro segundo de hoje, sem nenhum vazando pro período errado.
  Como a correção foi em `lib/periodo.js` (regra central), vale ao mesmo
  tempo para Visão Geral, Pedidos e Financeiro.
- **Testado:** `node --check` em todos os arquivos de backend alterados;
  limites de cada período validados com script Node isolado e com queries
  reais no Postgres local (`psql`); front-end (header da Visão Geral e
  tabela de Pedidos) testado com Playwright/Chromium local em 1440px e
  1280px de largura — sem seletor duplicado, sem rolagem horizontal na
  tabela, com "Ontem" disponível nos três seletores de período.

## 2026-08-22 (5) — Visão Geral, Pedidos e Financeiro com dados reais (fonte única de cálculo)
- Pedido pelo usuário: ativar de verdade as telas Visão Geral, Pedidos e
  Financeiro com os dados já sincronizados do Mercado Livre, com filtro de
  período funcionando, sem inventar valor nenhum, e as três telas usando a
  mesma regra de cálculo no backend (nunca uma conta paralela em cada
  tela).
- **Visão Geral:** deixou de ser um layout estático. Agora mostra
  faturamento, quantidade de pedidos, margem de contribuição (R$ e %),
  taxas/comissões, frete do vendedor, imposto, custo dos produtos e
  pedidos cancelados — tudo pro período selecionado (Hoje / 7 dias / 30
  dias / Este mês) — e um gráfico novo, Faturamento x Margem de
  contribuição por dia.
- **Pedidos:** ganhou filtro de período (a listagem toda, não só as mais
  recentes) e a tabela agora tem: data, número do pedido, loja, produto,
  SKU, quantidade, valor da venda, taxas/comissões, frete do vendedor,
  imposto, custo do produto, margem de contribuição (R$ e %), logística e
  status. O detalhe do pedido (ao clicar) agora também mostra a loja e o
  percentual de margem.
- **Financeiro:** telas novas, primeira versão — faturamento bruto, taxas e
  comissões, frete do vendedor, impostos, custo dos produtos, margem de
  contribuição em R$ e %, e pedidos cancelados à parte. Só Mercado Livre
  por enquanto; contas a pagar/receber, fluxo de caixa, DRE completa,
  banco, fornecedores e Shopee ficam para depois (não fazem parte desta
  etapa).
- **Regra de pedido cancelado:** definida com o usuário nesta etapa —
  pedido cancelado no Mercado Livre não conta em nenhum valor financeiro
  agregado (faturamento, taxas, frete, imposto, custo, margem); ele
  aparece só num lugar, um card "Pedidos cancelados" (quantidade e valor),
  pra não ficar escondido nem misturado com o resultado real. Na listagem
  de Pedidos ele continua aparecendo normalmente (linha esmaecida).
- **"Margem líquida"/"lucro real" renomeados para "margem de
  contribuição"** em toda a interface — nome mais correto pro que a
  fórmula (venda − taxas − frete do vendedor − imposto − custo do produto)
  realmente calcula, e o termo que o próprio usuário usou ao pedir.
- **Backend reorganizado pra ter uma fonte única de verdade:** dois
  arquivos novos, `lib/periodo.js` (cálculo dos 4 períodos, com "Hoje"/
  "Este mês" no fuso de Brasília) e `lib/relatorioVendas.js` (busca +
  cálculo + agregação dos pedidos de um período, reaproveitando
  `lib/resultadoVenda.js` já existente). A listagem de Pedidos
  (`routes/pedidos.js`) e o novo endpoint de relatórios
  (`routes/relatorios.js`, usado por Visão Geral e Financeiro) chamam
  exatamente as mesmas funções — não existe cálculo duplicado.
- Removidos da Visão Geral os cards "A receber"/"A pagar" que só
  mostravam "—" (contas a pagar/receber não fazem parte desta etapa);
  eles voltam quando esses módulos forem implementados de verdade.
- **Testado localmente antes de publicar** (Postgres local): a query SQL
  de `relatorioVendas.js` validada via `psql`, e a lógica de agregação
  (totais, série diária, os 4 períodos) validada com dados de teste
  cobrindo pedido completo, pedido com custo pendente e pedido cancelado —
  todos bateram com o cálculo esperado (contas refeitas à mão). Detalhes
  em `02-decisoes.md` (8).

## 2026-08-22 (4) — Pedido cai sozinho no sistema (webhook do Mercado Livre) + custo/imposto/margem na lista de Pedidos
- Pedido pelo usuário: (1) o pedido entrar sozinho no sistema, sem depender
  do botão "Sincronizar"; (2) a lista de Pedidos mostrar também custo do
  produto, imposto e margem líquida.
- Implementado webhook do Mercado Livre (tópico `orders_v2`, escolhido pelo
  usuário entre as duas opções apresentadas): assim que um pedido é
  criado/atualizado, o Mercado Livre notifica o ERP e o pedido é importado
  na hora — o botão "Sincronizar agora" continua existindo como reforço
  manual. Respeita a mesma regra de sempre (nunca inventar valor, nunca
  duplicar pedido) e agora tem uma trava por pedido para o webhook e a
  sincronização manual/periódica nunca gravarem o mesmo pedido ao mesmo
  tempo.
- A lista de Pedidos agora mostra, sem precisar abrir o detalhe: custo do
  produto, imposto e margem líquida de cada pedido (mesma fórmula do
  detalhe, agora compartilhada num só arquivo para nunca divergir). Falta
  alguma parte (custo de SKU não cadastrado, tarifa que o Mercado Livre não
  retornou) → aparece "pendente", nunca um número calculado com uma parte
  assumida.
- **Testado localmente** (Postgres local): 3 cenários de custo por pedido
  (todos os SKUs com custo cadastrado, um SKU sem custo, item sem SKU
  nenhum) bateram com o esperado; a lógica de validação do webhook
  (tópico, `application_id`, payload malformado) também foi testada
  isoladamente. **Falta testar o webhook com uma notificação real** — só é
  possível depois que o usuário configurar a URL no painel do Mercado
  Livre (ver `02-decisoes.md` (7)) e um pedido real acontecer.
- **Ação necessária do usuário:** configurar no painel de desenvolvedor do
  Mercado Livre a notificação do tópico `orders_v2` apontando para
  `https://cerne-erp.onrender.com/api/integracoes/mercadolivre/webhook`.

## 2026-08-21/22 (3) — Integração real com Mercado Livre (conectar, importar pedidos, custo + imposto)
- Conexão real via OAuth+PKCE com o Mercado Livre (tela Marketplaces),
  tokens criptografados no banco (AES-256-GCM), renovação automática antes
  de expirar.
- Importação real dos pedidos dos últimos 30 dias (tela Pedidos): dados do
  pedido, itens (SKU, título, quantidade, preços), comissão/tarifas reais
  da API, frete do comprador e do vendedor guardados separados, tipo de
  logística, payload bruto para auditoria. Sincronizar de novo nunca
  duplica pedido.
- Custo por SKU e alíquota de imposto configuráveis (tela Custos);
  resultado da venda (valor - tarifas - frete do vendedor - imposto - custo
  do produto) calculado só quando todas as partes existem — senão mostra o
  que está pendente, nunca um número inventado.
- **Testado com a conta real "PFEMBALAGEMS":** conectada e sincronizada com
  sucesso — **2.370 pedidos reais** dos últimos 30 dias importados/
  atualizados, 0 erros (sincronização concluída em ~14 min). Pedido de
  exemplo conferido em detalhe (ver relatório enviado ao usuário no chat,
  com o exemplo completo).
- Durante o teste real, foram corrigidos 2 problemas encontrados: (1) as
  telas de Marketplaces/Pedidos/Custos carregavam em branco no primeiro
  load (ordem de inicialização do `index.html`); (2) a sincronização podia
  travar para sempre se uma chamada à API do Mercado Livre não respondesse
  (adicionado timeout de 20s por chamada). Detalhes em `02-decisoes.md`.
- Endpoints do Mercado Livre usados: `/oauth/token`, `/users/me`,
  `/orders/search`, `/orders/{id}`, `/shipments/{id}`,
  `/shipments/{id}/costs`.
- Combinado um novo processo de entrega das próximas alterações (o `git
  push` direto não está disponível nesta sessão do Cowork) — ver
  `02-decisoes.md` (1) e `05-problemas-conhecidos.md`.
- Conforme pedido, nenhum outro módulo foi avançado (Shopee, lojas,
  usuários avançados, permissões, produtos, estoque, financeiro completo,
  Full, IA, notas fiscais).

## 2026-08-21 (2) — ERP no ar, com banco real e Empresas funcionando
- Backend Node.js/Express + PostgreSQL criado (`server/`), reaproveitando o
  mesmo front-end/design já aprovado.
- Publicado no Render: serviço web `cerne-erp` (deploy automático a partir do
  repositório GitHub `pabloandrade4/cerne-erp`) + banco Postgres `cerne-db`.
- URL pública: https://cerne-erp.onrender.com
- Tela de **Empresas** funcionando de verdade: cadastrar, editar, listar,
  ativar/desativar — tudo salvo no banco real, testado na URL pública
  (persistiu após recarregar a página).
- Nenhum outro módulo foi alterado ou avançado nesta etapa.

## 2026-08-21
- Início do projeto: criada a pasta `docs/` como memória do ERP, com os
  arquivos base (visão geral, regras de negócio, decisões, funcionalidades,
  alterações, problemas conhecidos e próximos passos).
- Criado e publicado o layout base navegável do ERP (`app/base-layout.html`,
  artifact "Cerne"): sidebar com os módulos, header, tema claro/escuro e
  página-esqueleto por módulo. Ver detalhes em `02-decisoes.md` e
  `03-funcionalidades.md`.
- Revisão visual completa do mesmo layout: hierarquia entre indicadores
  principais/secundários, 4 componentes de gráfico com empty state, sidebar e
  header mais refinados. Ver `02-decisoes.md` (2026-08-21 (3)).
