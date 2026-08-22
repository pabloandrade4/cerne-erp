# Decisões do Projeto

Registro de decisões importantes tomadas ao longo do desenvolvimento, na ordem
em que foram tomadas (mais recente no topo).

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
