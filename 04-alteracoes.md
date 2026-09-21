# Alterações Importantes (Changelog)

Registro cronológico de mudanças relevantes no projeto (mais recente no topo).

## 2026-09-21 (59) — Conversa de verdade pelo Telegram (pedir números pro bot, igual a IA Gestora)
- **Pedido do usuário:** "E O TELEGRAN JA ESTA FUNCIONANDO , POIS O BOT AINDA NAO ME RESPONDEU , QUEROQ EU DE PRA MIM PEDIR AS COISAS POR LA , MESMA COISA QUANDO CONVERSO COM A AI GESTORA , É POSSIVEL??" — até aqui (ver (57)) o Telegram só mandava avisos automáticos (Radar/Daily), nunca lia nem respondia o que a pessoa escrevia pro bot.
- **Decisão de arquitetura:** reaproveitar EXATAMENTE o mesmo motor da IA Gestora (`responderPergunta`, `lib/ia/orchestrator.js`) — nenhuma regra financeira nova, nenhuma ferramenta nova, nenhum cálculo novo. O Telegram só vira mais um "jeito de entrar", ao lado do site.
- **Duas decisões confirmadas com o usuário (`AskUserQuestion`):**
  1. **Período:** o Telegram não tem a telinha de escolher mês/período do site (header). O usuário respondeu "EU SEMPRE VOU FALAR A DATA QUE QUERO RELTORIOS OU OUTRAS COISAS" — por isso foi criado `lib/ia/telegramPeriodo.js`, que lê a PRÓPRIA mensagem em busca de uma data ("hoje", "ontem", "essa semana", "últimos 30 dias", "esse mês", "mês passado", nome de mês solto como "agosto" ou "agosto de 2025", um dia específico "dia 05/08", ou um intervalo "de 01/08 a 15/08") e converte pro mesmo `periodoChave`/`desde`/`ate` que `lib/periodo.js#calcularPeriodo` já usa em todo o sistema — nenhuma lógica de data nova, só uma tradução de texto pro que já existia. Regra de honestidade: quando NENHUMA data é reconhecida na mensagem, a resposta avisa isso explicitamente e usa o mês atual como padrão — nunca finge ter entendido uma data que não estava lá.
  2. **Empresa:** o usuário confirmou que usa só uma empresa no sistema — `buscarEmpresaUnica()` em `routes/telegram.js` sempre usa a empresa ativa mais antiga cadastrada, sem precisar de nenhuma tela de escolha no Telegram.
- **Segurança (sem login no Telegram):** só mensagens vindas do `TELEGRAM_CHAT_ID` já configurado (o mesmo usado pros avisos) são respondidas — qualquer outro chat que mandar mensagem pro bot é simplesmente ignorado, nunca recebe nenhum dado da empresa.
- **Como funciona por trás (webhook):** `lib/telegram.js#registrarWebhook(url)` (novo) chama o `setWebhook` da API do Telegram — precisa ser ativado UMA VEZ, abrindo `GET /api/integracoes/telegram/ativar-conversa` no navegador depois do deploy (só nesse momento o Telegram passa a avisar o servidor quando alguém escreve pro bot; antes disso só o envio de avisos funcionava). `POST /api/integracoes/telegram/webhook` (novo) é chamada pelo Telegram a cada mensagem recebida — responde 200 pro Telegram imediatamente (nunca espera a IA terminar de pensar) e processa a pergunta à parte, mandando a resposta de volta via `enviarMensagemTelegram` (mesma função já usada pros avisos).
- **Histórico da conversa:** guardado só em memória (por chat, reinicia a cada deploy/reinício do servidor) — de propósito, pra não duplicar o sistema de conversas por usuário logado da IA Gestora (`ia_conversas`), que não faz sentido pro Telegram (não tem login). Suficiente pra perguntas de acompanhamento na mesma sessão, tipo "e comparado ao mês passado?".
- **Comandos:** `/start`, `/ajuda` ou `/help` respondem com uma mensagem de boas-vindas explicando como perguntar; qualquer mensagem que não seja texto (figurinha, foto, áudio) recebe um aviso pedindo pra escrever a pergunta em texto.
- **Verificação:** `node --check` sem erro em todos os arquivos tocados; 14 testes novos em `test/telegramPeriodo.test.js` cobrindo cada tipo de data reconhecida (hoje/ontem/semana/30 dias/mês atual/mês passado, inclusive virada de ano/dezembro→janeiro/mês nome solto com e sem ano/intervalo explícito/dia único/data inválida como "31/02"/texto sem nenhuma data) — todos passando; suíte completa rodada (`node --test`) sem nenhuma regressão nos testes que já passavam antes (as mesmas 15 falhas de sempre continuam sendo só o módulo `pg` que não existe neste ambiente de desenvolvimento, nada relacionado a este recurso).
- **O que NÃO mudou:** nenhum arquivo da IA Gestora do site (`routes/iaGestora.js`, `lib/ia/orchestrator.js`, `lib/ia/ferramentas.js`) foi tocado — só lidos, pra reaproveitar o mesmo motor sem duplicar regra nenhuma. O envio de avisos automáticos por Telegram (Radar/Daily, ver (57)) continua exatamente igual.
- **Ajuste feito depois (mesmo dia, 21/09/2026):** o interpretador de período tinha sido criado num arquivo novo (`lib/ia/telegramPeriodo.js`), mas esse arquivo especificamente ficou se perdendo em repetidos envios manuais pro GitHub (mesmo depois de `lib/telegram.js` e o resto terem subido certo) — pelo padrão dos erros do Render (sempre "não encontrei o módulo", nunca outro tipo de erro), tudo indica que o processo de upload do usuário está descartando arquivos novos dentro de pastas mais profundas (`lib/ia/`) com mais frequência que arquivos direto em `lib/`. Pra eliminar essa fonte de erro de vez, a função `resolverPeriodoDoTexto` foi movida pra DENTRO de `lib/periodo.js` (arquivo que já existia e que, confirmado pelos logs do Render, sempre subiu certo em toda tentativa) — nenhum arquivo novo a mais é necessário; `lib/ia/telegramPeriodo.js` foi removido do projeto.

## 2026-09-21 (58) — Novo layout da tela do agente "Promoções" (só aparência, nenhum dado/rota/regra mudou)
- **Pedido explícito do usuário:** mandou um arquivo HTML (mockup próprio,
  "painel_agentes_pf_1.html") com um layout novo — cards de resumo no topo,
  cartão por sugestão (em vez de linha de tabela), com comparação
  antes/depois e linha do tempo — pedindo pra aplicar EXATAMENTE esse visual
  na tela real de Promoções do sistema, e reforçou: **"não é pra mudar nada
  além do lyaut de promoções"**.
- **Decisão de arquitetura:** a tela de Promoções (`window.AgentePromocoes`)
  usava a mesma fábrica genérica `criarModuloAgenteDecisoes()` que também
  monta a tela de Ads e Performance (`window.AgenteAds`) — mudar o layout
  dentro da fábrica mudaria as duas telas. Pra cumprir literalmente "só
  Promoções, nada além disso", `window.AgentePromocoes` virou um módulo
  próprio, independente da fábrica — `criarModuloAgenteDecisoes` e
  `window.AgenteAds` continuam exatamente como estavam, nenhuma linha
  tocada. Nenhum endpoint novo, nenhuma rota nova, nenhuma tabela do banco
  tocada: os mesmos 4 endpoints de sempre (`GET/PUT /api/promocoes/decisoes`,
  `POST /api/promocoes/analisar`, `GET /api/promocoes/config`) continuam
  sendo os únicos usados.
- **Honestidade dos números (regra permanente deste projeto — nunca
  inventar dado):** o mockup do usuário mostrava alguns números que não têm
  equivalente real no sistema hoje — "conversão estimada", uma fila fixa de
  "próximas ações" e um "resultado em R$" que a IA nunca calculou. Em vez de
  inventar esses campos, a tela nova só usa números que a API já devolve de
  verdade: `snapshot.precoNormal/precoPromo/descontoPct/margemRealPct/
  coberturaDiasEstoque/estoqueAlto` (campos que já existiam na resposta de
  `/api/promocoes/decisoes` mas não eram exibidos em lugar nenhum até
  agora). Os 4 cards de resumo no topo (Aguardando aprovação / Aprovadas /
  Recusadas / Margem média avaliada) são contagens reais sobre as decisões
  já registradas — quando ainda não há nenhuma decisão reavaliada pela IA
  (o que só acontece `IA_DECISOES_DIAS_AVALIACAO` dias depois, ver
  `lib/ia/promocoesDecisoesStore.js`), o card mostra "—" em vez de 0 ou um
  número inventado.
- **O que mudou de verdade na tela:** a aba "Pendentes" trocou a tabela por
  um cartão por sugestão (título, SKU, loja, selo colorido com a ação
  sugerida, 4 caixas de contexto — o que a IA encontrou / ação sugerida /
  motivo / estoque —, comparação de preço antes→depois com margem e
  desconto reais, e os botões Aprovar/Alterar/Recusar de sempre — mesmíssima
  função `decidir()`/mesma rota `PUT .../decisoes/:id`). Um painel lateral
  novo mostra a linha do tempo real do primeiro item da lista (datas reais:
  identificado pela IA → última atualização → decisão → reavaliação) e um
  resumo com as contagens reais. A aba "Histórico" continua sendo a mesma
  tabela de sempre (só o card de resumo acima dela mudou).
- **Cores nos dois temas:** o mockup era um preview de tema escuro fixo; a
  tela real do sistema já suporta claro (padrão) e escuro (alternável). Por
  isso o layout novo usa os mesmos tokens de cor que o resto do sistema já
  usa (`var(--surface)`, `var(--border)`, `var(--success)`, `var(--danger)`,
  `var(--warning)`, `var(--purple)` etc.) em vez dos hexadecimais fixos do
  mockup — continua funcionando certo nos dois temas, sem precisar de CSS
  novo pra isso.
- **Verificação:** sintaxe do JavaScript inteiro do arquivo (`node --check`
  no `<script>` extraído) sem erro; balanceamento de chaves do CSS
  conferido; `diff` contra o zip anterior (ml99) confirmando que SÓ
  `public/index.html` mudou, e dentro dele só o bloco de
  `window.AgentePromocoes` foi substituído (a fábrica e o Ads continuam
  intactos); as funções novas de formatação (badge de decisão, texto do
  problema encontrado, comparação de preço, resumo agregado) foram testadas
  isoladamente com dados no formato real da API (3 tipos de sugestão
  diferentes) — todas produziram o texto esperado, nenhum erro lançado.

## 2026-09-21 (57) — Telegram como alternativa ao WhatsApp pros avisos automáticos
- **Contexto:** o WhatsApp via Twilio segue exigindo um "Content Template"
  aprovado pela Meta pra funcionar fora da janela de 24h (ver comentário em
  `lib/whatsapp.js` e (54)); confirmado por log do Render que o erro
  `ContentSid Required` persiste mesmo depois de o usuário subir uma versão
  nova (21/09/2026, verificado via `mcp__Render__list_logs` comparando
  timestamps antes/depois do deploy `dep-dao7d1m8bjmc73b4fcfg`, que foi ao
  ar às 00:13:23 e mesmo assim recebeu o mesmo erro às 00:13:48). Foi
  pesquisado (com o usuário) usar a Evolution API como troca completa do
  WhatsApp, mas ele preferiu manter o WhatsApp e, diante da dificuldade real
  de achar a tela de Content Template Builder no Console da Twilio, pediu
  uma alternativa: **"trocar pra Telegram"**.
- **`lib/telegram.js` (novo, mesmo padrão de `lib/whatsapp.js`, zero
  dependência nova — usa só `fetch` nativo do Node, já que a API do Telegram
  é HTTP puro):** `telegramConfigurado()` checa `TELEGRAM_BOT_TOKEN` e
  `TELEGRAM_CHAT_ID`; `enviarMensagemTelegram(texto)` manda a mensagem via
  `POST /bot<token>/sendMessage` (nunca lança pra quem chama, sempre
  devolve `{ enviado, motivo?, detalhe? }` — mesmo contrato do WhatsApp);
  corta mensagens maiores que 4096 caracteres (limite real da API) em vez de
  falhar; remove os asteriscos de negrito (formato WhatsApp) do texto antes
  de mandar, sem usar `parse_mode` do Telegram — decisão deliberada pra
  nunca arriscar a API rejeitar a mensagem inteira por causa de um caractere
  especial não escapado numa recomendação gerada pela IA.
  `listarChatsRecentes()` lê `getUpdates` do bot — usada só pra ajudar o
  usuário a descobrir o `TELEGRAM_CHAT_ID` sem precisar mexer em nada
  técnico.
- **`routes/telegram.js` (novo, registrado em `server.js` como
  `/api/integracoes/telegram`):** `GET /status` (se já configurado),
  `GET /descobrir-chat-id` (lista os chats que já mandaram mensagem pro bot,
  pra copiar o id certo), `GET /testar` (manda uma mensagem de teste) — três
  rotas no mesmo espírito de `routes/whatsapp.js`.
- **`lib/ia/radar.js`, `lib/ia/radarConcorrente.js`, `lib/ia/dailyCiclo.js`:**
  Telegram foi ligado EXATAMENTE nos mesmos pontos onde o WhatsApp já era
  chamado (aviso do Radar por situação nova/escalada, aviso do Radar de
  Concorrente, resumo diário da Daily) — os dois canais são independentes:
  se só um estiver configurado, só ele envia; se os dois estiverem, os dois
  recebem o mesmo aviso; se nenhum, nada quebra (mesma filosofia defensiva
  de sempre — nunca lança, só loga e segue). `executarDailyComNotificacao`
  agora devolve também `telegram: { enviado, motivo?, detalhe? }` ao lado de
  `whatsapp`, e aceita `enviarMensagemTelegramFn` pra teste (mesmo padrão de
  `enviarMensagemWhatsappFn`).
- **Configuração (feita pelo usuário, sem entregar nenhuma credencial pra
  IA):** criar um bot conversando com `@BotFather` no Telegram (`/newbot`),
  mandar uma mensagem qualquer pro bot novo, e configurar
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (descoberto via
  `GET /api/integracoes/telegram/descobrir-chat-id`) nas variáveis de
  ambiente do Render.
- **Testes:** `test/telegram.test.js` (novo, 8 testes puros, sem rede real,
  mesmo padrão de `test/whatsapp.test.js` — todos passando: configuração,
  envio com sucesso, erro da API, erro de rede, corte de mensagem grande,
  descoberta de chats); `test/dailyCiclo.test.js` ganhou 2 novas asserções/
  1 teste novo cobrindo o campo `telegram` no retorno de
  `executarDailyComNotificacao` (não executável neste ambiente por falta do
  módulo `pg`, mesma limitação de sempre — ver (56) — mas sintaticamente
  verificado e revisado manualmente linha a linha).
- **Nada do WhatsApp foi removido ou alterado** — é 100% aditivo; se o
  usuário conseguir configurar o Content Template do Twilio no futuro, os
  dois canais passam a funcionar ao mesmo tempo sem nenhuma mudança extra.

## 2026-09-20 (56) — Agente Coordenador (Etapa 3) + tela "Plano de Ação do Dia" (Etapa 5) + cadastro manual de concorrente por SKU
- **Pedido explícito do usuário:** "claude agora com os meus agentes ligado
  praciso que o analista analise a conta toda um exeplo anuncios o porque
  um anuncio que vendia muito parou, pode ser ads pode ser o concorrente
  entre outras coisas, como podemos fazer com que os agentes analise a
  conta por completo e coloque pontual oque deve ser feito, lembrando que
  nao pode ser no chute ou inventado tem que ser com base em metricas e
  numeros da conta".
- **Antes de construir um agente novo do zero**, foi confirmado por leitura
  direta do código que ~80% do pedido já existia rodando em produção: a
  "Daily dos Agentes" (`lib/ia/dailyCiclo.js`, `lib/ia/especialistas.js`) já
  roda todo dia, com 6 especialistas reais (Ads, Promoções, Anúncios,
  Concorrente, SAC Mercado Livre, SAC Shopee) gerando achados com números
  reais por trás. O que faltava era exatamente a peça que o usuário pediu:
  um "Agente Coordenador" que cruza esses achados entre si — já estava
  planejado (`ia_correlacoes_diarias` em `db/schema.sql`, comentário com o
  exemplo do próprio usuário: "Ads acusa margem baixa + Promoções acusa
  desconto ativo + Buy Box confirma preço competitivo -> 'reduza o desconto
  antes de reduzir Ads'"), só nunca tinha sido implementado (Etapa 3), e não
  existia tela nenhuma pra ver o resultado sem depender do WhatsApp, que
  está falhando por configuração do Twilio (Etapa 5, "Plano de Ação do
  Dia"). Decisão comunicada ao usuário no chat antes de começar a construir.
- **`lib/ia/coordenadorDiario.js` (novo, função pura, sem banco/API):**
  `gerarCorrelacoes({ achados, concorrentesMonitoradosPorSku })` cruza
  achados de agentes DIFERENTES pro MESMO SKU com 4 regras determinísticas,
  cada uma citando o número real do achado que a embasa (nunca um texto
  solto):
  - **R1** — anúncio com queda de vendas (agente Anúncios) + Ads sugerindo
    pausar anúncio/campanha do mesmo SKU (agente Ads) → a queda pode estar
    ligada à redução/pausa do investimento em Ads.
  - **R2** — anúncio com estoque sincronizado ZERADO (o próprio achado do
    agente Anúncios já traz esse número) → motivo mais óbvio de descartar
    antes de qualquer outra hipótese.
  - **R3** — anúncio com queda de vendas + Promoções sugerindo sair de uma
    promoção do mesmo SKU (margem comprometida) → a queda pode estar
    ligada ao preço promocional atual.
  - **R4** — anúncio com queda de vendas + um concorrente CADASTRADO
    MANUALMENTE pelo usuário pra esse SKU → nunca afirma que o concorrente
    é a causa (a API do Mercado Livre não permite confirmar preço
    automaticamente, ver (49)/(51)/(52)), só aponta o link real cadastrado
    pra conferência manual.
  - SKU sem nenhum cruzamento possível não gera correlação nenhuma — nunca
    inventa uma causa provável sem base real.
- **Cadastro manual de concorrente por SKU** (resposta direta do usuário ao
  bloqueio confirmado da busca automática: "sobre o concorrente eu vou
  mandar o link do anuncio do concorrente para ficar mais facil"): nova
  tabela `concorrentes_monitorados` (`db/schema.sql`), novas funções em
  `lib/concorrente.js` (`cadastrarConcorrente`, `listarConcorrentesMonitorados`,
  `mapaConcorrentesMonitoradosPorSku`, `removerConcorrenteMonitorado` —
  "remover" desativa, nunca apaga de verdade), novas rotas `GET/POST/DELETE
  /api/concorrente/monitorados` (`routes/concorrente.js`). Nunca
  valida/busca o link automaticamente — é só o cadastro, alimentando a
  regra R4 acima.
- **`lib/ia/dailyCiclo.js`:** `inserirAchados` agora usa `RETURNING id` e
  devolve os achados com o id real gerado pelo Postgres (antes descartava);
  `executarDailyEmpresa` chama `coordenadorDiario.gerarCorrelacoes` logo
  depois de coletar os achados de todos os especialistas e grava o
  resultado em `ia_correlacoes_diarias` (nova coluna `sku` adicionada nela,
  pra a tela nunca precisar voltar em `ia_achados_diarios` só pra saber de
  qual produto cada conclusão fala); uma falha no Coordenador nunca derruba
  a Daily inteira (mesmo padrão de resiliência já usado pros especialistas).
  `buscarUltimaReuniao` agora também devolve `correlacoes`. Nenhum
  agendamento novo — continua reaproveitando 100% o scheduler que já existe
  (`lib/ia/dailyScheduler.js`).
- **WhatsApp** (`formatarMensagemWhatsappDaily`): as conclusões do
  Coordenador agora aparecem em DESTAQUE, no TOPO da mensagem, antes do
  detalhe por agente — é o "pontual o que deve ser feito" que o usuário
  pediu, não pode ficar perdido no meio da mensagem. (O envio por WhatsApp
  em si segue falhando por configuração do Twilio — avisado ao usuário
  separadamente, fora do escopo desta entrega.)
- **Tela nova "Plano de Ação do Dia"** (`public/index.html`, menu "Agentes
  IA"): mostra as conclusões do Coordenador em destaque no topo (cor por
  prioridade), os achados de cada agente agrupados abaixo, e um botão
  "Analisar agora" (mesma rota `POST /api/ia/daily/gerar-agora` que o
  agendador automático já chama todo dia). **Tela "Análise de Concorrente"**
  ganhou uma seção nova pra cadastrar/listar/remover o link do concorrente
  por SKU (ver cadastro manual acima).
- **Testado:** `test/coordenadorDiario.test.js` (novo, 15 testes — função
  pura, roda sem precisar de Postgres/`node_modules`, cobre as 4 regras
  isoladas, combinadas e o caso "sem cruzamento nenhum"); `test/concorrente.test.js`
  (6 testes novos pro cadastro manual — validação, upsert sem duplicar,
  remover desativa sem apagar, isolamento entre empresas, agrupamento por
  SKU); `test/dailyCiclo.test.js`/`test/dailyRoutes.test.js` (testes novos
  pra formatação da mensagem com correlações no topo — puro, roda sempre —
  e testes de integração pra todo o fluxo real: achados reais → id real →
  Coordenador → `ia_correlacoes_diarias` → `buscarUltimaReuniao`, incluindo
  o caso de rodar 2x no mesmo dia sem duplicar). **Nesta sessão o
  `node_modules` não estava disponível** (bloqueio de rede do sandbox pra
  `registry.npmjs.org`, já visto antes nesta conta) — os testes de
  integração (que precisam do pacote `pg`) não puderam ser executados por
  aqui desta vez; foram escritos seguindo exatamente o mesmo padrão dos
  testes de integração já existentes e devem rodar normalmente no ambiente
  do usuário (Render, que já tem `node_modules` instalado). Como reforço
  extra nesta sessão, todo o fluxo SQL real (achados com `RETURNING id` →
  `gerarCorrelacoes` → `ia_correlacoes_diarias` → busca de volta) foi
  verificado manualmente contra um Postgres local via `psql`, com o
  resultado batendo exatamente com o esperado.

## 2026-09-20 (55) — Concorrente: diagnóstico confirma que o Mercado Livre bloqueia até a consulta direta do anúncio (não só a busca por título)
- **Contexto:** o usuário testou o link de diagnóstico de (51) com um
  concorrente real e mandou o resultado: `{"ok":false,"etapa":"buscar_item",
  ...,"status":403,"erro":{"message":"Access to the requested resource is
  forbidden","error":"access_denied",...}}` — ou seja, nem o primeiro passo
  (`GET /items/{id}`, autenticado) funcionou desta vez, mais restritivo do
  que o já confirmado em (49)/(52) (que era só a busca por título).
- **`lib/mercadolivre.js`:** nova função `apiGetPublico(path)` — mesma
  chamada `GET`, mas SEM header `Authorization`. Existe só pra diagnóstico
  (nunca usada em nenhum fluxo real do ERP): alguns dados de catálogo do
  Mercado Livre tradicionalmente são públicos, então tentar sem login serve
  pra separar duas causas bem diferentes — (a) o bloqueio é só pra chamada
  AUTENTICADA de um vendedor vendo o anúncio de outro (a pública ainda
  funcionaria), ou (b) o bloqueio é do próprio anúncio/endpoint,
  independente de login (a pública falha igual).
- **`lib/concorrente.js#testarListagemPorVendedor`:** as duas chamadas
  (`GET /items/{id}` e `GET /users/{sellerId}/items/search`) agora tentam
  autenticado primeiro e, só se falhar, tentam sem login como diagnóstico
  adicional. Sucesso agora informa `itemBuscadoSemLogin`/
  `listagemBuscadaSemLogin` (importante pro próximo passo: se só funcionou
  sem login, um monitoramento automático futuro não pode depender de
  nenhuma conta conectada). Falha total agora devolve os DOIS erros reais
  (`autenticado`/`semLogin`, cada um com status e corpo da resposta) em vez
  de só um — nunca esconde qual das duas tentativas falhou.
- **Testado:** `test/concorrente.test.js` — testes atualizados/novos
  cobrindo sucesso autenticado (flags `false`), autenticado falha mas
  público funciona, e os dois falham (mesmo formato do resultado real que
  o usuário reportou).
- **Ainda sem resposta definitiva:** este resultado real do usuário
  mostrou que mesmo a consulta pública ao anúncio específico dele está
  bloqueada — o caminho de (51) (listar pelo `seller_id`) ainda não foi
  reconfirmado depois desta mudança. Ver decisão sobre como seguir em
  (56) acima: o usuário optou por cadastrar o link do concorrente
  manualmente em vez de depender de mais tentativas de descoberta
  automática pela API.

## 2026-09-20 (54) — Promoções: "estoque alto" agora avisa o usuário
- **Pedido explícito do usuário:** "sobre, meu estoque daquele produto
  estiver alto, quero que me avise". Perguntado de volta como definir
  "estoque alto" (por dias de cobertura, por quantidade fixa, ou
  configurável), o usuário confirmou a opção recomendada: **pelos dias
  que o estoque dura**, no ritmo real de vendas — nunca uma quantidade
  fixa em unidades, já que produtos diferentes vendem em ritmos bem
  diferentes.
- **Como funciona:** pra cada item analisado pela IA de Promoções, calcula
  quantos dias o estoque atual ainda dura, no ritmo real de vendas dos
  últimos 90 dias (mesmo estoque já sincronizado da tela Estoque —
  `ml_estoque_itens`, nunca uma segunda sincronização própria). Acima de
  **60 dias** (padrão), o item é marcado como "estoque alto" — esse limite
  é configurável por empresa em `config_promocoes.dias_cobertura_alta`
  (mesmo padrão já usado pra margem mínima), caso 60 dias não faça sentido
  pro seu negócio, é só pedir pra eu mudar. Produto com estoque > 0 e
  **nenhuma venda** nos últimos 90 dias também conta como alto (produto
  parado), mesmo sem dar pra calcular um número exato de dias. Sem o
  estoque desse SKU ainda sincronizado, o sistema nunca assume zero — só
  não mostra o aviso.
- **Onde aparece:** sinal totalmente independente da margem — nunca muda
  se a IA recomenda entrar/sair/manter uma promoção, só soma um aviso a
  mais. Na tela Promoções: badge "📦 Estoque alto (N dias)" ao lado da
  classificação de cada item, e um bloco de estoque (atual, vendas 90d,
  cobertura, alto?) no detalhe de cada anúncio. Quando a margem já está de
  boa (classificação "manter") mas o estoque está alto, a IA agora gera
  uma sugestão nova (antes não gerava nenhuma pra "manter"): "Estoque alto
  — considerar promoção", visível na aba de decisões, sugerindo considerar
  uma promoção mais forte pra girar esse estoque — sempre respeitando a
  margem mínima configurada.
- **Testado:** `test/promocoesMotor.test.js` (função `calcularCoberturaEstoque`
  — cobertura acima/abaixo/no limite, zero vendas com estoque, sem dado de
  estoque, limite customizado por empresa, e ponta a ponta via
  `analisarItemPromocao`), `test/promocoesDecisor.test.js` (nova sugestão
  "estoque_alto" pra "manter", nunca muda o `tipoAcao` decidido pela
  margem, aparece no motivo de todas as outras classificações),
  `test/promocoesCiclo.test.js` (integração real com Postgres: soma correta
  por SKU a partir de `ml_estoque_itens` ignorando linha pendente/SKU nulo,
  gravação e atualização dos novos campos em `promocoes_analises`). Suite
  completa sem nenhuma regressão nova.

## 2026-09-20 (53) — Promoções: a mesma tolerância de 3% também vale pra promoção JÁ ATIVA
- **Contexto:** o usuário reforçou o pedido de 20/09/2026 registrado em
  (ver `02-decisoes.md`) com um exemplo concreto — vendendo a R$78,99 com
  14% de margem, só quer sugestão de promoção em preços iguais ou
  menores, nunca maiores — e confirmou ("ISSO MESMO") que a mesma regra
  dos 3 pontos percentuais (que já valia só pra decidir ENTRAR numa
  promoção nova) também deve valer pra decidir se ainda faz sentido
  **manter** uma promoção que já está rodando.
- **Confirmado que a regra de "nunca sugerir preço maior" já estava
  correta** antes desta mudança: como o Mercado Livre só oferece preços
  candidatos abaixo ou igual ao preço normal dentro da Central de
  Promoções, a estrutura do próprio dado já garante isso — não havia bug
  aí. O que faltava era só a extensão pedida abaixo.
- **`lib/promocoesMotor.js#classificar`:** pra item já ativo numa
  promoção, se a margem real caiu mais de 3 pontos percentuais abaixo da
  margem NORMAL deste mesmo produto (preço cheio) — mesmo estando bem
  acima do mínimo absoluto configurado — a classificação agora vira
  **"RISCO DE MARGEM"** em vez de "MANTER". Nunca vira "SAIR" sozinho por
  causa disso (SAIR continua reservado só pra abaixo do mínimo absoluto)
  — é um aviso pra revisar, nunca uma saída automática.
- **`lib/ia/promocoesDecisor.js`:** o motivo da sugestão agora distingue
  os dois jeitos de cair em "risco de margem": perto do mínimo absoluto
  (texto de sempre) ou já caiu demais da margem normal (novo texto,
  explicando os pontos percentuais e a margem normal do produto).
- **Testado:** `test/promocoesMotor.test.js` (6 cenários novos pra
  `classificar` com item já ativo: acima/no limite/abaixo da tolerância,
  SAIR nunca vira risco_margem, sem margem normal calculável a regra não
  se aplica), `test/promocoesDecisor.test.js` (2 cenários novos
  confirmando qual dos dois textos aparece). 1 teste antigo que esperava
  o comportamento ANTERIOR (`"manter"` nesse cenário) foi atualizado pra
  refletir a regra nova, confirmada pelo usuário.

## 2026-09-20 (52) — Corrigido bug real: tela de Concorrente quebrava com "Erro interno do servidor"
- **Contexto:** o usuário mandou print mostrando "NÃO FOI POSSÍVEL BUSCAR —
  Erro interno do servidor" ao clicar em "Buscar concorrentes" pra um
  produto específico, e perguntou "a própria IA tem que entrar no mercado
  livre e pesquisar sobre as vendas? Isso é possível?".
- **Confirmado com log real de produção:** sim, é exatamente isso que a IA
  faz — ela chama a busca real do Mercado Livre na hora. O que estava
  quebrando: o bloqueio da própria plataforma (403 Forbidden em
  `/sites/{site}/search`, já documentado em (49)) estava subindo sem
  tratamento nesse caminho específico (`buscarCandidatosPorTitulo`, chamado
  de dentro de `buscarConcorrentesPorProduto`) e virando um erro 500
  genérico — diferente do ciclo automático diário, que já isolava esse
  mesmo erro por produto e continuava rodando (por isso só a tela sob
  demanda quebrava, não o Radar de Concorrente automático).
- **Corrigido** (`lib/concorrente.js`): esse trecho agora tem `try/catch` —
  quando a busca por título é recusada pelo Mercado Livre, a função nunca
  mais lança um erro pra cima; devolve um resultado normal com
  `modo: 'busca_bloqueada'` e a mensagem real do motivo. `public/index.html`
  ganhou um estado próprio pra esse modo (ícone vermelho, explicação clara),
  em vez de cair no fluxo genérico de "nenhum concorrente encontrado" (que
  seria enganoso — a busca nem rodou, não é que não achou ninguém).
- **Testado:** `test/concorrente.test.js` — 1 teste novo (403 vindo da API
  → `modo: 'busca_bloqueada'`, nunca lança), 9/9 no arquivo. Checagem de
  sintaxe do `public/index.html` sem erro.
- **Segue valendo o que já foi dito em (49):** o bloqueio em si é da
  plataforma do Mercado Livre, não um bug daqui — essa correção só garante
  que a tela avise com clareza em vez de quebrar. O caminho alternativo
  (monitorar concorrente pelo link da LOJA, sem depender dessa busca por
  título) segue em teste — ver (51) e a resposta separada no chat.

## 2026-09-20 (51) — Concorrente: rota de TESTE pra listar os anúncios de um vendedor só pelo link da loja (ainda não é a funcionalidade final)
- **Contexto:** o usuário esclareceu o pedido de monitorar concorrente:
  "eu posso te passar o link da loja dos concorrentes mas você não tem que
  ir sempre olhando pra me avisar, não tem como eu te mandar o link" — ou
  seja, dar o link da loja UMA VEZ, não ficar mandando link de anúncio toda
  vez, e o sistema acompanhar sozinho depois. Ele mandou um exemplo real:
  `mercadolivre.com.br/loja/nzb-embalagens?item_id=MLB4712675795&...`.
- Antes de construir o monitoramento automático inteiro em cima disso, foi
  criada uma rota só de **teste/diagnóstico**, pra confirmar com uma
  chamada real (nunca simulada) se o caminho técnico funciona: `GET
  /api/concorrente/testar-vendedor?empresaId=&url=` — aberta direto no
  navegador (mesmo espírito de `GET /api/integracoes/whatsapp/testar`).
- **Nova função `testarListagemPorVendedor`** (`lib/concorrente.js`): (1)
  extrai o `item_id` do link informado; (2) consulta esse anúncio real
  (`GET /items/{id}`, endpoint já usado em produção) pra descobrir o
  `seller_id` (o ID da loja/vendedor); (3) tenta listar os anúncios ATIVOS
  desse vendedor pelo ID (`GET /users/{seller_id}/items/search`) — um
  endpoint DIFERENTE do `/sites/{site}/search` que está bloqueado (ver
  entrada (49)). Qualquer etapa que falhar devolve o motivo exato vindo da
  API, nunca inventa sucesso nem esconde o erro.
- **Ainda não é a funcionalidade final.** Falta, depois de confirmar que
  funciona: (a) guardar os concorrentes monitorados (loja + o que ele
  vende) numa tabela nova, pra não precisar do link de novo; (b) cruzar os
  anúncios do concorrente com os produtos que você já vende (por
  título/SKU, do mesmo jeito cuidadoso que a busca por título já faz —
  nunca dando certeza automática, sempre "candidato a confirmar" quando
  não é o mesmo catálogo); (c) rodar isso sozinho de tempos em tempos,
  como o restante do Radar já faz.
- **Testado:** `test/concorrente.test.js` — 4 testes novos cobrindo o
  caminho feliz (link → item → vendedor → listagem), link sem `item_id`,
  erro da API sendo repassado sem esconder, e empresa sem conta do
  Mercado Livre ativa. 8/8 no arquivo (4 antigos + 4 novos).
- **Ação necessária do usuário:** abrir o link de teste que foi enviado
  em separado no chat (já com o link da loja dele preenchido) e mandar de
  volta o que aparecer, pra eu confirmar se o caminho funciona antes de
  construir o resto.

## 2026-09-20 (50) — Visão Geral: evolução do faturamento vs. período anterior + resumo dos Agentes de IA
- **Contexto:** pedido explícito do usuário: "em visão geral quero em
  colocar tudo que for possível, os agentes ia, resumos principalmente se
  o faturamento está caindo ou aumentando, comparado ao mês passado".
- **Faturamento vs. período anterior — resolve uma limitação já
  documentada** (`02-decisoes.md` (37): "mostrar isso exigiria inventar um
  número"). Nova função `evolucaoFaturamento()` em
  `lib/visaoGeralPainel.js` compara o faturamento do período selecionado
  com o **mesmo período imediatamente anterior**, usando
  `periodoAnteriorEquivalente()` — a MESMA função já usada em Performance
  de Anúncios e Visitas e Conversão, nunca uma segunda regra de
  comparação. Nunca inventa um "%" quando falta um dos dois lados: se o
  período atual ou o anterior não tem faturamento confirmado suficiente,
  a tendência vem `'sem_dado'` e a % vem `null` — sem esconder isso atrás
  de um zero. Aparece como uma seta (▲/▼/●) e a % de variação embaixo do
  KPI de Faturamento, com o intervalo de datas do período anterior ao
  lado.
- **Resumo dos Agentes de IA** — nova seção "Agentes de IA" na Visão
  Geral, reaproveitando **a mesma função que já existia** para o hub de
  Agentes de IA, `obterResumoHub()` (`lib/ia/agentesResumo.js`) — nenhum
  cálculo novo, nenhuma tabela nova. Mostra 3 números reais (agentes
  ativos, tarefas executadas hoje, alertas importantes) e, por agente,
  pendentes/sugestões novas/decisões de hoje.
- **Decisão de segurança ao linkar cada agente:** só os agentes que hoje
  têm página própria navegável (Ads e Performance, Promoções, Análise de
  Concorrente) viram um item clicável. Os outros (SAC Mercado Livre, SAC
  Shopee, Radar de Anúncios) aparecem só como texto — porque, como
  registrado em `02-decisoes.md`/comentário de 19/09/2026 em
  `public/index.html`, o próprio usuário pediu pra tirar "Agentes de IA",
  "SAC Mercado Livre" e "SAC Shopee" do menu; a tela-hub e as duas telas
  de SAC continuam existindo por baixo (nada foi apagado), só não têm
  mais um link de menu — e este novo resumo respeita isso, nunca reabrindo
  um caminho de navegação que o usuário tinha pedido pra fechar.
- O novo bloco só aparece com "Todas as lojas" selecionado (mesma
  convenção já usada por "Por marketplace" e "Alertas & IA": são sempre
  por empresa inteira, nunca por uma loja específica).
- **Testado:** `test/visaoGeralPainel.test.js` — 6 testes novos de
  `evolucaoFaturamento` (subiu/caiu/igual/sem dado atual/sem dado
  anterior/base zero) + assertões novas nos 2 testes de integração já
  existentes (empresa real e empresa vazia), 19/19 passando. Checagem de
  sintaxe do `public/index.html` inteiro (extração de todos os `<script>`
  e `new Function`) sem erro.

## 2026-09-20 (49) — Análise de Concorrente: bug real corrigido (alertas se autodestruindo) + bloqueio externo do Mercado Livre, documentado com honestidade
- **Contexto:** o usuário reportou "Análise de concorrente não está
  funcionando". Diagnóstico feito com **log real de produção** (Render,
  serviço `cerne-erp`), nunca por suposição.
- **Causa 1 — bug real, corrigido:** `persistirSituacoes()`
  (`lib/ia/radar.js`) é a mesma função usada pelo ciclo principal do Radar
  (a cada 15min) E pelo ciclo de Concorrente, e ela sempre "resolvia"
  (marcava como encerrado) todo alerta aberto que não tivesse sido
  detectado *naquele ciclo específico*. Sem isolar por origem, o Radar
  principal — que roda logo depois — resolvia sozinho todo alerta de
  Concorrente por não tê-lo detectado no SEU ciclo, mesmo com o
  concorrente continuando ativo de verdade. Resultado: nenhum alerta de
  Concorrente sobrevivia mais que ~15 minutos, por mais real que fosse.
  **Corrigido** com uma coluna nova, `origem_ciclo` (`radar_alertas`,
  `db/schema.sql`), e um 3º parâmetro em `persistirSituacoes(empresaId,
  situacoes, origem)`: cada ciclo só resolve os alertas que ele mesmo
  criou (`radar_principal` nunca mais mexe no que é do `concorrente`, e
  vice-versa). Teste de regressão novo em `test/radar.test.js` prova
  exatamente isso — 6/6 passando.
- **Causa 2 — bloqueio externo do Mercado Livre, não é um bug daqui:** o
  endpoint que a "busca por título" do Concorrente usa
  (`/sites/{site}/search`, `lib/concorrente.js`) está devolvendo **403
  Forbidden** — confirmado no log real de produção (`Error: forbidden`,
  `status: 403`) e, de forma independente, confirmado por busca na web
  (múltiplas reclamações no Reclame Aqui relatando exatamente essa
  restrição): o Mercado Livre passou a bloquear esse endpoint de busca
  pra aplicativos de terceiros, de forma ampla — não é algo que uma
  correção de código aqui resolve. Como a maioria dos produtos deste
  negócio não tem ID de catálogo do Mercado Livre (são produtos
  próprios/sob medida), o modo "por catálogo" quase nunca se aplica, e a
  "busca por título" era o único caminho que sobrava — por isso a
  sensação de "não funciona mais".
- **Decisão pendente com o usuário** sobre a Causa 2: ver `02-decisoes.md`
  (46) — nenhuma decisão foi tomada sozinha aqui, é uma pergunta aberta
  pro usuário.
- **Testado:** `test/radar.test.js` (6/6, incluindo o teste de regressão
  novo).

## 2026-09-20 (48) — Promoções IA: nova regra — nunca recomendar entrar numa promoção que derrube a margem normal do produto em mais de 3 pontos
- **Contexto:** pedido explícito do usuário: "Regra das promoções é só me
  avisar de promoções quando for vender em um preço igual ou menor com a
  mesma margem ou uma margem até 3% menor pois se eu vender com preço
  maior minha margem é mais mesmo certo".
- **Nova métrica `margemNormalPct`** (`lib/promocoesMotor.js`): a margem
  que o MESMO anúncio teria vendendo no preço normal (cheio), calculada
  com as MESMAS estimativas de comissão % e frete por unidade (vindas do
  histórico real de vendas) já usadas pra calcular a margem da promoção —
  nunca um segundo método de cálculo. Persistida em
  `promocoes_analises.margem_normal_pct` e
  `ia_decisoes_promocoes.snapshot_margem_normal_pct` (auditável depois).
- **Regra aplicada como um filtro A MAIS, nunca no lugar do que já
  existia:** a IA continua respeitando a margem mínima configurável e a
  margem de conforto (já existentes); agora, além disso, só recomenda
  "entrar" numa promoção se a margem da promoção não cair mais que
  **3 pontos percentuais** abaixo da margem normal do produto — a
  tolerância pedida pelo usuário (constante
  `TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT = 3`). Vender por um preço MAIOR
  nunca é penalizado por essa regra (a margem só melhora nesse caso,
  exatamente como o usuário observou).
- O texto explicativo (`motivo`) mostrado ao usuário em cada recomendação
  agora cita a margem normal do produto e a tolerância de 3 pontos usada,
  inclusive quando é especificamente esse novo critério (e não a margem
  mínima) que reprovou o item.
- **Testado:** `test/promocoesMotor.test.js` (6 testes novos cobrindo a
  regra isoladamente + 1 teste de integração ajustado — um cenário que
  antes classificava como "oportunidade" corretamente passou a
  "não recomendado" porque a promoção derrubava a margem normal em 9,5
  pontos, acima da tolerância) e `test/promocoesDecisor.test.js`, 46/46
  passando.

## 2026-09-20 (47) — "Detalhe do Agente": ao clicar num agente de IA, ver o que ele está fazendo, o que tem pra aprovar, o que já fez e a melhora que teve
- **Contexto:** pedido explícito do usuário, no mesmo fio das entradas (45)
  e (46): "QUANDO CLICAR EM CIMA DO AGENTE DE IA, QUERO VER OQUE ELE ESTA
  FAZENDO, OQUE TENHO PRA APROVAR PRA ELE FAZER, OQEU ELE FEZ E A MELHORA
  QUE ELE TEVE NAQUILO QUE É PRA SER FEITO". Antes de construir, foram
  perguntadas duas decisões de escopo genuinamente ambíguas (ver
  `02-decisoes.md`): (1) construir pra 1 agente-modelo primeiro ou pra
  todos os 6 de uma vez — o usuário escolheu **todos os 6 de uma vez**;
  (2) o que "melhora" deveria significar pra Anúncios/Concorrente, que só
  observam e não têm decisão pra aprovar — o usuário escolheu **quantos
  alertas o agente resolveu com o tempo (últimos 30 dias)**.
- **`lib/ia/agenteDetalhe.js` (novo arquivo):** módulo único que monta as
  4 seções pra qualquer um dos 6 agentes reais cadastrados em `ia_agentes`
  (`ads_performance`, `promocoes`, `sac_mercado_livre`, `sac_shopee`,
  `anuncios_radar`, `concorrente`), reaproveitando ~100% de infraestrutura
  já existente, sem inventar nenhum mecanismo novo de acompanhamento:
  - **"O que está fazendo agora"** — status do scheduler de cada agente
    (`ativo`, `emExecucao`, `ultimaExecucaoEm`, `ultimoCicloOk`), lendo
    direto de `lib/adsScheduler.js`/`lib/ia/promocoesScheduler.js`/
    `radarScheduler.js`/`concorrenteScheduler.js`/`sacScheduler.js` — os
    mesmos módulos que já existiam, sem alteração neles.
  - **"O que tem pra aprovar"** — contagem de sugestões pendentes reais
    (`ia_decisoes_ads`/`ia_decisoes_promocoes`/`sac_respostas`, filtrados
    por empresa e, no caso do SAC, por marketplace). Anúncios/Concorrente
    não têm fluxo de aprovação (só observam), então retornam
    `temFluxoDeAprovacao:false` de forma explícita, em vez de fingir um
    número.
  - **"O que já fez"** — histórico de eventos real, agora filtrável por
    agente (ver correção em `agentesResumo.js` abaixo).
  - **"A melhora que teve"** — pra Ads/Promoções, usa o sistema de
    avaliação antes/depois que **já existia e já estava ativo**
    (`resultado_snapshot`/`resultado_avaliado_em` em
    `ia_decisoes_ads`/`ia_decisoes_promocoes`, calculado por
    `lib/ia/adsDecisoesCiclo.js#avaliarResultadosAds`), comparando a
    margem antes da decisão com a margem real medida dias depois — só
    nunca tinha sido exposto em nenhuma tela. Pra Anúncios/Concorrente/SAC
    (sem essa métrica financeira), conta quantos alertas/atendimentos
    foram resolvidos nos últimos 30 dias vs. quantos continuam em aberto
    agora, exatamente como o usuário pediu.
- **`lib/ia/agentesResumo.js` — correção de um bug real, pré-existente:**
  `listarHistorico` marcava **todo** alerta do Radar com
  `agente_codigo='radar'`, fixo — ou seja, mesmo antes deste pedido, já
  não dava pra saber, pelo histórico, quais alertas eram de Anúncios e
  quais eram de Concorrente. Corrigido pra: `categoria LIKE 'anuncio_%'`
  → `anuncios_radar`; `categoria = 'concorrente_ativo'` → `concorrente`;
  o resto (custo, estoque, financeiro, fluxo de caixa — que não têm um
  agente-dono dos 6 cadastrados) → um grupo neutro `radar_negocio`, nunca
  atribuído a um agente errado. A função também ganhou um 3º parâmetro
  opcional (`agenteCodigo`) pra filtrar o histórico por agente sem quebrar
  quem já chamava sem esse parâmetro.
- **`routes/iaAgentes.js`:** nova rota `GET
  /api/ia-agentes/:codigo/detalhe?empresaId=ID`, restrita aos 6 códigos
  reais (404 pra qualquer outro valor vindo da URL, nunca aceito direto
  numa query).
- **`public/index.html` — as DUAS telas de "agente" do sistema ganharam o
  detalhe** (o app tem duas: o hub "Agentes de IA" em cards, e a "Sala dos
  Agentes" 3D construída em 19/09/2026):
  - No hub (`AgentesIaHub`): clicar num card de agente real (exceto a "IA
    Gestora", que já abre o chat) abre um modal com as 4 seções. De
    quebra, corrigido outro bug pré-existente: `anuncios_radar` e
    `concorrente` não tinham entrada em `META_REAIS`, então o botão "Ver
    detalhes" desses dois cards não fazia nada ao ser clicado.
  - Na sala 3D (`SalaAgentes`): ao selecionar um personagem, o painel
    lateral ganhou as mesmas 4 seções (buscadas uma vez por seleção, não
    a cada atualização de 20s da sala). Como a sala tem só 1 personagem
    de "SAC" pra 2 agentes reais (Mercado Livre + Shopee), os dois
    detalhes são combinados nessa tela (soma pendentes, soma resolvidos,
    mistura e ordena o histórico) — é uma simplificação visual assumida,
    não uma perda de dado (cada um continua com detalhe próprio no hub).
- **Testado:** `test/agenteDetalhe.test.js` (novo, 13/13 passando — cobre
  os 6 agentes, isolamento por empresa e por marketplace, a correção do
  histórico de Anúncios/Concorrente, e os dois formatos de "melhora"
  incluindo um caso concreto de delta de margem). `test/especialistaSac`
  e `iaAgentesHub` seguem passando (27/27 no total dos 3 arquivos novos/
  tocados). Suíte completa do projeto rodada de novo: 578 passando, 0
  falha nova — as únicas suítes que falham são as mesmas 16 de
  instabilidade antiga do ambiente (stack trace de um `pg` de outro
  repositório), já documentadas em segmentos anteriores.
- **Pendente/honesto:** o agente "Criativo" continua não existindo (não
  mudou nesta entrega). O agente Anúncios/Radar continua sem uma página
  própria de aprovação (só observação) — o botão "Ver e decidir" do novo
  detalhe leva pra página de Radar já existente, não pra um fluxo de
  aprovação dedicado, porque esse fluxo dedicado não existe.

## 2026-09-20 (46) — SAC (Mercado Livre e Shopee) entra na Daily dos Agentes; horário do relatório mudado para 7h
- **Contexto:** pedido explícito do usuário, no mesmo fio da entrada (45):
  ele mandou um print de um vídeo mostrando "Múltiplos Agentes IA no
  Mercado Livre" (Analista, Criativo, Gestor, Anúncios, Ads, SAC) e
  perguntou se o sistema já funciona assim (só conversar com o "Gestor",
  que repassa pros outros); junto, pediu pra ativar hoje o relatório
  diário às 7h da manhã. Confirmado a ele, em resposta separada no chat,
  o que já existe de verdade (Ads, Promoções, Anúncios/Radar, Análise de
  Concorrente = "Analista", e agora SAC) e o que não existe ainda
  (nenhum agente "Criativo"). Ele confirmou: incluir o SAC agora no
  relatório diário.
- **`lib/ia/especialistaSacComum.js` (novo arquivo):** lógica compartilhada
  dos dois especialistas de SAC pra Daily — lê exclusivamente
  `sac_atendimentos`/`sac_respostas` (nunca gera sugestão nova aqui, isso já
  é feito pelo ciclo próprio do SAC, `lib/ia/sacCiclo.js`/
  `lib/ia/sacRespostaIa.js`). Critério de classificação: atendimento com a
  flag `urgente` vira achado tipo "problema"/prioridade "alta"; reclamação,
  insatisfação, problema de entrega ou devolução viram "problema"/"média";
  o resto (dúvida simples, pergunta pré-venda) vira "risco"/"baixa" — não é
  um problema em si, mas demorar pra responder pode custar a venda.
  `decisaoTabela`/`decisaoId` apontam pra `sac_respostas`, então cada achado
  já nasce ligado à sugestão real que dá pra aprovar/editar/recusar.
- **`lib/ia/especialistaSacMercadoLivre.js`/`especialistaSacShopee.js`
  (novos arquivos):** wrappers finos sobre o módulo comum, um por
  marketplace — mesmo padrão de agente-por-arquivo já usado pelos outros
  4 especialistas.
- **`lib/ia/especialistas.js`:** os dois novos especialistas entram no
  array `ESPECIALISTAS` — nenhum outro arquivo da Daily precisou saber
  nada específico deles (exatamente como o comentário do arquivo já
  previa).
- **`lib/ia/dailyCiclo.js`:** mensagem de WhatsApp "nenhum achado hoje"
  atualizada pra citar também o SAC na lista de agentes (antes citava só
  Ads/Promoções/Anúncios/Concorrente).
- **Horário do relatório diário mudado de 9h para 7h (Brasília):**
  alterada a variável de ambiente `DAILY_HORA_ENVIO` diretamente no
  serviço do Render, com autorização explícita do usuário — nenhum outro
  código mudou (a hora já era configurável desde a etapa anterior, só
  nunca tinha sido ajustada). Isso não substitui o usuário aplicar os
  arquivos deste zip no repositório: a mudança de horário já está em
  produção, mas o SAC na Daily só passa a valer depois do deploy deste
  zip.
- **Testado:** `test/especialistaSac.test.js` (novo, 8/8 passando —
  cobre urgência, classificação, isolamento por marketplace, sugestão já
  decidida nunca reaparece, e o vínculo achado→`sac_respostas`).
  Regressão direcionada (especialistaAnunciosEConcorrente, dailyCiclo,
  dailyScheduler, dailyRoutes, sacScheduler): 40/40 passando. Suíte
  completa do projeto rodada de novo: mesmo resultado de sempre, sem
  nenhuma suíte nova quebrando (as falhas que aparecem são as mesmas 16
  suítes de instabilidade antiga do ambiente, já documentadas, sem
  relação com este código).
- **Pendente/honesto:** o agente "Criativo" (do vídeo que o usuário
  mostrou) não existe — nenhuma IA aqui gera texto/imagem de anúncio
  hoje. Fica pra quando o usuário definir o que exatamente esse agente
  deveria fazer.

## 2026-09-20 (45) — Agentes IA de Ads e Performance passam a EXECUTAR de verdade no Mercado Livre quando o usuário aprova ("Fase E")
- **Contexto:** pedido explícito do usuário, em uma mensagem que trazia três
  pontos: (1) dúvida sobre como o alerta por WhatsApp vai funcionar na
  prática; (2) confirmação de que a Análise de Concorrente deve buscar
  pelos próprios anúncios/modelos dele (ex.: caixa 16x11x6) e não depender
  do catálogo do Mercado Livre, já que caixa personalizada não é item de
  catálogo; (3) o pedido principal: "as ia elas não vão fazer sozinho mas
  eu sou vou aprovar [e] aí vai fazer... por enquanto só vai precisar da
  minha permissão, tem que mudar as configurações do developers pois lá só
  está como leitura". Perguntado qual área (Concorrente/Ads/Promoções)
  deveria ganhar execução real primeiro, o usuário escolheu Ads: "Ads tem
  que analisar todas as métricas dês do roas a acos, tacos e orçamento por
  campanha, tudo que tem de métrica" — métricas essas que já existiam
  (ver abaixo). Os itens (1) e (2) não exigiram mudança de código (ver
  observações no final desta entrada); o item (3) é o conteúdo desta
  entrada.
- **Arquitetura de segurança (duas travas independentes, nenhuma nova —
  reaproveitadas de scaffolding já existente desde 14/09/2026 para
  Promoções e nunca ativada):** (1) uma trava manual por empresa,
  `config_ads_ia.permite_escrita_ml` (BOOLEAN, `DEFAULT false`) — só liga
  depois que o usuário confirmar permissão de escrita no app do Mercado
  Livre Developers e reconectar a conta no ERP (um token emitido como
  leitura não vira escrita sozinho); (2) o catálogo já existente
  `ia_permissoes_acao.nivel_permissao`, por tipo de ação
  (`recommend_only`/`approval_required`/`auto_execute`) — todas as ações de
  Ads pré-cadastradas como `approval_required`, exceto
  `colocar_sku_em_campanha` (`recommend_only`, permanece só recomendação
  porque o ERP não tem como saber sozinho em qual campanha colocar um
  SKU). O `escopo_oauth` devolvido pelo Mercado Livre (ex.: "offline_access
  read write") é usado só como **informativo/diagnóstico** na tela — nunca
  como fonte de verdade — seguindo o mesmo princípio já documentado em
  `lib/mlPermissoes.js` para Promoções.
- **`db/schema.sql` (migração idempotente, já aplicada):**
  `ALTER TABLE config_ads_ia ADD COLUMN permite_escrita_ml BOOLEAN NOT NULL
  DEFAULT false`. Em `ia_decisoes_ads`, as colunas `executado`/
  `executado_em` já existiam desde 14/09/2026 mas nunca tinham sido
  preenchidas por nenhum código (eram para uma confirmação manual que
  nunca ganhou tela) — passam a ter significado real: `true` quando o
  próprio ERP executou a ação com sucesso via API do Mercado Livre.
  Adicionadas `execucao_erro TEXT` e `execucao_resposta JSONB` para
  guardar sempre uma explicação honesta (motivo da não-execução, ou erro
  real da API) e a resposta crua do Mercado Livre quando executa.
- **`lib/mercadolivre.js`:** nova função `apiPut` (primeira função de
  escrita deste arquivo — só existiam leituras até aqui).
- **`lib/mlAds.js`:** nova função `atualizarCampanha({accessToken, siteId,
  campanhaId, budget, status})`, usando o endpoint real e documentado `PUT
  /marketplace/advertising/{site_id}/product_ads/campaigns/{campanha_id}`
  (confirmado na documentação oficial do Mercado Livre, ver Fontes),
  headers `Authorization: Bearer` + `Api-Version: 2`.
- **`lib/mlPermissoes.js`:** generalizado — `statusIntegracaoPromocoes`
  virou um wrapper fino de uma nova função genérica
  `statusIntegracaoAgente(...)`, e criado o wrapper equivalente
  `statusIntegracaoAds(...)`. Nenhuma mensagem/comportamento de Promoções
  mudou (testes antigos de `mlPermissoes.test.js` continuam passando sem
  alteração).
- **`lib/ia/adsExecutor.js` (novo arquivo):** função central
  `executarDecisaoAprovada(decisaoId)` — **nunca lança exceção**: sempre
  devolve `{executado, motivo?, erro?}` e sempre grava uma explicação
  honesta em `execucao_erro` para todo caso de não-execução (trava manual
  desligada, tipo de ação não executável, conta/token/site_id ausente,
  erro real da API do Mercado Livre). Cobre 4 ações executáveis:
  `pausar_campanha`, `ativar_campanha`, `aumentar_orcamento`,
  `diminuir_orcamento`. A aprovação de uma decisão **nunca falha** por
  causa de um problema na execução real — são duas etapas
  independentes.
- **`routes/ads.js`:** `GET/PUT /config-ia` ganham o campo
  `permiteEscritaMl`; nova rota `GET /status-integracao` (status por conta
  ML + resumo da empresa); `PUT /decisoes/:id` — quando o novo status é
  `aprovada` ou `alterada`, chama `executarDecisaoAprovada` na hora e
  devolve na mesma resposta HTTP o resultado já atualizado (`executado`,
  `executadoEm`, `execucaoErro`); `recusada` nunca tenta executar nada.
- **`public/index.html` (módulo Agentes IA — Ads e Performance):** novo
  card "Permitir que a IA execute de verdade" (checkbox, desligado por
  padrão) com status por conta conectada (mostra se o escopo sugere
  escrita e se a trava manual está ligada); histórico de decisões passa a
  mostrar, quando aplicável, se a ação foi executada de verdade, quando, e
  o motivo quando não foi. **Promoções não foi tocada** — o módulo
  compartilhado só liga esse comportamento quando o agente declara
  `execucao` na configuração, e `AgentePromocoes` continua sem essa chave
  (confirmado lendo o código-fonte diretamente, sem nenhuma mudança
  visual/funcional lá).
- **Testado:** `test/adsExecutor.test.js` (novo, 9/9 passando — cobre
  cada uma das 4 ações, trava manual desligada, tipo de ação não
  executável, conta sem site_id, erro real da API mockado) e
  `test/adsRotasExecucao.test.js` (novo, 7/7 passando — HTTP real com
  Express + Postgres real, chamada ao Mercado Livre sempre mockada).
  Regressão direcionada rodada em seguida (`ads.test.js`,
  `adsScheduler.test.js`, `mlPermissoes.test.js`, `mlAds.test.js`,
  `iaAgentesHub.test.js`, `dailyCiclo.test.js`, `agentes3d.test.js`):
  **73/73 passando, 0 falhas** (as 4 suítes que aparecem canceladas nesse
  lote são uma flakiness antiga do ambiente de sandbox, sem relação com
  este código — o stack trace aponta pra um caminho de outro projeto,
  `/home/claude/erp-ecommerce/...`). Verificado também visualmente via
  navegador (Playwright) contra Postgres real: checkbox liga/desliga de
  verdade, tentativa real de chamada à API do Mercado Livre (rede do
  sandbox bloqueada) falha e é registrada honestamente em
  `execucao_erro`, sem quebrar a aprovação.
- **Fora do escopo desta etapa (recomendação apenas, disclosure
  intencional):** `pausar_anuncio` (pausar um anúncio individual dentro de
  uma campanha) — o endpoint de pausa por item ainda não foi pesquisado/
  integrado; `colocar_sku_em_campanha` — o ERP não decide sozinho em qual
  campanha colocar o SKU. Execução real para Análise de Concorrente e
  Promoções também não entrou nesta etapa (o usuário priorizou Ads).
  **Nada disto foi testado contra a API real do Mercado Livre** (o sandbox
  de desenvolvimento bloqueia a rede para `api.mercadolibre.com`) — só
  contra mocks e contra uma tentativa real que falhou do jeito esperado
  (rede bloqueada). O comportamento definitivo só é confirmado depois do
  deploy.
- **Sobre os outros dois pontos da mensagem do usuário (sem mudança de
  código, só confirmação/explicação):** WhatsApp já está com todo o código
  pronto desde uma etapa anterior (`lib/whatsapp.js`/`routes/whatsapp.js`,
  via Twilio) — falta só o usuário criar a conta Twilio e configurar as
  variáveis de ambiente no Render, algo que a IA não pode fazer por ele
  (credenciais nunca são inseridas por automação). A Análise de
  Concorrente (`lib/concorrente.js`) já busca por título/modelo do próprio
  anúncio sempre que não há correspondência de catálogo — exatamente o
  pedido do usuário — nenhum código precisou mudar.
- **Fontes consultadas para o endpoint de escrita de campanhas:**
  documentação oficial do Mercado Livre, Product Ads API
  (global-selling.mercadolibre.com/devsite/new-product-ads).

## 2026-08-27 (44) — ETAPA 3: REALIZADO do Fluxo de Caixa passa a vir do extrato bancário, saldo por conta, transferências internas
- **Contexto:** aprovado pelo usuário depois de uma revisão técnica prévia
  (perguntas A-L + diagrama, entregues no chat) e de uma especificação
  detalhada de 22 pontos com decisões exatas de modelagem, semântica do
  saldo inicial e 14 cenários de teste obrigatórios. Mudança de
  arquitetura: o REALIZADO do Fluxo de Caixa deixa de vir de
  `contas_pagar.status='pago'`/`contas_receber.status='recebido'`/
  `recebimentos_marketplace` e passa a vir **sempre** de
  `extrato_movimentos` (dinheiro que passou de verdade pelo banco,
  conciliado ou não). Essas três fontes continuam existindo e continuam
  importantes — só que exclusivamente para o PREVISTO e para
  conciliação/comparação, nunca mais para o realizado. **A DRE não foi
  tocada** (ponto 21 do pedido) — mudança exclusiva do Fluxo de Caixa.
- **`server/db/schema.sql`:** nova tabela
  `fluxo_caixa_saldo_inicial_conta` (saldo inicial POR conta bancária,
  `UNIQUE(conta_bancaria_id)`) — a tabela antiga `fluxo_caixa_saldo_inicial`
  (só por empresa) foi **preservada intacta**, nunca mais lida pela
  fórmula nova, só como histórico/legado. `extrato_movimentos` ganhou
  `categoria` e `transferencia_par_id` (suporte a transferência interna
  entre contas da própria empresa) e um índice em
  `(conta_bancaria_id, data)`.
- **`server/lib/fluxoCaixa.js` (reescrito):** REALIZADO e PREVISTO agora
  são fontes DISJUNTAS por construção — nunca a mesma query, nunca risco
  de somar os dois. Novas funções: `buscarSaldoInicialConta`/
  `definirSaldoInicialConta` (por conta), `saldoContaEm` (saldo de uma
  conta num dia — ver semântica abaixo), `saldosPorContaEDaEmpresaEm`
  (lista por conta + consolidado, nunca inventa soma parcial),
  `realizadoPorDia` (soma diária do extrato — a única fonte do realizado,
  nunca filtra por status de conciliação), `transferenciasInternasNoPeriodo`
  e `classificarComoTransferenciaInterna` (classificação SEMPRE manual —
  nenhuma detecção automática por valor/data existe nesta etapa, só o
  suporte de modelagem pedido). `gerarFluxoDeCaixa` ganhou o parâmetro
  opcional `contaBancariaId` (escopa realizado/saldo a uma conta; o
  previsto continua sempre em nível de empresa — `contas_pagar`/
  `contas_receber` não têm coluna de conta bancária hoje, ver riscos).
- **`server/routes/fluxoCaixa.js`:** novas rotas `POST`/`GET
  /saldo-inicial-conta` e `POST /transferencia-interna`; `GET /` passa a
  aceitar `contaBancariaId` opcional. As rotas legadas `/saldo-inicial`
  continuam funcionando (histórico).
- **`server/public/index.html` (módulo `window.FluxoCaixa`):** cards
  reorganizados (Saldo atual, Entradas realizadas, Saídas realizadas,
  Resultado realizado, A receber, A pagar, Saldo projetado, Contas
  vencidas, e Transferências internas quando há alguma no período — nunca
  infla entradas/saídas realizadas). Nova seção "Saldo por conta bancária"
  (lista cada conta ativa com saldo inicial/atual, e um botão de editar por
  linha). Modal "Definir saldo inicial" reescrito: agora sempre pede a
  conta bancária (troca de conta recarrega o formulário com o que já
  estava salvo pra ela) e grava em `/saldo-inicial-conta`. Uma conta ativa
  sem saldo inicial faz o consolidado da empresa aparecer como "Configure o
  saldo inicial das contas bancárias" — nunca um número inventado —
  enquanto entradas/saídas/previsto continuam sempre calculáveis.
- **Testado (Postgres local, `node --test`):** 15 testes automatizados
  dedicados (`server/test/fluxoCaixa.test.js`, empresa de teste 975) cobrindo
  os 14 cenários pedidos — resultado completo na entrega feita no chat
  (migrações, exemplos por conta/consolidado, prova de não duplicidade,
  riscos). Suíte completa do projeto: **392/392 passando, 0 falhas**
  (nenhuma regressão). Durante os testes foram corrigidos dois bugs nos
  próprios testes (não no código de produção): uma ordem de `DELETE` que
  violava FK na limpeza de uma suíte antiga, e contas bancárias
  compartilhadas entre testes numerados que contaminavam valores absolutos
  esperados — corrigido isolando cada teste numérico em sua própria conta
  bancária dedicada, sempre inativada ao final para não vazar no
  consolidado de outros testes.
- **Pendente de aprovação explícita do usuário antes de iniciar (ETAPA
  4):** importação de boletos/contas a pagar via CSV/XLSX.

## 2026-08-27 (43) — Fluxo de Caixa travado em "Carregando..." — diagnóstico + ETAPA 2 (correção do carregamento infinito + seleção de conta)
- **Contexto:** bug relatado pelo usuário após importar um extrato real do
  Nubank (45 movimentos) — a tela de Fluxo de Caixa ficava presa pra
  sempre em "Carregando fluxo de caixa...". Investigação completa (código
  + reprodução ao vivo contra Postgres local, sem alterar nenhum dado)
  entregue no chat antes desta etapa — nenhum código foi alterado durante
  o diagnóstico. Resultado: **não foi possível reproduzir uma exceção**
  isolando o cenário exato (45 movimentos sintéticos, sem saldo inicial,
  Nubank+Mercado Pago) — `gerarFluxoDeCaixa()` respondeu normalmente. A
  hipótese líder (não 100% confirmada — sem os logs do momento real da
  falha) é exaustão do pool de conexões (`db/pool.js` nunca teve nenhum
  timeout, e o ERP tem 5 rotinas em background — sync do Mercado Livre,
  Ads, despesas fixas, radar da IA, renovação Shopee — compartilhando o
  mesmo pool) somada a uma UI que nunca tinha um limite de tempo pra
  requisição nem blindagem contra exceção na hora de montar o HTML — ou
  seja, qualquer travamento (por exaustão do pool ou qualquer outra causa
  futura) nunca aparecia como erro pro usuário, só como "Carregando..."
  pra sempre. Aprovado pelo usuário: corrigir o sintoma agora (nunca mais
  permitir tela travada, seja qual for a causa) mantendo a causa raiz como
  hipótese até ter observabilidade real em produção.
- **`server/db/pool.js`:** adicionados timeouts que não existiam
  (`connectionTimeoutMillis: 8s`, `statement_timeout`/`query_timeout: 15s`,
  `max: 10`, `idleTimeoutMillis: 30s`) e um listener de erro no pool (pra
  um client ocioso com problema nunca mais derrubar o processo inteiro).
- **`server.js`:** handler de erro central agora loga, de forma
  estruturada (JSON: endpoint, query — onde já vêm empresaId/
  contaBancariaId/período nas rotas GET do financeiro —, mensagem, stack),
  todo erro 500 — sem nunca expor esse detalhe pro cliente (resposta
  continua genérica). Adicionado `process.on('unhandledRejection'/
  'uncaughtException')` só pra logar (nunca silenciar) — uma promise sem
  `.catch` em qualquer lugar do sistema podia derrubar o processo Node
  inteiro e travar TODAS as requisições em andamento, não só o Fluxo de
  Caixa.
- **`public/index.html` (módulo `window.FluxoCaixa`):** toda chamada
  `fetch` (fluxo, extrato, conciliação, contas bancárias) agora tem
  timeout de 20s via `AbortController` — se o servidor nunca responder, a
  tela sai do "Carregando..." sozinha com uma mensagem clara em vez de
  travar pra sempre (testado isoladamente contra um servidor que nunca
  responde: aborta em ~800ms com timeout de teste reduzido, mensagem
  correta). `render()` agora tem `try/catch` ao redor da montagem do HTML
  com dados (cards/fórmula/gráfico/tabela) e da seção de extrato/
  conciliação — nunca mais deixa `root.innerHTML` travado no esqueleto de
  loading anterior por causa de uma exceção de template; sempre cai numa
  tela de erro amigável (loga o detalhe real só no console, nunca esconde
  do desenvolvedor).
- **Seleção padrão de conta bancária corrigida (Nubank/Mercado Pago —
  item G do diagnóstico):** a causa raiz era `carregarContasBancarias()`
  sempre escolher `contas[0].id` de uma lista ordenada alfabeticamente por
  `lib/contasBancarias.js` — como "Mercado Pago..." vem antes de
  "Nubank..." no alfabeto, o seletor de conciliação voltava pra Mercado
  Pago a cada recarregamento da página, mesmo acabando de importar pro
  Nubank (nunca foi mistura de dado entre contas — todas as queries já
  eram corretamente filtradas por `conta_bancaria_id`). Nova prioridade,
  nunca mais alfabética: 1) conta já selecionada nesta sessão; 2) última
  conta escolhida por este usuário neste navegador (`localStorage`,
  sobrevive a recarregar a página); 3) conta da importação de extrato mais
  recente (`extrato_importacoes` já vem `ORDER BY created_at DESC`); 4)
  só na ausência de tudo isso, a primeira da lista. Testado isoladamente
  com os dados reais do cenário (Mercado Pago cadastrado primeiro, import
  feito no Nubank depois): a lógica antiga escolheria Mercado Pago
  (`contas[0]`); a nova escolhe corretamente o Nubank.
- **Testado:** checagem de sintaxe do `<script>` inline completo; servidor
  local subiu normal com os novos timeouts (guarda defensiva pro `pool.on`
  — o stub de teste `pg` deste ambiente de desenvolvimento não implementa
  eventos, só o driver real usado em produção); regressão manual via curl
  em `GET /api/fluxo-caixa`, `/api/contas-bancarias`, `/api/extrato/
  importacoes` (200 OK, formato inalterado); erro proposital
  (`empresaId=abc`) devolveu 500 genérico em ~3ms, log estruturado correto
  no servidor, servidor continuou respondendo normalmente depois.
- **Não validado nesta etapa:** os 45 movimentos REAIS do usuário — esta
  sessão não tem acesso ao banco de produção, só ao Postgres local de
  desenvolvimento. Query de validação (somente leitura) entregue no chat
  para ser rodada com acesso real.
- **Pendente de aprovação explícita do usuário antes de iniciar (ETAPA
  3):** mudar a arquitetura do REALIZADO do Fluxo de Caixa para vir de
  `extrato_movimentos` em vez de só `contas_pagar`/`contas_receber` — ver
  revisão técnica (perguntas A-L) entregue no chat.

## 2026-08-27 (42) — Camada de contexto de negócio + raio-X da empresa + identificar_produto_fisico (Etapa (b) da proposta de contexto de negócio da IA)
- **Contexto:** segunda etapa aprovada de
  `docs/PROPOSTA-contexto-negocio-ia-gestora.md` ("pode seguir", na
  sequência da etapa (a) — ver `(41)` acima). Ordem: (a) mapa de produtos
  ✅; **(b) camada de contexto + raio-X + identificar_produto_fisico ✅
  (esta entrada)**; (c) regras de negócio; (d) tarefas ligadas ao Radar;
  (e) WhatsApp, só depois do usuário escolher o provedor.
- **Princípio seguido à risca (ponto 2 da proposta — "compor, não
  recriar"):** nenhum arquivo desta etapa calcula um número novo. Tudo é
  casca fina sobre módulos já existentes e já validados
  (`lib/visaoGeralPainel.js`, `lib/recebimentosMl.js`,
  `produtos_base`/`produto_base_aliases` da etapa (a)).
- **`server/lib/mapaProdutos.js` (novo, fora de `lib/ia/` — convenção de
  nomes já aprovada, ponto 1 da proposta):** `identificarProdutoFisico(empresaId,
  textoLivre)` — resolve um texto livre ("a caixa 20x20x20", um código, um
  apelido) num produto físico cadastrado, numa cascata de 4 camadas
  (código exato → apelido exato → medida exata → busca aproximada),
  **nunca escolhendo sozinha entre candidatos**: devolve sempre um de 3
  status — `identificado` (exatamente 1 resultado), `ambiguo` (mais de um
  — a IA deve perguntar ao usuário, nunca supor) ou `nao_encontrado`.
  Empresa sempre isolada (nunca vaza produto de uma empresa pra outra).
- **`server/lib/ia/contextoNegocio.js` (novo, dentro de `lib/ia/` — é uma
  composição pensada especificamente pro formato que a IA consome):**
  `montarRaioXEmpresa({empresaId, periodoChave})` — junta
  `painelVisaoGeral` (mesma fonte da tela Visão Geral: vendas por canal,
  fluxo de caixa, conexões, alertas, Radar) com
  `recebimentosMl.resumoRecebimentosMarketplace` (detalhe por status —
  a_receber/disponível/recebido). Nunca quebra se o Radar falhar (mesma
  disciplina já usada por `painelVisaoGeral`).
- **`server/lib/ia/ferramentas.js`:** 2 ferramentas novas, ADITIVAS,
  SOMENTE LEITURA — `identificar_produto_fisico` (casca sobre
  `lib/mapaProdutos.js`) e `visao_geral_empresa` (casca sobre
  `lib/ia/contextoNegocio.js`, pensada pra perguntas gerais/abertas como
  "como está o negócio" numa única chamada, em vez de encadear 4-5
  ferramentas). Nenhuma ferramenta já existente foi alterada.
- **"Produto em foco" — contexto entre perguntas da mesma conversa (ponto
  2.6 da proposta):** quando `identificar_produto_fisico` resolve com
  CERTEZA (`identificado`), o produto vira o "foco" da conversa — guardado
  em `ia_conversas.contexto_ativo` (coluna `JSONB` nova,
  `db/schema.sql`) e devolvido pra IA na próxima pergunta via uma linha
  extra no system prompt (`lib/ia/orchestrator.js#linhaProdutoEmFoco`),
  pra ela entender "e desse produto, quanto vendi essa semana?" sem o
  usuário repetir o nome. Nunca atualizado por um resultado `ambiguo`;
  nunca apagado por uma pergunta que não tocou no assunto. Implementado
  com o menor footprint possível: sem loop novo, sem tabela nova além da
  1 coluna — só uma variável rastreada inline no laço de ferramentas já
  existente (`produtoEmFocoAtual`) e 2 pontos de leitura/escrita que
  `routes/iaGestora.js` já tocava (a mesma consulta que busca a conversa;
  o mesmo UPDATE que já atualizava `atualizado_em`).
- **`lib/ia/orchestrator.js`:** `HISTORICO_MAX_MENSAGENS` 8 → 12 (uma
  conversa de acompanhamento sobre o mesmo produto tende a durar mais
  rodadas; ainda cabe folgadamente no que `routes/iaGestora.js` já busca
  do banco, 20 — nenhuma mudança lá foi necessária). `responderPergunta`
  ganhou o parâmetro `contextoAtivo` (opcional) e todo retorno (sucesso,
  não configurada, limite de rodadas, erro do provedor) agora inclui
  `produtoEmFoco`.
- **`routes/iaGestora.js`:** `buscarConversaDoUsuario` passou a trazer
  `contexto_ativo`; `POST /perguntar` lê esse valor e passa como
  `contextoAtivo` pra `responderPergunta` (só quando já existe uma
  conversa — nunca lido do corpo da requisição, mesma disciplina já usada
  pro histórico) e grava de volta `resultado.produtoEmFoco` quando ele vier
  preenchido.
- **Testes novos:** `test/mapaProdutos.test.js` (8 casos — as 4 camadas,
  ambiguidade em cada uma delas, texto vazio, isolamento entre empresas);
  extensão de `test/iaFerramentas.test.js` (5 casos — as 2 ferramentas
  novas, incluindo comparação número a número de `visao_geral_empresa`
  contra `painelVisaoGeral`/`resumoRecebimentosMarketplace`); extensão de
  `test/iaOrchestrator.test.js` (5 casos — rastreamento de "produto em
  foco", preservação entre perguntas, linha no system prompt). Suíte
  completa: **386/386** (368 da etapa (a) + 18 novos).
- Um bug real encontrado e corrigido durante os testes: a query de
  `identificarProdutoFisico` por apelido fazia `JOIN` entre
  `produtos_base`/`produto_base_aliases` (ambas têm coluna `id`) sem
  qualificar as colunas do `SELECT` — Postgres real rejeita isso com
  "column reference id is ambiguous" (não é um problema do stub de dev,
  teria quebrado em produção também). Corrigido qualificando todas as
  colunas com `pb.` nas duas queries que fazem `JOIN`.
- Verificação manual: servidor sobe normalmente com a migração nova
  (`ia_conversas.contexto_ativo`); as duas ferramentas novas testadas
  diretamente contra o banco de desenvolvimento real (empresa 900, dados
  reais) via script pontual — devolveram dado real, sem erro.

## 2026-08-27 (41) — Mapa de Produtos: medida/categoria/aliases + tela de gestão (Etapa (a) da proposta de contexto de negócio da IA)
- **Contexto:** primeira etapa aprovada de
  `docs/PROPOSTA-contexto-negocio-ia-gestora.md` (arquitetura de "IA
  Gestora que conhece o negócio", apresentada em 27/08/2026 e aprovada
  pelo usuário na sequência — "vamos seguir sua orientação pode
  prosseguir"). Ordem de implementação escolhida (recomendação própria,
  aprovada): (a) mapa de produtos + aliases + tela; (b) camada de
  contexto + raio-X + ferramenta de identificação de produto; (c) regras
  de negócio; (d) tarefas ligadas ao Radar; (e) WhatsApp, só depois do
  usuário escolher o provedor. Esta entrada cobre só a etapa (a).
- **Gap corrigido:** `produtos_base`/`produto_base_skus` já tinham uma API
  REST completa (`routes/produtosBase.js`) mas nenhuma tela consumia essa
  API (confirmado por grep em `public/index.html` antes de começar) — só
  era possível cadastrar/corrigir o vínculo SKU → produto físico via
  chamada HTTP manual. Essa etapa fecha esse gap.
- **Schema (`db/schema.sql`):** `produtos_base` ganhou `medida VARCHAR(100)`
  e `categoria VARCHAR(100)` (ambos opcionais, texto livre — mesmo padrão
  já usado em `contas_pagar.categoria`). Tabela nova
  `produto_base_aliases` (`id, empresa_id, produto_base_id, alias,
  origem 'manual'|'ia_sugerido', created_at`, `UNIQUE (empresa_id,
  alias)`, `ON DELETE CASCADE` em `produto_base_id`) — apelidos em
  linguagem natural para um produto físico ("aquela 16x11x6", "caixa
  pequena"); pré-requisito para a futura ferramenta de IA
  `identificar_produto_fisico` (etapa (b), ainda não implementada) —
  nesta etapa é só CRUD manual pela tela, a IA não grava aqui ainda.
- **Backend (`server/routes/produtosBase.js` estendido):**
  `medida`/`categoria` no `POST /`/`PUT /:id` e no `serializeProdutoBase`;
  `GET /` passou a buscar também por medida (`search`); `GET
  /categorias-sugeridas` (novo — categorias já usadas por esta empresa,
  distinct, para autocompletar a tela); CRUD completo de apelidos: `GET
  /aliases` (filtra por `produtoBaseId`/`search`), `POST /aliases`
  (aceita `produtoBaseId` existente ou `codigoProdutoBase` pra criar o
  produto base na hora, mesmo padrão já usado em `POST /vinculos`), `PUT
  /aliases/:id`, `DELETE /aliases/:id`.
- **Bug de roteamento descoberto e corrigido (`server/server.js`):** o
  `express` "-stub" deste ambiente de desenvolvimento faz correspondência
  de prefixo por STRING pura em `app.use(caminho, ...)`, sem checar limite
  de segmento — uma chamada a `/api/produtos-base/categorias-sugeridas`
  (e, na prática, qualquer chamada a `/api/produtos-base` sem subcaminho)
  caía no router errado (montado em `/api/produtos`, registrado antes)
  quando o texto do caminho batia por prefixo simples (`'produtos-base'`
  começa com `'produtos'`) — confirmado ao vivo, com o log mostrando
  `SELECT * FROM produtos WHERE id = '-base'`. **Não afeta produção** (o
  Express real resolve por segmento de caminho, não por string) — mesma
  categoria do já documentado stub de `pg` que não preenche `rowCount`
  (ver `docs/05-problemas-conhecidos.md`). Corrigido registrando os
  prefixos mais específicos (`/api/produtos-base`, `/api/estoque-full`,
  `/api/estoque-produto-base`) antes dos mais genéricos
  (`/api/produtos`, `/api/estoque`) em `server.js` — inofensivo em
  qualquer versão do Express, blinda o ambiente de dev. Coberto por um
  teste de regressão dedicado (ver abaixo).
- **Frontend (`server/public/index.html`):** página nova "Mapa de
  Produtos" (Cadastros, ícone de vínculo), módulo `window.MapaProdutos`
  com 3 sub-abas: **Produtos físicos** (tabela com código/nome/medida/
  categoria/custo/apelidos/status, modal de criar/editar, ativar/
  desativar); **Vínculos de SKU** (tabela de vínculos já salvos + painel
  de "SKUs vendidos sem vínculo" com sugestão automática vinda de vendas
  reais — botão "Aceitar" grava direto, botão "Vincular" abre o modal
  pré-preenchido — mesma lógica de `resolverProdutosBasePorSku`, só
  exposta numa tela agora); **Apelidos** (lista com filtro por produto e
  busca, modal de criar/editar/remover). Reaproveita 100% os componentes
  visuais já existentes (`.seg`, `.data-table`, `.modal-*`, `.toast`) —
  nenhum componente novo de CSS.
- **Testes:** `test/produtosBase.test.js` (novo, 17 casos, sobe servidor
  HTTP real com os routers `produtos`+`produtos-base` **na mesma ordem
  corrigida de `server.js`** de propósito — é um teste de regressão para
  o bug de roteamento acima, não só um teste de CRUD). Suíte completa:
  368/368 (era 351/351 antes desta etapa).
- **Fora do escopo desta etapa (fica pra (b)/(c)):** ferramenta de IA
  `identificar_produto_fisico`, a IA gravar alias sugerido (`ia_sugerido`)
  sozinha, camada de contexto de negócio, regras de negócio declaradas,
  raio-X da empresa, tarefas, WhatsApp.

## 2026-08-27 (40) — Recebimentos + Fluxo de Caixa + IA Gestora (importação de extrato e conciliação)
- **Pedido do usuário, em 3 passos, restrito a este escopo:** (1) organizar
  os recebimentos dos marketplaces em status financeiros claros, pra a IA
  conseguir responder "quanto já recebi"/"quanto ainda tenho pra receber";
  (2) importar semanalmente o extrato bancário (XLSX/CSV) no Fluxo de
  Caixa, com prévia, deduplicação garantida e conciliação (sugestão, nunca
  automática) contra recebimentos de marketplace/contas a receber/contas a
  pagar, sem nunca contar previsto+realizado ao mesmo tempo; (3) dar essa
  informação pra IA Gestora, só leitura. Nenhum outro módulo foi alterado.

### Passo 1 — Recebimentos dos marketplaces
- **Tabela nova `recebimentos_marketplace`** (`db/schema.sql`) — antes os
  recebimentos eram calculados na hora, sem nenhuma linha própria no
  banco; agora são persistidos (upsert, nunca duplica — identidade única
  por empresa+marketplace+referência externa), com 3 status bem
  separados: `a_receber`, `disponivel`, `recebido` (nunca chama de
  "recebido no banco" só porque o marketplace marcou como liberado). FKs
  `conta_ml_id`/`pedido_id` deliberadamente `ON DELETE SET NULL` (não
  CASCADE) — são vínculos supletivos, não a identidade da linha; CASCADE
  apagaria conciliação já confirmada num reseed/exclusão de pedido.
- **`server/lib/recebimentosMl.js` reescrito.** `materializarRecebimentos`
  faz upsert dos pedidos elegíveis dos últimos 400 dias a cada leitura
  (nunca sobrescreve status/datas efetivas/valor recebido já confirmados).
  Funções novas: `listarRecebimentosMl` (lista persistida, substitui o
  cálculo na hora), `listarRecebimentosMlRecebidosNoPeriodo` (usada pelo
  Fluxo de Caixa pra jogar o valor no bucket certo do dia), `resumo
  RecebimentosMarketplace` (recebido hoje/mês, a receber total/atrasado/7/
  15/30 dias, sem previsão de liberação, por marketplace, por loja —
  sempre atual, independe do período do cabeçalho), `marcarComoDisponivel`
  /`marcarComoRecebido`/`definirPrevisaoLiberacao` (ações manuais, sempre
  avançando o status, nunca voltando) e `marcarComoRecebidoPorConciliacao`
  (usada só pela conciliação bancária do Passo 2). Função pura legada
  `serializeRecebimento` preservada intocada (ainda usada por
  `visaoGeralPainel.js#resumoRecebimentos`, que alimenta a ferramenta JÁ
  VALIDADA da IA `fluxo_de_caixa`) — **bug encontrado e corrigido:**
  `serializeRecebimento` estava definida mas não exportada, o que quebrava
  essa cadeia inteira (só apareceu ao rodar a suíte completa, não só os
  testes da área nova).
- **`server/routes/recebimentos.js`:** `GET /` (lista, já existia) +
  `GET /resumo` (novo) + `PATCH /:id/disponivel`, `PATCH /:id/recebido`,
  `PATCH /:id/previsao-liberacao` (as 3 únicas formas de mudar status por
  aqui — a IA nunca chama essas rotas, conciliação usa a função de
  banco diretamente com sua própria confirmação).
- **Frontend (`server/public/index.html`, módulo `window.Recebimentos`
  reescrito):** cards de KPI sempre atuais (recebido hoje/mês, a receber
  total/atrasado, a receber 7/15/30 dias, sem previsão), tabelas "Por
  marketplace" e "Por loja", `STATUS_LABEL` atualizado pros 3 status novos
  (`a_liberar`/`divergente` antigos não existem mais), e botões de ação
  por linha (marcar disponível, definir previsão de liberação, marcar
  como recebido — com modal pedindo valor e data quando aplicável).

### Passo 2 — Importação de extrato bancário + conciliação
- **Tabelas novas:** `contas_bancarias` (cadastro simples por empresa),
  `extrato_importacoes` (histórico — arquivo, contagens, quem importou,
  status; nunca guarda o arquivo em si), `extrato_movimentos`
  (movimentação estruturada — data, descrição, documento, valor, tipo,
  status de conciliação; `UNIQUE (conta_bancaria_id, hash_dedup)` garante
  a deduplicação no próprio banco).
- **`server/lib/contasBancarias.js` (novo):** CRUD mínimo
  (`listarContasBancarias`, `criarContaBancaria`, `buscarPorId`,
  `inativar`).
- **`server/lib/extratoBancario.js` (novo, ~430 linhas) — núcleo do Passo
  2.** Lê XLSX (`exceljs`) e CSV (parser leve escrito na mão — sem
  dependência nova, `;` ou `,` detectado automaticamente, aspas escapadas,
  BOM removido); sugere mapeamento de colunas por palavra-chave
  normalizada (sem acento/maiúscula); `parseData`/`parseValorMonetario`
  cobrem formatos brasileiros (`DD/MM/YYYY`, `1.234,56`, número de série
  do Excel, negativo entre parênteses/com sinal antes ou depois). Hash de
  deduplicação: SHA256 de conta bancária + data + valor + tipo + descrição
  + documento normalizados. Fluxo em 2 chamadas, exatamente como pedido:
  `previsualizarImportacao` (lê, mapeia, calcula prévia — **nunca grava
  nada**) e `confirmarImportacao` (grava, usando os movimentos já
  calculados na prévia — nunca reprocessa/reenvia o arquivo). **A planilha
  em si nunca é persistida** — só passa pela memória da requisição.
- **`server/lib/conciliacaoBancaria.js` (novo).** `sugerirConciliacoes`
  busca candidatos (recebimento de marketplace ou conta a receber, para
  entradas; conta a pagar, para saídas) com valor batendo em até R$ 0,01 —
  único filtro obrigatório; diferença de data só ordena (nunca elimina um
  candidato, marketplaces liberam dinheiro em datas imprevisíveis).
  `confirmarConciliacao` — sempre uma ação explícita do usuário, nunca
  automática — faz, numa única transação: marca o movimento como
  conciliado + muda o status do alvo pra recebido/pago (previsto SOME,
  vira realizado, nunca os dois somados). `ignorarMovimento` só tira da
  lista de pendências, nunca muda recebimento/conta nenhuma.
- **Funções aditivas novas em `lib/contasReceber.js` e
  `lib/contasPagar.js`:** `marcarComoRecebidoPorConciliacao`/
  `marcarComoPagoPorConciliacao` — usam transação do caller, guarda
  atômica `WHERE status NOT IN (...)` no próprio UPDATE (cobre corrida
  entre duas conciliações tentando confirmar o mesmo alvo).
- **`server/lib/fluxoCaixa.js` — corrigido o double-count (o requisito
  central do Passo 2).** Antes, `gerarFluxoDeCaixa` somava TODO
  recebimento de marketplace do período de venda como "previsto",
  independente do status — quando um virava "recebido" (via conciliação),
  contava nos dois lados ao mesmo tempo. Agora busca separado: recebimentos
  ainda não recebidos (por data de venda) vão pro previsto;
  recebimentos com status `recebido` dentro do período (por data efetiva
  de recebimento, via `listarRecebimentosMlRecebidosNoPeriodo`) são
  somados no mapa diário de REALIZADO. Testado com um teste de regressão
  dedicado que prova que previsto cai exatamente o valor X e realizado
  sobe exatamente X (nunca os dois, nunca nenhum).
- **`server/routes/contasBancarias.js`, `extratoBancario.js`,
  `conciliacao.js` (novas)** — registradas em `server.js`, junto com
  `express.json({ limit: '20mb' })` (o arquivo viaja em base64 dentro do
  corpo JSON — não existe biblioteca de multipart/multer disponível neste
  ambiente).
- **Frontend (`server/public/index.html`, módulo `window.FluxoCaixa`
  estendido):** novo botão "Importar extrato bancário" (ao lado de
  "Definir saldo inicial") abre um wizard de 3 etapas — 1) conta bancária
  (com opção de cadastrar uma nova ali mesmo) + arquivo; 2) revisão do
  mapeamento de colunas sugerido (editável); 3) prévia (movimentações
  encontradas, novas, duplicadas, entradas, saídas) com confirmação
  explícita antes de gravar. Página ganhou também "Histórico de
  importações" (arquivo, conta, data, contagens, quem importou, status) e
  "Sugestões de conciliação" (por conta bancária, com botão "Confirmar"
  por candidato e "Ignorar" por movimento) — nenhuma conciliação acontece
  sem clique explícito do usuário.

### Passo 3 — IA Gestora (somente leitura)
- **3 ferramentas novas em `lib/ia/ferramentas.js`** (registradas logo
  depois da já validada `fluxo_de_caixa`, que continua intocada):
  `recebimentos_marketplace_resumo` (mesmos números da tela Recebimentos),
  `fluxo_de_caixa_detalhado` (lê `lib/fluxoCaixa.js#gerarFluxoDeCaixa`,
  não a versão simples — nome deliberadamente diferente da ferramenta
  antiga pra nunca confundir as duas; parâmetro próprio `periodoChave`
  com o mesmo vocabulário de período do Fluxo de Caixa — 7d/15d/30d/mes/
  proximoMes — nunca o período backward-looking do cabeçalho) e
  `extrato_bancario_analise` (entradas/saídas do extrato importado numa
  semana, principais movimentações, fora do normal — detecção simples por
  desvio da mediana —, recebimentos conciliados/não identificados,
  evolução do saldo). As 3 adicionam adaptador visual em
  `lib/ia/estrutura.js` (cards com KPIs/tabela quando o modelo chama
  `apresentar_analise`) e entradas na base de conhecimento interna
  (`lib/ia/baseConhecimento.js`) e no system prompt
  (`lib/ia/orchestrator.js` — instruído a sempre diferenciar
  RECEBIDO/REALIZADO de A RECEBER/PREVISTO nas respostas). Nenhuma rota de
  escrita foi exposta à IA — as 3 são só leitura, mesma disciplina das
  ferramentas já existentes.
- **Sem mudança na arquitetura de despacho** — `FERRAMENTAS_SCHEMA` já era
  passada genericamente pro provedor de IA (sem allowlist fixa no código),
  então as ferramentas novas ficaram disponíveis automaticamente.

### Testes e verificação
- **Testes automatizados novos/estendidos:** `test/extratoBancario.test.js`
  (novo — cobre os cenários 1-3 obrigatórios: importar planilha, reimportar
  sem duplicar, conciliar recebimento de marketplace + conta a receber),
  `test/financeiro.test.js` (ações manuais de recebimento + resumo),
  `test/fluxoCaixa.test.js` (regressão do double-count previsto/
  realizado), `test/iaFerramentas.test.js` (5 testes novos comparando as 3
  ferramentas novas número-a-número contra as funções-fonte que alimentam
  as telas). **Suíte completa: 351/351 passando.**
- **Bug de FK corrigido durante o desenvolvimento:** a nova tabela
  `recebimentos_marketplace` com FK padrão (não `ON DELETE SET NULL`) pra
  `ml_pedidos`/`ml_contas` quebrou um teste PRÉ-EXISTENTE, já validado
  (`test/relatorioVendas.integration.test.js`, "Teste 6 — idempotência",
  que reseeda apagando e reinserindo `ml_pedidos`) — exatamente o tipo de
  regressão que o usuário pediu pra evitar. Corrigido mudando as FKs pra
  `ON DELETE SET NULL` (`db/schema.sql` + `ALTER TABLE` aplicado no banco
  de desenvolvimento já existente).
- **Verificação manual ao vivo (além dos testes automatizados):** os 4
  primeiros cenários obrigatórios foram reproduzidos via `curl` contra um
  servidor real (empresa 900) — importar planilha CSV, reimportar a mesma
  planilha (0 novas, 100% duplicadas), conciliar um recebimento real do
  Mercado Livre (valor batendo com um movimento do extrato) e confirmar
  que o recebimento virou "recebido" com `origemConfirmacao:
  "conciliacao_extrato"`, sem duplicar o valor no resumo. Dados de teste
  revertidos ao final (recebimento voltou pra `a_receber`, conta bancária
  e movimentos de teste apagados).
- **Cenários 5-7 (perguntas em português pra IA)** foram verificados no
  nível da ferramenta (`executarFerramenta`, comparado número-a-número
  contra as funções que alimentam as próprias telas financeiras — ver
  `test/iaFerramentas.test.js`), não numa conversa real de ponta a ponta:
  este ambiente de desenvolvimento não tem `IA_API_KEY` configurada (ver
  `05-problemas-conhecidos.md`), então não existe acesso ao provedor de IA
  aqui. O despacho de ferramentas é genérico (sem allowlist), então o
  comportamento em produção (com a chave configurada) depende só do
  modelo escolher a ferramenta certa — o que o system prompt em
  `lib/ia/orchestrator.js` já instrui.
- **Bug encontrado durante o desenvolvimento, específico deste ambiente de
  teste:** `lib/extratoBancario.js#confirmarImportacao` inicialmente usava
  `rowCount` pra saber se um `INSERT ... ON CONFLICT DO NOTHING` realmente
  inseriu — o `pg` deste sandbox é um stub que nunca preenche `rowCount`
  em DML sem `RETURNING` (só existe pra rodar testes aqui, nunca vai pro
  deploy). Corrigido adicionando `RETURNING id` e checando `rows.length`,
  mesmo padrão já usado em `lib/despesasFixas.js`.

### Arquivos tocados (só os 3 passos — nenhum outro módulo alterado)
`server/db/schema.sql`; `server/lib/recebimentosMl.js`,
`contasBancarias.js` (novo), `extratoBancario.js` (novo),
`conciliacaoBancaria.js` (novo), `contasReceber.js`, `contasPagar.js`,
`fluxoCaixa.js`; `server/routes/recebimentos.js`, `contasBancarias.js`
(novo), `extratoBancario.js` (novo), `conciliacao.js` (novo),
`server.js`; `server/lib/ia/ferramentas.js`, `estrutura.js`,
`baseConhecimento.js`, `orchestrator.js`; `server/public/index.html`
(módulos `Recebimentos` e `FluxoCaixa`); `server/test/extratoBancario.
test.js` (novo), `financeiro.test.js`, `fluxoCaixa.test.js`,
`iaFerramentas.test.js`.

## 2026-08-26 (39) — IA Gestora: corrigir a análise do Estoque Full (matéria-prima/valor a custo)
- **Pedido do usuário:** a IA Gestora não conseguiu dizer quanto o Estoque
  Full vale em R$ ("matéria-prima") e mandou o usuário conferir no painel
  do Mercado Livre — pedido explícito de 3 passos (fonte de dados correta
  com conversão de kit para unidade física; dar essa consulta pra IA; e
  separar Full disponível de Full "em trânsito", com Estoque normal e
  Estoque Full sempre financeiramente separados).
- **Arquivo novo:** `server/lib/estoqueFisico.js` — lê a mesma tabela das
  telas Estoque/Estoque Full (`ml_estoque_itens`, nunca a API do Mercado
  Livre ao vivo, pra os números baterem exatamente) e reaproveita, sem
  nenhuma lógica nova, a mesma regra de conversão kit→físico do Relatório
  de Produtos > "Por Caixa" (`resolverProdutosBasePorSku`, em
  `lib/relatoriosAgregados.js`). Custo usado: `produtos_base.custo` (custo
  por unidade FÍSICA do produto base) — nunca `produtos.custo` (custo por
  SKU/kit exato, usado só na margem de venda) e nunca o preço de venda.
- **`server/lib/ia/ferramentas.js`:** `estoque_valor_parado` reescrita —
  agora devolve sempre `valorEstoqueNormal`/`valorEstoqueFull`/`valorTotal`
  separados (nunca um total único sem explicar a divisão), unidades físicas
  de cada lado, e as pendências nunca escondidas: quantas unidades ficaram
  sem custo cadastrado (com a mensagem exata pedida pelo usuário) e quantas
  sem produto base identificado. Ferramenta nova `estoque_fisico_detalhado`
  (parâmetros `escopo`/`produtoBase`/`limite`) responde "quantas caixas
  físicas tenho no Full", "quanto tenho da caixa 20x20x20" e "quais
  produtos representam mais dinheiro no Full/estoque". As duas sempre
  devolvem o aviso fixo "Ainda não consigo consultar o estoque em trânsito
  pelo ERP." sem nunca bloquear a resposta sobre o Full já disponível.
- **`server/lib/ia/estrutura.js`:** dois adaptadores novos
  (`adEstoqueValorParado`/`adEstoqueFisicoDetalhado`) — quando o modelo
  chamar `apresentar_analise`, essas ferramentas agora também viram card
  visual (KPIs "Valor total a custo"/"Unidades físicas" + tabela
  Produto/Unidades físicas/Custo unitário/Valor em estoque), no formato
  pedido pelo usuário.
- **`server/lib/ia/baseConhecimento.js` e `server/lib/ia/orchestrator.js`:**
  removida a afirmação desatualizada de que "não existe agrupamento de
  estoque por caixa/produto físico" (tema `estoque` da documentação
  interna e a linha "SOBRE LIMITAÇÕES CONHECIDAS" do system prompt) — essa
  frase era a causa provável da IA deflectir pro painel do Mercado Livre.
  Nova seção "SOBRE ESTOQUE E ESTOQUE FULL" no system prompt instrui
  explicitamente a nunca mais responder "confira no painel do Mercado
  Livre" pra pergunta que o ERP já sabe responder.
- **Decisão registrada, não é bug:** nenhuma deduplicação própria de
  estoque compartilhado entre variações de um mesmo anúncio Full — os
  números somam exatamente as mesmas linhas que a tela Estoque Full já
  mostra hoje (ver docs/02-decisoes.md (39) e
  docs/05-problemas-conhecidos.md).
- **Limitação observada (fora do escopo dos 3 passos, reportada ao
  usuário):** não existe hoje nenhuma tela para cadastrar `produtos_base`/
  vínculos de SKU — a API já existe (`server/routes/produtosBase.js`) mas
  não tem UI. Enquanto isso, "sem custo cadastrado"/"sem produto base
  identificado" só podem ser corrigidos via banco/API direta.
- **Testes:** `server/test/iaFerramentas.test.js` — seed de
  `produtos_base`/`produto_base_skus` na empresa de teste (970), teste de
  `estoque_valor_parado` reescrito pra nova metodologia, 5 testes novos
  para `estoque_fisico_detalhado`. **Confirmado ao final:** único módulo
  tocado foi o de Estoque/IA Gestora (`server/lib/estoqueFisico.js`,
  `server/lib/ia/ferramentas.js`, `server/lib/ia/estrutura.js`,
  `server/lib/ia/baseConhecimento.js`, `server/lib/ia/orchestrator.js`,
  `server/test/iaFerramentas.test.js`) — nenhum outro arquivo mudou (mtime
  inalterado). Suite completa: **335/335 testes passando** (331 antes + 4
  líquidos novos).
- **Limitação do ambiente de teste:** a tabela `ml_estoque_itens` está
  vazia neste sandbox (sem `ML_TOKEN_KEY` configurada, sem sincronização
  real) — a verificação numérica de ponta a ponta foi feita via os testes
  automatizados com dado seedado, não via uma pergunta real na tela da IA
  Gestora.

## 2026-08-26 (38) — Visão Geral: reconstrução real da camada visual (2ª correção, só esta tela)
- **Pedido do usuário:** a entrega (37) ainda preservava demais a
  composição visual antiga — pediu explicitamente para NÃO usar o layout
  atual como base e reconstruir de verdade o HTML/CSS da Visão Geral,
  reaproveitando só dado/API/cálculo. **Único arquivo alterado:**
  `server/public/index.html`. **Confirmado ao final:** `server/routes/`,
  `server/lib/` e `server/db/` sem nenhuma mudança (mtime inalterado);
  Pedidos e Financeiro re-testados visualmente (tema escuro e claro) e
  continuam idênticos a antes. Suite completa: **331/331 testes
  passando**.
- **Kit visual novo e isolado (prefixo de classe `ov2-`):** os cards da
  Visão Geral pararam de usar as classes compartilhadas `.kpi-hero`/
  `.kpi-sec` (usadas por Pedidos, IA Gestora e outras telas) — nada nelas
  foi tocado, então nenhuma outra tela é afetada por este redesenho. Cards
  "hero": gradiente radial na cor do indicador, ícone grande em badge
  arredondado, rótulo em caixa alta, e uma nova sparkline em área
  preenchida (função `sparklineAreaSVG`, substitui `sparklineSVG`) na base
  do card. Indicadores secundários: 7 colunas ocupando 100% da largura.
  "Saúde da operação": de uma grade 3x1 de retângulos para uma fileira de
  chips circulares (ícone em círculo + valor + rótulo + status). "Resumo
  da IA": botão CTA cheio (roxo, "Ver insights completos"/"Abrir IA
  Gestora") fixado no rodapé do card. Gráfico principal: 200px → 340px de
  altura, proporção da linha "gráfico + Atenção hoje" ajustada para
  ~72%/28% — tudo reaproveitando as mesmas funções de sempre
  (`chartHTML` só com `heightPx` maior), nenhum cálculo novo.
- **"vs. período anterior" e delta "↑X%" nos secundários seguem fora, por
  decisão investigada:** conferido `lib/periodo.js` — o endpoint só aceita
  períodos nomeados fixos (hoje/ontem/7d/30d/mes), não um intervalo
  arbitrário, então calcular "o período anterior" exigiria uma mudança de
  backend (aceitar desde/ate customizados) que o usuário pediu para não
  fazer. Detalhado em `02-decisoes.md` (38).
- Removidas as funções `statusText()` e `secCardHTML()` do módulo
  Overview, sem uso depois desta reorganização (não afetam nenhuma outra
  tela — cada módulo tem sua própria cópia dessas funções).

## 2026-08-26 (37) — Reorganização visual da Visão Geral (correção pontual, só esta tela)
- **Pedido do usuário:** a entrega (36) não deixou a Visão Geral parecida com
  a nova imagem de referência enviada — pediu para reorganizar SOMENTE essa
  tela (nenhuma outra), reaproveitando os mesmos dados/serviços, sem
  inventar número para preencher o layout. **Único arquivo alterado:**
  `server/public/index.html` (só CSS novo e as funções de render do módulo
  `Overview`). **Confirmado ao final:** `server/routes/`, `server/lib/` e
  `server/db/` sem nenhuma mudança (mtime inalterado); páginas Pedidos e
  Financeiro re-testadas visualmente e continuam idênticas a antes. Suite
  completa: **331/331 testes passando**.
- **Nova estrutura em 4 linhas:** (1) 3 KPIs "hero" grandes — Faturamento,
  Margem de contribuição R$ e % — com ícone, valor grande, mini
  sparkline (quando há ≥2 dias de dado na série já carregada) e nota
  contextual; (2) 7 KPIs secundários compactos distribuídos na largura
  toda — Pedidos, Taxas/comissões, Frete do vendedor, Imposto, Custo dos
  produtos, A receber, A pagar; (3) gráfico "Faturamento x Margem de
  contribuição" ocupando ~2/3 da largura ao lado do painel "Atenção hoje"
  (mesmos alertas reais de sempre, só reposicionado/renomeado); (4)
  "Saúde da operação" (3 métricas novas calculadas sobre dado já existente:
  taxa de cancelamento, % de pedidos com margem calculada, sincronização
  empresas/ML/Shopee) ao lado de "Resumo da IA" (frase gerada a partir das
  contagens reais do Radar da IA, mais os até 2 itens mais recentes).
- **Nenhum dado novo, nenhuma rota nova:** os dois fetches que a tela já
  fazia (`GET /api/relatorios/resumo-vendas` e `GET /api/visao-geral/painel`)
  continuam sendo os únicos. "A receber"/"A pagar" e "Sincronização"
  reaproveitam painéis que existiam antes (Fluxo de caixa, Conexões &
  empresas) só reposicionados. Dois painéis sem substituto direto ficaram
  de fora por decisão explícita ("adapte ou omita"): "Evolução diária"
  (duplicava o gráfico principal) e "Por marketplace" (dado segue
  disponível em Relatórios/Performance de Anúncios) — motivo detalhado na
  entrada (37) de `02-decisoes.md`.
- **Correção de layout:** texto de estado vazio "Pendente — N pedidos sem
  essa informação" estourava a largura dos cards compactos e quebrava o
  alinhamento da linha; agora esses cards mostram só "Pendente"/"Sem
  dados" com o detalhe na notinha abaixo, mesmo padrão já usado em Pedidos.

## 2026-08-26 (36) — Redesign visual do ERP (dark premium) — só layout/CSS, nenhuma regra de negócio tocada
- **Pedido do usuário:** aplicar o novo design visual (5 imagens de
  referência: Pedidos, IA Gestora, Financeiro, Visão Geral, Performance de
  Anúncios) com uma regra explícita — "REFATORAÇÃO VISUAL, não
  REFATORAÇÃO DO SISTEMA": nenhuma API, rota de backend, cálculo,
  integração ou estrutura de dados poderia mudar. **Confirmado ao final:**
  nenhum arquivo em `server/routes/`, `server/lib/` ou `server/db/` foi
  tocado nesta sessão (conferido por data de modificação — só
  `server/public/index.html` mudou). Suite completa: **331/331 testes
  passando** (com `DATABASE_URL` apontando pro Postgres real de dev,
  incluindo os testes de integração) em todo ponto de checagem.
- **Design tokens globais:** paleta escura "graphite" com cobre/laranja
  como cor primária, azul petróleo e roxo/magenta como cores de apoio
  (`--petrol`, `--purple` e variações `-soft`/`-strong`) adicionadas aos
  três blocos de tema (`:root` escuro padrão, `@media
  prefers-color-scheme:light`, `:root[data-theme="light"]`) — usadas
  depois em todos os KPIs/gráficos novos abaixo.
- **Financeiro (dashboard consolidado):** corrigido bug de layout onde os
  links "Ver todas"/"Ver demonstrativo completo" viravam células extras
  soltas no grid (agora ficam dentro do próprio card); corrigido overflow
  silencioso da mini-tabela de Recebimentos (3 colunas cortadas sem
  scrollbar visível mesmo em telas grandes); nova classe `.fin-grid-3` com
  larguras de coluna ajustadas.
- **Pedidos:** nova linha de KPIs (Pedidos, Vendas, Margem R$/%, Ticket
  médio, Cancelados) reaproveitando o endpoint já existente
  `GET /api/relatorios/resumo-vendas` (mesmo dado que Visão Geral já usa —
  nenhuma rota nova, nenhum cálculo novo); o modal de detalhe do pedido
  virou um painel lateral deslizante (`#sidePanelRoot`, novo container,
  para não arriscar quebrar os outros ~10 módulos que usam `#modalRoot`) —
  a lógica de busca e montagem do conteúdo do pedido é a mesma de antes,
  só mudou o container visual.
- **Performance de Anúncios, Visitas e Conversão, Margem por Anúncio:**
  linha de KPIs, 2 rankings (top 5) e 1 gráfico de barras novos em cada
  tela — todos "soma de exibição" (soma/média/razão de valores que o
  backend já retornava por linha, documentado inline no código) e sempre
  com estado vazio honesto ("Dado não disponível", "margem incompleta",
  "Ads pendente", "Sem dados suficientes") em vez de zero fabricado —
  verificado com screenshot no dado real (esparso) da empresa de teste.
- **IA Gestora:** layout mudou de 2 colunas pra 3 (Conversas | Chat |
  painel direito), igual à referência. Painel direito novo com "Insights
  principais" (4 KPIs — Faturamento, Margem média, Ticket médio, Pedidos —
  reaproveitando o mesmo `resumo-vendas` já usado em Pedidos, sem "vs.
  período anterior" porque esse endpoint não traz comparação, então não
  foi inventada) e "O que precisa da minha atenção hoje" (o Radar da IA já
  existente, que antes só aparecia na tela vazia do chat e sumia ao
  conversar — agora fica sempre visível). A lógica de conversa, histórico,
  login e o card de resposta (`cardHTML`) da IA não foram tocados.
- **Demais telas (Marketplaces, Produtos, Anúncios, Fornecedores, Compras,
  Ads, Relatórios e outras):** achado e corrigido um bug visual real e
  antigo — o `<select>` de filtro por empresa/loja (`.empresa-picker
  select`) nunca tinha estilo próprio e caía no visual padrão branco do
  navegador, destoando do tema escuro em quase toda tela do sistema. Uma
  única correção de CSS (reaproveitando o estilo já existente de `.field
  select`) resolveu em todas as telas de uma vez — nenhum HTML/JS mudou.
- **Não implementado, por decisão consciente de não arriscar backend/
  lógica** (ver `02-decisoes.md` (36) para o porquê de cada um):
  aba "Fixadas/Recentes" e busca de conversas na IA Gestora (não existe
  esse dado no backend); painel "Resumo executivo" da IA Gestora (exigiria
  chamar a IA automaticamente ao abrir a tela, hoje ela só responde quando
  o usuário pergunta); Visão Geral e Alertas & IA ficaram como estavam
  (já bem alinhadas ao novo design, sem necessidade de mudança).
- **Entrega:** `git push` continua bloqueado nesta sessão (ver
  `05-problemas-conhecidos.md`) — entregue via zip, como nas sessões
  anteriores.

## 2026-08-26 (35) — Correção real do "Não foi possível carregar" + capa/foto, Ads atribuído separado, identidade centralizada
- **Pedido do usuário:** as 3 telas novas (item (34) abaixo) não estavam
  funcionando de verdade em produção — "Antes de modificar o visual,
  descubra e corrija a causa real desse erro." Só estes 3 passos, sem
  alterar outros módulos.
- **Causa raiz encontrada com evidência real, não suposição:** usando
  acesso (novo nesta sessão) ao Postgres real de produção (Supabase,
  projeto "cais erp") e aos logs reais do serviço no Render, confirmado
  que o servidor de produção caía no boot com
  `Error: Cannot find module './routes/performanceAnuncios'`
  (`MODULE_NOT_FOUND`). Clonando o repositório real do GitHub
  (`pabloandrade4/cerne-erp`, só leitura — `git push` continua bloqueado
  nesta sessão, ver `05-problemas-conhecidos.md`) confirmou que o último
  upload manual pro GitHub esqueceu a pasta `server/routes/` das 3 telas
  novas (`performanceAnuncios.js`, `visitasConversao.js`,
  `margemAnuncio.js`) — `lib/` e `public/index.html` já tinham subido
  certo, só faltou `routes/`. Uma instância nova do Render entrava em
  crash-loop a cada ~4s enquanto uma instância antiga (sem essas 3 telas)
  continuava respondendo — por isso o front-end só mostrava o erro
  genérico "Não foi possível carregar", nunca a causa real. **Corrigido:**
  zip de entrega desta vez conferido explicitamente para conter TODA a
  pasta `server/routes/`, com instrução clara pro usuário subir a pasta
  inteira (não só os arquivos novos).
- **Capa/foto real do anúncio (pedido explícito):** `lib/mlAnuncios.js`
  passa a pedir `thumbnail,secure_thumbnail` na API de Anúncios e expor
  `imagemUrl` (`secure_thumbnail` prioritário, https). As 3 telas mostram
  essa miniatura (36px, 64px no modal) — nunca reenviada/duplicada no ERP,
  só referenciada por URL; placeholder discreto quando a API não retorna
  imagem. Clicar na miniatura OU no título abre o mesmo modal de detalhe
  (comportamento já existente, agora também no clique da imagem).
- **Identidade centralizada — pedido explícito ("as 3 páginas precisam
  conversar entre si"):** nova função `resolverIdentidade()` em
  `server/lib/anunciosBase.js`, usada pelas 3 telas (`performanceAnuncios.js`,
  `visitasConversao.js` e, novidade, `margemAnuncio.js` — que antes nunca
  consultava o catálogo ao vivo do Mercado Livre) pra resolver item_id/
  imagem/SKU/loja/título sempre da mesma forma. Testado com um caso de
  integração novo que compara a mesma linha nas 3 telas e falha se
  divergir.
- **`server/lib/visitasConversao.js`:** adicionado o campo `faturamento`
  por linha (fazia parte do pedido original e tinha ficado de fora) + 2
  ordenações novas ("muitas visitas + poucas vendas", "poucas visitas +
  boa conversão").
- **Bug real de produção encontrado e corrigido em `server/lib/mlAds.js`:**
  usando o `detalhe_api` gravado na última tentativa real da conta
  PFEMBALAGEMS (advertiser_id 753060, Mercado Ads), confirmado que o
  endpoint "novo"/Global Selling de Product Ads
  (`/marketplace/advertising/{site}/advertisers/{id}/product_ads/ads`)
  responde 404 mesmo com o anunciante já confirmado — incompatibilidade
  real da API do Mercado Livre pra esta conta, não um bug deste ERP.
  Corrigido com um fallback documentado: tenta sempre o endpoint novo
  primeiro; SÓ num 404 (nunca em 401/403/500 — não faria sentido tentar
  outro caminho pra um erro de acesso) tenta o formato clássico
  (`/v1/{advertiser_id}/product_ads/items`, `/v1/{advertiser_id}/
  product_ads/campaigns` — endpoint documentado em
  `developers.mercadolivre.com.br/en_us/product-ads-us-read`, já que o
  domínio novo `global-selling.mercadolibre.com` bloqueia acesso
  automatizado). Registra qual formato funcionou (`formatoEndpoint`).
  Testado com `test/mlAdsFallback.test.js` (5 casos, mockando a API — sem
  rede real).
- **Bug real encontrado e corrigido em `motivoDeErro()` (mesmo arquivo):**
  um 404 na listagem de Ads DEPOIS do anunciante já confirmado estava
  sendo rotulado como "Nenhuma conta de anunciante encontrada" — mensagem
  factualmente errada, já que o anunciante FOI encontrado. Corrigido com
  um novo motivo (`sem_anuncios_ads`) que cita o advertiser_id real.
- **`server/lib/margemAnuncio.js` — Ads atribuído separado do resultado
  real (pedido explícito):** cada linha agora tem um bloco `adsAtribuido`
  (campanha, cliques, impressões, CTR/CVR/ROAS/ACOS, faturamento atribuído
  — tudo vindo da própria API do Mercado Ads) que NUNCA entra no cálculo
  de `resultadoAposAds`/`margemAposAdsPct` (esse continua sendo só: margem
  de contribuição das vendas reais menos o investimento real em Ads).
  Texto "Ads pendente" (literal, pedido do usuário) quando ainda não há
  Ads sincronizado pro anúncio — a margem antes do Ads é calculada
  normalmente mesmo assim. Também ganhou o campo `quantidadePedidos`
  (antes só tinha unidades vendidas).
- **Testes:** suíte completa do projeto **332/332 passando** (0 falha —
  confirma que nenhum outro módulo quebrou), incluindo os novos
  `test/mlAdsFallback.test.js` (5) e os casos novos em
  `test/anunciosAnaliseBase.test.js` (identidade) e
  `test/anunciosAnalise.integration.test.js` (imagemUrl, Ads separado,
  identidade cruzada entre Performance e Margem).
- **Bug visual encontrado e corrigido durante o teste manual (Playwright):**
  a nova célula de miniatura + título (`.anuncio-cell-flex`) quebrava o
  título palavra por palavra em ~10 linhas — o algoritmo automático de
  largura de coluna da `<table>` espremia essa coluna pra caber as demais.
  Corrigido travando a largura máxima da célula e truncando o título com
  reticências (mesma ideia que a tabela de Pedidos já usa, agora escopada
  só em `.anuncio-cell-flex` pra não alterar nenhuma tabela existente).
- **Testado com dados reais (empresa 900, 6 anúncios reais) e os 4 filtros
  de período (Hoje, 7 dias, 30 dias, Este mês):** todos retornando dado
  correto nas 3 rotas. Faturamento, tarifas, frete do vendedor e imposto
  de um anúncio real conferidos à mão contra `ml_pedidos`/
  `ml_pedido_itens`/`config_financeiro` — bateram exatos (ver
  `05-problemas-conhecidos.md` para o que NÃO pôde ser testado nesta
  sessão: capa real, preço/status ao vivo, visitas reais e o fallback de
  Ads contra uma resposta real da API — o ambiente de desenvolvimento não
  tem acesso de rede ao Mercado Livre).
- **Conforme pedido, nenhum outro módulo foi alterado nesta tarefa.**

## 2026-08-26 (34) — Análise ganha 3 abas: Performance de Anúncios, Visitas e Conversão, Margem por Anúncio
- **Pedido do usuário, "Pare depois dessas 3 abas":** 3 telas novas dentro
  do grupo Análise, cada anúncio real do Mercado Livre analisado
  individualmente. Ver `02-decisoes.md` (34) para o desenho completo e as
  decisões de negócio (critérios objetivos, definição de conversão, por
  que o gráfico é agregado, etc).
- **Arquivos novos de base compartilhada:**
  `server/lib/periodoComparacao.js` (período anterior de mesma duração,
  não altera `lib/periodo.js`), `server/lib/anunciosBase.js` (agrupamento
  de vendas por anúncio com todos os componentes financeiros, catálogo ao
  vivo do Mercado Livre por conta, última venda por anúncio, nomes de
  produto por SKU, cálculo de crescimento — reaproveitado pelas 3 telas),
  `server/lib/mlVisitas.js` (cliente novo da API de Visitas do Mercado
  Livre — `GET /items/visits`, `GET /users/{id}/items_visits/time_window`).
- **`server/lib/mlAnuncios.js` (aditivo):** nova função
  `buscarTodosAnunciosDaConta` (pagina o catálogo inteiro da conta, com
  limite de segurança) — a função existente `buscarAnunciosDaConta` (usada
  pela tela Anúncios) não foi alterada em comportamento, só refatorada
  internamente para reaproveitar a resolução de token.
- **`server/lib/ads.js` (aditivo):** exportada `buscarMetricasPorAnuncio`
  (já existia, só não era exportada) — usada por Margem por Anúncio para
  ler o investimento em Ads já sincronizado. Nenhuma mudança na tela Ads.
- **Arquivo novo `server/lib/performanceAnuncios.js`:** vendas reais por
  anúncio (fonte única de sempre) + catálogo ao vivo (preço/status/
  estoque) + última venda + crescimento vs. período anterior; classifica
  🟢/🟡/🔴 com critérios objetivos e documentados (constantes nomeadas,
  exportadas para os testes).
- **Arquivo novo `server/lib/visitasConversao.js`:** funil por anúncio
  (visitas × vendas × conversão), série diária agregada para os 2
  gráficos, insights objetivos (muitas visitas+poucas vendas, poucas
  visitas+boa conversão, anúncio forte, queda de visitas).
- **Arquivo novo `server/lib/margemAnuncio.js`:** margem de contribuição e
  resultado após Ads por anúncio, reaproveitando a mesma fórmula de
  sempre; destaques objetivos (fatura muito/pouca margem, margem negativa,
  prejuízo após Ads, Ads consumindo resultado, vende pouco/ótima margem,
  vende muito/margem saudável).
- **Rotas novas:** `server/routes/performanceAnuncios.js`
  (`GET /api/performance-anuncios`), `server/routes/visitasConversao.js`
  (`GET /api/visitas-conversao`), `server/routes/margemAnuncio.js`
  (`GET /api/margem-anuncio`). Wiring em `server.js`, nenhuma rota
  existente alterada.
- **Front-end (`public/index.html`), aditivo:** 3 itens novos no menu
  Análise (entre Ads e Relatórios) — mesmo padrão de módulo auto-contido
  (IIFE + `window.<Modulo>`), usando `window.CerneFiltro` (empresa/
  período) + filtro de loja/SKU/status próprio de cada tela (mesmo padrão
  da tela Ads). Modal compartilhado `window.AnuncioDetalheModal` (clique
  no anúncio em qualquer uma das 3 telas → abre o detalhe com os campos já
  carregados + botões para ver o mesmo anúncio, por SKU, nas outras 2
  abas). **Nenhum outro módulo foi alterado.**
- **Bug encontrado e corrigido durante o teste manual (Playwright):** a
  função `navigate()` não repassava a query string (`?sku=...`) para os 3
  módulos novos ao trocar de página — o clique em "ver este anúncio em
  Margem por Anúncio" navegava para a tela certa mas sem pré-preencher o
  filtro de SKU. Corrigido (mesma linha das outras 25 chamadas de
  `.load()`, só faltava passar `queryStr`) e confirmado por teste
  automatizado com Playwright: clique no anúncio → modal → botão "Margem
  por Anúncio" → tela filtrada para exatamente 1 linha (o mesmo SKU).
- **Bug encontrado e corrigido durante o teste manual:** o modal de
  detalhe usava a classe CSS `modal` (não existe no projeto — a classe
  correta é `modal-card`), então o modal aparecia sem caixa/fundo,
  sobrepondo o conteúdo da tela por trás. Corrigido para `modal-card` +
  `modal-title` (mesmo padrão de todos os outros modais do sistema).
- **Testes novos:** `server/test/anunciosAnaliseBase.test.js` (20 casos
  puros, sem banco — período anterior, agrupamento de vendas,
  `calcularCrescimento`, critérios objetivos do indicador 🟢🟡🔴) e
  `server/test/anunciosAnalise.integration.test.js` (10 casos com Postgres
  real, empresa 900 — reconciliação de faturamento com
  `lib/relatorioVendas.js`, comportamento com token de conta expirado
  (preço/status/visitas nunca inventados), filtro de SKU/loja, empresa sem
  conta). Suíte completa: **315/320 passando** (290 já existentes + 30
  novos, 0 regressão nos módulos já existentes — os 5 que falham são em
  `test/financeiro.test.js`, um teste **pré-existente e sem relação com
  esta tarefa**, sensível à data corrente; ver `05-problemas-conhecidos.md`).
- **Testado com dados reais (empresa 900 — "PFEMBALAGEMS"):** as 3 rotas
  batem exatamente com `/api/relatorios/resumo-vendas` (mesma fonte —
  R$ 558,92 de faturamento, 10 pedidos, em ambas), confirmando a
  reconciliação com Pedidos/Relatórios pedida no checklist. Testado
  visualmente com Playwright (screenshots das 3 telas + do modal de
  detalhe + da navegação cruzada) contra o servidor real rodando nesta
  sessão — nenhum erro de JavaScript no console.
- **Limitação conhecida, documentada (não é um bug):** as 2 contas do
  Mercado Livre disponíveis neste ambiente de desenvolvimento estão com
  token expirado (status `erro`) — por isso preço/status/estoque ao vivo e
  visitas nunca puderam ser testados contra uma resposta real da API
  nesta sessão; o comportamento testado e confirmado foi exatamente o
  esperado nesse cenário: nunca inventar o dado, mostrar o motivo real
  ("conexão com erro" / "Dado não disponível"). Ver
  `05-problemas-conhecidos.md`.

## 2026-08-25 (33) — Financeiro ganha 2 abas: Despesas Fixas (recorrência → Contas a Pagar automática) e Fluxo de Caixa (evolução diária, REALIZADO x PROJETADO)
- **Pedido do usuário, em 3 passos, "Não altere outros módulos":** cadastro
  de despesas recorrentes que gera sozinho a Conta a Pagar do período sem
  duplicar; tela de Fluxo de Caixa (cards, gráfico, tabela diária,
  filtros de 7/15/30 dias/este mês/próximo mês/personalizado); integração
  sem duplicar valor quando uma despesa fixa já virou conta a pagar. Ver
  `02-decisoes.md` (33) para o desenho completo e as decisões de negócio.
- **Schema novo (aditivo):** `despesas_fixas` (o "molde" da despesa
  recorrente), `fluxo_caixa_saldo_inicial` (1 linha por empresa, saldo
  SEMPRE informado pelo usuário — nunca calculado) e uma coluna nova em
  `contas_pagar` (`despesa_fixa_id`, `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`) + um índice único PARCIAL
  (`(despesa_fixa_id, vencimento) WHERE despesa_fixa_id IS NOT NULL`) que
  garante, no próprio banco, no máximo 1 conta a pagar por (despesa fixa,
  data) — a trava definitiva contra duplicação.
- **Arquivo novo `server/lib/despesasFixas.js`:** CRUD completo (criar,
  editar, ativar, desativar, excluir — bloqueado se já gerou histórico) +
  `ocorrenciasNoIntervalo` (cálculo puro de datas de vencimento pra
  mensal/semanal/anual, com clamp de fim de mês) +
  `gerarContasPagarAutomaticas` (gera as contas a pagar que faltam, até o
  fim do mês corrente, com `INSERT ... ON CONFLICT ... DO NOTHING
  RETURNING id` — idempotente mesmo rodando 2x seguidas).
- **Arquivo novo `server/lib/despesasFixasScheduler.js`:** ciclo automático
  em background (mesmo padrão de `adsScheduler.js`), a cada 1 hora
  (`DESPESAS_FIXAS_SYNC_INTERVALO_MS`), gerando as contas a pagar de todas
  as despesas fixas ativas de todas as empresas; nunca depende do
  navegador aberto. Wiring de uma linha em `server.js`
  (`iniciarGeracaoAutomaticaDeDespesasFixas()`).
- **Arquivo novo `server/lib/fluxoCaixa.js`:** agregação sem tabela de
  movimentos própria — junta `contas_pagar`, `contas_receber`, despesas
  fixas ainda não geradas (com a checagem de duplicidade contra
  `contas_pagar.despesa_fixa_id`) e `lib/recebimentosMl.js`, sempre
  separando REALIZADO (o que já foi pago/recebido) de PROJETADO (o que
  está pendente). Período próprio (`calcularPeriodoFluxoCaixa`),
  independente do período do header. Saldo acumulado por dia só é
  calculado se o usuário informou um saldo inicial; sem isso, vem `null`
  com o motivo.
- **Rotas novas:** `server/routes/despesasFixas.js`
  (`GET/POST /api/despesas-fixas`, `PUT/PATCH .../ativar/.../desativar`,
  `DELETE`, `GET .../categorias-sugeridas`, `POST .../gerar` — geração
  manual imediata) e `server/routes/fluxoCaixa.js`
  (`GET /api/fluxo-caixa`, `GET/POST .../saldo-inicial`). Wiring em
  `server.js`, nenhuma rota existente alterada.
- **Front-end (`public/index.html`), aditivo:** 2 itens novos no menu
  Financeiro (Despesas Fixas, Fluxo de Caixa) — mesmo padrão de módulo
  auto-contido (IIFE + `window.<Modulo>`) de Contas a Pagar/Receber.
  Despesas Fixas: tabela + modal de cadastro (frequência muda o campo
  "dia de vencimento" dinamicamente — escondido/calculado sozinho quando
  semanal) + botão "Gerar agora". Fluxo de Caixa: seletor de período
  próprio, 5 cards, bloco "Como o saldo projetado é calculado" (a fórmula
  pedida pelo usuário), gráfico de evolução do saldo (SVG à mão, sólido =
  realizado / tracejado = projetado) e tabela diária REALIZADO x
  PROJETADO. As duas telas usam a empresa do filtro do header
  (`window.CerneFiltro.state.empresaId`), como pedido. **Nenhum outro
  módulo foi alterado** — inclusive o card "Fluxo de Caixa" da Visão Geral
  (`visaoGeralPainel.js`) continua exatamente como estava, com "Saldo
  projetado: Indisponível".
- **Bug encontrado e corrigido durante o teste manual:** a primeira versão
  só "trazia pra hoje" contas a pagar/receber vencidas no passado, mas não
  fazia o mesmo para despesas fixas ainda não geradas — o total
  "despesas fixas previstas" da fórmula não batia com o total de "saídas
  previstas" do período. Corrigido antes de entregar (ver `02-decisoes.md`
  (33) para o detalhe).
- **Testes novos:** `server/test/despesasFixas.test.js` (12 casos) e
  `server/test/fluxoCaixa.test.js` (8 casos, incluindo o teste central:
  criar despesa fixa → conferir que ela aparece como "prevista" → gerar a
  conta a pagar → conferir que ela some de "prevista" e o total do período
  continua o MESMO valor, nunca dobra). Suíte completa: 290/290 passando
  (270 já existentes + 20 novos).
- **Pedido do usuário, em 3 passos:** a tela Ads mostrava "Nenhuma conta de
  anunciante encontrada" numa conta que usa publicidade de verdade. (1)
  descobrir a causa real, com log/interface mostrando status e causa reais;
  (2) sincronizar pela API ATUAL de Product Ads ("os endpoints legados já
  foram descontinuados pelo Mercado Livre", verbatim do usuário), guardando
  os dados no banco; (3) ativar de vez a tela já existente. Ver
  `02-decisoes.md` (32) para o desenho completo, incluindo os trechos da
  documentação oficial citados.
- **`server/lib/mlAds.js` reescrito:** checagem de anunciante agora manda
  `user_id` (faltava — causa mais provável do "nenhum anunciante
  encontrado"); endpoints de campanhas/anúncios trocados do formato antigo
  (`/{advertiser_id}/product_ads/items|campaigns`) para o atual
  (`/marketplace/advertising/{site_id}/advertisers/{advertiser_id}/
  product_ads/ads` e `.../campaigns/search`); métricas `ctr`/`cvr`/`roas`
  devolvidas ao endpoint de anúncios (tinham sido removidas por engano
  numa correção anterior); `motivoDeErro` reescrito pra sempre citar a
  mensagem/causa REAL devolvida pelo Mercado Livre (nunca mais um texto
  genérico), com status/corpo/endpoint completos em `detalheApi`.
- **Schema novo (aditivo):** `ads_contas` (situação/diagnóstico real por
  conta, incluindo `detalhe_api` JSONB), `ads_campanhas` (id→nome),
  `ads_metricas_anuncio` (métricas reais por anúncio, uma linha por
  período-chave do filtro global — `hoje`/`ontem`/`7d`/`30d`/`mes`) e
  `ads_diario` (série diária pro gráfico/cards, janela larga fixa de 40
  dias). `server/lib/ads.js` ganhou `sincronizarContaAds`/
  `sincronizarTodasAsContasAds` (grava tudo isso) e `listarAds` foi
  reescrito pra ler SEMPRE dessas tabelas — nunca mais chama a API do
  Mercado Livre dentro da requisição HTTP da tela.
- **Arquivo novo `server/lib/adsScheduler.js`** — ciclo automático em
  background (mesmo padrão de `syncScheduler.js`/`radarScheduler.js`), a
  cada 15 min (`ADS_SYNC_INTERVALO_MS`), sincronizando todas as contas
  ativas; nunca depende do navegador aberto. Wiring de uma linha em
  `server.js` (`iniciarSincronizacaoAutomaticaAds()`), nenhum outro módulo
  alterado nesse arquivo.
- **`server/routes/ads.js`:** GET passou a incluir `sincronizacaoAutomatica`
  (status do ciclo em background) na resposta; nova rota
  `POST /api/ads/sincronizar` (sincronização manual imediata).
- **Consumidores existentes de `lib/ads.js#listarAds` ajustados pra passar
  a `periodoChave` certa** (senão liam silenciosamente o padrão `30d` pra
  qualquer período pedido): `lib/ia/ferramentas.js` (ferramentas "ads
  desempenho" e "projeção do mês"), `lib/ia/radarAnuncios.js`
  (`listarAdsSeguro`, usado pelo Radar da IA pros períodos 7d/30d),
  `lib/relatoriosAgregados.js` → `routes/relatorios.js` (categoria "Vendas
  e Margem"). Nenhuma fórmula financeira mudou nesses arquivos, só o
  parâmetro novo repassado.
- **Front-end (`public/index.html`), aditivo:** opção de ordenação "Pior
  ACOS" (faltava — só tinha faturamento/lucro/prejuízo/gasto Ads/ROAS);
  botão "Sincronizar agora" + indicação de quando o ciclo automático rodou
  pela última vez. Cards/gráfico/tabelas não mudaram de estrutura, só a
  fonte dos dados.
- **Testes novos:** `server/test/mlAds.test.js` (10 casos — diagnóstico
  real do `motivoDeErro` com erros simulados de status/corpo variados;
  sincronização de conta sem anunciante grava a causa real; sincronização
  de conta com anunciante usa os endpoints atuais e nunca sobra chamada ao
  formato legado; `listarAds` nunca chama a API ao vivo; `listarAds` nunca
  mistura o investimento de uma janela de período na outra) e
  `server/test/adsScheduler.test.js` (3 casos — orquestração do ciclo,
  isolamento de erro, trava contra ciclos sobrepostos). Suíte completa:
  270/270 passando.

## 2026-08-25 (31) — Radar da IA: acompanhamento contínuo do negócio em segundo plano (análise automática de anúncios, negócio inteiro, alertas 🔴🟠🟢🔵)
- **Pedido do usuário, em 3 passos, com o pedido explícito de "não altere
  outros módulos nesta tarefa":** (1) análise automática de anúncios/SKU
  (vendas, faturamento, dias sem venda, crescimento/queda, margem, Ads,
  estoque), identificando anúncio vendendo pouco, praticamente parado (**a
  IA nunca apaga sozinha, só recomenda**), muito faturamento com pouco
  resultado, dando prejuízo, e também **oportunidades** (anúncio bom/em
  crescimento — "não quero uma IA que procure somente problemas"); (2) a
  IA analisando o negócio inteiro conforme os dados são sincronizados —
  custos, Ads agregado, estoque (cobertura estimada), financeiro, fluxo
  de caixa (saldo projetado), compras (cruzando com o caixa); (3) o
  "**Radar da IA**" — processo automático no **backend**, nunca um timer
  só no navegador, usando primeiro regras/cálculos determinísticos do ERP
  e só depois a IA para interpretar/recomendar (nunca chamando o modelo à
  toa a cada ciclo), organizado em 🔴 Crítico / 🟠 Atenção /
  🟢 Oportunidades / 🔵 Informativo, visível em Visão Geral > Alertas & IA
  **e** num resumo "O que precisa da minha atenção hoje" dentro da própria
  IA Gestora. Ver `02-decisoes.md` (31) para o desenho completo.
- **Arquivos novos:** `server/lib/ia/radarConfig.js` (limiares
  declarados), `server/lib/ia/radarAnuncios.js` (Passo 1),
  `server/lib/ia/radarNegocio.js` (Passo 2: custos, Ads agregado, estoque,
  financeiro/fluxo de caixa, compras), `server/lib/ia/radar.js`
  (orquestrador: persiste sem duplicar — upsert por `chave`, decide quando
  chamar a IA, gera o resumo de hoje), `server/lib/ia/radarScheduler.js`
  (ciclo automático a cada 15 min, mesmo padrão de `syncScheduler.js`).
- **Schema novo (aditivo, nenhuma tabela existente alterada):**
  `radar_alertas` (um alerta aberto por `chave` — `UNIQUE(empresa_id,
  chave)`; nunca duplica, atualiza a existente; auto-resolve quando a
  situação deixa de ser detectada), `radar_estado` (última execução,
  status, resumo "hoje" por empresa — prova que o ciclo roda mesmo sem
  ninguém com o ERP aberto), `radar_snapshot_custos` (último custo/margem
  conhecidos por SKU, usado só pra detectar "o custo mudou desde o último
  ciclo e a margem foi de X para Y" — o ERP não guarda custo histórico).
- **Rota nova:** `GET /api/ia-gestora/radar-resumo?empresaId=ID`
  (protegida pelo mesmo login da IA Gestora) — só leitura do que o ciclo
  já persistiu, nunca dispara uma análise nova.
- **Front-end (`public/index.html`), puramente aditivo:** Visão Geral
  ganhou um novo painel "Radar da IA" (função `radarPanelHTML`, ao lado do
  já existente "Alertas & IA" — este último **não foi alterado**) com os
  4 chips de severidade e a lista "O que precisa da minha atenção hoje"
  (clicável, navega para a tela relacionada); a IA Gestora ganhou o mesmo
  resumo na tela inicial do chat (antes de qualquer pergunta).
- **Bug real encontrado e corrigido pelos testes automatizados deste
  ciclo:** `lib/ads.js#listarAds` devolve uma linha por anúncio mesmo sem
  investimento de Ads no período (`margemDepoisDoAds` vem `null` mesmo com
  venda real e margem conhecida) — a primeira versão de
  `radarAnuncios.js` confiava cegamente nessa margem sempre que existia a
  linha, fazendo "anúncio dando prejuízo" desaparecer silenciosamente em
  qualquer empresa sem Ads conectado. Corrigido para cair no fallback
  (margem pura de vendas) sempre que a margem depois do Ads não estiver
  disponível. Ver `02-decisoes.md` (31), item 8.
- **Testado (Postgres real, empresa dedicada de teste — nunca compartilhada
  com outros arquivos):** `test/radar.test.js` (novo) cobre os 4 pontos do
  checklist do usuário — análise automática de anúncios (vendendo pouco,
  dando prejuízo, bom desempenho/oportunidade, com os MESMOS formatos de
  texto dos exemplos que o usuário deu), pelo menos um alerta financeiro
  (contas a pagar vencidas), pelo menos uma oportunidade, nunca duplica
  alerta (upsert por chave), resolve automaticamente quando a situação
  deixa de ser verdade, e funciona sem navegador aberto (chama
  `executarCicloRadarEmpresa` como função Node comum, nunca via HTTP, e
  confere que o resultado sobrevive a um "reinício do processo" —
  descarrega os módulos do `require.cache` e lê de novo só do Postgres).
  Mais 1 teste novo em `test/iaGestoraRoutes.test.js` (rota
  `GET /radar-resumo`, exige login). **257 testes automatizados no
  projeto, 0 falhas** (251 anteriores + 6 novos).

## 2026-08-25 (30) — IA Gestora vira central de análise e relatórios: histórico no banco (com login real, só nesta área), cards visuais e planilha XLSX com os mesmos dados
- **Pedido do usuário, em 3 passos:** (1) salvar as conversas no banco —
  nunca só `localStorage` —, com histórico por usuário, abrir conversa
  antiga e continuar, apagar conversa, sobrevivendo a atualizar a página
  ou logar de novo, sem um usuário acessar conversa de outro; (2)
  respostas mais organizadas/visuais quando fizer sentido (resumo/KPIs/
  tabelas/gráficos com dado real, nunca inventado, mais insights e um
  aviso de atenção); (3) planilha XLSX gerada automaticamente com os
  MESMOS dados da resposta. "Não altere os cálculos financeiros
  existentes." "Não alterar outros módulos nesta tarefa." Ver
  `02-decisoes.md` (30) para o desenho completo, incluindo a decisão do
  usuário (login real, escopado só a esta área) diante do bloqueio
  descoberto: o ERP não tinha autenticação em lugar nenhum.
- **6 arquivos novos em `server/lib/auth/`+`db/`:** `senha.js` (hash
  scrypt, sem dependência nova), `sessoes.js` (token opaco, só o hash
  fica no banco), `cookies.js`, `middleware.js` (`exigirLogin`), e
  `db/criarUsuarioIa.js` (script de bootstrap pra criar o primeiro
  login).
- **2 arquivos novos em `server/lib/ia/`:** `estrutura.js` (monta o card
  visual — resumo/KPIs/tabela/gráfico — só a partir de ferramentas já
  executadas, nunca calcula nada; 13 adaptadores) e
  `planilhaAnalise.js` (gera o XLSX a partir do MESMO card salvo — nunca
  uma nova consulta, garantindo paridade com a conversa).
- **`server/lib/ia/ferramentas.js`:** nova 21ª ferramenta,
  `apresentar_analise` — não consulta nada, só deixa o modelo "assinar"
  quando uma resposta merece card visual (título/insights/atenção); é a
  única parte do card escrita pela IA, todo número vem de outra
  ferramenta.
- **`server/lib/ia/orchestrator.js`:** regra 7 no system prompt (quando
  montar card visual), monta e devolve `estrutura` em toda resposta.
- **`server/db/schema.sql`:** `users.ativo` (coluna nova) + 3 tabelas
  novas — `sessoes_usuario`, `ia_conversas`, `ia_mensagens`.
- **`server/routes/iaGestora.js` (reescrita completa):** `POST /login`,
  `POST /logout`, `GET /me`, `GET /conversas`, `GET /conversas/:id`,
  `DELETE /conversas/:id`, `POST /perguntar` (agora aceita `conversaId`
  pra continuar uma conversa), `GET /conversas/:id/mensagens/:id/xlsx`.
  `router.use(exigirLogin)` protege tudo exceto `/login`/`/logout`/`/me`
  — login exigido só nesta área, nenhuma outra rota do ERP mudou.
- **`server/public/index.html`:** tela da IA Gestora reescrita — tela de
  login, sidebar de conversas (abrir/nova/excluir), card visual
  (KPIs/tabela/gráfico em barras CSS/insights/atenção), botão "Baixar
  planilha (XLSX)". Nenhuma outra tela/módulo do front-end alterado.
- **Correções de infraestrutura de dev (só `server/node_modules/`, nunca
  produção):** `exceljs` reescrito de um stub inútil pra um modelo de
  planilha em memória real (necessário pra gerar/testar o XLSX);
  `express` ganhou `Router.prototype.use()` (pra
  `router.use(exigirLogin)`) e corrigiu um bug latente que quebraria
  middleware dentro de router montado.
- **Testado localmente (Postgres real + servidor HTTP real, IA mockada —
  251 testes no total no projeto, 0 falhas; 3 arquivos de teste novos:
  `iaAuth.test.js`, `iaEstrutura.test.js`, `iaGestoraRoutes.test.js`):**
  login certo/errado, cookie/sessão, isolamento entre dois usuários
  reais, listar/continuar conversa, planilha comparada campo a campo com
  a resposta da conversa (prova de paridade), KPI comparado número a
  número com cálculo independente, sobrevivência a reiniciar o processo
  do servidor, logout revoga sessão de verdade.
- **Nenhum módulo de cálculo financeiro foi alterado** (`lib/relatorioVendas.js`,
  `lib/dre.js`, `lib/contasPagar.js`, `lib/contasReceber.js`,
  `lib/relatoriosAgregados.js`, `lib/ads.js` etc.) — confirmado por diff
  antes de finalizar, por instrução explícita do usuário.

## 2026-08-25 (29) — Conectar a Shopee ao ERP (Open Platform v2 — só autorização + renovação de token, sem pedidos/estoque/Ads/financeiro)
- **Pedido do usuário, em 3 passos:** preparar a integração (Shopee Open
  Platform oficial e atual, credenciais só no backend), fazer "Conectar
  Shopee" funcionar de verdade (OAuth real, salvar Shop ID/nome/empresa/
  tokens/expiração/status/última atualização no banco, tokens só no
  backend), testar e manter a conexão (visualizar status, renovar token
  automaticamente, sobreviver a reinício do servidor). "Não importe
  pedidos ainda." "Não implemente estoque, Ads, Full ou financeiro da
  Shopee nesta tarefa." Ver `02-decisoes.md` (29) para o desenho completo.
- **4 arquivos novos:** `server/lib/shopee.js` (cliente da API — URL de
  autorização, troca/renovação de token, assinatura HMAC-SHA256),
  `server/lib/shopeeCrypto.js` (criptografia AES-256-GCM dos tokens, chave
  própria `SHOPEE_TOKEN_KEY`), `server/lib/shopeeTokenScheduler.js` (ciclo
  automático de renovação de token a cada 30min, proativo — diferente do
  "sob demanda" do Mercado Livre), `server/routes/shopee.js` (rotas
  `config-status`, listar, `conectar`, `callback`, `renovar-token`).
- **`server/db/schema.sql`:** 2 tabelas novas — `shopee_contas` (mesmo
  desenho de `ml_contas`) e `shopee_oauth_states` (mesmo desenho de
  `ml_oauth_states`, sem `code_verifier` — a Shopee não usa PKCE).
- **`server/server.js`:** registra `/api/integracoes/shopee` e inicia o
  ciclo automático de renovação de token no boot do servidor.
- **`server/public/index.html`:** botão "Conectar Shopee" na tela
  Marketplaces (mesmo bloco do Mercado Livre), card de conexão mostrando
  loja/Shop ID/região/empresa vinculada/status/token expira em/última
  atualização, botões "Renovar token" (manual) e "Reconectar".
- **Efeito colateral necessário — `server/lib/visaoGeralPainel.js` e o
  bloco "Conexões & Empresas" de `server/public/index.html`:** o campo
  `shopee` de `conexoesEEmpresas` estava hardcoded em `{contasConectadas:
  0, status: 'nao_conectado'}` desde a criação dessa parte da tela
  (entrada 21) — corrigido pra consultar `shopee_contas` de verdade, senão
  o painel passaria a mostrar uma informação falsa (Shopee sempre
  desconectada) depois desta etapa conectar uma loja de verdade. Nenhuma
  outra regra de Visão Geral mudou.
- **Correção no stub local de Express (só dev/teste, nunca produção —
  `server/node_modules/express/index.js`):** adicionado `res.redirect()`,
  `req.get()` e `req.protocol`, que nunca tinham sido implementados
  (nenhuma rota de OAuth — nem do Mercado Livre — tinha sido testada via
  HTTP real neste ambiente antes desta etapa). Nunca vai para produção
  (Render instala o `express` real do npm).
- **Testado localmente (Postgres real, 24 testes de integração novos em
  `test/shopee.test.js` — 227 testes no total no projeto com Postgres, 0
  falhas):** assinatura HMAC-SHA256, troca/renovação de token (API
  mockada), ciclo de renovação automática (isolamento de erro), reconexão
  após reiniciar o servidor (sem estado em memória), e as 5 rotas HTTP
  reais (autorização → retorno → armazenamento → reconexão sem duplicar →
  renovação manual). **Não foi possível testar contra a Shopee real**
  (sem Partner ID/Partner Key de produção nesta sessão) — ver
  `05-problemas-conhecidos.md` e `06-proximos-passos.md`.
- **Nenhum arquivo do Mercado Livre foi alterado** — confirmado por diff
  antes de finalizar, por instrução explícita do usuário de preservar tudo
  que já está funcionando.

## 2026-08-25 (28) — IA Gestora: nova ferramenta `projecao_mes` (raciocínio/projeção) + correção da recusa indevida ("não existe essa funcionalidade")
- **Pedido do usuário:** corrigir o comportamento — a IA respondia "o ERP
  não tem funcionalidade de projeção" a perguntas de faturamento/lucro
  projetado, mesmo já tendo o dado necessário pra calcular. "A IA Gestora
  deve conseguir RACIOCINAR e fazer cálculos/projeções usando os dados
  reais que já existem no ERP." "Não altere outros módulos." Ver
  `02-decisoes.md` (28) para o desenho completo.
- **1 ferramenta nova** em `server/lib/ia/ferramentas.js` (catálogo de 19
  para 20): `projecao_mes` (`metrica`: `faturamento` | `margem_e_lucro` |
  `pedidos` | `ads`) — projeta até o último dia do MÊS CORRENTE (fixo,
  igual ao padrão do card `gastoMes` de Ads) usando só aritmética simples
  (média diária × dias do mês; ajuste pela tendência dos últimos 7 dias
  quando há venda real nesse período) sobre dado 100% real
  (`buscarPedidosDoPeriodo`/`resumirPeriodo`, `listarAds`) — nenhuma
  fórmula financeira nova.
- **`margem_e_lucro`** nunca inventa lucro projetado quando há SKU sem
  custo cadastrado no mês — devolve `margemEProjecaoDisponivel: false` com
  a contagem exata de SKUs/pedidos pendentes, mas ainda assim entrega a
  projeção de faturamento (que não depende de custo).
- **`server/lib/ia/orchestrator.js`:** regra 5 antiga (raiz do bug relatado)
  dividida em 5-A (nunca recusar só por "não existe tela pra isso" — tentar
  combinar ferramentas via matemática/comparação/agregação/projeção
  primeiro) e 5-B (quando/como usar `projecao_mes`, sempre separando
  REALIZADO de PROJETADO na resposta). Regra 3 renomeada pra "CONSULTA,
  ANÁLISE E PROJEÇÃO".
- **Testado localmente (Postgres real, 6 testes de integração novos em
  `test/iaFerramentas.test.js` — 203 testes no total com Postgres, 0
  falhas):** além dos testes automatizados, as 3 perguntas do checklist do
  usuário foram chamadas diretamente contra `executarFerramenta` (empresa
  900, dado real de 25/08/2026) e comparadas número a número contra
  recálculo manual fora da ferramenta — bateram exatamente. Mesma
  limitação de sempre pra teste ao vivo com o modelo (sem `IA_API_KEY`
  configurada nesta sessão) — ver `02-decisoes.md` (28).
- **Por instrução explícita do usuário, só estes 3 arquivos foram
  alterados** — `server/lib/ia/ferramentas.js`,
  `server/lib/ia/orchestrator.js`, `server/test/iaFerramentas.test.js`.
  Nenhum acesso de escrita foi dado à IA; continua só
  consultando/calculando/comparando/projetando/explicando.

## 2026-08-25 (27) — IA Gestora: catálogo de ferramentas expandido para "conhecer" o ERP inteiro (9 → 19 ferramentas, ainda só leitura)
- **Pedido do usuário:** transformar a IA Gestora em "inteligência central"
  do ERP, em 3 passos — dar conhecimento de todo o ERP (sempre via backend
  seguro, nunca acesso direto ao banco pro modelo), fazer a IA entender e
  cruzar módulos (usando sempre as mesmas contas do resto do sistema), e
  permitir relatórios/DRE/fluxo de caixa pela IA. "Antes de alterar
  qualquer coisa, leia toda a documentação do projeto e preserve o que já
  está funcionando." "Não implemente ações automáticas nesta tarefa." Ver
  `02-decisoes.md` (27) para o desenho completo de cada ferramenta e por quê.
- **10 ferramentas novas** em `server/lib/ia/ferramentas.js`:
  `produtos_por_caixa_desempenho`, `vendas_com_prejuizo`,
  `estoque_valor_parado`, `ads_desempenho`, `fluxo_de_caixa`,
  `dre_completa`, `compras_resumo`, `notas_fiscais_resumo`,
  `comparacao_periodo_anterior`, `consultar_documentacao` — todas casca
  fina sobre função já existente, nenhum cálculo financeiro novo.
- **2 arquivos novos:** `server/lib/compras.js` (agregação de Compras por
  fornecedor — não existia lib própria pra Compras) e
  `server/lib/ia/baseConhecimento.js` (base de conhecimento curada das
  regras de negócio/limitações do ERP, pra ferramenta
  `consultar_documentacao` — `docs/` não é enviado no deploy, então não dá
  pra ler os `.md` direto em produção).
- **`server/lib/contasPagar.js`/`resumoContasPagar` e
  `server/lib/contasReceber.js`/`resumoContasReceber`** ganharam o campo
  `vencendoProximos7Dias`/`previstoProximos7Dias` (aditivo — nenhum campo
  existente mudou de significado; todos os testes antigos continuam
  passando sem alteração).
- **`produtos_desempenho`** ganhou `ordenarPor: 'faturamento'` e
  `ordenarPor: 'quantidade'` (além de `lucro`/`prejuizo`, que continuam
  iguais).
- **`server/lib/ia/orchestrator.js`:** `MAX_RODADAS_FERRAMENTAS` de 6 para
  10 (relatórios/resumos executivos combinam mais ferramentas numa
  pergunta só); `montarSystemPrompt` ganhou instruções sobre fluxo de
  caixa/projeções, comparação de período, montagem de relatórios e
  limitações conhecidas (sem "estoque por caixa", sem Shopee, Ads pode não
  bater com o painel oficial do Mercado Ads).
- **Testado localmente (Postgres real + servidor real, 13 testes de
  integração novos em `test/iaFerramentas.test.js` — 197 testes no total
  no projeto com Postgres/64 sem, 31 suítes, 0 falhas):** cada ferramenta
  nova comparada número a número contra a mesma função canônica que a tela
  correspondente do ERP usa (empresa 900, 11 pedidos reais já seedados,
  mais uma empresa de teste dedicada com fornecedor/compra/produto/estoque
  cadastrados). **Não foi possível testar uma conversa real com o modelo de
  IA** (mesma limitação da entrada (26) — sem `IA_API_KEY` de produção
  configurada nesta sessão) — ver `02-decisoes.md` (27) sobre a estratégia
  de verificação usada no lugar disso.
- **Por instrução explícita do usuário, esta etapa parou nestes 3 passos**
  — nenhuma ferramenta nova grava dado nenhum (só leitura), nenhum outro
  módulo do ERP foi alterado além do necessário pra essas ferramentas
  (contasPagar.js/contasReceber.js ganharam só um campo aditivo cada).

## 2026-08-25 (26) — IA Gestora: provedor configurado corretamente, chat validado (sem dados do ERP), erros categorizados
- **Pedido do usuário:** ativar SOMENTE a IA Gestora, em 3 passos — ver
  `02-decisoes.md` entrada 26 pro texto completo e o raciocínio de cada
  decisão. Não conectar ainda aos dados do ERP, não implementar alertas
  automáticos, não alterar outras áreas.
- **`server/lib/ia/providers/anthropic.js`:** adicionada
  `CATEGORIA_POR_STATUS` (tabela oficial de erros da API de Mensagens da
  Anthropic — 401/403→`chave_invalida`, 402→`sem_credito`,
  429→`limite_uso`, 500/502/503/529→`provedor_indisponivel`,
  504/falha de rede→`erro_conexao`, resto→`erro_desconhecido`), verificada
  contra `https://platform.claude.com/docs/en/api/errors` e confirmada ao
  vivo (chamada real com chave inválida devolveu exatamente o formato
  documentado). Todo erro lançado agora carrega `err.categoria` (e
  `err.status`/`err.tipoApi` quando vem de uma resposta HTTP real).
- **`server/lib/ia/orchestrator.js`:** novo dicionário
  `MENSAGEM_POR_CATEGORIA` (exportado como `mensagemAmigavel`) — traduz
  cada categoria numa mensagem clara em PT-BR. O `catch` que envolve a
  chamada ao provedor não interpola mais `err.message` na resposta do
  chat (antes fazia isso — corrigido); agora usa
  `mensagemAmigavel(err.categoria)` e loga o detalhe técnico completo
  (status, tipo de erro da API, mensagem original) só no
  `console.error`. Resposta ganhou um campo novo, `avisoCategoria`
  (`aviso` continua `'erro_provedor'` como antes, sem quebrar o frontend
  existente).
- **`server/test/iaAnthropicProvider.test.js` (novo arquivo):** 13 testes
  — categorização de cada status HTTP documentado (fetch mockado, sem
  rede), parsing da resposta real (`content`/`stop_reason`/`usage`), e um
  teste de **integração AO VIVO** contra `api.anthropic.com` com uma chave
  propositalmente inválida (confirma o formato real de erro e que o
  servidor consegue mesmo alcançar a API — com skip automático se algum
  dia a rede não estiver disponível nesse ambiente).
- **`server/test/iaOrchestrator.test.js`:** 7 testes novos — cada uma das
  5 categorias produz `avisoCategoria` certo e uma mensagem própria (nunca
  o texto técnico bruto do provedor), e as 5 mensagens são todas
  diferentes entre si.
- **Descoberta relevante desta correção, documentada em
  `05-problemas-conhecidos.md`:** ao contrário do que estava registrado
  desde a ativação original da IA Gestora (28/08/2026), este servidor
  CONSEGUE alcançar `api.anthropic.com` pela internet — a limitação real
  nunca foi falta de rede, é a falta de uma `IA_API_KEY` de produção
  válida (que só o usuário pode gerar em https://console.anthropic.com).
- **O que o usuário precisa configurar no Render:** variável `IA_API_KEY`
  (chave de API válida da conta Anthropic do próprio usuário —
  https://console.anthropic.com); `IA_PROVEDOR` já é `anthropic` por
  padrão; modelo padrão `claude-sonnet-4-5-20250929` (sobrescrevível via
  `IA_MODELO`, opcional). Nenhuma mudança de código necessária além desta
  correção — só configurar a variável de ambiente.
- **Verificação de ponta a ponta feita nesta correção:** servidor real
  rodando contra o Postgres de teste; `POST /api/ia-gestora/perguntar`
  chamado (1) sem `IA_API_KEY` — mensagem "não configurada" de sempre;
  (2) com uma chave propositalmente inválida — chamada HTTP real chega
  em `api.anthropic.com`, recebe 401 real, usuário vê a mensagem
  categorizada certa ("chave configurada parece inválida..."), log do
  servidor guarda o detalhe técnico real (`categoria=chave_invalida
  status=401 tipoApi=authentication_error detalhe=API key is invalid.`).
  Validação de entrada (pergunta vazia → 400, empresa inexistente → 404)
  confirmada sem alteração de comportamento. **Não foi possível testar
  uma resposta real com sucesso (200)** — isso exige uma `IA_API_KEY` de
  produção válida, que só o usuário pode gerar (ver checklist de "o que
  falta" em `05-problemas-conhecidos.md`).
- **Nenhuma conexão nova com dados do ERP foi feita nesta etapa** (o laço
  de ferramentas já existente, de uma ativação anterior, foi mantido
  intacto e sem alterações — ver `02-decisoes.md` entrada 26 pro porquê).
  Suíte completa: 185/185 com Postgres, 64/64 sem Postgres. Nenhum outro
  módulo alterado.

## 2026-08-25 (25) — Correção da tela Ads: API real corrigida, cards de topo, gráfico diário, ranking dividido em duas visões
- **Pedido do usuário:** corrigir e ativar somente a tela Ads, em 3 passos
  (ver `02-decisoes.md` entrada 25 pro texto completo e o raciocínio de
  cada decisão) — sincronizar dado real do Product Ads (com checagem de
  permissão), mostrar cards de gasto hoje/mês + gráfico diário, e um
  ranking por anúncio dividido em duas visões separadas (nunca inventar
  atribuição de pedido ao Ads). Não alterar outros módulos.
- **`server/lib/mlAds.js` — dois erros de integração corrigidos após ler a
  documentação oficial da API de Advertising** (a versão anterior nunca
  tinha sido conferida contra ela): (1) `advertiser_id` agora vai no PATH
  da URL (`/{advertiser_id}/product_ads/items`), não em query string; (2)
  `ctr`/`cvr`/`roas` removidos da lista de métricas pedidas ao endpoint de
  itens (só existem no endpoint de campanhas — pedi-las junto
  provavelmente rejeitaria a chamada inteira). Adicionadas: busca de
  campanhas (`/{advertiser_id}/product_ads/campaigns`, resolve o nome da
  campanha por `campaign_id`, best-effort — uma falha aqui não derruba o
  resto) e busca de série diária (`aggregation_type=daily`, mesmo
  endpoint de itens). Novo ponto de entrada único,
  `buscarDadosAdsDaConta`, resolve o `advertiser_id` uma vez só e busca
  itens + campanhas + série diária do período + série diária mês-atual
  (reaproveitando a mesma chamada quando as janelas são iguais).
- **`server/lib/ads.js` — reescrito para consumir o novo `mlAds.js` e
  adicionar:** campo `campanha` por anúncio; `cliques`/`impressoes`/`cpc`
  por anúncio (dado real da API); `cards` (gastoHoje, gastoMes,
  investimentoPeriodo, receitaAtribuidaPeriodo, roasPeriodo, acosPeriodo,
  disponivel, parcial) — Gasto hoje/mês vêm de uma janela diária FIXA
  (dia 1 do mês até hoje, BRT), o resto vem "no período" e é a MESMA soma
  das linhas da tabela (nunca um segundo cálculo); `diario` (série
  investimento×receita atribuída do período, somada entre as contas/lojas
  em escopo) pro gráfico; `status`/`margemDepoisDoAdsPct` por anúncio.
  Nova função pura exportada `calcularCards` (testável sem API real).
- **`server/routes/ads.js`:** calcula e passa as janelas de "hoje" e "mês
  atual" (BRT, `lib/periodo.js`) além do período do filtro, pros cards.
- **`server/public/index.html` (`window.Ads`) — tela reconstruída:** 5
  cards de topo; gráfico diário "Investimento Ads x Receita atribuída"
  (mesmo desenho SVG do gráfico de Visão Geral, dados diferentes); seletor
  de ordenação (Mais lucrativos / Maior prejuízo / Maior gasto em Ads /
  Maior faturamento / Melhor ROAS), aplicado às duas tabelas ao mesmo
  tempo; e a tabela por anúncio dividida em duas visões separadas —
  **"Performance atribuída Mercado Ads"** (investimento, cliques,
  impressões, CPC, vendas/receita atribuída, ROAS, ACOS — só o que a API
  atribui) e **"Resultado real do SKU após Ads"** (faturamento real de
  todas as vendas do SKU, gasto Ads, TACOS, margem antes/depois do Ads,
  status — com aviso explícito na tela de que pode incluir venda
  orgânica, nunca chamado de "lucro gerado pelo Ads").
- **`server/test/ads.test.js`:** 6 testes novos — cards/diário/campanha
  nunca inventam valor quando a API está indisponível (o normal neste
  sandbox), e uma suíte unitária nova (sem banco) travando a fórmula de
  `calcularCards` com dados sintéticos (soma da série diária, soma das
  linhas, `disponivel`/`parcial`). Suíte completa: 166/166 com Postgres,
  51/51 sem Postgres.
- **Verificação de ponta a ponta feita nesta correção:** servidor real
  rodando contra o Postgres de teste, `GET /api/ads` chamado com
  `periodo=hoje`, `periodo=mes`, com e sem `contaId`, e com uma empresa
  sem conta conectada — todas as respostas conferidas manualmente: nenhum
  campo dependente da API de Ads aparece com valor (tudo `null`, porque a
  conta de teste está com `status='erro'`), e os campos vindos do ERP
  (`faturamentoReal`, `quantidadeVendidaReal`, título, SKU) batem com os
  pedidos reais da conta "PFEMBALAGEMS". **Não foi possível comparar o
  gasto exibido no ERP com o painel real do Mercado Livre nem confirmar
  as duas correções de URL/métricas contra uma chamada real** — este
  sandbox não tem acesso a uma conta Mercado Livre real com Product Ads
  nem à internet a partir do servidor Node (ver
  `05-problemas-conhecidos.md`).
- **Nenhuma tabela nova no banco.** Nenhum outro módulo alterado.

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
