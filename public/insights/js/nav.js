(function () {
  const links = [
    { href: "index.html",        id: "dash",    label: "Dashboard",     shortLabel: "Home",      icon: "📊" },
    { href: "lancamentos.html",  id: "lanc",    label: "Lancamentos",   shortLabel: "Lancar",    icon: "✏️" },
    { href: "gastos.html",       id: "gastos",  label: "Gastos",        shortLabel: "Gastos",    icon: "💸" },
    { href: "investimentos.html",id: "inv",     label: "Investimentos", shortLabel: "Invest.",   icon: "📈" },
    { href: "pagamentos.html",   id: "pay",     label: "Contas do mes", shortLabel: "Contas",    icon: "🗓️" },
    { href: "contas.html",       id: "contas",  label: "Bancos",        shortLabel: "Bancos",    icon: "🏦" },
    { href: "categorias.html",   id: "cat",     label: "Categorias",    shortLabel: "Categ.",    icon: "🏷️" },
    { href: "cartoes.html",      id: "cartoes", label: "Cartoes",       shortLabel: "Cartoes",   icon: "💳" },
  ];

  // Mobile: only show first 4 + "More" button
  const MOBILE_MAX = 4;

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

    // Check if active item is beyond mobile limit
    const activeIndex = links.findIndex(l => l.id === activeId);
    const isActiveInMore = activeIndex >= MOBILE_MAX;

    const html = links.map((l, i) => {
      const isActive = l.id === activeId;
      // On mobile: hide items beyond MOBILE_MAX (CSS handles this)
      const mobileClass = i >= MOBILE_MAX ? "nav-more-item" : "nav-main-item";
      return `<a href="${l.href}" class="${isActive ? "active" : ""} ${mobileClass}" data-index="${i}">
        <span class="nav-icon">${l.icon}</span>
        <span class="nav-text">${l.label}</span>
        <span class="nav-short">${l.shortLabel}</span>
      </a>`;
    }).join("");

    // Add "More" toggle button for mobile
    const moreActive = isActiveInMore ? "active" : "";
    const moreBtn = `<button class="nav-more-btn ${moreActive}" id="nav-more-toggle" onclick="toggleMoreMenu()">
      <span class="nav-icon">☰</span>
      <span class="nav-short">Mais</span>
    </button>`;

    // More dropdown (hidden by default)
    const moreDropdown = `<div class="nav-more-dropdown" id="nav-more-dropdown">
      ${links.slice(MOBILE_MAX).map(l => {
        const isActive = l.id === activeId;
        return `<a href="${l.href}" class="nav-more-link ${isActive ? "active" : ""}">
          <span class="nav-icon">${l.icon}</span>
          <span>${l.label}</span>
        </a>`;
      }).join("")}
    </div>`;

    nav.innerHTML = html + moreBtn + moreDropdown;
  };

  // Toggle "More" dropdown on mobile
  window.toggleMoreMenu = function () {
    const dropdown = document.getElementById("nav-more-dropdown");
    const btn = document.getElementById("nav-more-toggle");
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains("open");
    dropdown.classList.toggle("open");
    btn.classList.toggle("expanded");

    // Close on outside click
    if (!isOpen) {
      setTimeout(() => {
        const close = (e) => {
          if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            dropdown.classList.remove("open");
            btn.classList.remove("expanded");
            document.removeEventListener("click", close);
          }
        };
        document.addEventListener("click", close);
      }, 10);
    }
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
    } catch (e) { /* silencia */ }

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
  };
})();
