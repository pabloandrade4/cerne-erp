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
  teste nas três telas novas (Produtos, Anúncios, Fornecedores) —
  aguardando o usuário pedir o próximo módulo (ou alguma das pendências
  acima) antes de avançar (não avançar sozinho pra Estoque, Full, Compras,
  contas a pagar/receber, DRE completa, Ads, notas fiscais, Shopee, IA,
  etc., nem pra unificar Produtos com Custos sem o usuário decidir).
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
