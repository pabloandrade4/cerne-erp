# Decisões do Projeto

Registro de decisões importantes tomadas ao longo do desenvolvimento, na ordem
em que foram tomadas (mais recente no topo).

## 2026-08-22 (9) — 3 correções: filtro único da Visão Geral, tabela de Pedidos mais estreita, fuso horário do período
- Pedido do usuário: corrigir 3 problemas específicos, sem mudar o design
  geral e sem criar funcionalidade nova — (1) Visão Geral tinha dois
  conjuntos de filtro (header + seletor dentro da página) em vez de um só;
  (2) a tabela de Pedidos era larga demais, precisava rolar pro lado pra ver
  a margem; (3) o filtro de período podia deixar pedido de outro dia entrar
  no resultado de "Hoje"/"Ontem".
- **(1) Filtro único da Visão Geral:** os dois seletores (empresa/período)
  que ficavam dentro da página `Visão Geral` foram removidos. O header
  (`#companyBtn`/`#periodBtn`, que antes eram só visuais — clicar não
  mudava nenhum dado) virou a única fonte de verdade: um módulo novo,
  `window.CerneFiltro`, busca as empresas ativas de verdade
  (`/api/empresas?status=ativas`), preenche os dois dropdowns do header com
  dado real, e notifica quem estiver "ouvindo" (`onChange`) quando a
  empresa ou o período mudam. A `Visão Geral` agora só lê
  `window.CerneFiltro.state` — não tem mais `empresaId`/`periodo` próprio.
  **Pedidos e Financeiro não entraram nessa troca** (fora do pedido desta
  etapa) — continuam com o seletor de empresa/período de dentro da própria
  página, do jeito que já funcionava.
- **(2) Tabela de Pedidos mais estreita:** revisadas as colunas mostradas —
  ficaram Data, Pedido, Produto/SKU (uma coluna só, em duas linhas), Qtd.,
  Venda, Taxas, Frete vendedor, Custo, Margem R$, Margem %, Logística e
  Status, na ordem de prioridade que o usuário pediu. **Loja** e **Imposto**
  saíram da tabela — continuam disponíveis no detalhe do pedido (clique no
  ícone de olho), que já mostrava os dois. Foi reduzido o espaçamento e a
  fonte só dessa tabela (classe `.compact-orders`, não mexe nas outras
  tabelas do sistema — Empresas, Marketplaces, Custos continuam do jeito
  que estavam) e a coluna Produto/SKU trunca com reticências (com o texto
  completo disponível ao passar o mouse) em vez de empurrar a tabela pra
  largura maior. Testado numa tela de 1280px de largura (notebook comum)
  sem precisar rolar a tabela pro lado, com Margem R$ e Margem % sempre
  visíveis.
- **(3) Fuso horário do período — bug real corrigido:** `lib/periodo.js`
  calculava "Hoje" como `[00:00 de hoje em Brasília, agora]` — o limite de
  cima era o instante da consulta, não o fim do dia. Na prática isso não
  deixava pedido "vazar" pra dentro de "Hoje" (não existe pedido no
  futuro), mas não era exatamente o que foi pedido (00:00:00 até 23:59:59)
  e não tinha jeito de isolar só "ontem". Agora "Hoje" e "Ontem" usam
  início E fim explícitos do dia inteiro em `America/Sao_Paulo`
  (`[00:00:00 do dia, 00:00:00 do dia seguinte)`), e foi adicionado o
  período **"Ontem"** (não existia antes). Validado com queries reais no
  Postgres local, inserindo pedido de teste no último segundo de ontem
  (23:59:55 BRT) e no primeiro segundo de hoje (00:00:05 BRT): o de ontem
  só apareceu em "Ontem", o de hoje só em "Hoje" — sem sobreposição, sem
  vazamento de um dia pro outro. Como a coluna `data_criacao` já é
  `TIMESTAMPTZ` (guarda o instante certo, não depende do fuso do servidor),
  não havia bug de UTC na gravação — o ajuste foi só no cálculo do
  intervalo de consulta.
- Como Visão Geral, Pedidos e Financeiro continuam todos chamando
  `calcularPeriodo()` de `lib/periodo.js` (regra central, sem duplicação —
  ver `01-regras-de-negocio.md`), a correção do fuso horário e o novo
  período "Ontem" valem para as três telas ao mesmo tempo, sem precisar
  mexer em cada uma separadamente. Só foi necessário acrescentar "Ontem" na
  lista de opções mostradas em cada seletor (header da Visão Geral, e os
  seletores próprios de Pedidos e Financeiro).
- **Testado localmente antes de publicar:** `node --check` em todos os
  arquivos de backend alterados; a lógica de `calcularPeriodo()` validada
  com script Node isolado (limites exatos de cada período); as consultas
  reais no Postgres local (`psql`) confirmando os limites de "Hoje"/"Ontem"
  com pedidos de teste nos segundos-limite (23:59:55 de ontem e 00:00:05 de
  hoje, em BRT); e o front-end (header + tabela de Pedidos) testado com
  Playwright/Chromium local (dados mockados, sem depender do Postgres) em
  telas de 1440px e 1280px — confirmando que a Visão Geral não tem mais
  seletor duplicado, que trocar empresa/período no header realmente muda o
  dado carregado, que "Ontem" aparece nos três seletores, e que a tabela de
  Pedidos não tem mais rolagem horizontal com a Margem R$/% sempre visível.
- **Testado ao vivo em produção, depois do deploy** (conta real "pf
  embalegens"), com o Chrome automatizado: "Hoje" e "Ontem" bateram exato
  com o esperado (mesmos números em Visão Geral, Pedidos e Financeiro pro
  mesmo período — confirmando a fonte única de cálculo), o header mostrou
  empresa/período reais, sem seletor duplicado na Visão Geral, e a tabela
  de Pedidos renderizou sem rolagem horizontal (`scrollWidth === clientWidth`
  confirmado via JS), com Loja e Imposto corretos no detalhe do pedido.
  **Troca de empresa não pôde ser testada com dado real** — a conta só tem
  uma empresa ativa hoje; o mecanismo em si já foi validado com dados
  simulados de 2 empresas antes do deploy. **Achado durante esse teste ao
  vivo (não fazia parte das 3 correções pedidas):** "7 dias" e "30 dias"
  ficam muito lentos com o volume real de pedidos da conta — detalhes em
  `05-problemas-conhecidos.md`.

## 2026-08-22 (8) — Ativação de Visão Geral, Pedidos e Financeiro com dados reais
- Pedido do usuário: ativar de verdade 3 telas (Visão Geral, Pedidos,
  Financeiro) com dados reais do Mercado Livre já sincronizado, com filtro
  de período funcionando, sem inventar valor, e — regra explícita — **as
  três usando a mesma fonte de cálculo no backend**, nunca cada uma
  calculando do seu jeito.
- **Arquitetura escolhida:** dois módulos novos no backend, sem nenhum dos
  três acessarem o banco "cru" por conta própria:
  - `lib/periodo.js` — define os 4 períodos (Hoje, 7 dias, 30 dias, Este
    mês) e calcula os limites de data. "Hoje" e "Este mês" usam o fuso de
    Brasília (UTC-3 fixo — o Brasil não tem mais horário de verão desde
    2019); "7/30 dias" são janela corrida.
  - `lib/relatorioVendas.js` — busca os pedidos do período de uma empresa
    (uma query só, com o mesmo formato de subquery de custo por SKU que já
    existia), calcula o resultado de cada um usando
    `lib/resultadoVenda.js` (o mesmo arquivo já usado desde a etapa
    anterior) e expõe duas funções de agregação: `resumirPeriodo` (totais)
    e `serieDiaria` (pro gráfico).
  - `routes/relatorios.js` — só um endpoint,
    `GET /api/relatorios/resumo-vendas`, consumido tanto por Visão Geral
    quanto por Financeiro.
  - `routes/pedidos.js` (`GET /`) foi reescrito pra usar
    `lib/relatorioVendas.js` também, no lugar da query que tinha antes —
    ou seja, a listagem de Pedidos e o resumo de Visão Geral/Financeiro
    literalmente compartilham a mesma função de busca+cálculo, não só a
    mesma fórmula.
- **Regra de pedido cancelado, definida com o usuário nesta etapa:** pedido
  cancelado no Mercado Livre não conta como venda — fica de fora de todos
  os valores agregados (faturamento, taxas, frete, imposto, custo, margem)
  em Visão Geral e Financeiro. Ele aparece **num lugar só**: um card
  "Pedidos cancelados" (quantidade + valor, informativo) em Visão Geral,
  com uma nota equivalente no Financeiro. Na listagem de Pedidos ele
  continua aparecendo normalmente (linha esmaecida), já que ali é a lista
  operacional de tudo que veio do Mercado Livre.
- **Decisão sobre valores parciais/pendentes nos totais agregados:** se
  ALGUNS pedidos do período têm custo de SKU pendente mas outros não, o
  total de "custo do produto" e a "margem de contribuição" somam só os
  pedidos com informação completa — nunca zero fingindo que o pedido
  pendente não existe, nem uma estimativa. Junto do número aparece quantos
  pedidos ficaram de fora ("N pedido(s) sem essa informação"). Se **nenhum**
  pedido do período tem a informação, aparece "Pendente"; se não há pedido
  nenhum no período, aparece "Sem dados" — as duas palavras exatas pedidas
  pelo usuário, usadas em lugares diferentes de propósito.
- **Gráfico "Faturamento x Margem de contribuição" por dia:** implementado
  como SVG simples embutido no próprio `index.html` (sem biblioteca externa
  de gráfico) — barras de faturamento (cobre) + linha de margem de
  contribuição (azul-petróleo), mesmo eixo (mesma unidade, R$, sem eixo
  duplo). Dias com pedido cancelado não entram na soma do dia; dias com
  pedido de custo pendente somam só a margem já conhecida daquele dia (com
  aviso abaixo do gráfico).
- **Renomeação de "margem líquida"/"lucro real" para "margem de
  contribuição"** em toda a interface (Pedidos, Visão Geral, Financeiro).
  "Lucro real"/"margem líquida" prometiam um resultado depois de TODAS as
  despesas (aluguel, salário, etc.), que o sistema não calcula — o termo
  certo pro que a fórmula realmente calcula (venda − taxas − frete − imposto
  − custo do produto) é margem de contribuição, termo que o próprio
  usuário usou ao pedir a funcionalidade.
- **Limite de linhas na listagem de Pedidos:** até 500 pedidos por período
  (antes era sempre os 200 mais recentes, fixo). Se o período tiver mais
  que isso (ex: 30 dias com milhares de pedidos), aparece um aviso dizendo
  quantos estão sendo mostrados de quantos existem no total — nunca um
  corte silencioso.
- **Removidos os cards "A receber"/"A pagar"** que existiam (vazios, só
  "—") na Visão Geral antiga. Como contas a pagar/receber não fazem parte
  desta etapa (nem foram pedidas), deixá-los ali para sempre mostrando "—"
  parecia prometer algo que ainda não existe. Eles voltam quando esses
  módulos forem implementados de verdade.
- **Testado localmente antes de publicar** (Postgres local, mesmo
  procedimento já usado no projeto): a query SQL de `relatorioVendas.js`
  foi validada direto via `psql`, e a lógica pura de agregação
  (`resumirPeriodo`, `serieDiaria`, `calcularPeriodo`) foi validada com
  dados de teste cobrindo pedido completo, pedido com custo pendente,
  pedido cancelado e os 4 períodos — todos bateram com o esperado (contas
  refeitas à mão). Não foi possível instalar o driver `pg` neste ambiente
  (bloqueio de rede já documentado em `05-problemas-conhecidos.md`), então
  a query e a lógica pura foram validadas separadamente (uma via `psql`
  direto, a outra reproduzindo as mesmas funções fora do módulo que
  depende do `pg`) — mesmo resultado, mas registrando a limitação.

## 2026-08-22 (7) — Pedido cai sozinho no sistema (webhook do ML) + custo/imposto/margem na lista de Pedidos
- Usuário pediu duas coisas: (1) pedido entrar no sistema sozinho, sem
  depender do botão "Sincronizar"; (2) a lista de Pedidos mostrar também
  custo do produto, imposto e margem líquida (só aparecia valor da venda e
  os dois fretes).
- **Pra (1), foram apresentadas duas opções ao usuário** (sincronização
  periódica automática vs. webhook do Mercado Livre em tempo real) —
  **escolhido: webhook (tempo real)**.
- **Webhook implementado seguindo a documentação oficial do Mercado
  Livre:** tópico `orders_v2` (o recomendado atualmente; o tópico legado
  `orders` não é usado), recebido em
  `POST /api/integracoes/mercadolivre/webhook`. Seguindo a própria
  orientação do Mercado Livre, o ERP responde `200` imediatamente ao
  receber a notificação (antes de processar), e só depois busca o pedido
  completo na API — se der erro nesse processamento, ele só é registrado em
  log (a resposta 200 já foi enviada, então a próxima sincronização cobre
  o que passar batido).
- **Validação de segurança:** a notificação só é processada se o
  `application_id` dela bater com o `ML_CLIENT_ID` configurado no Render —
  evita processar notificação de outro aplicativo/conta por engano.
- **Trava por pedido:** como agora existem dois caminhos que podem tentar
  importar o mesmo pedido ao mesmo tempo (webhook em tempo real +
  sincronização manual/periódica), foi adicionada uma fila interna por
  pedido (`conta + ID do pedido`) pra garantir que dois processos nunca
  gravem o mesmo pedido ao mesmo tempo e corrompam os itens gravados.
- **Pra (2),** a fórmula de "resultado da venda" (que já existia no
  detalhe do pedido) foi extraída pra um arquivo só
  (`lib/resultadoVenda.js`), usado tanto pelo detalhe quanto pela nova
  listagem — garante que a lista e o detalhe nunca mostrem números
  diferentes pro mesmo pedido. Custo do produto na listagem é somado por
  SQL (soma o custo × quantidade de cada item do pedido); se **qualquer**
  item do pedido não tiver custo de SKU cadastrado, o total fica
  "pendente" (nunca uma soma parcial fingindo ser o total).
- **Testado localmente antes de publicar** (Postgres local, mesmo
  procedimento já usado no projeto): 3 cenários — pedido com todos os itens
  com custo cadastrado (resultado calculado certo), pedido com um SKU sem
  custo cadastrado (fica "pendente"), e pedido com item sem SKU nenhum
  (também fica "pendente", nunca ignorado como se custasse zero). Os três
  bateram com o esperado. A lógica de validação da notificação (tópico,
  `application_id`, extração do ID do pedido, payload malformado) também
  foi testada isoladamente. Não foi possível testar o webhook de ponta a
  ponta com uma notificação real do Mercado Livre neste ambiente (só depois
  que o usuário configurar a URL no painel do Mercado Livre e um pedido
  real acontecer) — ver `05-problemas-conhecidos.md`.
- **Configuração necessária no painel de desenvolvedor do Mercado
  Livre** (feita pelo usuário, fora do ERP): notificar sobre o tópico
  `orders_v2` na URL `https://cerne-erp.onrender.com/api/integracoes/mercadolivre/webhook`.

## 2026-08-21/22 (6) — Processo de entrega: como as alterações chegam ao GitHub
- O usuário pediu que o Claude trabalhasse **diretamente no repositório Git**
  (editar → testar → commit → `git push`), sem precisar baixar/subir zip
  manualmente.
- Testado de verdade neste ambiente (Cowork): `git clone` do repositório
  **funciona** (leitura liberada), mas `git push` é **bloqueado pelo proxy
  de git desta sessão**, com a mensagem: *"pabloandrade4/cerne-erp is not in
  this session's authorized repository set... To fix, add the repository to
  the session's sources."* Não existe, neste ambiente, nenhum comando/ação
  (tipo o `add_repo` do Claude Code CLI) para autorizar isso a partir do
  chat — parece ser uma configuração do lado do Cowork (fora do alcance do
  Claude nesta sessão).
- **Decisão/combinado com o usuário:** enquanto isso não for resolvido do
  lado do Cowork, o fluxo de entrega volta a ser manual — o Claude edita,
  testa (sintaxe de todos os arquivos `.js` e do script do front-end, e
  quando possível valida a lógica/SQL localmente) e empacota um `.zip` só
  com os arquivos alterados; o usuário sobrescreve os arquivos no GitHub
  (Add file → Upload files) e comita na `main`. O deploy automático do
  Render cuida do resto. Ver `05-problemas-conhecidos.md`.

## 2026-08-21/22 (5) — Integração real com Mercado Livre (Passos 1, 2 e 3)
- **OAuth 2.0 + PKCE (S256)** para conectar a conta do Mercado Livre —
  fluxo oficial, autorização acontece no site do próprio Mercado Livre.
  Domínio de autorização usado: `auth.mercadolivre.com.br` (Brasil/MLB);
  endpoint de token: `api.mercadolibre.com/oauth/token` (não muda por país).
- **Tokens (access + refresh) criptografados no banco com AES-256-GCM**
  (módulo Node `crypto`, sem dependência nova). Chave gerada pelo Claude e
  configurada direto nas variáveis de ambiente do Render
  (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_TOKEN_KEY`, `ML_REDIRECT_URI`) —
  nunca aparece no código nem no front-end.
- **Tabelas novas** (todas `IF NOT EXISTS`, aplicadas automaticamente pela
  migração): `ml_contas` (conta conectada por empresa), `ml_oauth_states`
  (proteção do fluxo OAuth), `ml_pedidos` e `ml_pedido_itens` (pedidos
  importados, com o payload bruto da API guardado à parte para auditoria),
  `custos_produto` (custo por SKU) e `config_financeiro` (alíquota de
  imposto por empresa).
- **Endpoints reais do Mercado Livre usados:** `/oauth/token` (troca e
  renovação de token), `/users/me`, `/orders/search` (com filtro real de
  data `order.date_created.from`/`.to` — só últimos 30 dias, por pedido
  explícito do usuário), `/orders/{id}` (detalhe completo do pedido, itens,
  pagamento), `/shipments/{id}` (status e tipo de logística do envio) e
  `/shipments/{id}/costs` (frete do comprador via `receiver.cost` e frete do
  vendedor via `senders[].cost` — nunca misturados).
- **Regra de ouro aplicada em código, não só em intenção:** todo campo
  financeiro que a API não retorna fica `NULL` no banco (nunca `0` fingindo
  ser um valor real). O cálculo do resultado da venda só é exibido como
  número fechado se **todas** as partes existirem (tarifas reais + frete do
  vendedor real + imposto configurado + custo do produto cadastrado);
  faltando qualquer uma, o sistema mostra exatamente o que está pendente em
  vez de calcular errado.
- **Correção encontrada durante teste real:** a tela de Marketplaces (e
  Pedidos/Custos) carregava em branco no primeiro carregamento da página —
  inclusive bem no retorno do OAuth do Mercado Livre — porque o código que
  decide qual tela mostrar rodava antes do código dos módulos terminar de
  carregar. Corrigido reordenando a inicialização do `index.html`.
- **Correção encontrada durante teste real (2):** a chamada HTTP para a API
  do Mercado Livre não tinha nenhum limite de tempo — uma sincronização real
  (193+ pedidos) travou no meio, sem nunca terminar nem dar erro, porque uma
  chamada específica ficou pendurada sem resposta. Adicionado timeout de 20s
  por chamada (com `AbortController`); se uma chamada travar/for muito
  lenta, aquele pedido específico entra na lista de erros da sincronização e
  o processo segue para o próximo, em vez de travar para sempre.
- **Observação de performance (não é bug, é limitação conhecida):** com um
  volume grande de pedidos (a conta real de teste tinha 193+ pedidos em 30
  dias), a sincronização é sequencial (um pedido por vez, várias chamadas à
  API por pedido) e pode ficar bem lenta — possivelmente por
  rate-limiting real da API do Mercado Livre após muitas chamadas seguidas.
  Não foi otimizado agora (paralelizar/backoff) porque estava fora do
  escopo dos 3 passos pedidos; ver `05-problemas-conhecidos.md` e
  `06-proximos-passos.md`.
- Conforme pedido, **nada além destes 3 passos** foi desenvolvido nesta
  etapa: sem Shopee, sem lojas/usuários avançados/permissões, sem avançar
  produtos/estoque/financeiro completo/Full/IA/notas fiscais.

## 2026-08-21 (4) — Colocar o sistema no ar + banco real + Empresas funcional
- **Arquitetura de hospedagem/persistência escolhida: Render**, com Postgres
  gerenciado do próprio Render. Opção escolhida pelo usuário entre as
  alternativas apresentadas (o layout publicado como *artifact* do Claude não
  permite chamadas de rede externas nem SQL real, então não podia virar o
  banco definitivo do ERP).
- **Stack do backend definida:** Node.js + Express + PostgreSQL (via `pg`),
  mantendo o mesmo front-end estático (HTML/CSS/JS de arquivo único, mesmo
  design já aprovado) servido pelo próprio Express. Sem front-end framework,
  sem build step — extensão natural do que já existia.
- Estrutura de pastas criada em `server/`: `server.js` (app Express),
  `db/schema.sql` + `db/migrate.js` (schema e migração), `db/pool.js`
  (conexão Postgres via `DATABASE_URL`), `routes/empresas.js` (API REST de
  Empresas), `lib/cnpj.js` (validação de CNPJ), `public/` (front-end).
- **Banco de dados:** Postgres gerenciado pelo Render (plano gratuito,
  expira em 30 dias — ver `05-problemas-conhecidos.md`). Criadas apenas as
  tabelas mínimas necessárias para esta etapa: `empresas` e um stub de
  `users` (preparação para autenticação real futura — ainda sem tela/rota de
  login).
- **Deploy:** o Render exige um repositório Git para publicar o serviço web;
  como não havia permissão para criar repositórios no GitHub a partir deste
  ambiente, o usuário criou o repositório `pabloandrade4/cerne-erp` no GitHub
  e subiu os arquivos manualmente (upload via navegador). O serviço web
  (`cerne-erp`) foi criado no Render apontando para esse repositório, com
  deploy automático habilitado (qualquer novo push na branch `main` publica
  uma nova versão automaticamente).
- **Empresas:** primeira tela do ERP com dados reais e persistentes. CRUD
  completo (cadastrar, editar, listar, ativar/desativar) via API própria,
  validado end-to-end na URL pública. Ver regra em
  `01-regras-de-negocio.md`.
- Conforme pedido pelo usuário, **nenhum outro módulo** foi avançado nesta
  etapa (lojas, usuários avançados, permissões, Mercado Livre, Shopee,
  pedidos, produtos, estoque, financeiro, Full, IA, notas fiscais seguem sem
  desenvolvimento).

## 2026-08-21
- Decidido construir o ERP aos poucos, etapa por etapa, e não tentar fazer tudo de
  uma vez.
- Decidido manter uma pasta de documentação (`docs/`) como memória do projeto,
  guardando: o que está sendo construído, regras de negócio, decisões,
  funcionalidades já desenvolvidas, alterações importantes, problemas conhecidos
  e próximos passos.
- Decidido que a documentação deve ser simples e objetiva (não extensa nem
  complicada).
- Decidido que, antes de desenvolver novas partes do sistema, a documentação
  deve ser consultada para relembrar regras e decisões já definidas.
- Decidido que, quando uma regra de negócio mudar, a documentação deve ser
  atualizada para não manter informação antiga como válida.
- Nesta primeira etapa, apenas a documentação foi criada — o desenvolvimento do
  ERP em si ainda não começou.

## 2026-08-21 (2)
- Criado o layout base navegável do ERP (esqueleto visual, sem funcionalidades
  reais ainda), usando como referência de estilo/organização uma imagem de
  dashboard enviada pelo usuário — sem copiar o layout literalmente.
- Nome provisório do produto/ERP: **Cerne**. Pode ser alterado depois; não é
  o nome de nenhuma empresa do usuário, apenas o nome do sistema.
- Estilo visual definido: tema escuro como padrão (com suporte completo a tema
  claro, alternável pelo usuário), paleta em tons de tinta/grafite com dois
  acentos (cobre como cor primária, azul-petróleo/teal como secundária).
  Tipografia: Archivo (títulos), Public Sans (interface e texto) e IBM Plex
  Mono (códigos como CNPJ/SKU).
- Estrutura de navegação (sidebar) definida em 5 grupos:
  - **Geral**: Visão Geral, Alertas & IA
  - **Cadastros**: Empresas, Marketplaces (contas ML/Shopee), Produtos, Fornecedores
  - **Operação**: Pedidos, Estoque, Full, Compras
  - **Financeiro**: Financeiro, Contas a Pagar, Contas a Receber, Recebimentos,
    DRE, Faturamento, Notas Fiscais
  - **Análise**: Custos & Margem, Ads, Relatórios
- Cada módulo já tem uma página-esqueleto (título, descrição curta e lista do
  que vai existir ali), pronta para receber a funcionalidade real quando o
  usuário explicar as regras de cada uma.
- Arquivo-fonte do layout: `app/base-layout.html` (projeto), publicado como
  artifact para o usuário poder visualizar/compartilhar.

## 2026-08-21 (3)
- Revisão visual completa do layout base (mesma estrutura/navegação, aparência
  muito mais premium). Continua sendo só design — nenhuma regra de negócio ou
  integração foi implementada.
- Hierarquia do dashboard: os indicadores mais importantes (Faturamento, Lucro
  Real, Margem Líquida) viraram cards "hero" maiores, com destaque de cor e
  espaço reservado para variação percentual e sparkline. Indicadores
  secundários (Pedidos, A Receber, A Pagar) ficaram em cards compactos,
  visualmente mais discretos.
- Regra de cor definida: verde só para resultado positivo, vermelho só para
  problema/despesa/alerta, amarelo/laranja para atenção; cobre é a cor da
  marca (não é "alerta"). Aplicado assim: Faturamento = cobre (marca), Lucro
  Real = verde, Margem = azul-petróleo, Pedidos = azul-petróleo, A Receber =
  verde, A Pagar = amarelo (atenção, pois tem vencimento).
- Adicionados 4 componentes de gráfico preparados (ainda sem dados reais, com
  empty state elegante e call-to-action quando faz sentido): Faturamento x
  Lucro, Evolução diária, Distribuição por marketplace, Fluxo de caixa. Regra:
  nunca inventar dado fictício como se fosse real — sempre empty state.
- Sidebar redesenhada: ícone de cada item em um "chip", barra de destaque à
  esquerda no item ativo, divisórias entre grupos, mais respiro.
- Header redesenhado: todos os controles (empresa, período, tema, notificações,
  usuário) padronizados no mesmo estilo de pílula/ícone, com divisor visual
  entre o grupo de contexto (empresa/período) e o grupo de utilidades.
- Painel "Conexões & empresas" criado (com barra de progresso 0/3) e "Alertas
  & IA" viraram empty states honestos (sem simular dados/alertas reais).
