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
- **Descoberto no teste ao vivo desta última correção:** os períodos
  "7 dias" e "30 dias" ficam muito lentos (minutos, chegou a travar a aba)
  em Visão Geral/Pedidos/Financeiro com o volume real de pedidos da conta
  — ver detalhes e causa provável em `05-problemas-conhecidos.md`.
  **Precisa de uma decisão do usuário** sobre corrigir isso agora ou depois
  (estava fora do escopo das 3 correções pedidas, então não foi mexido).
- Por instrução explícita do usuário, esta etapa terminou depois do teste
  nas três telas — aguardando o usuário pedir o próximo módulo (ou a
  correção da lentidão acima) antes de avançar (não avançar sozinho pra
  Estoque, Full, Compras, Produtos, Fornecedores, contas a pagar/receber,
  DRE completa, Ads, notas fiscais, Shopee, IA, etc.).
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
