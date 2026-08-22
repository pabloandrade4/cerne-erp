# Regras de Negócio

Este arquivo reúne as regras de negócio do ERP, explicadas pelo usuário ao longo
do desenvolvimento. Cada regra deve ser registrada na seção do módulo a que
pertence. Se um módulo ainda não tem regras, ele fica com a seção vazia até que
o usuário explique.

Se uma regra mudar, atualizar a seção correspondente (não deixar a regra antiga
junto da nova).

## Empresas / CNPJs
- Cada empresa cadastrada tem: CNPJ (único, validado — não aceita CNPJ
  inválido nem duplicado), razão social, nome fantasia (opcional) e status
  ativo/inativo.
- É possível cadastrar, editar, listar e ativar/desativar uma empresa.
- Por enquanto **não existe exclusão definitiva** de empresa — só
  ativar/desativar. Isso pode mudar futuramente, mas não foi pedido ainda.
- Empresas inativas continuam existindo no banco (para histórico), só ficam
  marcadas como inativas.

## Mercado Livre
- Integração real via OAuth 2.0 + PKCE (não é simulação). O usuário clica em
  "Conectar Mercado Livre" na tela de Marketplaces, autoriza no site do
  próprio Mercado Livre (login/consentimento acontece lá, nunca dentro do
  ERP) e volta conectado.
- Uma empresa pode ter uma conta do Mercado Livre conectada (1 conta ML por
  `ml_user_id`, vinculada a uma empresa do ERP).
- Access token e refresh token ficam **criptografados no banco** (AES-256-GCM)
  — nunca em texto puro, nunca expostos para o front-end. O token é renovado
  automaticamente pouco antes de expirar, usando o refresh token.
- **Shopee ainda não foi desenvolvida** — só Mercado Livre por enquanto.
- Sincronizar pedidos traz, por padrão, **somente os pedidos dos últimos 30
  dias** (pedido explícito do usuário — não traz o histórico completo).
- Sincronizar de novo (resync) nunca duplica pedido: cada pedido é
  identificado pelo ID do Mercado Livre + conta, e é atualizado (não
  recriado) se já existir.
- **Regra central: nunca inventar/estimar valor financeiro.** Comissão,
  tarifas, frete — só são gravados se a API do Mercado Livre realmente
  retornar aquele campo para aquele pedido. Se a API não retornar, o campo
  fica **indisponível/pendente no sistema (nunca um número calculado, nunca
  zero fingindo ser um valor real)**.
- **Frete do comprador e frete do vendedor são valores diferentes e nunca
  podem ser misturados.** O que o comprador pagou de frete
  (`receiver.cost`) é guardado separado do que foi cobrado do vendedor
  (`senders[].cost`). Nem todo frete é do vendedor — cada um é exatamente o
  que a API retornou para aquele lado.
- Logística do envio (Full/Fulfillment, Mercado Envios, etc.) é guardada
  exatamente como a API do Mercado Livre retorna — nunca deduzida/adivinhada.
- O payload bruto (resposta original da API) de cada pedido, envio e custo de
  envio é guardado separado dos campos já organizados, para auditoria futura.

## Shopee
_(sem regras registradas ainda)_

## Pedidos
- Pedidos do sistema hoje vêm só do Mercado Livre (Shopee ainda não existe).
  Cada pedido importado guarda: ID do pedido, data, status, comprador, cada
  item (com SKU, título, quantidade, preço unitário e total), ID do anúncio,
  ID do pagamento, ID do envio, tarifas/comissão reais da API, frete do
  comprador e do vendedor separados, e o tipo de logística.
- Ver a regra completa de "nunca inventar valor" e separação de frete em
  **Mercado Livre**, acima — vale igualmente para os pedidos importados.

## Produtos
_(sem regras registradas ainda)_

## Estoque
_(sem regras registradas ainda)_

## Full
_(sem regras registradas ainda)_

## Compras
_(sem regras registradas ainda)_

## Fornecedores
_(sem regras registradas ainda)_

## Financeiro
_(sem regras registradas ainda)_

## Contas a pagar
_(sem regras registradas ainda)_

## Contas a receber
_(sem regras registradas ainda)_

## Recebimentos dos marketplaces
_(sem regras registradas ainda)_

## Custos
- Custo do produto é cadastrado **por SKU**, por empresa (ex: SKU
  "50CX-24X15X10", custo R$ 32,50). Não vem do Mercado Livre — é digitado
  pelo usuário no ERP.
- Alíquota de imposto é um **percentual configurado no ERP, por empresa**
  (não vem do Mercado Livre nem de nenhum marketplace).
- Resultado da venda de um pedido = valor da venda **(-)** comissão/tarifas
  reais do Mercado Livre **(-)** frete do vendedor **(-)** imposto (calculado
  com a alíquota configurada) **(-)** custo do produto (pelo SKU
  cadastrado). O frete pago pelo comprador é mostrado à parte, só
  informativo — nunca entra nessa conta.
- Se faltar qualquer uma dessas partes (custo do SKU ainda não cadastrado,
  ou a API do Mercado Livre não ter retornado alguma tarifa/frete daquele
  pedido), o **resultado final não é calculado** — o sistema mostra
  exatamente o que está faltando, em vez de calcular com um valor
  presumido.

## Lucro real por pedido / Margem por produto
_(sem regras registradas ainda)_

## Ads
_(sem regras registradas ainda)_

## DRE
_(sem regras registradas ainda)_

## Faturamento
_(sem regras registradas ainda)_

## Emissão de notas fiscais
_(sem regras registradas ainda)_

## Relatórios
_(sem regras registradas ainda)_

## Inteligência Artificial (gestão)
_(sem regras registradas ainda)_

## Outras regras gerais
_(sem regras registradas ainda)_
