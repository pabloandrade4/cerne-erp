-- Cerne ERP — schema mínimo (Etapa: Empresas)
-- Só o necessário para esta etapa: empresas + uma tabela mínima de usuários
-- (preparo para autenticação real futura — login/permissões ainda não usam isso).

CREATE TABLE IF NOT EXISTS empresas (
  id             SERIAL PRIMARY KEY,
  cnpj           VARCHAR(14) NOT NULL UNIQUE,      -- somente dígitos
  razao_social   VARCHAR(200) NOT NULL,
  nome_fantasia  VARCHAR(200),
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Tabela "users" ainda não tem nenhuma tela/rota de login — existe só para o
-- banco já estar pronto quando implementarmos autenticação de verdade.

-- ============================================================
-- Etapa: Integração real com Mercado Livre (OAuth + pedidos)
-- ============================================================

-- Contas do Mercado Livre conectadas via OAuth, uma por empresa/CNPJ.
-- access_token e refresh_token ficam sempre criptografados (nunca em texto
-- puro) — ver server/lib/crypto.js. O front-end nunca recebe esses valores.
CREATE TABLE IF NOT EXISTS ml_contas (
  id                       SERIAL PRIMARY KEY,
  empresa_id               INTEGER NOT NULL REFERENCES empresas(id),
  ml_user_id               BIGINT NOT NULL UNIQUE,   -- id do vendedor no Mercado Livre
  nickname                 VARCHAR(100),
  email                    VARCHAR(255),
  site_id                  VARCHAR(10),               -- ex: MLB (Brasil)
  access_token_enc         TEXT NOT NULL,
  refresh_token_enc        TEXT NOT NULL,
  token_expires_at         TIMESTAMPTZ NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'ativa', -- ativa | erro | desconectada
  ultimo_erro              TEXT,
  ultima_sincronizacao_em  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estado temporário do fluxo OAuth (proteção CSRF + PKCE). Cada linha é
-- consumida (apagada) no callback; sobras antigas (>1h) podem ser limpas.
CREATE TABLE IF NOT EXISTS ml_oauth_states (
  state          VARCHAR(64) PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  code_verifier  VARCHAR(128) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pedidos importados do Mercado Livre. Um pedido nunca é duplicado ao
-- ressincronizar: a chave (conta_ml_id, ml_order_id) é única, e uma nova
-- sincronização atualiza a mesma linha (UPSERT).
-- Campos numéricos ficam NULL quando a API não retornou o dado (nunca 0
-- "inventado") — ver 01-regras-de-negocio.md (Mercado Livre).
CREATE TABLE IF NOT EXISTS ml_pedidos (
  id                          SERIAL PRIMARY KEY,
  conta_ml_id                 INTEGER NOT NULL REFERENCES ml_contas(id),
  ml_order_id                 BIGINT NOT NULL,
  pack_id                     BIGINT,
  data_criacao                TIMESTAMPTZ,
  data_fechamento             TIMESTAMPTZ,
  status                      VARCHAR(30),
  status_detail                VARCHAR(100),
  comprador_id                BIGINT,
  comprador_nickname          VARCHAR(100),
  valor_total                 NUMERIC(12,2),
  moeda                       VARCHAR(5),

  -- Pagamento (payments[0] do pedido — id necessário para não duplicar/atualizar depois)
  ml_payment_id                BIGINT,
  pagamento_status             VARCHAR(30),
  pagamento_taxas               NUMERIC(12,2),  -- payments[].taxes_amount
  pagamento_taxa_marketplace    NUMERIC(12,2),  -- payments[].marketplace_fee
  pagamento_metodo              VARCHAR(50),

  -- Envio / frete (shipment do pedido)
  ml_shipping_id               BIGINT,
  envio_status                 VARCHAR(30),
  envio_logistic_mode          VARCHAR(30),  -- ex: me1, me2, custom (valor bruto da API)
  envio_logistic_type          VARCHAR(30),  -- ex: fulfillment, drop_off, cross_docking, self_service (valor bruto da API)
  frete_comprador               NUMERIC(12,2),  -- receiver.cost — pago pelo comprador
  frete_vendedor                NUMERIC(12,2),  -- senders[].cost — cobrado do vendedor

  -- Comissão do Mercado Livre sobre a venda (soma de order_items[].sale_fee)
  taxa_venda_total              NUMERIC(12,2),

  -- Payload bruto da API, preservado para auditoria (separado dos campos normalizados acima)
  raw_pedido                   JSONB,
  raw_envio                    JSONB,
  raw_custos_envio             JSONB,

  criado_em                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (conta_ml_id, ml_order_id)
);

-- Itens de cada pedido (order_items[] do Mercado Livre). Ao ressincronizar
-- um pedido, os itens são substituídos pelos itens atuais da API.
CREATE TABLE IF NOT EXISTS ml_pedido_itens (
  id                        SERIAL PRIMARY KEY,
  pedido_id                 INTEGER NOT NULL REFERENCES ml_pedidos(id) ON DELETE CASCADE,
  ml_item_id                VARCHAR(30),
  titulo                    TEXT,
  sku                       VARCHAR(100),   -- seller_sku (pode ser NULL se o vendedor não cadastrou SKU no anúncio)
  variation_id               VARCHAR(30),
  quantidade                INTEGER,
  preco_unitario             NUMERIC(12,2),  -- unit_price
  preco_unitario_original    NUMERIC(12,2),  -- full_unit_price (quando diferente = desconto)
  valor_total_item           NUMERIC(12,2),
  taxa_venda                 NUMERIC(12,2)   -- sale_fee do item
);

-- Custo do produto por SKU, por empresa (cadastro manual, usado no cálculo
-- financeiro da venda).
CREATE TABLE IF NOT EXISTS custos_produto (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  sku            VARCHAR(100) NOT NULL,
  custo          NUMERIC(12,2) NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, sku)
);

-- Configuração financeira simples por empresa (por enquanto, só a alíquota
-- de imposto usada no cálculo do resultado da venda — não vem do Mercado Livre).
CREATE TABLE IF NOT EXISTS config_financeiro (
  empresa_id        INTEGER PRIMARY KEY REFERENCES empresas(id),
  aliquota_imposto  NUMERIC(5,2) NOT NULL DEFAULT 0,  -- percentual, ex: 6.00 = 6%
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Etapa: Produtos, Anúncios (visualização) e Fornecedores
-- ============================================================

-- Cadastro simples de produtos, por empresa. Ainda sem kits, composição nem
-- controle de estoque automático (não pedido nesta etapa) — catálogo
-- deliberadamente simples: nome, SKU, custo e status. Fica SEPARADA de
-- "custos_produto" (usada no cálculo de margem das vendas do Mercado Livre)
-- de propósito, para não alterar essa fonte de cálculo já em uso nesta
-- etapa — ver docs/02-decisoes.md sobre essa decisão e o que falta pra
-- unificar as duas no futuro.
CREATE TABLE IF NOT EXISTS produtos (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  nome           VARCHAR(200) NOT NULL,
  sku            VARCHAR(100) NOT NULL,
  custo          NUMERIC(12,2) NOT NULL,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, sku)
);

-- Cadastro de fornecedores, por empresa. "documento" guarda CNPJ (14
-- dígitos) ou CPF (11 dígitos), validado conforme o tamanho. Estrutura já
-- preparada (empresa_id) para futuramente relacionar fornecedor a produtos
-- e a compras — essa relação em si ainda não existe (não pedida nesta etapa).
CREATE TABLE IF NOT EXISTS fornecedores (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id),
  razao_social    VARCHAR(200) NOT NULL,
  nome_fantasia   VARCHAR(200),
  documento       VARCHAR(14) NOT NULL,   -- somente dígitos: CNPJ (14) ou CPF (11)
  telefone        VARCHAR(20),
  email           VARCHAR(255),
  observacao      TEXT,
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, documento)
);

-- Anúncios (itens/listagens) do Mercado Livre NÃO têm tabela própria: a tela
-- Anúncios busca ao vivo na API do Mercado Livre a cada carregamento (ver
-- server/lib/mlAnuncios.js) — nada é persistido aqui nesta etapa, por
-- decisão consciente (ver docs/02-decisoes.md).
