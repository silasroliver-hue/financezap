(function () {
  function computeApiBases() {
    if (typeof window.financezapGetApiBases === "function") {
      return window.financezapGetApiBases();
    }
    return ["/insights/api", "/api"];
  }

  const bases = computeApiBases();
  window.__API__ = bases[0] || "/insights/api";
  window.__API_CANDIDATES__ = bases;

  function looksLikeHtml(text) {
    return text && /<\!DOCTYPE|<html/i.test(text.trim().slice(0, 200));
  }

  /** Retorna o Authorization header da sessão atual (se disponível). */
  async function authHeader() {
    try {
      if (typeof window.getAuthHeader === "function") {
        return await window.getAuthHeader();
      }
    } catch (e) { /* sem sessão */ }
    return {};
  }

  async function tryRefreshAuthSession() {
    try {
      if (typeof window.getSupabaseClient !== "function") return false;
      const sb = window.getSupabaseClient();
      if (!sb || !sb.auth || typeof sb.auth.refreshSession !== "function") return false;
      const out = await sb.auth.refreshSession();
      return Boolean(out && out.data && out.data.session && out.data.session.access_token);
    } catch (e) {
      return false;
    }
  }

  window.apiFetch = async function (path, options) {
    const pathPart = path.startsWith("/") ? path : "/" + path;
    const allBases = computeApiBases();
    const locked = window.__API_RESOLVED__;
    const norm = (b) => String(b).replace(/\/$/, "");
    let tryBases = allBases;
    if (locked) {
      const rest = allBases.filter((b) => norm(b) !== norm(locked));
      tryBases = [locked, ...rest];
    }
    const aHeaders = await authHeader();

    let lastError = null;
    for (let i = 0; i < tryBases.length; i++) {
      const base = tryBases[i].replace(/\/$/, "");
      const url = base + pathPart;
      let res;
      try {
        res = await fetch(url, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...aHeaders,
            ...(options && options.headers),
          },
        });
      } catch (e) {
        lastError = e;
        continue;
      }

      // Token expirado: tenta renovar a sessão uma vez antes de redirecionar.
      if (res.status === 401) {
        const refreshed = await tryRefreshAuthSession();
        if (refreshed) {
          const retryHeaders = await authHeader();
          const retry = await fetch(url, {
            ...options,
            headers: {
              "Content-Type": "application/json",
              ...retryHeaders,
              ...(options && options.headers),
            },
          });

          if (retry.status === 401) {
            window.location.href = "/login";
            return;
          }

          if (retry.status === 402) {
            if (typeof window.showPaywall === "function") window.showPaywall({});
            return;
          }

          const retryText = await retry.text();
          if (looksLikeHtml(retryText)) {
            lastError = new Error("HTML em " + url);
            continue;
          }

          let retryData;
          try {
            retryData = retryText ? JSON.parse(retryText) : null;
          } catch {
            lastError = new Error(retryText ? retryText.slice(0, 120) : "Resposta inválida");
            continue;
          }

          if (!retry.ok) {
            const err = new Error(retryData?.error || retry.statusText);
            err.status = retry.status;
            err.body = retryData;
            throw err;
          }

          window.__API_RESOLVED__ = base;
          window.__API__ = base;
          return retryData;
        }

        window.location.href = "/login";
        return;
      }

      // Sem acesso pago → mostra paywall
      if (res.status === 402) {
        if (typeof window.showPaywall === "function") window.showPaywall({});
        return;
      }

      const text = await res.text();
      if (looksLikeHtml(text)) {
        lastError = new Error("HTML em " + url);
        continue;
      }

      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        lastError = new Error(text ? text.slice(0, 120) : "Resposta inválida");
        continue;
      }

      if (!res.ok) {
        const err = new Error(data?.error || res.statusText);
        err.status = res.status;
        err.body = data;
        throw err;
      }

      window.__API_RESOLVED__ = base;
      window.__API__ = base;
      return data;
    }

    const rootHealth =
      typeof window.location !== "undefined" && window.location.origin
        ? window.location.origin + "/health"
        : "/health";
    const hint = tryBases.map((b) => b + "/health").concat(rootHealth).join(" · ");
    throw new Error(
      "API inacessível (a resposta foi HTML ou a rede falhou). Abra no navegador: " +
        hint +
        ". Em Nginx/Caddy, encaminhe /api e /insights/api para o Node ANTES do fallback do SPA (try_files / index.html), senão o site devolve HTML em vez da API. " +
        "Se o painel está em outro domínio que o Node, defina window.__FINANCEZAP_API_ORIGIN__ = 'https://seu-servidor' antes dos scripts, ou <meta name=\"financezap-api-origin\" content=\"https://seu-servidor\">."
    );
  };

  window.fmtBRL = function (n) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
      Number(n) || 0
    );
  };

  window.fmtDate = function (d) {
    if (!d) return "—";
    const [y, m, day] = String(d).split("-");
    if (!y) return d;
    return `${day}/${m}/${y}`;
  };
})();
