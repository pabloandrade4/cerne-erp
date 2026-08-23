# Próximos Passos

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
- **Estoque, Estoque Full e Compras foram implementados e testados
  localmente** (schema, transações e queries — ver `04-alteracoes.md` (8) e
  `02-decisoes.md` (11)). **Ainda precisam do teste ao vivo em produção**
  depois que o usuário subir o novo zip pro GitHub:
  - **Estoque Full em especial** — a busca da quantidade real no Full do
    Mercado Livre (`inventory_id` + endpoint de estoque) nunca foi
    exercitada contra a API real. Se o formato vier diferente do esperado,
    a tela mostra "Pendente" (comportamento seguro), mas pode precisar de
    ajuste de código — ver `05-problemas-conhecidos.md`.
  - Estoque (ajuste manual) e Compras (criar/editar/mudar status) só foram
    testados via SQL direto e `node --check`, sem o servidor Express
    rodando de ponta a ponta — o teste ao vivo em produção é o primeiro
    teste real do fluxo completo (API + tela).
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
- Antes de 20/09/2026: decidir com o usuário sobre migrar o Postgres do
  Render do plano gratuito para um plano pago (ver
  `05-problemas-conhecidos.md`).
- Se o usuário quiser, otimizar a velocidade da sincronização do Mercado
  Livre para contas com muitos pedidos (ver `05-problemas-conhecidos.md`) —
  não fazer sem o usuário pedir.
- Verificar, com o usuário, se surgiu alguma forma de habilitar `git push`
  direto nesta sessão do Cowork (ver `05-problemas-conhecidos.md`); enquanto
  isso, seguir com o fluxo de zip manual.
