# Decisões do Projeto

Registro de decisões importantes tomadas ao longo do desenvolvimento, na ordem
em que foram tomadas (mais recente no topo).

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
