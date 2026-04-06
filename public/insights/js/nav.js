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
    const sidebar = nav.closest(".dash-sidebar");

    const activeIndex = links.findIndex(l => l.id === activeId);
    const isActiveInMore = activeIndex >= MOBILE_MAX;

    // Desktop: all links inside nav
    nav.innerHTML = links.map((l, i) => {
      const isActive = l.id === activeId;
      const mobileClass = i >= MOBILE_MAX ? "nav-more-item" : "nav-main-item";
      return `<a href="${l.href}" class="${isActive ? "active" : ""} ${mobileClass}">
        <span class="nav-icon">${l.icon}</span>
        <span class="nav-text">${l.label}</span>
        <span class="nav-short">${l.shortLabel}</span>
      </a>`;
    }).join("");

    // Remove old mobile elements if they exist
    const oldBtn = sidebar.querySelector(".nav-more-btn");
    const oldDrop = sidebar.querySelector(".nav-more-dropdown");
    if (oldBtn) oldBtn.remove();
    if (oldDrop) oldDrop.remove();

    // "More" button — appended to sidebar, not inside nav
    const moreBtn = document.createElement("button");
    moreBtn.className = "nav-more-btn" + (isActiveInMore ? " active" : "");
    moreBtn.id = "nav-more-toggle";
    moreBtn.innerHTML = `<span class="nav-icon">☰</span><span class="nav-short">Mais</span>`;
    moreBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMoreMenu();
    });
    sidebar.appendChild(moreBtn);

    // "More" dropdown — appended to sidebar
    const moreDropdown = document.createElement("div");
    moreDropdown.className = "nav-more-dropdown";
    moreDropdown.id = "nav-more-dropdown";
    moreDropdown.innerHTML = links.slice(MOBILE_MAX).map(l => {
      const isActive = l.id === activeId;
      return `<a href="${l.href}" class="nav-more-link ${isActive ? "active" : ""}">
        <span class="nav-icon">${l.icon}</span>
        <span>${l.label}</span>
      </a>`;
    }).join("");
    sidebar.appendChild(moreDropdown);
  };

  window.toggleMoreMenu = function () {
    const dropdown = document.getElementById("nav-more-dropdown");
    const btn = document.getElementById("nav-more-toggle");
    if (!dropdown || !btn) return;

    const isOpen = dropdown.classList.contains("open");
    dropdown.classList.toggle("open");
    btn.classList.toggle("expanded");

    if (!isOpen) {
      const close = function (e) {
        if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
          dropdown.classList.remove("open");
          btn.classList.remove("expanded");
          document.removeEventListener("click", close);
        }
      };
      setTimeout(function () {
        document.addEventListener("click", close);
      }, 50);
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
