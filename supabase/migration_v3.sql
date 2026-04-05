-- ============================================================
-- FinanceZap — Migration v3
-- Novas tabelas: whatsapp_sessions, credit_cards, credit_card_transactions
-- Alterações: email em user_profiles
-- ============================================================

-- 1. Coluna email em user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS email TEXT;

-- 2. whatsapp_sessions: estado da conversa por telefone
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  phone        TEXT        PRIMARY KEY,
  user_id      UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  state        TEXT,       -- null | waiting_extrato_days | waiting_receita_category | waiting_receita_amount | waiting_despesa_category | waiting_despesa_amount | waiting_invest_broker | waiting_invest_amount | waiting_question
  context      JSONB       DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_sessions_user_id_idx ON whatsapp_sessions(user_id);

-- Limpeza automática de sessões antigas (>2h)
-- (executar periodicamente ou usar pg_cron)

-- 3. credit_cards: cartões de crédito por usuário
CREATE TABLE IF NOT EXISTS credit_cards (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  bank_name     TEXT,
  last_four     CHAR(4),
  credit_limit  NUMERIC(12,2) NOT NULL DEFAULT 0,
  closing_day   SMALLINT    CHECK (closing_day BETWEEN 1 AND 31),
  due_day       SMALLINT    CHECK (due_day BETWEEN 1 AND 31),
  color         TEXT        DEFAULT '#8B5CF6',
  sort_order    INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_cards_user_id_idx ON credit_cards(user_id);

ALTER TABLE credit_cards ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'credit_cards' AND policyname = 'owner'
  ) THEN
    CREATE POLICY "owner" ON credit_cards USING (user_id = auth.uid());
  END IF;
END $$;

-- 4. credit_card_transactions: lançamentos de cartão (com parcelamento)
CREATE TABLE IF NOT EXISTS credit_card_transactions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id             UUID        NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  description         TEXT,
  category            TEXT        NOT NULL DEFAULT 'Geral',
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  installments        SMALLINT    NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 60),
  current_installment SMALLINT    NOT NULL DEFAULT 1,
  purchase_date       DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_transactions_user_id_idx  ON credit_card_transactions(user_id);
CREATE INDEX IF NOT EXISTS cc_transactions_card_id_idx  ON credit_card_transactions(card_id);
CREATE INDEX IF NOT EXISTS cc_transactions_date_idx     ON credit_card_transactions(purchase_date DESC);

ALTER TABLE credit_card_transactions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'credit_card_transactions' AND policyname = 'owner'
  ) THEN
    CREATE POLICY "owner" ON credit_card_transactions USING (user_id = auth.uid());
  END IF;
END $$;
