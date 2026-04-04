const { getSupabase } = require("./supabase");

/**
 * Middleware de autenticação via Supabase Auth JWT.
 * Injeta req.userId (string UUID) se o token for válido.
 * Retorna 401 se ausente/inválido ou 402 se sem acesso pago.
 *
 * @param {object} options
 * @param {boolean} [options.requireAccess=true] — se true, verifica has_access no perfil
 */
function createAuthMiddleware({ requireAccess = true } = {}) {
  return async function authMiddleware(req, res, next) {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: "Token de autenticação ausente" });
    }

    const sb = getSupabase();

    // Verifica o JWT com Supabase
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Token inválido ou expirado" });
    }

    req.userId = user.id;
    req.userEmail = user.email;

    // Verifica acesso pago (exceto em rotas que não exigem)
    if (requireAccess) {
      const { data: profile, error: pErr } = await sb
        .from("user_profiles")
        .select("has_access")
        .eq("id", user.id)
        .single();

      if (pErr || !profile) {
        return res.status(403).json({ error: "Perfil não encontrado" });
      }

      if (!profile.has_access) {
        return res.status(402).json({
          error: "Acesso não liberado",
          code: "PAYMENT_REQUIRED",
        });
      }
    }

    next();
  };
}

// Middleware padrão: exige auth + acesso pago
const authRequired = createAuthMiddleware({ requireAccess: true });

// Apenas verifica auth (sem checar has_access) — para perfil/onboarding
const authOnly = createAuthMiddleware({ requireAccess: false });

module.exports = { authRequired, authOnly, createAuthMiddleware };
