"use strict";

const pages = [
  { id: "getting-started", title: "Getting started", file: "getting-started.html", group: "Start" },
  { id: "create", title: "Create a wiki", file: "create.html", group: "Create" },
  { id: "anchors", title: "Claims and anchors", file: "anchors.html", group: "Create" },
  { id: "diagrams", title: "Flow diagrams", file: "diagrams.html", group: "Create" },
  { id: "drift", title: "Drift and review", file: "drift.html", group: "Review" },
  { id: "improve", title: "Improve loop", file: "improve.html", group: "Improve" },
  { id: "hooks", title: "Hooks and gates", file: "hooks.html", group: "Improve" },
  { id: "reference", title: "CLI reference", file: "reference.html", group: "Reference" },
  { id: "principles", title: "Design principles", file: "principles.html", group: "Reference" },
];

const logo = `
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <rect width="100" height="100" rx="24" fill="#16241E"></rect>
    <g fill="none" stroke-linecap="round">
      <path d="M42 82V55M42 55V18" stroke="#ECE7D9" stroke-width="7"></path>
      <path d="M42 55q7-9 14 0t14 0t14 0" stroke="#67C1E0" stroke-width="7"></path>
    </g>
    <path d="m36 69 6 8 6-8" fill="#ECE7D9"></path>
    <path d="m36 31 6 8 6-8" fill="#ECE7D9"></path>
    <circle cx="42" cy="55" r="7" fill="#F4B84E"></circle>
  </svg>`;

function currentPage() {
  return document.body.dataset.page || "home";
}

function headerMarkup() {
  const page = currentPage();
  return `
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="site-header">
      <div class="site-shell site-header-inner">
        <a class="site-brand" href="index.html" aria-label="Fey home">${logo}<span>fey</span></a>
        <nav class="site-nav" aria-label="Primary navigation">
          <a href="index.html#product">Product</a>
          <a href="principles.html"${page === "principles" ? ' aria-current="page"' : ""}>Principles</a>
          <a href="getting-started.html"${page !== "home" && page !== "principles" ? ' aria-current="page"' : ""}>Docs</a>
          <a class="header-github" href="https://github.com/abpatramsft/fey" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18A10.98 10.98 0 0 1 12 6.09c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>
            GitHub
          </a>
          <a class="header-cta" href="getting-started.html">Install</a>
        </nav>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="mobile-nav" aria-label="Open navigation"><span></span></button>
      </div>
    </header>
    <nav class="mobile-nav" id="mobile-nav" aria-label="Mobile navigation">
      <a href="index.html#product">Product</a>
      <a href="principles.html">Principles</a>
      <a href="getting-started.html">Documentation</a>
      <a href="https://github.com/abpatramsft/fey">GitHub</a>
    </nav>`;
}

function sidebarMarkup() {
  const groups = [...new Set(pages.map((page) => page.group))];
  const current = currentPage();
  return `<button class="docs-sidebar-close" type="button" data-doc-close aria-label="Close documentation menu">Close menu</button>` +
  groups.map((group) => `
    <section class="docs-nav-group">
      <h2>${group}</h2>
      ${pages.filter((page) => page.group === group).map((page) =>
        `<a href="${page.file}"${page.id === current ? ' class="is-active" aria-current="page"' : ""}>${page.title}</a>`
      ).join("")}
    </section>`
  ).join("");
}

function footerMarkup() {
  return `
    <footer class="site-footer">
      <div class="site-shell site-footer-inner">
        <div class="footer-brand">
          <a class="site-brand" href="index.html">${logo}<span>fey</span></a>
          <p>Explain what the code can prove. Keep the evidence local, readable, and under version control.</p>
        </div>
        <div class="footer-group">
          <h3>Product</h3>
          <a href="create.html">Create</a>
          <a href="improve.html">Improve</a>
          <a href="hooks.html">Gates</a>
        </div>
        <div class="footer-group">
          <h3>Project</h3>
          <a href="getting-started.html">Documentation</a>
          <a href="https://github.com/abpatramsft/fey">GitHub</a>
          <a href="https://github.com/abpatramsft/fey/issues">Issues</a>
        </div>
      </div>
      <div class="site-shell footer-bottom">
        <span>Fey is an early-stage public project.</span>
        <span>Built for GitHub Copilot CLI · <span data-year></span></span>
      </div>
    </footer>`;
}

function initChrome() {
  const header = document.querySelector("[data-site-header]");
  if (header) header.innerHTML = headerMarkup();
  const sidebar = document.querySelector("[data-doc-sidebar]");
  if (sidebar) sidebar.innerHTML = sidebarMarkup();
  const footer = document.querySelector("[data-site-footer]");
  if (footer) footer.innerHTML = footerMarkup();
  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = new Date().getFullYear();
  });
}

function initNavigation() {
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".mobile-nav");
  const docsSidebar = document.querySelector(".docs-sidebar");
  const docsBackdrop = document.querySelector(".docs-menu-backdrop");
  const docsMain = document.querySelector(".docs-main");
  const docsControls = document.querySelector(".mobile-doc-controls");
  const header = document.querySelector(".site-header");
  let lastDocTrigger = null;

  const syncBodyLock = () => {
    const open = !!(nav && nav.classList.contains("is-open")) ||
      !!(docsSidebar && docsSidebar.classList.contains("is-open"));
    document.body.classList.toggle("nav-open", open);
  };

  const setMobileNav = (open, returnFocus = true) => {
    if (!toggle || !nav) return;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    nav.classList.toggle("is-open", open);
    syncBodyLock();
    if (open) {
      const first = nav.querySelector("a");
      if (first) window.setTimeout(() => first.focus(), 0);
    } else if (returnFocus) {
      toggle.focus();
    }
  };

  const setDocsOpen = (open, trigger = null, returnFocus = true) => {
    if (!docsSidebar || !docsBackdrop) return;
    if (open && trigger) lastDocTrigger = trigger;
    docsSidebar.classList.toggle("is-open", open);
    docsBackdrop.classList.toggle("is-open", open);
    document.querySelectorAll("[data-doc-menu]").forEach((button) => button.setAttribute("aria-expanded", String(open)));
    if (docsMain) docsMain.inert = open;
    if (docsControls) docsControls.inert = open;
    if (header) header.inert = open;
    syncBodyLock();
    if (open) {
      const first = docsSidebar.querySelector("[data-doc-close], a");
      if (first) window.setTimeout(() => first.focus(), 0);
    } else if (returnFocus && lastDocTrigger) {
      lastDocTrigger.focus();
    }
  };

  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      setMobileNav(open);
    });
  }

  document.querySelectorAll("[data-doc-menu]").forEach((button) => {
    button.addEventListener("click", () => setDocsOpen(!docsSidebar.classList.contains("is-open"), button));
  });
  document.querySelectorAll("[data-doc-close]").forEach((button) => {
    button.addEventListener("click", () => setDocsOpen(false));
  });
  if (docsBackdrop) {
    docsBackdrop.addEventListener("click", () => setDocsOpen(false));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (docsSidebar && docsSidebar.classList.contains("is-open")) {
        event.preventDefault();
        setDocsOpen(false);
      } else if (nav && nav.classList.contains("is-open")) {
        event.preventDefault();
        setMobileNav(false);
      }
      return;
    }
    if (event.key !== "Tab" || !docsSidebar || !docsSidebar.classList.contains("is-open")) return;
    const focusable = [...docsSidebar.querySelectorAll('button:not([disabled]), a[href]')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const desktop = window.matchMedia("(min-width: 921px)");
  const resetForDesktop = (event) => {
    if (!event.matches) return;
    setMobileNav(false, false);
    setDocsOpen(false, null, false);
  };
  if (desktop.addEventListener) desktop.addEventListener("change", resetForDesktop);
  else desktop.addListener(resetForDesktop);
}

function initCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((container) => {
    const button = container.querySelector(".copy-button");
    const code = container.querySelector("code") || container.querySelector("pre");
    if (!button || !code) return;
    button.addEventListener("click", async () => {
      const text = container.dataset.copyText || code.textContent;
      await navigator.clipboard.writeText(text.trim());
      const original = button.textContent;
      button.textContent = "Copied";
      button.classList.add("copied");
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove("copied");
      }, 1500);
    });
  });
}

function initTabs() {
  document.querySelectorAll("[data-tab-group]").forEach((group) => {
    const buttons = [...group.querySelectorAll("[data-tab]")];
    const panels = [...group.querySelectorAll("[data-tab-panel]")];
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.tab;
        buttons.forEach((item) => {
          const active = item === button;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-selected", String(active));
        });
        panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.tabPanel === id));
      });
    });
  });
}

function initAnchorDemo() {
  const stage = document.querySelector("[data-anchor-stage]");
  if (!stage) return;
  const tabs = [...stage.querySelectorAll("[data-anchor-mode]")];
  const panes = [...stage.querySelectorAll("[data-evidence]")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.anchorMode;
      stage.dataset.mode = mode;
      tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      });
      panes.forEach((pane) => pane.classList.toggle("is-active", pane.dataset.evidence === mode));
      const claim = stage.querySelector(`[data-claim="${mode}"]`);
      stage.querySelectorAll("[data-claim]").forEach((item) => {
        item.hidden = item !== claim;
      });
    });
  });
}

function initViewSwitcher() {
  const stage = document.querySelector("[data-view-stage]");
  if (!stage) return;
  const tabs = [...stage.querySelectorAll("[data-view-tab]")];
  const panels = [...stage.querySelectorAll("[data-view-panel]")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.viewTab;
      tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      });
      panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.viewPanel === id));
    });
  });
}

function initToc() {
  const toc = document.querySelector("[data-doc-toc]");
  const content = document.querySelector("[data-doc-content]");
  if (!toc || !content) return;
  const headings = [...content.querySelectorAll("h2[id], h3[id]")];
  if (!headings.length) {
    toc.hidden = true;
    return;
  }
  toc.innerHTML = `<h2>In this section</h2>${headings.map((heading) =>
    `<a href="#${heading.id}" data-level="${heading.tagName === "H3" ? "3" : "2"}">${heading.textContent}</a>`
  ).join("")}`;
  const links = [...toc.querySelectorAll("a")];
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (!visible.length) return;
    const id = visible[0].target.id;
    links.forEach((link) => link.classList.toggle("is-active", link.hash === `#${id}`));
  }, { rootMargin: "-18% 0px -68% 0px", threshold: 0 });
  headings.forEach((heading) => observer.observe(heading));
}

function initDocPager() {
  const pager = document.querySelector("[data-doc-pager]");
  const mobile = document.querySelector("[data-mobile-doc-controls]");
  if (!pager && !mobile) return;
  const index = pages.findIndex((page) => page.id === currentPage());
  if (index < 0) return;
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (pager) {
    pager.innerHTML = `
      ${previous ? `<a class="pager-link" href="${previous.file}"><span>Previous</span><strong>${previous.title}</strong></a>` : "<span></span>"}
      ${next ? `<a class="pager-link" href="${next.file}"><span>Next</span><strong>${next.title}</strong></a>` : "<span></span>"}`;
  }
  if (mobile) {
    mobile.innerHTML = `
      ${previous ? `<a href="${previous.file}" aria-label="Previous: ${previous.title}">← ${previous.title}</a>` : "<span></span>"}
      <button type="button" data-doc-menu aria-expanded="false">Menu</button>
      ${next ? `<a href="${next.file}" aria-label="Next: ${next.title}">${next.title} →</a>` : "<span></span>"}`;
  }
}

initChrome();
initDocPager();
initNavigation();
initCopyButtons();
initTabs();
initAnchorDemo();
initViewSwitcher();
initToc();
