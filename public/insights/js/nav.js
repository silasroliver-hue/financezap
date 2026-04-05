(function () {
  const links = [
    { href: "index.html",        id: "dash",   label: "Dashboard",      icon: "📊" },
    { href: "gastos.html",       id: "gastos", label: "Gastos",         icon: "💸" },
    { href: "lancamentos.html",  id: "lanc",   label: "Lançamentos",    icon: "✏️" },
    { href: "investimentos.html",id: "inv",    label: "Investimentos",  icon: "📈" },
    { href: "pagamentos.html",   id: "pay",    label: "Contas do mês",  icon: "🗓️" },
    { href: "contas.html",       id: "contas", label: "Contas bancárias",icon: "🏦" },
    { href: "categorias.html",   id: "cat",    label: "Categorias",     icon: "🏷️" },
    { href: "cartoes.html",      id: "cartoes",label: "Cartões",         icon: "💳" },
  ];

  window.renderNav = function (activeId) {
    const nav = document.getElementById("main-nav");
    if (!nav) return;
    nav.innerHTML = links
      .map(l => `<a href="${l.href}" class="${l.id === activeId ? "active" : ""}">${l.label}</a>`)
      .join("");
  };

  window.renderSidebarNav = function (activeId) {
    const nav = document.getElementById("sidebar-nav");
    if (!nav) return;
    nav.innerHTML = links
      .map(l =>
        `<a href="${l.href}" class="${l.id === activeId ? "active" : ""}">
          <span class="nav-icon">${l.icon}</span>${l.label}
        </a>`
      )
      .join("");
  };

  /** Preenche o rodapé da sidebar com nome do usuário + botão de logout. */
  window.renderSidebarUser = async function () {
    const footer = document.getElementById("sidebar-footer");
    if (!footer) return;

    let name = "Usuário";
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
          <div class="dash-user-plan">✦ Acesso Completo</div>
        </div>
        <button class="dash-logout-btn" onclick="logout()" title="Sair">⏏</button>
      </div>
    `;
  };
})();
