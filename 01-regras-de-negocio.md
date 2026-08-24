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
- Sincronizar pedidos (botão "Sincronizar agora") traz, por padrão,
  **somente os pedidos dos últimos 30 dias** (pedido explícito do usuário —
  não traz o histórico completo). Existe, além dela, uma **sincronização
  histórica** separada (por enquanto só via API, sem botão na tela) que traz
  todo o período desde uma data escolhida — ver `## Banco de dados` abaixo.
- Sincronizar de novo (resync) nunca duplica pedido: cada pedido é
  identificado pelo ID do Mercado Livre + conta, e é atualizado (não
  recriado) se já existir. Vale tanto para a sincronização normal (30 dias)
  quanto para a histórica.
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
  "Sincronizar".** O Mercado Livre avisa o ERP em tempo real (webhook,
  tópico `orders_v2`) assim que um pedido é criado/atualizado, e o ERP já
  importa esse pedido automaticamente na hora — mesma lógica/regras de
  sempre (nunca inventar valor, nunca duplicar pedido). O botão
  "Sincronizar agora" continua existindo, como reforço manual/para trazer
  pedidos de antes de a conta ter sido conectada — ele não é mais o único
  jeito de um pedido aparecer no sistema.

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
  Cálculo de custo do produto e de imposto **não faz parte desta etapa** —
  continua exatamente como já estava (`custos_produto` +
  `config_financeiro`, usados por `lib/resultadoVenda.js`).

## Notificações do Mercado Livre (webhook)
- O ERP recebe as notificações do Mercado Livre (evento de pedido novo/
  atualizado) numa URL própria e as usa só para saber "tem pedido pra
  buscar" — os dados do pedido em si sempre vêm de buscar de novo na API do
  Mercado Livre (a notificação não traz o pedido completo).
- Notificação de uma conta que não está conectada neste ERP é ignorada.
- Regra combinada com o usuário: se a notificação chegar mas a importação
  falhar por algum motivo, o pedido não fica perdido — a próxima
  sincronização (manual ou periódica) cobre esse pedido normalmente.

## Shopee
_(sem regras registradas ainda)_

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
- **Esta tabela (`produtos`) é separada da tabela de custo por SKU que já
  existia (`custos_produto`, usada em Custos/Pedidos/Visão Geral/Financeiro
  para calcular a margem das vendas do Mercado Livre).** As duas hoje não
  têm nenhum vínculo entre si — cadastrar um produto aqui não atualiza (nem
  é atualizado por) o custo usado no cálculo de margem, e vice-versa. Ver
  `02-decisoes.md` para o porquê dessa separação nesta etapa, e
  `06-proximos-passos.md` para a decisão pendente sobre unificar as duas no
  futuro.
- Por enquanto **não existe exclusão definitiva** de produto — só
  ativar/desativar (mesma regra de Empresas).

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

## Estoque
- Mostra **todos os produtos cadastrados** (tela Produtos) da empresa
  selecionada, com: produto, SKU, estoque atual, custo unitário (o mesmo
  custo cadastrado em Produtos), valor total em estoque (estoque atual ×
  custo unitário) e status (ativo/inativo do produto). Produto sem nenhum
  ajuste ainda aparece com estoque atual **0** — nunca "sem dado".
- **Ajuste manual por enquanto** — pedido explícito do usuário. Não existe
  ainda entrada automática por compra recebida, nem reserva automática de
  estoque por pedido de venda.
- **Toda alteração de quantidade grava uma movimentação** (quantidade
  anterior, quantidade nova, diferença, observação opcional, data/hora) —
  preparado para existir um histórico de movimentação, mesmo sem ainda
  existir uma tela própria para consultá-lo.
- **Nunca é misturado com o Estoque Full** do Mercado Livre — são dois
  números diferentes, guardados e mostrados separadamente (ver "Estoque
  Full", abaixo).

## Estoque Full
- Mostra os **anúncios reais com logística Full** (armazenados nos centros
  de distribuição do Mercado Livre) das contas conectadas — nunca um
  anúncio ou quantidade inventados.
- Campos mostrados: **produto (título do anúncio), SKU, anúncio (ID),
  loja (conta/nickname do Mercado Livre), quantidade no Full e status**.
- **Busca ao vivo, direto na API do Mercado Livre**, a cada vez que a tela
  é aberta ou atualizada — assim como Anúncios, nenhum dado fica salvo no
  banco nesta etapa.
- **Se a API do Mercado Livre ainda não disponibilizar a quantidade de um
  anúncio Full específico** (ex: falta o identificador interno do estoque
  daquele anúncio, ou a chamada falha), a linha mostra **"Pendente"** no
  lugar da quantidade — nunca um número calculado ou zero fingindo ser
  real.
- Se a empresa não tiver conta do Mercado Livre conectada, ou a conexão
  estiver com erro, a tela mostra que a sincronização está pendente (mesmo
  padrão de Anúncios).
- **Nunca é misturado com o Estoque próprio** (tela separada, "Estoque",
  acima) — um produto pode ter uma quantidade em cada um, sem relação
  automática entre os dois números.

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
- Custo do produto é cadastrado **por SKU**, por empresa (ex: SKU
  "50CX-24X15X10", custo R$ 32,50). Não vem do Mercado Livre — é digitado
  pelo usuário no ERP.
- Alíquota de imposto é um **percentual configurado no ERP, por empresa**
  (não vem do Mercado Livre nem de nenhum marketplace).
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
_(sem regras registradas ainda)_

## Faturamento
_(sem regras registradas ainda)_

## Emissão de notas fiscais
_(sem regras registradas ainda)_

## Relatórios
_(sem regras registradas ainda)_

## Inteligência Artificial (gestão)
_(sem regras registradas ainda)_

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
