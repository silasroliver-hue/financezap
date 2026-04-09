-- ============================================================
-- FinanceZap — Migration v9
-- Saldo inicial no primeiro login
-- ============================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS initial_balance_set_at timestamptz;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS initial_balance_amount numeric(14, 2);

COMMENT ON COLUMN public.user_profiles.initial_balance_set_at IS
  'Data/hora em que o usuário concluiu a etapa de saldo inicial no primeiro acesso';

COMMENT ON COLUMN public.user_profiles.initial_balance_amount IS
  'Valor informado como saldo inicial no primeiro acesso (pode ser nulo se usuário optou por pular)';
