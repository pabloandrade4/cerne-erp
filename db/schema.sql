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
-- recebe esses valores. Estoque, Ads e financeiro da Shopee ainda NÃO fazem
-- parte deste projeto. Pedidos: a partir de 14/09/2026 (Fase 1, pedido
-- explícito do usuário), `ultima_sincronizacao_em` passa a ser preenchida —
-- ver shopee_pedidos/shopee_pedido_itens e lib/shopeeSync.js, mais abaixo
-- (fora desta seção, adicionadas junto da tabela shopee_oauth_states).
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
  ultima_sincronizacao_em  TIMESTAMPTZ,               -- última vez que os pedidos desta loja foram puxados (manual ou automático, ver lib/shopeeSync.js/lib/shopeeSyncScheduler.js)
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

-- Pedidos importados da Shopee — Fase 1 da sincronização (14/09/2026,
-- pedido explícito do usuário: "puxar os últimos 60 dias"). Mesmo princípio
-- do Mercado Livre (ml_pedidos, acima): nunca duplica (UNIQUE
-- conta_shopee_id + order_sn — uma nova sincronização faz UPSERT), nunca
-- inventa valor (campo NULL quando a API não retornou o dado), e guarda o
-- payload bruto (raw_pedido) para auditoria — ver lib/shopeeSync.js.
-- IMPORTANTE: esta é a PRIMEIRA sincronização de pedidos da Shopee deste
-- projeto — os campos normalizados abaixo seguem a documentação pública da
-- API de Pedidos v2 da Shopee, ainda não confirmados contra pedidos reais
-- desta conta. Nenhum cálculo de margem/comissão/frete é feito nesta etapa
-- (Fase 2, ainda não construída, depende de ver os dados reais primeiro) —
-- por isso os pedidos da Shopee ainda não entram nas tabelas/telas do
-- Mercado Livre (ml_pedidos, routes/pedidos.js), só na sua própria listagem
-- simples (GET /api/integracoes/shopee/:id/pedidos).
CREATE TABLE IF NOT EXISTS shopee_pedidos (
  id                   SERIAL PRIMARY KEY,
  conta_shopee_id      INTEGER NOT NULL REFERENCES shopee_contas(id),
  order_sn             VARCHAR(50) NOT NULL,
  order_status         VARCHAR(30),
  data_criacao         TIMESTAMPTZ,
  data_atualizacao     TIMESTAMPTZ,
  comprador_user_id    BIGINT,
  comprador_username   VARCHAR(100),
  valor_total          NUMERIC(12,2),
  moeda                VARCHAR(5),
  metodo_pagamento     VARCHAR(50),
  transportadora       VARCHAR(100),
  frete_estimado       NUMERIC(12,2),
  frete_real           NUMERIC(12,2),

  raw_pedido           JSONB,

  criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (conta_shopee_id, order_sn)
);

-- Fase 2b (14/09/2026, pedido explícito do usuário: "quero igual ao mercado
-- livre, mas com as taxas e comissões da shopee") — repasse/comissão real de
-- cada pedido, vinda de uma chamada SEPARADA da Shopee
-- (payment/get_escrow_detail_batch — ver lib/shopee.js#obterDetalhesRepasse
-- e lib/shopeeSync.js), porque a Shopee não devolve esse dado junto do
-- pedido em si (get_order_detail). Mesmo princípio de sempre: campo NULL
-- quando a Shopee ainda não liberou/devolveu o repasse daquele pedido
-- (nunca um valor inventado) — igual a um pedido do Mercado Livre sem
-- sale_fee retornado. raw_repasse guarda a resposta bruta da Shopee para
-- aquele pedido (auditoria, mesmo padrão de raw_pedido).
-- IMPORTANTE (mesma honestidade de sempre): esta é a PRIMEIRA vez que este
-- projeto chama get_escrow_detail_batch — os nomes de campo abaixo seguem a
-- documentação pública cruzada com SDKs de terceiros nesta etapa (ver
-- comentário em lib/shopee.js), ainda não confirmados contra uma resposta
-- real desta conta.
ALTER TABLE shopee_pedidos ADD COLUMN IF NOT EXISTS comissao_venda NUMERIC(12,2); -- commission_fee (equivalente ao sale_fee/taxa_venda_total do Mercado Livre)
ALTER TABLE shopee_pedidos ADD COLUMN IF NOT EXISTS taxa_transacao_pagamento NUMERIC(12,2); -- seller_transaction_fee (equivalente a pagamento_taxas do Mercado Livre)
ALTER TABLE shopee_pedidos ADD COLUMN IF NOT EXISTS taxa_servico NUMERIC(12,2); -- service_fee (equivalente a pagamento_taxa_marketplace do Mercado Livre)
ALTER TABLE shopee_pedidos ADD COLUMN IF NOT EXISTS valor_repasse NUMERIC(12,2); -- escrow_amount — informativo/auditoria, não entra no cálculo de margem
ALTER TABLE shopee_pedidos ADD COLUMN IF NOT EXISTS raw_repasse JSONB;

-- Itens de cada pedido da Shopee (item_list[] da API). Ao ressincronizar um
-- pedido, os itens são substituídos pelos itens atuais da resposta — mesmo
-- padrão de ml_pedido_itens.
CREATE TABLE IF NOT EXISTS shopee_pedido_itens (
  id                 SERIAL PRIMARY KEY,
  pedido_id          INTEGER NOT NULL REFERENCES shopee_pedidos(id) ON DELETE CASCADE,
  item_id            BIGINT,
  nome               TEXT,
  sku                VARCHAR(100),   -- model_sku (ou item_sku quando o anúncio não tem variação)
  variacao_id        BIGINT,         -- model_id
  quantidade         INTEGER,
  preco_unitario     NUMERIC(12,2),
  valor_total_item   NUMERIC(12,2)
);

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

-- CORREÇÃO (01/09/2026, ativação da Central de Alertas — Etapa 7 pedida
-- pelo usuário, ver docs/04-alteracoes.md): a tela pede 4 status
-- (Novo/Visualizado/Resolvido/Ignorado), mas a coluna `status` acima só
-- aceitava 2 ('aberto'/'resolvido'). Retrofit explícito (mesmo padrão já
-- usado neste arquivo pra contas_bancarias/despesas_fixas.ativo — nunca
-- só dentro do CREATE TABLE, que é no-op numa tabela que já existe):
-- adiciona 'ignorado' como 3º valor de status, e duas colunas novas pra
-- derivar Novo (visualizado_em IS NULL) x Visualizado (preenchido) sem
-- precisar de mais uma coluna de status paralela. Nome do constraint é o
-- nome automático que o Postgres já deu (`<tabela>_<coluna>_check`,
-- confirmado localmente) — o DROP+ADD é seguro rodar de novo (idempotente).
ALTER TABLE radar_alertas ADD COLUMN IF NOT EXISTS visualizado_em TIMESTAMPTZ;
ALTER TABLE radar_alertas ADD COLUMN IF NOT EXISTS ignorado_em TIMESTAMPTZ;
ALTER TABLE radar_alertas DROP CONSTRAINT IF EXISTS radar_alertas_status_check;
ALTER TABLE radar_alertas ADD CONSTRAINT radar_alertas_status_check CHECK (status IN ('aberto', 'resolvido', 'ignorado'));

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

-- CORREÇÃO (01/09/2026, diagnóstico do módulo Ads/banco de dados — ver
-- docs/04-alteracoes.md): o retrofit acima (28/08→31/08/2026) esqueceu de
-- incluir banco/agencia/conta — exatamente o mesmo incidente que ele
-- documenta ter corrigido para saldo_atual/saldo_data/saldo_atualizado_em,
-- só que para estas 3 colunas. Confirmado em produção via erro real do
-- Postgres: `error: column "conta" does not exist` (código 42703),
-- disparado por lib/contasBancarias.js#listarContasBancarias, que já
-- seleciona banco/agencia/conta desde que a tabela existe neste arquivo —
-- essas colunas nunca tinham sido de fato criadas no banco de produção
-- (só existiam dentro do CREATE TABLE IF NOT EXISTS acima, que é no-op
-- numa tabela que já existia antes deste arquivo).
ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS banco VARCHAR(100);
ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS agencia VARCHAR(20);
ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS conta VARCHAR(30);

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

-- ============================================================
-- Etapa: Categorias financeiras + DRE detalhada + conciliação simples
-- (31/08/2026)
-- ============================================================
-- Plano de contas do próprio usuário (antes só existia como texto livre em
-- contas_pagar.categoria/despesas_fixas.categoria, sem cadastro real — ver
-- CATEGORIAS_SUGERIDAS duplicada em lib/contasPagar.js e
-- lib/despesasFixas.js). Esta tabela NÃO substitui a coluna de texto livre
-- em nenhum lugar — ela é adicionada por cima (contas_pagar.categoria_id
-- abaixo), pra nunca quebrar um lançamento antigo que só tem o texto.
--
-- categoria_pai_id: um único nível de subcategoria (uma subcategoria nunca
-- tem filha própria — pedido explícito do usuário de "não criar
-- complexidade desnecessária"). Categoria nunca é apagada de verdade
-- (excluir um DELETE quebraria o histórico de lançamentos já categorizados)
-- — só "ativa=false" (mesmo padrão de despesas_fixas.ativo/contas_bancarias.ativa).
CREATE TABLE IF NOT EXISTS categorias_financeiras (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id),
  nome                VARCHAR(100) NOT NULL,
  categoria_pai_id    INTEGER REFERENCES categorias_financeiras(id),
  ativa               BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- contas_pagar e extrato_movimentos JÁ EXISTIAM — retrofit em colunas
-- separadas (ALTER ... ADD COLUMN IF NOT EXISTS), nunca dentro de um CREATE
-- TABLE, mesma regra documentada mais acima neste arquivo (incidente
-- despesas_fixas.ativo) e reaplicada na etapa do saldo bancário.
--
-- contas_pagar.categoria_id: aponta pro cadastro real de categoria, mas a
-- coluna de texto `categoria` continua existindo e sendo preenchida em
-- paralelo (lib/contasPagar.js mantém as duas em sincronia) — nunca quebra
-- busca/relatório antigo que lê `categoria` como texto.
-- contas_pagar.conta_bancaria_id: só ROTULA de qual conta saiu o dinheiro
-- (rastreio/relatório) — NUNCA altera contas_bancarias.saldo_atual. Quem
-- manda no saldo real da conta continua sendo exclusivamente o saldo final
-- do extrato importado (ver etapa anterior); lançar uma conta a pagar como
-- paga não soma nem subtrai desse saldo, pra nunca ter duas fórmulas de
-- saldo bancário concorrendo.
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias_financeiras(id);
ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS conta_bancaria_id INTEGER REFERENCES contas_bancarias(id);

-- extrato_movimentos.categoria_id: permite categorizar um lançamento que
-- aparece SÓ no extrato (nunca virou conta a pagar) — ex.: tarifa bancária,
-- cobrança de um serviço que só existe no extrato.
-- extrato_movimentos.conta_pagar_id / conta_receber_id: o vínculo de
-- conciliação — quando preenchido, este movimento do extrato JÁ está
-- contado através da conta a pagar/receber correspondente, então a DRE e o
-- detalhamento (lib/despesasFinanceiras.js) NUNCA somam os dois ao mesmo
-- tempo (ver comentário lá — filtro `conta_pagar_id IS NULL`).
-- extrato_movimentos.transferencia_interna: marca uma movimentação como
-- transferência entre contas da própria empresa (ex.: Nubank → Mercado
-- Pago) — nunca entra como despesa/receita na DRE nem no Fluxo de Caixa.
ALTER TABLE extrato_movimentos ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias_financeiras(id);
ALTER TABLE extrato_movimentos ADD COLUMN IF NOT EXISTS conta_pagar_id INTEGER REFERENCES contas_pagar(id);
ALTER TABLE extrato_movimentos ADD COLUMN IF NOT EXISTS conta_receber_id INTEGER REFERENCES contas_receber(id);

-- ============================================================
-- Etapa: IA de Promoções — Fase A (13/09/2026)
-- Pedido do usuário: módulo que analisa anúncios do Mercado Livre e
-- recomenda entrar/sair de promoções olhando a margem REAL — mas hoje o
-- aplicativo cadastrado no Mercado Livre Developers tem (segundo o próprio
-- usuário) só permissão de LEITURA, então esta primeira fase é só a base:
-- nenhuma tabela/coluna aqui guarda nada que a IA "decidiu aplicar" de
-- verdade — isso só existe a partir da Fase B/E (ver docs/plano-ia-promocoes).
-- ============================================================

-- ml_contas.escopo_oauth: guarda O TEXTO EXATO que o Mercado Livre devolve
-- no campo `scope` da resposta de autenticação (ex.: "offline_access read
-- write") — capturado de graça tanto na conexão inicial
-- (routes/integracoes.js#/callback) quanto em toda renovação de token
-- (lib/mlSync.js#getContaComTokenValido), sem nenhuma chamada nova à API.
-- ATENÇÃO (documentado em lib/mlPermissoes.js): esse campo é só
-- INFORMATIVO — ver por que ele sozinho não prova que a Central de
-- Promoções aceita escrita. Quem manda de verdade é
-- config_promocoes.permite_escrita_ml, controlado manualmente pelo usuário.
ALTER TABLE ml_contas ADD COLUMN IF NOT EXISTS escopo_oauth VARCHAR(255);

-- Correção (14/09/2026): em pelo menos uma renovação de token real, o
-- Mercado Livre devolveu um `scope` maior que 255 caracteres, o que
-- derrubava a renovação inteira com "value too long for type character
-- varying(255)" e travava a conta em status='erro' (o ciclo automático de
-- renovação só tenta contas com status='ativa' — ver lib/syncScheduler.js).
-- Como esse campo é só informativo (nunca é usado pra decidir nada, ver
-- comentário acima e lib/mlPermissoes.js), não há motivo pra limitar o
-- tamanho: troca pra TEXT, que não tem limite de caracteres no Postgres.
ALTER TABLE ml_contas ALTER COLUMN escopo_oauth TYPE TEXT;

-- Configuração da IA de Promoções, por empresa. `permite_escrita_ml` nasce
-- SEMPRE false e só deve virar true manualmente pelo usuário, depois de
-- confirmar (no painel do Mercado Livre Developers) que a Central de
-- Promoções foi liberada para leitura E escrita, E de reconectar a conta
-- (novo OAuth) — reautorizar é obrigatório porque um token já emitido não
-- ganha permissão nova sozinho. Nenhum código desta primeira fase executa
-- ação de escrita de verdade; esta coluna só existe pra já deixar a
-- arquitetura pronta pra quando isso for construído (Fase E).
CREATE TABLE IF NOT EXISTS config_promocoes (
  empresa_id           INTEGER PRIMARY KEY REFERENCES empresas(id),
  margem_minima_pct    NUMERIC(5,2) NOT NULL DEFAULT 14,   -- % — abaixo disso a IA marca "NÃO RECOMENDADA"
  desconto_maximo_pct  NUMERIC(5,2),                        -- opcional — trava futura do modo automático (Fase E)
  estoque_minimo       INTEGER,                             -- opcional — idem
  vendas_minimas_30d   INTEGER,                             -- opcional — idem ("não mexer com menos de X vendas")
  permite_full         BOOLEAN NOT NULL DEFAULT true,
  permite_proprio      BOOLEAN NOT NULL DEFAULT true,
  modo_ia              VARCHAR(30) NOT NULL DEFAULT 'somente_analisar',
    -- 'somente_analisar' | 'sugerir_aprovar' | 'automatico' — só
    -- 'somente_analisar' funciona nesta fase; os outros dois exigem escrita
    -- liberada (Fase E) e ficam bloqueados no backend até lá.
  permite_escrita_ml   BOOLEAN NOT NULL DEFAULT false,
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE extrato_movimentos ADD COLUMN IF NOT EXISTS transferencia_interna BOOLEAN NOT NULL DEFAULT false;

-- IA de Promoções — Fase B (13/09/2026): resultado já calculado do ciclo
-- automático (lib/ia/promocoesCiclo.js, roda a cada 1h — pedido explícito do
-- usuário: "a cada uma hora a ia tem que busca novas promoções"). A tela
-- SEMPRE lê daqui (nunca recalcula ao vivo) — uma linha por item de
-- promoção, com a margem REAL já calculada (nunca só o % de desconto).
-- `margem_incompleta`/`motivo_incompleto` existem porque a regra do usuário
-- é nunca fabricar um número quando falta um dado real (SKU não
-- identificado, produto sem custo cadastrado, SKU sem histórico de vendas
-- suficiente para estimar comissão/frete) — ver lib/promocoesMotor.js.
CREATE TABLE IF NOT EXISTS promocoes_analises (
  id                              SERIAL PRIMARY KEY,
  empresa_id                      INTEGER NOT NULL REFERENCES empresas(id),
  conta_id                        INTEGER NOT NULL REFERENCES ml_contas(id),
  promotion_id                    VARCHAR(80) NOT NULL,
  promotion_type                  VARCHAR(60) NOT NULL,
  promotion_label                 VARCHAR(255),
  ml_item_id                      VARCHAR(40) NOT NULL,
  status_item_ml                  VARCHAR(40),
  titulo                          TEXT,
  imagem_url                      TEXT,
  sku                             VARCHAR(120),
  preco_normal                    NUMERIC(12,2),
  preco_promo                     NUMERIC(12,2),
  origem_preco_promo              VARCHAR(40),
  desconto_pct                    NUMERIC(6,2),
  desconto_bancado_meli_pct       NUMERIC(6,2),
  desconto_bancado_vendedor_pct   NUMERIC(6,2),
  custo_produto                   NUMERIC(12,2),
  tarifas_estimadas               NUMERIC(12,2),
  frete_vendedor_estimado         NUMERIC(12,2),
  imposto_estimado                NUMERIC(12,2),
  margem_real                     NUMERIC(12,2),
  margem_real_pct                 NUMERIC(6,2),
  margem_minima_pct_usada         NUMERIC(5,2),
  margem_incompleta               BOOLEAN NOT NULL DEFAULT false,
  motivo_incompleto               TEXT,
  classificacao_codigo            VARCHAR(30),
  classificacao_label             VARCHAR(40),
  atualizado_em                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conta_id, promotion_id, ml_item_id)
);
CREATE INDEX IF NOT EXISTS idx_promocoes_analises_empresa ON promocoes_analises (empresa_id);

-- ============================================================
-- Correção de performance (14/09/2026) — "Query read timeout"
-- ============================================================
-- Investigando por que a IA de Promoções (e outras telas que usam o mesmo
-- período de vendas — Visão Geral, Financeiro, Pedidos, Relatórios, Margem
-- por Anúncio) vinham falhando de vez em quando com "Query read timeout" em
-- lib/relatorioVendas.js#buscarPedidosDoPeriodo: essa função faz, PARA CADA
-- pedido do período, várias subconsultas em ml_pedido_itens filtrando por
-- pedido_id (título/SKU resumidos, quantidade de itens/unidades, custo do
-- produto) — e ml_pedido_itens nunca teve nenhum índice em pedido_id, só a
-- chave estrangeira (que sozinha NÃO cria índice no Postgres). Ou seja: cada
-- uma dessas subconsultas varria a tabela ml_pedido_itens INTEIRA, um
-- pedido de cada vez. Com 90 dias de pedidos, isso piora ainda mais quanto
-- mais a loja vende — index puramente aditivo, não muda nenhum resultado,
-- só faz essas subconsultas irem direto nas linhas certas.
CREATE INDEX IF NOT EXISTS idx_ml_pedido_itens_pedido_id ON ml_pedido_itens (pedido_id);

-- ============================================================
-- IA de Ads e Performance — Fase A (14/09/2026)
-- ============================================================
-- Primeiro dos 4 agentes de IA do Mercado Livre pedidos pelo usuário (Buy
-- Box/Competitividade, SAC e Pós-Venda, Ads e Performance, Risco
-- Operacional) — ver lib/ia/adsMotor.js para a explicação de por que este
-- foi o escolhido pra começar (nenhum dado novo, nenhuma permissão nova).
-- Mesmo padrão de `config_promocoes`: `margem_minima_pct` é o único ajuste
-- que o usuário controla — abaixo disso a IA classifica como "AJUSTAR" (ou
-- "PAUSAR" se o resultado após Ads for negativo).
CREATE TABLE IF NOT EXISTS config_ads_ia (
  empresa_id           INTEGER PRIMARY KEY REFERENCES empresas(id),
  margem_minima_pct    NUMERIC(5,2) NOT NULL DEFAULT 10,
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Agentes de IA — Fase 1: aprendizado com decisão humana (14/09/2026)
-- ============================================================
-- Pedido explícito do usuário: os agentes de IA (Ads e Performance,
-- Promoções) não devem só classificar e mostrar — devem recomendar uma
-- AÇÃO concreta e explicável, guardar a decisão do usuário sobre cada
-- recomendação (aprovou/alterou/recusou) e, mais tarde, o resultado real
-- dessa decisão — pra aprender com o padrão de decisão do usuário antes de
-- qualquer execução automática (Fase 3, explicitamente NÃO implementada
-- agora). NESTA FASE NENHUM CÓDIGO CHAMA A API DO MERCADO LIVRE PARA
-- EXECUTAR NADA — só lê o que já está sincronizado e grava a decisão do
-- usuário (ver lib/ia/adsDecisoesCiclo.js e lib/ia/promocoesDecisoesStore.js).
--
-- `ia_agentes` é só o registro de identidade de cada agente (nome/descrição/
-- ícone) — pedido explícito do usuário: "para eu no futuro conseguir
-- conversar com cada um separado". Nenhuma conversa é implementada agora,
-- só a identidade que uma conversa futura vai precisar.
CREATE TABLE IF NOT EXISTS ia_agentes (
  id            SERIAL PRIMARY KEY,
  codigo        VARCHAR(40) NOT NULL UNIQUE,
  nome          VARCHAR(120) NOT NULL,
  descricao     TEXT,
  icone         VARCHAR(30),
  ordem         INTEGER NOT NULL DEFAULT 0,
  ativo         BOOLEAN NOT NULL DEFAULT true,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ia_agentes (codigo, nome, descricao, icone, ordem) VALUES
  ('ads_performance', 'Ads e Performance', 'Analisa campanhas, anúncios e SKUs de Mercado Ads e recomenda orçamento, meta de ACOS, pausar/escalar campanhas e mover SKUs entre campanhas — você aprova, altera ou recusa cada sugestão.', 'megaphone', 1),
  ('promocoes', 'Promoções', 'Analisa promoções do Mercado Livre e recomenda entrar, não entrar, sair ou revisar o preço promocional, sempre pela margem real — você aprova, altera ou recusa cada sugestão.', 'sparkle', 2)
ON CONFLICT (codigo) DO NOTHING;

-- Campos adicionais em ads_campanhas/ads_metricas_anuncio — puramente
-- ADITIVO, nunca muda o que já é gravado/lido hoje (ver lib/ads.js). São o
-- "orçamento e status reais atuais" que o agente de Ads precisa pra
-- calcular uma sugestão de orçamento com valor concreto (ex.: "de R$150
-- para R$100") em vez de só um percentual solto — confirmados como campos
-- padrão do objeto de campanha/anúncio na documentação oficial do Mercado
-- Ads (global-selling.mercadolibre.com/devsite/new-product-ads), nunca
-- escritos por este ERP nesta fase, só lidos e guardados.
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS orcamento_diario NUMERIC(12,2);
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS acos_alvo NUMERIC(6,2);
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS estrategia VARCHAR(30);
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS status_campanha VARCHAR(20);
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS orcamento_automatico BOOLEAN;
ALTER TABLE ads_metricas_anuncio ADD COLUMN IF NOT EXISTS status_anuncio VARCHAR(20);

-- Métricas de campanha adicionais (14/09/2026, pedido explícito do usuário
-- — "estude sobre todas as métricas que tem dentro do Mercado Livre") —
-- confirmadas na documentação oficial (developers.mercadolibre.com.ar/
-- en_us/product-ads-us-read, campo "metrics" do objeto de campanha) como
-- existentes e JÁ disponíveis via `metrics`, só nunca pedidas/gravadas
-- antes (ver METRICS_CAMPANHA em lib/mlAds.js). Puramente aditivo — nenhuma
-- chamada nova à API além de incluir esses nomes no parâmetro `metrics`
-- que a sincronização de campanhas já faz. São a base real (nunca
-- inventada) pra lib/ia/adsDecisor.js só sugerir "aumentar orçamento"
-- quando o motivo real de perder exibição É orçamento (não ranking/leilão),
-- e pra citar o ACOS de referência do próprio Mercado Livre na explicação.
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS sov NUMERIC(6,2); -- share of voice: % das vendas totais que vieram de Ads
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS fatia_impressoes_pct NUMERIC(6,2); -- impression_share
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS fatia_impressoes_topo_pct NUMERIC(6,2); -- top_impression_share
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS impressoes_perdidas_orcamento_pct NUMERIC(6,2); -- lost_impression_share_by_budget
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS impressoes_perdidas_ranking_pct NUMERIC(6,2); -- lost_impression_share_by_ad_rank
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS acos_benchmark NUMERIC(6,2); -- ACOS de referência do próprio Mercado Livre pra campanhas com bom desempenho
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS vendas_organicas_qtd NUMERIC(12,2); -- organic_units_quantity
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS vendas_organicas_valor NUMERIC(12,2); -- organic_units_amount
ALTER TABLE ads_campanhas ADD COLUMN IF NOT EXISTS acos_alvo_topo_busca NUMERIC(6,2); -- acos_top_search_target (campo do objeto campanha, não de "metrics" — confirmado no mesmo exemplo oficial)

-- Histórico de decisões do agente "Ads e Performance" — uma linha por
-- SITUAÇÃO em aberto (não uma linha por ciclo): enquanto ninguém decide, a
-- mesma situação (um anúncio ou uma campanha) mantém UMA linha "pendente",
-- só atualizada a cada ciclo com os números mais recentes (ver índice único
-- parcial abaixo); assim que o usuário decide, a linha vira histórico
-- definitivo e uma situação nova no mesmo anúncio/campanha abre uma linha
-- NOVA — o histórico nunca é sobrescrito. `executado` fica sempre false
-- nesta fase (nenhuma escrita real no Mercado Livre ainda).
CREATE TABLE IF NOT EXISTS ia_decisoes_ads (
  id                              SERIAL PRIMARY KEY,
  empresa_id                      INTEGER NOT NULL REFERENCES empresas(id),
  conta_id                        INTEGER NOT NULL REFERENCES ml_contas(id),
  tipo_referencia                 VARCHAR(20) NOT NULL,  -- 'anuncio' | 'campanha'
  ml_item_id                      VARCHAR(40),            -- preenchido quando tipo_referencia='anuncio'
  campanha_id                     VARCHAR(50),
  campanha_nome                   VARCHAR(255),
  sku                             VARCHAR(120),
  titulo                          TEXT,
  tipo_acao                       VARCHAR(40) NOT NULL,   -- ver lib/ia/adsDecisor.js
  motivo                          TEXT NOT NULL,          -- explicação legível — nunca "caixa preta"
  snapshot_investimento           NUMERIC(12,2),
  snapshot_faturamento_real       NUMERIC(12,2),
  snapshot_roas                   NUMERIC(12,2),
  snapshot_acos                   NUMERIC(12,2),
  snapshot_margem_antes_ads       NUMERIC(12,2),
  snapshot_margem_depois_ads      NUMERIC(12,2),
  snapshot_margem_depois_ads_pct  NUMERIC(6,2),
  snapshot_qtd_vendas             NUMERIC(12,2),
  snapshot_orcamento_atual        NUMERIC(12,2),
  snapshot_acos_alvo_atual        NUMERIC(6,2),
  valor_sugerido_ia               JSONB NOT NULL,
  valor_decidido_usuario          JSONB,
  status_decisao                  VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente|aprovada|alterada|recusada|expirada
  decidido_em                     TIMESTAMPTZ,
  decidido_por                    VARCHAR(180),
  executado                       BOOLEAN NOT NULL DEFAULT false,
  executado_em                    TIMESTAMPTZ,
  resultado_snapshot              JSONB,
  resultado_avaliado_em           TIMESTAMPTZ,
  criado_em                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_decisoes_ads_empresa ON ia_decisoes_ads (empresa_id, status_decisao);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_decisoes_ads_pendente
  ON ia_decisoes_ads (conta_id, tipo_referencia, COALESCE(ml_item_id,''), COALESCE(campanha_id,''), tipo_acao)
  WHERE status_decisao = 'pendente';

-- Mesmo conceito acima, pro agente de Promoções — chave natural é
-- (conta, promoção, item), igual a `promocoes_analises`.
CREATE TABLE IF NOT EXISTS ia_decisoes_promocoes (
  id                                SERIAL PRIMARY KEY,
  empresa_id                        INTEGER NOT NULL REFERENCES empresas(id),
  conta_id                          INTEGER NOT NULL REFERENCES ml_contas(id),
  promotion_id                      VARCHAR(80) NOT NULL,
  promotion_type                    VARCHAR(60) NOT NULL,
  promotion_label                   VARCHAR(255),
  ml_item_id                        VARCHAR(40) NOT NULL,
  sku                                VARCHAR(120),
  titulo                             TEXT,
  tipo_acao                          VARCHAR(40) NOT NULL,  -- ver lib/ia/promocoesDecisor.js
  motivo                             TEXT NOT NULL,
  snapshot_preco_normal              NUMERIC(12,2),
  snapshot_preco_promo               NUMERIC(12,2),
  snapshot_desconto_pct              NUMERIC(6,2),
  snapshot_custo_produto             NUMERIC(12,2),
  snapshot_tarifas_estimadas         NUMERIC(12,2),
  snapshot_frete_vendedor_estimado   NUMERIC(12,2),
  snapshot_imposto_estimado          NUMERIC(12,2),
  snapshot_margem_real               NUMERIC(12,2),
  snapshot_margem_real_pct           NUMERIC(6,2),
  valor_sugerido_ia                  JSONB NOT NULL,
  valor_decidido_usuario             JSONB,
  status_decisao                     VARCHAR(20) NOT NULL DEFAULT 'pendente',
  decidido_em                        TIMESTAMPTZ,
  decidido_por                       VARCHAR(180),
  executado                          BOOLEAN NOT NULL DEFAULT false,
  executado_em                       TIMESTAMPTZ,
  resultado_snapshot                 JSONB,
  resultado_avaliado_em              TIMESTAMPTZ,
  criado_em                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_decisoes_promocoes_empresa ON ia_decisoes_promocoes (empresa_id, status_decisao);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_decisoes_promocoes_pendente
  ON ia_decisoes_promocoes (conta_id, promotion_id, ml_item_id)
  WHERE status_decisao = 'pendente';

-- ============================================================================
-- "Daily dos Agentes" — Etapa 1: SÓ SCHEMA (14/09/2026, pedido explícito do
-- usuário). Fundação para uma reunião automática diária (09:00) em que um
-- Agente Coordenador chama os especialistas existentes (Ads e Performance,
-- Promoções — Buy Box/SAC/Riscos Operacionais entram quando existirem de
-- verdade como agentes, nunca como placeholder) e cruza os achados de cada
-- um em conclusões determinísticas, nunca texto inventado.
--
-- IMPORTANTE: nesta etapa NENHUM código lê ou escreve nestas tabelas ainda —
-- nem o scheduler, nem o Coordenador, nem a rota `/decisoes` existente de
-- Ads/Promoções foram alterados. É só a estrutura, aprovada e entregue
-- separada de qualquer lógica nova, pra poder ser conferida sozinha antes da
-- Etapa 2 (implementação dos especialistas) começar. Tudo abaixo é aditivo:
-- tabelas novas + colunas novas opcionais nas tabelas de decisão que já
-- funcionam (`ia_decisoes_ads`, `ia_decisoes_promocoes`), sem tocar em
-- nenhuma coluna/índice/comportamento já existente.
-- ============================================================================

-- Uma linha por reunião diária. `reuniao_anterior_id` é como cada
-- especialista sabe "o que mudou desde a última vez" sem precisar guardar
-- estado em nenhum outro lugar. Uma reunião por empresa por dia civil
-- (`data_referencia` é a data no fuso da empresa, não um timestamp).
CREATE TABLE IF NOT EXISTS ia_reunioes_diarias (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id),
  data_referencia       DATE NOT NULL,
  reuniao_anterior_id   INTEGER REFERENCES ia_reunioes_diarias(id),
  status                VARCHAR(20) NOT NULL DEFAULT 'em_andamento', -- em_andamento|concluida|falhou
  erro                  TEXT,
  iniciada_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizada_em         TIMESTAMPTZ,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_reunioes_diarias_empresa_dia
  ON ia_reunioes_diarias (empresa_id, data_referencia);

-- Coluna aditiva (19/09/2026, pedido explícito do usuário: "quero que
-- atualize... me enviar relatórios... pelo WhatsApp") — Etapa 4 da Daily dos
-- Agentes: agendamento automático + aviso por WhatsApp (ver
-- lib/ia/dailyScheduler.js). NULL enquanto o resumo do dia ainda não foi
-- enviado; marcado com now() assim que o agendador TENTA o envio (sucesso ou
-- falha do WhatsApp) — nunca tenta mandar 2 vezes no mesmo dia pra mesma
-- empresa, mesmo que o servidor reinicie no meio do dia.
ALTER TABLE ia_reunioes_diarias ADD COLUMN IF NOT EXISTS whatsapp_enviado_em TIMESTAMPTZ;

-- Um achado por linha — o que cada especialista relatou na reunião
-- (problema/oportunidade/risco/alteração desde a última reunião). `dados` é
-- o JSONB com os números reais que sustentam o achado (nunca uma frase sem
-- lastro). Quando o achado já corresponde a uma sugestão de ação concreta
-- que existe nas tabelas de decisão de hoje, `decisao_tabela`/`decisao_id`
-- apontam pra lá — a Daily nunca duplica o fluxo de aprovar/recusar que já
-- funciona, só referencia. `decisao_tabela` é texto (não FK) porque aponta
-- pra uma de duas tabelas hoje (`ia_decisoes_ads` ou `ia_decisoes_promocoes`)
-- e mais no futuro, conforme novos agentes ganharem tabela própria.
CREATE TABLE IF NOT EXISTS ia_achados_diarios (
  id                SERIAL PRIMARY KEY,
  reuniao_id        INTEGER NOT NULL REFERENCES ia_reunioes_diarias(id),
  agente_codigo     VARCHAR(40) NOT NULL REFERENCES ia_agentes(codigo),
  tipo              VARCHAR(20) NOT NULL, -- problema|oportunidade|risco|alteracao
  titulo            VARCHAR(255) NOT NULL,
  descricao         TEXT,
  dados             JSONB,
  prioridade        VARCHAR(10), -- critica|alta|media|baixa — nulo quando é só informativo
  sku               VARCHAR(120),
  campanha_id       VARCHAR(50),
  pedido_id         VARCHAR(50), -- para agentes futuros (SAC/Reclamações), sem uso ainda
  decisao_tabela    VARCHAR(40), -- 'ia_decisoes_ads' | 'ia_decisoes_promocoes' | NULL
  decisao_id        INTEGER,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_achados_diarios_reuniao ON ia_achados_diarios (reuniao_id, agente_codigo);

-- Conclusões do Coordenador ao CRUZAR achados de agentes diferentes (o
-- exemplo do próprio usuário: Ads acusa margem baixa num SKU + Promoções
-- acusa desconto ativo no mesmo SKU + Buy Box confirma preço competitivo ->
-- "reduza o desconto antes de reduzir Ads"). `regra_codigo` identifica qual
-- regra determinística do Coordenador disparou (auditável — nunca "a IA
-- decidiu" sem explicação) e `achados_relacionados` guarda os IDs reais de
-- `ia_achados_diarios` que embasam a conclusão, pra nunca virar texto solto
-- sem lastro nos dados.
CREATE TABLE IF NOT EXISTS ia_correlacoes_diarias (
  id                     SERIAL PRIMARY KEY,
  reuniao_id             INTEGER NOT NULL REFERENCES ia_reunioes_diarias(id),
  regra_codigo           VARCHAR(60) NOT NULL,
  achados_relacionados   JSONB NOT NULL, -- array de ids de ia_achados_diarios
  conclusao              TEXT NOT NULL,
  decisao_tabela         VARCHAR(40),
  decisao_id             INTEGER,
  prioridade             VARCHAR(10),
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_correlacoes_diarias_reuniao ON ia_correlacoes_diarias (reuniao_id);

-- Generaliza o `resultado_snapshot`/`resultado_avaliado_em` que já existe
-- hoje em ia_decisoes_ads/ia_decisoes_promocoes (continua existindo e
-- funcionando exatamente como hoje, sem nenhuma mudança) para MÚLTIPLOS
-- checkpoints — pedido explícito do usuário: resultado imediato, 24h, 3
-- dias e 7 dias. `decisao_tabela` é texto (não FK) pelo mesmo motivo de
-- ia_achados_diarios — aponta pra uma das tabelas de decisão existentes.
-- Índice único garante que cada checkpoint só é preenchido uma vez por
-- decisão (mesmo padrão de segurança que `resultado_avaliado_em IS NULL` já
-- usa hoje).
CREATE TABLE IF NOT EXISTS ia_decisoes_resultados_historico (
  id                SERIAL PRIMARY KEY,
  decisao_tabela    VARCHAR(40) NOT NULL, -- 'ia_decisoes_ads' | 'ia_decisoes_promocoes'
  decisao_id        INTEGER NOT NULL,
  checkpoint        VARCHAR(10) NOT NULL, -- imediato|24h|3d|7d
  snapshot          JSONB,
  avaliado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_decisoes_resultados_checkpoint
  ON ia_decisoes_resultados_historico (decisao_tabela, decisao_id, checkpoint);

-- Nível de permissão por tipo de ação de cada agente — pedido explícito do
-- usuário: "os agentes não devem ganhar autorização irrestrita... cada tipo
-- de ação deverá possuir sua própria permissão". NESTA ETAPA A TABELA É
-- INERTE: nenhum código lê `nivel_permissao` pra decidir executar nada
-- sozinho — toda ação continua 100% manual (aprovar/alterar/recusar pelos
-- mesmos botões que já existem). Ela só existe desde já pra você poder ver/
-- auditar o nível atual de cada tipo de ação, e pra uma fase futura de
-- autonomia não precisar inventar essa estrutura do zero. Semeada com todo
-- `tipo_acao` que os decisores já produzem hoje (ver lib/ia/adsDecisor.js e
-- lib/ia/promocoesDecisor.js), todos como 'approval_required' (ação
-- concreta e executável) ou 'recommend_only' (sugestão que não corresponde
-- a uma execução direta no Mercado Livre) — nunca 'auto_execute' nesta
-- etapa.
CREATE TABLE IF NOT EXISTS ia_permissoes_acao (
  id                SERIAL PRIMARY KEY,
  agente_codigo     VARCHAR(40) NOT NULL REFERENCES ia_agentes(codigo),
  tipo_acao         VARCHAR(40) NOT NULL,
  nivel_permissao   VARCHAR(20) NOT NULL DEFAULT 'approval_required', -- recommend_only|approval_required|auto_execute
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_permissoes_acao ON ia_permissoes_acao (agente_codigo, tipo_acao);
INSERT INTO ia_permissoes_acao (agente_codigo, tipo_acao, nivel_permissao) VALUES
  ('ads_performance', 'pausar_anuncio', 'approval_required'),
  ('ads_performance', 'colocar_sku_em_campanha', 'recommend_only'),
  ('ads_performance', 'pausar_campanha', 'approval_required'),
  ('ads_performance', 'diminuir_orcamento', 'approval_required'),
  ('ads_performance', 'ativar_campanha', 'approval_required'),
  ('ads_performance', 'aumentar_orcamento', 'approval_required'),
  ('promocoes', 'entrar_promocao', 'approval_required'),
  ('promocoes', 'nao_entrar_promocao', 'recommend_only'),
  ('promocoes', 'sair_promocao', 'approval_required'),
  ('promocoes', 'revisar_preco', 'approval_required')
ON CONFLICT (agente_codigo, tipo_acao) DO NOTHING;

-- Colunas aditivas em ia_decisoes_ads/ia_decisoes_promocoes — nenhuma coluna
-- existente é alterada. `reuniao_id` fica NULL para decisões geradas pelo
-- ciclo normal de sincronização (como hoje) e só é preenchido quando a
-- decisão nasce de uma Daily. `confianca_ia` fica propositalmente NULL até
-- existir um mecanismo real de cálculo baseado no histórico de decisões do
-- usuário — nunca um número fabricado só para preencher a tela.
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS reuniao_id INTEGER REFERENCES ia_reunioes_diarias(id);
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS confianca_ia NUMERIC(5,2);
ALTER TABLE ia_decisoes_promocoes ADD COLUMN IF NOT EXISTS reuniao_id INTEGER REFERENCES ia_reunioes_diarias(id);
ALTER TABLE ia_decisoes_promocoes ADD COLUMN IF NOT EXISTS confianca_ia NUMERIC(5,2);

-- ============================================================================
-- Agentes de SAC — Mercado Livre e Shopee (14/09/2026, pedido explícito do
-- usuário: "vem diretamente do mercado livre e shopee... vamos fazer com
-- todas as ia... por enquanto vai ser apenas leitura e analise... deve ter
-- um agente para shopee e outro para o mercado livre").
--
-- Dois agentes SEPARADOS (nunca um só "SAC" genérico) — mesmo catálogo
-- global `ia_agentes` já usado por ads_performance/promoções.
INSERT INTO ia_agentes (codigo, nome, descricao, icone, ordem) VALUES
  ('sac_mercado_livre', 'SAC Mercado Livre', 'Centraliza perguntas, mensagens pós-venda e reclamações do Mercado Livre, e sugere uma resposta pronta — você aprova, edita ou recusa. Só leitura e análise nesta fase: nada é enviado automaticamente.', 'inbox', 5),
  ('sac_shopee', 'SAC Shopee', 'Centraliza mensagens e devoluções da Shopee, e sugere uma resposta pronta — você aprova, edita ou recusa. Só leitura e análise nesta fase: nada é enviado automaticamente.', 'inbox', 6)
ON CONFLICT (codigo) DO NOTHING;

-- Identidade dos agentes "Anúncios" (Radar) e "Análise de Concorrente" pro
-- catálogo global de ia_agentes (19/09/2026, pedido explícito do usuário:
-- "quero que essas ia nunca pare de trabalhar... e quero que os
-- relatórios... me envie tudo no whatsapp") — precisam existir aqui pra
-- poder participar da Daily dos Agentes (ver lib/ia/especialistaAnuncios.js
-- e lib/ia/especialistaConcorrente.js, referenciados por
-- ia_achados_diarios.agente_codigo).
INSERT INTO ia_agentes (codigo, nome, descricao, icone, ordem) VALUES
  ('anuncios_radar', 'Anúncios', 'Acompanha o desempenho de cada anúncio no Mercado Livre (parado, venda baixa, prejuízo, crescimento) e aponta o que precisa de atenção — só observa e recomenda, nunca altera nada sozinho.', 'megaphone', 7),
  ('concorrente', 'Análise de Concorrente', 'Busca automaticamente, todo dia, quem mais está vendendo os mesmos produtos que você no Mercado Livre — preço, estoque e nível de confiança de cada achado. Só observa e recomenda, nunca altera preço sozinho.', 'search', 8)
ON CONFLICT (codigo) DO NOTHING;

-- Um atendimento real (pergunta pré-venda, mensagem pós-venda, reclamação ou
-- devolução) por linha — SEMPRE por empresa (mesmo isolamento de
-- ia_decisoes_ads/promocoes). Uma situação em aberto mantém UMA linha só
-- (upsert pela chave natural abaixo, nunca duplica a cada ciclo de
-- sincronização) — a mesma ideia de "situação" já usada em ia_decisoes_ads,
-- só que aqui a "situação" é a conversa/pergunta/caso em si, identificada
-- pelo id que o próprio marketplace usa (question_id/pack_id/claim_id/
-- return_sn, conforme `tipo_origem`).
-- `conta_id` aponta pra ml_contas.id OU shopee_contas.id conforme
-- `marketplace` — sem FK direta de propósito (são tabelas diferentes por
-- marketplace; a integridade real é garantida pelo código, nunca pelo
-- banco, mesmo caso de `decisao_tabela`/`decisao_id` em
-- ia_achados_diarios/ia_decisoes_resultados_historico acima).
CREATE TABLE IF NOT EXISTS sac_atendimentos (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id),
  marketplace           VARCHAR(20) NOT NULL CHECK (marketplace IN ('mercado_livre', 'shopee')),
  conta_id              INTEGER NOT NULL,
  tipo_origem           VARCHAR(20) NOT NULL CHECK (tipo_origem IN ('pergunta', 'mensagem', 'reclamacao', 'devolucao')),
  id_externo            VARCHAR(80) NOT NULL, -- question_id | pack_id | claim_id | return_sn
  pedido_ref            VARCHAR(60),          -- ml_order_id ou order_sn, quando existir (pergunta pré-venda não tem pedido)
  sku                   VARCHAR(120),
  produto_titulo        TEXT,
  cliente_nome          VARCHAR(200),
  cliente_id_externo    VARCHAR(60),
  mensagem_cliente      TEXT NOT NULL,        -- mensagem mais recente do cliente (o histórico completo fica em raw_atendimento)
  data_recebido         TIMESTAMPTZ NOT NULL, -- data/hora real da mensagem mais recente (nunca a data da sincronização)
  status                VARCHAR(20) NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'aguardando_resposta', 'respondido', 'resolvido')),
  classificacao         VARCHAR(20) CHECK (classificacao IN ('duvida_simples', 'info_pedido', 'problema_entrega', 'reclamacao', 'insatisfeito', 'devolucao')),
  urgente               BOOLEAN NOT NULL DEFAULT false,
  raw_atendimento       JSONB,                -- payload bruto (histórico completo da conversa, quando aplicável) — auditoria, mesmo padrão de raw_pedido
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, marketplace, tipo_origem, id_externo)
);
CREATE INDEX IF NOT EXISTS idx_sac_atendimentos_empresa ON sac_atendimentos(empresa_id, marketplace, status);

-- Sugestão da IA + decisão do usuário pra cada atendimento — mesmo padrão de
-- aprendizado de ia_decisoes_ads/promocoes: `resposta_sugerida_ia` é o que a
-- IA escreveu, `resposta_final` é o que o usuário realmente decidiu
-- (idêntica à sugestão quando aprovada sem mudar nada, diferente quando
-- editada), e é esse par que serve de aprendizado futuro. `enviado` fica
-- SEMPRE false nesta fase — pedido explícito do usuário em 14/09/2026
-- ("por enquanto vai ser apenas leitura e analise"): nenhuma resposta é
-- transmitida ao Mercado Livre/Shopee, aprovar aqui só REGISTRA a decisão
-- (mesma ressalva já usada em ia_decisoes_ads/promocoes: "executado" nunca
-- vira true nesta fase). Índice único parcial garante só uma sugestão
-- PENDENTE por atendimento por vez — assim que decidida, uma reabertura do
-- mesmo atendimento (nova mensagem do cliente) cria uma linha nova,
-- preservando a decisão anterior como histórico definitivo.
CREATE TABLE IF NOT EXISTS sac_respostas (
  id                     SERIAL PRIMARY KEY,
  atendimento_id         INTEGER NOT NULL REFERENCES sac_atendimentos(id) ON DELETE CASCADE,
  resposta_sugerida_ia   TEXT,          -- NULL quando a IA não conseguiu gerar (ver motivo_sem_sugestao) — nunca um texto fabricado no lugar
  motivo_sem_sugestao    TEXT,
  resposta_final         TEXT,
  status_decisao         VARCHAR(20) NOT NULL DEFAULT 'pendente' CHECK (status_decisao IN ('pendente', 'aprovada', 'editada', 'recusada')),
  decidido_em            TIMESTAMPTZ,
  decidido_por           VARCHAR(180),
  enviado                BOOLEAN NOT NULL DEFAULT false,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sac_respostas_atendimento ON sac_respostas(atendimento_id, status_decisao);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sac_respostas_pendente ON sac_respostas(atendimento_id) WHERE status_decisao = 'pendente';

-- Registro dos agentes de SAC em ia_permissoes_acao (tabela já existente,
-- ainda INERTE — nenhum código lê nivel_permissao pra executar nada
-- sozinho, ver comentário completo acima). `responder_atendimento` é a
-- única ação que os agentes de SAC produzem — enviar a resposta ao
-- marketplace — sempre 'approval_required' nesta fase.
INSERT INTO ia_permissoes_acao (agente_codigo, tipo_acao, nivel_permissao) VALUES
  ('sac_mercado_livre', 'responder_atendimento', 'approval_required'),
  ('sac_shopee', 'responder_atendimento', 'approval_required')
ON CONFLICT (agente_codigo, tipo_acao) DO NOTHING;

-- "Margem de conforto" da IA de Promoções — 15/09/2026, pedido explícito do
-- usuário: "voce deve me trazer promoções do mesmo valor com uma margem
-- igual ou valores abaixo com uma margem um pouco menor mas respeitando a
-- margem minima". Antes, QUALQUER promoção com margem acima de
-- margem_minima_pct (mesmo raspando o mínimo) era recomendada igual a uma
-- sem desconto nenhum. Com este campo > 0, uma promoção com DESCONTO real
-- (preço abaixo do normal) só é recomendada se a margem ficar acima de
-- margem_minima_pct + margem_conforto_pct — uma exigência extra só pra
-- quando a margem está sendo sacrificada por um desconto. Promoção no preço
-- normal (sem desconto, margem igual à normal) continua exigindo só o
-- mínimo, porque não há margem sendo sacrificada. Nasce em 0 (desligado —
-- comportamento igual ao de antes) até o usuário configurar um valor na
-- tela (ver routes/promocoes.js e lib/promocoesMotor.js#classificar).
ALTER TABLE config_promocoes ADD COLUMN IF NOT EXISTS margem_conforto_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

-- Registra, em cada análise gravada, qual margem de conforto foi usada
-- (mesmo espírito de margem_minima_pct_usada logo acima) — pra nunca
-- esconder do usuário por que um item foi classificado NÃO RECOMENDADO
-- mesmo com margem acima do mínimo puro (ver lib/promocoesMotor.js).
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS margem_conforto_pct_usada NUMERIC(5,2);
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS tem_desconto BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- Ads e Performance — "Fase E" ativada (19/09/2026, pedido explícito do
-- usuário: "eu vou aprovar, aí vai fazer... por enquanto só vai precisar
-- da minha permissão" — quer que aprovar uma sugestão de Ads já execute de
-- verdade no Mercado Livre, não só registre a aprovação como acontecia até
-- aqui). Mesmo desenho já usado por config_promocoes.permite_escrita_ml/
-- lib/mlPermissoes.js (trava manual, nasce desligada, só o usuário liga
-- depois de liberar escrita no painel do Mercado Livre Developers e
-- reconectar a conta) — nada aqui muda o comportamento de Promoções, que
-- continua 100% "Fase 1" (só registra a decisão) até uma etapa futura.
ALTER TABLE config_ads_ia ADD COLUMN IF NOT EXISTS permite_escrita_ml BOOLEAN NOT NULL DEFAULT false;

-- `executado`/`executado_em` já existiam nesta tabela desde 14/09/2026 mas
-- NUNCA foram preenchidos por nenhum código (a intenção original era
-- diferente — o usuário confirmar manualmente que fez a mudança ele mesmo
-- no Mercado Livre — e isso nunca chegou a ganhar tela). A partir de agora
-- passam a ter o significado real e mais útil: `executado = true` quando
-- ESTE ERP aplicou a ação de verdade via API (ver lib/ia/adsExecutor.js).
-- `execucao_erro` guarda a explicação legível de por que uma decisão
-- aprovada ainda não foi (ou não pôde ser) aplicada — permissão de escrita
-- desligada, token sem validade, erro real devolvido pelo Mercado Livre, ou
-- tipo de ação que ainda não tem execução direta (ex.: pausar_anuncio,
-- colocar_sku_em_campanha) — nunca fica em branco sem explicação nenhuma.
-- `execucao_resposta` guarda o corpo real devolvido pela API em caso de
-- sucesso, só para auditoria (nunca é o que decide o que mostrar pro
-- usuário — quem decide é `executado`).
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS execucao_erro TEXT;
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS execucao_resposta JSONB;

-- ============================================================
-- Promoções — "margem normal do produto" (20/09/2026)
-- ============================================================
-- Pedido explícito do usuário: "só me avisar de promoções quando for
-- vender em um preço igual ou menor com a mesma margem ou uma margem até
-- 3% menor, pois se eu vender com preço maior minha margem é maior mesmo".
-- Ver lib/promocoesMotor.js#TOLERANCIA_QUEDA_MARGEM_NORMAL_PCT — a IA de
-- Promoções passa a comparar a margem no preço promocional com a margem
-- NORMAL do mesmo produto (preço cheio), e só recomenda ENTRAR quando essa
-- queda for de no máximo 3 pontos percentuais (além de continuar exigindo
-- o mínimo/conforto configurados, que não mudaram). `margem_normal_pct`
-- guarda esse número calculado (nunca fabricado — mesma estimativa de
-- comissão/frete do histórico real do SKU, só aplicada ao preço normal em
-- vez do promocional) para poder ser exibido/conferido na tela.
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS margem_normal_pct NUMERIC(6,2);
ALTER TABLE ia_decisoes_promocoes ADD COLUMN IF NOT EXISTS snapshot_margem_normal_pct NUMERIC(6,2);

-- ============================================================
-- Correção de bug real — alertas de Concorrente se autodestruindo
-- (20/09/2026, usuário reportou "Análise de concorrente não está
-- funcionando")
-- ============================================================
-- Causa raiz encontrada nos logs de produção (Render): `persistirSituacoes`
-- (lib/ia/radar.js) resolve automaticamente todo alerta 'aberto' que não
-- apareceu na lista de situações do ciclo atual — pensado pra "se o
-- problema já não existe mais, fecha sozinho". Mas essa função é chamada
-- separadamente pelo Radar principal (a cada 15min, só com alertas de
-- anúncio/negócio) E pelo ciclo de Concorrente (1x/dia, só com alertas
-- 'concorrente_ativo') — como cada chamada só conhece a SUA PRÓPRIA lista,
-- o Radar principal, rodando 15 minutos depois, sempre enxergava o alerta
-- de concorrente como "não detectado" e o resolvia sozinho, mesmo com o
-- concorrente ainda ativo. Efeito colateral: as duas transações rodando ao
-- mesmo tempo, cada uma fazendo UPDATE em massa na mesma tabela, geravam de
-- vez em quando um "deadlock detected" no Postgres (também visto nos
-- logs). `origem_ciclo` marca de qual ciclo cada alerta
-- veio, e o "resolve automaticamente" (ver lib/ia/radar.js#persistirSituacoes)
-- passa a só considerar alertas DA MESMA origem — corrige os dois problemas
-- de uma vez, sem precisar listar categorias manualmente em lugar nenhum.
ALTER TABLE radar_alertas ADD COLUMN IF NOT EXISTS origem_ciclo VARCHAR(40) NOT NULL DEFAULT 'radar_principal';

-- ============================================================
-- Promoções — "estoque alto" avisa o usuário (20/09/2026)
-- ============================================================
-- Pedido explícito do usuário: "sobre, meu estoque daquele produto estiver
-- alto, quero que me avise". Perguntado de volta como definir "alto" —
-- escolheu PELOS DIAS QUE O ESTOQUE DURA no ritmo real de vendas (nunca
-- uma quantidade fixa em unidades, que seria enganosa entre produtos com
-- ritmos de venda bem diferentes). `dias_cobertura_alta` é o limite (em
-- dias) configurável por empresa, mesmo padrão de `margem_minima_pct` —
-- 60 dias por padrão, o usuário pode pedir pra ajustar quando quiser. Ver
-- lib/promocoesMotor.js#calcularCoberturaEstoque.
ALTER TABLE config_promocoes ADD COLUMN IF NOT EXISTS dias_cobertura_alta INTEGER NOT NULL DEFAULT 60;

-- `estoque_atual` vem de `ml_estoque_itens` (MESMA fonte real da tela
-- Estoque — nunca uma segunda sincronização), somado por SKU no momento da
-- análise. `vendas_unidades_90d` é a soma real de unidades vendidas desse
-- SKU nos últimos 90 dias (lib/relatorioVendas.js, mesma fonte de sempre).
-- `cobertura_dias_estoque` = estoque_atual ÷ (vendas_unidades_90d ÷ 90) —
-- nunca calculado quando não há venda no período (fica NULL; "estoque
-- alto sem nenhuma venda" ainda é sinalizado por `estoque_alto`, só sem um
-- número de dias exato). `estoque_alto` é o sinal booleano pronto pra
-- tela/alerta usar direto, sem recalcular nada no front-end.
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS estoque_atual INTEGER;
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS vendas_unidades_90d INTEGER;
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS cobertura_dias_estoque NUMERIC(8,1);
ALTER TABLE promocoes_analises ADD COLUMN IF NOT EXISTS estoque_alto BOOLEAN NOT NULL DEFAULT false;

-- Mesmos 3 campos, como snapshot no momento da sugestão (mesmo padrão de
-- snapshot_margem_normal_pct acima) — pra auditoria: o que o estoque
-- estava quando a IA sugeriu, mesmo que tenha mudado depois.
ALTER TABLE ia_decisoes_promocoes ADD COLUMN IF NOT EXISTS snapshot_estoque_atual INTEGER;
ALTER TABLE ia_decisoes_promocoes ADD COLUMN IF NOT EXISTS snapshot_cobertura_dias_estoque NUMERIC(8,1);
ALTER TABLE ia_decisoes_promocoes ADD COLUMN IF NOT EXISTS snapshot_estoque_alto BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- Concorrente cadastrado manualmente por SKU (20/09/2026)
-- ============================================================
-- Pedido explícito do usuário, depois de confirmado por teste real dele
-- (link de teste devolveu 403 tanto autenticado quanto sem login — ver
-- lib/concorrente.js#testarListagemPorVendedor e o comentário grande ali)
-- que a API do Mercado Livre bloqueia a descoberta automática de
-- concorrente: perguntado como resolver, respondeu "sobre o concorrente eu
-- vou mandar o link do anuncio do concorrente para ficar mais facil" — ou
-- seja, ELE cola o link manualmente por produto, e o sistema guarda isso
-- pra usar depois (hoje: alimentar o Agente Coordenador da Daily, ver
-- ia_correlacoes_diarias acima — regra R4 em lib/ia/coordenadorDiario.js).
-- Nunca tenta validar/buscar o link automaticamente nesta tabela — é só o
-- cadastro; a tela mostra o link pro usuário abrir e comparar preço ele
-- mesmo, honestamente, já que a checagem automática está bloqueada pela
-- API. `sku` é texto livre (não FK pra produtos.sku) pelo mesmo motivo de
-- outras tabelas deste arquivo (ia_achados_diarios.sku etc.) — permite
-- cadastrar um concorrente mesmo pra um SKU que ainda não tem produto
-- formalmente cadastrado. `ativo` permite "arquivar" sem apagar o
-- histórico (mesmo padrão de produtos.ativo).
CREATE TABLE IF NOT EXISTS concorrentes_monitorados (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  sku            VARCHAR(100) NOT NULL,
  url            TEXT NOT NULL,
  apelido        VARCHAR(120), -- nome livre pro usuário identificar o concorrente na lista (opcional)
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, sku, url)
);
CREATE INDEX IF NOT EXISTS idx_concorrentes_monitorados_empresa_sku ON concorrentes_monitorados (empresa_id, sku) WHERE ativo = TRUE;

-- Coluna aditiva em ia_correlacoes_diarias (20/09/2026) — todas as 4 regras
-- do Agente Coordenador (lib/ia/coordenadorDiario.js) são cruzamentos
-- ancorados num SKU específico; guardar isso direto na correlação evita a
-- tela "Plano de Ação do Dia" (Etapa 5) ter que voltar em
-- ia_achados_diarios só pra saber de qual produto cada conclusão fala.
ALTER TABLE ia_correlacoes_diarias ADD COLUMN IF NOT EXISTS sku VARCHAR(120);

-- ============================================================
-- Radar de Concorrentes (21/09/2026)
-- ============================================================
-- Pedido explícito do usuário, com um mockup de referência
-- (pf_radar_concorrentes_v2.html): cadastrar um concorrente por nome +
-- link do anúncio + SKU + marketplace, e o sistema passar a MONITORAR
-- sozinho preço, promoção, foto de capa, título, frete e outras mudanças
-- desse anúncio específico, guardando histórico e gerando alertas.
--
-- Isso é DIFERENTE das duas coisas que já existiam antes desta tabela
-- (nenhuma das duas foi alterada por esta funcionalidade):
--   1) concorrentes_monitorados (ver comentário grande acima): só guarda o
--      link, nunca busca nada automaticamente — porque a busca automática
--      POR TÍTULO/POR VENDEDOR (descoberta de quem são os concorrentes) é
--      bloqueada pela API do Mercado Livre (403, testado de verdade nesse
--      dia — ver lib/concorrente.js#testarListagemPorVendedor).
--   2) lib/ia/radarConcorrente.js: compara preço (só preço) contra OUTROS
--      vendedores do MESMO produto, descobertos automaticamente a cada
--      ciclo — sem guardar histórico nem acompanhar um anúncio específico.
-- Este Radar de Concorrentes é diferente dos dois: o usuário informa o
-- LINK EXATO de UM anúncio específico que ele já escolheu (não é busca/
-- descoberta) — e para isso o Mercado Livre confirma que funciona: buscar
-- um item PELO ID (GET /items/{id}) é uma chamada pública, já usada em
-- produção neste mesmo arquivo de teste (testarListagemPorVendedor,
-- comentário: "GET /items/{item_id}... Este endpoint já é usado em
-- produção"). Por isso o monitoramento automático aqui é honesto e real
-- só para Mercado Livre — Shopee e TikTok Shop entram no cadastro (o
-- formulário do mockup oferece as 3 opções), mas ficam marcados como
-- "sem monitoramento automático" (radar_concorrentes.monitoramento_automatico
-- = FALSE) porque não existe, neste sistema, nenhuma chamada pública
-- equivalente pra essas duas plataformas — nunca finge que buscou um dado
-- que não buscou de verdade.
--
-- `sku` é texto livre (mesmo padrão de concorrentes_monitorados/
-- ia_achados_diarios.sku) — não é FK pra produtos.sku.
CREATE TABLE IF NOT EXISTS radar_concorrentes (
  id                          SERIAL PRIMARY KEY,
  empresa_id                  INTEGER NOT NULL REFERENCES empresas(id),
  sku                         VARCHAR(100) NOT NULL,
  nome_concorrente            VARCHAR(120) NOT NULL,
  marketplace                 VARCHAR(30) NOT NULL, -- 'mercado_livre' | 'shopee' | 'tiktok_shop'
  link_anuncio                TEXT NOT NULL,
  ml_item_id                  VARCHAR(20), -- só quando marketplace='mercado_livre' e o link trouxer um MLB reconhecível
  monitoramento_automatico    BOOLEAN NOT NULL DEFAULT FALSE, -- true só quando ml_item_id foi reconhecido (ver comentário acima)
  ativo                       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_concorrentes_empresa ON radar_concorrentes (empresa_id) WHERE ativo = TRUE;

-- Uma linha por leitura (snapshot) do anúncio monitorado — é o histórico
-- pedido pelo usuário ("salvando histórico"). `ok=false` guarda o motivo
-- real do erro quando a consulta ao Mercado Livre falhar (nunca inventa um
-- valor quando a busca não funcionou). `vendidos_total` é o campo real
-- `sold_quantity` que a API pública do Mercado Livre devolve (contagem
-- acumulada, aproximada — o próprio Mercado Livre arredonda esse número, é
-- limitação da API, não desta implementação). `vendas_dia_estimado` NUNCA
-- vem da API — é calculado por este sistema comparando a leitura atual com
-- a leitura anterior bem-sucedida do MESMO anúncio (diferença de
-- vendidos_total ÷ dias entre as duas leituras); por isso fica NULL na
-- primeira leitura (ainda não tem uma leitura anterior pra comparar) — é
-- exatamente a mesma estimativa que o mockup do usuário já previa
-- ("* Vendas/dia deve ser tratado como estimativa quando o dado exato do
-- concorrente não estiver disponível pela API").
CREATE TABLE IF NOT EXISTS radar_concorrentes_leituras (
  id                     SERIAL PRIMARY KEY,
  radar_concorrente_id   INTEGER NOT NULL REFERENCES radar_concorrentes(id),
  lido_em                TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok                     BOOLEAN NOT NULL,
  erro                   TEXT,
  titulo                 TEXT,
  preco                  NUMERIC(12,2),
  preco_original         NUMERIC(12,2), -- item.original_price (quando presente = está em promoção)
  em_promocao            BOOLEAN,
  imagem_url             TEXT,
  status_anuncio         VARCHAR(30), -- item.status (active/paused/closed) da API do ML
  frete_tipo             VARCHAR(60), -- item.shipping.logistic_type
  frete_gratis           BOOLEAN,     -- item.shipping.free_shipping
  vendidos_total         INTEGER,     -- item.sold_quantity (real, acumulado, aproximado pelo ML)
  vendas_dia_estimado    NUMERIC(10,2) -- calculado por este sistema (ver comentário acima), nunca vindo direto da API
);
CREATE INDEX IF NOT EXISTS idx_radar_concorrentes_leituras_concorrente ON radar_concorrentes_leituras (radar_concorrente_id, lido_em DESC);

-- Um alerta por mudança real detectada entre duas leituras consecutivas
-- bem-sucedidas do mesmo anúncio (preço, promoção, foto, título, frete ou
-- status) — é o "gerando alertas" pedido pelo usuário. Fica de fora da
-- Central de Alertas existente (radar_alertas/persistirSituacoes) de
-- propósito: o mockup já tem seu próprio painel "Alertas prioritários"
-- dentro da tela do Radar de Concorrentes, e manter esta tabela separada
-- evita qualquer risco de mexer no pipeline de alertas que já existe hoje.
CREATE TABLE IF NOT EXISTS radar_concorrentes_alertas (
  id                     SERIAL PRIMARY KEY,
  radar_concorrente_id   INTEGER NOT NULL REFERENCES radar_concorrentes(id),
  leitura_id             INTEGER REFERENCES radar_concorrentes_leituras(id),
  tipo                   VARCHAR(30) NOT NULL, -- 'preco' | 'promocao' | 'foto' | 'titulo' | 'frete' | 'status' | 'vendas'
  severidade             VARCHAR(20) NOT NULL, -- 'critico' | 'atencao' | 'informativo' | 'oportunidade'
  mensagem               TEXT NOT NULL,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_concorrentes_alertas_empresa ON radar_concorrentes_alertas (radar_concorrente_id, criado_em DESC);

-- Diagnóstico completo por anúncio — Agente IA "Ads e Performance",
-- 21/09/2026, pedido explícito do usuário: "quero que a IA me dê relatórios
-- como esse... diagnosticando 100% daquele anúncio de ads e não só pedindo
-- pra pausar". Ver lib/ia/adsDiagnostico.js: `relatorio_diagnostico_texto`
-- é o relatório 100% determinístico (tabela de métricas + interpretações +
-- teste de monitoramento, todos calculados em cima de números reais já
-- usados pela tela de Ads); `relatorio_diagnostico_ia` é a MESMA informação
-- reescrita em prosa mais natural pelo provedor de IA generativa configurado
-- (pode ficar NULL quando a IA não está configurada/falhou — o texto
-- determinístico acima nunca fica nulo nesse caso, o recurso não depende da
-- IA generativa pra existir). Gerado só na CRIAÇÃO de uma decisão nova (não
-- a cada ciclo de sincronização, pra não gastar crédito de IA repetindo o
-- mesmo relatório enquanto a mesma situação continuar pendente).
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS relatorio_diagnostico_texto TEXT;
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS relatorio_diagnostico_ia TEXT;
ALTER TABLE ia_decisoes_ads ADD COLUMN IF NOT EXISTS relatorio_diagnostico_gerado_em TIMESTAMPTZ;

-- ============================================================================
-- Compras com IA — 22/09/2026, pedido explícito do usuário: substituir a
-- aba "Compras" (CRUD simples, `compras`/`compra_itens`, ligado a
-- `produtos` — CONTINUA existindo e funcionando exatamente como hoje, só
-- perde a tela própria no menu, já que nenhuma rota nem tabela antiga foi
-- tocada) por uma "Central Inteligente de Reposição de Estoque": a IA
-- analisa cada MODELO FÍSICO (produto_base — reaproveita a estrutura já
-- existente de `produtos_base`/`produto_base_skus`, nunca uma segunda forma
-- de agrupar SKUs), sugere quanto comprar e de quem, o usuário aprova (ou
-- ajusta, ou ignora) e só então vira um pedido de compra pronto pra enviar.
--
-- Decisão importante: como o pedido de compra aqui é por PRODUTO BASE
-- (físico) e o `compras`/`compra_itens` antigo é por `produtos` (SKU/kit
-- simples, sem ligação nenhuma com produto_base), criar um pedido novo por
-- aprovação de recomendação usa tabelas PRÓPRIAS (`compras_ia_pedidos`),
-- em vez de tentar encaixar no modelo antigo — evita gambiarra de
-- conversão e, principalmente, evita qualquer risco de quebrar o `compras`
-- antigo (ainda usado por lib/compras.js#resumoComprasPorFornecedor, hoje
-- consumido pela IA Gestora). Ver docs/02-decisoes.md.

-- Dado novo em fornecedores: prazo médio de entrega, em dias corridos —
-- opcional (fica NULL até o usuário informar); sem esse número a IA não
-- calcula ponto de recompra nem quantidade recomendada pra produtos ligados
-- a esse fornecedor (nunca inventa um prazo).
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS prazo_entrega_dias INTEGER;

-- Dados novos em produtos_base: qual fornecedor abastece esse modelo por
-- padrão (pra já vir sugerido ao montar o pedido) e quantos dias de venda
-- projetada o usuário quer manter como estoque de segurança pra ESTE
-- modelo específico (NULL = usa o padrão global do motor, ver
-- lib/ia/comprasMotor.js#ESTOQUE_SEGURANCA_DIAS_PADRAO).
ALTER TABLE produtos_base ADD COLUMN IF NOT EXISTS fornecedor_padrao_id INTEGER REFERENCES fornecedores(id);
ALTER TABLE produtos_base ADD COLUMN IF NOT EXISTS estoque_seguranca_dias INTEGER;

-- Uma recomendação de compra por produto base, gerada pelo ciclo automático
-- (lib/ia/comprasCiclo.js) — mesmo padrão de `ia_decisoes_ads`/
-- `ia_decisoes_promocoes`: todo número em `snapshot_*` é o dado REAL que
-- gerou a recomendação (nunca só o resultado final sem explicação), e o
-- índice único abaixo garante no máximo 1 recomendação PENDENTE por produto
-- base (uma nova leitura do ciclo atualiza a mesma linha pendente em vez de
-- duplicar — ver upsertDecisaoCompra).
CREATE TABLE IF NOT EXISTS ia_decisoes_compras (
  id                                SERIAL PRIMARY KEY,
  empresa_id                        INTEGER NOT NULL REFERENCES empresas(id),
  produto_base_id                   INTEGER NOT NULL REFERENCES produtos_base(id),
  produto_base_codigo               VARCHAR(100) NOT NULL,
  tipo_acao                         VARCHAR(30) NOT NULL DEFAULT 'comprar_estoque',
  status_urgencia                   VARCHAR(20) NOT NULL, -- saudavel|atencao|programar|comprar_agora|ruptura|a_caminho
  motivo                            TEXT NOT NULL,
  snapshot_estoque_galpao           NUMERIC(14,2),
  snapshot_estoque_full             NUMERIC(14,2),
  snapshot_estoque_a_caminho        NUMERIC(14,2),
  snapshot_venda_7d                 NUMERIC(14,2),
  snapshot_venda_14d                NUMERIC(14,2),
  snapshot_venda_30d                NUMERIC(14,2),
  snapshot_media_dia_projetada      NUMERIC(14,4),
  snapshot_acelerando               BOOLEAN,
  snapshot_dias_cobertura           NUMERIC(8,2),
  snapshot_data_ruptura_prevista    DATE,
  snapshot_prazo_fornecedor_dias    INTEGER,
  snapshot_estoque_seguranca_dias   INTEGER,
  snapshot_custo_unitario           NUMERIC(12,2),
  quantidade_sugerida_ia            NUMERIC(14,2) NOT NULL,
  valor_estimado_ia                 NUMERIC(14,2),
  fornecedor_sugerido_id            INTEGER REFERENCES fornecedores(id),
  quantidade_decidida               NUMERIC(14,2),
  status_decisao                    VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente|aprovada|alterada|ignorada|expirada
  decidido_em                       TIMESTAMPTZ,
  decidido_por                      VARCHAR(180),
  relatorio_diagnostico_texto       TEXT,
  relatorio_diagnostico_ia          TEXT,
  relatorio_diagnostico_gerado_em   TIMESTAMPTZ,
  criado_em                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_decisoes_compras_empresa ON ia_decisoes_compras (empresa_id, status_decisao);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_decisoes_compras_pendente
  ON ia_decisoes_compras (empresa_id, produto_base_id, tipo_acao)
  WHERE status_decisao = 'pendente';

-- Numeração sequencial dos pedidos gerados por esta tela (formato PC-000245,
-- ver lib/ia/comprasCiclo.js#gerarNumeroPedido) — sequência própria, nunca
-- reaproveita o id de `compras` (tabela antiga, numeração diferente).
CREATE SEQUENCE IF NOT EXISTS compras_ia_pedido_numero_seq START 1;

-- Pedido de compra gerado a partir de uma recomendação aprovada (ou criado
-- manualmente, `origem='manual'`, pra cobrir o caso de o usuário querer
-- registrar uma compra que a IA não recomendou). "quantidade"/"custo_unitario"
-- podem ter sido AJUSTADOS pelo usuário na aprovação — sempre o valor real
-- do pedido, nunca reconsultado de `ia_decisoes_compras` depois de criado
-- (mesmo espírito de `compras.valor_total`: sempre recalculado no servidor
-- a partir do que foi realmente decidido, nunca um número solto do
-- front-end). Status usa o vocabulário pedido pelo usuário.
CREATE TABLE IF NOT EXISTS compras_ia_pedidos (
  id                   SERIAL PRIMARY KEY,
  empresa_id           INTEGER NOT NULL REFERENCES empresas(id),
  numero_pedido        VARCHAR(20) NOT NULL UNIQUE,
  fornecedor_id        INTEGER NOT NULL REFERENCES fornecedores(id),
  produto_base_id      INTEGER NOT NULL REFERENCES produtos_base(id),
  recomendacao_id      INTEGER REFERENCES ia_decisoes_compras(id),
  origem               VARCHAR(20) NOT NULL DEFAULT 'recomendacao_ia', -- recomendacao_ia|manual
  quantidade           NUMERIC(14,2) NOT NULL,
  custo_unitario       NUMERIC(12,2) NOT NULL,
  valor_total          NUMERIC(14,2) NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'aprovado', -- aprovado|pedido_enviado|em_producao|a_caminho|recebido|cancelado
  previsao_chegada     DATE,
  recebido_em          TIMESTAMPTZ,
  observacao           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compras_ia_pedidos_empresa ON compras_ia_pedidos (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_compras_ia_pedidos_produto_base ON compras_ia_pedidos (produto_base_id, status);

-- ============================================================
-- Etapa: Venda de Balcão / "Calculadora de Vendas" (22/09/2026)
-- ============================================================
-- Pedido explícito do usuário: "quero colocar agora uma calculadora de
-- vendas pra eu vende[r] para o cliente final que vem até a minha
-- empresa... porque todas as vendas que eu faço pro fora eu nao coloco no
-- faturamento sei que isso é errado mas quero arrumar" — vendas
-- presenciais/balcão, pagas na hora (dinheiro/pix/cartão), feitas fora do
-- Mercado Livre/Shopee, que até aqui não entravam em NENHUM número do
-- sistema. Respostas do usuário às perguntas de escopo (todas a opção
-- recomendada): 1) contam em TODO o sistema — Visão Geral/DRE/Relatórios/
-- Faturamento, não só uma tela isolada; 2) baixam do estoque mostrado
-- (ver lib/estoqueFisico.js); 3) produto sempre escolhido do catálogo já
-- cadastrado (produtos.sku), pra aproveitar o mesmo custo já usado nas
-- vendas do Mercado Livre/Shopee; 4) sempre pago na hora (sem fiado/contas
-- a receber).
--
-- 'balcao' vira o 3º canal em lib/relatorioVendas.js — MESMO padrão já
-- usado pra unir a Shopee ao Mercado Livre em 14/09/2026 (SQL_UNIAO_PEDIDOS
-- vira uma união de 3, não 2) — por isso as colunas abaixo já nascem
-- pensadas pra alimentar aquele UNION ALL sem gambiarra nenhuma: preço e
-- quantidade por item são DIGITADOS pelo usuário na hora da venda (não
-- existe "preço de venda" cadastrado em produtos — só custo, ver
-- comentário na tabela `produtos` acima), e o custo unitário é CONGELADO
-- no momento da venda (mesma regra já usada pros itens de pedido do
-- Mercado Livre/Shopee: o custo pode mudar depois em Produtos sem
-- reescrever o resultado de uma venda já feita).
--
-- Nunca é apagada de verdade (mesmo padrão "expira/cancela, nunca apaga"
-- já usado no resto do sistema) — uma venda cancelada vira status
-- 'cancelada' e some do faturamento/margem (mesma regra de pedido
-- cancelado do Mercado Livre/Shopee), mas a linha continua no banco.
CREATE SEQUENCE IF NOT EXISTS vendas_balcao_numero_seq START 1;

CREATE TABLE IF NOT EXISTS vendas_balcao (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id),
  numero_venda          INTEGER NOT NULL,
  cliente_nome          VARCHAR(200),
  forma_pagamento       VARCHAR(20) NOT NULL, -- dinheiro | pix | debito | credito | outro
  desconto              NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_total           NUMERIC(12,2) NOT NULL,
  -- Regra "nunca inventar" de sempre: NULL só quando algum item da venda
  -- não tinha custo cadastrado no momento (produtos.custo é NOT NULL, então
  -- isso só aconteceria se o produto fosse excluído do catálogo entre o
  -- momento de escolher e o de salvar — condição de corrida rara, mas
  -- tratada, nunca um custo 0 fingido).
  custo_produto_total   NUMERIC(12,2),
  observacao            TEXT,
  status                VARCHAR(20) NOT NULL DEFAULT 'concluida', -- concluida | cancelada
  data_venda            TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelado_em          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, numero_venda)
);
CREATE INDEX IF NOT EXISTS idx_vendas_balcao_empresa_data ON vendas_balcao (empresa_id, data_venda);

-- Itens da venda — mesmo espírito de ml_pedido_itens/shopee_pedido_itens:
-- guarda o SKU como TEXTO (não uma FK pra produtos), pra manter o
-- histórico de uma venda já feita mesmo que o cadastro do produto mude ou
-- seja desativado depois — nunca uma segunda regra de vínculo.
CREATE TABLE IF NOT EXISTS vendas_balcao_itens (
  id                     SERIAL PRIMARY KEY,
  venda_id               INTEGER NOT NULL REFERENCES vendas_balcao(id) ON DELETE CASCADE,
  sku                    VARCHAR(100) NOT NULL,
  titulo                 VARCHAR(200) NOT NULL,
  quantidade             NUMERIC(12,3) NOT NULL,
  preco_unitario_venda   NUMERIC(12,2) NOT NULL,
  custo_unitario         NUMERIC(12,2), -- congelado de produtos.custo no momento da venda
  valor_total_item       NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendas_balcao_itens_venda ON vendas_balcao_itens (venda_id);

-- CORREÇÃO (22/09/2026, mesma etapa acima): `faturamento_pedidos` e
-- `notas_fiscais` tinham `pedido_id UNIQUE REFERENCES ml_pedidos(id)` — bug
-- pré-existente nunca notado até aqui porque a tela Faturamento só continha
-- pedidos do Mercado Livre até 14/09/2026 (quando a Shopee se uniu na mesma
-- tela, ver lib/relatorioVendas.js). Como ml_pedidos.id e shopee_pedidos.id
-- são sequências SERIAL INDEPENDENTES, um pedido da Shopee podia colidir
-- com o id de um pedido do Mercado Livre: na melhor das hipóteses a
-- atualização de situação falhava (violação de FK contra ml_pedidos), na
-- pior confirmava/alterava a situação de um pedido ERRADO do Mercado Livre
-- que só por coincidência tinha o mesmo id. Isso ia se repetir com o 3º
-- canal (Venda de Balcão, acima) se não fosse corrigido agora.
--
-- Correção: cada linha passa a se identificar por (pedido_id, marketplace)
-- — o MESMO par já usado no `detailKey` de lib/relatorioVendas.js
-- ("mercado_livre:123"/"shopee:57"/"balcao:9") — em vez de pedido_id
-- sozinho. A FK direta pra ml_pedidos(id) sai (não dá pra referenciar 3
-- tabelas de origem diferentes com uma FK só) — a validação de que o
-- pedido realmente existe passa a ser feita na aplicação
-- (lib/faturamento.js#empresaDoPedido / lib/notasFiscais.js#empresaDoPedido
-- — mesmo espírito de ml_pedidos/shopee_pedidos, que também não têm FK
-- cruzada entre si). Nenhum dado existente precisa ser editado: linhas
-- antigas não tinham `marketplace`, e o DEFAULT abaixo marca todas como
-- 'mercado_livre' — a única origem que existia até aqui, então continuam
-- corretas sem nenhuma migração de dados.
ALTER TABLE faturamento_pedidos ADD COLUMN IF NOT EXISTS marketplace VARCHAR(20) NOT NULL DEFAULT 'mercado_livre';
ALTER TABLE faturamento_pedidos DROP CONSTRAINT IF EXISTS faturamento_pedidos_pedido_id_key;
ALTER TABLE faturamento_pedidos DROP CONSTRAINT IF EXISTS faturamento_pedidos_pedido_id_fkey;
ALTER TABLE faturamento_pedidos DROP CONSTRAINT IF EXISTS uq_faturamento_pedidos_pedido_marketplace;
ALTER TABLE faturamento_pedidos ADD CONSTRAINT uq_faturamento_pedidos_pedido_marketplace UNIQUE (pedido_id, marketplace);

ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS marketplace VARCHAR(20) NOT NULL DEFAULT 'mercado_livre';
ALTER TABLE notas_fiscais DROP CONSTRAINT IF EXISTS notas_fiscais_pedido_id_key;
ALTER TABLE notas_fiscais DROP CONSTRAINT IF EXISTS notas_fiscais_pedido_id_fkey;
ALTER TABLE notas_fiscais DROP CONSTRAINT IF EXISTS uq_notas_fiscais_pedido_marketplace;
ALTER TABLE notas_fiscais ADD CONSTRAINT uq_notas_fiscais_pedido_marketplace UNIQUE (pedido_id, marketplace);

-- ============================================================
-- Etapa: "Agente de Envio Full" (23/09/2026)
-- ============================================================
-- Pedido explícito do usuário: "agente de envio full - quando enviar ro
-- full, quado ta acabando, quando segurar, quanto gastei de envios full no
-- mes". Mesma régua de decisão já usada em "Compras com IA"
-- (lib/ia/comprasMotor.js: dias de cobertura, projeção de venda ponderada,
-- ponto de recompra) — aqui adaptada pra decidir quando TRANSFERIR estoque
-- do Galpão pro Full, em vez de quando comprar do fornecedor. Reaproveita
-- ao vivo, sem duplicar: estoque físico (lib/estoqueFisico.js), vendas por
-- janela e cadastro de produtos base ativos (ambos já expostos por
-- lib/ia/comprasCiclo.js). Mesmo padrão "nunca apaga" (expira, não some) e
-- "no máximo 1 recomendação pendente por produto base" de ia_decisoes_compras.
--
-- `prazo_envio_full_dias`: quantos dias, em média, uma remessa enviada ao
-- Full leva até ficar disponível pra venda (o "prazo de fornecedor" desta
-- régua, só que é o próprio Mercado Livre recebendo/processando, não um
-- fornecedor). Fica em produtos_base porque pode variar por produto
-- (tamanho/peso mudam o tempo de logística) — NULL usa o padrão global
-- (ver PRAZO_ENVIO_FULL_DIAS_PADRAO em lib/ia/envioFullMotor.js), mesmo
-- espírito de estoque_seguranca_dias.
ALTER TABLE produtos_base ADD COLUMN IF NOT EXISTS prazo_envio_full_dias INTEGER;

CREATE TABLE IF NOT EXISTS ia_decisoes_envio_full (
  id                                SERIAL PRIMARY KEY,
  empresa_id                        INTEGER NOT NULL REFERENCES empresas(id),
  produto_base_id                   INTEGER NOT NULL REFERENCES produtos_base(id),
  produto_base_codigo               VARCHAR(100) NOT NULL,
  tipo_acao                         VARCHAR(30) NOT NULL DEFAULT 'enviar_full',
  status_urgencia                   VARCHAR(20) NOT NULL, -- saudavel|atencao|programar_envio|enviar_agora|ruptura
  sem_estoque_galpao_suficiente     BOOLEAN NOT NULL DEFAULT FALSE, -- "segurar": precisaria enviar, mas não há estoque de sobra no galpão
  motivo                            TEXT NOT NULL,
  snapshot_estoque_galpao           NUMERIC(14,2),
  snapshot_estoque_full             NUMERIC(14,2),
  snapshot_venda_7d                 NUMERIC(14,2),
  snapshot_venda_14d                NUMERIC(14,2),
  snapshot_venda_30d                NUMERIC(14,2),
  snapshot_media_dia_projetada      NUMERIC(14,4),
  snapshot_acelerando               BOOLEAN,
  snapshot_dias_cobertura_full      NUMERIC(8,2),
  snapshot_data_ruptura_full_prevista DATE,
  snapshot_prazo_envio_full_dias    INTEGER,
  snapshot_estoque_seguranca_dias   INTEGER,
  quantidade_sugerida_envio         NUMERIC(14,2) NOT NULL,
  quantidade_decidida               NUMERIC(14,2),
  status_decisao                    VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente|aprovada|alterada|ignorada|expirada
  decidido_em                       TIMESTAMPTZ,
  decidido_por                      VARCHAR(180),
  relatorio_diagnostico_texto       TEXT,
  criado_em                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em                     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_decisoes_envio_full_empresa ON ia_decisoes_envio_full (empresa_id, status_decisao);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_decisoes_envio_full_pendente
  ON ia_decisoes_envio_full (empresa_id, produto_base_id, tipo_acao)
  WHERE status_decisao = 'pendente';

-- Registro do envio em si (aprovado a partir de uma recomendação, ou
-- lançado manualmente — mesmo espírito de compras_ia_pedidos). Status em
-- português simples, vocabulário da tela: separado de compras_ia_pedidos
-- porque é um fluxo diferente (Galpão -> Full, não Fornecedor -> Galpão).
CREATE SEQUENCE IF NOT EXISTS envio_full_pedido_numero_seq START 1;

CREATE TABLE IF NOT EXISTS envio_full_pedidos (
  id                   SERIAL PRIMARY KEY,
  empresa_id           INTEGER NOT NULL REFERENCES empresas(id),
  numero_envio         VARCHAR(20) NOT NULL UNIQUE,
  produto_base_id      INTEGER NOT NULL REFERENCES produtos_base(id),
  recomendacao_id      INTEGER REFERENCES ia_decisoes_envio_full(id),
  origem               VARCHAR(20) NOT NULL DEFAULT 'recomendacao_ia', -- recomendacao_ia|manual
  quantidade           NUMERIC(14,2) NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'aprovado', -- aprovado|enviado|recebido_no_full|cancelado
  previsao_chegada     DATE,
  recebido_em          TIMESTAMPTZ,
  observacao           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_envio_full_pedidos_empresa ON envio_full_pedidos (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_envio_full_pedidos_produto_base ON envio_full_pedidos (produto_base_id, status);

-- Custo mensal de envio pro Full, LANÇADO À MÃO pelo usuário (mesmo
-- espírito de fluxo_caixa_saldo_inicial: nunca inventado nem lido de uma
-- integração que não existe). Motivo documentado em 05-problemas-conhecidos.md
-- 23/09/2026: pesquisamos a API de Relatórios de Cobrança do Mercado Livre
-- e não há confirmação pública do nome exato da cobrança de envio ao Full
-- — puxar isso automaticamente fica como melhoria futura, condicionada a
-- testar direto na conta real ou receber um exemplo de fatura do usuário.
-- Uma linha por (empresa, ano, mês) — upsert, mesmo padrão de despesas
-- recorrentes lançadas manualmente.
CREATE TABLE IF NOT EXISTS envio_full_custos_mensais (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
  ano          INTEGER NOT NULL,
  mes          INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  valor        NUMERIC(12,2) NOT NULL,
  observacao   TEXT,
  lancado_por  VARCHAR(180),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, ano, mes)
);

-- ============================================================
-- Etapa: Devoluções (separadas de Cancelamento) — 26/09/2026
-- ============================================================
-- Pedido explícito do usuário: entender "oque é devolção e oque é
-- cancelamento de pedido" — hoje só pedido CANCELADO sai do faturamento
-- real (ver STATUS_CANCELADO em lib/relatorioVendas.js); uma DEVOLUÇÃO
-- formal (cliente recebeu, devolveu e foi reembolsado) nasce como uma
-- "claim" tipo 'return' no Mercado Livre ou uma "devolução" na Shopee, e
-- até agora só aparecia no SAC — o pedido continuava contando como venda
-- normal em Faturamento/DRE/Margem, mesmo o dinheiro tendo voltado pro
-- cliente. Esta tabela guarda cada devolução detectada, pra
-- lib/relatorioVendas.js poder excluir do faturamento real (só quando
-- `status='confirmada'` — dinheiro realmente devolvido) e mostrar contada
-- à parte de cancelamento, nunca misturada.
--
-- Fontes (só leitura, nunca inventa nada — mesmo padrão de radar_alertas/
-- sac_atendimentos):
--   • Mercado Livre: mesmo endpoint de reclamações já usado pelo SAC
--     (GET /post-purchase/v1/claims/search, lib/mercadolivre.js#buscarReclamacoes)
--     — aqui filtramos só `type === 'return'` (devolução formal; outros
--     tipos como 'mediations'/'cancel_purchase' continuam só no SAC, sem
--     afetar o faturamento). `pedido_ref` = claim.resource_id (id do
--     pedido no Mercado Livre).
--   • Shopee: GET /api/v2/returns/get_return_list
--     (lib/shopee.js#buscarDevolucoes) — `pedido_ref` = return.order_sn.
--     IMPORTANTE (mesma honestidade de sempre): primeira vez que este
--     projeto lê este endpoint pra fins financeiros — o nome do campo
--     order_sn dentro da resposta de devolução ainda não foi confirmado
--     contra uma devolução real desta conta (ver 05-problemas-conhecidos.md).
--
-- `status`: 'aberta' (em andamento, dinheiro ainda não confirmado — NÃO
-- exclui do faturamento, pra não tirar uma venda real por uma disputa que
-- pode ser negada) | 'confirmada' (reembolso confirmado — Mercado Livre:
-- claim status='closed' + resolution indicando reembolso; Shopee:
-- status='COMPLETED' — EXCLUI do faturamento real) | 'negada_ou_cancelada'
-- (claim fechado sem reembolso, ou devolução cancelada pelo comprador —
-- NÃO exclui, a venda continua valendo).
-- `valor_reembolsado`: só preenchido quando a API devolve um valor claro
-- (coverage/refund_amount) — NULL quando não dá pra confirmar (nunca usa
-- o valor total do pedido como aproximação).
CREATE TABLE IF NOT EXISTS pedido_devolucoes (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id),
  marketplace         VARCHAR(20) NOT NULL, -- 'mercado_livre' | 'shopee'
  conta_id            INTEGER, -- ml_contas.id ou shopee_contas.id (sem FK cruzada, mesmo padrão de faturamento_pedidos/notas_fiscais)
  id_externo          VARCHAR(60) NOT NULL, -- claim id (Mercado Livre) ou return_sn (Shopee)
  pedido_ref          VARCHAR(60), -- ml_order_id ou order_sn — liga com relatorioVendas.js; NULL só se a API não informar
  tipo                VARCHAR(30) NOT NULL DEFAULT 'return',
  status              VARCHAR(30) NOT NULL DEFAULT 'aberta', -- aberta | confirmada | negada_ou_cancelada
  motivo              TEXT,
  valor_reembolsado   NUMERIC(12,2),
  data_criacao        TIMESTAMPTZ,
  data_conclusao      TIMESTAMPTZ,
  raw                 JSONB,
  sincronizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (marketplace IN ('mercado_livre', 'shopee')),
  CHECK (status IN ('aberta', 'confirmada', 'negada_ou_cancelada')),
  UNIQUE (empresa_id, marketplace, id_externo)
);
CREATE INDEX IF NOT EXISTS idx_pedido_devolucoes_empresa ON pedido_devolucoes (empresa_id, status);
-- Índice usado pelo LEFT JOIN em lib/relatorioVendas.js (empresa + canal +
-- pedido, só quando confirmada) — filtro parcial porque só devolução
-- confirmada entra nesse JOIN.
CREATE INDEX IF NOT EXISTS idx_pedido_devolucoes_pedido_confirmada
  ON pedido_devolucoes (empresa_id, marketplace, pedido_ref)
  WHERE status = 'confirmada' AND pedido_ref IS NOT NULL;
