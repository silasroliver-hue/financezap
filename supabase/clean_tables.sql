-- ============================================================
-- FinanceZap — Limpar TODAS as tabelas para testes
-- ⚠️  CUIDADO: apaga TODOS os dados de TODOS os usuários!
-- Execute no Supabase SQL Editor
-- ============================================================

-- Limpa tudo de uma vez com CASCADE para resolver dependências de FK
TRUNCATE TABLE
  whatsapp_sessions,
  credit_card_transactions,
  credit_cards,
  bill_payments,
  recurring_bills,
  investments,
  transactions,
  user_categories,
  bank_accounts,
  budget_pots,
  pending_payments,
  user_profiles
CASCADE;

-- 13. Remover todos os usuários do Supabase Auth
-- ⚠️  Isso deleta TODAS as contas de login!
DELETE FROM auth.users;

-- ============================================================
-- Pronto! Banco zerado para novos testes.
-- ============================================================
