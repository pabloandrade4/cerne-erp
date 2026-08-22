# Funcionalidades Desenvolvidas

Lista das partes do ERP que já foram desenvolvidas, com uma descrição curta de
cada uma e o status (em desenvolvimento / concluída).

## Integração real com Mercado Livre (conexão, pedidos, custo/imposto)
- **Status:** concluído (os 3 passos pedidos: conectar conta, importar
  pedidos completos, custo por SKU + imposto configurável).
- **O que é:** conexão real via OAuth com uma conta do Mercado Livre por
  empresa (tela **Marketplaces**), importação dos pedidos reais dos últimos
  30 dias com todos os valores discriminados (tela **Pedidos**), e
  cadastro de custo por SKU + alíquota de imposto para calcular o resultado
  de cada venda (tela **Custos**). Ver as regras completas em
  `01-regras-de-negocio.md` e as decisões técnicas em `02-decisoes.md`.
- **Testado com conta real:** conta "PFEMBALAGEMS" conectada e sincronizada
  de verdade, com pedidos reais importados (ver `04-alteracoes.md` para o
  changelog e o relatório de teste enviado ao usuário).
- **Onde está:** `server/lib/mercadolivre.js` (cliente da API do ML),
  `server/lib/mlSync.js` (sincronização/importação), `server/lib/crypto.js`
  (criptografia dos tokens), `server/lib/pkce.js` (OAuth/PKCE),
  `server/routes/integracoes.js` (conectar/sincronizar),
  `server/routes/pedidos.js` (listar/detalhar pedidos + cálculo do
  resultado), `server/routes/custos.js` (custo por SKU + imposto),
  `server/public/index.html` (módulos `window.Marketplaces`,
  `window.Pedidos`, `window.Custos`).
- **O que falta:** Shopee, DRE/financeiro completo, IA, notas fiscais —
  nada disso foi pedido ainda. Também falta otimizar a sincronização para
  contas com muitos pedidos (ver `05-problemas-conhecidos.md`).

## Pedido cai sozinho no sistema (importação automática por webhook)
- **Status:** concluído (código testado localmente; teste de ponta a ponta
  com notificação real do Mercado Livre depende do usuário configurar a
  URL no painel do Mercado Livre — ver `02-decisoes.md` (7) e
  `05-problemas-conhecidos.md`).
- **O que é:** o Mercado Livre agora avisa o ERP em tempo real assim que um
  pedido é criado/atualizado (webhook), e o pedido é importado
  automaticamente — sem precisar clicar em "Sincronizar agora". O botão
  continua existindo como reforço manual.
- **Onde está:** `server/routes/integracoes.js` (rota
  `POST /mercadolivre/webhook`), `server/lib/mlSync.js`
  (`importarPedidoPorNotificacao`, trava por pedido).
- **O que falta:** o usuário configurar a notificação no painel de
  desenvolvedor do Mercado Livre (ver `02-decisoes.md` (7) para a URL
  exata) e confirmar, com um pedido real, que ele aparece sozinho no ERP.

## Custo, imposto e margem líquida na lista de Pedidos
- **Status:** concluído.
- **O que é:** a tela de Pedidos passou a mostrar, direto na lista (sem
  precisar abrir o detalhe de cada pedido), o custo do produto, o imposto
  e a margem líquida de cada pedido — além do valor da venda e dos dois
  fretes que já apareciam. Quando falta alguma informação (custo de SKU
  não cadastrado, tarifa que o Mercado Livre não retornou), a coluna
  mostra "pendente" em vez de um número.
- **Onde está:** `server/lib/resultadoVenda.js` (cálculo compartilhado com
  o detalhe do pedido), `server/routes/pedidos.js` (`GET /`),
  `server/public/index.html` (módulo `window.Pedidos`).

## Sistema publicado online, com banco de dados real
- **Status:** concluído.
- **O que é:** o ERP deixou de ser só um layout estático — agora roda como um
  serviço web real (Node.js/Express) publicado no Render, com um banco
  Postgres real e persistente (também no Render). Os dados não dependem mais
  do navegador: continuam existindo depois de fechar/atualizar a página, ou
  mesmo depois de reiniciar o serviço.
- **Onde está:** código em `server/` (backend) e `server/public/` (o mesmo
  front-end/design já aprovado, adaptado para consumir a API real).
- **URL pública:** https://cerne-erp.onrender.com
- **O que falta:** autenticação/login real (existe só uma tabela `users`
  preparada, sem tela nem rota ainda), e todos os outros módulos.

## Empresas (CRUD real)
- **Status:** concluído.
- **O que é:** primeiro cadastro real do ERP. Permite cadastrar, editar,
  listar e ativar/desativar empresas (CNPJ validado e único, razão social,
  nome fantasia). Dados salvos no Postgres do Render — persistem entre
  sessões. Testado na URL pública (cadastro, edição, listagem, ativar/
  desativar e persistência após recarregar a página).
- **Onde está:** `server/routes/empresas.js` (API), `server/lib/cnpj.js`
  (validação de CNPJ), `server/public/index.html` (tela — módulo
  `window.Empresas`).
- **O que falta:** exclusão definitiva (não foi pedida ainda — hoje só existe
  ativar/desativar).

## Layout base navegável do ERP
- **Status:** concluído (estrutural/visual — ainda sem dados ou regras reais).
- **O que é:** esqueleto do ERP com sidebar (5 grupos de módulos), header
  (seletor de empresa/CNPJ, período, tema claro/escuro, notificações, usuário)
  e uma página para cada módulo do sistema. Visual revisado para um padrão
  "premium": hierarquia entre KPIs principais/secundários, 4 gráficos
  preparados com empty state, sidebar e header refinados.
- **Onde está:** `app/base-layout.html`, publicado como artifact ("Cerne").
- **O que falta:** implementar a funcionalidade real de cada módulo (dados,
  regras de negócio, integrações), módulo por módulo.
