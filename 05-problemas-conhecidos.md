# Problemas Conhecidos

Lista de problemas, limitações ou pendências identificadas durante o
desenvolvimento, para não serem esquecidas.

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
  funcionando normalmente como reforço/backup.

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

## Serviço web também está no plano gratuito do Render
- O serviço `cerne-erp` está no plano **Free**. Nesse plano o Render
  "dorme" o serviço após um período sem acessos, e a primeira requisição
  depois disso demora mais (cold start, alguns segundos). Não afeta os
  dados, só a velocidade de resposta na primeira visita. Se isso incomodar,
  dá pra migrar para um plano pago mais adiante.

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
