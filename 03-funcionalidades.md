# Funcionalidades Desenvolvidas

Lista das partes do ERP que já foram desenvolvidas, com uma descrição curta de
cada uma e o status (em desenvolvimento / concluída).

## IA Gestora — central de análise e relatórios, com histórico, cards visuais e planilha automática (2026)
- **Status:** concluído e testado localmente (Postgres real + servidor
  real via HTTP — **251 testes automatizados no projeto com Postgres, 0
  falhas**). Ainda **só de consulta, análise e projeção** — nenhuma ação
  automática foi implementada, nenhum acesso de escrita foi dado à IA.
  **Ampliação de 25/08/2026 (30)** (ver `02-decisoes.md` (30)), pedida
  pelo usuário em 3 passos ("transformar a IA Gestora em uma central de
  análise e relatórios"): (1) **login real** (e-mail/senha, escopado só a
  esta área — nenhuma outra tela do ERP passou a exigir login) e
  **histórico de conversas salvo no banco** (nunca só `localStorage`) —
  lista de conversas, abrir uma antiga e continuar, apagar, sobrevive a
  atualizar a página/logar de novo, e um usuário nunca acessa a conversa
  de outro; (2) **respostas visuais** — quando a pergunta é uma
  análise/relatório maior (não uma pergunta simples de um número só), a
  resposta ganha um card com resumo, KPIs, tabela, gráfico (barra/linha,
  sempre com dado real) e conclusões, com aviso de "atenção" quando a IA
  identifica um problema (ex.: margem negativa depois do Ads) — quem
  decide se a pergunta merece esse tratamento é o próprio modelo; (3)
  **planilha XLSX automática** disponível para download em qualquer
  resposta que tenha tabela/gráfico, usando **exatamente os mesmos dados
  já mostrados na conversa** (nunca uma nova consulta, nunca o texto
  reformatado) — garantia de que a conversa e a planilha nunca divergem.
  **Ampliações anteriores, 25/08/2026 (28)** (ver `02-decisoes.md` (28)): a IA ganhou
  capacidade de RACIOCÍNIO/PROJEÇÃO — nova ferramenta `projecao_mes`
  (catálogo foi de 19 para **20**, e agora **21** com `apresentar_analise`
  na etapa (30)) para perguntas de "quanto devo
  faturar/lucrar/vender/gastar de Ads até o fim do mês" ou "se continuar
  nesse ritmo…", sempre separando REALIZADO de PROJETADO na resposta; o
  system prompt também foi corrigido para nunca mais recusar uma pergunta
  só por "o ERP não tem essa tela" quando já existe dado suficiente para
  calcular a resposta combinando ferramentas. **Ampliação de 25/08/2026
  (27)** (ver `02-decisoes.md` (27)): catálogo de ferramentas foi de 9 para
  19, cobrindo praticamente todos os módulos do ERP (vendas, produtos por
  SKU/por caixa, Ads, estoque/dinheiro parado em estoque, contas a
  pagar/receber, fluxo de caixa, DRE completa, compras por fornecedor,
  notas fiscais, comparação com período anterior, e uma base de
  conhecimento pra explicar regras/limitações). Continua faltando só uma
  `IA_API_KEY` de produção válida do próprio usuário para responder de
  verdade (ver `05-problemas-conhecidos.md`) — sem chave configurada, a
  tela abre normalmente e avisa que a IA ainda não está configurada.
  **Ampliação de 25/08/2026 (28)** (ver `02-decisoes.md` (28)): a IA ganhou
  capacidade de RACIOCÍNIO/PROJEÇÃO — nova ferramenta `projecao_mes`
  (catálogo foi de 19 para **20**) para perguntas de "quanto devo
  faturar/lucrar/vender/gastar de Ads até o fim do mês" ou "se continuar
  nesse ritmo…", sempre separando REALIZADO de PROJETADO na resposta; o
  system prompt também foi corrigido para nunca mais recusar uma pergunta
  só por "o ERP não tem essa tela" quando já existe dado suficiente para
  calcular a resposta combinando ferramentas. **Ampliação de 25/08/2026
  (27)** (ver `02-decisoes.md` (27)): catálogo de ferramentas foi de 9 para
  19, cobrindo praticamente todos os módulos do ERP (vendas, produtos por
  SKU/por caixa, Ads, estoque/dinheiro parado em estoque, contas a
  pagar/receber, fluxo de caixa, DRE completa, compras por fornecedor,
  notas fiscais, comparação com período anterior, e uma base de
  conhecimento pra explicar regras/limitações). Continua faltando só uma
  `IA_API_KEY` de produção válida do próprio usuário para responder de
  verdade (ver `05-problemas-conhecidos.md`) — sem chave configurada, a
  tela abre normalmente e avisa que a IA ainda não está configurada.
- **O que é:** uma tela de chat (menu **Geral → IA Gestora**) onde o
  usuário conversa em português com uma IA sobre a operação da empresa e
  período selecionados no cabeçalho — mesmo filtro (`window.CerneFiltro`)
  já usado pela Visão Geral. Cobre hoje, entre outras: faturamento/margem
  de contribuição/resultado do período; SKU mais vendido, modelo de caixa
  (produto físico) mais vendido em unidades, produto que mais faturou,
  vendas individuais com prejuízo; gasto com taxas/frete/Ads (hoje e no
  mês) e quais anúncios têm melhor/pior resultado real depois do Ads;
  contas a pagar/receber (em aberto, vencendo hoje, vencendo nos próximos
  7 dias, vencidas/atrasadas) e fluxo de caixa (sempre separando o que já
  ACONTECEU do que é só PREVISTO — nunca um saldo bancário projetado, que
  o ERP não tem como calcular); a DRE completa linha a linha; compras do
  período por fornecedor; quantas notas fiscais estão pendentes/emitidas;
  comparação com o período anterior de mesma duração; dinheiro parado em
  estoque; **projeção de faturamento, margem/lucro, quantidade de pedidos
  e gasto de Ads até o último dia do mês corrente** — média diária × dias
  do mês, ajustada pela tendência dos últimos 7 dias quando há venda real
  nesse período, sempre com "faixa provável" e sempre nomeando o que é
  REALIZADO e o que é PROJETADO; e os mesmos alertas de Visão Geral >
  Alertas & IA — com 5 sugestões de pergunta na tela vazia. Todo número
  que a IA cita vem de uma consulta real ao banco (nunca calculado pelo
  modelo, nunca uma segunda fórmula financeira diferente do resto do ERP);
  quando falta informação para responder com segurança (ex.: SKU sem custo
  cadastrado impedindo projetar margem), ela diz claramente o motivo em
  vez de estimar — mas nunca recusa uma pergunta só porque não existe uma
  tela dedicada pra ela: tenta combinar ferramentas existentes via
  consulta/matemática/comparação/agregação/projeção primeiro. A IA **não
  altera nada no sistema** — só consulta, calcula com as mesmas contas já
  existentes, compara, projeta (com dado real, nunca inventado), explica e
  resume. Trocar empresa/período no cabeçalho reinicia a conversa.
- **Onde está:** `server/lib/ia/providers/anthropic.js` (tradução HTTP
  com a API de Mensagens da Anthropic — sem SDK novo, `fetch` nativo),
  `server/lib/ia/providers/index.js` (registro de provedor/modelo,
  trocável por variável de ambiente sem mexer no resto), `server/lib/ia/
  ferramentas.js` (catálogo de 21 ferramentas, incluindo `projecao_mes` e
  `apresentar_analise` — cada uma uma casca fina sobre uma função já
  existente do ERP, exceto `apresentar_analise`, que não toca o banco),
  `server/lib/compras.js` e `server/lib/ia/baseConhecimento.js` (módulos
  de apoio — ver `02-decisoes.md` (27)), `server/lib/ia/orchestrator.js`
  (laço de pergunta → ferramenta → resposta; regras 5-A/5-B de quando
  projetar e nunca recusar por falta de tela; regra 7 de quando montar
  card visual), `server/lib/ia/estrutura.js` (monta o card
  resumo/KPI/tabela/gráfico a partir só de ferramentas já executadas —
  nunca calcula nada), `server/lib/ia/planilhaAnalise.js` (gera o XLSX a
  partir do mesmo card salvo), `server/lib/auth/*` (senha, sessão, cookie,
  middleware de login — usados só aqui), `server/db/criarUsuarioIa.js`
  (script de bootstrap pra criar o primeiro login),
  `server/routes/iaGestora.js` (`/login`, `/logout`, `/me`, `/conversas`,
  `/perguntar`, `/conversas/:id/mensagens/:id/xlsx`),
  `server/public/index.html` (módulo `window.IAGestora` — login, sidebar
  de conversas, card visual, download de planilha; item de menu "IA
  Gestora"). Ver `02-decisoes.md` (22), (27), (28) e (30) para o desenho
  completo.
- **O que falta:** só configurar `IA_API_KEY` no Render com uma chave real
  da conta Anthropic do usuário (https://console.anthropic.com) e testar
  ao vivo as perguntas reais — a integração em si (formato de erro,
  categorização, `Api-Version`/headers) já foi confirmada contra a API
  real numa etapa anterior; o catálogo ampliado (incluindo `projecao_mes`
  e o card visual/planilha) foi verificado no nível de cada ferramenta e
  de ponta a ponta via HTTP com a chamada à Anthropic mockada (número a
  número contra recálculo manual e contra a função canônica), não no
  nível de uma conversa real com o modelo (só possível depois da chave
  configurada). Também falta criar o primeiro usuário de login — ver o
  comando exato em `06-proximos-passos.md`.
  Por instrução explícita do usuário, não avançar sozinho para a IA poder
  alterar dados (custo, estoque, compras, contas, notas fiscais, anúncios,
  pedidos) sem o usuário pedir depois de validar que ela entende
  corretamente os dados da empresa.

## Radar da IA — acompanhamento contínuo do negócio, em segundo plano (25/08/2026)
- **Status:** concluído e testado (Postgres real, **257 testes
  automatizados no projeto, 0 falhas** — 251 anteriores + 6 novos deste
  ciclo, ver `test/radar.test.js`). Ainda **só análise e recomendação** —
  nenhuma ação automática, mesma regra da IA Gestora.
- **O que é:** a IA Gestora deixa de depender só de pergunta — um
  processo automático no backend (nunca um timer no navegador) analisa
  continuamente cada empresa ativa, a cada 15 minutos, e mantém um
  retrato sempre atualizado do negócio, mesmo sem ninguém com o ERP
  aberto. Pedido do usuário em 3 passos — ver `02-decisoes.md` (31) e
  `01-regras-de-negocio.md` (seção "Radar da IA").
- **Passo 1 — anúncios:** por SKU/anúncio, identifica anúncio vendendo
  pouco, praticamente parado (nunca apaga sozinho, só recomenda), com
  muito faturamento e pouco resultado, dando prejuízo — e também
  oportunidades (crescimento com margem saudável, bom desempenho
  consistente).
  `server/lib/ia/radarAnuncios.js`.
- **Passo 2 — negócio inteiro:** custos (impacto na margem quando o custo
  cadastrado muda), Ads agregado (gastando sem vender, consumindo grande
  parte da margem), estoque (cobertura estimada em dias, baixa/crítica/
  excesso), financeiro (contas a pagar/receber vencidas ou vencendo),
  fluxo de caixa (risco de aperto nos próximos dias, cruzando pagar ×
  receber), compras (o que precisa ser comprado, cruzando com o caixa
  disponível). `server/lib/ia/radarNegocio.js`.
- **Passo 3 — "Radar da IA":** ciclo automático (`server/lib/ia/radar.js`
  + `radarScheduler.js`) que junta os dois passos acima, persiste sem
  duplicar (upsert por chave, resolve sozinho quando a situação some), e
  só chama o modelo de IA para escrever a recomendação de situações
  **novas ou que pioraram** — nunca para detectar, nunca a cada ciclo pra
  tudo. Organizado em 🔴 Crítico / 🟠 Atenção / 🟢 Oportunidades /
  🔵 Informativo, visível em **Visão Geral > Alertas & IA** (novo painel
  "Radar da IA", aditivo ao alerta já existente) e num resumo
  "O que precisa da minha atenção hoje" na tela inicial da própria IA
  Gestora — `GET /api/ia-gestora/radar-resumo`.
- **Dados sempre reais.** Nenhuma fórmula financeira nova — reaproveita as
  mesmas funções de cálculo já usadas pelo resto do ERP; a única exceção
  declarada é a estimativa de cobertura de estoque/compra necessária
  (heurística simples, o ERP ainda não tem ponto de reposição).

## Sincronização automática do Mercado Livre (backend, a cada 1 minuto)
- **Status:** concluído, testado localmente (Postgres real + servidor real
  rodando via HTTP + 8 testes automatizados novos — a mecânica de
  orquestração, o não-duplicar e o isolamento de erro entre contas
  cobertos ponta a ponta com dados reais da conta PFEMBALAGEMS e a API do
  Mercado Livre mockada, já que este ambiente não tem credenciais nem
  internet reais). **Depende de o usuário fazer o upgrade do plano do
  serviço `cerne-erp` no Render (Free → Starter) para funcionar de forma
  confiável 24h em produção** — ver `02-decisoes.md` (19) e
  `05-problemas-conhecidos.md`.
- **O que é:** o ERP não depende mais só do botão manual "Sincronizar" no
  dia a dia. O próprio servidor (nunca o navegador) roda um ciclo a cada 1
  minuto verificando todas as contas do Mercado Livre conectadas e ativas
  — pedidos novos, mudança de status, pagamentos, cancelamentos,
  devoluções, envio, taxas/comissões, frete do vendedor e do comprador.
  Combinado com o webhook já existente (notificação em tempo real): o
  webhook cuida da atualização rápida de qualquer pedido, e o ciclo de 1
  minuto é a camada de segurança/reconciliação (janela mais curta, 2 dias
  por padrão — ver decisão acima). Nunca duplica pedido (mesma chave conta
  + ID do pedido do Mercado Livre de sempre) e nunca mistura pedidos entre
  contas/empresas (cada conta sincronizada isoladamente). Um erro numa
  conta (ex: token inválido) nunca impede as outras contas nem os
  próximos ciclos — fica isolado e registrado no log do servidor.
- **Indicador discreto no header:** "Sincronizado há X segundos/minutos"
  (ou "Última sincronização: HH:MM" depois de 1 hora), virando "Erro na
  sincronização" (com o motivo no tooltip) quando o último ciclo falhou. Só
  aparece quando a integração com o Mercado Livre está configurada no
  servidor. Atualiza sozinho (relê o status já calculado pelo servidor a
  cada ~20s, e recalcula o texto "há Xs" a cada ~5s) — o navegador nunca
  sincroniza nada, só mostra um status que o servidor já calculou.
- **Botão manual "Sincronizar agora" continua existindo**, como opção de
  emergência — não é mais o único jeito de um pedido aparecer no ERP.
- **Onde está:** `server/lib/syncScheduler.js` (o ciclo em si — chamado a
  partir de `server/server.js` depois do `app.listen`), `GET
  /api/integracoes/mercadolivre/status-automatico`
  (`server/routes/integracoes.js`), `window` IIFE em
  `server/public/index.html` (indicador do header, perto do
  `window.CerneFiltro`). Reaproveita 100% de `lib/mlSync.js#sincronizarConta`
  — nenhuma regra de cálculo/importação nova, só a orquestração de quando
  chamar.
- **O que falta:** o usuário fazer o upgrade de plano no Render (só ele
  pode, é uma decisão financeira) e depois subir o zip; testar em produção
  com uma conta real conectada (criar/aguardar um pedido novo e confirmar
  que aparece sozinho, sem clicar em "Sincronizar" — ver
  `06-proximos-passos.md`).

## Ads (Product Ads do Mercado Livre)
- **Status:** concluído, testado localmente (servidor real + Postgres local
  — 26 testes automatizados, incluindo reconciliação item a item, fórmula
  dos cards de topo, sincronização com a API mockada e diagnóstico real de
  erro). **Corrigido em 25/08/2026, e de novo em 25/08/2026 — parte 2**
  (ver `04-alteracoes.md`/`02-decisoes.md` entradas 25 e 32): a segunda
  correção trocou os endpoints de campanhas/anúncios pelo formato ATUAL da
  API de Advertising (o formato anterior foi descontinuado pelo Mercado
  Livre), adicionou o parâmetro `user_id` que faltava na checagem de
  anunciante, e substituiu o diagnóstico genérico por um real (status,
  mensagem e corpo exatos devolvidos pelo Mercado Livre). **A chamada real
  à API de Publicidade continua sem poder ser testada de ponta a ponta
  neste ambiente** (o servidor Node aqui não tem acesso à internet nem a
  uma conta Mercado Livre real — ver `05-problemas-conhecidos.md`). Ainda
  não testado ao vivo em produção.
- **O que é:** visão por anúncio (SKU, loja, campanha) do investimento em
  Ads, cliques, impressões, CPC, vendas atribuídas (quantidade e R$),
  receita atribuída, ROAS e ACOS — dividida em DUAS visões separadas na
  tela (nunca misturadas numa tabela só, por instrução explícita do
  usuário, porque a API do Mercado Livre não informa quais pedidos
  pertencem à publicidade, só totais agregados por anúncio/dia):
  - **"Performance atribuída Mercado Ads"** — só o que a API de
    Advertising atribui diretamente (investimento, cliques, impressões,
    CPC, vendas/receita atribuída, ROAS, ACOS).
  - **"Resultado real do SKU após Ads"** — a margem de contribuição REAL
    de TODAS as vendas daquele anúncio/SKU no período (mesma fonte de
    Pedidos/DRE/Financeiro, `buscarItensDoPeriodo`), menos o investimento
    real em Ads — deixado explícito na tela que pode incluir venda
    orgânica, e nunca chamado de "lucro gerado pelo Ads".
  TACOS = investimento em Ads ÷ faturamento REAL do anúncio no período
  (não o "atribuído" pelo Mercado Livre) — só calculado quando os dois
  números existem. Margem depois do Ads = margem real − investimento em
  Ads (venda − taxas − frete do vendedor − imposto − custo do produto −
  Ads). ROAS/ACOS por anúncio são aritmética sobre dois números reais
  (receita atribuída ÷ investimento), nunca uma estimativa — o endpoint de
  itens da API não devolve ROAS pronto (só existe no endpoint de
  campanhas). Nunca inventa valor: quando a conta não tem acesso a
  Product Ads, ou a API de Publicidade não responde, todo campo
  dependente dela aparece como "Pendente de sincronização".
- **Cards de topo e gráfico diário (adicionados em 25/08/2026):** Gasto
  hoje, Gasto no mês (dia 1 do mês até hoje, sempre a data real —
  independente do período escolhido no filtro da tela), Receita atribuída
  aos Ads, ROAS e ACOS (esses três últimos "no período" escolhido no
  filtro). Gráfico diário "Investimento Ads x Receita atribuída", vindo de
  uma série diária sincronizada à parte. Filtros de empresa/período do
  header e de loja (nesta tela) funcionam nos cards, no gráfico e nas duas
  tabelas.
- **Ordenação da tabela por anúncio:** Mais lucrativos, Maior prejuízo,
  Maior gasto em Ads, Maior faturamento, Melhor ROAS, **Pior ACOS**
  (adicionada em 25/08/2026 — parte 2) — aplicada às duas visões ao mesmo
  tempo (mesma ordem nas duas, pra facilitar comparar). Shopee Ads não foi
  implementado (fora do escopo desta etapa, por instrução explícita do
  usuário).
- **Sincronização em background (25/08/2026 — parte 2):** a tela nunca
  mais consulta a API do Mercado Livre ao vivo — `server/lib/adsScheduler.js`
  roda dentro do processo Node do servidor a cada 15 min
  (`ADS_SYNC_INTERVALO_MS`), sincronizando todas as contas ativas pras 5
  janelas do filtro global (`hoje`/`ontem`/`7d`/`30d`/`mes`) mais uma série
  diária de 40 dias — nunca depende do navegador aberto. Botão
  "Sincronizar agora" na tela (`POST /api/ads/sincronizar`) força um ciclo
  imediato sem esperar o próximo.
- **Diagnóstico real (25/08/2026 — parte 2):** quando uma conta não
  sincroniza, a tela mostra a causa REAL devolvida pelo Mercado Livre
  (status HTTP + mensagem, nunca um texto genérico) — guardado também em
  `ads_contas.detalhe_api` (JSONB) pra investigação.
- **Onde está:** `server/lib/mlAds.js` (cliente da API de Advertising —
  advertiser, anúncios/métricas, campanhas, série diária, endpoints ATUAIS
  não-legados), `server/lib/ads.js` (sincronização + leitura: combina as
  duas fontes, cards, série diária — sempre lendo do banco),
  `server/lib/adsScheduler.js` (ciclo automático em background),
  `server/routes/ads.js`, `server/public/index.html` (módulo
  `window.Ads`). **Tabelas próprias no banco** (25/08/2026 — parte 2):
  `ads_contas`, `ads_campanhas`, `ads_metricas_anuncio`, `ads_diario` — ver
  `db/schema.sql`.
- **O que falta:** confirmar ao vivo, em produção, que a conta
  "PFEMBALAGEMS" tem (ou não) acesso a Product Ads, e que os
  endpoints/parâmetros atuais (`/advertising/advertisers?product_id=PADS&
  user_id=...`, `/marketplace/advertising/{site_id}/advertisers/
  {advertiser_id}/product_ads/ads`, `.../campaigns/search`,
  `aggregation_type`, `Api-Version`) batem exatamente com a resposta real
  da API — ver `05-problemas-conhecidos.md`.

## Relatórios (categorias, reaproveitando a mesma fonte de sempre)
- **Status:** concluído, testado localmente (servidor real + Postgres
  local + navegador via Playwright, com os pedidos reais da conta
  "PFEMBALAGEMS" — 6 testes automatizados novos, todos comparando o
  relatório com `resumirPeriodo`/`buscarPedidosDoPeriodo` do mesmo
  período). Confirmado que os totais batem exatamente com Visão
  Geral/Pedidos/Financeiro (ver `05-problemas-conhecidos.md` se algum
  dado aparecer diferente). Ainda não testado ao vivo em produção.
  **Atualizado em 25/08/2026:** categoria Produtos ganhou uma segunda
  visão, "Por Caixa" — ver abaixo.
- **O que é:** relatórios separados por categoria, todos usando as MESMAS
  regras já usadas em Visão Geral/Pedidos/Financeiro — nenhum cálculo
  novo. **Vendas e Margem:** faturamento, pedidos, unidades vendidas,
  taxas/comissões, frete vendedor, imposto, custo dos produtos, Ads
  (quando disponível — mesma fonte da tela Ads) e margem de contribuição
  em R$ e %. **Produtos — Por SKU:** quantidade vendida, faturamento,
  custo, imposto e margem gerada (decompõe pedido em item, com o rateio
  documentado em `lib/relatorioVendas.js` quando o pedido tem mais de 1
  item). **Produtos — Por Caixa** (novo, 25/08/2026): agrupa todos os
  SKUs/kit que representam a mesma medida/produto físico (ex:
  `25CX-20X20X20`, `50CX-20X20X20`, `100CX-20X20X20` → `CX-20X20X20`),
  mostrando caixas físicas vendidas (kits × unidades por kit, somado),
  kits vendidos, quantidade de pedidos e faturamento total — nunca
  dividido pela quantidade de caixas. Identificação de produto base
  reaproveita `produtos_base`/`produto_base_skus` (vínculo salvo) e cai
  para o padrão automático do SKU (`lib/skuProdutoBase.js`) quando não há
  vínculo; SKU fora do padrão nunca é chutado — aparece à parte, em "sem
  produto base identificado". **Marketplaces/Lojas:** o mesmo resumo de
  Vendas e Margem, agrupado por loja, para comparar contas lado a lado.
  Filtros de empresa/período (header) e loja funcionam nas duas visões de
  Produtos; busca por SKU só existe em Por SKU. Exportação em XLSX e CSV
  sempre respeita os filtros atuais e nunca mistura empresa/período
  diferente do que está selecionado na tela — disponível hoje só para
  Vendas e Margem, Produtos (Por SKU) e Marketplaces (Por Caixa ainda não
  tem exportação; os botões ficam ocultos nessa visão).
- **Onde está:** `server/lib/relatoriosAgregados.js` (`relatorioVendasMargem`,
  `relatorioProdutos`, `relatorioProdutosPorCaixa`,
  `resolverProdutosBasePorSku`, `relatorioMarketplaces` — reaproveita
  `lib/relatorioVendas.js`, `lib/ads.js` e, pra Por Caixa,
  `lib/skuProdutoBase.js`/`produtos_base`/`produto_base_skus`; nenhuma
  fórmula financeira nova), `server/routes/relatorios.js` (rotas
  `/vendas-margem`, `/produtos`, `/produtos-por-caixa`, `/marketplaces`,
  `/exportar`, somadas às já existentes `/resumo-vendas`),
  `server/public/index.html` (módulo `window.Relatorios`).
- **O que falta:** exportação em PDF (o usuário priorizou XLSX/CSV nesta
  etapa), relatórios agendados, exportação da visão Por Caixa, e uma tela
  de gestão dos vínculos SKU → produto base (hoje só existe a API, sem
  interface — ver `06-proximos-passos.md`) — tudo fora do escopo pedido
  até agora.

## DRE (Demonstrativo de Resultado do Exercício)
- **Status:** concluído, testado localmente (servidor real + Postgres
  local + navegador via Playwright, com dados reais da conta
  "PFEMBALAGEMS", 60 testes automatizados incluindo o cenário de período
  sem nenhum pedido). Ainda não testado ao vivo em produção.
- **O que é:** demonstrativo de resultado por empresa e período (Receita
  Bruta → Cancelamentos/Devoluções → Descontos → Receita Líquida → Custo
  dos Produtos → Taxas e Comissões → Frete do vendedor → Impostos →
  Margem de Contribuição → Despesas/Contas pagas do período → Resultado
  Final), sempre em R$ e em % sobre o faturamento. Nenhuma fórmula nova:
  reaproveita a mesma fonte única de vendas (Visão Geral/Pedidos/
  Financeiro/Relatórios) e a mesma consulta de Contas a Pagar já
  existente. Nunca inventa valor — período sem pedido mostra "Sem dados";
  informação faltando (ex: custo de SKU não cadastrado) mostra "Pendente"
  só na linha afetada. Filtro de empresa/período do header funciona
  nesta tela.
- **Onde está:** `server/lib/dre.js`, `server/routes/dre.js`,
  `server/public/index.html` (módulo `window.DRE`). Sem tabela própria no
  banco — calculada ao vivo.
- **O que falta:** cadastrar custo em todos os SKUs vendidos (hoje vários
  pedidos ficam com "Custo dos Produtos"/"Margem de Contribuição"
  pendentes por falta de cadastro em Produtos — não é um bug da DRE, é a
  regra "nunca inventar valor" já usada em toda a parte financeira do
  ERP).

## Faturamento
- **Status:** concluído, testado localmente (servidor real + Postgres
  local + navegador via Playwright, incluindo seleção múltipla e ação em
  lote pela interface). Ainda não testado ao vivo em produção. **Sem
  emissão real de NF-e** — fora do escopo desta etapa.
- **O que é:** hub central dos pedidos que precisam ser faturados. Lista
  pedidos reais (data, número, marketplace, loja, cliente, valor, status
  do pedido, situação de faturamento), com 4 situações possíveis
  (Aguardando faturamento, Faturado, Erro, Cancelado). Suporta pesquisar
  pedido, filtrar por empresa/período (header) e por situação, selecionar
  vários pedidos e aplicar uma ação em lote. Nunca duplica dado do
  pedido — situação de faturamento fica numa tabela própria vinculada por
  `pedido_id` (1:1, upsert), cliente/loja/marketplace sempre vêm do
  pedido original via JOIN.
- **Onde está:** `server/lib/faturamento.js`, `server/routes/faturamento.js`,
  `server/public/index.html` (módulo `window.Faturamento`).
- **O que falta:** integração real de emissão de NF-e (SEFAZ) — por
  instrução explícita do usuário, fica para uma etapa futura.

## Notas Fiscais
- **Status:** concluído, testado localmente (servidor real + Postgres
  local + navegador via Playwright, incluindo preencher e emitir uma nota
  pela interface de ponta a ponta). Ainda não testado ao vivo em
  produção. **Sem integração real com a SEFAZ** — fora do escopo desta
  etapa.
- **O que é:** estrutura para registrar e acompanhar notas fiscais
  vinculadas a pedidos (número, série, pedido, empresa/CNPJ, cliente,
  valor, data de emissão, chave de acesso quando existir, status:
  Pendente/Emitida/Cancelada/Rejeitada). Cada pedido tem no máximo 1 nota
  (`pedido_id` único, upsert) — nunca duplica dado do pedido. Marcar como
  "Emitida" exige número, série, data de emissão e chave de acesso (44
  dígitos); sem isso o sistema recusa a mudança, nunca inventa esses
  dados. Abrir uma nota mostra os dados do pedido relacionado (mesma
  fonte da tela Pedidos).
- **Onde está:** `server/lib/notasFiscais.js`, `server/routes/notasFiscais.js`,
  `server/public/index.html` (módulo `window.NotasFiscais`).
- **O que falta:** integração real com a SEFAZ (emissão/consulta/
  cancelamento de verdade) — por instrução explícita do usuário, fica
  para uma etapa futura.

## Contas a Pagar (cadastro manual)
- **Status:** concluído, testado localmente (servidor real + Postgres local
  + navegador via Playwright, com dados reais da conta "PFEMBALAGEMS").
  Ainda não testado ao vivo em produção.
- **O que é:** tela para lançar manualmente obrigações a pagar (descrição,
  empresa, fornecedor — quando houver —, categoria em texto livre, valor,
  vencimento, data de pagamento, status, observação). Ações: cadastrar,
  editar, excluir, cancelar, marcar como pago, pesquisar, filtrar por
  status/empresa/período. KPIs no topo: total a pagar, vencendo hoje,
  vencidas (sempre o saldo atual, sem filtro de período) e pagas no
  período (com filtro). "Vencido" é sempre calculado na leitura, nunca
  gravado no banco. Conta paga vira histórico imutável (não editável, não
  excluível). Filtro de empresa/período do header funciona nesta tela.
- **Onde está:** `server/lib/contasPagar.js`, `server/routes/contasPagar.js`,
  `server/public/index.html` (módulo `window.ContasPagar`).
- **O que falta:** integração com Compras (gerar conta a pagar
  automaticamente a partir de uma compra recebida) e um plano de contas
  de verdade para "categoria" (hoje é texto livre com sugestões).

## Contas a Receber (cadastro manual)
- **Status:** concluído, testado localmente (servidor real + Postgres local
  + navegador via Playwright). Ainda não testado ao vivo em produção.
- **O que é:** tela simétrica à Contas a Pagar, para valores a receber
  (descrição, empresa, origem em texto livre, valor, data prevista, data
  recebida, status, observação). Mesmas ações (cadastrar, editar, excluir,
  cancelar, marcar como recebido, pesquisar, filtrar por status/empresa/
  período) e mesmo desenho de KPIs/imutabilidade/status calculado (aqui,
  "Atrasado"). Filtro de empresa/período do header funciona nesta tela.
- **Onde está:** `server/lib/contasReceber.js`, `server/routes/contasReceber.js`,
  `server/public/index.html` (módulo `window.ContasReceber`).
- **O que falta:** vínculo automático com vendas/pedidos — hoje é 100%
  manual, por pedido explícito do usuário ("allowing manual entry
  initially").

## Recebimentos (conciliação de repasse de marketplace)
- **Status:** concluído, testado localmente (servidor real + Postgres local
  + navegador via Playwright, com os 11 pedidos reais da conta
  "PFEMBALAGEMS"). Ainda não testado ao vivo em produção.
- **O que é:** tela somente leitura mostrando os pedidos com pagamento
  aprovado no período (Mercado Livre, único marketplace integrado hoje),
  com valor bruto, taxas/descontos (comissão + frete do vendedor +
  desconto do cupom) e valor líquido esperado pelo ERP. **Não inventa
  data nem valor de recebimento**: como a integração atual não traz esse
  dado da API do Mercado Livre, "previsão de liberação", "valor
  recebido" e "data do recebimento" aparecem sempre como "Informação não
  disponível", e o status sempre como "A liberar" — pronta para, no
  futuro, comparar o valor que o ERP esperava receber com o valor que o
  marketplace realmente repassou assim que a API trouxer esse dado.
  Filtro de empresa/período do header funciona nesta tela.
- **Onde está:** `server/lib/recebimentosMl.js`, `server/routes/recebimentos.js`,
  `server/public/index.html` (módulo `window.Recebimentos`). Sem tabela
  própria no banco — calculada ao vivo a partir de `lib/relatorioVendas.js`
  (mesma fonte já usada por Pedidos/Visão Geral/Financeiro).
- **O que falta:** dado real de liberação/repasse do Mercado Livre (não
  disponível na integração atual — ver `05-problemas-conhecidos.md`);
  marketplaces além do Mercado Livre (Shopee etc., fora do escopo desta
  etapa).

## Produto base + SKU de venda + Multiplicador
- **Status:** concluído e **testado em produção** (deploy `ml15`, com dados
  reais da conta "PFEMBALAGEMS").
- **O que é:** resolve o problema de um mesmo produto físico ser vendido em
  vários "kits" diferentes no Mercado Livre (ex.: `25CX-19X12X12`,
  `50CX-19X12X12`, `75CX-19X12X12`, `100CX-19X12X12` são todos o mesmo
  produto físico `CX-19X12X12`, em quantidades diferentes por kit). Três
  peças novas no banco:
  - `produtos_base` — o produto físico real (o que fica no Galpão).
  - `produto_base_skus` — o vínculo entre um SKU vendido/armazenado e um
    produto base, com um `multiplicador` (quantas unidades físicas aquele
    SKU representa) e uma `origem` (`manual` ou `automatico`).
  - Interpretação automática (`server/lib/skuProdutoBase.js`) sugere
    produto base + multiplicador a partir do padrão "dígitos no início do
    SKU" (`100CX-19X12X12` → multiplicador 100, código `CX-19X12X12`) —
    **só uma sugestão**, nunca a fonte de verdade. O vínculo que vale é
    sempre o salvo em `produto_base_skus`, e pode ser corrigido
    manualmente a qualquer momento (o SKU original do Mercado Livre nunca
    é alterado no pedido).
  - Conversão de venda para quantidade física (`server/lib/produtoBaseConversao.js`,
    compartilhada com a tela Estoque): `quantidade física = quantidade
    vendida × multiplicador`, somada por produto base. SKU sem vínculo
    salvo nunca é somado como se fosse zero ou inventado — fica separado
    em `pendentes`.
- **Onde está:** `server/db/schema.sql` (tabelas), `server/lib/skuProdutoBase.js`
  (sugestão automática), `server/lib/produtoBaseConversao.js` (conversão
  compartilhada), `server/routes/produtosBase.js` (API: CRUD de produto
  base, CRUD de vínculos, sugestões de vínculo a partir dos pedidos reais,
  conversão de uma venda ou de um pedido específico para quantidade
  física).
- **O que falta:** nada — este conceito foi **descontinuado para fins de
  estoque** em 26/08/2026 (ver seção "Estoque / Estoque Full" abaixo e
  `02-decisoes.md` (20)). As tabelas e a API (`routes/produtosBase.js`)
  continuam existindo, só não são mais lidas por nenhuma tela.

## Estoque / Estoque Full — Mercado Livre como fonte oficial (26/08/2026)
- **Status:** concluído e testado localmente (Postgres real + servidor
  real via HTTP + Mercado Livre mockado — 29 testes automatizados novos,
  cobrindo a lib de sincronização, a orquestração no ciclo automático e as
  rotas HTTP; ver `06-proximos-passos.md` para o teste ao vivo em produção
  ainda pendente). **Substitui por completo** a etapa anterior "Estoque
  (Galpão + Full, por produto base)" — reescrita pedida explicitamente
  pelo usuário, em 3 ajustes.
- **O que é:** duas telas de menu separadas — **Estoque** (estoque
  disponível fora do Full) e **Estoque Full** (quantidade armazenada no
  Full) — cada uma somente leitura, uma linha por anúncio/variação do
  Mercado Livre, com as colunas produto/anúncio, SKU, loja, ID do anúncio,
  estoque disponível, status e última sincronização. Nunca somam ou
  misturam os dois saldos (tabela nova `ml_estoque_itens`, com uma coluna
  `tipo` = `proprio`/`full` que separa uma tela da outra na consulta).
  - **Quantidade é sempre somente leitura** — sem modal, sem botão de
    ajuste, sem PUT de escrita. O usuário faz todo o lançamento/ajuste de
    estoque direto no Mercado Livre; o ERP só espelha o que a API retornar.
  - **Sincronização automática**, reaproveitando o mesmo ciclo de 1 em 1
    minuto criado para pedidos (`server/lib/syncScheduler.js`) — todas as
    contas ativas são varridas a cada ciclo; erro numa conta nunca afeta
    as demais nem a sincronização de pedidos (laço independente, com seu
    próprio contador de erro). Botão "Sincronizar agora" em cada tela é a
    opção de emergência (mesmo padrão do botão manual de pedidos).
  - **Recurso da API por tipo de anúncio:** Full usa
    `/inventories/{inventory_id}/stock/fulfillment` (já validado, mesma
    lógica de antes); fora do Full usa `available_quantity` do anúncio/
    variação, ou — quando o anúncio tem `user_product_id` (conta com
    estoque multi-origem/User Products) — tenta primeiro `GET
    /user-products/{id}` (formato de resposta não confirmado contra a API
    real nesta etapa, parsing defensivo, cai pro `available_quantity` como
    segurança; ver `05-problemas-conhecidos.md`).
  - **Nunca inventa:** quando a API não retorna a quantidade (ou o formato
    do recurso de User Products não é reconhecido), a linha fica com
    quantidade `null` e "Pendente" na tela.
  - **Nunca dá baixa de estoque por causa de uma venda** — confirmado por
    auditoria de código que `lib/mlSync.js` nunca teve essa lógica; o saldo
    mostrado é sempre um espelho fresco do Mercado Livre.
- **Onde está:** `server/lib/mlEstoque.js` (sincronização — busca todas as
  páginas de anúncios da conta, resolve a quantidade certa por anúncio/
  variação, grava/atualiza em `ml_estoque_itens`), `server/lib/syncScheduler.js`
  (dispara a sincronização de estoque a cada ciclo automático),
  `server/routes/estoque.js` e `server/routes/estoqueFull.js` (API — leitura
  do espelho + `POST /api/estoque/sincronizar` pro botão manual),
  `server/db/schema.sql` (tabela `ml_estoque_itens`), `server/public/index.html`
  (telas — `window.Estoque` e `window.EstoqueFull`, construídas pela mesma
  função `criarTelaEstoqueSomenteLeitura` pra nunca divergir uma da outra).
  As rotas antigas `server/routes/estoqueProdutoBase.js` (ajuste manual do
  Galpão, agora retorna 410) e a tela/tabelas de produto base continuam no
  código como histórico, desativadas.
- **O que falta:** teste ao vivo em produção (mudar uma quantidade no
  Mercado Livre e confirmar que aparece certa no ERP depois da
  sincronização — só validável em produção, com uma conta real, ver
  `06-proximos-passos.md`); validar o caminho de User Products com uma
  conta real que use estoque multi-origem (a conta de teste
  "PFEMBALAGEMS" não necessariamente usa esse modelo); alertas de estoque
  mínimo/ruptura (fora do escopo pedido nesta etapa).

## Compras (primeira versão simples)
- **Status:** concluído localmente (aguardando deploy + teste ao vivo em
  produção — ver `06-proximos-passos.md`).
- **O que é:** pedido de compra a um fornecedor — criar, listar, editar,
  pesquisar (por fornecedor) e mudar status (Em aberto, Pedido realizado,
  Recebido, Cancelado). Cada compra tem um ou mais itens (produto,
  quantidade, custo unitário); o valor de cada item e o valor total da
  compra são sempre calculados pelo servidor. Marcar como "Recebido" não
  mexe no Estoque (não automatizado nesta etapa, por pedido do usuário).
  Sem IA de compras.
- **Onde está:** `server/routes/compras.js` (API, com transação para
  criar/editar compra + itens), `server/public/index.html` (tela — módulo
  `window.Compras`).
- **O que falta:** automatizar entrada de estoque ao marcar "Recebido"
  (decisão pendente do usuário sobre como); sugestão de reposição/IA de
  compras; anexar nota fiscal/boleto; aprovação de compra.

## Produtos (cadastro unificado: nome, SKU, custo, status e imposto)
- **Status:** concluído localmente (aguardando deploy + teste ao vivo em
  produção — ver `06-proximos-passos.md`).
- **O que é:** cadastro de produtos por empresa — nome, SKU, custo e
  status. Permite cadastrar, listar (com busca por nome/SKU e filtro
  ativos/inativos/todos), editar e ativar/desativar. Ainda sem kits,
  composição nem controle de estoque automático (não pedido nesta etapa).
  **Desde 24/08/2026, esta tela também é onde se configura a alíquota de
  imposto da empresa** (única por empresa, não por produto) — a antiga
  tela separada "Custo & Margem" foi removida e seus dados (SKU + custo)
  migrados pra dentro de `produtos`, que passou a ser a ÚNICA fonte de
  custo por SKU usada no cálculo de margem das vendas (Pedidos, Visão
  Geral, Financeiro, Relatórios). Esta tela nunca mostra margem — só
  cadastra os insumos do cálculo. Ver `02-decisoes.md` e
  `04-alteracoes.md` (14).
- **Onde está:** `server/routes/produtos.js` (API — SKU, custo, nome,
  status), `server/routes/custos.js` (API — alíquota de imposto,
  `/api/config-financeiro`), `server/db/migrate.js` (migração de dados de
  `custos_produto` pra `produtos`, roda uma vez só), `server/public/
  index.html` (tela — módulo `window.Produtos`).
- **O que falta:** kits/composição; vínculo com estoque; exclusão
  definitiva.

## Anúncios (visualização ao vivo do Mercado Livre)
- **Status:** concluído localmente (aguardando deploy + teste ao vivo em
  produção — ver `06-proximos-passos.md`).
- **O que é:** mostra os anúncios reais das contas do Mercado Livre
  conectadas — ID, título, SKU, loja, preço, estoque disponível, status e
  tipo do anúncio — buscados ao vivo na API a cada carregamento da tela
  (nada fica salvo no banco nesta etapa). Se a empresa não tiver conta
  conectada, a conexão estiver com erro, ou a API falhar, a tela mostra que
  a sincronização está pendente (nunca um anúncio fictício). Edição de
  preço/estoque ainda não faz parte desta etapa.
- **Onde está:** `server/lib/mlAnuncios.js` (busca dos anúncios na API),
  `server/routes/anuncios.js` (API), `server/public/index.html` (tela —
  módulo `window.Anuncios`, item de menu "Anúncios", ao lado de Produtos).
- **O que falta:** editar preço e estoque pelo Mercado Livre; paginação
  além da primeira página (hoje mostra até 100 anúncios com o total real
  informado); Shopee.

## Fornecedores (cadastro)
- **Status:** concluído localmente (aguardando deploy + teste ao vivo em
  produção — ver `06-proximos-passos.md`).
- **O que é:** cadastro de fornecedores por empresa — razão social/nome,
  nome fantasia, CNPJ ou CPF (validado conforme o tamanho), telefone,
  e-mail, observação e status. Permite cadastrar, listar (com busca e
  filtro ativos/inativos/todos), editar e ativar/desativar. Estrutura já
  preparada para relacionar fornecedor a produtos e compras no futuro
  (relação em si ainda não existe).
- **Onde está:** `server/routes/fornecedores.js` (API), `server/lib/cpf.js`
  (validação de CPF, novo — CNPJ reaproveita `server/lib/cnpj.js` já
  existente), `server/public/index.html` (tela — módulo
  `window.Fornecedores`).
- **O que falta:** vínculo de fato com produtos e com o módulo de Compras;
  exclusão definitiva.

## Integração real com Mercado Livre (conexão, pedidos, custo/imposto)
- **Status:** concluído (os 3 passos pedidos: conectar conta, importar
  pedidos completos, custo por SKU + imposto configurável).
- **O que é:** conexão real via OAuth com uma conta do Mercado Livre por
  empresa (tela **Marketplaces**), importação dos pedidos reais dos últimos
  30 dias com todos os valores discriminados (tela **Pedidos**), e
  cadastro de custo por SKU + alíquota de imposto para calcular o resultado
  de cada venda (tela **Produtos**, desde 24/08/2026 — antes era uma tela
  separada "Custo & Margem", ver `02-decisoes.md`). Ver as regras completas
  em `01-regras-de-negocio.md` e as decisões técnicas em `02-decisoes.md`.
- **Testado com conta real:** conta "PFEMBALAGEMS" conectada e sincronizada
  de verdade, com pedidos reais importados (ver `04-alteracoes.md` para o
  changelog e o relatório de teste enviado ao usuário).
- **Onde está:** `server/lib/mercadolivre.js` (cliente da API do ML),
  `server/lib/mlSync.js` (sincronização/importação), `server/lib/crypto.js`
  (criptografia dos tokens), `server/lib/pkce.js` (OAuth/PKCE),
  `server/routes/integracoes.js` (conectar/sincronizar),
  `server/routes/pedidos.js` (listar/detalhar pedidos + cálculo do
  resultado), `server/routes/produtos.js` (custo por SKU),
  `server/routes/custos.js` (alíquota de imposto, `/api/config-financeiro`),
  `server/public/index.html` (módulos `window.Marketplaces`,
  `window.Pedidos`, `window.Produtos`).
- **O que falta:** otimizar a sincronização para contas com muitos pedidos
  (ver `05-problemas-conhecidos.md`). Shopee agora tem conexão real (ver
  seção **Integração real com a Shopee**, abaixo), mas ainda sem pedidos —
  isso e mais Full/Ads/financeiro da Shopee ficam para uma etapa futura.

## Integração real com a Shopee (conexão + renovação de token — 25/08/2026)
- **Status:** concluído e testado localmente (Postgres real + Express
  real via HTTP — 24 testes de integração novos em `test/shopee.test.js`,
  227 testes no total no projeto com Postgres, 0 falhas). **Ainda só
  conexão** — pedidos, estoque, Ads e financeiro da Shopee **não fazem
  parte desta etapa** (pedido explícito do usuário). Falta configurar
  Partner ID/Partner Key reais no Render e testar ao vivo (ver
  `05-problemas-conhecidos.md` e `06-proximos-passos.md`) — sem essas
  variáveis, a tela Marketplaces mostra "Integração com a Shopee ainda não
  configurada", sem quebrar o resto do ERP.
- **O que é:** conexão real via OAuth (Shopee Open Platform v2) com uma
  loja da Shopee por empresa (tela **Marketplaces**, abaixo do bloco do
  Mercado Livre) — o usuário clica em "Conectar Shopee", autoriza no site
  da própria Shopee (login/consentimento acontece lá) e volta conectado.
  Depois de conectada, a tela mostra loja/Shop ID/região/empresa
  vinculada/status/token expira em/última atualização, com um botão
  "Renovar token" manual (a renovação já acontece sozinha no servidor a
  cada 30 minutos) e "Reconectar". O painel "Conexões & Empresas" de Visão
  Geral também passou a mostrar o número real de lojas Shopee conectadas
  (antes sempre "Nenhuma conta conectada", hardcoded).
- **Diferenças de desenho em relação ao Mercado Livre** (ver
  `01-regras-de-negocio.md` e `02-decisoes.md` (29) para o porquê de cada
  uma): a Shopee assina cada chamada com HMAC-SHA256 (nunca usa PKCE);
  chave de criptografia dos tokens é própria (`SHOPEE_TOKEN_KEY`, nunca
  `ML_TOKEN_KEY`); a renovação de token é proativa (ciclo automático a
  cada 30min), não "sob demanda" como o Mercado Livre — porque, sem
  sincronização de pedidos ainda, nada mais chamaria a API da Shopee com
  regularidade suficiente pra manter o token vivo sozinho.
- **Onde está:** `server/lib/shopee.js` (cliente da API — autorização,
  troca/renovação de token, assinatura HMAC), `server/lib/shopeeCrypto.js`
  (criptografia dos tokens), `server/lib/shopeeTokenScheduler.js` (ciclo
  automático de renovação), `server/routes/shopee.js` (conectar/callback/
  renovar-token), `server/public/index.html` (bloco Shopee dentro de
  `window.Marketplaces`).
- **O que falta:** configurar `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` e
  `SHOPEE_TOKEN_KEY` no Render (ver `06-proximos-passos.md` para a lista
  exata) e testar ao vivo os 5 pontos pedidos pelo usuário: autorização,
  retorno pro ERP, armazenamento da conexão, renovação do token e
  reconexão após reiniciar o servidor.

## Pedido cai sozinho no sistema (importação automática por webhook)
- **Status:** concluído (código testado localmente; teste de ponta a ponta
  com notificação real do Mercado Livre depende do usuário configurar a
  URL no painel do Mercado Livre — ver `02-decisoes.md` (7) e
  `05-problemas-conhecidos.md`).
- **O que é:** o Mercado Livre agora avisa o ERP em tempo real assim que um
  pedido é criado/atualizado (webhook), e o pedido é importado
  automaticamente — sem precisar clicar em "Sincronizar agora". O botão
  continua existindo como reforço manual.
- **Onde está:** `server/routes/integracoes.js` (rota
  `POST /mercadolivre/webhook`), `server/lib/mlSync.js`
  (`importarPedidoPorNotificacao`, trava por pedido).
- **O que falta:** o usuário configurar a notificação no painel de
  desenvolvedor do Mercado Livre (ver `02-decisoes.md` (7) para a URL
  exata) e confirmar, com um pedido real, que ele aparece sozinho no ERP.

## Pedidos — listagem completa, filtros e relatório de exportação
- **Status:** concluído.
- **O que é:** a tela de Pedidos usa as vendas reais sincronizadas do
  Mercado Livre, filtradas pelo período selecionado (Hoje / Ontem / 7 dias
  / 30 dias / Este mês) e, agora, também por **loja** (conta do Mercado
  Livre), **status** do pedido e busca livre por **produto/SKU**, numa
  tabela compacta (coube priorizar as colunas pra caber na largura normal
  de uma tela desktop sem rolar pro lado) com: data, número do pedido,
  produto/SKU (uma coluna, em duas linhas), quantidade, valor da venda,
  taxas/comissões, frete do vendedor, custo do produto, margem de
  contribuição (R$ e %), logística e status. Loja e imposto saíram da
  tabela, mas continuam no detalhe do pedido. Clicar num pedido abre o
  detalhe completo, com cada parte do cálculo (venda − taxas − frete −
  imposto − custo = margem de contribuição) explicada linha a linha,
  incluindo loja e imposto. Quando falta alguma informação (custo de SKU
  não cadastrado, tarifa que o Mercado Livre não retornou), a coluna
  mostra "pendente" em vez de um número. Se o período (já filtrado) tiver
  mais de 500 pedidos, mostra os 500 mais recentes com um aviso de quantos
  existem no total — o relatório de exportação, abaixo, sempre traz todos.
- **Relatório de Pedidos:** dois botões, "Gerar relatório (Excel)" e
  "CSV", exportam exatamente os pedidos que batem com os filtros
  selecionados na tela (empresa, período, loja, status, produto/SKU),
  reaproveitando o mesmo cálculo da listagem — nenhuma regra financeira
  nova. Uma linha por pedido (data, número, loja, produto, SKU,
  quantidade, valor da venda, descontos, taxas/comissões, frete do
  comprador, frete do vendedor, imposto, custo do produto, margem de
  contribuição em R$ e %, logística, status) e um resumo no fim (total
  faturado, total de pedidos, total de unidades, totais de taxas/frete
  vendedor/imposto/custo, margem de contribuição total em R$ e média em %,
  pedidos cancelados à parte). Nome do arquivo com a data ou o intervalo
  do período filtrado. PDF ainda não foi implementado (não é prioridade
  agora, por pedido do usuário) — ver `06-proximos-passos.md`.
- **Onde está:** `server/lib/resultadoVenda.js` (fórmula),
  `server/lib/relatorioVendas.js` (busca + agregação, compartilhado com
  Visão Geral e Financeiro — desde 24/08/2026 lê o custo por SKU de
  `produtos` em vez de `custos_produto`, ver `04-alteracoes.md` (14), a
  fórmula em si não mudou), `server/lib/periodo.js` (cálculo dos
  períodos), `server/routes/pedidos.js` (`GET /`, `GET /:id`,
  `GET /relatorio` e os helpers de filtro/exportação), `server/public/
  index.html` (módulo `window.Pedidos`, tabela com a classe CSS
  `.compact-orders`, filtros de loja/status/busca, botões de relatório).

## Visão Geral com dados reais
- **Status:** concluído.
- **O que é:** a tela deixou de ser só visual — mostra, pra empresa e
  período selecionados **no header** (único filtro da tela — o seletor que
  existia dentro da própria página foi removido por ser duplicado):
  faturamento, quantidade de pedidos, margem de contribuição (R$ e %),
  taxas/comissões, frete do vendedor, imposto, custo dos produtos e
  pedidos cancelados (quantidade/valor, informativo — não entram nos
  valores acima). Período: Hoje / Ontem / 7 dias / 30 dias / Este mês. Tem
  também o gráfico "Faturamento x Margem de contribuição" por dia, um SVG
  simples sem biblioteca externa. Indicador sem nenhum pedido no período
  mostra "Sem dados"; indicador com pedido mas informação faltando mostra
  "Pendente".
- **Onde está:** `server/routes/relatorios.js`
  (`GET /api/relatorios/resumo-vendas`), `server/lib/relatorioVendas.js`,
  `server/public/index.html` (módulo `window.CerneFiltro` — dono do filtro
  do header — e módulo `window.Overview`, que só lê o filtro dele).
- **O que falta:** comparativo com o período anterior (Δ) não foi
  implementado. O filtro do header ainda controla só a Visão Geral —
  Pedidos e Financeiro continuam com seletor próprio dentro da página (não
  foi pedido estender agora). Ver a seção abaixo para a parte inferior da
  tela (Evolução diária/Por marketplace/Fluxo de Caixa/Conexões &
  Empresas/Alertas & IA), ativada em 26/08/2026.

## Visão Geral — parte inferior: Evolução diária, Por marketplace, Fluxo de Caixa, Conexões & Empresas, Alertas & IA (26/08/2026)
- **Status:** concluído e testado localmente (Postgres real + servidor
  real via HTTP + navegador real via Playwright, trocando empresa e
  período de verdade — 13 testes automatizados novos, 123 no total, 0
  falhas). Substitui os 5 blocos que antes mostravam dado de demonstração/
  "em breve" — pedido explícito do usuário, em 3 passos.
- **O que é:** os 5 blocos abaixo, todos respeitando SEMPRE a
  empresa/período do header (nenhum filtro próprio) e nunca recalculando
  nada — só reaproveitam as mesmas funções já usadas em Visão Geral/
  Pedidos/Financeiro/Relatórios:
  - **Evolução diária:** versão compacta do gráfico "Faturamento x Margem
    de contribuição" já existente logo acima — mesmo dado (`serieDiaria`),
    nunca um segundo cálculo.
  - **Por marketplace:** faturamento, quantidade de pedidos e participação
    % no faturamento, agrupado por CANAL de venda (não por loja/conta
    individual — diferente de Relatórios > Marketplaces). Hoje só existe
    "Mercado Livre" (única integração de pedidos do ERP); a função que
    decide o canal de cada pedido é central e única, pra uma segunda
    integração (ex: Shopee) aparecer sozinha aqui no futuro, sem alterar
    mais nada desta tela.
  - **Fluxo de Caixa:** contas a receber em aberto, contas a pagar em
    aberto, recebimentos do Mercado Livre (líquido esperado no período) —
    os mesmos números de Contas a Pagar/Contas a Receber/Recebimentos.
    **Saldo projetado** sempre "Indisponível — sem saldo bancário
    cadastrado" (o ERP não tem esse cadastro ainda; nunca inventa um
    saldo).
  - **Conexões & Empresas:** quantidade real de empresas cadastradas;
    Mercado Livre (quantidade de contas conectadas, status, última
    sincronização); Shopee (sempre "Nenhuma conta conectada" — integração
    não existe ainda). Nenhum texto fictício.
  - **Alertas & IA:** central de alertas por regras simples sobre dado
    real (não uma IA/modelo preditivo ainda): SKU sem custo cadastrado,
    pedido sem custo (impede a margem), venda com margem negativa, erro de
    sincronização do Mercado Livre, conta a pagar vencida, recebimento
    (conta a receber) atrasado, estoque zerado/muito baixo (≤ 5 unidades,
    só item já sincronizado). Clicar num alerta navega pra tela
    relacionada (Produtos, Pedidos, Marketplaces, Contas a Pagar, Contas a
    Receber ou Estoque).
- **Onde está:** `server/lib/visaoGeralPainel.js` (toda a regra dos 4
  blocos novos), `server/routes/visaoGeral.js`
  (`GET /api/visao-geral/painel`), `server/public/index.html` (dentro do
  módulo `window.Overview` — `evolucaoDiariaMiniHTML`,
  `porMarketplaceHTML`, `fluxoDeCaixaHTML`, `connectionsPanelHTML`,
  `alertsPanelHTML`).
- **O que falta:** nada pedido nesta etapa. Fora do escopo (não pedido):
  Shopee de verdade (o "Por marketplace"/"Conexões" já está preparado pra
  quando existir), saldo bancário cadastrável (pré-requisito de "saldo
  projetado"), e uma IA/modelo preditivo de verdade nos alertas (o pedido
  explícito foi começar simples, por regras).

## Financeiro (primeira versão — só Mercado Livre)
- **Status:** concluído.
- **O que é:** primeira versão do Financeiro, mostrando pro período
  selecionado: faturamento bruto, taxas e comissões, frete pago pelo
  vendedor, impostos, custo dos produtos, margem de contribuição em R$ e
  em %, e pedidos cancelados no período (fora do resultado). Usa a mesma
  fonte de dados de Visão Geral e Pedidos — nunca mostra um número
  diferente pro mesmo período.
- **Onde está:** `server/routes/relatorios.js` (mesmo endpoint da Visão
  Geral), `server/public/index.html` (módulo `window.Financeiro`, item de
  menu "Financeiro").
- **O que falta (por pedido explícito do usuário, para depois):** contas a
  pagar, contas a receber, fluxo de caixa, DRE completa, banco,
  fornecedores, Shopee.

## Sistema publicado online, com banco de dados real
- **Status:** concluído.
- **O que é:** o ERP deixou de ser só um layout estático — agora roda como um
  serviço web real (Node.js/Express) publicado no Render, com um banco
  Postgres real e persistente. Os dados não dependem mais do navegador:
  continuam existindo depois de fechar/atualizar a página, ou mesmo depois
  de reiniciar o serviço.
- **Banco principal: Supabase** (trocado do Postgres do Render para o
  Supabase em 24/08/2026 — ver `## Supabase como banco principal +
  sincronização histórica` abaixo e `02-decisoes.md` (12)).
- **Onde está:** código em `server/` (backend) e `server/public/` (o mesmo
  front-end/design já aprovado, adaptado para consumir a API real).
- **URL pública:** https://cerne-erp.onrender.com
- **O que falta:** autenticação/login real (existe só uma tabela `users`
  preparada, sem tela nem rota ainda), e todos os outros módulos.

## Supabase como banco principal + sincronização histórica
- **Status:** concluído.
- **O que é:** o Supabase/PostgreSQL passou a ser a fonte permanente de
  dados sincronizados do Mercado Livre. Visão Geral, Pedidos e Financeiro
  continuam lendo só do banco (nunca chamam a API do Mercado Livre em
  tempo real) — confirmado ao vivo, com os 5 filtros de período
  respondendo normalmente sem nenhuma chamada nova ao Mercado Livre. Todos
  os dados existentes (empresas, contas do Mercado Livre, custos, config
  financeira e os pedidos já sincronizados antes) foram migrados para o
  Supabase sem perda.
- **Sincronização histórica desde 01/07/2026:** executada com sucesso para
  a conta "PFEMBALAGEMS" — **3.604 pedidos** encontrados e importados,
  cobrindo o período de 01/07/2026 até 23/08/2026 (hoje), **0 erros**.
  Rodada uma segunda vez para confirmar que não duplica pedido (mesmo
  upsert por conta + ID do pedido do Mercado Livre). Detalhes completos em
  `04-alteracoes.md`.
- **Nova tabela `ml_pedido_pagamentos`:** guarda todos os pagamentos de
  cada pedido (um pedido pode ter mais de um), sem mexer no cálculo
  central de margem (`lib/resultadoVenda.js` / `lib/relatorioVendas.js`).
- **Nova tabela `ml_sync_historicos`:** controla o progresso da
  sincronização histórica (dia a dia, retomável se interrompida).
- **Onde está:** `server/lib/mlSync.js` (lógica da sincronização
  histórica), `server/routes/integracoes.js` (endpoints
  `sincronizar-historico` e `sincronizar-historico/status`),
  `server/db/schema.sql` (tabelas novas), `server/lib/periodo.js`
  (`inicioDoDiaBRTDeString`, usado para andar dia a dia em BRT).
- **O que falta:** custo do produto e imposto continuam exatamente como já
  estavam — não fazem parte desta etapa (pedido explícito do usuário).

## Empresas (CRUD real)
- **Status:** concluído.
- **O que é:** primeiro cadastro real do ERP. Permite cadastrar, editar,
  listar e ativar/desativar empresas (CNPJ validado e único, razão social,
  nome fantasia). Dados salvos no Postgres do Render — persistem entre
  sessões. Testado na URL pública (cadastro, edição, listagem, ativar/
  desativar e persistência após recarregar a página).
- **Onde está:** `server/routes/empresas.js` (API), `server/lib/cnpj.js`
  (validação de CNPJ), `server/public/index.html` (tela — módulo
  `window.Empresas`).
- **O que falta:** exclusão definitiva (não foi pedida ainda — hoje só existe
  ativar/desativar).

## Layout base navegável do ERP
- **Status:** concluído (estrutural/visual — ainda sem dados ou regras reais).
- **O que é:** esqueleto do ERP com sidebar (5 grupos de módulos), header
  (seletor de empresa/CNPJ, período, tema claro/escuro, notificações, usuário)
  e uma página para cada módulo do sistema. Visual revisado para um padrão
  "premium": hierarquia entre KPIs principais/secundários, 4 gráficos
  preparados com empty state, sidebar e header refinados.
- **Onde está:** `app/base-layout.html`, publicado como artifact ("Cerne").
- **O que falta:** implementar a funcionalidade real de cada módulo (dados,
  regras de negócio, integrações), módulo por módulo.
