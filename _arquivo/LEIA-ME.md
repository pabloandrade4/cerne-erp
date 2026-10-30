# _arquivo — coisas que o Cerne não usa mais (guardadas, não apagadas)

Criado em 30/10/2026 (Fase 1 "Cerne só financeiro"), a pedido do Pablo: "as coisas
que não vou usar quero que exclua de lá, mas guarde em uma pasta separada".

Nada aqui é carregado pelo servidor nem pela tela. O banco de dados NÃO foi
mexido: as tabelas dessas funções continuam lá, com todo o histórico.

## O que tem aqui

(Para economizar arquivos no GitHub, `backend-arquivado.zip` guarda tudo do backend e `arquivos-soltos-raiz.zip` guarda as cópias antigas da raiz: é só abrir o ZIP para achar os arquivos.)

- `front-end/` (24 arquivos): o código das telas que saíram de `public/index.html`
  (IA-Gestora, Fornecedores, Mapa-de-Produtos, Anuncios, Estoque-e-Estoque-Full, Compras-com-IA, Envio-Full, Calculadora-de-Vendas, Alertas-e-IA, Ads-ML, Ads-Shopee-e-Ads-Total, Modal-Detalhe-do-Anuncio, Performance-de-Anuncios, Visitas-e-Conversao, Margem-por-Anuncio, Promocoes-IA, Agentes-IA-Ads-e-Performance, SAC-ML-e-Shopee, Analise-de-Concorrente, Radar-de-Concorrentes, Plano-de-Acao-do-Dia, Agentes-IA-Hub, Relatorios, Sala-dos-Agentes).
- dentro de `backend-arquivado.zip`: `routes/` e `lib/`: rotas e lógicas dos agentes e telas arquivadas
  (IA Gestora, Alertas, SAC, Daily, Promoções, Concorrente, Radar, Compras com IA,
  Envio Full, Anúncios, Estoque, Mapa de Produtos, Visitas e Conversão, Margem por
  Anúncio, Ads da Shopee, Sala dos Agentes). Os caminhos são os mesmos de antes.
- `test/` (no mesmo ZIP): testes automáticos dessas funções.
- `ia/` e `auth/` (no mesmo ZIP): cópias antigas e soltas dessas pastas (a versão
  em uso estava em `lib/ia` e `lib/auth`).
- `arquivos-soltos-raiz.zip` (191 arquivos): cópias antigas que estavam soltas na raiz do projeto.

## Não foi arquivado (continua no projeto)

Tudo do financeiro (contas a pagar/receber, recebimentos, DRE, fluxo de caixa,
faturamento, notas fiscais, despesas fixas), pedidos, empresas, marketplaces,
Produtos (o custo do produto é a base do lucro; só está escondido do menu),
Fornecedores (rota usada por Contas a Pagar), Venda de Balcão (rota e dados que
alimentam DRE/Faturamento), Ads do Mercado Livre e Performance (a Visão Geral lê
esses dados), Devoluções, e as rotas de extrato e conciliação bancária.

## Como trazer uma coisa de volta

1. **Backend:** abra `backend-arquivado.zip` e copie o arquivo de `backend/<caminho>` de volta para
   `<caminho>` (ex.: `backend/routes/envioFull.js` -> `routes/envioFull.js`),
   junto com os arquivos de `lib/` que ele usa; depois religue em `server.js`
   (a linha `require` da rota, a linha `app.use('/api/...')` e, se tiver, a rotina
   automática com `iniciarSePermitido`). Rotinas automáticas ficam desligadas
   até existir a variável `CERNE_ATIVAR` no Render (veja `lib/pausas.js`).
2. **Tela:** abra `_arquivo/front-end/<tela>.js.txt`, cole o conteúdo em
   `public/index.html` logo antes do comentário "Só navega para a rota inicial",
   e recoloque o item no menu (`GROUPS`).
3. Combine as duas partes: uma tela sem a rota volta sem dados.
