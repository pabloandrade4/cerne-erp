# Próximos Passos

- Sistema já está no ar (https://cerne-erp.onrender.com), com banco Postgres
  real, **Empresas** funcionando de ponta a ponta, e a **integração real com
  o Mercado Livre** (conectar conta, importar pedidos dos últimos 30 dias,
  custo por SKU + imposto configurável) testada com a conta real
  "PFEMBALAGEMS".
- Antes de 20/09/2026: decidir com o usuário sobre migrar o Postgres do
  Render do plano gratuito para um plano pago (ver
  `05-problemas-conhecidos.md`).
- Se o usuário quiser, otimizar a velocidade da sincronização do Mercado
  Livre para contas com muitos pedidos (ver `05-problemas-conhecidos.md`) —
  não fazer sem o usuário pedir.
- Verificar, com o usuário, se surgiu alguma forma de habilitar `git push`
  direto nesta sessão do Cowork (ver `05-problemas-conhecidos.md`); enquanto
  isso, seguir com o fluxo de zip manual.
- Aguardando o usuário pedir o próximo módulo/etapa — por instrução
  explícita, nada além do que já foi pedido deve avançar sozinho (lojas,
  usuários avançados, permissões, Shopee, pedidos além do que já existe,
  produtos, estoque, financeiro completo, Full, IA, notas fiscais).
