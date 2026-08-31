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

  -- Comissão do Mercado Livre sobre a venda (soma de order_items[].sale_fee
  -- × quantity de cada item — corrigido em 24/08/2026, ver docs/04-alteracoes.md;
  -- sale_fee vem da API por unidade, não pela linha inteira)
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
  taxa_venda                 NUMERIC(12,2)   -- sale_fee × quantidade (comissão TOTAL da linha — corrigido em 24/08/2026, ver docs/04-alteracoes.md)
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

-- Adicionada em 24/08/2026 (Bug 3 da reconciliação PF ERP x Mercado Turbo,
-- ver docs/04-alteracoes.md): desconto de cupom (Mercado Livre/PIX) aplicado
-- no pagamento — payments[].coupon_amount. NULL nas linhas sincronizadas
-- antes desta data (não preenchido retroativamente por migração de dados —
-- lib/relatorioVendas.js usa COALESCE com o valor já existente dentro de
-- raw_pagamento, que sempre teve o dado completo, então nenhum pedido
-- antigo fica com o cálculo errado por causa disso).
ALTER TABLE ml_pedido_pagamentos ADD COLUMN IF NOT EXISTS coupon_amount NUMERIC(12,2);

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

-- ============================================================
-- Etapa: Financeiro — Contas a Pagar, Contas a Receber, Recebimentos (24/08/2026)
-- ============================================================
--
-- Lançamento manual de conta a pagar, por empresa. `fornecedor_id` é
-- OPCIONAL de propósito ("fornecedor, quando houver" — pedido do usuário):
-- nem toda despesa tem fornecedor cadastrado (ex: imposto, aluguel, taxa
-- bancária). `categoria` é texto livre (não uma tabela/enum fixo) — o ERP
-- ainda não tem um plano de contas definido pelo usuário, então não
-- inventamos uma taxonomia; o front-end sugere algumas categorias comuns
-- via datalist, mas qualquer texto é aceito.
--
-- IMPORTANTE sobre o status "Vencido": NÃO é um valor gravado nesta coluna
-- — é sempre calculado em tempo de consulta (status = 'pendente' E
-- vencimento < hoje), em lib/contasPagar.js. Se fosse gravado, precisaria de
-- um job em segundo plano "promovendo" pendente -> vencido sozinho todo dia
-- (nada parecido existe no projeto — ver a mesma filosofia em `compras`,
-- onde nenhuma transição de status é automática). Assim a coluna `status`
-- só armazena o que o usuário realmente definiu (pendente/pago/cancelado),
-- e "vencido" é sempre derivado da data de hoje, nunca fica desatualizado.
CREATE TABLE IF NOT EXISTS contas_pagar (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id),
  fornecedor_id    INTEGER REFERENCES fornecedores(id),
  descricao        VARCHAR(200) NOT NULL,
  categoria        VARCHAR(100),
  valor            NUMERIC(12,2) NOT NULL,
  vencimento       DATE NOT NULL,
  data_pagamento   DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente | pago | cancelado ("vencido" é calculado, nunca gravado)
  observacao       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Lotes de importação de Contas a Pagar por CSV/XLSX. O lote existe só
-- para auditoria/rastreabilidade; as contas continuam morando na MESMA
-- tabela contas_pagar usada por lançamento manual, DRE e Fluxo de Caixa.
CREATE TABLE IF NOT EXISTS contas_pagar_importacoes (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id),
  nome_arquivo      VARCHAR(255) NOT NULL,
  total_linhas      INTEGER NOT NULL DEFAULT 0,
  total_importadas  INTEGER NOT NULL DEFAULT 0,
  total_ignoradas   INTEGER NOT NULL DEFAULT 0,
  total_erros       INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Metadados opcionais que podem vir da planilha. `fornecedor_nome_importado`
-- preserva o nome quando ele ainda não existe no cadastro de fornecedores —
-- nunca criamos fornecedor fictício sem CNPJ/CPF só para satisfazer o import.
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS fornecedor_nome_importado VARCHAR(200);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS documento VARCHAR(100);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS parcela VARCHAR(50);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS data_emissao DATE;
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS forma_pagamento VARCHAR(100);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS banco_conta VARCHAR(150);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS valor_pago NUMERIC(12,2);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS importacao_id INTEGER REFERENCES contas_pagar_importacoes(id);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_importacao_id ON contas_pagar(importacao_id) WHERE importacao_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa_vencimento_status ON contas_pagar(empresa_id, vencimento, status);

-- Lançamento manual de conta a receber, por empresa. `origem` é texto livre
-- (mesma razão de `categoria` em contas_pagar — sem plano de contas
-- definido ainda). "Atrasado" segue a mesma regra de "Vencido" acima:
-- calculado (status = 'a_receber' E data_prevista < hoje), nunca gravado.
CREATE TABLE IF NOT EXISTS contas_receber (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id),
  descricao        VARCHAR(200) NOT NULL,
  origem           VARCHAR(100),
  valor            NUMERIC(12,2) NOT NULL,
  data_prevista    DATE NOT NULL,
  data_recebida    DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'a_receber', -- a_receber | recebido | cancelado ("atrasado" é calculado, nunca gravado)
  observacao       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A tela "Recebimentos" (repasses dos marketplaces) NÃO tem tabela própria
-- nesta etapa — mesma decisão já tomada para Anúncios/Estoque Full: os
-- dados reais que já temos (ml_pedidos + ml_pedido_pagamentos, já
-- sincronizados) são suficientes para montar a visão, então ela é
-- calculada ao vivo por lib/recebimentosMl.js (reaproveitando
-- buscarPedidosDoPeriodo — a mesma fonte única de Visão Geral/Pedidos/
-- Financeiro/Relatórios), sem duplicar pedido nenhum. O Mercado Livre não
-- retorna data de liberação nem valor efetivamente repassado nos dados que
-- esta integração já busca (order/payments) — confirmado lendo o
-- raw_pagamento real de produção: não existe money_release_date nem campo
-- parecido. Por isso a tela mostra essas colunas como "Informação não
-- disponível" (nunca um valor/data inventado) até que uma fonte real desses
-- dados seja integrada (endpoint de settlements do ML, ou conciliação
-- manual) — ver docs/05-problemas-conhecidos.md.

-- ============================================================
-- Etapa: DRE, Faturamento e Notas Fiscais (24/08/2026)
-- ============================================================
--
-- A DRE NÃO tem tabela própria — é sempre calculada ao vivo em
-- lib/dre.js, reaproveitando exatamente lib/relatorioVendas.js
-- (buscarPedidosDoPeriodo + resumirPeriodo, intocado) para a parte de
-- vendas, e lib/contasPagar.js (resumoContasPagar) para a linha de
-- despesas/contas pagas do período — mesma filosofia já usada em
-- Recebimentos (sem duplicar dado, sem uma segunda fórmula financeira
-- paralela). Ver docs/02-decisoes.md para o desenho completo das linhas.
--
-- `ON DELETE CASCADE` no pedido_id de faturamento_pedidos e notas_fiscais:
-- pedido do Mercado Livre nunca é apagado de verdade na sincronização real
-- (é sempre upsert — ver docs/01-regras-de-negocio.md), então isso não
-- deveria disparar em produção; existe pra a situação de faturamento/nota
-- de um pedido nunca ficar "órfã" apontando pra um pedido que não existe
-- mais, e para não travar a exclusão de um pedido de teste que também
-- tenha faturamento/nota associados.

-- Faturamento: situação de faturamento de um pedido já existente
-- (ml_pedidos) — NUNCA duplica o pedido, só anota em que pé está o
-- faturamento dele. `pedido_id` é UNIQUE (1 pedido = no máximo 1 registro
-- de situação de faturamento). Um pedido sem linha aqui ainda é tratado
-- pela aplicação como "aguardando_faturamento" (o valor padrão/implícito
-- — só grava uma linha quando o usuário realmente muda o status pela
-- primeira vez), então a tabela começa vazia e só cresce conforme o
-- usuário for trabalhando a fila.
CREATE TABLE IF NOT EXISTS faturamento_pedidos (
  id           SERIAL PRIMARY KEY,
  pedido_id    INTEGER NOT NULL UNIQUE REFERENCES ml_pedidos(id) ON DELETE CASCADE,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id), -- denormalizado da empresa do pedido, só para filtro rápido — validado na aplicação que bate com a empresa real do pedido
  status       VARCHAR(30) NOT NULL DEFAULT 'aguardando_faturamento', -- aguardando_faturamento | faturado | erro | cancelado
  observacao   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notas Fiscais: estrutura para REGISTRAR e ACOMPANHAR notas relacionadas
-- a um pedido — nesta etapa não existe emissão real (SEFAZ). `pedido_id`
-- é UNIQUE (uma nota por pedido, nesta primeira versão — reemissão após
-- rejeição/cancelamento fica para uma etapa futura, se for pedida; ver
-- docs/02-decisoes.md). `numero`/`serie`/`chave_acesso`/`data_emissao`
-- ficam NULL até o usuário realmente registrar uma nota já emitida (em
-- outro sistema fiscal) — o ERP nunca gera/inventa esses valores sozinho.
-- `cliente` e `empresa/CNPJ`, pedidos pelo usuário na tela, NÃO são
-- colunas aqui — vêm sempre de um JOIN com ml_pedidos/empresas na hora de
-- montar a resposta, para nunca duplicar um dado que já existe no pedido.
CREATE TABLE IF NOT EXISTS notas_fiscais (
  id             SERIAL PRIMARY KEY,
  pedido_id      INTEGER NOT NULL UNIQUE REFERENCES ml_pedidos(id) ON DELETE CASCADE,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id), -- denormalizado da empresa do pedido, mesma razão de faturamento_pedidos
  numero         VARCHAR(20),
  serie          VARCHAR(10),
  chave_acesso   VARCHAR(44),
  valor          NUMERIC(12,2),
  data_emissao   DATE,
  status         VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente | emitida | cancelada | rejeitada
  observacao     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Etapa: Estoque com o Mercado Livre como fonte oficial (26/08/2026)
-- ============================================================
-- Pedido explícito do usuário: ele faz todos os lançamentos/ajustes de
-- estoque direto no Mercado Livre, então o ERP para de aceitar ajuste
-- manual de estoque e passa a espelhar, só leitura, a quantidade real de
-- cada anúncio/variação — sincronizada pelo mesmo ciclo automático de 1 em
-- 1 minuto de server/lib/syncScheduler.js (Etapa "sincronização automática
-- do Mercado Livre", ver mais acima), reaproveitado também para estoque.
--
-- `tipo` separa explicitamente Full de não-Full na MESMA tabela (nunca somados
-- nem misturados numa consulta só) — 'proprio' = estoque disponível fora do
-- Full (aba Estoque), 'full' = quantidade armazenada no Full (aba Estoque
-- Full). Uma linha por (conta, anúncio, variação, tipo) — item sem variação
-- usa ml_variation_id = NULL (tratado como uma única "variação" pela chave
-- única abaixo, via COALESCE, pra nunca duplicar linha a cada sincronização).
--
-- Nunca inventa: quando a API não retorna a quantidade (ou retorna num
-- formato que o ERP não reconhece — ver server/lib/mlEstoque.js sobre o
-- recurso de User Products/estoque multi-origem, cuja resposta exata não
-- pôde ser confirmada contra a documentação oficial nesta etapa, ver
-- docs/05-problemas-conhecidos.md), `quantidade` fica NULL e `pendente`
-- fica TRUE com o motivo em `motivo_pendencia` — a tela sempre mostra
-- "Pendente", nunca 0 ou um número calculado.
--
-- `recurso_usado` registra qual recurso da API respondeu a quantidade desta
-- linha ('available_quantity', 'user_products', 'available_quantity_fallback'
-- ou 'full_inventory') — só para transparência/depuração, não é mostrado
-- na tela nesta etapa.
CREATE TABLE IF NOT EXISTS ml_estoque_itens (
  id                 SERIAL PRIMARY KEY,
  conta_ml_id        INTEGER NOT NULL REFERENCES ml_contas(id) ON DELETE CASCADE,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id),
  tipo               VARCHAR(10) NOT NULL, -- 'proprio' (fora do Full) | 'full'
  ml_item_id         VARCHAR(30) NOT NULL,
  ml_variation_id    BIGINT,
  titulo             TEXT,
  sku                VARCHAR(100),
  loja               VARCHAR(200),
  status             VARCHAR(30),
  quantidade         INTEGER,
  pendente           BOOLEAN NOT NULL DEFAULT FALSE,
  motivo_pendencia   VARCHAR(50),
  user_product_id    VARCHAR(30),
  recurso_usado      VARCHAR(30),
  sincronizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tipo IN ('proprio', 'full'))
);

-- Chave de upsert (nunca duplica linha pra o mesmo anúncio/variação/tipo a
-- cada ciclo de sincronização — mesmo padrão de idempotência de ml_pedidos
-- por conta_ml_id+ml_order_id). COALESCE(ml_variation_id, 0) porque UNIQUE
-- trata NULL como sempre distinto no Postgres — sem isso, um item sem
-- variação criaria uma linha nova a cada sincronização em vez de atualizar
-- a existente.
CREATE UNIQUE INDEX IF NOT EXISTS ml_estoque_itens_unq
  ON ml_estoque_itens (conta_ml_id, ml_item_id, (COALESCE(ml_variation_id, 0)), tipo);
CREATE INDEX IF NOT EXISTS ml_estoque_itens_empresa_tipo_idx ON ml_estoque_itens (empresa_id, tipo);

-- As tabelas antigas de estoque (`estoque`/`estoque_movimentos`, ligadas a
-- `produtos`, e `estoque_produto_base`/`estoque_produto_base_movimentos`,
-- ligadas a `produtos_base`) NÃO são apagadas nesta etapa — preservam
-- histórico de ajustes manuais feitos antes desta mudança — mas param de
-- ser alimentadas: a tela Estoque não oferece mais ajuste manual (pedido
-- explícito do usuário), e as rotas antigas de ajuste (PUT em
-- routes/estoque.js e routes/estoqueProdutoBase.js) foram desativadas. Ver

-- ============================================================
-- Etapa: Integração real com a Shopee (Open Platform v2 — só autorização)
-- ============================================================

-- Lojas da Shopee conectadas via OAuth, uma por empresa/CNPJ (mesmo desenho
-- de ml_contas). access_token e refresh_token ficam sempre criptografados
-- (nunca em texto puro) — ver server/lib/shopeeCrypto.js (chave própria,
-- SHOPEE_TOKEN_KEY, nunca a mesma do Mercado Livre). O front-end nunca
-- recebe esses valores. Pedidos, estoque, Ads e financeiro da Shopee NÃO
-- fazem parte desta etapa — por isso não existe (ainda) nenhuma tabela de
-- pedido/estoque da Shopee; `ultima_sincronizacao_em` fica reservada para
-- quando a importação de pedidos for pedida (sempre NULL até lá).
CREATE TABLE IF NOT EXISTS shopee_contas (
  id                       SERIAL PRIMARY KEY,
  empresa_id               INTEGER NOT NULL REFERENCES empresas(id),
  shopee_shop_id           BIGINT NOT NULL UNIQUE,   -- id da loja na Shopee
  shop_name                VARCHAR(200),              -- nome da loja, quando a API retorna
  region                   VARCHAR(10),               -- ex: BR
  access_token_enc         TEXT NOT NULL,
  refresh_token_enc        TEXT NOT NULL,
  token_expires_at         TIMESTAMPTZ NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'ativa', -- ativa | erro | desconectada
  ultimo_erro              TEXT,
  ultima_sincronizacao_em  TIMESTAMPTZ,               -- reservado; sem pedidos nesta etapa, sempre NULL
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estado temporário do fluxo OAuth (proteção CSRF). Diferente de
-- ml_oauth_states, não guarda code_verifier — a Shopee Open Platform v2 não
-- usa PKCE, só assinatura HMAC por chamada (ver lib/shopee.js). Cada linha é
-- consumida (apagada) no callback; sobras antigas (>1h) podem ser limpas.
CREATE TABLE IF NOT EXISTS shopee_oauth_states (
  state          VARCHAR(64) PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- docs/02-decisoes.md.

-- ============================================================
-- Etapa: IA Gestora — central de análise (histórico de conversas + login
-- real, 25/08/2026 — ver docs/02-decisoes.md)
-- ============================================================
-- Login real, escopado a este momento só pra IA Gestora (ver comentário em
-- routes/iaGestora.js e docs/02-decisoes.md para o porquê desse recorte):
-- a tabela "users" já existia no schema (criada na etapa "Empresas", nunca
-- usada) — reaproveitada aqui como a fonte de verdade de login, sem
-- recriá-la. Senha nunca fica em texto puro: password_hash guarda
-- "salt:hash" (scrypt, ver lib/auth/senha.js) — nunca um hash reversível,
-- nunca a senha original em lugar nenhum (nem log).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;

-- Sessões de login (cookie httpOnly opaco — nunca JWT/token auto-contido,
-- pra sempre dar pra revogar uma sessão de verdade deletando a linha, ex: um
-- logout ou uma senha trocada). O valor que vai no cookie do navegador NUNCA
-- é gravado aqui — só o hash SHA-256 dele (mesma filosofia de nunca guardar
-- segredo em texto puro já usada no resto do projeto), pra um dump do banco
-- nunca ser suficiente pra personificar um usuário logado.
CREATE TABLE IF NOT EXISTS sessoes_usuario (
  id             SERIAL PRIMARY KEY,
  usuario_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     CHAR(64) NOT NULL UNIQUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em      TIMESTAMPTZ NOT NULL,
  ultimo_uso_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario_usuario ON sessoes_usuario(usuario_id);

-- Conversas da IA Gestora — cada uma pertence a UM usuário logado E a UMA
-- empresa (a empresa selecionada no cabeçalho no momento em que a conversa
-- foi criada). Nunca aparece na listagem de outro usuário — toda consulta a
-- esta tabela, em qualquer rota, sempre filtra por usuario_id = quem está
-- logado (ver routes/iaGestora.js) — nunca só por empresa_id.
CREATE TABLE IF NOT EXISTS ia_conversas (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  usuario_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  titulo         VARCHAR(200) NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_conversas_usuario_empresa ON ia_conversas(usuario_id, empresa_id, atualizado_em DESC);

-- Mensagens de uma conversa. `estruturado` guarda o payload visual (resumo,
-- KPIs, tabela, gráficos, insights, atenção) exatamente como foi mostrado na
-- conversa — a mesma estrutura é reaproveitada depois pra gerar a planilha
-- XLSX (nunca uma nova consulta ao banco: ver lib/ia/planilhaAnalise.js),
-- pra nunca existir a chance de a conversa mostrar um total e a planilha
-- mostrar outro. `ferramentas_usadas` guarda só os NOMES das ferramentas
-- consultadas (mesmo valor já mostrado no rodapé da mensagem) — nunca o
-- resultado bruto (esse já está dentro de `estruturado`/embutido no texto).
CREATE TABLE IF NOT EXISTS ia_mensagens (
  id                 SERIAL PRIMARY KEY,
  conversa_id        INTEGER NOT NULL REFERENCES ia_conversas(id) ON DELETE CASCADE,
  papel              VARCHAR(20) NOT NULL CHECK (papel IN ('usuario', 'assistente')),
  texto              TEXT NOT NULL,
  estruturado        JSONB,
  ferramentas_usadas JSONB,
  aviso              VARCHAR(40),
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_mensagens_conversa ON ia_mensagens(conversa_id, criado_em);
-- docs/02-decisoes.md.

-- Radar da IA — ativado em 25/08/2026 (ver docs/02-decisoes.md), 3º passo
-- pedido pelo usuário: a IA passa a acompanhar o negócio continuamente, em
-- segundo plano no SERVIDOR (lib/ia/radarScheduler.js), sem depender do
-- navegador aberto. `radar_alertas` guarda o resultado JÁ PERSISTIDO das
-- regras/cálculos determinísticos (lib/ia/radarAnuncios.js/radarNegocio.js)
-- — nunca um cálculo novo, sempre em cima das mesmas fontes já usadas pelo
-- resto do ERP. Cada situação tem uma `chave` estável (ex.:
-- "anuncio_parado:123456789") — o mesmo problema detectado de novo num
-- ciclo seguinte ATUALIZA a linha existente (nunca duplica um alerta igual
-- todo dia, pedido explícito do usuário), e uma situação que deixou de ser
-- verdade fica com status='resolvido' automaticamente (nunca precisa ação
-- manual pra "limpar" um alerta que já não existe mais).
CREATE TABLE IF NOT EXISTS radar_alertas (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id),
  chave              VARCHAR(200) NOT NULL,
  categoria          VARCHAR(60) NOT NULL,
  severidade         VARCHAR(20) NOT NULL CHECK (severidade IN ('critico', 'atencao', 'oportunidade', 'informativo')),
  titulo             TEXT NOT NULL,
  descricao          TEXT NOT NULL,
  -- `recomendacao` começa com um texto padrão (determinístico, por
  -- categoria — nunca vazio) e é enriquecida pela IA (lib/ia/radar.js) só
  -- quando a situação é NOVA ou piorou de severidade — nunca a cada ciclo
  -- pra não chamar o modelo à toa (pedido explícito do usuário).
  recomendacao       TEXT NOT NULL,
  dados              JSONB NOT NULL,
  pagina             VARCHAR(40),
  status             VARCHAR(20) NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'resolvido')),
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em       TIMESTAMPTZ,
  ultima_deteccao_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  interpretado_em    TIMESTAMPTZ,
  UNIQUE (empresa_id, chave)
);
CREATE INDEX IF NOT EXISTS idx_radar_alertas_empresa_status ON radar_alertas(empresa_id, status, severidade);

-- Estado do Radar por empresa (1 linha por empresa) — usado pra: 1) provar
-- que o radar roda mesmo sem ninguém com o ERP aberto (ultima_execucao_em
-- persiste no banco, sobrevive a reiniciar o servidor); 2) guardar o
-- resumo "O QUE PRECISA DA MINHA ATENÇÃO HOJE" já pronto (gerado pela IA a
-- partir só dos alertas abertos reais — nunca um texto solto sem dado por
-- trás), mostrado em Visão Geral > Alertas & IA e no resumo da IA Gestora.
CREATE TABLE IF NOT EXISTS radar_estado (
  empresa_id       INTEGER PRIMARY KEY REFERENCES empresas(id),
  ultima_execucao_em TIMESTAMPTZ,
  ultima_execucao_ok BOOLEAN,
  ultimo_erro        TEXT,
  situacoes_abertas  INTEGER NOT NULL DEFAULT 0,
  resumo_hoje        JSONB,
  resumo_gerado_em   TIMESTAMPTZ
);

-- Snapshot interno (NUNCA mostrado direto numa tela) só pra detectar
-- "o custo de um SKU mudou desde o último ciclo, e a margem foi de X para
-- Y" (lib/ia/radarNegocio.js) — sem isso não haveria como comparar "antes e
-- depois" de uma alteração de custo, já que o ERP recalcula toda margem
-- histórica com o custo ATUAL (nunca guarda o custo de quando a venda
-- aconteceu). Guarda só o ÚLTIMO valor conhecido por SKU (upsert a cada
-- ciclo) — não é histórico completo, só o suficiente pra comparar um ciclo
-- com o anterior.
CREATE TABLE IF NOT EXISTS radar_snapshot_custos (
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id),
  sku                   VARCHAR(100) NOT NULL,
  custo                 NUMERIC(12,2) NOT NULL,
  margem_percentual_30d NUMERIC(6,2),
  capturado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, sku)
);

-- Persistência do Product Ads do Mercado Livre (correção de 25/08/2026 —
-- ver docs/02-decisoes.md e docs/04-alteracoes.md). Antes desta correção a
-- tela Ads consultava a API de Advertising do Mercado Livre AO VIVO, dentro
-- da própria requisição HTTP da tela, toda vez que a página era aberta.
-- Pedido explícito do usuário: guardar os dados no banco (sincronizados em
-- background, ver lib/adsScheduler.js) pra tela Ads nunca depender de
-- consultar a API inteira a cada abertura.
--
-- Uma linha por conta do Mercado Livre — situação da conta na API de
-- Advertising (achou anunciante? qual o motivo real se não achou?) e
-- quando foi a última sincronização. `detalhe_api` guarda o corpo REAL da
-- resposta de erro do Mercado Livre (status HTTP + payload), pedido
-- explícito do usuário pro diagnóstico nunca ser um texto genérico solto
-- (ver lib/mlAds.js) — nunca mostrado direto pro usuário final sem
-- contexto, só disponível pra quem for investigar o motivo real.
CREATE TABLE IF NOT EXISTS ads_contas (
  conta_id                 INTEGER PRIMARY KEY REFERENCES ml_contas(id) ON DELETE CASCADE,
  advertiser_id             VARCHAR(50),
  site_id                   VARCHAR(10),
  disponivel                BOOLEAN NOT NULL DEFAULT false,
  motivo                    VARCHAR(40),
  mensagem                  TEXT,
  detalhe_api               JSONB,
  ultima_sincronizacao_em   TIMESTAMPTZ,
  ultima_sincronizacao_ok   BOOLEAN,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nome das campanhas por anunciante — só pra resolver campaign_id → nome
-- na tabela de anúncios (lib/ads.js); nunca usada pra recalcular
-- investimento/ROAS/ACOS de campanha (fonte única continua sendo o anúncio,
-- ver lib/ads.js).
CREATE TABLE IF NOT EXISTS ads_campanhas (
  conta_id      INTEGER NOT NULL REFERENCES ml_contas(id) ON DELETE CASCADE,
  campanha_id   VARCHAR(50) NOT NULL,
  nome          VARCHAR(255),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conta_id, campanha_id)
);

-- Métricas reais de Ads por anúncio, uma linha por (conta, período-chave,
-- anúncio) — `periodo_chave` é exatamente uma das chaves de PERIODOS em
-- lib/periodo.js ('hoje'|'ontem'|'7d'|'30d'|'mes'), o mesmo filtro global
-- usado em todo o ERP. A sincronização em background (lib/adsScheduler.js)
-- busca o total do anúncio pra cada uma dessas 5 janelas exatas na API do
-- Mercado Livre e grava aqui — porque a própria API de Advertising só
-- devolve um total agregado para o intervalo de datas pedido (não dá pra
-- "somar dias" depois, é a API que soma), replicar aqui o mesmo conjunto de
-- janelas do filtro da tela é o jeito de a tela nunca precisar consultar a
-- API ao vivo, pra qualquer período que o usuário escolher no filtro
-- existente. `faturamento_atribuido`/`qtd_atribuida` já aplicam a mesma
-- regra de fallback de sempre (total_amount, senão direct+indirect só
-- quando os dois existem — ver extrairInvestimentoEReceita em lib/ads.js);
-- os demais campos (ctr/cvr/roas/acos da API) são passados exatamente como
-- a API devolveu, nunca recalculados aqui.
CREATE TABLE IF NOT EXISTS ads_metricas_anuncio (
  id                        SERIAL PRIMARY KEY,
  conta_id                  INTEGER NOT NULL REFERENCES ml_contas(id) ON DELETE CASCADE,
  periodo_chave             VARCHAR(10) NOT NULL,
  ml_item_id                VARCHAR(30) NOT NULL,
  campanha_id               VARCHAR(50),
  titulo                    VARCHAR(255),
  cliques                   INTEGER,
  impressoes                INTEGER,
  cpc                       NUMERIC(12,2),
  investimento              NUMERIC(12,2),
  acos_api                  NUMERIC(12,2),
  ctr_api                   NUMERIC(12,4),
  cvr_api                   NUMERIC(12,4),
  roas_api                  NUMERIC(12,2),
  faturamento_atribuido     NUMERIC(12,2),
  qtd_atribuida             NUMERIC(12,2),
  atualizado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conta_id, periodo_chave, ml_item_id)
);
CREATE INDEX IF NOT EXISTS idx_ads_metricas_anuncio_conta_periodo ON ads_metricas_anuncio(conta_id, periodo_chave);

-- Série diária (investimento/receita atribuída, somado de todos os
-- anúncios da conta) — só pro gráfico "Investimento Ads x Receita
-- atribuída por dia" e pros cards "Gasto hoje"/"Gasto no mês". Uma janela
-- corrida (ver lib/adsScheduler.js), sempre re-sincronizada, nunca um
-- histórico "congelado" no dia em que foi gravado.
CREATE TABLE IF NOT EXISTS ads_diario (
  conta_id            INTEGER NOT NULL REFERENCES ml_contas(id) ON DELETE CASCADE,
  data                DATE NOT NULL,
  investimento        NUMERIC(12,2),
  receita_atribuida   NUMERIC(12,2),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conta_id, data)
);

-- ============================================================
-- Etapa: Despesas Fixas + Fluxo de Caixa (25/08/2026)
-- ============================================================
--
-- Despesas fixas são um MODELO de despesa recorrente (aluguel, salários,
-- pró-labore, sistemas, contador, energia, internet etc.) — não são, elas
-- mesmas, um lançamento financeiro. A cada ciclo (lib/despesasFixasScheduler.js)
-- o sistema gera a Conta a Pagar correspondente em contas_pagar, usando a
-- despesa fixa só como "molde". `categoria` é texto livre, mesma decisão
-- (e mesma lista sugerida, reaproveitada) de contas_pagar.categoria — sem
-- plano de contas definido no ERP ainda.
--
-- `dia_vencimento`: pro significado depender da frequência —
--   mensal/anual: dia do mês (1-31; se o mês tiver menos dias, cai no
--     último dia dele — ver normalizarDiaMes em lib/despesasFixas.js);
--   semanal: dia da semana ISO (1=segunda...7=domingo), sempre derivado do
--     dia da semana de data_inicio (nunca escolhido separado, pra nunca
--     ficar inconsistente com a própria data de início).
-- Anual usa o MÊS de data_inicio como o mês da ocorrência (só um campo de
-- dia a mais não faria sentido sem mês; não criamos um segundo campo
-- "mes_vencimento" pra não duplicar informação que data_inicio já dá).
--
-- `ativo`: pedido explícito do usuário ("cadastrar, editar, ativar e
-- desativar") — uma despesa fixa inativa só para de gerar novas contas a
-- pagar; nunca apaga nem altera as que já foram geradas (mesmo raciocínio
-- de imutabilidade do histórico já usado em contas_pagar/contas_receber).
CREATE TABLE IF NOT EXISTS despesas_fixas (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  descricao      VARCHAR(200) NOT NULL,
  categoria      VARCHAR(100),
  valor          NUMERIC(12,2) NOT NULL,
  frequencia     VARCHAR(10) NOT NULL, -- mensal | semanal | anual
  dia_vencimento INTEGER NOT NULL,
  data_inicio    DATE NOT NULL,
  data_fim       DATE,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  observacao     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vínculo entre a conta a pagar GERADA automaticamente e a despesa fixa que
-- a originou — coluna adicionada em contas_pagar (tabela já existente,
-- por isso ALTER + ADD COLUMN IF NOT EXISTS, mesmo padrão já usado neste
-- arquivo para ml_pedido_pagamentos/produtos_base). NULL pra toda conta a
-- pagar lançada manualmente (a grande maioria) — só é preenchida pela
-- geração automática (lib/despesasFixas.js#gerarContasPagarAutomaticas).
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS despesa_fixa_id INTEGER REFERENCES despesas_fixas(id);

-- Trava de não-duplicação (pedido explícito do usuário: "não duplicar
-- contas caso o processo seja executado mais de uma vez"). Índice único
-- PARCIAL (só quando despesa_fixa_id não é nulo — contas manuais nunca
-- competem entre si por essa regra): no máximo 1 conta a pagar por
-- (despesa fixa, vencimento). A geração automática usa
-- INSERT ... ON CONFLICT (despesa_fixa_id, vencimento) DO NOTHING — mesma
-- garantia mesmo se o ciclo rodar 2x seguidas ou em paralelo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_pagar_despesa_fixa_vencimento
  ON contas_pagar(despesa_fixa_id, vencimento) WHERE despesa_fixa_id IS NOT NULL;

-- Saldo inicial de caixa, INFORMADO PELO USUÁRIO — nunca lido de um banco
-- de verdade (o ERP não tem nenhuma integração bancária) e nunca inventado
-- pelo sistema. Mesma regra já registrada em lib/visaoGeralPainel.js
-- (fluxoDeCaixa/saldoProjetado): sem uma fonte real de saldo bancário,
-- qualquer "saldo atual" só pode existir se o próprio usuário informar o
-- ponto de partida — a partir daí o Fluxo de Caixa soma os movimentos reais
-- (contas pagas/recebidas) e projetados (contas em aberto) em cima desse
-- valor. Uma linha por empresa (upsert): só o valor mais recente importa,
-- não um histórico de todos os ajustes.
CREATE TABLE IF NOT EXISTS fluxo_caixa_saldo_inicial (
  empresa_id       INTEGER PRIMARY KEY REFERENCES empresas(id),
  valor            NUMERIC(14,2) NOT NULL,
  data_referencia  DATE NOT NULL,
  observacao       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Etapa: Saldo bancário automático a partir de extrato (31/08/2026)
-- ============================================================
-- contas_bancarias / extrato_importacoes / extrato_movimentos JÁ EXISTIAM em
-- produção antes desta etapa (criadas fora deste arquivo). Os CREATE TABLE
-- IF NOT EXISTS abaixo são só para deixar o schema.sql completo em qualquer
-- ambiente NOVO (ex.: um banco de testes do zero) — em produção eles são
-- no-op, exatamente como o resto deste arquivo. NÃO recriam nem apagam nada.
--
-- O saldo bancário (saldo_atual/saldo_data/saldo_atualizado_em) é sempre
-- SUBSTITUÍDO pelo "saldo final" identificado no extrato mais recente
-- confirmado — nunca somado a movimentos importados separadamente (ver
-- lib/contasBancarias.js#confirmarImportacao e lib/fluxoCaixa.js). Um
-- extrato com data de saldo mais antiga que a já registrada nunca regride o
-- saldo sozinho (só com confirmação explícita do usuário — ver
-- forcarSubstituicaoSaldo em confirmarImportacao).
CREATE TABLE IF NOT EXISTS contas_bancarias (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id),
  nome                  VARCHAR(200) NOT NULL,
  banco                 VARCHAR(100),
  agencia               VARCHAR(20),
  conta                 VARCHAR(30),
  ativa                 BOOLEAN NOT NULL DEFAULT TRUE,
  saldo_atual           NUMERIC(14,2),
  saldo_data            DATE,
  saldo_atualizado_em   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retrofit explícito e separado do CREATE TABLE acima (mesmo padrão já usado
-- para users.ativo e contas_pagar.despesa_fixa_id neste arquivo) — pedido
-- explicitamente pelo usuário para nunca repetir o incidente em que uma
-- coluna só existia dentro de um CREATE TABLE IF NOT EXISTS e por isso
-- nunca era aplicada num banco onde a tabela já existia (ver o mesmo caso
-- em despesas_fixas.ativo, mais acima neste arquivo).
ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS saldo_atual NUMERIC(14,2);
ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS saldo_data DATE;
ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS saldo_atualizado_em TIMESTAMPTZ;

-- Uma linha por arquivo de extrato realmente confirmado (a prévia/análise
-- não grava nada — só o passo de confirmação). arquivo_hash é o SHA-256 do
-- arquivo inteiro; a combinação (conta_bancaria_id, arquivo_hash) é o que
-- permite reimportar o mesmo arquivo sem duplicar (reconfirma/atualiza o
-- saldo em vez de gravar tudo de novo — ver confirmarImportacao).
CREATE TABLE IF NOT EXISTS extrato_importacoes (
  id                      SERIAL PRIMARY KEY,
  empresa_id              INTEGER NOT NULL REFERENCES empresas(id),
  conta_bancaria_id       INTEGER NOT NULL REFERENCES contas_bancarias(id),
  arquivo_nome            VARCHAR(255),
  arquivo_hash            VARCHAR(128),
  formato                 VARCHAR(20),
  saldo_final             NUMERIC(14,2),
  saldo_data              DATE,
  quantidade_movimentos   INTEGER NOT NULL DEFAULT 0,
  quantidade_importada    INTEGER NOT NULL DEFAULT 0,
  quantidade_duplicada    INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conta_bancaria_id, arquivo_hash)
);

-- Cada movimentação individual de um extrato confirmado. fingerprint (hash
-- de data+tipo+descrição+valor, com um contador para desempatar
-- movimentações idênticas no mesmo dia — ver lib/extratoBancario.js) é a
-- trava de não-duplicação por conta: ON CONFLICT (conta_bancaria_id,
-- fingerprint) DO NOTHING garante que reimportar o mesmo extrato nunca
-- duplica uma movimentação já gravada.
CREATE TABLE IF NOT EXISTS extrato_movimentos (
  id                  SERIAL PRIMARY KEY,
  importacao_id       INTEGER REFERENCES extrato_importacoes(id),
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id),
  conta_bancaria_id   INTEGER NOT NULL REFERENCES contas_bancarias(id),
  data                DATE NOT NULL,
  descricao           VARCHAR(500),
  tipo                VARCHAR(10) NOT NULL, -- entrada | saida
  valor               NUMERIC(14,2) NOT NULL,
  fingerprint         VARCHAR(64) NOT NULL,
  conciliado          BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conta_bancaria_id, fingerprint)
);
