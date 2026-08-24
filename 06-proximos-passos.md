# Próximos Passos

- **Concluído em 24/08/2026, testado ao vivo em produção:** conceito de
  **produto base + SKU de venda + multiplicador** (deploy `ml15`) — ver
  `04-alteracoes.md` (11) e `03-funcionalidades.md`. Só depois disso, a
  nova tela **Estoque** (Galpão + Full, agrupada por produto base, com
  filtro Todos/Galpão/Full) foi construída reaproveitando essa estrutura —
  ver `04-alteracoes.md` (12). **A tela Estoque nova ainda só foi testada
  localmente** (Postgres local + dados sintéticos batendo o exemplo do
  pedido do usuário) — falta:
  - o usuário subir o próximo zip de código (`ml16`) pro GitHub;
  - depois do deploy, testar os três filtros ao vivo com dados reais da
    empresa (idealmente já com algum produto base cadastrado e com custo,
    e com a conta do Mercado Livre da empresa ativa, pra também confirmar
    o Full ao vivo — hoje a conta de teste local está marcada como
    "erro", então o caminho de Full com sucesso só foi validado com dados
    simulados, não contra a API real);
  - confirmar que produtos base sem nenhum SKU do Mercado Livre vinculado
    ainda aparecem certinho com Full = 0 (não pendente), e que SKUs do
    Full sem vínculo aparecem na lista de pendências da tela, não somados
    a nenhum produto.
  - as antigas telas "Estoque" e "Estoque Full" (com ajuste por produto
    cadastrado em Produtos / visualização separada por anúncio) **foram
    substituídas** por essa tela única — os itens de pendência abaixo
    datados de 23/08/2026 que mencionam essas duas telas antigas ficam
    como histórico, não como trabalho ainda por fazer nelas.
- **Pendência aberta, sem prazo:** não existe ainda uma tela para cadastrar
  produtos base e corrigir manualmente o vínculo SKU → produto base →
  multiplicador — hoje isso só é possível direto pela API
  (`server/routes/produtosBase.js`). A tela Estoque já mostra o produto
  base e o custo, mas cadastrar um produto base novo ou corrigir um
  vínculo errado ainda depende de uma chamada de API manual.
- **Concluído em 24/08/2026:** Supabase como banco principal, migração dos
  dados existentes, sincronização histórica desde 01/07/2026 (3.604
  pedidos, 0 erros) e confirmação de que Visão Geral lê só do banco — ver
  `04-alteracoes.md` (10) e `02-decisoes.md` (12). Por instrução explícita
  do usuário, esta etapa não avançou nenhum outro módulo, e **custo do
  produto e imposto continuam fora do escopo** — a próxima decisão do
  usuário é se/quando entrar nisso.
- **Pendência aberta, sem prazo:** decidir quando desligar o banco antigo
  do Render (`cerne-db`) agora que o Supabase é o principal — ver
  `05-problemas-conhecidos.md`. Também dá pra remover, sem pressa, as
  variáveis de ambiente `SUPABASE_DATABASE_URL` e `ADMIN_MIGRATION_TOKEN`
  do serviço no Render (não são mais usadas).
- Sistema já está no ar (https://cerne-erp.onrender.com), com banco Postgres
  real, **Empresas** funcionando de ponta a ponta, a **integração real com
  o Mercado Livre** (conectar conta, importar pedidos dos últimos 30 dias,
  custo por SKU + imposto configurável) testada com a conta real
  "PFEMBALAGEMS", e **Visão Geral, Pedidos e Financeiro** com dados reais e
  filtro de período — incluindo as 3 correções pedidas depois (filtro
  único no header da Visão Geral, tabela de Pedidos mais estreita, fuso
  horário do período) — testadas ao vivo em produção (ver
  `03-funcionalidades.md` e `04-alteracoes.md`).
- **Produtos, Anúncios e Fornecedores foram implementados e testados
  localmente** (código, schema e queries — ver `04-alteracoes.md` (7) e
  `02-decisoes.md` (10)). **Ainda precisam do teste ao vivo em produção**
  depois que o usuário subir o novo zip pro GitHub e o deploy automático do
  Render terminar — em especial a busca real de anúncios na API do Mercado
  Livre, que não pôde ser testada neste ambiente de desenvolvimento.
- **Estoque, Estoque Full e Compras foram testados ao vivo em produção em
  23/08/2026** (ver `04-alteracoes.md` (9) e `05-problemas-conhecidos.md`):
  - **Estoque** — carregou normalmente (empresa "pf embalegens" ainda sem
    produtos cadastrados, então mostrou o estado vazio correto). O fluxo
    de ajuste de quantidade por linha (que abre um formulário) ainda
    precisa ser conferido ao vivo com um produto real cadastrado — ainda
    não dá pra testar porque a empresa não tem nenhum produto em Produtos.
  - **Estoque Full** — funcionou com dados reais da API do Mercado Livre,
    sem nenhum item em "Pendente". Considerar validado.
  - **Compras** — encontrado e corrigido um bug: o botão "Nova compra" do
    topo não abria o formulário (faltava o evento de clique). **Precisa de
    um novo upload do zip de código pro GitHub e um novo deploy** para a
    correção valer em produção, e depois disso reconferir o botão ao vivo.
- **Pendência aberta, sem prazo:** cadastrar o primeiro produto em
  Produtos (empresa "pf embalegens") para poder testar de ponta a ponta,
  com dado real, o ajuste manual de estoque e a montagem de uma compra
  (seleção de produto no formulário) — hoje as duas telas só têm o estado
  vazio confirmado ao vivo.
- **Pendência aberta, sem prazo:** decidir com o usuário se e quando
  automatizar a entrada de estoque ao marcar uma compra como "Recebido"
  (hoje é 100% manual, por instrução explícita) — inclui decisões de
  negócio como o que fazer com recebimento parcial ou compra editada
  depois de recebida. Ver `05-problemas-conhecidos.md`.
- **Pendência aberta, sem prazo:** custo por SKU hoje existe em dois
  lugares sem sincronia (tabela nova `produtos` e a já existente
  `custos_produto`, usada no cálculo de margem das vendas) — ver
  `05-problemas-conhecidos.md`. **Precisa de uma decisão do usuário** sobre
  unificar as duas (e como) quando fizer sentido.
- **Descoberto no teste ao vivo da correção anterior:** os períodos
  "7 dias" e "30 dias" ficam muito lentos (minutos, chegou a travar a aba)
  em Visão Geral/Pedidos/Financeiro com o volume real de pedidos da conta
  — ver detalhes e causa provável em `05-problemas-conhecidos.md`.
  **Precisa de uma decisão do usuário** sobre corrigir isso agora ou depois
  (ficou fora do escopo das etapas pedidas até aqui, então não foi mexido).
- Por instrução explícita do usuário, esta etapa também termina depois do
  teste nas três telas novas (Estoque, Estoque Full, Compras) — aguardando
  o usuário pedir o próximo módulo (ou alguma das pendências acima) antes
  de avançar (não avançar sozinho pra contas a pagar/receber, DRE completa,
  Ads, notas fiscais, Shopee, IA de compras, automação de entrada de
  estoque, etc., nem pra unificar Produtos com Custos sem o usuário
  decidir).
- **Pendente do usuário:** configurar no painel de desenvolvedor do
  Mercado Livre a notificação do tópico `orders_v2` apontando para
  `https://cerne-erp.onrender.com/api/integracoes/mercadolivre/webhook`,
  pra ativar o pedido caindo sozinho no sistema. Depois de configurado,
  confirmar com um pedido real que ele aparece sem precisar clicar em
  "Sincronizar" (ver `05-problemas-conhecidos.md`).
- Se o usuário quiser, otimizar a velocidade da sincronização do Mercado
  Livre para contas com muitos pedidos (ver `05-problemas-conhecidos.md`) —
  não fazer sem o usuário pedir.
- Verificar, com o usuário, se surgiu alguma forma de habilitar `git push`
  direto nesta sessão do Cowork (ver `05-problemas-conhecidos.md`); enquanto
  isso, seguir com o fluxo de zip manual.
