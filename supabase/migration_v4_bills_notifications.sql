-- ============================================================
-- FinanceZap — Migration v4
-- Contas do mês: notificação 1 dia antes + campos auxiliares
-- ============================================================

ALTER TABLE public.recurring_bills
  ADD COLUMN IF NOT EXISTS notify_one_day_before BOOLEAN NOT NULL DEFAULT FALSE;

-- Garante faixa válida para due_day (caso ainda não exista constraint)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'recurring_bills_due_day_check'
  ) THEN
    ALTER TABLE public.recurring_bills
      ADD CONSTRAINT recurring_bills_due_day_check
      CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31));
  END IF;
END $$;
