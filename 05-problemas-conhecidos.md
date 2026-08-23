# Problemas Conhecidos

Lista de problemas, limitações ou pendências identificadas durante o
desenvolvimento, para não serem esquecidas.

## Estoque Full: testado ao vivo em produção com sucesso (23/08/2026)
- A tela **Estoque Full** identifica anúncios Full pelo campo
  `shipping.logistic_type === 'fulfillment'` e busca a quantidade pelo
  endpoint `GET /inventories/{inventory_id}/stock/fulfillment`, usando o
  `inventory_id` que a própria API do item retorna. **Testado ao vivo em
  produção com a conta real "PFEMBALAGEMS"**: a tela carregou 20 anúncios
  Full (dos 52 anúncios totais verificados nos primeiros 50) com
  quantidades reais retornadas pela API, **nenhum caiu em "Pendente"** —
  ou seja, o formato assumido para `inventory_id` e para o endpoint de
  estoque bateu com a API real.
- Buscar a quantidade Full é **uma chamada de API por anúncio Full
  encontrado** (o Mercado Livre não documenta um jeito de buscar várias de
  uma vez) — para uma conta com muitos anúncios Full, isso pode ficar
  lento, parecido com o problema já conhecido de sincronização de pedidos.
  Não foi otimizado agora (ex: cache, busca em background) porque fugiria
  do escopo desta etapa.
- A tela só verifica os **primeiros 50 anúncios da conta por página** (sem
  buscar páginas seguintes automaticamente) — no teste ao vivo, a conta
  tinha 52 anúncios no total, então os últimos 2 não foram verificados
  nessa carga. Buscar mais páginas ainda não foi implementado nesta etapa
  (a tela avisa isso no rodapé da tabela, com o total verificado vs. total
  da conta).

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

## Custo por SKU existe em dois lugares (Produtos e Custos), sem sincronia entre eles
- Ao ativar a tela **Produtos** (nome, SKU, custo, status), foi criada uma
  tabela nova (`produtos`) — de propósito, **separada** da tabela
  `custos_produto` já existente e usada no cálculo de margem das vendas do
  Mercado Livre (telas Custos, Pedidos, Visão Geral e Financeiro). Ver o
  porquê dessa separação em `02-decisoes.md`.
- Na prática, hoje: cadastrar/editar o custo de um SKU em **Produtos** não
  atualiza o custo usado no cálculo de margem em **Custos** (e vice-versa)
  — são dois cadastros independentes, mesmo que guardem informação
  parecida (custo por SKU).
- **Precisa de uma decisão do usuário** sobre unificar as duas no futuro
  (ex: Produtos passar a ser a fonte única de custo usada no cálculo de
  margem, substituindo `custos_produto`) — não foi feito agora porque
  fugiria do escopo desta etapa ("não altere outras áreas") e do pedido
  explícito de um cadastro de Produtos simples primeiro. Ver
  `06-proximos-passos.md`.

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

## Banco Postgres do Render está no plano gratuito (expira em 30 dias)
- O banco `cerne-db` foi criado no plano **Free** do Render, que **expira em
  20/09/2026**. Depois disso o Render pode apagar o banco se não for
  migrado para um plano pago antes.
- Ação necessária: antes dessa data, decidir com o usuário se migra para um
  plano pago do Postgres no Render (para não perder os dados das empresas
  cadastradas e dos próximos módulos).

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
