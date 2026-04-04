-- Rode no SQL Editor se a tabela budget_pots já existia com percent muito estreito (erro "numeric field overflow").
alter table public.budget_pots
  alter column percent type numeric(12, 6);
