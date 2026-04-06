(function () {
  // Itens principais (aparecem na tab bar mobile)
  const mainLinks = [
    { href: "index.html",        id: "dash",   label: "Dashboard",     shortLabel: "Home",    icon: "📊" },
    { href: "lancamentos.html",  id: "lanc",   label: "Lancamentos",   shortLabel: "Lancar",  icon: "✏️" },
    { href: "gastos.html",       id: "gastos", label: "Gastos",        shortLabel: "Gastos",  icon: "💸" },
  ];

  // Itens que ficam dentro de "Configuracoes"
  const configLinks = [
    { href: "investimentos.html",id: "inv",    label: "Investimentos", icon: "📈" },
    { href: "pagamentos.html",   id: "pay",    label: "Contas do mes", icon: "🗓️" },
    { href: "contas.html",       id: "contas", label: "Contas bancarias", icon: "🏦" },
    { href: "categorias.html",   id: "cat",    label: "Categorias",    icon: "🏷️" },
    { href: "cartoes.html",      id: "cartoes",label: "Cartoes de credito", icon: "💳" },
  ];

  const allLinks = [...mainLinks, ...configLinks];

  window.renderNav = function (activeId) {
    const nav = document.getElementById("main-nav");
    if (!nav) return;
    nav.innerHTML = allLinks
      .map(l => `<a href="${l.href}" class="${l.id === activeId ? "active" : ""}">
        <span class="nav-icon">${l.icon}</span><span class="nav-text">${l.label}</span>
      </a>`)
      .join("");
  };

  window.renderSidebarNav = function (activeId) {
    const nav = document.getElementById("sidebar-nav");
    if (!nav) return;
    const sidebar = nav.closest(".dash-sidebar");

    // Desktop: all links inside nav (flat)
    nav.innerHTML = allLinks.map(l => {
      const isActive = l.id === activeId;
      return `<a href="${l.href}" class="${isActive ? "active" : ""}">
        <span class="nav-icon">${l.icon}</span>
        <span class="nav-text">${l.label}</span>
        <span class="nav-short">${l.shortLabel || l.label}</span>
      </a>`;
    }).join("");

    // Clean up old mobile elements
    sidebar.querySelectorAll(".nav-config-btn, .nav-config-overlay").forEach(el => el.remove());

    // Check if active page is in config section
    const isActiveInConfig = configLinks.some(l => l.id === activeId);

    // Config button for mobile
    const configBtn = document.createElement("button");
    configBtn.className = "nav-config-btn" + (isActiveInConfig ? " active" : "");
    configBtn.id = "nav-config-toggle";
    configBtn.innerHTML = `<span class="nav-icon">⚙️</span><span class="nav-short">Config</span>`;
    configBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openConfigPanel();
    });
    sidebar.appendChild(configBtn);

    // Config full-screen overlay for mobile
    const overlay = document.createElement("div");
    overlay.className = "nav-config-overlay";
    overlay.id = "nav-config-overlay";
    overlay.innerHTML = `
      <div class="nav-config-panel">
        <div class="nav-config-header">
          <h3>Menu</h3>
          <button class="nav-config-close" id="nav-config-close">✕</button>
        </div>
        <div class="nav-config-grid">
          ${configLinks.map(l => {
            const isActive = l.id === activeId;
            return `<a href="${l.href}" class="nav-config-item ${isActive ? "active" : ""}">
              <span class="nav-config-icon">${l.icon}</span>
              <span class="nav-config-label">${l.label}</span>
            </a>`;
          }).join("")}
        </div>
        <div class="nav-config-logout" id="nav-config-logout"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Close button
    overlay.querySelector("#nav-config-close").addEventListener("click", closeConfigPanel);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeConfigPanel();
    });
  };

  window.openConfigPanel = function () {
    const overlay = document.getElementById("nav-config-overlay");
    if (!overlay) return;
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  };

  window.closeConfigPanel = function () {
    const overlay = document.getElementById("nav-config-overlay");
    if (!overlay) return;
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  };

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
    } catch (e) {}

    const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

    footer.innerHTML = `
      <div class="dash-user-card">
        <div class="dash-user-avatar">${initials}</div>
        <div class="dash-user-info">
          <div class="dash-user-name">${name}</div>
        </div>
        <button class="dash-logout-btn" onclick="logout()" title="Sair">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    `;

    // Also put logout in config panel
    const configLogout = document.getElementById("nav-config-logout");
    if (configLogout) {
      configLogout.innerHTML = `
        <div class="nav-config-user">
          <div class="dash-user-avatar" style="width:36px;height:36px;font-size:.8rem">${initials}</div>
          <div style="flex:1">
            <div style="font-weight:700;font-size:.9rem">${name}</div>
            <div style="font-size:.72rem;color:var(--dash-accent)">Acesso Completo</div>
          </div>
          <button onclick="logout()" class="nav-config-logout-btn">Sair</button>
        </div>
      `;
    }
  };
})();
