# Alterações Importantes (Changelog)

Registro cronológico de mudanças relevantes no projeto (mais recente no topo).

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
