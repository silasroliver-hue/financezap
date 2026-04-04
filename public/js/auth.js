/**
 * auth.js — Supabase Auth client para o browser
 * Carregado em todas as páginas protegidas e nas de auth.
 *
 * Depende de: window.__SUPABASE_URL__ e window.__SUPABASE_ANON_KEY__
 * injetados pelo endpoint GET /api/config (via tag <script> inline nas páginas).
 */

let _supabase = null;

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
  const res = await fetch("/api/profile", { headers });
  if (res.status === 401) {
    window.location.href = "/login";
    return false;
  }
  const profile = await res.json();
  if (!profile.has_access) {
    // Mostra paywall em vez de redirecionar
    showPaywall(profile);
    return false;
  }
  return profile;
}

/** Login com email+senha. Retorna { error } ou redireciona. */
async function signIn(email, password) {
  const sb = getSupabaseClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  // Verifica acesso
  const headers = await getAuthHeader();
  const res = await fetch("/api/profile", { headers });
  const profile = await res.json();

  if (!profile.has_access) {
    window.location.href = "/onboarding";
  } else {
    window.location.href = "/insights/";
  }
  return {};
}

/** Cadastro. Retorna { error } ou redireciona. */
async function signUp(email, password, fullName) {
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

/** Logout e redirect para landing. */
async function logout() {
  const sb = getSupabaseClient();
  await sb.auth.signOut();
  window.location.href = "/";
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
