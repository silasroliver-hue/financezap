-- ============================================================
-- FinanceZap — Limpar TODAS as tabelas para testes
-- ⚠️  CUIDADO: apaga TODOS os dados de TODOS os usuários!
-- Execute no Supabase SQL Editor
-- ============================================================

-- 1. Tabelas de sessão/estado (sem FK dependente)
TRUNCATE TABLE whatsapp_sessions;

-- 2. Lançamentos de cartão de crédito (depende de credit_cards)
TRUNCATE TABLE credit_card_transactions;

-- 3. Cartões de crédito
TRUNCATE TABLE credit_cards;

-- 4. Pagamentos de contas recorrentes (depende de recurring_bills)
TRUNCATE TABLE bill_payments;

-- 5. Contas recorrentes
TRUNCATE TABLE recurring_bills;

-- 6. Investimentos
TRUNCATE TABLE investments;

-- 7. Transações financeiras
TRUNCATE TABLE transactions;

-- 8. Categorias do usuário
TRUNCATE TABLE user_categories;

-- 9. Contas bancárias
TRUNCATE TABLE bank_accounts;

-- 10. Budget pots
TRUNCATE TABLE budget_pots;

-- 11. Pagamentos pendentes (checkout)
TRUNCATE TABLE pending_payments;

-- 12. Perfis de usuário (depende de auth.users)
TRUNCATE TABLE user_profiles;

-- 13. Remover todos os usuários do Supabase Auth
-- ⚠️  Isso deleta TODAS as contas de login!
DELETE FROM auth.users;

-- ============================================================
-- Pronto! Banco zerado para novos testes.
-- ============================================================
