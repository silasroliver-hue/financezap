-- ============================================================
-- FinanceZap — Migration v7
-- Adiciona status 'activated' na constraint de pending_payments
-- ============================================================

ALTER TABLE public.pending_payments
  DROP CONSTRAINT pending_payments_status_check;

ALTER TABLE public.pending_payments
  ADD CONSTRAINT pending_payments_status_check
  CHECK (status = ANY (ARRAY['pending','confirmed','activated','cancelled']));
