-- ============================================================
-- FinanceZap — Migration v10
-- Tabela de posts agendados para o Instagram (Story + Feed)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.instagram_posts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo        TEXT NOT NULL,
  legenda       TEXT,
  image_url     TEXT NOT NULL,
  tipo          TEXT NOT NULL DEFAULT 'feed' CHECK (tipo IN ('feed', 'story')),
  status        TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'publicado', 'erro')),
  agendado_para TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 day'),
  ig_post_id    TEXT,
  erro_msg      TEXT,
  publicado_em  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para queries do n8n e do painel
CREATE INDEX IF NOT EXISTS instagram_posts_status_idx       ON public.instagram_posts (status);
CREATE INDEX IF NOT EXISTS instagram_posts_agendado_idx     ON public.instagram_posts (agendado_para);
CREATE INDEX IF NOT EXISTS instagram_posts_status_sched_idx ON public.instagram_posts (status, agendado_para);

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS instagram_posts_updated_at ON public.instagram_posts;
CREATE TRIGGER instagram_posts_updated_at
  BEFORE UPDATE ON public.instagram_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Sem RLS — tabela acessada apenas por service_role (admin + n8n)
