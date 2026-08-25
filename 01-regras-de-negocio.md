# Regras de Negócio

Este arquivo reúne as regras de negócio do ERP, explicadas pelo usuário ao longo
do desenvolvimento. Cada regra deve ser registrada na seção do módulo a que
pertence. Se um módulo ainda não tem regras, ele fica com a seção vazia até que
o usuário explique.

Se uma regra mudar, atualizar a seção correspondente (não deixar a regra antiga
junto da nova).

## Empresas / CNPJs
- Cada empresa cadastrada tem: CNPJ (único, validado — não aceita CNPJ
  inválido nem duplicado), razão social, nome fantasia (opcional) e status
  ativo/inativo.
- É possível cadastrar, editar, listar e ativar/desativar uma empresa.
- Por enquanto **não existe exclusão definitiva** de empresa — só
  ativar/desativar. Isso pode mudar futuramente, mas não foi pedido ainda.
- Empresas inativas continuam existindo no banco (para histórico), só ficam
  marcadas como inativas.

## Mercado Livre
- Integração real via OAuth 2.0 + PKCE (não é simulação). O usuário clica em
  "Conectar Mercado Livre" na tela de Marketplaces, autoriza no site do
  próprio Mercado Livre (login/consentimento acontece lá, nunca dentro do
  ERP) e volta conectado.
- Uma empresa pode ter uma conta do Mercado Livre conectada (1 conta ML por
  `ml_user_id`, vinculada a uma empresa do ERP).
- Access token e refresh token ficam **criptografados no banco** (AES-256-GCM)
  — nunca em texto puro, nunca expostos para o front-end. O token é renovado
  automaticamente pouco antes de expirar, usando o refresh token.
- **Shopee ainda não foi desenvolvida** — só Mercado Livre por enquanto.
- **Desde 24/08/2026, o ERP não depende mais do botão manual para
  funcionar no dia a dia** (ver `04-alteracoes.md` (19)). Existe uma
  **sincronização automática, executada pelo próprio servidor** (nunca pelo
  navegador de quem está com o ERP aberto — funciona mesmo sem ninguém
  logado), que roda **a cada 1 minuto**, verificando **todas as contas do
  Mercado Livre conectadas e com status "ativa"** (nunca as com erro/
  desconectadas). O botão "Sincronizar agora" continua existindo — vira uma
  opção de emergência/manual, não o único jeito de os pedidos entrarem.
- A cada execução (automática ou manual), o ERP verifica: pedidos novos,
  mudança de status, pagamentos, cancelamentos, devoluções, informações de
  envio, taxas/comissões, frete do vendedor, frete do comprador e as demais
  informações financeiras já importadas — sempre pelo mesmo caminho de
  código (`lib/mlSync.js#sincronizarConta`), então nunca existe uma "versão
  automática" com regras diferentes da manual.
- Sincronizar pedidos (botão "Sincronizar agora" ou o ciclo automático)
  traz, por padrão, **somente os pedidos dos últimos 30 dias** (pedido
  explícito do usuário — não traz o histórico completo). Existe, além
  dela, uma **sincronização histórica** separada (por enquanto só via API,
  sem botão na tela) que traz todo o período desde uma data escolhida —
  ver `## Banco de dados` abaixo.
- **A sincronização automática de 1 em 1 minuto usa uma janela mais curta**
  (por padrão, últimos 2 dias — configurável no servidor via
  `ML_SYNC_RECONCILIACAO_DIAS`), não os 30 dias do botão manual: repetir uma
  busca de 30 dias inteira a cada 60 segundos não é viável (uma conta com
  muitos pedidos pode levar minutos para sincronizar sozinha — ver
  `05-problemas-conhecidos.md`) nem necessário, porque a notificação em
  tempo real (webhook, ver seção própria abaixo) já cobre pedidos de
  qualquer idade — o ciclo de 1 minuto é a camada de
  **segurança/reconciliação**, não a única forma de um pedido entrar.
- Sincronizar de novo (resync, manual ou automático) nunca duplica pedido:
  cada pedido é identificado pelo ID do Mercado Livre + conta, e é
  atualizado (não recriado) se já existir. Vale para a sincronização normal
  (30 dias), a automática (janela curta) e a histórica.
- **Regra central: nunca inventar/estimar valor financeiro.** Comissão,
  tarifas, frete — só são gravados se a API do Mercado Livre realmente
  retornar aquele campo para aquele pedido. Se a API não retornar, o campo
  fica **indisponível/pendente no sistema (nunca um número calculado, nunca
  zero fingindo ser um valor real)**.
- **Frete do comprador e frete do vendedor são valores diferentes e nunca
  podem ser misturados.** O que o comprador pagou de frete
  (`receiver.cost`) é guardado separado do que foi cobrado do vendedor
  (`senders[].cost`). Nem todo frete é do vendedor — cada um é exatamente o
  que a API retornou para aquele lado.
- Logística do envio (Full/Fulfillment, Mercado Envios, etc.) é guardada
  exatamente como a API do Mercado Livre retorna — nunca deduzida/adivinhada.
- O payload bruto (resposta original da API) de cada pedido, envio e custo de
  envio é guardado separado dos campos já organizados, para auditoria futura.
- **Pedido novo entra no sistema sozinho, sem precisar clicar em
  "Sincronizar".** Duas camadas, combinadas (estratégia pedida pelo
  usuário): o Mercado Livre avisa o ERP em tempo real (webhook, tópico
  `orders_v2`) assim que um pedido é criado/atualizado, e o ERP já importa
  esse pedido automaticamente na hora — **atualização rápida**; além disso,
  o ciclo automático de 1 em 1 minuto (acima) verifica de novo as contas
  ativas — **segurança/reconciliação**, cobrindo o que a notificação não
  tenha avisado por qualquer motivo. As duas usam exatamente a mesma
  lógica/regras de sempre (nunca inventar valor, nunca duplicar pedido). O
  botão "Sincronizar agora" continua existindo, como opção de
  emergência/manual — ele não é mais o único jeito de um pedido aparecer no
  sistema.
- **Status da sincronização, visível no ERP:** um indicador discreto no
  cabeçalho mostra "Sincronizado há X segundos/minutos" (ou "Última
  sincronização: HH:MM" quando faz mais de uma hora), e "Erro na
  sincronização" quando o último ciclo automático falhou — com o motivo
  disponível ao passar o mouse, e sempre registrado no log do servidor para
  análise. Um erro numa sincronização nunca impede as próximas (nem de
  outras contas no mesmo ciclo, nem dos próximos ciclos) — ver
  `lib/syncScheduler.js`.

## Banco de dados (armazenamento permanente)
- **Supabase (Postgres) é o banco principal e permanente do ERP.** Todas as
  telas que mostram indicadores (Visão Geral, Pedidos, Financeiro) leem
  **só do banco** — nunca fazem chamada em tempo real à API do Mercado
  Livre para montar a tela. Os dados da API só chegam ao banco através da
  sincronização (normal ou histórica) e do webhook.
- Nenhuma credencial (chave de acesso do Supabase, tokens do Mercado Livre,
  senha do banco) fica exposta no front-end — tudo fica em variável de
  ambiente só do servidor.
- Existe uma **sincronização histórica** (`POST
  /api/integracoes/mercadolivre/:id/sincronizar-historico`, corpo `{ desde:
  'YYYY-MM-DD' }`) que importa todos os pedidos de uma conta desde a data
  informada até hoje — diferente da sincronização normal, que só pega os
  últimos 30 dias. Roda em segundo plano (pode levar bastante tempo),
  dia a dia, e pode ser consultada em `GET
  .../sincronizar-historico/status?desde=YYYY-MM-DD`.
- A sincronização histórica é **retomável**: se for interrompida, a próxima
  execução com o mesmo `desde` continua de onde parou (não reprocessa dias
  já concluídos) enquanto o status daquela execução não estiver
  `concluido`. Depois de `concluido`, rodar de novo com o mesmo `desde`
  cria uma nova execução que reprocessa o período inteiro — sem duplicar
  pedido nenhum, porque a gravação de cada pedido é um "upsert" (identificado
  por conta + ID do pedido no Mercado Livre): já existindo, atualiza; não
  existindo, cria.
- Para cada pedido são guardados: dados gerais do pedido, itens (com
  SKU/quantidade/valores), **todos os pagamentos** (tabela própria, um
  pedido pode ter mais de um pagamento), envio/logística, frete do
  comprador e do vendedor, taxas/comissão e status (incluindo cancelamento).
  Cálculo de custo do produto e de imposto **não fez parte desta etapa** —
  continuou como já estava até então (na época, `custos_produto` +
  `config_financeiro`, usados por `lib/resultadoVenda.js`; desde 24/08/2026
  o custo por SKU passou a vir de `produtos` — ver seção **Produtos**,
  abaixo, e **Custos**, mais abaixo).

## Notificações do Mercado Livre (webhook)
- O ERP recebe as notificações do Mercado Livre (evento de pedido novo/
  atualizado) numa URL própria e as usa só para saber "tem pedido pra
  buscar" — os dados do pedido em si sempre vêm de buscar de novo na API do
  Mercado Livre (a notificação não traz o pedido completo).
- Notificação de uma conta que não está conectada neste ERP é ignorada.
- Regra combinada com o usuário: se a notificação chegar mas a importação
  falhar por algum motivo, o pedido não fica perdido — a próxima
  sincronização (manual ou automática, a cada 1 minuto) cobre esse pedido
  normalmente, desde que dentro da janela de reconciliação (ver seção
  **Mercado Livre**, acima).
- **Continua não confirmado com uma notificação real do Mercado Livre em
  produção** (só testado com payloads simulados) — ver
  `05-problemas-conhecidos.md`. Isso não bloqueia o funcionamento do ERP: a
  sincronização automática de 1 em 1 minuto (acima) é a camada de segurança
  justamente para esse cenário.

## Shopee
- **Integração real via OAuth da Shopee Open Platform v2** (não é simulação),
  ativada em 25/08/2026 — pedido do usuário em 3 passos: preparar a
  integração (credenciais só no backend), fazer o botão "Conectar Shopee"
  funcionar de verdade, e testar/manter a conexão viva (renovação de
  token). **Nesta etapa, só a conexão da loja** — pedidos, estoque, Ads e
  financeiro da Shopee **não fazem parte** (pedido explícito do usuário:
  "não importe pedidos ainda", "não implemente estoque, Ads, Full ou
  financeiro da Shopee nesta tarefa"). Ver `02-decisoes.md` (29).
- O usuário clica em "Conectar Shopee" na tela de Marketplaces, autoriza no
  site da própria Shopee (login/consentimento acontece lá, nunca dentro do
  ERP) e volta conectado. Uma empresa pode ter uma loja da Shopee conectada
  (1 loja por `shopee_shop_id`, vinculada a uma empresa do ERP) — mesmo
  desenho já usado pelo Mercado Livre.
- **Diferente do Mercado Livre (OAuth2 + PKCE padrão), a Shopee Open
  Platform v2 assina CADA chamada** com HMAC-SHA256 (parâmetro `sign`,
  calculado com o `Partner Key`, que nunca trafega pela rede) — nunca usa
  PKCE. A Shopee também não tem um parâmetro `state` nativo na URL de
  autorização; a proteção contra CSRF é embutida na própria URL de retorno
  (`redirect`), que a Shopee preserva ao anexar `code`/`shop_id` de volta.
  Ver `lib/shopee.js`.
- Access token e refresh token ficam **criptografados no banco**
  (AES-256-GCM, mesmo algoritmo do Mercado Livre) — nunca em texto puro,
  nunca expostos para o front-end. A chave de criptografia é **própria da
  Shopee** (`SHOPEE_TOKEN_KEY`, variável de ambiente separada de
  `ML_TOKEN_KEY`) — um segredo nunca depende do outro.
- **Renovação de token é PROATIVA** (diferente do Mercado Livre, que renova
  sob demanda ao usar o token): como esta etapa ainda não importa pedidos
  da Shopee, não existe nenhuma outra chamada periódica que naturalmente
  manteria o token em uso — por isso um ciclo próprio
  (`lib/shopeeTokenScheduler.js`), rodando no servidor a cada 30 minutos,
  renova qualquer loja cujo token vença em menos de 60 minutos, mantendo a
  conexão viva indefinidamente sem exigir que o usuário reconecte
  manualmente. O access token da Shopee vale 4h; o refresh token, usado com
  regularidade por este ciclo, nunca fica tempo suficiente sem uso a ponto
  de expirar.
- **Salvo no banco após a autorização:** Shop ID, nome da loja (quando a
  API retorna), região, empresa vinculada, access token e refresh token
  (criptografados), expiração do token, status da conexão (`ativa` | `erro`
  | `desconectada`) e última atualização — mesmos campos já usados pelo
  Mercado Livre, adaptados ao vocabulário da Shopee.
- Reconectar a mesma loja (mesmo `shopee_shop_id`) nunca duplica linha —
  é sempre um upsert, mesma regra do Mercado Livre.
- **Nunca inventa dado**: se o nome/região da loja não vier na chamada
  extra feita logo após a autorização, a conexão ainda é salva (o
  essencial: tokens + Shop ID) — só sem nome/região por ora, nunca um valor
  inventado no lugar.
- **Ambiente configurável** (`SHOPEE_HOST`, variável de ambiente) —
  permite apontar para o ambiente de testes/sandbox da Shopee
  (`partner.test-stable.shopeemobile.com`) sem alterar código, antes de
  usar o ambiente de produção (`partner.shopeemobile.com`, padrão).

## Visão Geral
- A tela **nunca chama a API do Mercado Livre em tempo real** — todos os
  indicadores vêm de consulta ao banco (Supabase/Postgres), lendo os
  pedidos já sincronizados. Confirmado ao vivo: a tela carrega e os 5
  filtros de período funcionam normalmente mesmo sem nenhuma chamada nova
  ao Mercado Livre no momento (ver `04-alteracoes.md`).
- A tela usa dados reais dos pedidos do Mercado Livre já sincronizados —
  nada de indicador decorativo/estático. Mostra, para a empresa e o
  **período selecionado**: faturamento, quantidade de pedidos, margem de
  contribuição (R$ e %) quando já houver dados suficientes, taxas/
  comissões, frete do vendedor, imposto e custo dos produtos — e um
  gráfico de Faturamento x Margem de contribuição por dia.
- **Empresa e período são escolhidos só no HEADER** (topo da tela, os dois
  botões ao lado do sino de notificações) — é a **única fonte de verdade**
  dessas duas escolhas para a Visão Geral. Não existe mais um segundo
  seletor dentro da própria página (existia antes; foi removido por ser
  duplicado e nunca ficar em sincronia com o header). Trocar empresa ou
  período no header atualiza a Visão Geral na hora.
- **Filtro de período de verdade** (não decorativo, e não só visual — a
  consulta ao banco também respeita): Hoje, Ontem, Últimos 7 dias, Últimos
  30 dias ou Este mês. Tudo no fuso `America/Sao_Paulo` (BRT, UTC-3 fixo —
  o Brasil não usa mais horário de verão desde 2019). "Hoje" e "Ontem" são
  o dia inteiro, início e fim exatos (00:00:00 até 23:59:59 daquele dia em
  BRT) — nunca deixam pedido de um dia vazar pro resultado do outro.
  "7/30 dias" são uma janela corrida a partir de agora.
- Se não houver nenhum pedido no período, os indicadores mostram "Sem
  dados". Se houver pedido mas faltar alguma informação (ex: custo de SKU
  não cadastrado em algum pedido), mostra "Pendente" — nunca um número
  calculado com uma parte inventada.
- Ver a regra de **pedidos cancelados** em "Outras regras gerais", abaixo —
  vale igualmente aqui.
- **Parte inferior da tela — ativada em 26/08/2026** (pedido do usuário, em
  3 passos; antes ficava com dado de demonstração/"em breve"). Os 5 blocos
  abaixo usam SEMPRE a empresa e o período do header — nenhum filtro
  próprio — e nunca recalculam nada: reaproveitam exatamente as mesmas
  funções de Visão Geral/Pedidos/Financeiro/Relatórios
  (`lib/relatorioVendas.js`, `lib/contasPagar.js`, `lib/contasReceber.js`,
  `lib/recebimentosMl.js`). Ver `lib/visaoGeralPainel.js`,
  `02-decisoes.md` (21) e `04-alteracoes.md` (21) para o desenho completo.
  - **Evolução diária:** o mesmo gráfico de Faturamento x Margem de
    contribuição por dia mostrado acima, numa versão compacta — mesmo
    dado, nunca um segundo cálculo.
  - **Por marketplace:** faturamento, quantidade de pedidos e participação
    % no faturamento, agrupado por canal de venda. Hoje existe só o
    Mercado Livre (única integração de pedidos do ERP) — a tela já está
    escrita para, quando uma segunda integração existir (ex: Shopee),
    aparecer como uma linha nova automaticamente, sem precisar mudar mais
    nada nesta tela.
  - **Fluxo de Caixa:** contas a receber em aberto, contas a pagar em
    aberto e recebimentos do Mercado Livre (líquido esperado no período) —
    os mesmos números já mostrados em Contas a Pagar/Contas a
    Receber/Recebimentos. **Saldo projetado** sempre aparece como
    "Indisponível" — o ERP ainda não tem nenhum cadastro de saldo
    bancário real, e sem um saldo inicial de verdade esse número nunca
    pode ser calculado com segurança (nunca um valor inventado).
  - **Conexões & Empresas:** quantidade real de empresas cadastradas;
    Mercado Livre — quantidade de contas conectadas, status e última
    sincronização; **Shopee (real desde 25/08/2026)** — quantidade de lojas
    conectadas e status (a Shopee ainda não tem "última sincronização" de
    pedidos pra mostrar aqui — só a conexão em si, ver seção **Shopee**).
    Nenhum texto fictício de demonstração.
  - **Alertas & IA:** central de alertas por regras simples sobre dado
    real (não é uma IA/modelo preditivo ainda) — SKU sem custo
    cadastrado, pedido sem custo (impede a margem), venda com margem de
    contribuição negativa, erro de sincronização do Mercado Livre, conta a
    pagar vencida, recebimento (conta a receber) atrasado, e estoque
    zerado/muito baixo (≤ 5 unidades, só para item já sincronizado — nunca
    a partir de um dado pendente). Clicar num alerta abre a tela
    relacionada (ex: clicar em "SKU ABC está sem custo cadastrado" abre
    Produtos).

## Pedidos
- Pedidos do sistema hoje vêm só do Mercado Livre (Shopee ainda não existe).
  Cada pedido importado guarda: ID do pedido, data, status, comprador, cada
  item (com SKU, título, quantidade, preço unitário e total), ID do anúncio,
  ID do pagamento, ID do envio, tarifas/comissão reais da API, frete do
  comprador e do vendedor separados, e o tipo de logística.
- Ver a regra completa de "nunca inventar valor" e separação de frete em
  **Mercado Livre**, acima — vale igualmente para os pedidos importados.
- A lista de pedidos (tela Pedidos) usa o mesmo cálculo de período de
  Visão Geral/Financeiro (período escolhido no seletor da própria tela —
  ver nota abaixo), e mostra por pedido, priorizando a informação que cabe
  na largura normal da tela desktop sem precisar rolar pro lado: data,
  número do pedido, produto/SKU (numa coluna só), quantidade, valor da
  venda, taxas/comissões, frete do vendedor, **custo do produto** (soma do
  custo cadastrado de cada SKU do pedido), **margem de contribuição** (R$ e
  %) — ver fórmula em **Custos**, abaixo — logística e status. Se qualquer
  parte estiver faltando, a coluna mostra "pendente" em vez de um número —
  nunca um valor parcial/estimado. **Loja** e **imposto** do pedido não
  ficam mais como coluna própria — continuam disponíveis no detalhe do
  pedido (mesma informação, só que dentro do clique, pra tabela caber sem
  rolagem horizontal).
- Clicando no pedido abre o detalhe completo, mostrando a loja, o imposto e
  exatamente como o resultado daquela venda foi calculado (cada parte
  subtraída, uma por uma, até a margem de contribuição final).
- **Nota:** o seletor de empresa/período da tela Pedidos é próprio dessa
  tela (não é o mesmo do header, que hoje só controla a Visão Geral — ver
  seção "Visão Geral", acima) — mas usa a mesma regra de cálculo de período
  (`lib/periodo.js`) das outras duas telas, então o mesmo período nunca
  significa datas diferentes dependendo de onde foi escolhido.
- Pedidos cancelados aparecem normalmente na lista (linha esmaecida, para
  diferenciar visualmente) — a regra de não entrarem no resultado
  financeiro vale só pros números agregados de Visão Geral/Financeiro, não
  pra esta listagem operacional. Ver "Outras regras gerais", abaixo.
- **Filtros:** além de empresa e período, a tela tem filtro por **loja**
  (conta do Mercado Livre conectada àquela empresa), **status** do pedido e
  busca livre por **produto/SKU**. As opções de loja vêm das contas ML
  cadastradas na empresa; as opções de status vêm dos status **reais**
  encontrados nos pedidos do período (nunca uma lista fixa adivinhada — se
  um status novo aparecer na API do Mercado Livre, ele aparece sozinho no
  filtro). Os filtros de loja/status/busca são aplicados em cima do
  resultado já calculado (mesmos pedidos, mesmos números) — nunca mudam a
  forma como o resultado de cada pedido é calculado.
- **Relatório de Pedidos:** o botão "Gerar relatório" (Excel ou CSV) exporta
  exatamente os pedidos que batem com os filtros selecionados na tela no
  momento do clique (empresa, período, loja, status, produto/SKU) — se a
  tela está mostrando só "Hoje", o relatório traz só os pedidos de hoje. O
  relatório usa o mesmo cálculo da tela (`lib/relatorioVendas.js`,
  inalterado) — não existe uma regra financeira separada para a
  exportação. Cada linha do relatório é um pedido, com: data, número do
  pedido, loja, produto, SKU, quantidade, valor da venda, descontos,
  taxas/comissões do Mercado Livre, frete pago pelo comprador, frete do
  vendedor, imposto, custo do produto, margem de contribuição em R$ e em
  %, logística e status. No fim do relatório vem um resumo: total
  faturado, total de pedidos, total de unidades, total de taxas/comissões,
  total de frete do vendedor, total de imposto, total de custo dos
  produtos, margem de contribuição total em R$ e margem média em %, além
  dos pedidos cancelados (contados à parte, fora dos totais acima, seguindo
  a mesma regra de Visão Geral/Financeiro). Onde faltar informação, o
  relatório mostra "pendente" (nunca inventa um número) — mas quando o
  resultado de uma soma é realmente zero (ex: filtro só de pedidos
  cancelados, então não há pedidos não-cancelados para somar), mostra
  "R$ 0,00", que é diferente de "pendente" (dado faltando). O nome do
  arquivo traz a data ou o intervalo de datas do período filtrado (ex:
  `relatorio-pedidos-2026-08-24.xlsx` ou
  `relatorio-pedidos-2026-08-01-a-2026-08-24.xlsx`). O **desconto** de cada
  pedido vem do preço original informado pelo Mercado Livre na API (quando
  diferente do preço cobrado) — não é um valor calculado por regra própria
  do relatório.

## Produtos
- Cadastro simples, por empresa: **nome, SKU, custo e status**
  (ativo/inativo). É possível cadastrar, listar, editar, pesquisar (por nome
  ou SKU) e ativar/desativar um produto.
- **SKU é único por empresa** (a mesma empresa não pode ter dois produtos
  com o mesmo SKU) — mas o mesmo SKU pode existir em empresas diferentes.
- **Ainda não existem regras de kits, composição (produto feito de outros
  produtos) nem controle de estoque automático** — pedido explícito do
  usuário para esta etapa ser só um cadastro simples e funcional. Isso pode
  vir depois, quando for pedido.
- **Desde 24/08/2026, esta é a ÚNICA tela onde se cadastra/edita custo por
  SKU e a alíquota de imposto da empresa** — a antiga tela separada "Custo
  & Margem" foi removida, e o cadastro de custo (tabela `custos_produto`)
  foi migrado pra dentro de `produtos`, que agora é a fonte de custo usada
  no cálculo de margem das vendas do Mercado Livre (Pedidos, Visão Geral,
  Financeiro e Relatórios). A alíquota de imposto continua única por
  empresa (não por produto) — só passou a ser configurada nesta tela em vez
  de numa aba própria. Ver `02-decisoes.md` e `04-alteracoes.md` (14).
- **Esta tela NUNCA mostra margem de contribuição** — só cadastra/edita
  SKU, custo e (a nível de empresa) o imposto. A margem calculada com esses
  valores só aparece nas telas de vendas (Pedidos, Visão Geral, Financeiro,
  Relatórios) — pedido explícito do usuário.
- Por enquanto **não existe exclusão definitiva** de produto — só
  ativar/desativar (mesma regra de Empresas). Desativar um produto não
  apaga o custo usado no cálculo de vendas já feitas (ou futuras) daquele
  SKU — é só uma flag de catálogo/visibilidade.

## Anúncios
- Mostra os **anúncios reais das contas do Mercado Livre conectadas** — não
  existe (e não pode existir) anúncio cadastrado manualmente ou fictício
  nesta tela.
- Campos mostrados por anúncio: **ID do anúncio, título, SKU, loja
  (conta/nickname do Mercado Livre), preço, estoque disponível, status e
  tipo do anúncio**.
- **Busca ao vivo, direto na API do Mercado Livre, a cada vez que a tela é
  aberta ou atualizada** — nenhum anúncio fica salvo no banco de dados
  nesta etapa (diferente de Pedidos, que são importados e guardados). Ver
  `02-decisoes.md`.
- Se a empresa não tiver nenhuma conta do Mercado Livre conectada, ou a
  conexão estiver com erro, ou a API do Mercado Livre falhar ao responder,
  a tela **mostra claramente que a sincronização está pendente** (com o
  motivo) — nunca inventa ou mantém na tela um anúncio de exemplo.
- Se o Mercado Livre não retornar o SKU de um anúncio (ou o anúncio tiver
  variações com SKUs diferentes, sem um único SKU "principal"), o campo
  aparece como "—" nessa linha — nunca um SKU adivinhado.
- **Nesta etapa não é possível editar preço nem estoque pelo Mercado
  Livre** — pedido explícito do usuário para primeiro visualizar
  corretamente os anúncios, antes de qualquer edição.

## Produto base / SKU de venda / Multiplicador (DEPRECIADO para fins de estoque desde 26/08/2026; REATIVADO em 25/08/2026 para Relatórios)
- Este conceito (produto físico real por trás de vários SKUs/kits do
  Mercado Livre, com um multiplicador de conversão) foi criado só pra
  alimentar a tela Estoque de uma etapa anterior. Desde 26/08/2026 a tela
  Estoque não usa mais produto base/multiplicador — ver seção "Estoque"
  abaixo. As tabelas (`produtos_base`, `produto_base_skus`) e as rotas de
  API (`routes/produtosBase.js`) continuam existindo (nada foi apagado),
  e voltaram a ser lidas (só leitura, nunca escritas por esta tela) pela
  visão "Por Caixa" de Relatórios → Produtos, ativada em 25/08/2026 — ver
  seção "Relatórios" acima. Um vínculo salvo aqui (`produto_base_skus`)
  continua sendo a fonte que vale quando existe; sem ele, o relatório usa
  o mesmo padrão de leitura de SKU já usado nas sugestões desta tela
  (`lib/skuProdutoBase.js`). Ainda não existe uma tela de gestão desses
  vínculos no menu — a API (`routes/produtosBase.js`) já permite
  cadastrar/corrigir, mas sem interface (ver `06-proximos-passos.md`).
- **O SKU original recebido do Mercado Livre nunca é alterado** — nem no
  pedido, nem em lugar nenhum, então nada nesta descontinuação afeta
  cálculo de venda/margem/DRE (que nunca dependeram de produto base).

## Estoque / Estoque Full — Mercado Livre como fonte oficial (26/08/2026)
Reescrita completa da lógica do módulo, por pedido explícito do usuário: ele
faz todos os lançamentos e ajustes de estoque **direto no Mercado Livre**, o
ERP nunca mais aceita ajuste manual e nunca decide um saldo por conta
própria — só espelha, somente leitura, o que o Mercado Livre responder. As
regras "Galpão" / "produto base" / multiplicador descritas nas seções
anteriores foram **substituídas** por este modelo (ficam documentadas ali
só como histórico).

- **Duas telas separadas** — nunca uma só com filtro combinado: **Estoque**
  mostra o estoque disponível **fora do Full**; **Estoque Full** mostra,
  separadamente, a quantidade armazenada no Full. As duas nunca somam nem
  misturam saldo — cada uma lê um conjunto de linhas próprio (marcado por
  `tipo` no banco: `proprio` ou `full`), então nunca existe ambiguidade
  sobre de onde um número veio.
- **Uma linha por anúncio/variação** (nunca agrupado por produto base ou
  por "produto físico") — colunas: produto/anúncio, SKU, loja (conta do
  Mercado Livre), ID do anúncio (+ ID da variação quando houver), estoque
  disponível, status do anúncio e última sincronização.
- **Quantidade é sempre somente leitura.** Não existe mais botão de
  ajuste, modal, nem endpoint de escrita de quantidade nas telas Estoque/
  Estoque Full — a única forma de mudar o saldo é ajustando direto no
  Mercado Livre. Se o usuário mudar de 500 para 800 unidades lá, o ERP
  mostra 800 depois da próxima sincronização (automática, até 1 minuto
  depois, ou imediatamente com o botão "Sincronizar agora").
- **Fonte da quantidade, por tipo de anúncio:**
  - **Full** (`logistic_type = 'fulfillment'`): mesmo recurso já usado e
    validado por Anúncios/Estoque Full antigo —
    `/inventories/{inventory_id}/stock/fulfillment`.
  - **Fora do Full, conta simples:** `available_quantity` do item/variação
    (recurso simples, sempre disponível, documentado).
  - **Fora do Full, conta com estoque multi-origem / User Products**
    (anúncio com `user_product_id`): consulta `GET /user-products/{id}`
    em vez de confiar só no `available_quantity` do anúncio. **Atenção:**
    o formato exato da resposta desse recurso não pôde ser confirmado
    contra a documentação oficial nem contra uma conta real nesta etapa
    (ver `05-problemas-conhecidos.md`) — o parsing é defensivo (tenta
    alguns formatos plausíveis) e, se não reconhecer a resposta ou a
    chamada falhar, tenta o `available_quantity` do anúncio como
    segurança antes de marcar como pendente. **Nunca inventa um número.**
- **Sincronização automática**, reaproveitando o mesmo ciclo de 1 em 1
  minuto criado para pedidos (`server/lib/syncScheduler.js`) — todas as
  contas ativas são varridas, cada anúncio/variação é gravado (upsert,
  nunca duplica) com a quantidade e o horário da sincronização. Erro numa
  conta nunca afeta as demais nem o pedido de pedidos (laço independente).
  O botão "Sincronizar agora" em cada tela é só a opção de emergência.
- **Nunca inventa.** Quando a API não retorna a quantidade (ou o recurso
  de User Products responde num formato não reconhecido), a linha fica com
  quantidade `null` e "Pendente" na tela — nunca 0, nunca um número
  calculado.
- **Nunca dá baixa de estoque no ERP por causa de uma venda.** O ERP não
  tem (e nunca teve) nenhuma lógica que decremente estoque ao importar um
  pedido — a sincronização de pedidos (`lib/mlSync.js`) sempre foi só
  financeira/operacional, nunca mexeu em nenhuma tabela de estoque. Como o
  saldo mostrado é sempre um espelho fresco do que o Mercado Livre
  retornou (nunca uma soma/subtração feita pelo ERP), não existe risco de
  desconto duplicado.
- Nunca mistura contas/empresas: cada linha carrega o `conta_ml_id`/
  `empresa_id` de onde veio, e a tela mostra os itens de todas as contas
  ativas conectadas à empresa selecionada (cada um com sua própria coluna
  "Loja").

## Compras
- Primeira versão simples de pedido de compra a um fornecedor: **criar,
  listar, editar, pesquisar (por fornecedor) e mudar status**.
- Campos de uma compra: **fornecedor, um ou mais itens (produto,
  quantidade, custo unitário — o valor do item é quantidade × custo
  unitário), valor total (soma dos itens), data da compra, previsão de
  chegada (opcional) e status**.
- **Valor total é sempre calculado pelo sistema**, a partir dos itens —
  nunca aceito pronto de fora, pra nunca ficar dessincronizado da soma
  real.
- **Status possíveis: Em aberto, Pedido realizado, Recebido, Cancelado.**
  A compra começa como "Em aberto" e o status pode ser trocado livremente
  entre os quatro a qualquer momento nesta etapa.
- **Marcar uma compra como "Recebido" não faz nada além de mudar o
  status** — pedido explícito do usuário para NÃO automatizar ainda a
  entrada desses itens no Estoque. Essa automação fica para uma etapa
  futura, quando for pedida.
- **Não existe IA de compras** (sugestão de reposição, previsão de
  demanda, etc.) nesta etapa — pedido explícito do usuário.

## Fornecedores
- Cadastro por empresa: **razão social/nome, nome fantasia (opcional),
  CNPJ ou CPF, telefone (opcional), e-mail (opcional), observação
  (opcional) e status** (ativo/inativo). É possível cadastrar, listar,
  editar, pesquisar (por razão social, fantasia ou CNPJ/CPF) e
  ativar/desativar um fornecedor.
- **Aceita CNPJ (pessoa jurídica) ou CPF (pessoa física)** no mesmo campo —
  o sistema identifica pelo tamanho do número (14 dígitos = CNPJ, 11 =
  CPF) e valida os dígitos verificadores de cada um.
- **Documento (CNPJ/CPF) é único por empresa** — a mesma empresa não pode
  cadastrar o mesmo fornecedor duas vezes.
- **Estrutura já preparada para relacionar fornecedor a produtos e a
  compras no futuro** (cada fornecedor já pertence a uma empresa) — essa
  relação em si (quais produtos cada fornecedor fornece, pedidos de compra)
  ainda não existe, não foi pedida nesta etapa.
- Por enquanto **não existe exclusão definitiva** de fornecedor — só
  ativar/desativar (mesma regra de Empresas e Produtos).

## Financeiro
- **Primeira versão, focada só nas vendas do Mercado Livre já sincronizadas**
  — não é a DRE completa. Mostra, para a empresa e o período selecionado:
  faturamento bruto, taxas e comissões, frete pago pelo vendedor, impostos,
  custo dos produtos, margem de contribuição em R$ e em %.
- Usa o mesmo seletor de período (Hoje / Ontem / 7 dias / 30 dias / Este
  mês) e a mesma regra de cálculo da Visão Geral e dos Pedidos — nunca um
  valor diferente pro mesmo período em telas diferentes.
- **Por pedido do usuário, NÃO fazem parte desta etapa:** contas a pagar,
  contas a receber, fluxo de caixa, DRE completa, banco, fornecedores,
  Shopee. Isso vem depois, quando for pedido.

## Contas a pagar
_(sem regras registradas ainda)_

## Contas a receber
_(sem regras registradas ainda)_

## Recebimentos dos marketplaces
_(sem regras registradas ainda)_

## Custos
- **Desde 24/08/2026, custo por SKU e alíquota de imposto são cadastrados
  na tela Produtos** (não existe mais uma tela separada "Custo & Margem")
  — ver seção **Produtos**, acima, e `02-decisoes.md`. As regras de cálculo
  abaixo não mudaram, só onde o usuário cadastra os valores.
- Custo do produto é cadastrado **por SKU**, por empresa (ex: SKU
  "50CX-24X15X10", custo R$ 32,50). Não vem do Mercado Livre — é digitado
  pelo usuário no ERP.
- Alíquota de imposto é um **percentual configurado no ERP, por empresa**
  (não vem do Mercado Livre nem de nenhum marketplace) — continua única
  por empresa, não por produto (decisão confirmada com o usuário em
  24/08/2026, ver `02-decisoes.md`).
- Resultado da venda de um pedido = valor da venda **(-)** comissão/tarifas
  reais do Mercado Livre **(-)** frete do vendedor **(-)** imposto (calculado
  com a alíquota configurada) **(-)** custo do produto (pelo SKU
  cadastrado). O frete pago pelo comprador é mostrado à parte, só
  informativo — nunca entra nessa conta.
- Se faltar qualquer uma dessas partes (custo do SKU ainda não cadastrado,
  ou a API do Mercado Livre não ter retornado alguma tarifa/frete daquele
  pedido), o **resultado final não é calculado** — o sistema mostra
  exatamente o que está faltando, em vez de calcular com um valor
  presumido.

## Lucro real por pedido / Margem por produto
_(sem regras registradas ainda)_

## Ads
_(sem regras registradas ainda)_

## DRE
- **Ativado em 24/08/2026.** Nenhuma fórmula financeira nova — é a mesma
  fonte única já usada em Visão Geral/Pedidos/Financeiro/Relatórios
  (`lib/relatorioVendas.js`) reorganizada em formato de demonstrativo, mais
  a mesma consulta já usada em Contas a Pagar (`resumoContasPagar`) para a
  linha de despesas do período.
- Linhas mostradas, sempre em R$ **e** em % sobre o faturamento (a mesma
  base já usada pela Margem de Contribuição em Financeiro/Visão Geral —
  vendas não canceladas do período): Receita Bruta, (-) Cancelamentos/
  Devoluções, (-) Descontos concedidos (cupom), = Receita Líquida, (-)
  Custo dos Produtos, (-) Taxas e Comissões dos marketplaces, (-) Frete do
  vendedor, (-) Impostos, = Margem de Contribuição, (-) Despesas/Contas
  pagas no período, = Resultado Final.
- A **Margem de Contribuição é sempre lida direto de `resumirPeriodo`**
  (nunca recalculada por subtração das linhas do demonstrativo), pra nunca
  divergir do valor já mostrado em Pedidos/Visão Geral/Financeiro. Em
  casos raros de pendência parcial, a soma das linhas do demonstrativo
  pode não bater centavo a centavo com esse número — o número da Margem
  de Contribuição é sempre o correto.
- Despesas/Contas pagas do período = exatamente o "pago no período" já
  mostrado em Contas a Pagar — sempre um valor real (nunca "Pendente"),
  independente de ter havido venda ou não no período.
- **Nunca inventa valor.** Sem nenhum pedido no período inteiro, todas as
  linhas de receita mostram "Sem dados" (nunca R$ 0,00) — mesma convenção
  já usada na Visão Geral. Havendo pedido no período mas faltando alguma
  informação (ex: custo do produto ainda não cadastrado para algum SKU
  vendido), a linha correspondente mostra "Pendente". Resultado Final só é
  calculado quando a Margem de Contribuição em si é conhecida.
- Filtros de empresa e período do cabeçalho (`window.CerneFiltro`)
  funcionam normalmente, mesmo padrão já usado nas outras telas.

## Faturamento
- **Ativado em 24/08/2026** como o hub central dos pedidos que precisam
  ser faturados — **sem emissão real de NF-e nesta etapa** (a emissão de
  verdade, ainda sem integração com a SEFAZ, é a tela "Emissão de notas
  fiscais", abaixo). Por isso as ações em lote se chamam "Marcar como
  Faturado/Erro/Cancelado", nunca "Emitir NF-e".
- Lista todos os pedidos reais do período (mesma fonte única de Pedidos),
  com a situação de faturamento de cada um. Status possíveis: Aguardando
  faturamento (padrão, quando o pedido ainda não tem nenhuma situação
  registrada), Faturado, Erro, Cancelado.
- A situação de faturamento fica numa tabela própria
  (`faturamento_pedidos`), no máximo 1 linha por pedido, vinculada por
  `pedido_id` — **nunca duplica dado do pedido**: cliente, loja,
  marketplace e valor sempre vêm do pedido original via JOIN.
- Suporta: pesquisar por número do pedido/loja/cliente, filtrar por
  empresa e por período (filtros do cabeçalho), filtrar por situação de
  faturamento, selecionar vários pedidos de uma vez (multi-seleção) e
  aplicar uma ação em lote sobre os selecionados.
- Trocar a situação de um pedido (individualmente ou em lote) nunca cria
  uma segunda linha — é sempre um upsert por `pedido_id`.

## Emissão de notas fiscais
- **Ativado em 24/08/2026** como estrutura para registrar e acompanhar
  notas fiscais vinculadas a pedidos — **sem integração real com a SEFAZ
  nesta etapa**: nenhuma nota é de fato transmitida/autorizada perante o
  fisco, é só o registro manual dos dados da nota no ERP.
- Cada pedido tem no máximo 1 nota fiscal registrada (`notas_fiscais`, 1
  linha por pedido, vinculada por `pedido_id`, upsert) — **nunca duplica
  dado do pedido**: cliente e loja sempre vêm do pedido original via
  JOIN. Histórico de múltiplas notas por pedido (ex: nota rejeitada e
  reemitida) fica para uma etapa futura, se for pedido.
- Status possíveis: Pendente (padrão, quando nenhuma nota foi registrada
  ainda para o pedido), Emitida, Cancelada, Rejeitada.
- **Nunca inventa número de NF-e nem chave de acesso.** Marcar uma nota
  como "Emitida" exige informar número, série, data de emissão e chave de
  acesso (44 dígitos) — o sistema rejeita a tentativa se faltar qualquer
  um desses campos, pra nunca fingir uma emissão que não aconteceu de
  verdade. Um pedido sem nota registrada aparece corretamente como
  "Pendente", com número/série/chave em branco.
- Abrir uma nota mostra os dados do pedido relacionado (data, cliente,
  loja, status do pedido, valor, itens) — mesma fonte já usada na tela de
  Pedidos.
- Filtros de empresa e período do cabeçalho funcionam normalmente; a tela
  também suporta pesquisar por número do pedido/nota/cliente e filtrar
  por status da nota.

## Relatórios
- **Categoria "Produtos" tem duas visões, alternáveis, sem remover
  nenhuma (25/08/2026):** **Por SKU** (comportamento original — cada
  SKU/kit do Mercado Livre é uma linha, com quantidade vendida,
  faturamento, custo, imposto e margem) e **Por Caixa** (nova — agrupa
  todos os SKUs/kit que representam a mesma medida/produto físico,
  somando tudo). As duas leem os mesmos itens de pedido do período
  (`buscarItensDoPeriodo`) — nenhum cálculo financeiro novo, nenhuma
  segunda fonte de dado.
- **Por Caixa — regras de cálculo:**
  - **Caixas físicas vendidas** = kits vendidos × unidades por kit do
    SKU, somado por produto base. Ex: `50CX-20X20X20` com 200 kits
    vendidos = 10.000 caixas.
  - **Faturamento** é a SOMA do faturamento de TODOS os SKUs/kit daquela
    medida — nunca dividido pela quantidade de caixas.
  - **Pedidos** = quantidade de pedidos distintos que tiveram algum item
    daquela medida (não soma pedido repetido).
  - **Kits vendidos** = soma da quantidade vendida de todos os SKUs/kit
    daquela medida, sem multiplicar.
- **Identificação de produto base é centralizada no backend** (nunca uma
  lógica no frontend), com uma ordem de prioridade fixa:
  1. Vínculo **salvo** em `produto_base_skus` (estrutura que já existia
     no banco, criada quando a tela Estoque ainda usava "produto base +
     multiplicador" — desativada para Estoque em 26/08/2026, mas nunca
     apagada, ver seção "Produto base" abaixo). Um vínculo salvo sempre
     vence, porque pode ter sido corrigido manualmente por um humano.
  2. Sem vínculo salvo, o texto do próprio SKU é interpretado pelo
     padrão "dígitos no início = unidades por kit, resto = código do
     produto base" (ex: `100CX-19X12X12` → produto base `CX-19X12X12`,
     100 unidades por kit). Isso NÃO é uma estimativa financeira — é
     leitura determinística de um identificador estruturado — por isso
     pode ser aplicado automaticamente no relatório, sem exigir
     cadastro manual prévio.
  3. SKU nulo, vazio, ou que não segue o padrão: **nunca é chutado**.
     Aparece à parte, em "SKUs sem produto base identificado" — some do
     agrupamento e do total de caixas físicas, de forma transparente.
- **Filtros de empresa, loja e período continuam valendo nas duas
  visões**, exatamente como no resto de Relatórios — selecionar "Hoje"
  no cabeçalho calcula só as vendas de hoje também na visão Por Caixa.
- **Exportação (XLSX/CSV) só existe hoje para a visão Por SKU** — não foi
  estendida para Por Caixa nesta etapa (fora do escopo do pedido). Os
  botões de exportar ficam ocultos quando a visão Por Caixa está
  selecionada, para nunca baixar um arquivo com dado diferente do que a
  tela está mostrando.

## Inteligência Artificial (gestão) — IA Gestora
- **Ativada em 2026** (pedido do usuário, em 3 passos: ativar a aba/chat,
  conectar a dados reais, primeira versão só de consulta e análise). Fica
  no menu **Geral → IA Gestora**, mesmo padrão visual do resto do ERP
  (painel, botões, tipografia — nenhum componente novo de fora).
- **É um chat de CONSULTA E ANÁLISE.** Nesta primeira versão a IA pode
  consultar, calcular (usando as contas que já existem no ERP, nunca uma
  fórmula nova), comparar, explicar, identificar problemas, destacar
  oportunidades e gerar resumos. Ela **não pode**: alterar custo, criar
  compra, pagar conta, alterar estoque, alterar anúncio, emitir nota
  fiscal, cancelar pedido nem modificar qualquer outro dado importante —
  se o usuário pedir uma dessas ações, ela explica que ainda não faz isso.
- **Sempre usa a empresa e o período do cabeçalho** (`window.CerneFiltro`,
  o mesmo filtro já usado pela Visão Geral) — não existe (e não pode
  existir) um seletor de empresa/período próprio dentro da tela de chat.
  Trocar empresa ou período no cabeçalho durante uma conversa reinicia o
  chat (nunca mistura resposta de uma empresa/período com outra).
- **Nunca responde um número inventado.** Toda pergunta que envolva um
  valor (faturamento, margem, custo, taxa, saldo etc.) passa por uma
  "ferramenta" que consulta o banco de verdade — a IA nunca calcula de
  cabeça. Quando falta informação para responder com segurança (ex: custo
  de SKU não cadastrado), ela diz isso com todas as letras (ex: "Não
  consigo calcular isso com segurança porque 14 pedidos ainda estão sem
  custo cadastrado"), nunca estima nem arredonda um valor aproximado.
- **Não existe uma segunda regra financeira só para a IA.** As respostas
  usam exatamente as mesmas funções/tabelas já usadas em Visão Geral,
  Pedidos, Financeiro, DRE, Relatórios, Contas a Pagar/Receber e Estoque
  (`lib/relatorioVendas.js`, `lib/dre.js`, `lib/relatoriosAgregados.js`,
  `lib/contasPagar.js`, `lib/contasReceber.js`, `lib/visaoGeralPainel.js`,
  `ml_estoque_itens`) — o mesmo período, na mesma tela, nunca tem um
  faturamento diferente entre a IA Gestora e o resto do ERP.
- **Login real, só nesta área (25/08/2026).** A IA Gestora agora exige
  login (e-mail/senha, tabela `users` já existente) antes de conversar —
  `router.use(exigirLogin)` em `routes/iaGestora.js`. **Nenhuma outra tela
  do ERP passou a exigir login nesta mudança** — o resto do sistema
  continua exatamente como era (sem tela de login, sem sessão), porque o
  pedido foi alterar SOMENTE a área da IA Gestora. Sessão é um token
  opaco (não é JWT) guardado em cookie `httpOnly`, validado contra
  `sessoes_usuario` no banco — um logout real revoga a sessão no servidor
  (não é só apagar cookie no navegador). Criação de usuário é só por
  script de bootstrap (`node db/criarUsuarioIa.js "email" "senha" "nome"`
  no servidor) — não existe tela de "criar minha conta". Ver `02-decisoes.md`.
- **O que o login garante — e o que ele NÃO garante.** Garante que uma
  conversa (histórico, mensagens) é sempre de um usuário só: um usuário
  nunca lista, abre ou apaga a conversa de outro (todo acesso filtra por
  `usuario_id`, testado em `test/iaGestoraRoutes.test.js`). **Não** cria
  permissão por empresa — qualquer usuário logado pode selecionar qualquer
  empresa ativa no cabeçalho, exatamente como qualquer outra tela do ERP já
  funciona hoje (não existe controle "usuário X só vê empresa Y" em
  nenhuma tela do sistema, e criar isso ficaria fora do escopo desta
  tarefa). Ver `05-problemas-conhecidos.md`.
- **Histórico de conversas é salvo no banco** (`ia_conversas`/
  `ia_mensagens`), nunca só no navegador — sobrevive a atualizar a página,
  fechar o navegador ou trocar de computador, porque não depende de
  `localStorage`. A tela mostra uma lista das conversas do usuário
  (título, data), permite abrir uma conversa antiga e continuar de onde
  parou, começar uma nova e excluir uma conversa quando quiser.
- **A chave do provedor de IA nunca fica no front-end.** Toda a
  comunicação com o provedor (hoje: Anthropic/Claude, via chamada HTTP
  direta no backend) acontece só no servidor — o navegador só fala com
  `POST /api/ia-gestora/perguntar`, do próprio ERP. Provedor e modelo são
  configuráveis por variável de ambiente (`IA_PROVEDOR`, `IA_API_KEY`,
  `IA_MODELO`), preparados para trocar de provedor no futuro sem
  reconstruir a integração — ver `02-decisoes.md`.
- **Sem IA_API_KEY configurada, a tela abre normalmente** (nunca quebra o
  resto do ERP) e avisa, na própria conversa, que a IA Gestora ainda não
  está configurada no servidor.
- **Resposta visual, quando faz sentido (25/08/2026).** Para perguntas
  simples ("Quanto faturei hoje?") a resposta continua só texto. Para uma
  análise/relatório maior, a IA pode apresentar a resposta em um "card":
  resumo (período/empresa), indicadores (KPIs), tabela, gráfico (barra de
  produtos/lojas, linha de evolução, REALIZADO×PROJETADO no fluxo de
  caixa etc.), conclusões e um aviso de atenção quando identifica um
  problema (ex: margem negativa depois do Ads). **Quem decide se a
  pergunta merece esse tratamento visual é o próprio modelo de IA**
  (chamando ou não a ferramenta `apresentar_analise`) — não existe uma
  lista fixa de palavras-chave no código. **Todo número do card vem de
  uma ferramenta já executada na mesma pergunta — nunca é calculado ou
  inventado pelo modelo.** Só a análise textual (as "conclusões" e o
  aviso de "atenção") é escrita pela IA; nenhum valor numérico é. Ver
  `lib/ia/estrutura.js` e `02-decisoes.md`.
- **Planilha (XLSX) automática, quando a resposta tem card visual
  (25/08/2026).** Sempre que a resposta tiver tabela ou gráfico, um botão
  "Baixar planilha" fica disponível na própria mensagem. **A planilha usa
  exatamente os mesmos dados estruturados que a conversa mostrou** —
  nunca uma nova consulta ao banco, nunca o texto da resposta reformatado
  — então é impossível a conversa mostrar um total e a planilha mostrar
  outro. Respeita a empresa/período/filtro exatos da pergunta que gerou
  aquela mensagem. Ver `lib/ia/planilhaAnalise.js`.
- Perguntas de exemplo que a IA já responde com dado real: quanto vendi
  hoje, quanto estou lucrando este mês, qual minha margem de contribuição,
  qual produto está dando mais lucro/prejuízo, quanto gastei com
  taxas/frete do vendedor, quanto tenho para receber/pagar, quais SKUs
  estão sem custo cadastrado, como está meu estoque, qual conta do
  Mercado Livre está performando melhor — e uma central de "quais
  problemas precisam da minha atenção" (mesmos alertas de Visão Geral >
  Alertas & IA).

## Outras regras gerais
- **Pedido cancelado no Mercado Livre não é venda de verdade.** Ele não
  entra no faturamento, taxas, frete, imposto, custo nem margem de
  contribuição mostrados em Visão Geral e Financeiro. Ele tem **um lugar
  só** pra aparecer nesses números agregados: o card/linha "Pedidos
  cancelados" (quantidade e valor, só informativo). Na listagem de
  Pedidos ele continua aparecendo normalmente junto dos outros (linha
  esmaecida), porque ali é a lista operacional de tudo que veio do
  Mercado Livre — a regra de ficar de fora vale só pros totais.
- **Fonte única de cálculo (regra central, pedida pelo usuário):** o
  cálculo de resultado de uma venda — venda **(-)** taxas/comissões
  **(-)** frete do vendedor **(-)** imposto **(-)** custo do produto **=**
  margem de contribuição — existe em um único lugar no backend
  (`lib/resultadoVenda.js` + `lib/relatorioVendas.js`) e é reaproveitado
  por Visão Geral, Pedidos e Financeiro. Nenhuma dessas três telas tem sua
  própria conta paralela — se a regra mudar, muda nos três lugares de uma
  vez só. Ver `02-decisoes.md`.
