# Alterações Importantes (Changelog)

Registro cronológico de mudanças relevantes no projeto (mais recente no topo).

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
