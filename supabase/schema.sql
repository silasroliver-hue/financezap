-- Gestão Contas — execute no SQL Editor do Supabase (projeto novo ou existente)
-- Use a service role no backend Node; nunca exponha a service key no browser.

create extension if not exists "pgcrypto";

-- Lançamentos (entradas e saídas)
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('income', 'expense')),
  category text not null default 'Geral',
  amount numeric(14, 2) not null check (amount > 0),
  description text,
  occurred_on date not null default (current_date at time zone 'utc')::date,
  source text not null default 'manual' check (source in ('manual', 'whatsapp', 'import', 'api')),
  created_at timestamptz not null default now()
);

create index if not exists idx_transactions_occurred on public.transactions (occurred_on desc);
create index if not exists idx_transactions_kind on public.transactions (kind);

-- Investimentos (posição por corretora/conta)
create table if not exists public.investments (
  id uuid primary key default gen_random_uuid(),
  broker_name text not null,
  balance numeric(14, 2) not null default 0,
  notes text,
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);

-- Contas recorrentes (modelo da aba PAGAMENTOS)
create table if not exists public.recurring_bills (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_amount numeric(14, 2) not null default 0,
  due_day smallint check (due_day is null or (due_day >= 1 and due_day <= 31)),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Status de pagamento por mês
create table if not exists public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.recurring_bills (id) on delete cascade,
  year smallint not null check (year >= 2020 and year <= 2100),
  month smallint not null check (month >= 1 and month <= 12),
  paid boolean not null default false,
  amount_paid numeric(14, 2),
  paid_at date,
  unique (bill_id, year, month)
);

create index if not exists idx_bill_payments_period on public.bill_payments (year, month);

-- Potes (Lei dos Potes) — opcional no dashboard
create table if not exists public.budget_pots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  percent numeric(12, 6) not null check (percent >= 0 and percent <= 1),
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);

-- Habilitar RLS (acesso só via service role no seu servidor = política deny all para anon)
alter table public.transactions enable row level security;
alter table public.investments enable row level security;
alter table public.recurring_bills enable row level security;
alter table public.bill_payments enable row level security;
alter table public.budget_pots enable row level security;

-- Sem políticas públicas: o Node usa service_role e ignora RLS.
-- Se quiser ler do browser com anon key, crie políticas específicas depois.

comment on table public.transactions is 'Lançamentos de receitas e despesas';
comment on table public.investments is 'Posições de investimento por instituição';
comment on table public.recurring_bills is 'Contas mensais fixas';
comment on table public.bill_payments is 'Pagamento efetivado por mês';
comment on table public.budget_pots is 'Percentuais da lei dos potes';
