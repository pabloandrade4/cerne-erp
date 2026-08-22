# Alterações Importantes (Changelog)

Registro cronológico de mudanças relevantes no projeto (mais recente no topo).

## 2026-08-21/22 (3) — Integração real com Mercado Livre (conectar, importar pedidos, custo + imposto)
- Conexão real via OAuth+PKCE com o Mercado Livre (tela Marketplaces),
  tokens criptografados no banco (AES-256-GCM), renovação automática antes
  de expirar.
- Importação real dos pedidos dos últimos 30 dias (tela Pedidos): dados do
  pedido, itens (SKU, título, quantidade, preços), comissão/tarifas reais
  da API, frete do comprador e do vendedor guardados separados, tipo de
  logística, payload bruto para auditoria. Sincronizar de novo nunca
  duplica pedido.
- Custo por SKU e alíquota de imposto configuráveis (tela Custos);
  resultado da venda (valor - tarifas - frete do vendedor - imposto - custo
  do produto) calculado só quando todas as partes existem — senão mostra o
  que está pendente, nunca um número inventado.
- **Testado com a conta real "PFEMBALAGEMS":** conectada e sincronizada com
  sucesso — **2.370 pedidos reais** dos últimos 30 dias importados/
  atualizados, 0 erros (sincronização concluída em ~14 min). Pedido de
  exemplo conferido em detalhe (ver relatório enviado ao usuário no chat,
  com o exemplo completo).
- Durante o teste real, foram corrigidos 2 problemas encontrados: (1) as
  telas de Marketplaces/Pedidos/Custos carregavam em branco no primeiro
  load (ordem de inicialização do `index.html`); (2) a sincronização podia
  travar para sempre se uma chamada à API do Mercado Livre não respondesse
  (adicionado timeout de 20s por chamada). Detalhes em `02-decisoes.md`.
- Endpoints do Mercado Livre usados: `/oauth/token`, `/users/me`,
  `/orders/search`, `/orders/{id}`, `/shipments/{id}`,
  `/shipments/{id}/costs`.
- Combinado um novo processo de entrega das próximas alterações (o `git
  push` direto não está disponível nesta sessão do Cowork) — ver
  `02-decisoes.md` (1) e `05-problemas-conhecidos.md`.
- Conforme pedido, nenhum outro módulo foi avançado (Shopee, lojas,
  usuários avançados, permissões, produtos, estoque, financeiro completo,
  Full, IA, notas fiscais).

## 2026-08-21 (2) — ERP no ar, com banco real e Empresas funcionando
- Backend Node.js/Express + PostgreSQL criado (`server/`), reaproveitando o
  mesmo front-end/design já aprovado.
- Publicado no Render: serviço web `cerne-erp` (deploy automático a partir do
  repositório GitHub `pabloandrade4/cerne-erp`) + banco Postgres `cerne-db`.
- URL pública: https://cerne-erp.onrender.com
- Tela de **Empresas** funcionando de verdade: cadastrar, editar, listar,
  ativar/desativar — tudo salvo no banco real, testado na URL pública
  (persistiu após recarregar a página).
- Nenhum outro módulo foi alterado ou avançado nesta etapa.

## 2026-08-21
- Início do projeto: criada a pasta `docs/` como memória do ERP, com os
  arquivos base (visão geral, regras de negócio, decisões, funcionalidades,
  alterações, problemas conhecidos e próximos passos).
- Criado e publicado o layout base navegável do ERP (`app/base-layout.html`,
  artifact "Cerne"): sidebar com os módulos, header, tema claro/escuro e
  página-esqueleto por módulo. Ver detalhes em `02-decisoes.md` e
  `03-funcionalidades.md`.
- Revisão visual completa do mesmo layout: hierarquia entre indicadores
  principais/secundários, 4 componentes de gráfico com empty state, sidebar e
  header mais refinados. Ver `02-decisoes.md` (2026-08-21 (3)).
