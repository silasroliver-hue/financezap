(function () {
  function computeApiBases() {
    const list = [];
    if (window.__INSIGHTS_API_BASE__) {
      list.push(String(window.__INSIGHTS_API_BASE__).replace(/\/$/, "") + "/api");
    }
    try {
      const p = window.location.pathname || "";
      if (
        (window.location.protocol === "http:" || window.location.protocol === "https:") &&
        /^\/insights(\/|$)/.test(p)
      ) {
        list.push("/insights/api");
      }
    } catch (e) { /* ignore */ }
    list.push("/insights/api");
    list.push("/api");
    return [...new Set(list)];
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

  window.apiFetch = async function (path, options) {
    const pathPart = path.startsWith("/") ? path : "/" + path;
    const tryBases = window.__API_RESOLVED__ ? [window.__API_RESOLVED__] : computeApiBases();
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

      // Token expirado → redireciona para login
      if (res.status === 401) {
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

    const hint = tryBases.map((b) => b + "/health").join(" ou ");
    throw new Error(
      "API inacessível (só HTML ou rede). Teste no navegador: " +
        hint +
        ". Se usar proxy, exponha /api ou /insights/api para o Node."
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
