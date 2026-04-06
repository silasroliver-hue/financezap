(function () {
  const links = [
    { href: "index.html",        id: "dash",   label: "Dashboard",       icon: "📊" },
    { href: "lancamentos.html",  id: "lanc",   label: "Lancamentos",     icon: "✏️" },
    { href: "gastos.html",       id: "gastos", label: "Gastos",          icon: "💸" },
    { href: "investimentos.html",id: "inv",    label: "Investimentos",   icon: "📈" },
    { href: "pagamentos.html",   id: "pay",    label: "Contas",          icon: "🗓️" },
    { href: "contas.html",       id: "contas", label: "Bancos",          icon: "🏦" },
    { href: "categorias.html",   id: "cat",    label: "Categorias",      icon: "🏷️" },
    { href: "cartoes.html",      id: "cartoes",label: "Cartoes",         icon: "💳" },
  ];

  /** Render top nav (desktop) + bottom tab bar (mobile) — same markup, CSS adapts */
  window.renderNav = function (activeId) {
    const nav = document.getElementById("main-nav");
    if (!nav) return;
    nav.innerHTML = links
      .map(l => `<a href="${l.href}" class="${l.id === activeId ? "active" : ""}">
        <span class="nav-icon">${l.icon}</span><span class="nav-text">${l.label}</span>
      </a>`)
      .join("");
  };

  window.renderSidebarNav = function (activeId) {
    const nav = document.getElementById("sidebar-nav");
    if (!nav) return;
    nav.innerHTML = links
      .map(l =>
        `<a href="${l.href}" class="${l.id === activeId ? "active" : ""}">
          <span class="nav-icon">${l.icon}</span><span class="nav-text">${l.label}</span>
        </a>`
      )
      .join("");
  };

  /** Preenche o footer da navbar com nome do usuario + botao de logout. */
  window.renderSidebarUser = async function () {
    const footer = document.getElementById("sidebar-footer");
    if (!footer) return;

    let name = "Usuario";
    try {
      if (typeof window.getAuthHeader === "function") {
        const headers = await window.getAuthHeader();
        const res = await fetch("/api/profile", { headers });
        if (res.ok) {
          const p = await res.json();
          if (p.full_name) name = p.full_name;
        }
      }
    } catch (e) { /* silencia */ }

    const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

    footer.innerHTML = `
      <div class="dash-user-card">
        <div class="dash-user-avatar">${initials}</div>
        <div class="dash-user-info">
          <div class="dash-user-name">${name}</div>
          <div class="dash-user-plan">Acesso Completo</div>
        </div>
        <button class="dash-logout-btn" onclick="logout()" title="Sair">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    `;
  };
})();
