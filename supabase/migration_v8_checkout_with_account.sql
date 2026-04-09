-- ============================================================
-- FinanceZap — Migration v8
-- Checkout cria conta na hora — vincula pagamento ao usuário
-- ============================================================

ALTER TABLE public.pending_payments
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pending_payments_user_id_idx ON public.pending_payments(user_id);
