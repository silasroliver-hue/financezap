-- ============================================================
-- MIGRATION: Gestão Contas → SaaS Multi-tenant
-- Execute no SQL Editor do Supabase (após o schema.sql original)
-- ============================================================

-- 1. Perfil do usuário (extensão de auth.users)
create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  whatsapp_phone text unique,  -- ex: "5511999999999" (apenas dígitos)
  has_access boolean not null default false,
  paid_at timestamptz,
  payment_ref text,
  created_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

create policy "user_profiles_owner" on public.user_profiles
  using (id = auth.uid())
  with check (id = auth.uid());

-- Cria perfil automaticamente ao criar conta
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 2. Adicionar user_id em todas as tabelas existentes
-- ============================================================

-- transactions
alter table public.transactions
  add column if not exists user_id uuid references auth.users (id);

-- Preenche user_id nulo com o primeiro usuário existente (dados legados)
-- Após executar, se necessário rode:
-- UPDATE public.transactions SET user_id = '<uuid-do-usuario-existente>' WHERE user_id IS NULL;

-- Depois de preencher os dados legados, aplique NOT NULL:
-- ALTER TABLE public.transactions ALTER COLUMN user_id SET NOT NULL;

create index if not exists idx_transactions_user on public.transactions (user_id);

-- investments
alter table public.investments
  add column if not exists user_id uuid references auth.users (id);

create index if not exists idx_investments_user on public.investments (user_id);

-- recurring_bills
alter table public.recurring_bills
  add column if not exists user_id uuid references auth.users (id);

create index if not exists idx_recurring_bills_user on public.recurring_bills (user_id);

-- budget_pots
alter table public.budget_pots
  add column if not exists user_id uuid references auth.users (id);

create index if not exists idx_budget_pots_user on public.budget_pots (user_id);

-- bill_payments não precisa de user_id direto pois referencia recurring_bills (que já tem user_id)
-- mas adicionamos para facilitar queries diretas:
alter table public.bill_payments
  add column if not exists user_id uuid references auth.users (id);

create index if not exists idx_bill_payments_user on public.bill_payments (user_id);

-- ============================================================
-- 3. RLS Policies — cada usuário vê e edita só os próprios dados
-- (server usa service_role e filtra manualmente, mas RLS é a
--  última linha de defesa caso o anon key seja exposto)
-- ============================================================

-- transactions
drop policy if exists "transactions_owner" on public.transactions;
create policy "transactions_owner" on public.transactions
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- investments
drop policy if exists "investments_owner" on public.investments;
create policy "investments_owner" on public.investments
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- recurring_bills
drop policy if exists "recurring_bills_owner" on public.recurring_bills;
create policy "recurring_bills_owner" on public.recurring_bills
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- budget_pots
drop policy if exists "budget_pots_owner" on public.budget_pots;
create policy "budget_pots_owner" on public.budget_pots
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- bill_payments
drop policy if exists "bill_payments_owner" on public.bill_payments;
create policy "bill_payments_owner" on public.bill_payments
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- 4. Índice de telefone WhatsApp para lookup rápido no webhook
-- ============================================================
create index if not exists idx_user_profiles_phone on public.user_profiles (whatsapp_phone)
  where whatsapp_phone is not null;

comment on table public.user_profiles is 'Perfil SaaS do usuário: acesso, WhatsApp, pagamento';
comment on column public.user_profiles.has_access is 'true = pagamento confirmado; false = aguardando';
comment on column public.user_profiles.whatsapp_phone is 'Número no formato E.164 sem + (ex: 5511999999999)';
