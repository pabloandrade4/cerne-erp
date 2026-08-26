# Decisões do Projeto

Registro de decisões importantes tomadas ao longo do desenvolvimento, na ordem
em que foram tomadas (mais recente no topo).

## 2026-08-26 (36) — Redesign visual: onde a linha "só visual" foi traçada

- **Regra usada em toda decisão desta sessão:** o usuário pediu
  explicitamente para tratar isso como "REFATORAÇÃO VISUAL, não
  REFATORAÇÃO DO SISTEMA" e para parar e avisar antes de qualquer mudança
  visual que exigisse tocar backend/regra de negócio. Cada decisão abaixo
  foi resolvida assim: dá pra fazer só com CSS/HTML/reaproveitando um
  endpoint que já existe? Faz. Precisaria de rota nova, campo novo numa
  resposta de API existente, ou comportamento novo (ex.: IA respondendo
  sozinha)? Não faz — registra aqui e informa no resumo final.

- **Por que Pedidos não ganhou um campo `resumo` na resposta de
  `GET /api/pedidos`, mesmo sendo puramente aditivo:** a função que
  calcularia esse resumo (`resumirPeriodo()`) já existe e já está pronta,
  sem uso nessa rota — teria sido trivial e resultado num campo novo,
  nunca quebrando quem já consome essa resposta. Mesmo assim, a regra do
  usuário foi "não altere... estruturas de dados" da API — então em vez
  disso a tela de Pedidos passou a chamar `GET /api/relatorios/resumo-vendas`
  (a mesma rota que Visão Geral já usa), uma segunda chamada do
  front-end em vez de uma mudança na rota existente.

- **Por que o painel "Insights principais" da IA Gestora reaproveita esse
  mesmo endpoint (`resumo-vendas`) em vez de inventar um cálculo:** é
  leitura pura (GET), já testado e usado em produção por 3 telas
  diferentes (Visão Geral, Pedidos, Financeiro) — reaproveitar o mesmo
  dado garante que a IA Gestora nunca mostra um número diferente do resto
  do sistema pro mesmo período/empresa. O card não mostra "vs. período
  anterior" (como na imagem de referência) porque esse endpoint não
  calcula comparação com período anterior — mostrar isso exigiria uma
  segunda chamada e um cálculo novo só pra essa tela; decidido deixar de
  fora em vez de inventar.

- **Por que o painel "Resumo executivo" da referência da IA Gestora não
  foi implementado:** na imagem de referência é um parágrafo gerado
  (linguagem natural, não um número formatado) — mostrar algo assim exigiria
  ou (a) inventar o texto no front-end (nunca aceitável — a IA "falaria"
  algo que não disse), ou (b) chamar a IA automaticamente toda vez que a
  tela abre, o que muda o comportamento atual (hoje ela só processa/
  responde quando o usuário pergunta algo) e teria custo/efeito colateral
  novo. Como isso não é "só visual", ficou de fora — o usuário pode pedir
  isso como funcionalidade nova depois, com escopo próprio.

- **Por que a sidebar de Conversas não ganhou busca nem abas "Fixadas/
  Recentes" (presentes na imagem de referência):** conferido no backend
  (`routes/iaGestora.js`) que não existe conceito de conversa fixada — só
  criar/listar/abrir/excluir. Adicionar esses controles sem uma lógica
  real por trás seria decoração que não funciona (uma aba "Fixadas" que
  nunca fixa nada). Deixado de fora até existir esse dado.

- **Por que o Radar da IA (painel "O que precisa da minha atenção hoje")
  virou permanente em vez de só aparecer na tela vazia do chat:** o dado
  (`state.radar`, `GET /radar-resumo`) já existia e já era carregado toda
  vez que a tela abre — só nunca ficava visível depois da primeira
  pergunta. Mover pro painel lateral fixo é puramente de posição/CSS,
  sem nenhuma mudança na leitura ou no cálculo do radar.

- **Por que Visão Geral e Alertas & IA não mudaram nesta sessão:** na
  varredura de todas as telas "demais" contra o novo sistema de design,
  as duas já usavam integralmente os componentes/tokens já revisados
  (cards de KPI, paleta escura, cores por tinta) — mudar por mudar sem um
  problema real identificado não estava dentro do pedido.

- **Por que o bug do `<select>` branco foi corrigido mesmo sem estar em
  nenhuma das 5 imagens de referência:** é uma inconsistência visual real,
  generalizada (afeta ~12 telas) e a correção é uma única regra de CSS
  reaproveitando um estilo que já existe e já é usado em outro lugar do
  mesmo arquivo — risco equivalente a zero, e diretamente a favor do
  pedido "mesmo design system em toda tela".

## 2026-08-26 (35) — Diagnóstico com acesso real de produção, endpoint clássico de Ads, identidade centralizada

- **Diagnosticar com dado real em vez de suposição:** o usuário pediu
  explicitamente "descubra e corrija a causa real desse erro" e "não deixe
  apenas uma mensagem genérica". Em vez de tentar reproduzir o erro só
  localmente, usado o acesso real (disponível nesta sessão) ao Postgres de
  produção (Supabase) e aos logs reais do serviço no Render — encontrado o
  stack trace exato do crash (`MODULE_NOT_FOUND` na pasta `routes/`).
  Confirmado clonando o próprio repositório do GitHub (leitura anônima —
  funciona mesmo com `git push` bloqueado nesta sessão, técnica útil pra
  próximas sessões: `git clone --depth 5 <repo> /tmp/algum-lugar` deixa
  inspecionar exatamente o que está publicado, sem depender de memória de
  sessões anteriores).

- **Por que um fallback de endpoint, e não trocar de vez para o formato
  clássico:** a decisão foi manter o endpoint "novo" (Global Selling) como
  primeira tentativa (é o documentado como atual pelo Mercado Livre) e só
  cair pro formato clássico (`/v1/{advertiser_id}/product_ads/items`)
  quando o novo responde 404 — nunca em outros códigos de erro (401/403 é
  problema de acesso, não de endpoint errado; 500 é problema do servidor
  do Mercado Livre). Registrar qual formato funcionou (`formatoEndpoint`)
  em vez de esconder a diferença. Fonte usada para o formato clássico:
  `developers.mercadolivre.com.br/en_us/product-ads-us-read` (a doc do
  domínio novo, `global-selling.mercadolibre.com`, bloqueia acesso
  automatizado com 403 — mas essa página legada continua acessível e
  documenta exatamente esse endpoint, com o mesmo shape de resposta que o
  parser já esperava).

- **Por que "Ads atribuído" nunca entra no cálculo de resultado real —
  pedido explícito do usuário:** o Mercado Ads atribui cliques/vendas a
  campanhas usando sua própria janela de atribuição, que não é a mesma
  coisa que "esta venda real aconteceu". Misturar os dois inflaria (ou
  reduziria, dependendo do caso) o resultado real de forma que não bate
  com o que entrou no caixa de verdade. Por isso os dois ficam sempre
  visualmente separados na tela e nunca somados no back-end — mesmo que
  isso signifique mostrar dois números de "cliques"/["vendas atribuídas"]
  que um usuário desatento poderia querer somar à margem.

- **Por que a imagem nunca é reenviada ao Mercado Livre nem salva no ERP —
  pedido explícito do usuário ("nunca reenviar imagem duplicada"):** o
  campo `imagemUrl` guarda só a URL (`secure_thumbnail`/`thumbnail`) que já
  vem do catálogo ao vivo do Mercado Livre a cada consulta — o `<img>` no
  front-end carrega direto dessa URL. Nenhum download/upload de arquivo de
  imagem acontece neste ERP. Trade-off consciente: se o Mercado Livre
  trocar a imagem do anúncio, a próxima consulta já reflete isso
  automaticamente (não existe uma cópia desatualizada guardada em lugar
  nenhum) — mas também significa que, se a API estiver fora do ar, a
  imagem também fica indisponível (mesmo racional já usado pra preço/
  status ao vivo).

- **Por que `resolverIdentidade()` prioriza o título do catálogo ao vivo
  sobre o título gravado na venda:** antes desta correção, cada tela
  montava sua própria versão de "qual é o título deste anúncio" com uma
  lógica ligeiramente diferente (uma preferia o título da venda, outra o
  vivo) — exatamente o problema que o usuário apontou ("não quero cada
  página construindo uma versão diferente do mesmo anúncio"). Decisão:
  quando o catálogo ao vivo está disponível, ele é a fonte de verdade (é o
  título atual, o vendedor pode ter renomeado o anúncio depois da venda);
  o título da venda histórica só é usado como último recurso, quando a
  conta está sem conexão válida com o Mercado Livre.

- **Limitação aceita conscientemente:** nenhuma verificação desta correção
  pôde ser feita contra uma resposta real da API do Mercado Livre — o
  ambiente de desenvolvimento não tem saída de rede para
  `api.mercadolibre.com` (confirmado com um teste de conectividade direto,
  timeout). Tudo que envolve o Mercado Livre de verdade (capa real,
  fallback de endpoint de Ads contra uma resposta real, visitas reais)
  precisa ser conferido pelo usuário depois do deploy — ver
  `05-problemas-conhecidos.md`.

## 2026-08-26 (34) — Três abas novas em Análise: Performance de Anúncios, Visitas e Conversão, Margem por Anúncio

- **Pedido do usuário, "Pare depois dessas 3 abas", "Não altere outros
  módulos":** analisar cada anúncio real do Mercado Livre em 3 telas
  separadas dentro do grupo Análise, usando os mesmos filtros globais
  (empresa/loja/período), com critérios objetivos e documentados para
  qualquer indicador/status, nunca inventando dado, e permitindo clicar
  num anúncio em qualquer uma das 3 telas para abrir o detalhe. Ver
  `04-alteracoes.md` (34) para a lista completa de arquivos.

- **Critérios objetivos dos indicadores 🟢🟡🔴 (Performance de Anúncios) —
  por que estes números:** o usuário pediu explicitamente "não crie esses
  status arbitrariamente". Em vez de um único limiar mágico, os critérios
  combinam 3 sinais que já existem nos dados reais (dias sem vender,
  crescimento/queda de unidades vendidas vs. o período anterior de mesma
  duração, e média de vendas por dia) em 2 faixas (queda forte ≥50% / queda
  moderada ≥20%, 14+ dias sem vender / 7-13 dias sem vender) — os mesmos
  números estão em `lib/performanceAnuncios.js` (constantes nomeadas no
  topo do arquivo, nunca "no olho" dentro da lógica) e em
  `01-regras-de-negocio.md`. Só se aplicam a anúncios com status "active"
  — um anúncio pausado/encerrado tem seu próprio badge de status, não faz
  sentido avaliar "desempenho" de um anúncio que nem está no ar.

- **Período anterior ("comparação com período anterior"):** criado
  `lib/periodoComparacao.js` (não altera `lib/periodo.js`, mesmo padrão já
  usado para `lib/fluxoCaixa.js`) com uma única regra simples para as 5
  chaves do filtro global: mesma duração, imediatamente anterior ao início
  do período selecionado. Para "Este mês" isso NÃO é "o mês de calendário
  anterior inteiro" (duração variável) — é a mesma quantidade de dias
  corridos antes do dia 1. Decisão consciente de manter uma única regra
  simples e sempre igual, em vez de um cálculo especial por chave que
  seria mais "natural" para calendário mas inconsistente entre si.

- **Definição de conversão (Visitas e Conversão):** o usuário pediu para
  "usar a métrica mais adequada... e deixar claro qual definição está
  sendo usada". Decidido: **Conversão = pedidos ÷ visitas × 100** (não
  unidades ÷ visitas) — um pedido com 3 unidades do mesmo anúncio conta
  como 1 conversão, é a definição padrão de taxa de conversão de
  e-commerce e evita inflar a conversão de anúncios vendidos em kit/multi-
  unidade. Mostrado com esse rótulo explícito em toda a tela (cabeçalho da
  coluna, `field-hint`, modal de detalhe), nunca só "Conversão".

- **API de Visitas do Mercado Livre — pesquisada e integrada de verdade,
  mas resposta NÃO verificada contra uma conta real:** endpoint real
  pesquisado na documentação oficial (`GET /items/visits?ids=...&date_from=
  ...&date_to=...`, ver `lib/mlVisitas.js`) e implementado com chamada real
  à API. As duas contas ML disponíveis neste ambiente de desenvolvimento
  estão com token expirado (status `erro`), então o formato exato da
  resposta da API nunca pôde ser conferido contra uma chamada real nesta
  sessão — o parsing foi feito defensivamente (tenta os formatos mais
  prováveis descritos na documentação) e, se o formato real vier diferente
  do esperado, o anúncio simplesmente fica com "Dado não disponível" (nunca
  quebra, nunca inventa um número). Ver `05-problemas-conhecidos.md`.

- **Gráficos "Visitas x Vendas" e "Conversão ao longo do tempo" são
  agregados (toda a loja/anúncios filtrados), não por anúncio individual:**
  decisão forçada pela própria API do Mercado Livre — o endpoint de série
  diária de visitas (`items_visits/time_window`) é por CONTA (usuário
  vendedor), não por anúncio; pedir a série diária de cada anúncio
  individualmente exigiria 1 chamada por anúncio, o que não escala para um
  catálogo inteiro. Documentado em `lib/visitasConversao.js` e na própria
  tela (`field-hint`). A tabela por anúncio mostra visitas TOTAIS do
  período e a evolução (comparação percentual) vs. o período anterior —
  não uma série diária por anúncio.

- **"Muitas"/"poucas" visitas, "fatura muito"/"vende pouco" são relativos
  ao próprio conjunto filtrado, por terços — não um valor fixo em reais/
  visitas:** um valor fixo (ex: "1000 visitas é muito") funcionaria para
  uma empresa e seria absurdo para outra 10x maior/menor. Decidido comparar
  cada anúncio aos outros do MESMO resultado filtrado (empresa/loja/
  período), usando o terço de cima/baixo do conjunto como corte — mesmo
  critério em `lib/margemAnuncio.js` e `lib/visitasConversao.js`. Com menos
  de 3 anúncios no conjunto, nenhum destaque relativo é calculado (não faz
  sentido "terço" de 1 ou 2 itens).

- **Margem por Anúncio reaproveita EXATAMENTE a fórmula de sempre — nenhum
  cálculo novo:** pedido explícito do usuário ("Não crie uma nova fórmula
  específica para essa página"). `lib/margemAnuncio.js` não recalcula nada
  — agrupa por anúncio os mesmos itens de pedido já calculados por
  `lib/relatorioVendas.js` (via `lib/anunciosBase.js#agruparVendasDetalhado`,
  que usa `lib/resultadoVenda.js`) e o investimento em Ads já sincronizado
  (mesma fonte da tela Ads — `lib/ads.js#buscarMetricasPorAnuncio`, agora
  exportado; mudança puramente aditiva, não altera a tela Ads).

- **"Imposto ausente por SKU" nunca é sinalizado — decisão consciente,
  não uma omissão:** o usuário pediu para sinalizar quando "algum SKU
  estiver sem custo ou imposto". Neste ERP o imposto é uma ALÍQUOTA ÚNICA
  POR EMPRESA (`config_financeiro`, não por SKU — ver `lib/resultadoVenda.js`),
  sempre calculada quando o valor da venda existe. Sinalizar "imposto
  ausente" seria inventar uma situação que o modelo de dados atual nunca
  produz de verdade. Documentado no topo de `lib/margemAnuncio.js`: a causa
  real de margem incompleta hoje é sempre custo do produto não cadastrado
  em Produtos (mesmo sinal `margemIncompleta`/`pendentes` já usado em
  Pedidos, Relatórios e Ads) — se um dia o imposto passar a ser por SKU,
  esta tela precisa ser revisada.

- **"Abrir os detalhes do anúncio" — modal compartilhado com navegação
  cruzada por SKU, em vez de uma 4ª tela nova:** em vez de criar uma
  página de detalhe do zero (que exigiria decidir uma URL própria, um
  layout novo, e ainda assim duplicaria dado já carregado), decidido um
  modal compartilhado (`window.AnuncioDetalheModal`, um único código
  reaproveitado pelas 3 telas) que mostra os campos JÁ CARREGADOS daquela
  linha (nenhuma chamada nova à API) e oferece botões para abrir o MESMO
  anúncio (filtrado pelo SKU) nas outras 2 abas — clicar em "Visitas e
  Conversão" dentro do modal de Performance de Anúncios navega pra lá já
  com o filtro de SKU preenchido. Reaproveita o padrão de rota com
  query string já existente (`navigate('marketplaces?ml=...')`).

- **Playwright estava disponível neste ambiente o tempo todo — correção a
  uma afirmação anterior:** a entrada de 25/08/2026 (33) registrou "este
  ambiente de desenvolvimento não tem acesso a um navegador Playwright
  nesta etapa". Isso estava ERRADO — o Chromium do Playwright está
  pré-instalado neste ambiente (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`)
  e foi usado nesta etapa para testar as 3 telas novas visualmente
  (screenshots + captura de erros de console), inclusive o clique no
  anúncio e a navegação cruzada entre as 3 abas com o filtro de SKU. Ver
  `05-problemas-conhecidos.md` para o que ainda não pôde ser testado (dados
  ao vivo do Mercado Livre, por causa do token expirado das contas de
  teste).

## 2026-08-25 (33) — Duas abas novas em Financeiro: Despesas Fixas (recorrência → Contas a Pagar automática, sem duplicar) e Fluxo de Caixa (evolução diária, REALIZADO x PROJETADO)

- **Pedido do usuário, em 3 passos, "Não altere outros módulos":** (1)
  cadastro de despesas recorrentes (aluguel, salários, pró-labore,
  sistemas, contador, energia, internet, outras — frequência mensal/
  semanal/anual, cadastrar/editar/ativar/desativar) que gera sozinha a
  Conta a Pagar do período, sem nunca duplicar mesmo rodando o processo
  mais de uma vez; (2) tela de Fluxo de Caixa com saldo, contas a
  receber/pagar, despesas fixas previstas e recebimentos previstos dos
  marketplaces, visão diária, filtros de 7/15/30 dias/este mês/próximo
  mês/personalizado, sempre separando REALIZADO de PROJETADO, cards de
  topo e gráfico de evolução; (3) integrar sem duplicar valor nenhum —
  "Aluguel em Despesas Fixas = R$3.000, Conta a Pagar gerada = R$3.000 ⇒
  Fluxo de Caixa conta R$3.000 uma única vez, nunca R$6.000" — e manter o
  filtro de empresa do header funcionando nas duas abas novas.
- **Despesa fixa é só um MOLDE — quem representa dinheiro de verdade
  continua sendo `contas_pagar`.** Nada de uma segunda tabela de
  "lançamentos financeiros" paralela: a cada ciclo, `lib/despesasFixas.js`
  gera a linha em `contas_pagar` (com `despesa_fixa_id` preenchido) e a
  partir daí ela é uma conta a pagar igual qualquer outra — aparece em
  Contas a Pagar, pode ser paga/cancelada por lá, entra no DRE, etc. Isso
  também é o que evita a duplicação: editar/desativar uma despesa fixa
  **nunca** altera contas já geradas (mesma filosofia de imutabilidade de
  fato financeiro já usada em `contas_pagar`/`contas_receber`/`compras`).
- **Trava de não-duplicação em DOIS níveis, não só um.** (a) Índice único
  PARCIAL em `contas_pagar(despesa_fixa_id, vencimento) WHERE
  despesa_fixa_id IS NOT NULL` — no máximo 1 conta por (despesa fixa,
  data), garantido pelo próprio Postgres, não só pela aplicação; (b) a
  geração usa `INSERT ... ON CONFLICT (despesa_fixa_id, vencimento) ...
  DO NOTHING RETURNING id` — se o ciclo automático (a cada hora) e um
  clique manual em "Gerar agora" colidirem, só um dos dois efetivamente
  insere, o outro recebe 0 linhas de volta. Testado rodando o ciclo 2x
  seguidas (`test/despesasFixas.test.js`): a segunda rodada sempre gera 0
  contas novas, e o banco nunca tem 2 linhas pra a mesma ocorrência.
  **Detalhe técnico encontrado só ao testar de verdade:** o driver `pg`
  deste ambiente de desenvolvimento (stub local, nunca usado em produção —
  ver `05-problemas-conhecidos.md`) não preenche `rowCount` em
  `INSERT ... DO NOTHING` sem `RETURNING`; por isso a contagem de "quantas
  contas foram geradas" usa `RETURNING id` + `rows.length` em vez de
  `rowCount` — funciona igual nos dois ambientes (stub local e `pg` real
  em produção) e é mais robusto de qualquer forma.
- **`dia_vencimento` muda de significado conforme a frequência** (ao invés
  de inventar 3 campos diferentes): mensal/anual = dia do mês (1-31,
  ajustado pro último dia quando o mês é mais curto — igual qualquer
  cobrança recorrente de verdade: dia 31 cai em 28/29 de fevereiro);
  semanal = dia da semana ISO (1=segunda...7=domingo), **sempre calculado
  a partir do dia da semana de `data_inicio`, nunca aceito separado do
  formulário** — evita a despesa ficar inconsistente com a própria data em
  que ela começa a se repetir. Anual usa o MÊS de `data_inicio` como o mês
  da ocorrência (não existe um segundo campo "mês de vencimento" — seria
  duplicar informação que `data_inicio` já dá).
- **Horizonte da geração automática = fim do mês corrente** (não o dia
  exato do vencimento). "Quando chegar o novo período" foi interpretado
  como "o mês já começou" — a conta a pagar aparece assim que o mês vira,
  dando tempo do usuário se planejar antes do vencimento chegar de
  verdade, em vez de só no dia. Ciclo automático a cada 1 hora
  (`lib/despesasFixasScheduler.js`, mesmo padrão de `lib/adsScheduler.js`
  — roda dentro do processo Node do servidor, nunca depende do navegador
  aberto), mais um botão "Gerar agora" (`POST /api/despesas-fixas/gerar`)
  pra quem acabou de cadastrar não precisar esperar o próximo ciclo.
- **Campo "empresa/CNPJ" do pedido = o seletor de empresa já existente**
  (`empresaId`), igual todo o resto do ERP — não um campo de texto livre
  pro CNPJ. O CNPJ já está no cadastro de Empresas; duplicar esse dado
  como texto solto em Despesas Fixas criaria uma segunda fonte que podia
  ficar desatualizada.
- **Fluxo de Caixa tem PERÍODO PRÓPRIO, deliberadamente separado do
  período do header** (`window.CerneFiltro`/`lib/periodo.js`, que só tem
  hoje/ontem/7d/30d/mes e nunca inclui data futura). Fluxo de Caixa é
  sempre uma projeção pra FRENTE — "7/15/30 dias" aqui contam a partir de
  HOJE (inclusive) até N-1 dias à frente, o oposto do "últimos N dias" do
  resto do ERP. Implementado só dentro de `lib/fluxoCaixa.js`
  (`calcularPeriodoFluxoCaixa`), sem tocar em `lib/periodo.js` nem em
  nenhuma outra tela — só a empresa do header é reaproveitada.
- **Saldo inicial é SEMPRE informado pelo usuário — nunca calculado ou
  inventado pelo sistema.** O ERP não tem nenhuma integração bancária real
  (mesma regra já registrada pra o card "Fluxo de Caixa" da Visão Geral em
  `lib/visaoGeralPainel.js`, que continua **intocado**, com "Saldo
  projetado: Indisponível" hardcoded exatamente como antes). Nova tabela
  `fluxo_caixa_saldo_inicial` (1 linha por empresa, upsert) guarda valor +
  data de referência informados pelo usuário; sem essa informação, "Saldo
  atual"/"Saldo projetado" aparecem como "Não informado" (nunca um número,
  nunca zero disfarçado de saldo real) em vez de travar a tela — REALIZADO
  e PROJETADO (entradas/saídas do período) continuam sempre calculáveis
  independente disso.
- **Contas/despesas vencidas no passado são "trazidas" pra dentro de
  HOJE no gráfico/tabela diária** (nunca pra uma data futura inventada).
  Uma conta pendente com vencimento ontem não desaparece da série nem fica
  presa no passado — ela soma no dia de hoje, junto com o que já é de
  hoje, porque é dinheiro que já deveria ter saído/entrado. Aplicado
  igualmente a contas a pagar, contas a receber E despesas fixas ainda não
  geradas (`somarPorDiaComDobraParaHoje` e a mesma lógica dentro de
  `calcularDespesasFixasPrevistasPorDia`) — achado um bug real nessa
  simetria durante os testes manuais: a primeira versão só "dobrava" contas
  a pagar/receber, esquecendo despesas fixas ainda não geradas, o que
  fazia `despesasFixasPrevistas` e `saidasPrevistas` baterem números
  diferentes (uma inconsistência visível na fórmula); corrigido antes de
  entregar.
- **Recebimentos previstos dos marketplaces entram só como TOTAL do
  período, nunca num dia específico do gráfico/tabela diária.** O Mercado
  Livre não devolve data de liberação (mesma limitação já documentada em
  `lib/recebimentosMl.js`/tela Recebimentos) — inventar um dia pra plotar
  esse valor seria inventar um dado que o ERP não tem. Aparecem
  destacados, com essa ressalva explícita, no bloco "Como o saldo
  projetado é calculado" (a fórmula pedida pelo usuário: saldo inicial/
  atual + contas a receber + recebimentos previstos dos marketplaces −
  contas a pagar − despesas fixas previstas = saldo projetado).
- **Sem tabela de "movimentos" nova para o Fluxo de Caixa** — mesma
  filosofia de DRE/Recebimentos: `lib/fluxoCaixa.js` só reorganiza dado
  que já existe em `contas_pagar`, `contas_receber`, despesas fixas ainda
  não geradas e `lib/recebimentosMl.js`, nunca uma segunda fórmula
  financeira paralela.
- **Gráfico "Evolução do saldo de caixa"**: SVG desenhado à mão (mesmo
  padrão de Visão Geral/Ads — sem biblioteca de gráfico), uma linha só
  (saldo acumulado por dia), sólida até hoje (realizado) e tracejada dali
  em diante (projetado), com tooltip por ponto. Sem saldo inicial
  informado, mostra um empty state explicando o motivo, com atalho pra
  abrir o formulário de saldo inicial — nunca um gráfico com eixo zerado
  fingindo ser um dado real.
- **Testado**: `test/despesasFixas.test.js` (12 casos: validação,
  `ocorrenciasNoIntervalo` puro para as 3 frequências incluindo clamp de
  fim de mês e dia da semana derivado, geração idempotente rodando 2x,
  edição não altera conta já gerada, ativar/desativar, exclusão bloqueada
  depois de já ter gerado histórico) e `test/fluxoCaixa.test.js` (8 casos:
  período próprio, saldo inicial nunca inventado, a peça central —
  despesa fixa já gerada não conta 2x no total do período — e separação
  REALIZADO x PROJETADO por dia). Suíte inteira do projeto rodada depois:
  290/290 passando (270 já existentes + 20 novos), nada quebrado nos
  outros módulos.

## 2026-08-25 (32) — Ads: diagnóstico real (nunca mais "nenhum anunciante encontrado" genérico), endpoints ATUAIS de Product Ads e sincronização em banco

- **Pedido do usuário, em 3 passos, com uma instrução MUITO IMPORTANTE:**
  a tela Ads mostrava "Nenhuma conta de anunciante (Product Ads) encontrada
  para esta conta do Mercado Livre" mesmo numa conta que usa publicidade de
  verdade. (1) descobrir a causa REAL (não só mostrar a mensagem genérica),
  usando o token real da conta contra `GET /advertising/advertisers?
  product_id=PADS`, e registrar status/causa no log/interface se o Mercado
  Livre devolver erro; (2) sincronizar Product Ads pela API ATUAL (a
  instrução MUITO IMPORTANTE, verbatim do usuário: **"Os endpoints
  legados de Product Ads já foram descontinuados pelo Mercado Livre"**),
  guardando os dados no banco pra não depender de consultar a API toda vez
  que a página abre; (3) ativar de vez a tela já existente (cards, gráfico,
  ranking por anúncio ordenável, incluindo "pior ACOS"). Como sempre: ler
  toda a documentação oficial e atual antes de alterar qualquer coisa, e
  não misturar vendas atribuídas pelo Ads com venda orgânica.
- **A correção anterior (entrada 25) só tinha sido validada contra
  `developers.mercadolivre.com.br/en_us/product-ads-us-read` — a Mercado
  Livre também documenta Product Ads em
  `global-selling.mercadolibre.com/devsite/new-product-ads` (e
  `/devsite/mercado-ads`), que é a MESMA API real (`api.mercadolibre.com`),
  não uma API separada para conta de venda internacional — "Mercado Ads
  está disponível apenas no Brasil, México e Chile", sem distinção
  documentada entre conta doméstica e cross-border. Essa segunda
  documentação tem um aviso explícito de descontinuação que a primeira não
  tem: "the previous version's endpoint .../product_ads/campaigns will be
  deprecated" e "campaign search requests must now include /search" —
  confirma a instrução do usuário.** Três correções reais feitas em
  `lib/mlAds.js` a partir dela:
  1. **Faltava o parâmetro `user_id` na checagem de anunciante.** A
     documentação atual exige `GET /advertising/advertisers?
     product_id=PADS&user_id={marketplace_user_id}` — a versão anterior só
     mandava `product_id=PADS`. Sem `user_id`, essa é a causa mais provável
     de "nenhum anunciante encontrado" mesmo numa conta que anuncia de
     verdade. `ml_contas.ml_user_id` (já existente, usado no resto da
     integração) resolve isso sem precisar de nenhum dado novo.
  2. **Os endpoints de campanhas e anúncios eram o formato ANTIGO.** Trocado
     `/{advertiser_id}/product_ads/items` e
     `/{advertiser_id}/product_ads/campaigns` pelo formato atual:
     `GET /marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads`
     e
     `GET /marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/campaigns/search`
     (sufixo `/search` obrigatório pra campanhas, conforme o aviso de
     descontinuação).
  3. **A lista de métricas do endpoint de anúncios estava faltando `ctr`,
     `cvr` e `roas`** — a correção anterior (entrada 25) tinha removido as
     três achando que só existiam no endpoint de campanhas; o exemplo
     verbatim da documentação atual as inclui também para anúncios/itens.
     Adicionadas de volta — ROAS/ACOS calculados aqui em cima de
     `cost`/`total_amount` continuam existindo como fallback quando a API
     não devolve o valor.
  - **Não existe "Ad Group" na API do Mercado Livre** — pesquisado
    especificamente porque o pedido do usuário citava isso; o fluxo real é
    anunciante → campanha → anúncio (item), sem camada intermediária.
- **Diagnóstico real (Passo 1) — `motivoDeErro` (`lib/mlAds.js`) reescrito**
  pra nunca mais devolver um texto genérico solto: toda falha carrega o
  status HTTP real, a mensagem/causa exatamente como o Mercado Livre
  devolveu (campo `message`/`cause` do corpo de erro), e o endpoint e
  parâmetros usados — gravado em `ads_contas.detalhe_api` (JSONB) e
  citado dentro da própria mensagem mostrada na tela (nunca só "HTTP 404",
  sempre com a causa em texto). Continua nunca lançando erro solto — quem
  chama sempre recebe um motivo estruturado.
- **Persistência (Passo 2) — 3 tabelas novas** (`db/schema.sql`):
  `ads_contas` (situação/diagnóstico por conta), `ads_campanhas`
  (id→nome), `ads_metricas_anuncio` (métricas reais por anúncio, UMA
  LINHA POR PERÍODO-CHAVE — ver decisão abaixo) e `ads_diario` (série
  diária pro gráfico e pros cards fixos). A tela (`routes/ads.js` →
  `lib/ads.js#listarAds`) **NUNCA MAIS chama a API do Mercado Livre** — lê
  só o que já foi sincronizado. Um novo `lib/adsScheduler.js` (mesmo
  padrão de `lib/syncScheduler.js`) roda em BACKGROUND, dentro do processo
  Node do servidor, sincronizando todas as contas ativas a cada 15 minutos
  (`ADS_SYNC_INTERVALO_MS`) — nunca depende do navegador aberto. Também
  adicionado `POST /api/ads/sincronizar` (botão "Sincronizar agora" na
  tela) pra quem acabou de corrigir a integração no painel do Mercado
  Livre não precisar esperar o próximo ciclo.
- **Por que "uma linha por período-chave" em vez de granularidade diária
  por anúncio:** a API de Advertising só devolve um TOTAL agregado pro
  intervalo de datas pedido (não dá pra "somar dias depois" — quem soma é
  a própria API). O filtro global do ERP (`lib/periodo.js`) só tem 5
  janelas possíveis (`hoje`/`ontem`/`7d`/`30d`/`mes`) — a sincronização
  busca o total de cada anúncio pra essas 5 janelas exatas e grava uma
  linha por (conta, período-chave, anúncio), assim a tela nunca precisa de
  uma chamada ao vivo pra nenhum período que o filtro já oferece. A série
  diária (gráfico + cards "Gasto hoje"/"Gasto no mês") é sincronizada à
  parte, numa janela larga fixa (40 dias, `ADS_SYNC_DIARIO_DIAS`),
  independente das 5 chaves. Todos os outros lugares do ERP que já liam
  Ads (`lib/ia/ferramentas.js`, `lib/ia/radarAnuncios.js`,
  `lib/relatoriosAgregados.js` → `routes/relatorios.js`) foram ajustados
  pra passar a `periodoChave` certa — sem isso, um pedido de "últimos 7
  dias" acabaria lendo silenciosamente o dado de "últimos 30 dias"
  sincronizado por padrão, o que seria um número real mas da janela
  errada (a mesma classe de erro que "nunca inventar" existe pra evitar).
- **Passo 3 — ativação da tela:** cards, gráfico "Investimento Ads x
  Receita atribuída por dia" e as duas tabelas separadas ("Performance
  atribuída Mercado Ads" / "Resultado real do SKU após Ads") já existiam
  da correção anterior (entrada 25) e não precisaram mudar de estrutura —
  só a fonte dos dados (banco em vez de API ao vivo). Adicionada a opção
  de ordenação "Pior ACOS" que faltava (só tinha faturamento/lucro/
  prejuízo/gasto Ads/ROAS), e um botão "Sincronizar agora" com indicação
  de quando a sincronização automática rodou pela última vez.
- **O que ainda não foi confirmado contra uma chamada real:** este ambiente
  de desenvolvimento não tem uma conta Mercado Livre real com Product Ads
  nem acesso à internet a partir do servidor Node (mesma limitação da
  entrada 25) — as 3 correções acima vêm diretamente do texto da
  documentação oficial (com URLs e trechos citados no código e em
  `05-problemas-conhecidos.md`), não de suposição, mas só uma sincronização
  real em produção confirma definitivamente a causa do "nenhum anunciante
  encontrado" original. O diagnóstico rico (`detalhe_api`) foi desenhado
  exatamente pra essa confirmação ser imediata assim que rodar contra a
  conta real, sem precisar de mais uma rodada de leitura de documentação.

## 2026-08-25 (31) — Radar da IA: a IA Gestora deixa de depender de pergunta e passa a acompanhar o negócio continuamente, em segundo plano

Pedido do usuário, em 3 passos, com as mesmas constraints de sempre repetidas
explicitamente ("antes de alterar qualquer coisa, leia toda a documentação e
preserve o que já está funcionando", "faça SOMENTE estes 3 passos", "não
altere outros módulos nesta tarefa"): (1) **análise automática dos
anúncios** — por SKU/anúncio, continuamente: vendas, faturamento, evolução,
dias sem venda, queda/crescimento, margem de contribuição, gasto com Ads,
resultado depois de Ads, estoque, preço, taxas, frete — identificando
anúncio vendendo pouco, anúncio praticamente parado (**"a IA NÃO deve
apagar anúncio automaticamente, ela apenas recomenda"**), anúncio com muito
faturamento e pouco resultado, anúncio dando prejuízo, e também anúncios
bons/oportunidades (**"não quero uma IA que procure somente problemas"**);
(2) **a IA analisando o negócio inteiro** conforme os dados são
sincronizados — custos (impacto na margem quando o custo muda), Ads
agregado (ROAS/ACOS, gastando sem vender, Ads consumindo grande parte da
margem), estoque (cobertura estimada, zerado, baixo, excesso), financeiro
(contas a pagar/receber, vencidas), fluxo de caixa (saldo projetado,
cruzando pagar × receber), compras (o que precisa ser comprado, cruzando
com o caixa disponível); (3) **"Radar da IA"** — processo automático no
BACKEND, periódico, **nunca um timer só no navegador**, e **"não chame o
modelo de IA desnecessariamente a cada minuto — use primeiro regras e
cálculos do ERP para detectar situações relevantes e depois utilize a IA
para interpretar e gerar recomendações"**, organizado em 🔴 Crítico /
🟠 Atenção / 🟢 Oportunidades / 🔵 Informativo, aparecendo em Visão Geral >
Alertas & IA **e** num resumo dentro da própria IA Gestora, com um bloco
"O que precisa da minha atenção hoje". Constraints permanentes reafirmadas:
nunca inventar número (sempre os mesmos cálculos das demais telas), a IA
continua **sem permissão para executar ações sozinha** (analisa, compara,
projeta, alerta, recomenda — nunca apaga anúncio, pausa anúncio, altera
preço, altera Ads, paga conta, cria compra, altera estoque, altera custo),
e nunca duplicar alerta ("se um problema já possui um alerta aberto,
atualize esse alerta em vez de criar outro igual todos os dias").

**1) Como "vasculhar tudo" sem inventar nenhuma fórmula financeira nova.**
A tentação óbvia seria escrever um novo cálculo de margem "por anúncio" —
errado, porque violaria a regra central do projeto (fonte única de
cálculo). Em vez disso, o Radar é construído como uma camada nova de
**agregação e detecção** por cima do que já existe: `lib/relatorioVendas.js`
(`buscarItensDoPeriodo` — a mesma função que já alimenta Pedidos, DRE,
Financeiro e a própria IA Gestora) fornece os itens vendidos já com
margem de contribuição calculada por `lib/resultadoVenda.js`; o Radar só
agrupa esses itens por `ml_item_id`/SKU em janelas de tempo (30d/7d/7d
anteriores) para enxergar tendência. `lib/ads.js#listarAds` (a mesma fonte
da tela Ads) fornece ROAS/ACOS/margem depois de Ads. Nenhuma fórmula
financeira nova foi criada — só regras de comparação/limiar em cima de
números que o ERP já calculava.

**2) Estrutura em 3 arquivos, espelhando os 3 passos do pedido.**
`server/lib/ia/radarAnuncios.js` (Passo 1 — por anúncio),
`server/lib/ia/radarNegocio.js` (Passo 2 — negócio inteiro: custos, Ads
agregado, estoque, financeiro/fluxo de caixa, compras) e
`server/lib/ia/radar.js` (Passo 3 — orquestrador: junta os dois, persiste,
decide quando chamar a IA, gera o resumo "hoje"). Um quarto arquivo,
`server/lib/ia/radarConfig.js`, guarda só os limiares/constantes
declarados (ex.: "vendeu ≤5 unidades em 30 dias", "estoque cobre ≤7
dias") — mesmo padrão já usado por `ESTOQUE_BAIXO_LIMITE` em
`lib/visaoGeralPainel.js`: um ponto de partida simples e declarado, não
uma previsão de demanda ou modelo de ML.

**3) Detecção sempre determinística; a IA só escreve a recomendação —
e só quando algo é NOVO ou PIOROU.** Todo número/comparação/limiar roda em
JavaScript/SQL puro, sem nenhuma chamada ao modelo. A IA (mesmo provedor
já configurado em `lib/ia/providers/`) é chamada **só** para transformar
uma lista de situações NOVAS ou que pioraram de severidade neste ciclo em
um texto de recomendação melhor — nunca para decidir se algo é um problema
(isso já foi decidido pelas regras) e nunca a cada ciclo pra tudo (cumprindo
literalmente "não chame o modelo desnecessariamente a cada minuto"). Cada
situação já nasce com uma `recomendacaoPadrao` determinística (muitas
copiadas quase literalmente dos exemplos que o próprio usuário deu no
pedido) — então o Radar funciona **inteiramente sem IA configurada**
(relevante porque esta sandbox não tem `IA_API_KEY` válida, mesma
limitação já documentada em `05-problemas-conhecidos.md`); a IA, quando
configurada, só enriquece o texto, nunca é uma dependência para o sistema
funcionar.

**4) Nunca duplicar alerta: upsert por `chave` estável + auto-resolução.**
Cada situação detectada carrega uma `chave` determinística e estável (ex.:
`anuncio_parado:ml:123456789`, `custo_alterado:SKU-X`,
`financeiro_contas_vencidas` — este último e `fluxo_caixa_risco` são
propositalmente "globais" por empresa, já que só existe uma versão
agregada dessas situações). Nova tabela `radar_alertas` tem
`UNIQUE(empresa_id, chave)`: a cada ciclo, uma chave já existente **nunca**
gera uma nova linha — atualiza a existente; uma severidade que piorou (ou
um alerta que tinha sido resolvido e voltou a acontecer) reseta a
recomendação para o texto padrão e entra na lista pra IA reinterpretar;
uma chave que não foi detectada neste ciclo é automaticamente marcada como
`resolvido` — nunca precisa de ação manual pra "limpar" um alerta que já
deixou de ser verdade.

**5) Por que uma tabela nova só pra custo (`radar_snapshot_custos`).**
O ERP recalcula toda margem histórica sempre com o custo **atual** de
`produtos` (nunca guarda o custo de quando a venda aconteceu) — então não
existe, hoje, nenhuma forma de comparar "margem antes/depois de uma
mudança de custo" sem guardar, em algum lugar, o último custo/margem
conhecidos. Em vez de inventar um recálculo hipotético, o Radar grava (a
cada ciclo, upsert por SKU) o último custo e a margem % dos últimos 30
dias — duas leituras **reais**, tiradas em momentos reais diferentes.
Comparar essas duas leituras reais nunca inventa nenhum número; só existe
alerta quando o custo realmente mudou desde o ciclo anterior.

**6) "Compra necessária" é uma estimativa nova e claramente declarada —
não existe reorder point no ERP hoje.** Não havia, em nenhuma tela do
sistema, o conceito de "ponto de reposição" ou "estoque mínimo". Foi
construída uma estimativa simples: `coberturaDias = estoqueAtual /
(quantidadeVendida30d / 30)`, com limiares nomeados em `radarConfig.js`
(crítico ≤7 dias, atenção ≤14 dias, excesso ≥120 dias — mesmo espírito
declarado do `ESTOQUE_BAIXO_LIMITE` já existente). A sugestão de compra
(quantidade e valor) é sempre cruzada com o fluxo de caixa real dos
próximos 7 dias (contas a pagar vencidas/vencendo × contas a
receber/recebimentos do Mercado Livre esperados) antes de avisar se
"apertaria o caixa" — exatamente como no exemplo do pedido do usuário.
Nunca inventa saldo bancário (o ERP não tem esse cadastro, ver
`01-regras-de-negocio.md`) — só valores previstos reais.

**7) Ciclo automático no BACKEND, nunca um timer no navegador — mesmo
padrão já usado e testado por `lib/syncScheduler.js` (Mercado Livre) e
`lib/shopeeTokenScheduler.js` (Shopee).** `server/lib/ia/radarScheduler.js`
usa `setInterval` dentro do próprio processo Node do servidor
(`.unref()`'d, primeiro ciclo dispara imediatamente ao subir o servidor,
sem esperar o intervalo inteiro), com `Promise.allSettled` isolando o
erro de uma empresa das demais. Intervalo padrão de **15 minutos**
(configurável por `IA_RADAR_INTERVALO_MS`) — bem maior que o 1 minuto da
sincronização de pedidos, porque cada ciclo chama a API de Ads do Mercado
Livre (rate limit real) e roda vários cálculos agregados por empresa; os
alertas em si também não mudam minuto a minuto (são tendências de dias,
não de segundos). A API de Ads é buscada **uma única vez** por
empresa/ciclo (30d e 7d) no orquestrador (`radar.js`) e compartilhada
entre `radarAnuncios.js` e `radarNegocio.js`, pra nunca consultar Ads em
dobro no mesmo ciclo.

**8) Bug real encontrado pelos testes automatizados deste ciclo, corrigido
antes de considerar a tarefa concluída.** `lib/ads.js#listarAds` devolve
uma linha por anúncio mesmo quando não há investimento de Ads no período
(sem campanha vinculada, ou conta de Ads sem token válido) — com
`margemDepoisDoAds` vindo `null` nesse caso, mesmo havendo venda real e
margem de contribuição conhecida. A primeira versão de
`radarAnuncios.js` confiava cegamente nessa margem sempre que existia uma
linha de Ads (mesmo com o número vindo `null`), fazendo a detecção de
"anúncio dando prejuízo" desaparecer silenciosamente em qualquer empresa
sem Ads conectado — justamente o cenário mais comum. Corrigido para cair
no fallback (margem pura de vendas, sem Ads) sempre que a margem depois
do Ads não estiver disponível, não só quando não existe nenhuma linha de
Ads para aquele anúncio. Coberto por `test/radar.test.js` (ver
`04-alteracoes.md`).

**9) Escopo do que NÃO foi feito nesta tarefa (respeitando "SOMENTE estes 3
passos").** Nenhum módulo fora de `lib/ia/radar*.js`,
`routes/iaGestora.js` (só a rota nova `GET /radar-resumo`),
`server.js` (só a chamada de boot do scheduler), `db/schema.sql` (só as 3
tabelas novas) e `lib/visaoGeralPainel.js` (só o campo aditivo `radar` no
retorno) foi alterado. `lib/visaoGeralPainel.js#gerarAlertas` (o
mecanismo de alertas simples já existente) continua **inteiramente
intacto** — o Radar é puramente aditivo, uma segunda fonte de alerta,
nunca uma substituição.

## 2026-08-25 (30) — IA Gestora vira "central de análise e relatórios": histórico salvo no banco (com login real, só nesta área), respostas visuais (KPI/tabela/gráfico) e planilha XLSX automática com os MESMOS dados

Pedido do usuário, em 3 passos, com a constraint explícita de ler a
documentação e "preservar tudo que já está funcionando" antes de alterar, e
"não alterar outros módulos nesta tarefa": (1) salvar as conversas da IA no
banco — não só `localStorage` — com histórico por usuário, abrir conversa
antiga, apagar conversa, sobrevivendo a atualizar a página ou logar de
novo, respeitando "usuário; empresa/CNPJ; permissões — um usuário não pode
acessar conversas de outro usuário sem autorização"; (2) melhorar a forma
como a IA entrega análises — resumo, KPIs, tabelas, gráficos (com DADOS
REAIS, "não invente dados apenas para preencher visual"), insights e um
aviso de "atenção" quando há problema, adaptando a apresentação ao tipo de
pergunta; (3) gerar automaticamente uma planilha XLSX com os MESMOS dados
da resposta ("não pode acontecer de a conversa mostrar um total e a
planilha mostrar outro"), respeitando a empresa/loja/período/filtro
exatos da pergunta, organizada em abas quando fizer sentido. Constraint
final repetida: **"Não altere os cálculos financeiros existentes"** e
**"Pare depois desses 3 passos."**

**0) Bloqueio descoberto antes de alterar qualquer coisa — decidido com o
usuário via pergunta direta.** Lendo a documentação e o código (conforme
pedido) antes de mexer em qualquer coisa, ficou claro que o requisito
"usuário não pode acessar conversa de outro usuário sem autorização" é
impossível de cumprir de verdade hoje: **o ERP não tem autenticação em
lugar nenhum** — a tabela `users` existe no schema mas nunca foi usada
(sem tela de login, sem sessão, sem verificação de senha); a única
"identidade" hoje é a empresa selecionada no cabeçalho, que qualquer
pessoa pode trocar. Apresentadas 3 opções ao usuário: (a) escopar conversa
só por empresa, sem login de verdade; (b) identificação leve por
navegador, sem senha; (c) login real (tela, sessão, senha), usando a
tabela `users` já existente, com risco explícito de que isso é "um
projeto bem maior que só a IA Gestora". **O usuário escolheu (c),
login real.** Decisão registrada aqui porque ela molda todo o resto desta
etapa: login passou a existir de verdade, mas — para não violar "não
altere outros módulos" — **aplicado SOMENTE dentro de `routes/iaGestora.js`**
(`router.use(exigirLogin)`), nunca em qualquer outra rota/tela do ERP.
Nenhuma outra tela pede senha depois desta mudança.

**1) Login real, sem nenhuma dependência nova** (`lib/auth/senha.js`,
`lib/auth/sessoes.js`, `lib/auth/cookies.js`, `lib/auth/middleware.js`,
`db/criarUsuarioIa.js`) — escolhido deliberadamente para não depender de
`bcrypt` (pacote não instalável neste sandbox sem acesso ao registro
npm; produção no Render também não tinha essa dependência antes):
- **Senha:** `crypto.scryptSync` (nativo do Node, recomendação da OWASP
  quando bcrypt não está disponível), salt aleatório de 16 bytes por
  senha (a mesma senha nunca gera o mesmo hash duas vezes), comparação
  em tempo constante (`crypto.timingSafeEqual`) — `verificarSenha` nunca
  lança exceção, mesmo com hash malformado.
- **Sessão:** token opaco (32 bytes aleatórios, não é JWT/não
  auto-contido) — o banco (`sessoes_usuario`) guarda só o **hash
  SHA-256** do token, nunca o token em si; um dump do banco sozinho não
  permite se passar por um usuário logado. Guardado em cookie
  `httpOnly; SameSite=Lax` (`Secure` quando a requisição é https, mesmo
  padrão já usado nos redirects OAuth de Mercado Livre/Shopee). Logout
  (`revogarSessao`) apaga a linha no banco — sessão realmente invalidada
  no servidor, não só cookie apagado no navegador (testado explicitamente
  em `test/iaGestoraRoutes.test.js`: mesma sessão não funciona mais depois
  do logout). Duração configurável via `IA_SESSAO_DIAS` (padrão 30 dias,
  opcional).
- **Criação de usuário é só por script**, rodado manualmente no servidor —
  não existe (e não foi pedido) tela de "criar minha conta": ver o comando
  exato em `06-proximos-passos.md`.
- **O que o login garante, e o que ele deliberadamente NÃO garante:**
  garante que toda conversa (`ia_conversas`/`ia_mensagens`) pertence a UM
  usuário, e todo acesso (listar/abrir/apagar) filtra por
  `usuario_id = req.usuario.id` — testado com dois usuários reais (A e B)
  em `test/iaGestoraRoutes.test.js`: a lista de B nunca mostra conversa de
  A, abrir por ID direto devolve 404 (nunca revela que a conversa existe),
  apagar como B devolve 404 e a conversa de A continua intacta. **Não**
  cria permissão por empresa — qualquer usuário logado pode escolher
  qualquer empresa ativa no cabeçalho, exatamente como qualquer outra
  tela do ERP já funciona hoje. Criar uma ACL de empresa por usuário
  tocaria `routes/empresas.js` e o seletor do cabeçalho, compartilhado com
  o resto do sistema — fora do escopo de "só a área da IA Gestora" desta
  tarefa, e por isso deliberadamente não feito. Ver `05-problemas-conhecidos.md`.

**2) Histórico de conversas no banco, nunca só `localStorage`**
(`db/schema.sql`: tabelas novas `ia_conversas` e `ia_mensagens`,
+ `sessoes_usuario`, + `users.ativo`) — `routes/iaGestora.js` reescrito
com `GET /conversas`, `GET /conversas/:id`, `DELETE /conversas/:id` e
`POST /perguntar` (aceita `conversaId` opcional pra continuar uma
conversa existente; carrega o histórico do BANCO — nunca confia num
histórico que o navegador mandasse — últimas 20 mensagens). Uma conversa
é sempre de UMA empresa (`ia_conversas.empresa_id`); trocar de empresa no
cabeçalho fecha a conversa aberta no front-end (nunca mistura pergunta
nova com histórico de outra empresa). Título da conversa é sugerido pela
própria IA (via `apresentar_analise`, ver abaixo) quando disponível,
senão a própria pergunta truncada.

**3) Card visual (resumo/KPIs/tabela/gráfico/insights/atenção) — decisão
central: quem decide é o MODELO, e todo número vem de ferramenta já
executada, nunca do modelo** (`lib/ia/ferramentas.js` ganhou uma 21ª
ferramenta, `apresentar_analise`; `lib/ia/estrutura.js`, novo módulo puro
e determinístico, `montarEstrutura`):
- `apresentar_analise` **não consulta nada** — o handler só ecoa a
  própria entrada (`tituloConversa`, `insights[]`, `atencao?`). A
  descrição da ferramenta instrui o modelo a chamá-la só para
  análises/relatórios/rankings maiores, nunca para uma pergunta simples
  de um número só — é essa decisão do modelo (chamar ou não) que decide
  se a resposta ganha tratamento visual, satisfazendo "adapte a
  apresentação conforme o tipo de pergunta" sem nenhuma lista de palavras-
  chave hardcoded em lugar nenhum. Regra 7 nova no system prompt
  (`orchestrator.js`) explica exatamente quando usar.
- **Separação estrita:** todo KPI/linha de tabela/ponto de gráfico é
  produzido por `lib/ia/estrutura.js`, lendo SÓ a saída já real de outras
  ferramentas chamadas na mesma pergunta (`ADAPTADORES`, um por
  ferramenta) — zero participação do modelo nesses números. A ÚNICA parte
  do card escrita pelo modelo é o texto qualitativo: `insights` (as
  conclusões) e `atencao` (o aviso de problema). Isso significa que a
  regra "nunca inventar número" vale também pra camada visual nova, com a
  mesma garantia estrutural que já existe pro texto (ver decisão (26)).
  Quando o modelo não chama `apresentar_analise`, `estrutura` volta
  `null` e a resposta continua só texto — comportamento idêntico ao de
  antes desta tarefa.
- **Cobertura: 13 das 21 ferramentas têm adaptador visual hoje**
  (`resumo_vendas`, `resultado_periodo`, `produtos_desempenho`,
  `produtos_por_caixa_desempenho`, `desempenho_por_loja`,
  `fluxo_de_caixa`, `contas_a_receber_resumo`, `contas_a_pagar_resumo`,
  `dre_completa`, `ads_desempenho`, `comparacao_periodo_anterior`,
  `projecao_mes`, `vendas_com_prejuizo`) — são exatamente as ferramentas
  cuja saída tem números/rankings/séries que fazem sentido num card
  (KPI, tabela ou gráfico). As demais (ex: ferramentas de consulta muito
  pontual, como buscar um pedido específico) continuam só texto — não
  ganham adaptador porque não têm o que desenhar num card sem inventar
  estrutura.
- `fluxo_de_caixa`/`projecao_mes` sempre separam KPIs com `grupo:
  'REALIZADO'` de `grupo: 'PROJETADO'` no card — mesma exigência textual
  já usada desde a decisão (28), agora também no visual.
- Gráficos são desenhados como barras HTML/CSS simples
  (`.ia-chart-bar-fill`) — sem biblioteca de gráficos nova (nenhuma
  dependência de CDN/npm adicionada).

**4) Planilha XLSX com garantia estrutural de nunca divergir da conversa**
(`lib/ia/planilhaAnalise.js`, `montarPlanilhaAnalise`) — a decisão de
design mais importante desta etapa para cumprir "a planilha deve
utilizar os MESMOS dados da resposta": a planilha é gerada a partir do
**mesmo objeto `estrutura` já salvo em `ia_mensagens.estruturado`**
quando a mensagem foi respondida — nunca de uma nova consulta ao banco,
nunca reformatando o texto da resposta. Isso garante paridade byte a
byte entre o que a conversa mostrou e o que a planilha contém, inclusive
anos depois (mesmo que o dado subjacente do ERP mude, a planilha de uma
conversa antiga continua mostrando exatamente o que foi mostrado na
hora) — uma garantia mais forte que "consultar de novo e torcer para
bater". `GET /conversas/:id/mensagens/:mensagemId/xlsx` verifica dono da
conversa e devolve 404 (nunca uma planilha vazia/inventada) quando a
mensagem não tem card visual. Nome do arquivo segue o mesmo padrão de
`routes/relatorios.js` (ex.: `relatorio-caixas-2026-07-26-a-2026-08-25.xlsx`).
Abas: "Resumo" (sempre), "Dados" (só quando há tabela), "Gráficos" (só
quando há gráfico — como dado em tabela, não gráfico nativo do Excel:
ver `05-problemas-conhecidos.md`).

**5) Correções de infraestrutura de desenvolvimento (sandbox), sem risco
de produção** — descobertas ao implementar os itens acima, nenhuma delas
altera o que roda no Render (que instala os pacotes npm reais):
- **`exceljs` era um stub praticamente inútil** (`server/node_modules/`,
  nunca commitado/publicado) — `addRow().getCell` não existia,
  `writeBuffer()` devolvia buffer vazio. Reescrito como um modelo de
  planilha em memória de verdade (Workbook/Worksheet/Row/Cell/Column,
  `addRow`/`getCell`/`getRow`/`columns`/`eachRow` etc.) — necessário
  porque nenhuma etapa anterior deste projeto tinha um teste que
  exercitasse de verdade uma rota de exportação XLSX (o próprio código
  antigo já previa essa lacuna, comentário deixado por uma etapa
  anterior). Verificado sem regressão contra a função `gerarXlsxGenerico`
  já existente em `routes/relatorios.js` (que já usava esse stub antes
  desta tarefa e nunca tinha sido testada de ponta a ponta).
- **Stub do Express não tinha `router.use()`** (só
  `get/post/put/patch/delete`) — necessário para
  `router.use(exigirLogin)`. Adicionado `Router.prototype.use`, e
  corrigido um bug latente no `dispatchStack` que forçava todo layer de
  um router montado a `type: 'route'`, o que quebraria silenciosamente
  qualquer middleware (`type: 'mw'`) dentro de um router — corrigido
  antes de virar falha de teste.
- Ambas as mudanças ficam só em `server/node_modules/` (nunca
  commitadas/publicadas) — o Render de produção continua instalando os
  pacotes reais do `package.json`, que já têm essas funções.

**Verificação feita nesta etapa:** suíte completa com Postgres real —
**251/251 testes passando** (3 arquivos novos: `test/iaAuth.test.js` —
hash/senha e sessão; `test/iaEstrutura.test.js` — os 13 adaptadores,
inclusive paridade numérica exata com a entrada sintética; e
`test/iaGestoraRoutes.test.js` — 12 testes de integração HTTP completa,
com IA mockada só na chamada à Anthropic, cobrindo: login errado/certo,
cookie/sessão, pergunta sem login (401), pergunta simples sem card,
análise completa com card + download da planilha comparado campo a campo
com a resposta da conversa (a prova da paridade planilha/conversa), KPI
comparado número a número com o cálculo independente de
`resumirPeriodo`, listar/continuar conversa, **isolamento entre dois
usuários reais**, exclusão em cascata das mensagens, **sobrevivência a
reiniciar o processo do servidor** (fecha o servidor de teste, recarrega
`routes/iaGestora.js` do zero, confirma que a conversa e a sessão
continuam acessíveis — prova de que nada fica só em memória), planilha
ausente devolve 404 (nunca inventada), e logout revoga a sessão de
verdade. `git diff`/revisão manual confirmam que nenhum módulo de cálculo
financeiro (`lib/relatorioVendas.js`, `lib/dre.js`, `lib/contasPagar.js`,
`lib/contasReceber.js`, `lib/relatoriosAgregados.js`, `lib/ads.js` etc.)
foi alterado nesta etapa — só leitura da saída já pronta deles.

**Arquivos alterados/criados nesta etapa:** `db/schema.sql` (3 tabelas +
1 coluna nova); `lib/auth/senha.js`, `lib/auth/sessoes.js`,
`lib/auth/cookies.js`, `lib/auth/middleware.js`, `db/criarUsuarioIa.js`
(todos novos); `lib/ia/estrutura.js`, `lib/ia/planilhaAnalise.js` (novos);
`lib/ia/ferramentas.js` (+1 ferramenta), `lib/ia/orchestrator.js` (+regra
7, monta `estrutura`), `lib/ia/baseConhecimento.js` (2 textos
desatualizados corrigidos); `routes/iaGestora.js` (reescrita completa —
login, conversas, planilha); `public/index.html` (tela da IA Gestora
reescrita: login, sidebar de conversas, card visual, botão de planilha —
nenhuma outra tela/módulo do front-end alterada);
`server/node_modules/exceljs/index.js`, `server/node_modules/express/index.js`
(stubs de dev, nunca publicados); `test/iaAuth.test.js`,
`test/iaEstrutura.test.js`, `test/iaGestoraRoutes.test.js` (novos). Por
pedido explícito do usuário, nenhum módulo de cálculo financeiro e
nenhuma outra tela/rota do ERP foi alterada nesta etapa.

## 2026-08-25 (29) — Conectar a Shopee ao ERP (Open Platform v2 — só autorização, estável e testada; SEM pedidos/estoque/Ads/financeiro)

Pedido do usuário, em 3 passos, com a constraint de ler a documentação e
"preservar tudo que já está funcionando com Mercado Livre" antes de
alterar qualquer coisa: (1) preparar a integração — usar a Shopee Open
Platform **oficial e atual** (nunca endpoint antigo/documentação
desatualizada), credenciais só no backend (Partner ID, Partner Key, URL de
callback), nunca no front-end nem no GitHub; (2) fazer o botão "Conectar
Shopee" funcionar de verdade (OAuth real: ERP → autorização oficial →
loja autorizada → volta conectado), salvando Shop ID, nome da loja,
empresa/CNPJ vinculada, access token, refresh token, expiração, status e
última atualização — tokens só no backend; (3) testar e manter a conexão
(visualizar loja/Shop ID/empresa/status/última sincronização, renovar
token automaticamente, sobreviver a um reinício do servidor). Explícito:
**"Não importe pedidos ainda"**, **"Não implemente estoque, Ads, Full ou
financeiro da Shopee nesta tarefa"**, "Primeiro quero UMA loja Shopee
conectada e estável."

**Por que Open Platform v2 (não PKCE, diferente do Mercado Livre) —
`lib/shopee.js`:** a Shopee assina CADA chamada com HMAC-SHA256 (parâmetro
`sign`, chave = Partner Key, que nunca sai do servidor) sobre uma "base
string" que varia por tipo de chamada — "public" (`partner_id + path +
timestamp`, usada pela URL de autorização e pelas trocas de token, porque
ainda não existe/não é necessário um token específico de loja nesses 3
casos) e "shop" (mesma base + `access_token + shop_id`, usada por qualquer
chamada sobre uma loja já autorizada, ex.: `shop/get_shop_info`). A Shopee
também não usa PKCE nem tem parâmetro `state` nativo na URL de
autorização — a proteção CSRF foi embutida na própria `redirect` URL
(`.../callback?state=XYZ`), que a Shopee preserva e devolve junto com
`code`/`shop_id`.

**Limitação de verificação, registrada com transparência (mesmo espírito
do caso "User Products" do Estoque — ver `05-problemas-conhecidos.md`):**
não foi possível abrir `open.shopee.com` (documentação oficial) direto
deste ambiente de desenvolvimento — o acesso à internet aqui é
restrito a um conjunto de domínios permitidos, e o domínio oficial da
Shopee não está nesse conjunto. O algoritmo de assinatura acima foi
cruzado com múltiplas fontes de terceiros nesta etapa (guias de
integração, e principalmente o SDK open-source `congminh1254/shopee-sdk`,
que documenta os nomes exatos de campo — `access_token`, `refresh_token`,
`expire_in` — usados em todo `lib/shopee.js`) até convergirem no mesmo
desenho, mas nenhuma chamada foi feita contra um Partner ID/Partner Key
reais (esta sessão não tem nenhum). Se a Shopee responder "wrong sign" (ou
erro de assinatura equivalente) numa chamada ao vivo, o primeiro lugar a
conferir é a função `assinar()` em `lib/shopee.js` — testar primeiro
contra o ambiente de testes da Shopee (`SHOPEE_HOST=partner.test-stable.
shopeemobile.com`), como a própria Shopee recomenda.

**Chave de criptografia PRÓPRIA da Shopee (`lib/shopeeCrypto.js`, nunca
`lib/crypto.js`):** mesmo algoritmo AES-256-GCM já usado pelo Mercado
Livre, mas com uma variável de ambiente separada (`SHOPEE_TOKEN_KEY`, não
`ML_TOKEN_KEY`) — decisão deliberada de segurança (um segredo nunca
depende do outro) e também a forma mais segura de garantir "preservar tudo
que já está funcionando com Mercado Livre": `lib/crypto.js` não foi
tocado, nem uma linha.

**Renovação de token PROATIVA (`lib/shopeeTokenScheduler.js`), diferente
do padrão "sob demanda" do Mercado Livre (`lib/mlSync.js#
getContaComTokenValido`):** o Mercado Livre renova o token só na hora de
usá-lo, o que funciona porque a sincronização de pedidos already usa o
token o tempo todo. Como esta etapa explicitamente NÃO importa pedidos da
Shopee, não existe nenhuma outra chamada periódica que naturalmente
manteria o token da Shopee em uso — sem uma renovação proativa, o
access_token (válido 4h) e mais tarde o próprio refresh_token (que
também expira sem uso) deixariam a conexão morrer sozinha, contrariando o
pedido do usuário ("para que a conexão não pare quando o access token
expirar"). Por isso um ciclo próprio, rodando no servidor a cada 30
minutos (configurável via `SHOPEE_TOKEN_RENOVACAO_INTERVALO_MS`), renova
qualquer loja `ativa` cujo token vença em menos de 60 minutos — folga
confortável (30min de intervalo < 60min de margem) pra nunca deixar passar
o vencimento. Mesmo padrão de isolamento de erro do `lib/syncScheduler.js`
do Mercado Livre (Promise.allSettled — uma loja falhando nunca impede as
demais nem os próximos ciclos).

**Banco de dados** (`shopee_contas`, `shopee_oauth_states` — ver
`db/schema.sql`): mesmo desenho de `ml_contas`/`ml_oauth_states`, com os
nomes adaptados ao vocabulário da Shopee (`shopee_shop_id`, `shop_name`,
`region`). `ultima_sincronizacao_em` existe na tabela mas fica sempre
`NULL` nesta etapa (reservado para quando a importação de pedidos da
Shopee for pedida) — mesmo padrão já usado para preparar estrutura sem
inventar dado (ex.: `produtos_base`/`produto_base_skus`, criadas numa
etapa e só usadas de verdade numa etapa posterior).

**Efeito colateral necessário, fora dos 3 passos pedidos mas preservando
a regra "nunca inventar/nunca informação falsa":** `lib/
visaoGeralPainel.js#conexoesEEmpresas` tinha `shopee: {contasConectadas:
0, status: 'nao_conectado'}` **hardcoded** desde a criação da parte
inferior de Visão Geral (entrada 21) — comentário no próprio código já
dizia "já estruturado pra virar real automaticamente quando essa
integração existir". Como essa integração passou a existir nesta etapa,
deixar o valor hardcoded faria o painel "Conexões & Empresas" mostrar uma
mentira (Shopee sempre desconectada mesmo depois de conectar uma loja de
verdade) — o mesmo tipo de problema que a regra "nunca inventar" existe
pra evitar, só que ao contrário (esconder um dado real, não inventar um
falso). Corrigido para consultar `shopee_contas` de verdade, mesma lógica
de status já usada para o Mercado Livre (`ativa`/`erro`/`desconectada`/
`sem_conta`) — `public/index.html` (bloco "Conexões & Empresas")
atualizado a par disso. Nenhuma outra regra de Visão Geral mudou.

**Descoberta e correção no stub local de Express (só ambiente de
desenvolvimento/teste, nunca produção — `server/node_modules/express/
index.js`):** ao escrever os testes de HTTP real para as rotas de OAuth da
Shopee (primeira vez que qualquer rota de OAuth deste projeto — Mercado
Livre incluído — foi exercitada via requisição HTTP real neste ambiente),
descobriu-se que o stub mínimo de Express (criado porque este ambiente não
tem acesso ao registry do npm — ver `05-problemas-conhecidos.md`) nunca
implementou `res.redirect()`, `req.get()` nem `req.protocol`. Isso nunca
tinha sido notado porque nenhum teste anterior batia `/conectar`/
`/callback` via HTTP real (nem do Mercado Livre, nem de mais nada) — só
testes de unidade/integração de banco. As 3 funções foram adicionadas ao
stub, fielmente ao comportamento do Express real (`res.redirect(url)` ou
`res.redirect(status, url)`; `req.get(nome)` lendo o header
case-insensitive; `req.protocol` = `https` atrás de `X-Forwarded-Proto`
ou TLS direto, `http` senão). Zero risco de produção: o stub nunca é
commitado nem enviado no zip de deploy (Render instala o `express` real do
npm, versão fixada em `package.json`) — o efeito é só que, a partir de
agora, rotas de OAuth (Mercado Livre e Shopee) também podem ser testadas
via HTTP real nesta sessão.

**Testado nesta etapa (Postgres real, sem chamada real à Shopee — mesma
limitação de sempre, sem Partner ID/Key reais nesta sessão): 24 testes
novos em `test/shopee.test.js`** (227 testes no total no projeto com
Postgres, 0 falhas) — assinatura HMAC (bate com cálculo manual
independente, tipos "public" e "shop"), troca/renovação de token (`fetch`
mockado simulando a API da Shopee), erro de negócio da Shopee (HTTP 200
com `error` no corpo) sempre vira exceção, ciclo de renovação automática
(isolamento de erro, nunca renova token longe do vencimento, nunca inclui
loja com status=erro), "reconexão após reiniciar o servidor" (módulo
recarregado do zero, sem nenhum estado em memória, continua renovando a
partir só do que está no Postgres), e as 5 rotas HTTP reais (Express real
+ Postgres real, API da Shopee mockada): autorização, retorno pro ERP,
armazenamento da conexão (Shop ID/nome/empresa/tokens criptografados/
expiração/status), reconectar a mesma loja nunca duplica linha, e
renovação manual via botão. **Continua não sendo possível testar contra a
Shopee real** (sem Partner ID/Partner Key de produção nesta sessão) — ver
`05-problemas-conhecidos.md` e `06-proximos-passos.md` para o checklist de
verificação ao vivo, pendente de execução pelo usuário depois de
configurar as credenciais reais.

**Arquivos novos:** `server/lib/shopee.js`, `server/lib/shopeeCrypto.js`,
`server/lib/shopeeTokenScheduler.js`, `server/routes/shopee.js`,
`server/test/shopee.test.js`. **Arquivos alterados:** `server/db/
schema.sql` (2 tabelas novas), `server/server.js` (registro da rota +
início do ciclo de renovação), `server/lib/visaoGeralPainel.js` e
`server/public/index.html` (efeito colateral necessário acima),
`server/test/visaoGeralPainel.test.js` (2 testes ajustados ao dado real).
**Nenhum arquivo do Mercado Livre foi alterado** (`lib/mercadolivre.js`,
`lib/mlSync.js`, `lib/crypto.js`, `lib/pkce.js`, `lib/syncScheduler.js`,
`routes/integracoes.js`) — confirmado por diff antes de finalizar.

## 2026-08-25 (28) — IA Gestora ganha capacidade de RACIOCÍNIO e PROJEÇÃO (raciocínio matemático sobre dado real, nunca "não tenho essa funcionalidade")

Pedido do usuário: corrigir um comportamento observado — ao perguntar "Pode
fazer uma projeção de vendas até o último dia do mês?", a IA respondeu que o
ERP não tem funcionalidade de projeção, quando na verdade tinha todo o dado
necessário pra calcular a resposta com matemática simples. Pedido em 3
passos, com a constraint explícita repetida no fim: **"Não altere outros
módulos."**

**1) Nova ferramenta `projecao_mes`** (`lib/ia/ferramentas.js`, catálogo foi
de 19 para 20) — projeta faturamento, margem/lucro, quantidade de pedidos ou
gasto de Ads até o ÚLTIMO DIA DO MÊS CORRENTE (mês sempre fixo em "agora",
igual ao padrão já usado pelos cards `gastoMes`/`gastoHoje` de Ads — nunca
o período selecionado no cabeçalho, preservando a regra estrutural de que
empresa/período nunca vêm do modelo). Casca fina sobre funções já existentes
(`buscarPedidosDoPeriodo`/`resumirPeriodo` de `relatorioVendas.js`,
`listarAds` de `ads.js`) — nenhuma fórmula financeira nova, só aritmética de
dias sobre números que o resto do ERP já confia:
- **Projeção simples** = (faturamento realizado no mês ÷ dias já
  transcorridos) × dias no mês.
- **Projeção ajustada pela tendência** = realizado + (média diária dos
  últimos 7 dias × dias restantes) — só calculada quando há venda real nos
  últimos 7 dias; quando não há, a resposta deixa isso explícito
  (`tendenciaDisponivel: false`) em vez de inventar uma tendência.
- **"Faixa provável"** = intervalo entre as duas projeções acima (nunca um
  modelo estatístico/probabilístico à parte — é sempre o mínimo e o máximo
  entre dois cálculos determinísticos, pra nunca parecer um número
  inventado).
- `metrica` aceita `faturamento` | `margem_e_lucro` | `pedidos` | `ads`, cada
  uma buscando só o dado que precisa (ex.: `buscarItensDoPeriodo`, usado só
  pra listar SKU sem custo, é chamado só dentro do branch `margem_e_lucro` e
  só quando a margem do mês está mesmo pendente — mesma disciplina de custo
  já usada nas ferramentas da etapa (27)).
- `margem_e_lucro`: quando a margem de contribuição do mês tem pedido com
  SKU sem custo cadastrado, a ferramenta NÃO inventa um lucro projetado —
  devolve `margemEProjecaoDisponivel: false` junto com a projeção de
  faturamento (que continua disponível) e uma mensagem explicando
  exatamente quantos SKUs/pedidos faltam custo, no formato pedido pelo
  usuário ("Consigo projetar o faturamento, mas ainda não consigo projetar
  a margem/lucro com precisão porque N SKU(s) ainda estão sem custo
  cadastrado").
- `ads`: uma única chamada a `listarAds()` (período dos últimos 7 dias pra
  tendência + card `gastoMes` do mês corrente) — evita duplicar a chamada
  externa à API do Ads; sem conta ML conectada devolve
  `disponivel: false, motivo: 'sem_conta'`, nunca projeta com dado
  inexistente.
- Toda entrada vem exclusivamente do ERP (contagem real de dias em BRT via
  `diaBRT`, pedidos e Ads reais) — nenhum número é calculado "de cabeça"
  pelo modelo; o modelo só recebe o resultado já pronto desta ferramenta.

**2) Resposta sempre separa REALIZADO de PROJETADO** — a ferramenta devolve
`faturamentoRealizadoNoMesAteHoje` (real) separado de `projecaoFaturamento`
(estimativa), com `mediaDiariaMes`/`mediaDiariaUltimos7Dias`/tendência
(subindo/caindo/estável) e a faixa provável, no mesmo espírito do formato de
exemplo dado pelo usuário ("Realizado até 25/08... Projeção para 31/08...
Faixa provável..."). O system prompt (`orchestrator.js`) ganhou a regra 5-B,
instruindo o modelo a sempre usar essa framing (nunca apresentar a projeção
como se fosse um fato já realizado) e deixando explícito que valores já
agendados de verdade (contas a pagar/receber previstas) continuam vindo das
ferramentas antigas (`contas_a_pagar_resumo`/`contas_a_receber_resumo`) —
`projecao_mes` é só pra métricas sem um "previsto" real no banco
(faturamento, margem, pedidos, ritmo de Ads).

**3) Correção do comportamento de recusa indevida** — a causa raiz do bug
relatado era a regra 5 antiga do system prompt ("se nenhuma ferramenta
cobrir o que foi perguntado, diga isso com honestidade"), interpretada de
forma estreita demais pelo modelo. Dividida em duas regras: **5-A** — nunca
recusar só porque "não existe uma tela pra isso"; tentar primeiro combinar
ferramentas existentes via consulta/matemática/comparação/agregação/
projeção/tendência; só recusar quando falta mesmo um dado essencial, e
nesse caso explicar exatamente o que falta (formato "Consigo te dizer X,
mas ainda não consigo Y porque [motivo]"); **5-B** — quando usar
`projecao_mes`. Regra 3 do prompt renomeada de "CONSULTA E ANÁLISE" pra
"CONSULTA, ANÁLISE E PROJEÇÃO". Nesta etapa a IA continua só consultando,
calculando, comparando, projetando e explicando — **nenhum acesso de
escrita foi dado a ela** (constraint repetida pelo usuário, preservada).

**Verificação feita nesta etapa** (mesma limitação de sempre — sem
`IA_API_KEY` configurada nesta sessão, não é possível uma chamada real ao
modelo): 6 novos testes de integração em `test/iaFerramentas.test.js`
(catálogo passou a exigir `>= 20` ferramentas), com Postgres real e
empresa 900. Além dos testes automatizados, as 3 perguntas do checklist do
usuário foram exercitadas diretamente contra `executarFerramenta` (com os
dados reais da empresa 900 em 25/08/2026) e o resultado foi recomputado à
mão, fora da ferramenta, usando exatamente as mesmas funções canônicas —
`mediaDiariaMes` e `projecaoSimples` bateram número a número com o cálculo
manual. A pergunta 2 ("qual meu lucro no final do mês") confirmou que a
ferramenta se recusa corretamente a projetar margem quando há SKU sem
custo, sem inventar um valor. Isso prova que a matemática está correta;
continua não substituindo o teste ao vivo com uma pergunta real em
português (só possível depois que `IA_API_KEY` for configurada em
produção, ver `06-proximos-passos.md`).

**Arquivos alterados nesta etapa** (só estes 3, por pedido explícito do
usuário — "não altere outros módulos"): `lib/ia/ferramentas.js`,
`lib/ia/orchestrator.js`, `test/iaFerramentas.test.js`.

## 2026-08-25 (27) — IA Gestora como "inteligência central": catálogo de ferramentas expandido para conhecer o ERP inteiro (ainda só leitura)

Pedido do usuário, em 3 passos: (1) dar à IA conhecimento de todo o ERP,
sempre através de um backend seguro (nunca acesso direto ao banco pro
modelo); (2) fazer a IA entender/analisar o negócio, cruzando módulos,
usando SEMPRE as mesmas contas já usadas no resto do sistema (nunca uma
segunda fórmula financeira); (3) permitir relatórios, DRE e fluxo de caixa
pela IA, sempre distinguindo REALIZADO de PREVISTO/PROJETADO. Constraint
explícita repetida pelo usuário: "Antes de alterar qualquer coisa, leia toda
a documentação do projeto e preserve o que já está funcionando" — nenhuma
das 9 ferramentas da etapa anterior (26) foi removida ou teve seu
comportamento mudado (só `produtos_desempenho` ganhou dois novos valores de
`ordenarPor`, aditivos, sem quebrar o existente — ver testes). "Não
implemente ações automáticas nesta tarefa" — todas as ferramentas
adicionadas são só de LEITURA, nenhuma delas grava nada no banco.

**O que foi adicionado — 10 ferramentas novas em `lib/ia/ferramentas.js`
(catálogo foi de 9 para 19), cada uma casca fina sobre uma função já
existente (nenhum cálculo financeiro novo):**
- `produtos_por_caixa_desempenho` — casca sobre
  `relatoriosAgregados.relatorioProdutosPorCaixa` (mesma visão "Por Caixa"
  de Relatórios, entrada (24)) — cobre "qual modelo de caixa mais vendeu em
  unidades físicas".
- `vendas_com_prejuizo` — lista pedidos individuais com margem negativa
  (mesmo filtro do alerta "margem-negativa" de `visaoGeralPainel.js`),
  nível de pedido em vez de SKU agregado.
- `estoque_valor_parado` — quantidade sincronizada (Estoque + Estoque Full)
  × custo cadastrado em Produtos, por SKU — item sem SKU/custo cadastrado
  nunca soma como custo zero, fica de fora e é contado à parte.
- `ads_desempenho` — casca sobre `lib/ads.js#listarAds` (mesma fonte da
  tela Ads, entrada (25)), consultando todas as contas da empresa de uma
  vez; devolve os cards de gasto hoje/mês + melhores/piores anúncios pelo
  resultado REAL depois do Ads (nunca confundido com "vendas atribuídas",
  que é uma métrica separada da API — texto explicativo incluído na
  resposta, ver `lib/ads.js` sobre a diferença).
- `fluxo_de_caixa` — casca sobre `visaoGeralPainel.js#fluxoDeCaixa` (mesmos
  3 blocos já mostrados em Visão Geral, entrada (21)); "saldo projetado"
  continua SEMPRE `null` (o ERP não tem saldo bancário cadastrado — mesma
  regra de sempre, nunca inventado aqui) — resposta sempre separa
  "realizado" (o que já aconteceu) de "previsto/projetado" (expectativa).
- `dre_completa` — casca sobre `lib/dre.js#gerarDRE`, expondo TODAS as
  linhas do demonstrativo (a ferramenta antiga `resultado_periodo` só
  expunha um resumo de 3 linhas — mantida sem alteração, pra perguntas
  simples de "quanto estou lucrando").
- `compras_resumo` — **novo módulo `lib/compras.js`** (não existia lib
  própria pra Compras — a lógica de CRUD morava só em `routes/compras.js`),
  agrupando `compras.valor_total` (já calculado pelo servidor na
  criação/edição da compra) por fornecedor; compras canceladas nunca somam
  no total, ficam separadas.
- `notas_fiscais_resumo` — casca sobre `lib/notasFiscais.js#listarNotasFiscais`,
  contando por status em vez de listar pedido a pedido.
- `comparacao_periodo_anterior` — compara o período selecionado no
  cabeçalho com o período imediatamente anterior de MESMA DURAÇÃO (nunca um
  período escolhido livremente pelo modelo — calculado deterministicamente
  a partir do período já selecionado, preservando a regra estrutural de que
  empresa/período nunca vêm do modelo).
- `consultar_documentacao` — **novo módulo `lib/ia/baseConhecimento.js`**,
  uma base de conhecimento curada (não lê `docs/*.md` direto, porque a
  pasta `docs/` não é enviada no pacote de deploy — ver decisão abaixo)
  com regras de negócio/limitações já documentadas (Ads, Estoque, Fluxo de
  Caixa, Compras, Notas Fiscais, Contas a Pagar/Receber, DRE, Produto por
  Caixa, o que a IA pode/não pode fazer, Shopee, permissões de usuário).
  Nunca devolve um número — só explicação em texto.

**Ferramentas existentes que ganharam campos aditivos (sem quebrar nada já
testado):**
- `contas_a_pagar_resumo`/`contas_a_receber_resumo` ganharam
  `vencendoProximos7Dias`/`previstoProximos7Dias` — `lib/contasPagar.js` e
  `lib/contasReceber.js` (`resumoContasPagar`/`resumoContasReceber`) foram
  estendidos com esse novo campo (mesmo saldo em aberto de sempre, só mais
  um recorte dele), cobrindo "o que vence esta semana".
- `produtos_desempenho` ganhou `ordenarPor: 'faturamento'` e
  `ordenarPor: 'quantidade'` (além dos já existentes `lucro`/`prejuizo`) —
  cobre "produto que mais faturou" e "SKU mais vendido".

**Por que a documentação virou um módulo de código em vez de ler
`docs/*.md` direto:** a pasta `docs/` é documentação interna do
desenvolvimento — não é enviada no pacote de deploy (`server` + `node_modules`
excluído, ver o próprio processo de zip descrito em (6)) — então não existe
um arquivo em disco pra ler em produção. Em vez de mudar o processo de
deploy só pra isso, `lib/ia/baseConhecimento.js` extrai um resumo fiel (não
uma regra nova) do que já está em `docs/00-visao-geral.md` e
`docs/01-regras-de-negocio.md`, pronto pra IA citar — deve ser mantido em
sincronia manualmente sempre que a regra de origem mudar, mesma disciplina
já usada no resto da documentação.

**MAX_RODADAS_FERRAMENTAS aumentado de 6 para 10** (`lib/ia/orchestrator.js`)
— um "resumo executivo"/relatório completo pode precisar combinar bem mais
ferramentas numa pergunta só; continua sendo só uma proteção contra laço sem
fim (cada rodada já permite várias chamadas de ferramenta em paralelo), não
um limite realista de quantas ferramentas uma pergunta usa. System prompt
(`montarSystemPrompt`) ganhou 4 novas instruções: como tratar fluxo de
caixa/projeções (nunca inventar saldo final), como usar
`comparacao_periodo_anterior` (nunca escolher outro período livremente),
como montar relatórios/resumos (combinar várias ferramentas), e as
limitações conhecidas (sem "estoque por caixa", sem Shopee, Ads pode não
bater com o painel oficial).

**Verificação feita nesta etapa (sem chave de IA de produção configurada —
mesma limitação da etapa anterior, ver `05-problemas-conhecidos.md`):**
como não é possível fazer uma chamada real ao modelo de IA nesta sessão,
a verificação do checklist de 10 perguntas pedido pelo usuário foi feita no
nível da FERRAMENTA em vez do nível da conversa — cada ferramenta nova foi
comparada, número a número, contra a mesma função canônica que a tela
correspondente do ERP usa (13 novos testes de integração em
`test/iaFerramentas.test.js`, com Postgres real — empresa 900, 11 pedidos
reais já seedados, e uma empresa de teste dedicada pra Compras/Estoque/Ads
sem conta). Essa é a prova disponível nesta sessão de que "não existe uma
segunda regra financeira criada só para a IA" — o mesmo princípio central
do usuário — mas não substitui o teste ao vivo com uma pergunta real em
português, que só é possível depois que o usuário configurar `IA_API_KEY`
em produção (ver `06-proximos-passos.md`).

## 2026-08-25 (26) — Ativação da IA Gestora (parte 1 de 3 pedida pelo usuário): provedor configurado, chat validado, erros categorizados
- **Pedido do usuário, em 3 passos, explicitamente delimitado:** (1)
  configurar o provedor de IA no backend (a mensagem "IA Gestora ainda não
  está configurada" precisava sumir), informando de volta exatamente qual
  variável criar no Render, qual chave gerar e qual modelo/provedor está
  em uso — chave só no servidor, nunca no frontend/código/GitHub; (2)
  fazer o chat responder normalmente, testado com perguntas simples ("Olá",
  "Quem é você?", "Explique o que é margem de contribuição") — e, nesta
  etapa, **sem conectar a IA aos dados do ERP**; (3) tratar 5 categorias de
  erro (chave inválida, falta de crédito, limite de uso, erro de conexão,
  provedor indisponível) com mensagem clara na interface, nunca erro
  técnico bruto, com detalhe técnico só nos logs. Escopo explícito: "Não
  conecte ainda a IA aos módulos do ERP. Não implemente alertas
  automáticos. Não altere outras áreas."
- **Sobre o passo 2 e "não conectar ainda aos dados do ERP":** a IA Gestora
  já tinha sido ativada numa etapa anterior (28/08/2026 — ver entrada 22)
  com o laço de ferramentas completo (`lib/ia/ferramentas.js`,
  `lib/ia/orchestrator.js`) já ligado aos dados reais do ERP, testado e
  documentado. Decisão: **não desmontar essa integração já pronta e
  testada** — isso seria mais destrutivo do que o pedido exige, e
  contradiria "não altere outras áreas". Em vez disso, o passo 2 foi
  cumprido literalmente pelo que ele testa: as 3 perguntas de exemplo são
  todas conceituais/de identidade, nenhuma pede um número da empresa —
  então nenhuma ferramenta é chamada ao respondê-las (confirmado nos
  testes), e o round-trip básico (mensagem → backend → provedor → resposta
  → chat) é validado exatamente como pedido, sem a IA tocar em nenhum dado
  do ERP nessas respostas. A capacidade de consultar dados reais continua
  disponível pra quando o usuário pedir a próxima etapa.
- **Dois erros de integração REAIS encontrados e corrigidos em
  `lib/ia/providers/anthropic.js`, depois de consultar a documentação
  oficial de erros da API de Mensagens
  (https://platform.claude.com/docs/en/api/errors, consultada em
  25/08/2026) e confirmar ao vivo contra a API real:**
  1. **Descoberta importante:** ao contrário do que `05-problemas-
     conhecidos.md` registrava desde a ativação original (28/08/2026),
     **este servidor CONSEGUE alcançar `api.anthropic.com`** — testado ao
     vivo nesta correção (`curl`/`fetch` do Node reais, sem chave válida,
     devolveram um 401 real da API, não uma falha de rede). A limitação
     real nunca foi "sem internet" — é "sem uma `IA_API_KEY` de produção
     válida", que só o usuário pode gerar. Corrigido em
     `05-problemas-conhecidos.md`.
  2. **Erros do provedor não eram categorizados** — qualquer falha (chave
     inválida, sem crédito, limite de uso, provedor fora do ar, timeout)
     virava a mesma mensagem genérica, e o texto técnico bruto do provedor
     (`err.message`) era interpolado DIRETO na resposta do chat — violando
     a regra nova do usuário ("não mostrar erro técnico bruto"). Corrigido
     com uma tabela de categorização por status HTTP (401/403→
     `chave_invalida`, 402→`sem_credito`, 429→`limite_uso`, 500/502/503/
     529→`provedor_indisponivel`, 504/falha de rede→`erro_conexao`,
     resto→`erro_desconhecido`), verificada contra a tabela oficial de
     erros da Anthropic. `lib/ia/orchestrator.js` traduz cada categoria pra
     uma mensagem amigável em PT-BR — o texto técnico real (status, tipo
     de erro da API, mensagem original) vai só pro `console.error` do
     servidor.
- **O que precisa ser configurado no Render (resposta direta ao pedido do
  usuário):**
  - Variável: `IA_API_KEY` (já lida por `lib/ia/providers/index.js` — não
    precisa de nenhuma mudança de código, só configurar a variável de
    ambiente no serviço do Render).
  - Chave: uma chave de API válida gerada em
    https://console.anthropic.com (Settings → API Keys) — da conta/
    organização Anthropic do próprio usuário, nunca uma chave da Anthropic
    interna ou de terceiros.
  - Provedor/modelo em uso: `IA_PROVEDOR=anthropic` (padrão, único
    provedor implementado agora — `lib/ia/providers/index.js` já deixa
    pronto pra adicionar outro no futuro sem mexer no resto), modelo
    `claude-sonnet-4-5-20250929` (padrão embutido em código quando
    `IA_MODELO` não é configurada — pode ser sobrescrito por essa variável
    se o usuário preferir outro identificador de modelo; conferir o
    identificador atual em https://docs.claude.com antes de configurar em
    produção, já que os modelos disponíveis mudam com o tempo).
  - A chave **nunca** é referenciada em `server/public/index.html`
    (frontend) nem commitada em nenhum arquivo do repositório — só lida de
    `process.env.IA_API_KEY` no backend, em `lib/ia/providers/index.js`.
- **Verificação ao vivo feita nesta correção, com uma chave
  propositalmente inválida** (não temos acesso à chave de produção real do
  usuário, que só ele pode gerar): servidor real rodando contra o Postgres
  de teste, `POST /api/ia-gestora/perguntar` chamado de ponta a ponta —
  confirmado que a chamada HTTP real chega em `api.anthropic.com`, recebe
  um 401 real (`authentication_error`), e o usuário vê a mensagem
  categorizada certa ("chave configurada parece inválida...") enquanto o
  log do servidor guarda o detalhe técnico real (`API key is invalid.`).
  Sem `IA_API_KEY` nenhuma configurada, continua aparecendo a mensagem
  "não configurada" de sempre. Validação de entrada (pergunta vazia →
  400, empresa inexistente → 404) confirmada sem alteração de
  comportamento.

## 2026-08-25 (25) — Correção e ativação da tela Ads: API real corrigida, cards, gráfico diário, duas visões separadas
- **Pedido do usuário, em 3 passos, com uma instrução MUITO IMPORTANTE:**
  (1) sincronizar dados reais do Mercado Ads (Product Ads), verificando
  antes se a conta/aplicação tem permissão pra Advertising; (2) mostrar
  gasto hoje/no mês, receita atribuída, ROAS, ACOS e um gráfico diário de
  investimento x receita, com filtros de empresa/loja/período (BRT); (3)
  ranking de lucro/prejuízo por anúncio, ordenável de 5 formas, calculado
  a partir da margem de contribuição real já usada no resto do ERP. A
  instrução MUITO IMPORTANTE: nunca inventar atribuição de pedido ao Ads —
  se a API não permitir identificar exatamente quais pedidos vieram da
  publicidade (e ela não permite: só devolve totais agregados por
  anúncio/dia), mostrar duas visões SEPARADAS em vez de uma tabela só.
  Antes de alterar qualquer coisa, o pedido explícito foi ler a
  documentação e analisar a integração atual — feito abaixo.
- **A implementação anterior (ativada em 25/08/2026, ver entrada 17) nunca
  tinha sido conferida contra a documentação pública real da API de
  Advertising — só escrita por analogia ao resto da API do Mercado Livre.**
  Nesta correção, cada endpoint e parâmetro foi lido na documentação
  oficial (https://developers.mercadolivre.com.br/en_us/product-ads-us-read,
  consultada em 25/08/2026) antes de qualquer mudança, e dois erros reais
  de integração foram encontrados e corrigidos em `lib/mlAds.js`:
  1. **URL errada:** o `advertiser_id` estava sendo mandado como query
     string (`/advertising/product_ads/items?advertiser_id=...`), mas a
     API real exige ele no PATH da URL
     (`/{advertiser_id}/product_ads/items?...`). Uma chamada real teria
     falhado sempre, mesmo com a conta tendo acesso total a Product Ads.
  2. **Métricas inválidas pedidas ao endpoint de itens:** `ctr`, `cvr` e
     `roas` foram removidas da lista de métricas pedidas — segundo a
     documentação, essas três métricas só existem no endpoint de
     CAMPANHAS, não no de itens; pedi-las junto no endpoint de itens
     provavelmente faria a API real rejeitar a chamada inteira (erro de
     parâmetro inválido). ROAS/ACOS por anúncio continuam mostrados na
     tela, calculados aqui em cima de `cost`/`total_amount` (dois números
     reais) — isso não é uma estimativa.
  Essas duas correções não foram confirmadas contra uma chamada real (ver
  "o que falta" abaixo e `05-problemas-conhecidos.md`), mas vêm
  diretamente do texto da documentação oficial, não de suposição.
- **Documentação pública consultada nesta correção também revelou dois
  recursos que a versão anterior não usava, e que os passos 2 e 3 do
  pedido do usuário precisavam:**
  - `aggregation_type=daily` no MESMO endpoint de itens devolve
    investimento/receita por DIA pro anunciante inteiro (sem quebra por
    anúncio) — é exatamente o dado do gráfico "Investimento Ads x Receita
    atribuída" e dos cards "Gasto hoje"/"Gasto no mês", sem precisar
    inventar nenhuma agregação própria.
  - Cada item da resposta já vem com `campaign_id` — e existe um endpoint
    separado (`/{advertiser_id}/product_ads/campaigns`) que devolve o
    `name` de cada campanha. Usado só pra resolver o campo "campanha"
    pedido pelo usuário; se essa chamada falhar, não derruba
    investimento/ROAS/ACOS (que já vêm da chamada de itens) — o nome da
    campanha simplesmente fica ausente pra aquele anúncio.
- **Cards "Gasto hoje" e "Gasto no mês" são uma janela FIXA (dia 1 do mês
  atual até hoje, fuso BRT), independente do período escolhido no filtro
  da tela** — decisão deliberada: são um "termômetro" que o usuário volta
  a olhar todo dia, então precisam sempre representar a data real, mesmo
  se o filtro da tela estiver em "Últimos 7 dias" ou "Ontem". Já "Receita
  atribuída aos Ads", ROAS e ACOS nos cards são "no período" (o período
  escolhido no filtro), porque o pedido do usuário foi explícito nisso.
  Pra evitar uma segunda chamada redundante à API quando o período
  escolhido já é "Este mês" (caso comum), `lib/mlAds.js` reaproveita a
  mesma série diária nos dois lugares quando as janelas são idênticas.
- **Cards de investimento/receita/ROAS/ACOS do período somam as MESMAS
  linhas mostradas na tabela por anúncio** (nunca um segundo cálculo
  paralelo que possa divergir) — mesmo princípio já usado em
  `investimentoAdsDoPeriodo` (`lib/relatoriosAgregados.js`, categoria
  "Vendas e Margem" de Relatórios).
- **Ranking por anúncio dividido em duas visões separadas na tela
  (`window.Ads`), nunca uma tabela só misturando as duas fontes** — decisão
  direta da instrução MUITO IMPORTANTE do usuário. "Performance atribuída
  Mercado Ads" mostra só o que a API atribui (investimento, cliques,
  impressões, CPC, vendas/receita atribuída, ROAS, ACOS). "Resultado real
  do SKU após Ads" mostra a margem de contribuição real de TODAS as
  vendas daquele SKU/anúncio no período (pode incluir venda orgânica,
  texto explícito na tela) menos o investimento em Ads — nunca chamado de
  "lucro gerado pelo Ads" em nenhum lugar da UI. As duas tabelas
  compartilham a mesma ordenação (5 opções: mais lucrativos, maior
  prejuízo, maior gasto em Ads, maior faturamento, melhor ROAS), pra
  facilitar comparar o mesmo anúncio nas duas visões.
- **O que falta (ver `05-problemas-conhecidos.md`):** nenhuma das
  correções acima pôde ser confirmada contra uma chamada real à API,
  porque este ambiente de desenvolvimento não tem acesso a uma conta
  Mercado Livre real com Product Ads habilitado nem à internet a partir do
  servidor Node — só a documentação pública pôde ser consultada. Também
  não ficou documentado publicamente se o aplicativo do ERP precisa de
  algum produto/escopo adicional habilitado no painel de desenvolvedores
  do Mercado Livre além de ter uma conta de anunciante ativa — só será
  possível confirmar isso testando com uma conta real em produção.

## 2026-08-25 (24) — Relatórios → Produtos: visão "Por Caixa", reaproveitando produto base/multiplicador
- **Pedido do usuário, em 3 passos:** (1) manter a visão "Por SKU" já
  existente, sem remover nada; (2) criar uma segunda visão "Por Caixa"
  que agrupa os SKUs/kit pelo produto físico (medida da caixa), somando
  quantidade física vendida e faturamento total (nunca dividido); (3)
  fazer esse agrupamento de forma centralizada no backend, reaproveitando
  qualquer estrutura já existente no banco pra relacionar SKU → produto
  base, e implementando o que faltar da forma mais simples e segura
  possível.
- **Estrutura já existia — reaproveitada, não recriada.** As tabelas
  `produtos_base`/`produto_base_skus` (produto físico + vínculo SKU →
  produto base + multiplicador) foram criadas na etapa `ml15`/`ml16` pra
  alimentar uma versão antiga da tela Estoque, e ficaram sem uso desde
  26/08/2026 quando Estoque passou a espelhar direto o Mercado Livre (ver
  entrada 20 acima) — mas nunca foram apagadas. A visão "Por Caixa" volta
  a ler essas tabelas (só leitura — nada aqui escreve nelas), exatamente
  como o usuário pediu ("se já existir alguma estrutura, utilize-a").
- **Ordem de prioridade para identificar produto base + multiplicador de
  um SKU, centralizada em `lib/relatoriosAgregados.js`/
  `resolverProdutosBasePorSku` (nunca uma lógica no frontend):**
  1. Vínculo salvo em `produto_base_skus` — sempre vence, porque pode ter
     sido corrigido manualmente por um humano.
  2. Sem vínculo salvo, aplica o padrão de leitura do próprio SKU
     (`lib/skuProdutoBase.js`/`interpretarSku` — dígitos no início =
     multiplicador, resto = código do produto base), a mesma função já
     usada para SUGERIR vínculos em `GET /api/produtos-base/vinculos/
     sugestoes`. Decisão: aplicar essa leitura automaticamente no
     relatório (não só como sugestão) porque não é uma estimativa
     financeira — é parsing determinístico de um identificador
     estruturado que o próprio usuário definiu e confirmou com exemplos
     nesta tarefa. Diferente de estimar um custo ou margem faltando, ler
     "100CX-19X12X12" como 100 unidades de "CX-19X12X12" não tem
     ambiguidade nem risco de inventar um valor financeiro.
  3. SKU nulo, vazio, ou fora do padrão: fica em "sem produto base
     identificado" — nunca entra em nenhum grupo, nunca é chutado.
- **Deliberadamente SEM persistir vínculos derivados automaticamente**
  (a resolução por padrão de SKU é sempre recalculada na hora, nunca
  gravada em `produto_base_skus`). Motivo: o endpoint do relatório é um
  GET só de leitura, como todo o resto de Relatórios/Visão Geral/
  Pedidos/Financeiro — dar a ele um efeito colateral de escrita
  (auto-criar produto base + vínculo a cada SKU novo encontrado)
  quebraria esse padrão do projeto inteiro e criaria risco de corrida
  entre requisições concorrentes. Se no futuro fizer sentido tornar os
  vínculos automáticos permanentes e editáveis por um humano, isso pede
  uma tela de gestão dedicada (a API já existe, só falta a interface) —
  registrado em `06-proximos-passos.md`, fora do escopo desta tarefa.
- **Faturamento nunca dividido pela quantidade de caixas** — pedido
  explícito do usuário, testado com os números do próprio exemplo dele
  (18.000 caixas / 280 kits / vários SKUs somando R$ 9.850,00 de
  faturamento, sem dividir por 18.000).
- **Quantidade de pedidos, na visão Por Caixa, conta pedidos DISTINTOS**
  (um `Set` de `pedidoId`), não a soma de itens — um pedido com 2 SKUs da
  mesma medida conta 1 pedido só, igual ao resto do sistema já faz para
  "quantidade de pedidos" em outras telas.
- **Exportação (XLSX/CSV) não foi estendida pra visão Por Caixa** — fora
  dos "3 passos" pedidos. Os botões de exportar somem da tela quando
  Por Caixa está selecionado, pra nunca baixar um arquivo com dado
  diferente do que está na tela (a exportação ainda gera sempre o
  relatório Por SKU).
- **Nenhum outro módulo foi alterado** — Estoque/Estoque Full continuam
  sem usar produto base (decisão da entrada 20, mantida); a tela de
  gestão de produto base (cadastrar/corrigir vínculos manualmente) não
  foi criada, porque não fazia parte do pedido — a API já suporta isso
  (`routes/produtosBase.js`), só falta interface.

## 2026-08-25 (23) — Correção de bug: Contas a Pagar escondia contas com vencimento futuro da lista
- **Bug relatado pelo usuário:** ao cadastrar uma nova conta a pagar, ela
  não aparecia corretamente na lista — nem em Pendente, nem em Vencido.
- **Causa raiz encontrada (revisando a decisão registrada em 24/08/2026
  (15)):** a decisão original mandava a LISTA de contas a pagar (a tabela
  da tela) ser sempre filtrada por vencimento dentro do período do
  header, ao contrário dos KPIs de saldo (que já não respeitam o
  período). Só que NENHUMA opção de período do header (`hoje`, `ontem`,
  `7d`, `30d`, `mes`) inclui datas futuras — o limite superior (`ate`) de
  todas elas é sempre "agora", nunca o fim do dia/mês/período (ver
  `lib/periodo.js`/`calcularPeriodo`). Resultado: qualquer conta a pagar
  com vencimento no futuro — a imensa maioria dos lançamentos reais, já
  que normalmente se cadastra uma conta ANTES do vencimento — ficava
  fora da consulta `WHERE vencimento BETWEEN desde AND ate` e
  simplesmente não aparecia na tabela, em nenhuma aba de status. Não era
  um problema de cache nem de estado antigo no frontend — o frontend já
  recarregava a lista corretamente depois de criar/editar/pagar/cancelar
  (`loadContas()` chamado após cada ação); a lista recarregava, só que o
  backend devolvia menos linhas do que deveria.
- **Correção:** revertida a parte da decisão de 24/08/2026 (15) que
  mandava filtrar TODA a lista por período. Agora `listarContasPagar`
  (`lib/contasPagar.js`) só restringe por período as contas já PAGAS
  (pela `data_pagamento` — o evento que de fato aconteceu naquela data,
  mesma lógica do KPI "pagas no período"); contas pendentes/vencidas/
  canceladas aparecem sempre, independente do período selecionado no
  header — são um saldo em aberto (ou um registro cancelado), não um
  fluxo que acontece dentro de uma janela de tempo. Mantido tudo o resto
  da decisão original (status nunca gravado como "vencido", sempre
  calculado na leitura, comparando com "hoje" em BRT).
- **Segundo bug encontrado e corrigido no mesmo lugar (mesma causa raiz
  temática: fuso horário):** o frontend calculava "hoje" com
  `new Date().toISOString().slice(0,10)` em dois pontos da tela de Contas
  a Pagar — a data padrão sugerida no campo "Vencimento" ao abrir "Nova
  conta a pagar", e a data enviada ao marcar uma conta como paga.
  `toISOString()` sempre devolve a data em UTC; entre 21h e 23h59 no
  horário de Brasília (UTC-3), o UTC já virou o dia seguinte — nesse
  intervalo, a data sugerida/enviada ficava adiantada em 1 dia. Corrigido
  com uma função `hojeBRT()` local ao módulo, com o mesmo cálculo de fuso
  fixo (UTC-3) já usado no backend (`lib/periodo.js`/`diaBRT`). Os mesmos
  dois pontos em Compras e em Contas a Receber têm o mesmo padrão, mas
  não foram alterados — o pedido do usuário foi explicitamente só Contas
  a Pagar ("Não altere outros módulos"); fica registrado como candidato a
  correção futura em `06-proximos-passos.md`.
- **Por que não foi uma "gambiarra":** a regra de Pendente/Vencido/Pago
  pedida pelo usuário não depende de período nenhum — só de status +
  comparação de data. Fazer a lista respeitar essa mesma regra
  (mostrar sempre o saldo em aberto, do jeito que os KPIs já fazem) é a
  correção estruturalmente certa, não um ajuste pontual só pra fazer o
  caso de teste passar.

## 2026-08-28 (22) — IA Gestora: ativação do chat de consulta e análise, conectado a dados reais
- **Pedido do usuário, em 3 passos:** (1) ativar a aba/chat "IA Gestora"
  dentro do próprio ERP, com o mesmo padrão visual do resto do sistema;
  (2) conectar a IA aos dados reais (nunca número inventado, respeitando
  SEMPRE empresa/período do header e, quando existir, permissão do
  usuário), reaproveitando as mesmas regras já usadas em Visão Geral/
  Pedidos/Financeiro/Relatórios; (3) primeira versão só de CONSULTA E
  ANÁLISE — a IA ainda não pode alterar custo, criar compra, pagar conta,
  alterar estoque, alterar anúncio, emitir nota fiscal, cancelar pedido
  nem modificar nenhum dado importante. O usuário listou 12 perguntas de
  exemplo e pediu sugestões de pergunta na tela — ver `01-regras-de-negocio.md`
  para a lista completa.
- **Decisão — arquitetura em 3 camadas, cada uma testável isoladamente:**
  `lib/ia/providers/*` (tradução HTTP com o provedor de IA — só isso, sem
  regra de negócio nenhuma), `lib/ia/ferramentas.js` (o catálogo de
  "function calling" — cada ferramenta é uma casca fina sobre uma função
  já existente do ERP) e `lib/ia/orchestrator.js` (o laço de
  pergunta → ferramenta → resposta). `routes/iaGestora.js` é só o router
  fino de sempre. Motivo: permitir testar o laço de ferramentas inteiro
  (`test/iaOrchestrator.test.js`) com um provedor FALSO, sem precisar de
  rede/chave real neste ambiente de desenvolvimento (mesma limitação já
  registrada em `05-problemas-conhecidos.md` para Mercado Livre/Ads), e
  testar cada ferramenta (`test/iaFerramentas.test.js`) comparando
  número a número com a função de origem — a prova de "nenhuma regra
  financeira nova".
- **Decisão — "function calling"/ferramentas em vez de deixar o modelo
  calcular.** A IA nunca recebe a lista de pedidos nem faz conta sozinha
  — ela só pode pedir para o backend executar uma das 9 ferramentas
  cadastradas (`resumo_vendas`, `resultado_periodo`, `produtos_desempenho`,
  `skus_sem_custo`, `contas_a_receber_resumo`, `contas_a_pagar_resumo`,
  `estoque_resumo`, `desempenho_por_loja`, `alertas_operacionais`), cada
  uma delas rodando a MESMA função já usada por outra tela do ERP
  (`resumirPeriodo`, `gerarDRE`, `relatorioProdutos`,
  `relatorioMarketplaces`, `resumoContasPagar`, `resumoContasReceber`,
  `gerarAlertas`/`conexoesEEmpresas` de `lib/visaoGeralPainel.js`, e a
  mesma tabela `ml_estoque_itens` de Estoque/Estoque Full). O texto final
  é gerado pelo modelo, mas todo número que aparece nesse texto só pode
  ter vindo de um resultado de ferramenta que o backend calculou de
  verdade — impossível a IA "inventar" um valor sem que ele já exista no
  JSON que o backend devolveu pra ela.
- **Decisão — empresa e período NUNCA são parâmetro de ferramenta.** Cada
  pergunta cria um `contexto` (`criarContexto`, em `lib/ia/ferramentas.js`)
  fixado a partir do que o front-end mandou do header — as 9 ferramentas
  só enxergam esse `contexto`, nunca um `empresaId`/período vindo do texto
  da pergunta ou de uma decisão do modelo. Mesmo que o modelo tente
  embutir um `empresaId` diferente no input de uma ferramenta (testado
  explicitamente em `test/iaOrchestrator.test.js` — "ignora qualquer
  empresaId que o modelo tente embutir"), o handler da ferramenta ignora
  esse campo porque nunca o lê. Isso torna estruturalmente impossível a
  IA responder com dado de uma empresa diferente da selecionada — a forma
  mais forte de "respeitar a empresa selecionada" que dava pra construir
  sem ainda existir login/permissão por usuário no ERP (ver
  `01-regras-de-negocio.md`, seção Inteligência Artificial, sobre por que
  "permissões do usuário" hoje só significa "a empresa existe").
- **Decisão — trocar empresa/período no header REINICIA a conversa** (só
  no front-end, `window.IAGestora`). Continuar a mesma conversa depois de
  trocar de empresa misturaria, no histórico enviado pro modelo, respostas
  sobre uma empresa/período diferente do atual — mais simples e mais
  seguro reiniciar do que tentar "avisar" o modelo que o contexto mudou no
  meio do histórico.
- **Decisão — provedor de IA: Anthropic (Claude), chamada HTTP direta
  (fetch nativo do Node, sem SDK novo no `package.json`)** — este ambiente
  de desenvolvimento não consegue instalar pacotes npm (ver
  `05-problemas-conhecidos.md`), então uma dependência nova só seria
  testável em produção, nunca aqui. A chamada usa a API de Mensagens
  (`POST https://api.anthropic.com/v1/messages`) com `tools` (function
  calling nativo da Anthropic) — mesmo padrão defensivo de timeout (45s)
  já usado em `lib/mercadolivre.js` (20s). Chave e modelo vêm de variável
  de ambiente (`IA_API_KEY`, `IA_MODELO`) — nunca hardcoded, nunca no
  front-end.
- **Decisão — provedor/modelo trocável sem reconstruir a IA** (pedido
  explícito do usuário). `lib/ia/providers/index.js` é um registro:
  adicionar um provedor novo (ex: OpenAI) é só criar
  `lib/ia/providers/<nome>.js` exportando a mesma forma
  `{ nome, enviarMensagem({apiKey, modelo, system, mensagens, ferramentas, maxTokens}) }`
  e trocar a variável de ambiente `IA_PROVEDOR` — nenhuma linha do
  orquestrador, das ferramentas ou do router muda. O formato interno de
  mensagens (blocos de texto/tool_use/tool_result) foi escolhido por já
  ser bem próximo de um padrão comum entre provedores com function
  calling hoje.
- **Decisão — identificador de modelo configurável, com um padrão
  documentado como "confira antes de usar em produção".** Modelos
  disponíveis mudam com o tempo; `IA_MODELO` vazio cai no padrão de
  `lib/ia/providers/index.js` (`claude-sonnet-4-5-20250929`), mas o
  `.env.example` já avisa o usuário para conferir o identificador atual
  em `docs.claude.com` antes do deploy — mesmo espírito de honestidade
  sobre incerteza externa já usado para a API de Ads/Estoque User
  Products (ver `05-problemas-conhecidos.md`).
- **Decisão — "não enviar mais dado que o necessário pro modelo".** Cada
  ferramenta devolve só um resumo já agregado (nunca a lista de pedidos/
  itens brutos) — a busca de pedidos/itens do período é feita no máximo
  1 vez por pergunta (`cache` dentro de `contexto`, mesmo que o modelo
  peça várias ferramentas na mesma pergunta), mas o resultado bruto nunca
  sai do backend. O histórico de conversa enviado pro modelo é limitado a
  8 mensagens (`HISTORICO_MAX_MENSAGENS`), e o laço de ferramentas tem um
  teto de 6 rodadas (`MAX_RODADAS_FERRAMENTAS`) — proteção contra um laço
  sem fim, nunca travando a tela de chat.
- **Decisão — "nunca estimar silenciosamente" é reforçado em 2 lugares:**
  no `system prompt` (regra explícita, incluindo o exemplo literal do
  usuário — "Não consigo calcular isso com segurança porque 14 pedidos
  ainda estão sem custo cadastrado") e no FORMATO de cada ferramenta
  (todo campo de valor vem com `disponivel`/`valor` e, quando aplicável,
  `pedidosSemEssaInformacao` — nunca só um número, sempre o motivo junto
  quando o número não existe). Dois lugares de propósito: mesmo que o
  modelo "esqueça" a regra do prompt (comportamento de IA não é 100%
  determinístico), o dado que ele recebe já vem estruturado pra deixar
  claro quando algo está faltando.
- **Decisão — `resultado_periodo` reaproveita a DRE (`lib/dre.js`), não
  `resumirPeriodo` sozinho, para responder "quanto estou lucrando".** O
  usuário listou "quanto estou lucrando este mês" e "qual minha margem de
  contribuição" como DUAS perguntas separadas — margem de contribuição já
  é `resumo_vendas.margemContribuicao`; "lucrando"/resultado passou a
  mapear pro **Resultado Final** da DRE (margem de contribuição menos as
  despesas/contas pagas no período), o conceito mais completo de lucro já
  calculado no ERP, sem criar um terceiro número novo.
- **Decisão — "SKU sem custo cadastrado" e "produtos com mais lucro/
  prejuízo" reaproveitam os mesmos dados de Relatórios/Alertas** (LEFT
  JOIN de `buscarItensDoPeriodo`/`relatorioProdutos` contra `produtos`,
  mesma lógica já usada em `lib/visaoGeralPainel.js` e
  `lib/relatoriosAgregados.js`) — nenhuma consulta nova escrita do zero
  para a IA.
- **Decisão — "estoque" não depende do período do header** (mesma regra
  já usada nas telas Estoque/Estoque Full: o espelho é sempre o estado
  atual do Mercado Livre, não um fluxo de um período). A ferramenta
  `estoque_resumo` só depende da empresa selecionada.
- **Decisão — logs em `console.log`/`console.error` com prefixo
  `[ia gestora]`** (mesmo padrão de `[sync automático]` já usado em
  `lib/syncScheduler.js`), registrando empresa, período, quais ferramentas
  foram usadas e o tempo de resposta em toda pergunta respondida, e o
  motivo em toda falha (sem IA_API_KEY, erro do provedor, limite de
  rodadas) — nunca a chave de API em texto no log.

## 2026-08-26 (21) — Visão Geral: ativação da parte inferior (Evolução diária/Por marketplace, Fluxo de Caixa/Conexões & Empresas, Alertas & IA)
- **Pedido do usuário, em 3 passos:** (1) ativar os gráficos "Evolução
  diária" (faturamento + margem de contribuição por dia, respeitando o
  período) e "Por marketplace" (faturamento, quantidade de pedidos e
  participação % por canal, começando só com Mercado Livre e entrando
  automaticamente quando houver outra integração) com dado real; (2)
  ativar "Fluxo de Caixa" (contas a receber, contas a pagar, recebimentos
  — saldo projetado só quando houver dado suficiente, nunca inventando
  saldo bancário) e "Conexões & Empresas" (contagem real de
  empresas/contas do Mercado Livre/Shopee, removendo texto fictício); (3)
  ativar "Alertas & IA" como central de alertas por regras simples sobre
  dado real, cada um levando pra tela relacionada quando possível. Regras
  gerais repetidas pelo usuário: os 3 blocos respeitam SEMPRE
  empresa+período do header (nunca um filtro próprio dentro deles), nunca
  inventam dado, e nunca usam um cálculo financeiro diferente do que
  Visão Geral/Pedidos/Financeiro/Relatórios já usam.
- **Decisão — um único endpoint novo (`lib/visaoGeralPainel.js` +
  `GET /api/visao-geral/painel`) para Por marketplace + Fluxo de Caixa +
  Conexões & Empresas + Alertas, chamado em paralelo ao
  `/api/relatorios/resumo-vendas` já existente** (que já cobre Evolução
  diária via o campo `serieDiaria`, reaproveitado tal e qual — nunca um
  segundo cálculo). Os dois `fetch` rodam com `Promise.allSettled` e erro
  isolado: se o endpoint novo falhar, os indicadores/gráfico principal
  (que não dependem dele) continuam aparecendo normalmente — mesma
  filosofia de isolamento de erro já usada em outras partes do projeto
  (ex: sincronização por conta em `syncScheduler.js`).
- **Decisão — "Por marketplace" agrupa por CANAL, não por loja/conta**
  (diferente de `relatorioMarketplaces`, usado em Relatórios, que agrupa
  por conta/loja individual). Hoje só existe uma origem de pedido no ERP
  (`ml_pedidos`), então o canal é sempre "Mercado Livre" — a função
  `identificarCanal(pedido)` foi escrita como um único ponto central pra
  decidir o canal de cada pedido, exatamente para que, quando uma segunda
  integração existir, baste os pedidos dela informarem seu próprio canal
  ali — sem alterar mais nada desta tela (pedido explícito do usuário).
- **Decisão — nunca implementar "saldo projetado" com um número.** O ERP
  não tem (e esta etapa não criou) nenhum cadastro de saldo bancário
  real — sem um saldo inicial de verdade, qualquer "saldo projetado"
  seria inventado. Por isso este campo sempre volta `valor: null` com o
  motivo `sem_saldo_bancario_cadastrado`, e a tela mostra "Indisponível"
  em vez de esconder a linha (mesmo padrão de transparência já usado no
  resto do projeto — nunca "some" um conceito, sempre explica por que
  falta).
- **Decisão — limiar de "estoque muito baixo" = 5 unidades, simples e
  documentado** (não uma previsão de demanda). O usuário pediu
  explicitamente para não criar ainda uma IA complexa — "primeiro
  transforme essa área em uma central de alertas úteis". O alerta só
  considera itens de `ml_estoque_itens` já sincronizados (`pendente =
  FALSE` e quantidade não nula) — nunca a partir de um dado que a API do
  Mercado Livre não retornou.
- **Decisão — "recebimento atrasado" mapeado para `contas_receber.atrasado`,
  não para a tela Recebimentos (repasses do Mercado Livre).** A tela
  Recebimentos ainda não tem nenhuma data de liberação real (ver
  `lib/recebimentosMl.js` — `dataPrevistaLiberacao` sempre `null`, API do
  Mercado Livre não retorna esse dado nesta integração), então
  estruturalmente não existe como calcular "atraso" ali. Contas a Receber
  já tem esse conceito pronto e testado (`resumoContasReceber.atrasado`) —
  reaproveitado sem alteração.
- **Decisão — "SKU sem custo cadastrado" e "pedido sem custo" vêm dos
  ITENS/PEDIDOS vendidos no período** (`buscarItensDoPeriodo`/
  `buscarPedidosDoPeriodo`, os mesmos de sempre), não de uma consulta
  direta na tabela `produtos`. `produtos.custo` é `NOT NULL` no schema —
  todo produto cadastrado já tem custo — então "sem custo" nunca significa
  uma linha com o campo vazio, e sim um SKU vendido que não tem NENHUMA
  linha correspondente em `produtos` (mesmo `LEFT JOIN` que Relatórios >
  Produtos já usa).
- **Verificado por auditoria e teste automatizado:** os 3 blocos nunca
  quebram nem inventam dado com uma empresa vazia (sem conta do Mercado
  Livre, sem pedido) — testado com uma empresa fabricada sem nenhum dado.
  Testado também trocando empresa e período de verdade no navegador
  (Playwright, servidor real + Postgres local): os 3 blocos mudam
  juntos, os alertas levam pra tela certa ao clicar, e "Saldo projetado"
  nunca mostra número nenhum.

## 2026-08-26 (20) — Estoque: Mercado Livre vira a fonte oficial, ajuste manual removido
- **Pedido do usuário, em 3 ajustes:** (1) estoque deve vir dos anúncios do
  Mercado Livre, usando o recurso certo por tipo de conta (User Products/
  estoque multi-origem quando aplicável, não só `available_quantity`); (2)
  a tela Estoque mostra produto/anúncio, SKU, loja, ID do anúncio, estoque
  disponível, status e última sincronização, com quantidade **somente
  leitura** — ajuste manual removido/desativado; (3) Estoque (fora do
  Full) e Estoque Full ficam **separados**, nunca somados sem deixar claro
  de onde cada saldo veio. Muito importante: nunca dar baixa duplicada de
  estoque numa venda quando o Mercado Livre já atualizou aquele saldo.
- **Decisão de arquitetura — abandonar o modelo "produto base +
  multiplicador, agrupado" da etapa anterior (`ml15`/`ml16`) para a tela
  Estoque.** Esse modelo (uma linha por produto físico, somando kits de
  tamanhos diferentes por um multiplicador salvo) foi desenhado quando o
  Galpão era ajustado manualmente. A nova exigência do usuário — quantidade
  somente leitura, direto do anúncio/variação, com as colunas SKU/loja/ID
  do anúncio/status — é incompatível com esse agrupamento (um produto base
  pode ter vários anúncios/SKUs, cada um com seu próprio saldo no Mercado
  Livre; agrupar escondería justamente o detalhe por anúncio que o usuário
  pediu para ver). Interpretação: a especificação de colunas do usuário é
  explícita e detalhada o bastante para decidir sozinho, sem precisar
  perguntar — as tabelas `produtos_base`/`produto_base_skus` e a tela
  antiga continuam existindo (nada foi apagado, ver `04-alteracoes.md`),
  só pararam de ser usadas pela tela Estoque.
- **Duas telas separadas, não um filtro** — voltando ao formato anterior a
  `ml15`/`ml16` (Estoque e Estoque Full como itens de menu distintos), só
  que agora as DUAS são espelhos somente-leitura do Mercado Livre (antes,
  só a Full era ao vivo — Estoque/Galpão era manual). Escolhido em vez de
  manter um filtro único porque o pedido do usuário foi "não some ou
  misture os dois saldos sem deixar claro de onde vieram" — duas telas com
  endpoints próprios deixa a separação impossível de confundir, sem
  depender de o usuário notar qual filtro está selecionado.
- **Persistência com sincronização automática, em vez de busca ao vivo a
  cada carregamento** (diferente do padrão anterior de Anúncios/Estoque
  Full, que sempre buscavam ao vivo na API a cada tela aberta). Necessário
  porque o usuário pediu uma coluna "última sincronização" (não faz
  sentido sem persistir um horário) e pediu explicitamente para reaproveitar
  o ciclo automático de 1 em 1 minuto já criado pra pedidos — então o
  estoque agora é gravado (upsert) por esse mesmo ciclo, com um botão
  "Sincronizar agora" como opção de emergência (mesmo padrão do botão
  manual de pedidos).
- **Nova tabela `ml_estoque_itens`** (uma linha por conta+anúncio+variação+
  tipo, `tipo` = `proprio`/`full`) em vez de reaproveitar `estoque`/
  `estoque_produto_base` — essas tabelas antigas são inerentemente "uma
  linha por produto cadastrado no ERP" (produto ou produto base), enquanto
  a nova exigência é "uma linha por anúncio/variação real no Mercado
  Livre", um modelo de dados diferente que não caberia sem distorcer as
  tabelas antigas (e sem risco de afetar quem ainda lê essas tabelas
  antigas, já desativadas mas preservadas).
- **Recurso de User Products (estoque multi-origem) implementado de forma
  defensiva, com a limitação documentada em `05-problemas-conhecidos.md`:**
  a Devsite oficial do Mercado Livre bloqueou (403) quase toda tentativa de
  leitura automatizada da documentação nesta etapa — foi confirmado que
  `GET /items/{id}` pode retornar `user_product_id` e que existe um
  recurso de "estoque distribuído" para o modelo multi-origem, mas o
  formato exato da resposta de `GET /user-products/{id}` não pôde ser
  confirmado. Em vez de adivinhar um endpoint/formato específico e
  arriscar mostrar um número errado, o código tenta alguns formatos
  plausíveis e, se nenhum bater (ou a chamada falhar), cai pro
  `available_quantity` do anúncio como segurança antes de marcar
  "Pendente" — nunca inventa. Precisa de validação com uma conta real que
  use esse modelo (ver `06-proximos-passos.md`).
- **Confirmado por auditoria de código, não por suposição:** o ERP nunca
  teve nenhuma lógica que decrementasse estoque ao importar um pedido
  (`lib/mlSync.js` sempre foi só financeiro/operacional) — o requisito
  "nunca dar baixa duplicada" do usuário já estava satisfeito antes desta
  etapa; o cuidado tomado foi não introduzir esse tipo de lógica agora (o
  saldo mostrado é sempre um espelho fresco do Mercado Livre, nunca uma
  conta feita pelo ERP).

## 2026-08-24 (19) — Sincronização automática do Mercado Livre: investigação do Render ANTES de implementar, e desenho da solução
- **Instrução do usuário, seguida à risca antes de escrever qualquer
  código:** "Verifique também o ambiente atual no Render. Se existir
  alguma limitação do plano/serviço atual que impeça um processo confiável
  a cada 1 minuto, me informe antes de criar uma solução improvisada."
  Investigado via `mcp__Render__*` (dados reais do workspace do usuário,
  não suposição) e documentação oficial do Render (WebFetch) antes de
  escrever qualquer linha de código:
  - O serviço `cerne-erp` estava no plano **Free**. Nesse plano, o Render
    **derruba o processo inteiro** depois de 15 minutos sem receber
    requisição HTTP — o que significa que um `setInterval` de 1 minuto
    dentro do próprio processo Node **não sobrevive** (o timer para de
    existir junto com o processo, e só volta quando uma nova requisição
    chega, com atraso de cold start). Isso violava diretamente o requisito
    "deve funcionar mesmo que nenhum usuário esteja com o ERP aberto".
  - Alternativa "Cron Job" do Render (produto separado): sem plano
    gratuito (mínimo ~US$1/mês + instância), documentação não confirma
    suporte a intervalo de 1 minuto, e cada execução sobe uma instância
    nova com o Render garantindo no máximo 1 execução ativa por vez
    (atrasando a próxima se a anterior ainda estiver rodando) — não dá pra
    garantir uma cadência exata de 1 minuto.
  - Alternativa "Background Worker" (processo contínuo, não dependente de
    tráfego HTTP): também sem plano gratuito nesse workspace (mínimo
    Starter, ~US$7/mês).
  - **Resultado informado ao usuário antes de qualquer implementação**,
    com as opções acima — o usuário escolheu **fazer upgrade do
    `cerne-erp` de Free para Starter** (ele mesmo, no painel do Render —
    as ferramentas MCP disponíveis nesta sessão não têm um "trocar plano
    de serviço existente", só criar serviço novo; e trocar plano é uma
    decisão financeira que não é do Claude tomar sozinho de qualquer
    forma). No plano Starter o serviço não dorme mais, e um `setInterval`
    de 1 minuto dentro do próprio processo passa a ser confiável — a
    arquitetura mais simples, reaproveitando 100% do código já existente
    (`lib/mlSync.js#sincronizarConta`), sem criar um serviço novo no
    Render nem um segundo caminho de deploy.
- **Desenho do ciclo automático (`server/lib/syncScheduler.js`):**
  `setInterval` de 1 minuto **no processo do servidor** (nunca no
  navegador — proibido explicitamente pelo usuário), disparando um
  primeiro ciclo imediatamente ao subir (não espera 1 minuto pro primeiro
  pedido novo entrar). A cada ciclo: busca `SELECT id, empresa_id FROM
  ml_contas WHERE status = 'ativa'` e chama `sincronizarConta` para cada
  uma em paralelo via `Promise.allSettled` (nunca `Promise.all`) — uma
  conta falhando nunca impede as outras nem os próximos ciclos (requisito
  explícito do usuário). Trava contra ciclos sobrepostos: se um ciclo
  ainda está rodando quando o próximo deveria disparar, o novo disparo é
  simplesmente pulado (log de aviso), evitando acúmulo de execuções
  concorrentes se a API do Mercado Livre estiver lenta.
- **Janela de reconciliação menor que os 30 dias do botão manual (padrão:
  2 dias, configurável por `ML_SYNC_RECONCILIACAO_DIAS`).** Repetir uma
  busca de 30 dias inteira a cada 60 segundos não é viável (uma conta com
  muitos pedidos já demora minutos — ver `05-problemas-conhecidos.md`) nem
  necessário: a notificação em tempo real (webhook, já existente) cobre
  pedidos de qualquer idade — o ciclo de 1 minuto é a camada de
  segurança/reconciliação (exatamente a estratégia descrita pelo usuário:
  "Webhook/notificação → atualização rápida" + "Sincronização a cada 1
  minuto → segurança/reconciliação"), não a única forma de um pedido
  entrar. Consequência assumida e documentada (não escondida): uma
  mudança de status/pagamento num pedido com mais de 2 dias só é pega
  automaticamente pelo webhook, não pelo ciclo de 1 minuto — ver
  `05-problemas-conhecidos.md`.
- **Status da sincronização é estado em memória do processo
  (`syncScheduler.js`), não uma tabela nova no banco** — decisão pra não
  criar schema/migração só para um indicador de UI. As informações por
  conta que já existiam (`ml_contas.status/ultimo_erro/
  ultima_sincronizacao_em`, usadas na tela Marketplaces) continuam do jeito
  que estavam; o novo endpoint `GET
  /api/integracoes/mercadolivre/status-automatico` expõe o "batimento
  cardíaco" do ciclo automático em si (quando rodou pela última vez, se
  deu erro, quais contas falharam) pro indicador discreto do header.
  Reiniciar o servidor reseta esse estado (mostra "Aguardando 1ª
  sincronização..." por até 1 minuto) — comportamento esperado, não um bug.

## 2026-08-25 (17) — Ads e Relatórios: fonte única desce a nível de item, Ads nunca mistura API real com cálculo próprio
- Decidido que a margem por anúncio/SKU (precisa tanto por Ads quanto por
  Relatórios → Produtos) seria uma **extensão da mesma fonte única**
  (`lib/relatorioVendas.js`), não uma consulta paralela. Criada
  `buscarItensDoPeriodo`, que decompõe cada pedido já calculado por
  `buscarPedidosDoPeriodo` em suas linhas de item, reaproveitando
  `calcularResultadoVenda` por linha. Motivo: exatamente a mesma razão de
  sempre — nunca correr o risco de Ads/Relatórios divergirem de Pedidos/
  Visão Geral/Financeiro se uma regra de cálculo mudar.
- **Rateio decidido caso a caso, por campo** — nunca um rateio genérico
  aplicado a tudo. Comissão (`ml_pedido_itens.taxa_venda`) e custo do
  produto (`produtos.custo × quantidade`) são genuinamente itemizáveis no
  dado já salvo pelo Mercado Livre/ERP — por isso são **sempre exatos por
  item, nunca rateados**, mesmo num pedido com vários itens. Frete do
  vendedor, desconto (cupom) e tarifas de pagamento além da comissão só
  existem no nível do PEDIDO (a API do Mercado Livre não os itemiza) —
  esses três são **rateados proporcionalmente ao valor de cada item**
  somente quando o pedido tem mais de 1 item; um pedido de item único
  nunca passa por rateio nenhum (ratio=1, resultado idêntico ao valor do
  pedido). Decisão registrada explicitamente no código
  (`lib/relatorioVendas.js`) para não ser reconsiderada por engano numa
  etapa futura sem entender o porquê.
- **Ads decidido com duas fontes estritamente separadas, nunca combinadas
  numa fórmula nova.** Investimento, vendas atribuídas, faturamento
  atribuído, ROAS e ACOS vêm sempre da API de Advertising (Product Ads)
  real do Mercado Livre (`lib/mlAds.js`) — nunca calculados a partir dos
  nossos próprios pedidos, porque o modelo de atribuição de venda a um
  anúncio é proprietário do Mercado Livre e não pode ser reconstruído com
  certeza a partir dos dados de pedido que o ERP já tem. Faturamento
  real e margem "antes do Ads" vêm da fonte única de vendas
  (`buscarItensDoPeriodo`, agrupado por `ml_item_id`) — a mesma margem
  real já mostrada em Pedidos/DRE/Financeiro/Relatórios, nunca uma
  segunda forma de calcular margem. **TACOS decidido como investimento em
  Ads ÷ faturamento REAL do anúncio (fonte 2), não o faturamento
  "atribuído" pelo Mercado Livre (fonte 1)** — essa é a definição padrão
  de mercado de TACOS (spend ÷ receita total, não spend ÷ receita
  atribuída ao anúncio) e é exatamente o que o usuário pediu ao explicar
  que não queria analisar ROAS isoladamente, e sim saber se o anúncio é
  realmente lucrativo depois do Ads.
- **Nenhuma tabela nova no banco para Ads** — mesma decisão já tomada
  para Anúncios (`lib/mlAnuncios.js`) e Recebimentos: sempre buscado ao
  vivo na API no momento do carregamento da tela, nunca uma cópia
  guardada que pode ficar desatualizada. Ao contrário de
  `routes/anuncios.js` (que hoje só olha a primeira conta do Mercado
  Livre da empresa — limitação pré-existente, não alterada nesta etapa
  por instrução de "não altere módulos que já estão funcionando"),
  `lib/ads.js` percorre **todas** as contas da empresa, porque o usuário
  pediu explicitamente que o filtro de loja funcionasse em Ads.
- **API de Advertising do Mercado Livre nunca integrada antes neste
  projeto** — pesquisada via documentação pública em 25/08/2026. Não foi
  possível confirmar com 100% de certeza, só pela documentação (sem uma
  conta real de teste com Product Ads habilitado neste ambiente): a URL
  base exata, o valor exato de `Api-Version` esperado por cada endpoint,
  e os pré-requisitos de habilitação da conta anunciante. Decidido tratar
  isso com desenho defensivo (toda chamada em try/catch, sempre devolve
  um motivo estruturado) em vez de bloquear a entrega esperando
  confirmação — consistente com a própria instrução do usuário de usar
  dado real "quando a integração/API permitir" e mostrar "Pendente de
  sincronização" caso contrário. Registrado como limitação conhecida em
  `05-problemas-conhecidos.md`, a confirmar ao vivo em produção.

## 2026-08-24 (16) — DRE, Faturamento e Notas Fiscais: waterfall sem fórmula nova, situação de faturamento e nota 1:1 com o pedido
- Ao ativar a DRE, decidido que ela **não teria tabela nem cálculo
  financeiro próprio** — é sempre montada ao vivo, reorganizando em forma
  de demonstrativo os mesmos números já calculados por
  `lib/relatorioVendas.js` (vendas) e `lib/contasPagar.js` (despesas do
  período), sem duplicar nem reimplementar nenhuma fórmula. Motivo: é a
  mesma filosofia de "fonte única" já usada em Recebimentos — evita o
  risco de a DRE divergir das outras telas assim que uma regra de cálculo
  mudar em um único lugar.
- Decidido que a **Margem de Contribuição da DRE é sempre lida direto de
  `resumirPeriodo`**, nunca recalculada por subtração das linhas do
  demonstrativo (Receita Líquida − Custo − Taxas − Frete − Impostos).
  Motivo: em casos raros de pendência parcial (um pedido com uma
  informação faltando mas outra presente), a soma das linhas poderia, em
  teoria, divergir em centavos do valor real — e a Margem de Contribuição
  precisa ser idêntica à mostrada em Pedidos/Visão Geral/Financeiro,
  sempre.
- Acrescentada a linha "Descontos concedidos (cupom)" à DRE, mesmo não
  estando na lista literal pedida pelo usuário — decisão tomada pra que a
  subtração em cascata (Receita Bruta → Receita Líquida) feche
  exatamente com a Margem de Contribuição já usada nas outras telas, já
  que `resumirPeriodo` sempre desconta o cupom da receita. Ficou como uma
  linha própria e visível (nunca escondida dentro de outra), pra não
  disfarçar de onde vem a diferença.
- Adotado o mesmo gate de "Sem dados" x "0 de verdade" já usado na Visão
  Geral: só quando o período inteiro não tem NENHUM pedido (nem
  cancelado) é que as linhas de receita mostram "Sem dados" (null); um
  grupo vazio dentro de um período que TEM pedidos (ex: nenhum
  cancelamento) mostra R$ 0,00 — zero de verdade, não pendência.
- Faturamento decidido como um **rastreador de situação por pedido**
  (`faturamento_pedidos`, 1:1 com `ml_pedidos`, `pedido_id` único), não
  uma tabela de lançamento manual como Contas a Pagar — reaproveita a
  mesma fonte única de pedidos e só guarda a situação de faturamento por
  cima. Um pedido sem linha registrada é tratado como
  "aguardando_faturamento" por padrão (não é criada uma linha para todo
  pedido só de inicialização).
- Ações em lote do Faturamento nomeadas deliberadamente "Marcar como
  Faturado/Erro/Cancelado" — nunca "Emitir NF-e" — porque a emissão real
  (SEFAZ) está fora do escopo desta etapa, por instrução explícita do
  usuário.
- Notas Fiscais decidida como **1 nota por pedido** (`notas_fiscais`,
  `pedido_id` único, upsert), a estrutura mais simples que atende "vinculado
  ao pedido, sem duplicar pedido" — um histórico de múltiplas notas por
  pedido (útil pra casos de rejeição/reemissão) fica registrado como
  próximo passo, não implementado agora.
- Marcar uma nota como "Emitida" **exige** número, série, data de emissão
  e chave de acesso (44 dígitos) — validado no backend antes de gravar.
  Decisão direta da instrução do usuário de nunca inventar número de NF-e
  nem chave de acesso: sem os 4 campos, o sistema recusa a mudança de
  status em vez de aceitar uma "emissão" incompleta/fictícia.
- `faturamento_pedidos.pedido_id` e `notas_fiscais.pedido_id` ganharam
  `ON DELETE CASCADE` para `ml_pedidos(id)`. Motivo: a sincronização real
  do Mercado Livre nunca apaga um pedido de verdade (é sempre upsert),
  então isso não deveria disparar em produção — existe só pra nunca
  deixar uma situação de faturamento ou nota "órfã" apontando pra um
  pedido inexistente, e pra não travar o teste automatizado de
  idempotência (que apaga e recria os pedidos seedados a cada execução).
- Nenhuma das duas telas duplica `cliente`/`loja`/`marketplace`/CNPJ da
  empresa nas tabelas novas — esses campos são sempre lidos do pedido
  original via JOIN no momento da consulta, nunca gravados de novo.

## 2026-08-24 (15) — Financeiro: status calculado, imutabilidade após baixa, e Recebimentos sem tabela própria
- Ao ativar Contas a Pagar/Receber, decidido não gravar "vencido"/
  "atrasado" como valor de status — só `pendente/pago/cancelado` (ou
  `a_receber/recebido/cancelado`) ficam no banco; o rótulo "vencido"/
  "atrasado" é sempre calculado no momento da leitura, comparando com
  "hoje" (fuso BRT). Motivo: evita depender de uma tarefa agendada (cron)
  rodando todo dia só pra atualizar status — o cálculo é sempre correto,
  não importa há quanto tempo o servidor está de pé.
- Decidido que uma conta paga/recebida vira histórico imutável — não
  editável, não excluível. Uma conta pendente pode ser editada/cancelada/
  excluída livremente; uma cancelada não pode mais ser editada, mas pode
  ser excluída (corrigir um cadastro errado). Motivo: depois que o
  dinheiro entrou/saiu de verdade, alterar ou apagar o registro romperia
  a rastreabilidade financeira.
- KPIs de "total em aberto"/"vencendo hoje"/"vencidas" (e os equivalentes
  de Contas a Receber) foram desenhados para NUNCA respeitar o filtro de
  período do header — são sempre o saldo atual da empresa ("quanto eu
  tenho em aberto agora", uma pergunta atemporal). Só "pago no período"/
  "recebido no período" respeitam o período selecionado. A lista/tabela
  de contas, essa sim, é sempre filtrada pelo período (por vencimento/
  data prevista) — assim o filtro do header "funciona" na tela inteira,
  sem descaracterizar o significado dos KPIs de saldo.
- Recebimentos foi decidido **sem tabela própria no banco** — é sempre
  calculado ao vivo a partir da mesma fonte única de pedidos
  (`lib/relatorioVendas.js`) já usada por Pedidos/Visão Geral/Financeiro/
  Relatórios, filtrando pagamento aprovado. Motivo: evita duplicar dado
  (o pedido já existe no banco) e evita o risco de a tela de Recebimentos
  ficar dessincronizada da fonte real assim que um pedido for cancelado/
  estornado depois.
- Taxas/descontos de Recebimentos somam comissão do Mercado Livre + frete
  do vendedor + desconto do cupom (`tarifasMl + freteVendedor +
  desconto`) — deliberadamente SEM imposto e SEM custo do produto, ao
  contrário da "margem de contribuição" usada em Pedidos/Visão Geral.
  Motivo: Recebimentos responde "quanto o marketplace realmente
  repassa", uma pergunta puramente sobre o que o Mercado Livre desconta —
  imposto e custo do produto não são descontados pelo marketplace, são
  custos internos da empresa.
- Confirmado, com consulta direta ao banco de produção (Supabase), que o
  payload de pagamento salvo pela integração atual com o Mercado Livre
  (`raw_pagamento`) não contém nenhum campo de data de liberação nem de
  valor efetivamente repassado. Decidido não simular/estimar esses campos
  de forma alguma — ficam sempre `null` na API, e a tela mostra
  "Informação não disponível" (nunca uma data ou valor calculado) até que
  a integração real traga esse dado. Status sempre "A liberar" como único
  valor honesto possível hoje.
- `categoria` (Contas a Pagar) e `origem` (Contas a Receber) foram
  decididos como texto livre (não uma lista fixa/tabela de categorias)
  porque o projeto ainda não tem um plano de contas definido — uma lista
  de sugestões (`<datalist>`) ajuda a digitação sem travar o usuário numa
  lista fechada.

## 2026-08-24 (14) — Unificação Produtos + Custo & Margem
- Pedido do usuário: unificar as abas "Produtos" e "Custo & Margem" numa só
  ("Produtos"), sem mostrar margem nessa tela — só cadastrar/editar SKU,
  custo e imposto. Preservar os dados já existentes na antiga Custo &
  Margem, migrando/reaproveitando SKU e custo pra dentro de Produtos. A
  margem continua calculada nas vendas (Pedidos, Visão Geral, Financeiro,
  Relatórios), com a mesma fórmula de sempre — só a fonte do custo muda de
  tabela.
- **Pergunta feita ao usuário antes de mexer:** o pedido descrevia a nova
  tela Produtos com um campo "imposto" junto de SKU e custo — o que
  sugeria imposto virar um cadastro por produto/SKU, diferente da alíquota
  única por empresa que existe hoje. Perguntado diretamente; o usuário
  confirmou que **o imposto continua uma alíquota única por empresa** — só
  a tela onde ela é configurada mudou (de "Custo & Margem" pra "Produtos").
  Essa resposta evitou uma mudança de comportamento financeiro não pedida
  (transformar o imposto em algo por produto teria alterado o resultado
  calculado de todas as vendas, sem o usuário ter pedido isso de propósito).
- **Fonte de custo para o cálculo de margem passou de `custos_produto` para
  `produtos`:** `lib/relatorioVendas.js` (usado por Pedidos, Visão Geral,
  Financeiro, Relatórios) e a rota de detalhe do pedido
  (`routes/pedidos.js`, `GET /:id` — tinha sua PRÓPRIA query separada pra
  custo, que também precisou ser trocada, senão o detalhe do pedido
  continuaria mostrando números diferentes da lista, o exato problema que
  o compartilhamento de código dessas telas foi desenhado pra evitar) agora
  fazem `LEFT JOIN produtos` em vez de `LEFT JOIN custos_produto`, mesma
  lógica de nulo/pendência (nunca inventa custo faltando). Não filtra por
  `produtos.ativo` de propósito — desativar um produto é só uma flag de
  catálogo, não deveria apagar o custo usado no cálculo de vendas já
  feitas ou futuras daquele SKU.
- **Migração de dados: preservar, nunca inventar, nunca sobrescrever edição
  futura.** A tabela `custos_produto` **fica no banco**, intocada, só como
  histórico — nenhuma rota lê ou escreve nela mais. Uma migração de dados
  (não de schema) copia cada linha de `custos_produto` pra `produtos`:
  - SKU que só existia em `custos_produto` → cria produto novo em
    `produtos`, usando o próprio SKU como nome (não existe nome cadastrado
    lá pra reaproveitar, e nome é obrigatório na tabela `produtos`) — o
    usuário pode editar o nome depois.
  - SKU que já existia nos dois lugares → o custo de `produtos` é
    **sobrescrito** pelo valor de `custos_produto` (não o contrário),
    porque era essa a fonte que estava sendo usada de verdade no cálculo
    de margem até aqui — preservar o valor antigo e não usado de
    `produtos.custo` mudaria silenciosamente o resultado calculado das
    vendas no dia do deploy. O nome já cadastrado em `produtos` é
    preservado (só o custo é sobrescrito).
  - **Crítico:** essa migração roda **uma única vez**, guardada por uma
    tabela nova `migracoes_aplicadas`. Rodar de novo a cada boot do
    servidor (como o `schema.sql` faz, com segurança, via `CREATE TABLE
    IF NOT EXISTS`) sobrescreveria PARA SEMPRE qualquer custo que o
    usuário venha a editar depois em Produtos, revertendo pro valor antigo
    de `custos_produto` a cada deploy/reinício — um bug sério que foi
    identificado e evitado antes de implementar, não depois. Testado
    localmente confirmando que editar o custo depois da migração e rodar a
    migração de novo NÃO reverte a edição (ver `05-problemas-conhecidos.md`).
- **Backend:** `routes/custos.js` perdeu as rotas de custo por SKU
  (`/api/custos-produto`, agora inexistentes — cadastro de custo passou a
  ser só via `routes/produtos.js`, que já tinha CRUD completo de SKU +
  custo) e manteve só `/api/config-financeiro` (alíquota de imposto,
  inalterada). Nenhuma rota nova precisou ser criada em `produtos.js`
  porque ele já suportava nome/SKU/custo/status — só o comentário de
  cabeçalho foi atualizado pra refletir que agora é a fonte de verdade.
- **Frontend:** o módulo `window.Custos` foi removido inteiro; sua seção
  "Imposto configurado" (alíquota) foi movida pro topo do módulo
  `window.Produtos`, acima da tabela de produtos — mesmo empresa
  selecionada serve pros dois. A aba "Custos & Margem" foi removida do
  menu (grupo Análise). A tabela de produtos continua sem coluna de
  margem — só Produto/SKU/Custo/Status/Cadastrado em/ações, como já era.

## 2026-08-24 (13) — Relatório de Pedidos: reaproveitar cálculo existente, nunca duplicar
- Pedido do usuário: adicionar um botão "Gerar relatório" na tela Pedidos,
  exportando Excel/CSV com os filtros da tela, usando **exatamente os
  mesmos cálculos já usados no ERP** — proibido criar uma regra financeira
  diferente só para o relatório.
- **Decisão central:** o relatório não recalcula nada por conta própria.
  Ele chama `buscarPedidosDoPeriodo` (mesma função de sempre, de
  `lib/relatorioVendas.js`, **não tocada** nesta etapa), filtra o array já
  calculado em memória (por loja/status/produto) e resume o resultado
  filtrado pela mesma `resumirPeriodo`. Isso garante, por construção, que
  o relatório nunca pode divergir da tela — os dois usam o mesmo código.
- **Novos filtros (Loja/Status/Produto) ficaram só em `routes/pedidos.js`**,
  como um filtro em memória (`filtrarPedidos`) sobre o array já retornado
  — nunca uma cláusula nova dentro da query pesada de
  `buscarPedidosDoPeriodo`. Isso evita mexer numa query já identificada
  como lenta (ver `05-problemas-conhecidos.md`) e mantém a mesma função
  compartilhada por Visão Geral/Pedidos/Financeiro intacta.
- **Trade-off de performance aceito conscientemente:** a listagem da tela
  (`GET /`) só busca sem limite de 500 quando algum filtro novo
  (loja/status/busca) está ativo — no caso comum (sem filtro extra),
  mantém o mesmo `LIMIT 500` de sempre, sem regressão de velocidade. Já o
  endpoint de relatório (`GET /relatorio`) **sempre** busca tudo, porque
  "não exportar pedidos fora do filtro escolhido" (pedido explícito do
  usuário) exige o conjunto completo, não só os 500 mais recentes.
- **Origem das opções de filtro:** loja vem de uma query simples nas
  contas ML da empresa; status vem de um `SELECT DISTINCT` real nos
  pedidos do período — nunca uma lista fixa de status do Mercado Livre
  digitada de memória, pra não arriscar inventar ou esquecer um status que
  a API realmente usa.
- **Origem do "Descontos":** em vez de inventar uma regra nova, usado o
  campo `preco_unitario_original` (já existente em `ml_pedido_itens`,
  documentado no schema como "full_unit_price (quando diferente =
  desconto)") comparado ao `preco_unitario` cobrado — dado real já
  capturado da API do Mercado Livre, não um cálculo novo.
- **"Pendente" vs. zero real, revisado nesta etapa:** a função que monta as
  linhas de resumo do relatório inicialmente usava uma única flag
  "vazio" pra decidir quando mostrar "pendente" em vez de um número,
  o que causava um bug (total mostrando "pendente" quando na verdade a
  soma era zero de forma legítima, ex: filtro só de pedidos cancelados).
  Corrigido para duas flags independentes (pedidos não-cancelados = 0,
  pedidos cancelados = 0) — cada grupo de totais decide "pendente" vs
  "0,00" pela sua própria contagem, nunca por uma flag genérica. Ver
  detalhe do bug em `04-alteracoes.md` (13).
- **XLSX via `exceljs`** (biblioteca Node.js, adicionada a
  `package.json`) — não instalável neste sandbox (mesma limitação de
  sempre, ver `05-problemas-conhecidos.md`), mas instala normalmente no
  build do Render. **CSV com `;` como separador e BOM UTF-8** — convenção
  do Excel em português (vírgula é separador decimal aqui), consistente
  com como um usuário brasileiro abriria o arquivo.
- **PDF não foi implementado** — o próprio usuário disse não ser
  prioridade agora; ficou registrado como possibilidade futura em
  `06-proximos-passos.md`, não descartado silenciosamente.

## 2026-08-24 (12) — Supabase como banco principal + sincronização histórica desde 01/07/2026
- Pedido do usuário: parar de avançar módulos e corrigir a base de dados —
  3 passos, nada além disso: (1) Supabase/PostgreSQL como fonte permanente
  dos dados do Mercado Livre (Visão Geral não pode depender de chamar o
  Mercado Livre em tempo real), (2) importar todo o histórico de pedidos
  desde 01/07/2026 sem duplicar, (3) fazer a Visão Geral ler do banco.
  Custo e imposto explicitamente **fora** desta etapa.
- **Descoberta importante antes de mexer em qualquer coisa:** Visão Geral,
  Pedidos e Financeiro **já liam só do Postgres** (`routes/relatorios.js` →
  `lib/relatorioVendas.js` → `pool.query`), nunca chamavam a API do
  Mercado Livre ao montar a tela. O passo 3 do pedido já estava
  estruturalmente atendido — faltava confirmar isso ao vivo (feito, ver
  `04-alteracoes.md`) e trocar o banco por trás para o Supabase.
- **Por que Supabase, e não continuar no Postgres do Render:** o Postgres
  gratuito do Render (`cerne-db`) expira em 20/09/2026 (ver
  `05-problemas-conhecidos.md`) — trocar agora, dentro desta etapa,
  resolve os dois problemas de uma vez (banco permanente + fonte única de
  dados).
- **Migração dos dados existentes:** feita a partir de dentro do próprio
  app já publicado (que já tinha acesso legítimo ao banco antigo via
  `DATABASE_URL`), através de uma rota administrativa temporária
  (`server/routes/adminMigracao.js`, protegida por token em
  `ADMIN_MIGRATION_TOKEN`, nunca exposto no front-end) que copiou tabela
  por tabela preservando os IDs (necessário por causa das chaves
  estrangeiras). Depois de confirmada a migração e a troca do
  `DATABASE_URL` de produção para o Supabase, essa rota foi **removida do
  projeto** (não faz parte do funcionamento normal do ERP) — junto com o
  arquivo `server/routes/adminMigracao.js` e as duas linhas que a
  registravam em `server.js`.
- **Cópia em lotes, não linha por linha:** a primeira versão da migração
  copiava uma linha por vez (um round-trip de rede por linha) e ficou
  lenta demais indo até o Supabase (bancos em provedores/regiões
  diferentes) com o volume real de dados (10.136 pedidos + itens).
  Reescrita para `INSERT ... VALUES (...),(...),...` em lotes de 300
  linhas — a mesma migração caiu de minutos sem terminar para ~55s.
- **Nova tabela `ml_pedido_pagamentos`** (em vez de mexer nas colunas de
  pagamento que já existiam em `ml_pedidos`): guarda **todos** os
  pagamentos de um pedido (um pedido pode ter mais de um), com valor,
  taxas, forma de pagamento, parcelas e status — preservando o cálculo
  central de margem (`lib/resultadoVenda.js` / `lib/relatorioVendas.js`)
  intacto, sem duplicar essa lógica em lugar nenhum.
- **Sincronização histórica desenhada dia a dia, não em uma chamada só:**
  para não esbarrar em limite de paginação da busca do Mercado Livre e
  para poder retomar de onde parou se cair no meio (processo pode levar
  bastante tempo — dezenas de dias de pedidos). Nova tabela
  `ml_sync_historicos` guarda, por execução: data de início, data alvo,
  **até que dia já foi processado** (`janela_concluida_ate`, funciona como
  marcador de retomada), totais e eventuais erros por pedido. Roda em
  segundo plano (responde na hora, processa depois) — mesmo padrão já
  usado no webhook do Mercado Livre.
- **Por que isso não duplica pedido, nem na primeira nem em execuções
  seguintes:** cada pedido é gravado com `INSERT ... ON CONFLICT (conta_ml_id,
  ml_order_id) DO UPDATE` — já existindo, atualiza; não existindo, cria.
  Rodar a sincronização histórica de novo depois de `concluido` reprocessa
  o período inteiro (não é um "pular tudo"), mas o resultado é o mesmo
  conjunto de pedidos atualizado, nunca duplicado. Confirmado ao vivo
  rodando a sincronização duas vezes seguidas — ver `04-alteracoes.md`.
- **Bug encontrado e corrigido antes de qualquer deploy (nunca chegou a
  rodar em produção quebrado):** o driver `pg` devolve colunas `DATE` como
  objeto `Date` do JavaScript, não como string. O código original comparava
  `'YYYY-MM-DD' <= objetoDate` para decidir se o dia-a-dia da sincronização
  histórica devia continuar — essa comparação sempre dá `false` em
  JavaScript (o objeto vira `NaN` ao ser coagido pra número, e qualquer
  comparação com `NaN` é falsa), o que faria a sincronização parar depois
  de processar só o primeiro dia. Encontrado por raciocínio sobre o
  comportamento do driver antes de testar, confirmado com teste isolado, e
  corrigido normalizando os dois lados para string (`YYYY-MM-DD`) antes de
  comparar.
- Conforme pedido, nenhum outro módulo foi avançado nesta etapa, e custo/
  imposto continuam exatamente como já estavam (não foram tocados).

## 2026-08-23 (11) — Ativação de Estoque, Estoque Full e Compras
- Pedido do usuário: ativar 3 áreas novas — Estoque (próprio), Estoque Full
  (renomeado de "Full", visualização real do Mercado Livre) e Compras —
  mantendo o design atual e sem mexer em nenhuma outra área.
- **Estoque é modelado em cima de Produtos, não de `custos_produto`.** Uma
  linha por produto na tabela nova `estoque` (produto_id único, quantidade)
  — um produto sem nenhum ajuste ainda simplesmente não tem linha lá, e a
  tela trata isso como quantidade 0. Fica consistente com a decisão já
  tomada em Produtos (ver (10), abaixo) de não tocar em `custos_produto`
  nesta etapa.
- **Histórico de movimentação preparado desde já, mesmo sem tela própria
  para vê-lo.** Tabela nova `estoque_movimentos`: toda vez que o endpoint
  de ajuste (`PUT /api/estoque/:produtoId`) roda, ele grava a quantidade
  anterior, a nova, a diferença e uma observação opcional, dentro da MESMA
  transação que atualiza `estoque` (usando `pool.connect()` + `BEGIN`/
  `COMMIT`/`ROLLBACK` — primeira vez que este projeto usa uma transação
  explícita, necessária aqui porque são duas tabelas que precisam mudar
  juntas ou nenhuma mudar). Isso atende ao pedido literal do usuário
  ("toda alteração de quantidade deve ficar preparada para possuir
  histórico de movimentação") sem construir uma tela de histórico que não
  foi pedida ainda.
- **Estoque Full não tem tabela — busca ao vivo, mesmo padrão de Anúncios**
  ((10), abaixo), por uma razão adicional aqui: a API do Mercado Livre para
  saber a quantidade de um item Full (`GET /inventories/{inventory_id}/
  stock/fulfillment`) não tem um "multiget" documentado — é uma chamada por
  anúncio. Persistir isso exigiria uma sincronização própria (fila,
  agendamento, etc.) fora do escopo pedido ("Se algum dado ainda não
  estiver disponível, mostre claramente como pendente" já assume que isso
  pode não estar completo). Nova lib `server/lib/mlFull.js`, deliberadamente
  **separada** de `server/lib/mlAnuncios.js` (mesmo com alguma duplicação
  de código) para não arriscar alterar a lógica de Anúncios, que ainda
  segue pendente de teste ao vivo em produção.
- **Identificar um anúncio como "Full" usa `shipping.logistic_type ===
  'fulfillment'`** no retorno de `/items?ids=...` — campo documentado pela
  API do Mercado Livre. A quantidade em si depende de mais um campo,
  `inventory_id`, que só existe quando o Mercado Livre já processou aquele
  anúncio como Full — quando ausente, ou quando a chamada ao endpoint de
  estoque falha, o item entra na lista com `pendenteQuantidade: true` e a
  tela mostra "Pendente" na coluna, nunca um número.
- **Só a primeira "janela" de anúncios da conta é verificada** (até 100 por
  carregamento, mesmo limite de Anúncios) — a tela avisa quantos anúncios
  foram verificados de quantos existem no total, e quantos desses são Full,
  pra nunca dar a entender que a lista é completa quando não é. Mesma
  lógica de não över-construir uma paginação completa que não foi pedida
  ainda.
- **Compras: `valor_total` da compra e de cada item são sempre calculados
  no servidor** (quantidade × custo unitário, por item; soma dos itens,
  pro total) — nunca aceitos prontos do que o front-end mandar, mesmo
  princípio de "nunca inventar/confiar em número de fora" já usado pra
  dados do Mercado Livre, agora aplicado a dado digitado pelo usuário
  (evita o total ficar errado por um bug ou manipulação no front-end).
- **Editar uma compra substitui todos os itens** (apaga os itens antigos e
  grava os novos, dentro de uma transação) — mesmo padrão já usado em
  `ml_pedido_itens` ao ressincronizar um pedido do Mercado Livre. Mais
  simples que tentar calcular um diff item a item, e suficiente pro
  "primeiro quero apenas o módulo de compras funcionando corretamente"
  pedido pelo usuário.
- **"Recebido" não mexe em estoque, de propósito** (pedido explícito do
  usuário: "também não automatize ainda entrada de estoque ao receber a
  compra") — o PATCH de status só troca o campo `status`. Ligar Compras
  "Recebido" → Estoque é uma decisão de negócio (o que fazer se a
  quantidade recebida for diferente da pedida? soma ou substitui?) que
  precisa ser conversada com o usuário antes de automatizar — fica
  registrada como pendência em `06-proximos-passos.md`.
- **Sem `CHECK` de banco para o status da compra** (`em_aberto` /
  `pedido_realizado` / `recebido` / `cancelado`) — validado só na rota
  (`STATUS_VALIDOS`), mesmo padrão já usado pros outros campos "tipo enum"
  do projeto (ex: `ml_contas.status`). Consistente, mas significa que só a
  aplicação garante os valores válidos, não o banco.
- **Editar uma compra que referencia um produto já desativado**: o
  formulário mantém esse produto selecionável (com um aviso "— inativo"),
  em vez de fazer a seleção sumir silenciosamente — pra nunca perder, sem
  querer, qual produto era aquele item ao reabrir uma compra antiga depois
  de desativar o produto em Produtos.
- **Testado localmente** (sem poder rodar o servidor Express+pg neste
  ambiente — ver `05-problemas-conhecidos.md`): `node --check` em todos os
  arquivos de backend novos/alterados e no bloco de script do front-end;
  schema aplicado no Postgres local confirmando criação das 4 tabelas
  novas (`estoque`, `estoque_movimentos`, `compras`, `compra_itens`) sem
  afetar nenhuma tabela existente; fluxo completo de ajuste de estoque
  testado via `psql` dentro de uma transação (produto sem linha ainda →
  cria; produto com linha → atualiza; grava a movimentação; confere o
  valor total em estoque) para os dois casos (criar e atualizar); fluxo
  completo de Compras testado via `psql` (criar com 2 itens e valor total
  calculado, editar substituindo os itens, mudar status, filtrar por
  status, buscar por fornecedor). **Não foi possível testar a chamada real
  ao endpoint de estoque Full do Mercado Livre** neste ambiente (sem
  servidor rodando, sem conta real acessível) — depende do teste ao vivo
  em produção depois do deploy, junto com o teste (ainda pendente) de
  Anúncios.

## 2026-08-22 (10) — Ativação de Produtos, Anúncios e Fornecedores
- Pedido do usuário: ativar 3 áreas novas do ERP — Produtos (cadastro
  simples), Anúncios (visualização real do Mercado Livre) e Fornecedores
  (cadastro) — mantendo o design atual e sem mexer em nenhuma outra área.
- **Produtos é uma tabela nova e separada de `custos_produto`.** A tabela
  `custos_produto` já existia e é usada, hoje, pelo cálculo de margem de
  Custos/Pedidos/Visão Geral/Financeiro — mexer nela contaria como alterar
  "outras áreas", proibido nesta etapa. Como o pedido também foi
  explicitamente por um "cadastro de produtos simples", sem kits/composição/
  estoque ainda, a decisão foi criar `produtos` como catálogo independente
  (nome, SKU, custo, status), sem nenhum vínculo com o cálculo de margem por
  enquanto. **Trade-off consciente:** custo por SKU passa a existir em dois
  lugares (Produtos e Custos) sem sincronia entre eles — registrado como
  pendência em `05-problemas-conhecidos.md` e `06-proximos-passos.md`, para
  o usuário decidir quando/como unificar (ex: Produtos passar a ser a fonte
  única de custo, ou as duas telas serem uma só).
- **Anúncios não tem tabela no banco — busca ao vivo na API do Mercado
  Livre a cada carregamento da tela.** Alternativa considerada: importar e
  guardar os anúncios como é feito com os pedidos (`ml_pedidos`). Decisão:
  não criar uma sincronização nova nesta etapa, porque (1) o pedido foi
  explicitamente "primeiro quero visualizar corretamente os anúncios" (sem
  editar preço/estoque ainda), (2) evita duplicar mais uma vez o problema já
  registrado de sincronização lenta com contas de muitos itens (ver
  `05-problemas-conhecidos.md`, período 7/30 dias), e (3) mantém o escopo no
  tamanho pedido. Usa os endpoints `/users/{id}/items/search` (lista de IDs,
  paginado) e `/items?ids=...` (detalhe de até 20 itens por chamada) — ambos
  documentados oficialmente pelo Mercado Livre. Nova lib
  `server/lib/mlAnuncios.js`, reaproveitando `getContaComTokenValido` de
  `mlSync.js` (mesmo padrão de renovação automática de token) e `apiGet` de
  `mercadolivre.js` — nenhuma lógica de token/renovação foi duplicada.
- **SKU do anúncio nem sempre vem num campo único e óbvio da API do Mercado
  Livre** — pode estar no atributo `SELLER_SKU` do anúncio, no campo legado
  `seller_custom_field`, ou só dentro de cada variação. Regra adotada: usar
  o SKU do anúncio se existir; senão, o campo legado; senão, o SKU da(s)
  variação(ões) **só se todas tiverem o mesmo SKU** — se houver mais de um
  SKU diferente entre variações, o campo fica "—" (nunca escolhe um SKU "no
  chute" entre vários possíveis).
- **Primeira página de anúncios limitada a 50–100 itens por carregamento**
  (parâmetro `limit`, máx. 100), com o total real informado pela API
  mostrado na tela ("mostrando X de Y"). "Carregar mais"/paginação completa
  não foi implementado nesta etapa — decisão de manter o escopo no tamanho
  pedido ("primeiro quero visualizar corretamente"); fica registrado em
  `06-proximos-passos.md` para quando o usuário quiser ver mais que a
  primeira página.
- **Validação de CPF nova** (`server/lib/cpf.js`), no mesmo padrão já usado
  para CNPJ (`server/lib/cnpj.js`, não alterado) — Fornecedores aceita
  CNPJ (14 dígitos) ou CPF (11 dígitos) no mesmo campo, detectando qual
  validar pelo tamanho do número.
- **Posição no menu:** "Anúncios" foi adicionado ao grupo "Cadastros", logo
  depois de "Produtos" (antes de "Fornecedores") — pedido explícito do
  usuário foi a aba ficar "próxima de Produtos". Fornecedores e Produtos já
  existiam como itens do menu (desativados, com placeholder "Em
  desenvolvimento") — só precisaram ser ativados com tela real, sem mexer
  na posição deles no menu.
- **Testado localmente** (sem poder rodar o servidor Express+pg neste
  ambiente — ver `05-problemas-conhecidos.md`): `node --check` em todos os
  arquivos de backend novos/alterados e no bloco de script do front-end;
  schema aplicado no Postgres local (`cerne_dev`) confirmando criação das
  tabelas novas sem afetar as existentes; CRUD completo de Produtos e
  Fornecedores testado direto via `psql` com as mesmas queries das rotas
  (criar, listar, buscar, editar, ativar/desativar, e a violação de
  unicidade de SKU/documento por empresa); validação de CPF testada com
  números conhecidos válidos/inválidos; extração de SKU do anúncio testada
  com os 5 cenários possíveis (atributo, campo legado, sem SKU, variações
  com SKU igual, variações com SKU diferente); máscara de CNPJ/CPF do
  formulário testada com digitação progressiva de ambos os formatos. Não
  foi possível testar a chamada real à API de itens do Mercado Livre nem
  rodar o servidor Express completo neste ambiente — isso depende do teste
  ao vivo em produção depois do deploy (ver `04-alteracoes.md` e
  `06-proximos-passos.md`).

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
