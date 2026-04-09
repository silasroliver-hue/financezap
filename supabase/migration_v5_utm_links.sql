-- ============================================================
-- FinanceZap — Migration v5
-- Gerenciamento de links UTM para vendas via influenciadores
-- ============================================================

CREATE TABLE IF NOT EXISTS public.utm_links (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,                    -- Nome do influenciador/campanha
  slug         TEXT        NOT NULL UNIQUE,             -- Identificador curto para /r/:slug
  utm_source   TEXT        NOT NULL,                    -- Ex: instagram, youtube, tiktok
  utm_medium   TEXT        NOT NULL DEFAULT 'influencer',
  utm_campaign TEXT        NOT NULL DEFAULT 'lancamento',
  utm_content  TEXT,                                    -- Ex: stories, feed, reels
  utm_term     TEXT,                                    -- Palavra-chave opcional
  base_url     TEXT        NOT NULL DEFAULT 'https://financezap.thesilasstudio.com.br',
  notes        TEXT,                                    -- Observações internas
  click_count  INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para busca por slug (rota de redirect)
CREATE INDEX IF NOT EXISTS utm_links_slug_idx ON public.utm_links (slug);

-- Sem RLS — tabela é gerenciada apenas pelo admin via service role
