/**
 * auth.js — Supabase Auth client para o browser
 * Carregado em todas as páginas protegidas e nas de auth.
 *
 * Depende de: window.__SUPABASE_URL__ e window.__SUPABASE_ANON_KEY__
 * (carregados via ensureSupabaseConfig() a partir de GET .../config).
 */

let _supabase = null;

/**
 * URLs base da API (alinhado a public/insights/js/api.js).
 * Override: window.__INSIGHTS_API_BASE__ = "https://node" → tenta .../api
 * Ou origem do Node: meta financezap-api-origin ou window.__FINANCEZAP_API_ORIGIN__
 */
function getApiBases() {
  const list = [];
  if (window.__INSIGHTS_API_BASE__) {
    list.push(String(window.__INSIGHTS_API_BASE__).replace(/\/$/, "") + "/api");
  }
  let fixedOrigin = "";
  try {
    const m = document.querySelector('meta[name="financezap-api-origin"]');
    const c = m && m.getAttribute("content");
    if (c) fixedOrigin = String(c).trim().replace(/\/$/, "");
  } catch (e) {
    /* ignore */
  }
  if (!fixedOrigin && typeof window.__FINANCEZAP_API_ORIGIN__ === "string") {
    const t = window.__FINANCEZAP_API_ORIGIN__.trim().replace(/\/$/, "");
    if (t) fixedOrigin = t;
  }
  if (fixedOrigin) {
    list.push(fixedOrigin + "/insights/api");
    list.push(fixedOrigin + "/api");
  }
  try {
    const p = window.location.pathname || "";
    if (
      (window.location.protocol === "http:" || window.location.protocol === "https:") &&
      /^\/insights(\/|$)/.test(p)
    ) {
      list.push("/insights/api");
    }
  } catch (e) {
    /* ignore */
  }
  list.push("/insights/api", "/api");
  return [...new Set(list)];
}

async function fetchJsonFromApiBases(path, init) {
  const pathPart = path.startsWith("/") ? path : "/" + path;
  for (const base of getApiBases()) {
    const url = base.replace(/\/$/, "") + pathPart;
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      continue;
    }
    const text = await res.text();
    if (/^\s*</.test(text)) continue;
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      continue;
    }
    return { res, data, url };
  }
  return null;
}

/** POST/PATCH/GET com tentativa em cada base (login celular, onboarding, etc.) */
async function insightApiFetch(path, init = {}) {
  const pathPart = path.startsWith("/") ? path : "/" + path;
  for (const base of getApiBases()) {
    const url = base.replace(/\/$/, "") + pathPart;
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      if (/^\s*</.test(text)) continue;
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        continue;
      }
      return { res, data, url };
    } catch (e) {
      continue;
    }
  }
  return null;
}

/**
 * Garante __SUPABASE_URL__ / __SUPABASE_ANON_KEY__ (tenta /insights/api/config e /api/config).
 */
async function ensureSupabaseConfig() {
  if (window.__SUPABASE_URL__ && window.__SUPABASE_ANON_KEY__) return true;
  const r = await fetchJsonFromApiBases("/config", {});
  if (!r || !r.res.ok || !r.data) return false;
  const cfg = r.data;
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    window.__SUPABASE_URL__ = cfg.supabaseUrl;
    window.__SUPABASE_ANON_KEY__ = cfg.supabaseAnonKey;
    return true;
  }
  return false;
}

function showBootstrapError(message) {
  const el = document.getElementById("alert");
  if (el) {
    el.innerHTML = `<div class="dash-alert">${message}</div>`;
    return;
  }
  const main = document.querySelector("main");
  if (main) {
    main.innerHTML = `<div class="dash-alert" style="margin:1rem">${message}</div>`;
  } else {
    alert(message.replace(/<[^>]+>/g, ""));
  }
}

function getSupabaseClient() {
  if (_supabase) return _supabase;
  const url = window.__SUPABASE_URL__;
  const key = window.__SUPABASE_ANON_KEY__;
  if (!url || !key) throw new Error("Supabase config não carregada");
  _supabase = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return _supabase;
}

/** Retorna a sessão atual (ou null). */
async function getSession() {
  const sb = getSupabaseClient();
  const { data } = await sb.auth.getSession();
  return data?.session || null;
}

/** Retorna o usuário atual (ou null). */
async function getUser() {
  const session = await getSession();
  return session?.user || null;
}

/** Header Authorization para as chamadas à API. */
async function getAuthHeader() {
  const session = await getSession();
  if (!session) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Verifica se há sessão ativa. Se não houver, redireciona para /login.
 * Chame no topo de cada página protegida.
 */
async function checkAuth() {
  if (!(await ensureSupabaseConfig())) {
    showBootstrapError(
      "Não foi possível carregar a configuração do app. Confirme se o servidor expõe <strong>/insights/api</strong> ou <strong>/api</strong> (incluindo <code>/config</code>)."
    );
    return null;
  }
  const session = await getSession();
  if (!session) {
    window.location.href = "/login";
    return null;
  }
  return session;
}

/**
 * Verifica se o usuário tem acesso pago.
 * Se não tiver, redireciona para /onboarding ou exibe paywall.
 */
async function checkAccess() {
  const session = await checkAuth();
  if (!session) return false;

  const headers = await getAuthHeader();
  const r = await fetchJsonFromApiBases("/profile", { headers });
  if (!r) {
    showBootstrapError(
      "Não foi possível carregar seu perfil. Confirme se o proxy encaminha <strong>/insights/api</strong> ou <strong>/api</strong> para o Node."
    );
    return false;
  }
  if (r.res.status === 401) {
    window.location.href = "/login";
    return false;
  }
  const profile = r.data;
  if (!profile || typeof profile !== "object") {
    showBootstrapError("Resposta inválida ao carregar perfil.");
    return false;
  }
  if (!profile.has_access) {
    showPaywall(profile);
    return false;
  }
  return profile;
}

/** Login com email+senha. Retorna { error } ou redireciona. */
async function signIn(email, password) {
  if (!(await ensureSupabaseConfig())) {
    return {
      error:
        "Servidor inacessível. Confirme se /insights/api ou /api está disponível (endpoint /config).",
    };
  }
  const sb = getSupabaseClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  const headers = await getAuthHeader();
  const r = await fetchJsonFromApiBases("/profile", { headers });
  if (!r || !r.data) {
    return { error: "Não foi possível verificar seu perfil. Tente de novo." };
  }
  const profile = r.data;

  if (!profile.has_access) {
    window.location.href = "/onboarding";
  } else {
    window.location.href = "/insights/";
  }
  return {};
}

/** Cadastro. Retorna { error } ou redireciona. */
async function signUp(email, password, fullName) {
  if (!(await ensureSupabaseConfig())) {
    return {
      error:
        "Servidor inacessível. Confirme se /insights/api ou /api está disponível (endpoint /config).",
    };
  }
  const sb = getSupabaseClient();
  const { error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) return { error: error.message };
  window.location.href = "/onboarding";
  return {};
}

/** Logout e redirect para login. */
async function logout() {
  const sb = getSupabaseClient();
  await sb.auth.signOut();
  window.location.href = "https://financezap.thesilasstudio.com.br/login";
}

/** Exibe paywall inline (substitui o conteúdo main). */
function showPaywall(profile) {
  const main = document.querySelector("main") || document.body;
  main.innerHTML = `
    <div class="paywall">
      <div class="paywall-card">
        <div class="paywall-icon">🔒</div>
        <h2>Acesso Pendente</h2>
        <p>Olá${profile?.full_name ? ", " + profile.full_name : ""}! Seu acesso está sendo processado.</p>
        <p class="paywall-sub">Após a confirmação do pagamento, seu acesso será liberado automaticamente.</p>
        <button onclick="logout()" class="btn-outline">Sair</button>
      </div>
    </div>
  `;
}

window.getSupabaseClient = getSupabaseClient;
window.getSession = getSession;
window.getUser = getUser;
window.getAuthHeader = getAuthHeader;
window.checkAuth = checkAuth;
window.checkAccess = checkAccess;
window.signIn = signIn;
window.signUp = signUp;
window.logout = logout;
window.ensureSupabaseConfig = ensureSupabaseConfig;
/** Para nav.js e outros: GET/PATCH com tentativa em /insights/api e /api */
window.insightApiJson = fetchJsonFromApiBases;
window.insightApiFetch = insightApiFetch;
window.financezapGetApiBases = getApiBases;
