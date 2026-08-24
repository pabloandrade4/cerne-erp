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

-- Custo do produto por SKU, por empresa.
-- LEGADO (24/08/2026): esta tabela era usada pela antiga tela "Custo &
-- Margem" e no cálculo financeiro da venda. Nessa data, a tela foi unificada
-- com "Produtos" (ver docs/02-decisoes.md e docs/04-alteracoes.md) — SKU e
-- custo passaram a ser cadastrados/editados só em `produtos`, e o cálculo de
-- margem passou a ler o custo de lá. Esta tabela FICA NO BANCO, com os dados
-- antigos preservados (não apagada, não editada), só para histórico/
-- auditoria — nenhuma rota ou cálculo do ERP lê ou escreve nela desde então.
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

-- Cadastro simples de produtos, por empresa: nome, SKU, custo e status.
-- Ainda sem kits nem composição.
-- Desde 24/08/2026, esta é a ÚNICA fonte de custo por SKU usada no cálculo
-- de margem das vendas do Mercado Livre (lib/relatorioVendas.js) — a antiga
-- tabela "custos_produto" (tela separada "Custo & Margem") foi unificada
-- aqui; ver o comentário em `custos_produto`, acima, e docs/02-decisoes.md.
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

-- ============================================================
-- Etapa: Estoque, Estoque Full (visualização) e Compras
-- ============================================================

-- Estoque PRÓPRIO (nunca misturado com o Estoque Full do Mercado Livre, que
-- não tem tabela — ver mais abaixo). Uma linha por produto — se o produto
-- ainda não teve nenhum ajuste, ele simplesmente não tem linha aqui ainda
-- (a tela trata como quantidade 0). Ajuste manual por enquanto (não pedido:
-- entrada automática por compra recebida, reserva por pedido).
CREATE TABLE IF NOT EXISTS estoque (
  id             SERIAL PRIMARY KEY,
  produto_id     INTEGER NOT NULL UNIQUE REFERENCES produtos(id),
  quantidade     INTEGER NOT NULL DEFAULT 0,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Histórico de movimentação do estoque próprio: toda alteração de
-- quantidade (por enquanto, só ajuste manual) grava uma linha aqui, mesmo
-- sem ainda existir uma tela própria de "ver histórico" — a tabela já fica
-- pronta pra isso (pedido explícito do usuário: "toda alteração de
-- quantidade deve ficar preparada para possuir histórico de movimentação").
CREATE TABLE IF NOT EXISTS estoque_movimentos (
  id                    SERIAL PRIMARY KEY,
  estoque_id            INTEGER NOT NULL REFERENCES estoque(id) ON DELETE CASCADE,
  tipo                  VARCHAR(20) NOT NULL DEFAULT 'ajuste_manual',
  quantidade_anterior   INTEGER NOT NULL,
  quantidade_nova       INTEGER NOT NULL,
  diferenca             INTEGER NOT NULL,
  observacao            TEXT,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estoque FULL (Mercado Livre) NÃO tem tabela própria, pela mesma razão de
-- Anúncios: a tela busca ao vivo na API a cada carregamento (ver
-- server/lib/mlFull.js) — nunca fica salvo/misturado com o estoque próprio
-- acima. Se a API não trouxer a quantidade de algum anúncio Full, a tela
-- mostra "pendente" — nunca um número inventado (ver docs/02-decisoes.md).

-- Pedido de compra a um fornecedor. "valor_total" é sempre recalculado no
-- servidor a partir dos itens (nunca aceito direto do que o front-end
-- mandar), pra nunca ficar dessincronizado da soma real dos itens.
CREATE TABLE IF NOT EXISTS compras (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id),
  fornecedor_id      INTEGER NOT NULL REFERENCES fornecedores(id),
  data_compra        DATE NOT NULL DEFAULT CURRENT_DATE,
  previsao_chegada   DATE,
  status             VARCHAR(20) NOT NULL DEFAULT 'em_aberto', -- em_aberto | pedido_realizado | recebido | cancelado
  valor_total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  observacao         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Itens de um pedido de compra. Ao editar uma compra, os itens são
-- substituídos pelos itens atuais enviados (mesmo padrão já usado em
-- ml_pedido_itens ao ressincronizar um pedido do Mercado Livre).
CREATE TABLE IF NOT EXISTS compra_itens (
  id                 SERIAL PRIMARY KEY,
  compra_id          INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  produto_id         INTEGER NOT NULL REFERENCES produtos(id),
  quantidade         INTEGER NOT NULL,
  custo_unitario     NUMERIC(12,2) NOT NULL,
  valor_total_item   NUMERIC(12,2) NOT NULL
);
-- Nesta etapa, receber uma compra (status "recebido") NÃO entra
-- automaticamente no estoque — pedido explícito do usuário para não
-- automatizar isso ainda. Ver docs/01-regras-de-negocio.md.

-- ============================================================
-- Etapa: Supabase como banco principal + sincronização histórica
-- ============================================================

-- Detalhe completo de cada pagamento de um pedido (order.payments[] —
-- um pedido pode ter mais de um pagamento). ml_pedidos.pagamento_* continua
-- guardando só um RESUMO do primeiro pagamento (payments[0]), que é o que
-- lib/resultadoVenda.js usa no cálculo de margem (fonte única de cálculo,
-- não alterada nesta etapa) — esta tabela é o detalhe completo de todos os
-- pagamentos, para auditoria/consulta, sem duplicar nem mudar essa fonte.
-- Ao ressincronizar um pedido, os pagamentos são substituídos pelos atuais
-- da API (mesmo padrão já usado em ml_pedido_itens).
CREATE TABLE IF NOT EXISTS ml_pedido_pagamentos (
  id                  SERIAL PRIMARY KEY,
  pedido_id           INTEGER NOT NULL REFERENCES ml_pedidos(id) ON DELETE CASCADE,
  ml_payment_id       BIGINT,
  status              VARCHAR(30),
  status_detail       VARCHAR(100),
  payment_type        VARCHAR(50),
  payment_method_id   VARCHAR(50),
  transaction_amount  NUMERIC(12,2),
  taxes_amount        NUMERIC(12,2),
  shipping_cost       NUMERIC(12,2),
  marketplace_fee     NUMERIC(12,2),
  installments        INTEGER,
  date_approved       TIMESTAMPTZ,
  date_created        TIMESTAMPTZ,
  raw_pagamento       JSONB,
  UNIQUE (pedido_id, ml_payment_id)
);

-- Acompanhamento da sincronização HISTÓRICA (importa todos os pedidos desde
-- uma data específica, ex: 01/07/2026 — diferente da sincronização normal,
-- que só traz os últimos 30 dias). Processada dia a dia, em fuso
-- America/Sao_Paulo, em segundo plano (pode levar bastante tempo numa conta
-- com muitos pedidos). O progresso é salvo a cada dia concluído
-- (janela_concluida_ate) — se for interrompida por qualquer motivo, a
-- próxima chamada retoma do dia seguinte ao último concluído, em vez de
-- reprocessar tudo de novo. Mesmo sem isso, nenhum pedido duplicaria (o
-- UPSERT de ml_pedidos por conta_ml_id+ml_order_id já garante isso) — o
-- bookmark existe só para não desperdiçar chamadas à API refazendo dias
-- já importados.
CREATE TABLE IF NOT EXISTS ml_sync_historicos (
  id                     SERIAL PRIMARY KEY,
  conta_ml_id            INTEGER NOT NULL REFERENCES ml_contas(id),
  desde                  DATE NOT NULL,
  ate_alvo               DATE NOT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'em_andamento', -- em_andamento | concluido | erro
  janela_concluida_ate   DATE,
  total_encontrados      INTEGER NOT NULL DEFAULT 0,
  total_importados       INTEGER NOT NULL DEFAULT 0,
  erros                  JSONB NOT NULL DEFAULT '[]',
  iniciado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_em          TIMESTAMPTZ
);

-- ============================================================
-- Etapa: Produto base e SKU (kit vendido no marketplace -> modelo físico)
-- ============================================================
--
-- O estoque físico não é controlado pelo SKU do kit vendido (ex:
-- '100CX-19X12X12'), e sim pelo modelo físico real por trás dele (ex:
-- 'CX-19X12X12'). Um mesmo produto base pode ter vários SKUs de venda
-- diferentes no Mercado Livre, cada um representando um kit de N unidades
-- físicas. Estas duas tabelas ficam SEPARADAS de `produtos` (catálogo
-- simples já existente) e de `custos_produto` (usada no cálculo de margem)
-- de propósito — nenhuma das duas foi tocada nesta etapa, só a estrutura
-- de produto base/SKU/multiplicador foi criada. Ver docs/02-decisoes.md.

-- Produto base: o modelo físico de verdade, por empresa.
CREATE TABLE IF NOT EXISTS produtos_base (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  codigo         VARCHAR(100) NOT NULL,  -- ex: 'CX-19X12X12'
  nome           VARCHAR(200),
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, codigo)
);

-- Vínculo SKU de venda -> produto base -> multiplicador. O `sku` aqui é
-- exatamente o mesmo texto gravado em ml_pedido_itens.sku (o SKU original
-- do Mercado Livre nunca é alterado lá) — este vínculo só serve para
-- TRADUZIR esse SKU em quantidade física, sem tocar no dado original do
-- pedido. Um SKU aponta para um único produto base (não faz sentido um
-- kit ser "metade de um produto, metade de outro" neste modelo).
-- `origem` marca se o vínculo veio de uma sugestão automática (leitura do
-- texto do SKU, ex: dígitos no início = multiplicador) ou foi cadastrado/
-- corrigido manualmente — em ambos os casos o vínculo salvo no banco é
-- que vale; a interpretação automática é só um ponto de partida, nunca a
-- fonte de verdade.
CREATE TABLE IF NOT EXISTS produto_base_skus (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id),
  sku              VARCHAR(100) NOT NULL,
  produto_base_id  INTEGER NOT NULL REFERENCES produtos_base(id),
  multiplicador    INTEGER NOT NULL CHECK (multiplicador > 0),
  origem           VARCHAR(20) NOT NULL DEFAULT 'manual', -- 'manual' | 'automatico'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, sku)
);

-- ============================================================
-- Etapa: tela Estoque (Galpão + Full, agrupado por produto base)
-- ============================================================
--
-- Custo unitário do produto base — usado só pelo valor financeiro do
-- estoque nesta etapa (Galpão/Full). Fica em `produtos_base` (e não numa
-- tabela separada, ao contrário de `custos_produto`) porque aqui já existe
-- uma linha por produto base — não há o problema de multiplicidade que
-- motivou a tabela separada para o custo por SKU. NULL = custo ainda não
-- cadastrado (tela mostra "pendente", nunca zero fingindo ser um custo real).
ALTER TABLE produtos_base ADD COLUMN IF NOT EXISTS custo NUMERIC(12,2);

-- Estoque físico no Galpão, por produto base (ajuste manual, mesmo padrão
-- já usado em `estoque`/`estoque_movimentos` para a tela antiga de
-- Produtos — só que agora por produto base, não por produto/SKU de venda).
-- Deliberadamente uma tabela NOVA e separada de `estoque` (que continua
-- existindo, ligada a `produtos`, sem nenhuma mudança) — nenhum dado real
-- existia lá (nenhum produto cadastrado ainda), então não há nada para
-- migrar, e as duas telas antigas (Produtos/Estoque) continuam intactas.
CREATE TABLE IF NOT EXISTS estoque_produto_base (
  id               SERIAL PRIMARY KEY,
  produto_base_id  INTEGER NOT NULL UNIQUE REFERENCES produtos_base(id),
  quantidade       INTEGER NOT NULL DEFAULT 0,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Histórico de movimentação do estoque de Galpão por produto base — mesmo
-- padrão de `estoque_movimentos` (quantidade anterior/nova/diferença,
-- observação opcional), preparado desde já mesmo sem tela própria pra
-- consultar o histórico ainda.
CREATE TABLE IF NOT EXISTS estoque_produto_base_movimentos (
  id                        SERIAL PRIMARY KEY,
  estoque_produto_base_id   INTEGER NOT NULL REFERENCES estoque_produto_base(id) ON DELETE CASCADE,
  quantidade_anterior       INTEGER NOT NULL,
  quantidade_nova           INTEGER NOT NULL,
  diferenca                 INTEGER NOT NULL,
  observacao                TEXT,
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Etapa: Unificação Produtos + Custo & Margem (24/08/2026)
-- ============================================================

-- Marca migrações de DADOS (não de schema) já aplicadas neste banco — schema
-- em si é sempre reaplicado com segurança via CREATE TABLE/ALTER ... IF NOT
-- EXISTS (db/migrate.js), mas uma migração que MOVE dados (ex: copiar
-- custos_produto para produtos) só pode rodar uma vez: rodar de novo a cada
-- boot sobrescreveria, para sempre, qualquer custo que o usuário venha a
-- editar depois em Produtos com o valor antigo de custos_produto. Ver
-- db/migrate.js.
CREATE TABLE IF NOT EXISTS migracoes_aplicadas (
  nome         VARCHAR(100) PRIMARY KEY,
  aplicado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
