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
