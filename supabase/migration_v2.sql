-- ============================================================
-- FinanZen — Migration v2
-- Novas tabelas: pending_payments, user_categories, bank_accounts
-- Atualiza transactions com bank_account_id
-- ============================================================

-- 1. pending_payments: fila de pagamentos aguardando confirmação do admin
CREATE TABLE IF NOT EXISTS pending_payments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  whatsapp_phone   TEXT        NOT NULL,
  email            TEXT,
  amount           NUMERIC(12,2) NOT NULL DEFAULT 97.00,
  status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','cancelled')),
  activation_token UUID        UNIQUE DEFAULT gen_random_uuid(),
  notes            TEXT,
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- 2. user_categories: categorias criadas por cada usuário (começa vazio)
CREATE TABLE IF NOT EXISTS user_categories (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  kind       TEXT        NOT NULL DEFAULT 'both'
               CHECK (kind IN ('income','expense','both')),
  sort_order INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_categories_user_id_idx ON user_categories(user_id);

ALTER TABLE user_categories ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_categories' AND policyname = 'owner'
  ) THEN
    CREATE POLICY "owner" ON user_categories USING (user_id = auth.uid());
  END IF;
END $$;

-- 3. bank_accounts: contas bancárias por usuário
CREATE TABLE IF NOT EXISTS bank_accounts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  bank_name    TEXT,
  account_type TEXT        NOT NULL DEFAULT 'corrente'
                 CHECK (account_type IN ('corrente','poupança','cartão','investimento','digital','outro')),
  balance      NUMERIC(12,2) NOT NULL DEFAULT 0,
  color        TEXT        DEFAULT '#10B981',
  sort_order   INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_accounts_user_id_idx ON bank_accounts(user_id);

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'bank_accounts' AND policyname = 'owner'
  ) THEN
    CREATE POLICY "owner" ON bank_accounts USING (user_id = auth.uid());
  END IF;
END $$;

-- 4. Adiciona bank_account_id em transactions (opcional — pode ser NULL)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;
