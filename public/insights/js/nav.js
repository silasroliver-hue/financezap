(function () {
  // SVG icon helpers
  const SVG = {
    home:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    plus:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
    chart:   `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    menu:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
    trend:   `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
    calendar:`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    bank:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg>`,
    tag:     `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    card:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
  };

  // Itens principais (aparecem na tab bar mobile — max 4)
  const mainLinks = [
    { href: "index.html",      id: "dash",    label: "Dashboard",      shortLabel: "Inicio",  icon: SVG.home  },
    { href: "gastos.html",     id: "gastos",  label: "Movimentacoes",  shortLabel: "Movs",    icon: SVG.plus  },
    { href: "cartoes.html",    id: "cartoes", label: "Cartoes",        shortLabel: "Cartao",  icon: SVG.card  },
    { href: "categorias.html", id: "cat",     label: "Categorias",     shortLabel: "Categorias", icon: SVG.tag },
  ];

  // Itens que ficam dentro do painel "Menu"
  const configLinks = [
    { href: "pagamentos.html",  id: "pay", label: "Contas do mes", icon: SVG.calendar },
    { href: "relatorios.html",  id: "reports", label: "Relatorios", icon: SVG.chart },
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
    configBtn.innerHTML = `<span class="nav-icon">${SVG.menu}</span><span class="nav-short">Menu</span>`;
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
      if (typeof window.getAuthHeader === "function" && typeof window.insightApiJson === "function") {
        const headers = await window.getAuthHeader();
        const r = await window.insightApiJson("/profile", { headers });
        if (r && r.res.ok && r.data && r.data.full_name) name = r.data.full_name;
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
