# Problemas Conhecidos

Lista de problemas, limitações ou pendências identificadas durante o
desenvolvimento, para não serem esquecidas.

## IA Gestora: login não cobre permissão por empresa; primeiro usuário precisa ser criado por script; "Gráficos" da planilha é dado, não gráfico nativo (25/08/2026)
- **Login não cria permissão por empresa** (ver `02-decisoes.md` (30)): o
  novo login real garante que uma conversa é sempre de um usuário só, mas
  **não** garante "usuário X só pode ver a empresa Y" — qualquer usuário
  logado continua podendo escolher qualquer empresa ativa no cabeçalho da
  IA Gestora, exatamente como acontece em toda outra tela do ERP hoje
  (não existe controle de acesso por empresa em nenhum lugar do sistema).
  Não era pedido dos "3 passos" desta tarefa e exigiria alterar
  `routes/empresas.js` e o seletor do cabeçalho, compartilhados com o
  resto do ERP — fora do escopo de "só a área da IA Gestora". Se algum
  dia isso for necessário, é um projeto à parte que toca o ERP inteiro,
  não só a IA Gestora.
- **Não existe tela de "criar minha conta"** — o primeiro (e todo) login
  da IA Gestora precisa ser criado rodando um script no servidor:
  `node db/criarUsuarioIa.js "email@empresa.com" "SenhaForte123" "Nome"`
  (ver `06-proximos-passos.md` para o comando completo). Enquanto nenhum
  usuário for criado, a tela da IA Gestora mostra a tela de login
  normalmente, mas ninguém consegue entrar.
- **A aba "Gráficos" da planilha XLSX é uma tabela de dados, não um
  gráfico nativo do Excel** (ver `lib/ia/planilhaAnalise.js`) — a mesma
  categoria/série que aparece como barra na conversa vira uma tabela
  simples (categoria + valor por coluna) na planilha, porque o `exceljs`
  usado neste projeto não tem suporte a `addChart`/`addImage` (nem o real
  do npm nesta versão, nem o stub de dev). Os números são exatamente os
  mesmos do gráfico mostrado na conversa — só a apresentação (barra visual
  vs. tabela) muda entre os dois lugares. Se algum dia for pedido um
  gráfico nativo de verdade na planilha, precisaria trocar de biblioteca
  ou gerar a imagem do gráfico separadamente e inserir com `addImage`.

## Shopee: falta configurar Partner ID/Partner Key reais + confirmar a assinatura HMAC contra a Shopee de verdade (25/08/2026)
- Ao conectar a Shopee (ver `04-alteracoes.md` e `02-decisoes.md` (29)), o
  fluxo inteiro (autorização → callback → armazenamento → renovação de
  token → reconexão após reiniciar o servidor) foi testado de ponta a
  ponta com a API da Shopee **mockada** (`test/shopee.test.js`, 24 testes,
  Postgres real + Express real via HTTP). Isso prova que a lógica do ERP
  está correta para qualquer resposta que a Shopee possa dar — não prova
  que a assinatura HMAC (`sign`) implementada em `lib/shopee.js` está
  byte a byte igual ao que a Shopee real exige.
- **Motivo:** este ambiente de desenvolvimento não conseguiu abrir
  `open.shopee.com` (documentação oficial) — o acesso à internet aqui é
  restrito a um conjunto de domínios permitidos, e o domínio da Shopee não
  está nesse conjunto. O algoritmo foi implementado cruzando várias fontes
  de terceiros (guias de integração e, principalmente, o SDK open-source
  `congminh1254/shopee-sdk`, que confirma os nomes de campo exatos —
  `access_token`/`refresh_token`/`expire_in`), mas nenhuma chamada foi
  feita contra um Partner ID/Partner Key reais (esta sessão não tem
  nenhum) — diferente do Mercado Livre, onde uma chamada real com chave
  inválida já confirmou o formato de erro da API (ver entrada anterior
  sobre a IA Gestora/provedor).
- **Precisa de confirmação do usuário ao vivo em produção:** depois de
  criar o app na Shopee Open Platform e configurar as 3 variáveis de
  ambiente no Render (`SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`,
  `SHOPEE_TOKEN_KEY` — ver `06-proximos-passos.md` para o passo a passo
  completo), clicar em "Conectar Shopee" na tela Marketplaces. **Se
  aparecer um erro de assinatura** ("wrong sign" ou parecido) na tela ou
  no log do servidor, o primeiro lugar a olhar é a função `assinar()` em
  `server/lib/shopee.js` — testar primeiro contra o ambiente de testes da
  Shopee (`SHOPEE_HOST=partner.test-stable.shopeemobile.com`, variável de
  ambiente opcional), como a própria Shopee recomenda para descartar erro
  de credencial antes de suspeitar do código. Se a autorização funcionar
  normalmente, não é preciso fazer nada — o desenho já está correto.
- **Nunca bloqueou nem vai bloquear o resto do ERP:** sem as 3 variáveis
  configuradas, a tela Marketplaces mostra "Integração com a Shopee ainda
  não configurada" (mesmo padrão já usado pelo Mercado Livre) — nunca
  quebra a tela nem qualquer outra parte do sistema.

## Relatórios → Produtos "Por Caixa": sem tela de gestão dos vínculos SKU → produto base (25/08/2026)
- A visão "Por Caixa" prioriza um vínculo SALVO em `produto_base_skus`
  quando existe, e cai pro padrão automático do SKU quando não existe
  (ver `01-regras-de-negocio.md` e `02-decisoes.md` (24)). A API pra
  cadastrar/corrigir esses vínculos manualmente já existe
  (`routes/produtosBase.js` — `GET/POST /api/produtos-base`,
  `GET/POST/PUT/DELETE /api/produtos-base/vinculos`, incluindo
  `.../vinculos/sugestoes`), mas **não há nenhuma tela no menu** que a
  use — ela ficou sem interface desde que a tela Estoque parou de usar
  esse modelo (26/08/2026). Na prática, hoje, o único jeito de um usuário
  corrigir um caso em que o padrão automático erra (SKU que não segue
  "dígitos no início" ou que deveria apontar pra um produto base
  diferente do sugerido) é via chamada direta à API — não é um problema
  visível para SKUs que já seguem o padrão descrito pelo usuário, mas é
  uma lacuna real. Não fazia parte dos "3 passos" desta tarefa; registrado
  como próximo passo em `06-proximos-passos.md`.
- Reforçando: nenhum SKU sem vínculo salvo e fora do padrão é "chutado" —
  ele aparece à parte, em "SKUs sem produto base identificado", nunca
  entra em nenhum grupo nem no total de caixas físicas.

## IA Gestora: falta só uma IA_API_KEY de produção válida (28/08/2026, revisado em 25/08/2026 duas vezes)
- Ao ativar a IA Gestora (ver `04-alteracoes.md` (22) e `02-decisoes.md`
  (22)), o laço de ferramentas inteiro (pergunta → executar ferramenta →
  responder) foi testado de ponta a ponta com um **provedor de IA FALSO**
  (`test/iaOrchestrator.test.js`). Além disso, a rota HTTP real
  (`POST /api/ia-gestora/perguntar`) foi testada com servidor real rodando
  contra o Postgres de teste (empresa 900): devolve a mensagem de "não
  configurada" corretamente (sem `IA_API_KEY`), e os erros 404 (empresa
  inexistente) e 400 (pergunta vazia/faltando) na validação de entrada.
- **Correção de 25/08/2026 — descoberta importante:** a frase "este
  ambiente de desenvolvimento não tem acesso à internet" (registrada aqui
  desde a ativação original) **estava errada para este caso.** Testado ao
  vivo nesta correção (`curl` e `fetch` do Node reais, direto deste
  servidor): uma chamada para `https://api.anthropic.com/v1/messages` com
  uma chave propositalmente inválida devolveu um 401 real da API
  (`{"type":"error","error":{"type":"authentication_error","message":"API
  key is invalid."}}`) — ou seja, **este servidor CONSEGUE alcançar a API
  real da Anthropic pela internet.** A limitação real nunca foi rede — é
  não ter uma `IA_API_KEY` de produção válida (que só o usuário pode gerar
  em https://console.anthropic.com; este ambiente de desenvolvimento não
  tem uma). Com essa descoberta, também foi possível confirmar ao vivo,
  nesta correção, que o formato de request/response implementado em
  `lib/ia/providers/anthropic.js` bate com a API real: o corpo de erro
  (`type`/`error.type`/`error.message`) veio exatamente como
  documentado e como o código espera — só não foi possível confirmar
  ainda o formato de uma resposta de SUCESSO (200, com blocos
  `text`/`tool_use`, `stop_reason`, `usage`), porque isso exige uma chave
  válida de verdade.
- **Erros do provedor agora são categorizados** (correção de 25/08/2026 —
  ver `02-decisoes.md` (26)): `chave_invalida` (401/403), `sem_credito`
  (402), `limite_uso` (429), `provedor_indisponivel` (500/502/503/529),
  `erro_conexao` (504/falha de rede), `erro_desconhecido` (resto) —
  tabela verificada contra a documentação oficial de erros
  (`https://platform.claude.com/docs/en/api/errors`). Cada categoria vira
  uma mensagem clara e diferente em PT-BR (`lib/ia/orchestrator.js`); o
  texto técnico real do provedor nunca aparece pro usuário, só no
  `console.error` do servidor.
- **Não é mais uma lacuna de rede — é só a falta de uma chave real de
  produção.** O desenho continua defensivo por precaução (qualquer erro
  HTTP cai numa mensagem categorizada, nunca uma exceção que quebra a
  tela), mas a causa raiz documentada aqui até 25/08/2026 (suposta falta
  de internet) estava incorreta e foi corrigida.
- **Precisa de confirmação do usuário ao vivo em produção:** depois do
  deploy, configurar `IA_API_KEY` (uma chave de API válida da Anthropic,
  https://console.anthropic.com) no Render, abrir IA Gestora e perguntar
  algo simples (ex: "Olá" ou "Quanto vendi hoje?"). Se a resposta vier
  normal, está tudo certo. Se aparecer uma mensagem categorizada de erro
  mesmo com a chave configurada certa, o próximo passo é olhar o log do
  servidor (`[ia gestora] erro ao consultar o provedor de IA:
  categoria=... status=... tipoApi=... detalhe=...`) — se a categoria for
  `erro_desconhecido` com status 404, o mais provável é o identificador de
  modelo (`IA_MODELO`, padrão `claude-sonnet-4-5-20250929`) ter mudado ou
  não estar mais disponível; conferir o identificador atual em
  https://docs.claude.com e ajustar a variável de ambiente resolve sem
  precisar de nenhuma alteração de código.
- **Revisão de 25/08/2026 (catálogo ampliado para 19 ferramentas — ver
  `02-decisoes.md` (27)):** a mesma limitação acima (falta só a
  `IA_API_KEY` de produção) continua sendo o único bloqueio — nenhuma
  ferramenta nova precisa de nenhuma configuração adicional. Como ainda
  não há chave de produção configurada nesta sessão, **não foi possível
  testar uma conversa real em português com o modelo** usando as 10
  ferramentas novas (ex: perguntar de verdade "qual modelo de caixa mais
  vendeu em unidades físicas" e ver a IA escolher e chamar
  `produtos_por_caixa_desempenho` sozinha). A verificação disponível nesta
  sessão foi no nível da FERRAMENTA: cada uma foi chamada diretamente
  (sem passar pelo modelo) e comparada número a número contra a mesma
  função canônica que a tela do ERP usa (13 testes de integração novos,
  `test/iaFerramentas.test.js`, com Postgres real). Isso prova que os
  DADOS que a IA vai receber estão corretos e batem com o resto do ERP —
  não prova que o modelo, na prática, sempre escolhe a ferramenta certa
  pra cada pergunta (isso só é testável com uma chave real, ao vivo). Ver
  `06-proximos-passos.md` para o checklist das 10 perguntas pedidas pelo
  usuário, pendente de execução ao vivo.
- **Sobre "permissões do usuário" — RESOLVIDO em 25/08/2026 (30), ver
  `02-decisoes.md` (30):** a IA Gestora agora exige login real
  (e-mail/senha) e toda conversa é isolada por usuário — um usuário nunca
  acessa a conversa de outro (testado com dois usuários reais em
  `test/iaGestoraRoutes.test.js`). Fica de fora, deliberadamente:
  permissão por EMPRESA continua não existindo — qualquer usuário logado
  pode selecionar qualquer empresa ativa no cabeçalho, igual ao resto do
  ERP (nenhuma tela do sistema tem "usuário X só vê empresa Y"). Ver a
  entrada de baixo, "IA Gestora: login não cobre permissão por empresa".
- **Revisão de 25/08/2026 (nova ferramenta `projecao_mes` — ver
  `02-decisoes.md` (28)):** mesmo bloqueio de sempre, sem novidade — falta
  só a `IA_API_KEY` de produção. A projeção de faturamento/margem/pedidos/
  Ads foi verificada no nível da FERRAMENTA (6 testes de integração novos
  em `test/iaFerramentas.test.js`, 203 testes no total com Postgres, 0
  falhas) e, adicionalmente, as 3 perguntas do checklist pedido pelo
  usuário nesta etapa foram chamadas diretamente contra
  `executarFerramenta` (empresa 900, dado real) e o resultado recomputado
  à mão fora da ferramenta — bateu número a número. Isso prova que a
  matemática da projeção está correta; não prova ainda que o modelo, numa
  conversa real, sempre escolhe `projecao_mes` pra esse tipo de pergunta
  em vez de tentar responder "de cabeça" ou recusar — só testável ao vivo,
  depois da chave configurada (ver `06-proximos-passos.md`).

## Visão Geral: "Por marketplace" só valida com 1 canal (Mercado Livre); "Saldo projetado" nunca aparece até existir cadastro de saldo bancário (26/08/2026)
- Ao ativar a parte inferior da Visão Geral (ver `04-alteracoes.md` (21) e
  `02-decisoes.md` (21)), dois pontos ficam registrados aqui — nenhum dos
  dois é um bug, são limitações estruturais esperadas:
  1. **"Por marketplace" nunca foi testado com mais de 1 canal de
     verdade**, porque o ERP só integra o Mercado Livre até agora. O
     agrupamento (`identificarCanal`/`porCanal`, em
     `lib/visaoGeralPainel.js`) foi escrito de propósito para uma segunda
     integração (ex: Shopee) aparecer automaticamente como uma linha
     nova, mas isso só pode ser confirmado de verdade quando essa segunda
     integração existir — hoje é só uma garantia de desenho, não um teste
     com dado real de 2 canais.
  2. **"Saldo projetado" sempre mostra "Indisponível"** — não é uma
     sincronização pendente nem um bug, é uma decisão: o ERP não tem
     nenhuma tela/tabela de saldo bancário ainda, então não existe um
     saldo inicial real para projetar a partir dele. Isso só muda quando
     (e se) o usuário pedir uma funcionalidade de saldo bancário — não faz
     parte desta etapa.
- **Não precisa de ação agora** — só um lembrete pra não estranhar "Por
  marketplace" mostrando sempre 1 linha só, e "Saldo projetado" nunca
  mostrando um número, até que essas duas funcionalidades (Shopee, saldo
  bancário) existam.

## Estoque: formato exato da resposta de User Products (estoque multi-origem) não confirmado (26/08/2026)
- Ao reescrever o módulo de Estoque para usar o Mercado Livre como fonte
  oficial (ver `04-alteracoes.md` (20) e `02-decisoes.md` (20)), o usuário
  pediu explicitamente para consultar o recurso certo conforme o tipo de
  conta — contas com estoque multi-origem (`user_product_id`) devem usar o
  endpoint de User Products, não só `available_quantity`. A documentação
  pública do Mercado Livre foi consultada (`developers.mercadolivre.com.br`),
  mas quase todas as tentativas de acesso retornaram bloqueio (403/robots) —
  só uma página carregou com sucesso
  (`https://developers.mercadolivre.com.br/en_us/user-products`),
  confirmando que `GET /items/{id}` pode retornar `user_product_id` e que
  existe um recurso de "distributed stock" por loja/depósito para contas
  com a tag `warehouse_management`, mas **sem confirmar o formato exato**
  (nomes de campo) da resposta de `GET /user-products/{id}`.
- **Desenho defensivo por causa dessa incerteza:**
  `buscarQuantidadeUserProduct` (`server/lib/mlEstoque.js`) tenta 3
  formatos plausíveis de resposta, nesta ordem: `available_quantity` na
  raiz, `stock.available_quantity`, e soma de `locations[].available_quantity`
  (só se TODAS as locations tiverem um número — nunca soma parcial). Se
  nenhum formato bater, o item fica `pendente` com motivo
  `formato_resposta_nao_reconhecido` — nunca um valor inventado. Se a
  chamada à API falhar, cai pra `available_quantity` do item (motivo
  `available_quantity_fallback`) quando esse dado existir, ou também fica
  pendente. Todos os 3 formatos e os 2 caminhos de erro têm teste
  automatizado cobrindo (`server/test/mlEstoque.test.js`).
- **Não é um bug conhecido, é uma lacuna de teste** — mesmo padrão já
  registrado para a API de Ads (item abaixo). Além disso, **não há
  confirmação de que a conta de teste "PFEMBALAGEMS" sequer usa o modelo
  multi-origem** — é possível que ela só tenha `available_quantity` normal,
  o que significa que este caminho específico (User Products) pode
  continuar sem validação real mesmo depois do deploy, até o usuário
  testar com uma conta que realmente use múltiplos depósitos.
- **Precisa de confirmação do usuário ao vivo em produção:** depois do
  deploy, se a conta "PFEMBALAGEMS" (ou outra conta real conectada) usa
  User Products, sincronizar e conferir se `recursoUsado` (campo interno,
  não exibido na tela) bate com o esperado, e se a quantidade mostrada
  confere com o painel do Mercado Livre. Se aparecer `pendente` com motivo
  `formato_resposta_nao_reconhecido` para itens que deveriam ter estoque,
  o próximo passo é inspecionar a resposta real da API (log do servidor)
  e ajustar `buscarQuantidadeUserProduct` pro formato real observado.

## Ads: API de Advertising (Product Ads) do Mercado Livre ainda não testada contra uma conta real (25/08/2026, revisado em 25/08/2026)
- Ao ativar Ads (ver `04-alteracoes.md` (18) e `02-decisoes.md` (17)), essa
  foi a primeira vez que o projeto precisou integrar a API de Publicidade
  do Mercado Livre — diferente da API de pedidos/anúncios já usada em todo
  o resto do ERP. **Na correção de 25/08/2026** (`04-alteracoes.md` (25),
  `02-decisoes.md` (25)) a documentação pública oficial foi lida de novo,
  desta vez com acesso real à internet (não pelo servidor Node deste
  sandbox, que continua sem internet — pelo ambiente onde o código foi
  escrito), e dois erros REAIS de integração foram encontrados e
  corrigidos, com trecho da documentação citado como fonte:
  1. `advertiser_id` estava sendo mandado em query string; a API real usa
     ele no PATH (`/{advertiser_id}/product_ads/items`,
     `/{advertiser_id}/product_ads/campaigns`) — corrigido.
  2. As métricas `ctr`, `cvr` e `roas` estavam sendo pedidas ao endpoint de
     ITENS; a documentação só lista essas três para o endpoint de
     CAMPANHAS — removidas do endpoint de itens (ROAS/ACOS por anúncio
     continuam calculados no ERP em cima de `cost`/`total_amount` reais).
  Também confirmado (e agora usado): o parâmetro `aggregation_type=daily`
  no endpoint de itens (série diária pro gráfico/cards) e o `campaign_id`
  já presente em cada item da resposta (resolvido pra nome via
  `/{advertiser_id}/product_ads/campaigns`).
- **O que continua sem confirmação — porque não é possível confirmar sem
  uma chamada autenticada real, que este ambiente não consegue fazer**
  (o servidor Node do sandbox não tem acesso à internet nem um token
  válido de conta anunciante): (1) o valor exato de `Api-Version` esperado
  por cada endpoint continua o mesmo assumido antes (`/advertisers` usa
  `1`, `/product_ads/items` e `/product_ads/campaigns` usam `2`, conforme
  a documentação — mas isso pode ter mudado); (2) os pré-requisitos reais
  pra uma conta ter acesso a Product Ads (conta vendedora com anunciante
  ativo, e possivelmente o app do ERP precisando de algum produto/escopo
  adicional habilitado no painel de desenvolvedor — a documentação
  consultada não deixa isso explícito, nenhum dos dois foi confirmado pra
  conta de teste "PFEMBALAGEMS"); (3) o formato exato da resposta com
  `aggregation_type=daily` e do endpoint de campanhas (a documentação
  mostra um exemplo, mas sem confirmação contra uma resposta real).
- **Não é um bug conhecido, é uma lacuna de teste.** O desenho é
  defensivo por causa dessa incerteza: toda chamada está em try/catch
  (`buscarDadosAdsDaConta`, `lib/mlAds.js`) e qualquer falha — 401/403
  (sem acesso), 404 (sem anunciante), timeout, ou qualquer outro erro —
  devolve um motivo estruturado (`sem_acesso_ads`, `sem_anunciante`,
  `timeout`, `erro_api`) que a tela mostra como "Pendente de
  sincronização", nunca um número inventado; uma falha só na busca de
  campanhas ou só numa das duas séries diárias não derruba o resto (cada
  pedaço degrada isoladamente). Testado localmente (servidor real + curl,
  `periodo=hoje` e `periodo=mes`) que a conta de teste "PFEMBALAGEMS"
  (status `erro` no banco de teste) realmente cai no caminho de
  indisponibilidade e a tela degrada corretamente em todos os campos
  (cards, gráfico, as duas tabelas) — mas isso prova só o caminho de erro,
  não o caminho de sucesso com dado real.
- **Precisa de confirmação do usuário ao vivo em produção:** abrir Ads com
  a conta "PFEMBALAGEMS" (ou outra conta real conectada, com Product Ads
  habilitado) depois do deploy e conferir se investimento/cliques/
  impressões/CPC/ROAS/ACOS/campanha aparecem com dado real, e comparar o
  gasto mostrado nos cards "Gasto hoje"/"Gasto no mês" com o painel real
  de Product Ads do Mercado Livre. Se aparecer "Pendente de sincronização"
  pra sempre mesmo com a conta tendo campanhas ativas, o próximo passo é
  inspecionar a mensagem de erro específica (a tela mostra o motivo por
  loja) — mais provável de ser um dos pontos não confirmados acima do que
  um erro de lógica.

## Relatórios: SKU sem custo cadastrado aparece "pendente" nas categorias Vendas e Margem/Produtos (mesma regra de sempre, 25/08/2026)
- Igual à DRE (ver item abaixo) — como vários pedidos da conta de teste
  "PFEMBALAGEMS" ainda não têm custo cadastrado em Produtos, "Custo dos
  produtos" e "Margem de contribuição" aparecem como "pendente" na
  maioria dos períodos consultados hoje, em Vendas e Margem e em
  Produtos. **Não é um bug** — mesma regra "nunca inventar valor" de
  sempre. Resolve sozinho conforme o usuário cadastra o custo de cada
  SKU em Produtos.

## DRE: Custo dos Produtos e Margem de Contribuição ficam "Pendente" quando falta custo cadastrado no SKU (24/08/2026)
- Ao ativar a DRE (ver `04-alteracoes.md` (17) e `02-decisoes.md` (16)),
  confirmado com dado real que vários pedidos da conta de teste
  (PFEMBALAGEMS) ainda não têm custo cadastrado em Produtos para o SKU
  vendido — por isso "Custo dos Produtos" e "Margem de Contribuição"
  aparecem como "Pendente" na DRE para praticamente qualquer período
  consultado hoje. **Não é um bug** — é a mesma regra "nunca inventar
  valor" já usada em Pedidos/Financeiro/Visão Geral desde a etapa de
  Custos: sem custo cadastrado, o sistema não calcula/estima a margem, só
  mostra que está faltando. Resolve sozinho conforme o usuário cadastra o
  custo de cada SKU em Produtos — não exige nenhuma mudança na DRE.

## Recebimentos: API do Mercado Livre não traz data de liberação nem valor repassado (24/08/2026)
- Ao ativar a tela Recebimentos (ver `04-alteracoes.md` (16) e
  `02-decisoes.md` (15)), foi confirmado por consulta direta ao banco de
  produção (Supabase) que o payload de pagamento salvo pela sincronização
  atual (`raw_pagamento`) não tem nenhum campo de data de liberação do
  dinheiro nem de valor efetivamente repassado — só dados da venda/
  pagamento em si (aprovação, valor, taxas). Por isso os campos "previsão
  de liberação", "valor recebido" e "data do recebimento" aparecem sempre
  como "Informação não disponível" (nunca um valor inventado ou
  estimado), e o status sempre como "A liberar". **Não é um bug** — é o
  reflexo real do que a integração hoje entrega. A tela já está pronta
  para, quando essa informação existir (endpoint de liberação do Mercado
  Pago, ou um webhook de repasse), passar a mostrar e comparar valor
  esperado x valor realmente recebido, sem precisar mudar o desenho da
  tela — só preencher esses campos com dado real.

## Correção de margem (24/08/2026): premissa não confirmada com o usuário sobre quem paga o cupom (Bug 3)
- O Bug 3 (ver `04-alteracoes.md` (15)) trata `payments[].coupon_amount`
  como um desconto que reduz a receita real do vendedor — decisão baseada
  em evidência forte (o valor bate exatamente, centavo a centavo, com a
  diferença de margem que o usuário mediu contra o Mercado Turbo em 4
  pedidos reais diferentes, incluindo um caso com 2 pagamentos somados).
  Mas a API do Mercado Livre não deixa 100% claro, só com os campos
  disponíveis em `order.payments[]`, se ESSE cupom específico é sempre
  pago pelo vendedor ou às vezes é um cupom promocional custeado pelo
  próprio Mercado Livre/Mercado Pago (comum em campanhas de desconto no
  Pix) — nesse segundo caso, o vendedor recebe o valor cheio e não deveria
  ter a receita reduzida. O campo `fee_details` (que discrimina quem paga
  cada componente) não veio nos dados consultados — só o resumo embutido
  em `order.payments[]`, não o endpoint completo `/payments/{id}`.
  **Recomendação:** acompanhar, num período maior, se `desconto` bate
  consistentemente com o Mercado Turbo (ou com o extrato real de
  recebimento do Mercado Pago) pedido a pedido — se aparecer um pedido
  onde o cupom NÃO deveria ter sido descontado, é sinal de que a regra
  precisa diferenciar por tipo/origem do cupom (exigiria mais dado da API,
  possivelmente `/payments/{id}` completo em vez do resumo do pedido).

## Correção de margem (24/08/2026): Row Level Security desligada em todas as tabelas do Supabase de produção
- Ao investigar os Bugs 1-4 (ver `04-alteracoes.md` (15)), o Supabase
  reportou que as 21 tabelas do banco de produção estão com Row Level
  Security (RLS) **desligada** — qualquer requisição com a chave `anon`
  (pública, usada por bibliotecas cliente Supabase) consegue ler ou editar
  qualquer linha de qualquer tabela, sem autenticação nenhuma. O SQL de
  correção (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) NÃO foi aplicado
  automaticamente — habilitar RLS sem as políticas de acesso corretas
  bloquearia todo acesso ao banco, inclusive o do próprio ERP. **Como hoje
  o ERP acessa o Postgres direto pela `DATABASE_URL`/`SUPABASE_DATABASE_URL`
  (não pela API pública do Supabase com a chave `anon`), isso não afeta o
  funcionamento atual do sistema** — mas é uma porta aberta se a chave
  pública do projeto (`anon key`) algum dia vazar ou for usada em algum
  código cliente. **Precisa de uma decisão do usuário** sobre quando
  habilitar RLS com as políticas certas (fora do escopo desta correção de
  margem).

## Unificação Produtos/Custo & Margem: migração de dados ainda não confirmada em produção (24/08/2026)
- A migração que copia os dados de `custos_produto` (antiga tela "Custo &
  Margem") para `produtos` roda **automaticamente, uma única vez**, no
  primeiro boot do servidor depois do deploy (`server/db/migrate.js`,
  guardada pela tabela `migracoes_aplicadas` pra nunca rodar de novo e
  sobrescrever uma edição feita depois pelo usuário — ver `02-decisoes.md`
  para o desenho completo). Foi testada localmente (Postgres local): SKU
  só em `custos_produto` cria produto novo (nome = SKU); SKU que já existia
  nos dois lugares mantém o nome cadastrado e atualiza o custo para o valor
  de `custos_produto` (a fonte que já estava valendo de verdade); rodar a
  migração de novo não altera nada (idempotente); editar o custo em
  Produtos depois da migração e "reiniciar o servidor" (chamar a migração
  de novo) não reverte a edição.
- **Não foi possível testar contra o banco de produção** (Supabase) neste
  ambiente — só contra Postgres local com dados sintéticos. **Depois do
  deploy, vale conferir**: (1) nos logs do Render, a linha `[migrate]
  migração de dados aplicada: N SKU(s)...` apareceu uma vez só; (2) os
  produtos que já tinham custo cadastrado em "Custo & Margem" aparecem
  agora em Produtos, com o custo certo; (3) pedidos que já tinham resultado
  calculado (margem) continuam mostrando os mesmos números de antes da
  migração — nenhum valor mudou silenciosamente.
- A alíquota de imposto (`config_financeiro`) **não foi migrada** porque
  não precisou — ela já era, e continua sendo, uma configuração por
  empresa (não por produto); só a tela que a exibe mudou (agora é
  Produtos, não mais uma aba separada).

## Relatório de Pedidos: geração real do .xlsx/.csv ainda não testada em produção (24/08/2026)
- A lógica de filtro, cálculo e montagem das linhas/resumo do relatório foi
  testada localmente contra dados sintéticos no Postgres (totais conferem
  com a soma manual — ver `04-alteracoes.md` (13)). Porém, a geração real
  do arquivo `.xlsx` (biblioteca `exceljs`) **não pôde ser executada de
  ponta a ponta neste ambiente**, porque `npm install` não funciona aqui
  (ver "Este ambiente de desenvolvimento não consegue instalar pacotes
  npm", abaixo) — a integração com o ExcelJS foi conferida por leitura
  cuidadosa da API (métodos estáveis e documentados) e por um stub que
  imita a mesma API, não pela abertura real do arquivo gerado num Excel.
  **Precisa de confirmação do usuário** depois do próximo deploy: clicar
  em "Gerar relatório (Excel)" e "CSV" na tela Pedidos com alguns filtros
  diferentes, abrir os arquivos baixados e conferir que abrem sem erro e
  que os totais batem com o que a tela mostra.
- **PDF não foi implementado** nesta etapa — o usuário pediu para deixar
  isso pra depois, sem prioridade agora. Ver `06-proximos-passos.md`.
- O relatório sempre busca **todos** os pedidos do filtro (sem o limite de
  500 usado na listagem da tela), porque a exportação precisa estar
  completa — para uma empresa com muitos pedidos no período (ex: "30
  dias"), isso herda a mesma lentidão já conhecida da consulta
  `buscarPedidosDoPeriodo` (ver "Período '7 dias'/'30 dias' fica muito
  lento...", abaixo). Não foi otimizado nesta etapa (fora do escopo
  pedido); se a exportação demorar muito ou expirar num período grande, é
  o mesmo problema de fundo, não um bug novo do relatório.

## Estoque Full: testado ao vivo em produção com sucesso (23/08/2026)
- O Full identifica anúncios pelo campo `shipping.logistic_type ===
  'fulfillment'` e busca a quantidade pelo endpoint `GET
  /inventories/{inventory_id}/stock/fulfillment`, usando o `inventory_id`
  que a própria API do item retorna. **Testado ao vivo em produção com a
  conta real "PFEMBALAGEMS"**: carregou 20 anúncios Full (dos 52 anúncios
  totais verificados nos primeiros 50) com quantidades reais retornadas
  pela API, **nenhum caiu em "Pendente"** — ou seja, o formato assumido
  para `inventory_id` e para o endpoint de estoque bateu com a API real.
- Buscar a quantidade Full é **uma chamada de API por anúncio Full
  encontrado** (o Mercado Livre não documenta um jeito de buscar várias de
  uma vez) — para uma conta com muitos anúncios Full, isso pode ficar
  lento, parecido com o problema já conhecido de sincronização de pedidos.
  Não foi otimizado (ex: cache, busca em background) porque fugiria do
  escopo das etapas até aqui.
- **RESOLVIDO em 24/08/2026:** a limitação de só verificar os primeiros 50
  anúncios da conta por carregamento foi corrigida —
  `buscarEstoqueFullCompletoDaConta` (`server/lib/mlFull.js`) agora
  percorre todas as páginas da conta sozinha, usada pela nova tela
  Estoque. Continua existindo um teto defensivo de 200 páginas (~10.000
  anúncios verificados) para nunca entrar num loop sem fim se a API
  devolver um total inconsistente — se esse teto for atingido antes de
  terminar, a resposta da API vem com `truncado: true` (ainda não exibido
  na tela; ver `06-proximos-passos.md` se isso um dia for relevante para
  uma conta muito grande). Não pôde ser testado contra a API real neste
  ambiente (sem acesso à internet/token válido aqui) — só com dados
  simulados; **precisa de confirmação ao vivo em produção** com uma conta
  com mais de 50 anúncios Full.

## Compras: botão "Nova compra" do topo não abria o modal (bug encontrado e corrigido em 23/08/2026)
- No teste ao vivo em produção, o botão **"Nova compra"** no topo da tela
  (fora do estado vazio) não tinha nenhum evento de clique associado —
  clicar nele não fazia nada. Faltou a linha de wiring
  `document.getElementById('btnNewCompra').addEventListener(...)` que
  todos os outros botões equivalentes têm (Nova empresa, Novo produto,
  Novo fornecedor, Atualizar do Estoque Full). O botão "Nova compra" que
  aparece dentro do estado vazio (quando não há nenhuma compra cadastrada)
  funcionava normalmente, por isso o bug só foi percebido testando o botão
  do topo especificamente.
- **Corrigido** nesta mesma etapa, antes da entrega final — mas como a
  correção foi feita depois do primeiro upload pro GitHub, **precisa de um
  novo upload do zip de código e um novo deploy** para valer em produção.
  Depois desse novo deploy, o botão do topo precisa ser reconferido ao
  vivo (clicar e confirmar que o formulário de nova compra abre).

## Compras e Estoque não têm nenhuma automação entre si ainda
- Marcar uma compra como "Recebido" **não altera o Estoque** — foi uma
  decisão explícita do usuário para esta etapa ("não automatize ainda
  entrada de estoque ao receber a compra"). Enquanto isso não existir, dar
  entrada no estoque depois de receber uma compra precisa ser feito à mão,
  na tela Estoque (ajuste manual).
- Quando essa automação for pedida, existem decisões de negócio a
  combinar com o usuário antes de implementar: o que fazer se a
  quantidade recebida for diferente da pedida (soma o que veio, ou exige
  bater com o pedido?), o que fazer se a compra for editada depois de já
  ter dado entrada, etc.

## Custo por SKU/produto: RESOLVIDO PARCIALMENTE em 24/08/2026 (2 das 3 fontes unificadas)
- Até 23/08/2026, existiam **três** cadastros de custo sem sincronia entre
  si: `produtos.custo` (tela Produtos, sem uso real ainda), `custos_produto`
  (tela separada "Custo & Margem", a fonte de fato usada no cálculo de
  margem das vendas do Mercado Livre) e `produtos_base.custo` (custo do
  produto físico, usado só no valor financeiro do estoque).
- **Em 24/08/2026, por pedido do usuário, as duas primeiras foram
  unificadas:** a tela "Custo & Margem" foi removida, seus dados (SKU +
  custo) migrados pra dentro de `produtos` (ver `04-alteracoes.md` (14) e
  `02-decisoes.md`), e o cálculo de margem das vendas (Pedidos, Visão
  Geral, Financeiro, Relatórios) passou a ler o custo de `produtos` em vez
  de `custos_produto`. Agora só existem **duas** fontes de custo, não
  sincronizadas entre si: `produtos.custo` (cadastro do produto/SKU —
  usado na margem das vendas) e `produtos_base.custo` (produto físico —
  usado só no valor do estoque).
- **`produtos_base.custo` continua deliberadamente separado** — o pedido do
  usuário nesta etapa foi só unificar Produtos com a antiga Custo & Margem,
  não mexer em Estoque/produto base. Cadastrar/editar o custo em Produtos
  não atualiza o custo do produto base (usado no estoque), e vice-versa.
- **Continua precisando de uma decisão do usuário** sobre unificar também
  essa última fonte no futuro (ex: produto base virar a fonte única de
  custo físico, usada tanto pro estoque quanto pra margem das vendas) — não
  foi feito agora porque fugiria do escopo explícito desta etapa ("não
  altere outras funções"). Ver `06-proximos-passos.md`.

## Anúncios: sem tabela própria, primeira página limitada, SKU pode não vir da API
- A tela **Anúncios** busca os dados ao vivo na API do Mercado Livre a
  cada carregamento — não existe tabela no banco guardando anúncios (ver
  `02-decisoes.md`). Isso significa que, se a API do Mercado Livre estiver
  lenta ou instável no momento, a tela demora ou mostra erro — não há uma
  cópia local para cair como reforço (diferente de Pedidos, que ficam
  salvos depois de importados).
- **Só a primeira página é mostrada** (até 100 anúncios), com o total real
  informado pela API na tela. Contas com mais de 100 anúncios veem só uma
  parte, com aviso de quantos existem no total — "carregar mais"/paginação
  completa não foi implementado nesta etapa (ver `02-decisoes.md`).
- O **SKU de um anúncio pode aparecer como "—"** quando o Mercado Livre não
  retorna esse dado num campo único (ex: anúncio com variações que têm
  SKUs diferentes entre si) — o sistema nunca escolhe um SKU "no chute"
  nesses casos.
- **Ainda não foi possível testar a busca real de anúncios na API do
  Mercado Livre** neste ambiente (sem conseguir rodar o servidor Express
  completo aqui — ver "Este ambiente de desenvolvimento não consegue
  instalar pacotes npm", abaixo) — depende do teste ao vivo em produção
  depois do deploy.

## Período "7 dias"/"30 dias" fica muito lento com muitos pedidos (Visão Geral, Pedidos, Financeiro)
- Descoberto testando ao vivo em produção (conta real "pf embalegens",
  22/08/2026) depois da correção do filtro de período: **"Hoje" (7
  pedidos) respondeu em ~6s e "Ontem" (91 pedidos) em ~41s** — mas
  **"Últimos 7 dias" não terminou nem depois de 160 segundos esperando**
  (nesse ponto o teste foi interrompido; "Últimos 30 dias" na tela de
  Pedidos eventualmente terminou de carregar, mas levou dezenas de
  segundos e a aba do navegador ficou sem responder enquanto isso).
- **Causa provável:** a query de `lib/relatorioVendas.js`
  (`buscarPedidosDoPeriodo`) roda, pra cada pedido do período, várias
  subqueries correlacionadas (itens, SKUs, quantidade, custo do produto) —
  isso escala mal conforme o número de pedidos cresce. Como Visão Geral,
  Pedidos e Financeiro compartilham essa mesma função (de propósito, pra
  nunca calcular diferente em cada tela — ver `01-regras-de-negocio.md`),
  o problema aparece nas três, sempre que o período tem muitos pedidos.
- **Isso já existia antes desta etapa** (a query em si não foi alterada
  nesta correção — só o cálculo de início/fim do período em
  `lib/periodo.js`) — não é um problema causado pelas 3 correções pedidas
  agora, mas só apareceu claramente ao testar com "Ontem"/"7 dias"/"30
  dias" numa conta com volume real de pedidos.
- **Não foi corrigido agora** — está fora do escopo das 3 correções
  pedidas nesta etapa ("não faça nenhuma outra alteração"). Precisa de uma
  decisão do usuário sobre quando resolver (ex: reescrever a query pra
  buscar itens/custos numa consulta só em vez de subquery por pedido, ou
  paginar/adiar o cálculo pesado). Ver `06-proximos-passos.md`.

## `git push` direto não funciona nesta sessão do Cowork
- O usuário pediu para o Claude trabalhar direto no repositório Git
  (editar → testar → commit → push). `git clone` funciona (leitura
  liberada), mas `git push` é bloqueado pelo proxy de git desta sessão:
  *"pabloandrade4/cerne-erp is not in this session's authorized repository
  set... To fix, add the repository to the session's sources."*
- Não existe, neste ambiente (Cowork), nenhum comando disponível para
  autorizar isso a partir do chat (diferente do Claude Code CLI, que tem
  esse mecanismo). Parece ser uma configuração do lado do produto Cowork,
  fora do alcance desta sessão.
- **Enquanto isso não for resolvido:** o Claude edita e testa os arquivos
  normalmente, empacota um `.zip` só com o que mudou, e o usuário sobrescreve
  os arquivos no GitHub manualmente (Add file → Upload files) e comita.

## Sincronização do Mercado Livre demora com muitos pedidos (não é erro, é lentidão esperada)
- Testado com a conta real "PFEMBALAGEMS": a primeira sincronização trouxe
  **2.370 pedidos reais dos últimos 30 dias** (confirmado: 2370 de 2370
  importados/atualizados, 0 erros) — levou cerca de 14 minutos, do clique
  em "Sincronizar agora" até aparecer "Última sincronização" preenchida.
  Terminou certa e completa, só demorou.
- A sincronização processa um pedido por vez (sequencial), com até 3
  chamadas à API do Mercado Livre por pedido — para uma conta com muitos
  pedidos, isso soma bastante tempo. O botão fica em "Sincronizando..." o
  tempo todo, sem indicar progresso (quantos já foram, quantos faltam).
- Não foi otimizado agora (ex: processar em paralelo com limite de
  concorrência, mostrar progresso em tempo real, rodar em background) porque
  estava fora do escopo dos 3 passos pedidos nesta etapa. Ver
  `06-proximos-passos.md`. Foi adicionado um timeout de 20s por chamada à
  API (ver `02-decisoes.md`) para garantir que, mesmo numa chamada lenta,
  o processo nunca trave para sempre.

## Webhook do Mercado Livre ainda não foi testado com uma notificação real
- O webhook (`POST /api/integracoes/mercadolivre/webhook`) foi testado de
  duas formas neste ambiente: a lógica de validação (tópico `orders_v2`,
  conferência do `application_id`, extração do ID do pedido, payload
  malformado) isoladamente, e a query SQL/cálculo que agora aparece na
  lista de Pedidos, com dados de teste no Postgres local. **Não foi
  possível** disparar uma notificação real do Mercado Livre e confirmar o
  pedido aparecendo sozinho no ERP, porque isso depende de duas coisas que
  só o usuário pode fazer: configurar a URL do webhook no painel de
  desenvolvedor do Mercado Livre, e existir um pedido real acontecendo
  depois disso.
- **Ação necessária do usuário:** no painel de desenvolvedor do app do
  Mercado Livre, em Notificações, configurar o tópico `orders_v2` com a
  URL `https://cerne-erp.onrender.com/api/integracoes/mercadolivre/webhook`.
  Depois disso, o ideal é confirmar com o próximo pedido real (ou um pedido
  de teste, se o Mercado Livre permitir) que ele aparece no ERP sem
  precisar clicar em "Sincronizar".
- Enquanto o webhook não estiver configurado (ou se alguma notificação
  falhar por qualquer motivo), o botão "Sincronizar agora" continua
  funcionando normalmente como reforço/backup — e, desde 24/08/2026, o
  ciclo automático de 1 em 1 minuto (ver `04-alteracoes.md` (19)) também
  cobre esse caso automaticamente, dentro da janela de reconciliação (2
  dias por padrão — pedidos mais antigos que o webhook não avisar
  continuam dependendo do botão manual, ver item acima).

## `mcp__Render__query_render_postgres` não funciona
- A ferramenta de consulta direta ao Postgres do Render (via MCP) retorna
  erro de SSL (`FATAL: SSL/TLS required`) mesmo em consultas simples de
  leitura. Não foi possível inspecionar o banco de produção diretamente por
  esse caminho — os testes usaram as próprias rotas da API (`/api/...`) e um
  Postgres local só para validar a sintaxe das queries antes de publicar.
- Os logs de request (HTTP) do serviço no Render também não retornaram nada
  via `mcp__Render__list_logs` (só os logs de build/boot aparecem) — não dá
  para usar esse caminho para depurar tráfego HTTP em tempo real.

## RESOLVIDO (24/08/2026): banco principal trocado de Render Postgres para Supabase
- O problema abaixo (Postgres do Render no plano Free, expirando em
  20/09/2026) motivou a troca do banco principal para o **Supabase**, feita
  em 24/08/2026 (ver `02-decisoes.md` (12) e `04-alteracoes.md` (10)). O
  `DATABASE_URL` de produção já aponta para o Supabase — o ERP não depende
  mais do Postgres antigo do Render para funcionar.
- **Pendência que sobrou:** o banco antigo `cerne-db` (Render) ainda existe
  e ainda tem os dados de antes da migração (não foi apagado). Fica com o
  usuário decidir quando desligá-lo — recomendo manter por um tempo como
  cópia de segurança até confirmar que o Supabase está estável em uso
  normal, e só então decidir se apaga o `cerne-db` no painel do Render.
- **Também sobrou (limpeza opcional, sem urgência):** as variáveis de
  ambiente `SUPABASE_DATABASE_URL` e `ADMIN_MIGRATION_TOKEN`, criadas só
  para a migração pontual, continuam configuradas no serviço do Render mas
  não são mais usadas por nenhum código (a rota que as lia foi removida).
  Não atrapalham nada ficando lá, mas o usuário pode removê-las no painel
  do Render se quiser deixar limpo.
- Vale a pena o usuário também checar os limites do plano gratuito do
  Supabase (armazenamento, transferência, pausa por inatividade etc.)
  diretamente no painel/documentação do Supabase — não tenho esse dado
  para registrar aqui com certeza.

## Sincronização automática (1 em 1 minuto) depende do usuário fazer upgrade do plano no Render — AÇÃO NECESSÁRIA
- **Confirmado em 24/08/2026** (investigação pedida pelo usuário antes de
  implementar a sincronização automática — ver `02-decisoes.md` (19)): o
  serviço `cerne-erp` estava no plano **Free** do Render, que derruba o
  processo inteiro depois de 15 minutos sem receber requisição HTTP. Um
  `setInterval` de 1 minuto dentro do processo (a implementação feita
  nesta etapa, ver `04-alteracoes.md` (19)) **não roda de forma confiável
  nesse plano** — o timer para de existir junto com o processo sempre que
  o ERP fica um tempo sem uso, voltando só na próxima requisição HTTP
  (cold start).
- **O usuário decidiu fazer upgrade do serviço para o plano Starter**
  (~US$7/mês) — a opção recomendada, porque remove o "dormir" e deixa o
  `setInterval` funcionando 24h sem precisar de nenhum serviço adicional
  no Render nem gambiarra (ex: um ping externo mantendo o serviço
  acordado, que o próprio usuário pediu para evitar). **Esse upgrade
  precisa ser feito pelo próprio usuário no painel do Render** (Settings →
  Instance Type do serviço `cerne-erp`) — as ferramentas MCP do Render
  disponíveis nesta sessão não têm um comando para trocar o plano de um
  serviço já existente, e é uma decisão financeira que não cabe ao Claude
  tomar sozinho de qualquer forma.
- **Enquanto o upgrade não for feito**, o serviço continua funcionando
  normalmente para todo o resto do ERP (o comportamento de sempre no plano
  Free — cold start na primeira visita depois de um tempo sem acesso), mas
  o ciclo automático de 1 minuto só roda de fato enquanto o processo
  estiver de pé — ou seja, só enquanto alguém estiver usando o ERP com
  alguma frequência (cada requisição HTTP mantém o processo acordado por
  mais 15 minutos). O botão manual "Sincronizar agora" continua
  funcionando normalmente nesse meio-tempo, como sempre funcionou.
- **Depois do upgrade**, vale conferir nos logs do Render que a linha
  `[sync automático] iniciado — verificando contas ativas...` aparece uma
  vez no boot e que o serviço não reinicia sozinho por inatividade — sinal
  de que o plano Starter está mesmo mantendo o processo vivo.

## Sincronização automática: mudança num pedido com mais de 2 dias depende do webhook, não do ciclo de 1 minuto
- A janela de reconciliação do ciclo automático é de **2 dias** por padrão
  (`ML_SYNC_RECONCILIACAO_DIAS`), não os 30 dias do botão manual — decisão
  registrada em `02-decisoes.md` (19) por causa do tempo que uma
  sincronização de muitos pedidos leva (ver item abaixo). Isso significa
  que uma mudança de status/pagamento/devolução num pedido com **mais de 2
  dias** só é capturada automaticamente pelo **webhook** (notificação em
  tempo real), não pelo ciclo de 1 minuto. **Não é um bug** — é a
  estratégia combinada com o usuário (webhook = atualização rápida
  cobrindo qualquer idade de pedido; ciclo de 1 minuto = segurança/
  reconciliação de curto prazo). A consequência prática é que, enquanto o
  webhook não for confirmado funcionando ao vivo (ver item abaixo), uma
  mudança tardia num pedido antigo pode não entrar automaticamente — o
  botão manual "Sincronizar agora" (30 dias) continua cobrindo esse caso.

## Serviço web também está no plano gratuito do Render
- **Ver o item acima** ("Sincronização automática depende do usuário fazer
  upgrade") para o motivo pelo qual isso passou a importar de verdade
  nesta etapa. Continua valendo o comportamento de sempre nesse plano: o
  Render "dorme" o serviço após um período sem acessos, e a primeira
  requisição depois disso demora mais (cold start, alguns segundos). Não
  afeta os dados, só a velocidade de resposta na primeira visita.

## Existe um registro de teste na tabela de Empresas
- Durante o teste do CRUD na URL pública, foi cadastrada uma empresa de
  teste ("Empresa Teste Cerne LTDA (editada)", CNPJ 11.222.333/0001-81) para
  validar cadastro/edição/ativação. Ela foi deixada **desativada** no final
  dos testes. Como ainda não existe exclusão definitiva (só
  ativar/desativar — ver `01-regras-de-negocio.md`), ela continua no banco.
  O usuário pode ignorá-la ou pedir para removê-la quando a exclusão
  definitiva for implementada.

## Este ambiente de desenvolvimento não consegue instalar pacotes npm
- O sandbox onde o Claude desenvolve não tem acesso aos registros do
  `npm`/`pip` (bloqueio de rede). Isso não afeta o site publicado (o Render
  builda o projeto na infraestrutura dele, com internet completa), mas
  significa que o Claude não consegue rodar `npm install` nem testar o
  servidor Express localmente neste ambiente — os testes de código
  precisam ser feitos de outras formas (ex: testar a lógica isolada, testar
  o SQL direto no Postgres, ou testar direto na URL publicada).
