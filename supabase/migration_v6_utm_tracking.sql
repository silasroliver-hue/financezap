-- ============================================================
-- FinanceZap — Migration v6
-- Rastreamento de origem UTM em pagamentos e perfis de usuário
-- ============================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS utm_slug   TEXT,
  ADD COLUMN IF NOT EXISTS utm_source TEXT;

ALTER TABLE public.pending_payments
  ADD COLUMN IF NOT EXISTS utm_slug   TEXT,
  ADD COLUMN IF NOT EXISTS utm_source TEXT;
