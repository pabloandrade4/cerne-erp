# Funcionalidades Desenvolvidas

Lista das partes do ERP que já foram desenvolvidas, com uma descrição curta de
cada uma e o status (em desenvolvimento / concluída).

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
- **O que falta:** tela própria de cadastro/vínculo (hoje só existe a API —
  usada pela tela Estoque para mostrar produto base e pela sugestão de
  vínculos; cadastrar/corrigir um vínculo manualmente hoje precisa ser
  feito direto pela API).

## Estoque (Galpão + Full, por produto base)
- **Status:** concluído localmente (aguardando deploy + teste ao vivo em
  produção — ver `06-proximos-passos.md`).
- **O que é:** tela única de estoque físico (substitui as antigas telas
  separadas "Estoque" e "Estoque Full"), sempre agrupada por **produto
  base** — nunca por SKU de kit (não existe mais uma linha para
  `25CX-19X12X12` e outra para `50CX-19X12X12`; existe uma linha para
  `CX-19X12X12`, com a soma física dos dois).
  - **Filtro Todos / Galpão / Full** no topo: "Galpão" mostra só o estoque
    físico do nosso galpão (tabela própria `estoque_produto_base`, ajuste
    manual); "Full" mostra só o estoque armazenado no Full do Mercado
    Livre (buscado ao vivo na API, convertido de "kits no Full" para
    "unidades físicas" com o mesmo multiplicador salvo); "Todos" soma os
    dois. Galpão e Full continuam guardados/calculados separadamente por
    baixo — o filtro só muda o que aparece.
  - **Cards no topo:** quantidade total de caixas e valor total em
    estoque (quantidade física × custo do produto base), mudando conforme
    o filtro selecionado.
  - **Nunca inventa:** produto base sem custo cadastrado aparece como
    "Pendente" no valor (não soma como zero); se o Full não puder ser
    consultado agora (sem conta conectada, conta com erro, ou falha da
    API do Mercado Livre), os cards mostram "Pendente" em vez de um total
    que ignoraria o Full silenciosamente; SKU do Full sem vínculo de
    produto base, anúncio sem SKU, ou anúncio sem quantidade disponível na
    API aparecem numa lista de pendências, nunca somados a nenhum produto.
  - **Ajuste manual** só existe para o Galpão (mesmo padrão transacional
    da tela antiga: grava a movimentação com quantidade anterior/nova/
    diferença). O Full nunca é editável aqui — é sempre um espelho ao vivo
    da API do Mercado Livre.
- **Onde está:** `server/lib/mlFull.js` (busca de todas as páginas de
  anúncios Full de uma conta), `server/lib/produtoBaseConversao.js`
  (conversão de SKU do Full para quantidade física, reaproveitada da
  conversão de vendas), `server/routes/estoqueProdutoBase.js` (API:
  agregação Galpão+Full por produto base com os três filtros, ajuste
  manual do Galpão), `server/public/index.html` (tela — módulo
  `window.Estoque`, único; `window.EstoqueFull` foi removido).
- **O que falta:** entrada automática por compra recebida; reserva por
  pedido de venda; tela de histórico de movimentação do Galpão (a tabela
  já existe, só falta a tela); alertas de estoque mínimo; cadastro/edição
  de vínculo SKU → produto base direto da tela (hoje só pela API); página
  além da primeira janela de anúncios do Full continua limitada por um
  teto defensivo de páginas (`maxPaginas`, ver `05-problemas-conhecidos.md`
  se o catálogo Full for muito grande).

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
- **O que falta:** Shopee, DRE/financeiro completo, IA, notas fiscais —
  nada disso foi pedido ainda. Também falta otimizar a sincronização para
  contas com muitos pedidos (ver `05-problemas-conhecidos.md`).

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
- **O que falta:** os outros 3 gráficos da tela (Evolução diária, Por
  marketplace, Fluxo de caixa) continuam como empty-state — não foram
  pedidos nesta etapa. Comparativo com o período anterior (Δ) também não
  foi implementado agora. O filtro do header ainda controla só a Visão
  Geral — Pedidos e Financeiro continuam com seletor próprio dentro da
  página (não foi pedido estender agora).

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
