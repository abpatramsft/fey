"use strict";
// fey viewer SPA. Three views on a hash router. The signature interaction:
// selecting a wiki claim lights the exact code lines it is anchored to.

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---- minimal markdown ----
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
// GFM table helpers
const tableRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const tableDelim = (l) => { const c = tableRow(l); return c.length > 0 && c.every((x) => /^:?-{1,}:?$/.test(x)); };
const tableAlign = (c) => { const s = (c || "").trim(); const L = s.startsWith(":"), R = s.endsWith(":"); return L && R ? "center" : R ? "right" : L ? "left" : ""; };
const alignAttr = (a) => (a ? ` style="text-align:${a}"` : "");
function md(text) {
  const lines = (text || "").split(/\r?\n/);
  let out = "", para = [], listType = null, quote = [];
  const flushPara = () => { if (para.length) { out += `<p>${inline(para.join(" "))}</p>`; para = []; } };
  const closeList = () => { if (listType) { out += listType === "ol" ? "</ol>" : "</ul>"; listType = null; } };
  const closeQuote = () => {
    if (!quote.length) return;
    let body = quote.join(" ").trim();
    let ic = "Note";
    const m = body.match(/^([A-Za-z][A-Za-z ]{1,18}):\s*(.*)$/);
    if (m) { ic = m[1]; body = m[2]; }
    out += `<div class="callout"><div class="ic">${esc(ic)}</div><div class="txt"><p>${inline(body)}</p></div></div>`;
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // fenced code block — tolerant of an unterminated fence while streaming
    const fence = raw.match(/^\s*(`{3,})\s*([\w.+-]*)\s*$/);
    if (fence) {
      flushPara(); closeList(); closeQuote();
      const lang = fence[2] || "";
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*`{3,}\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      out += `<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`;
      continue; // i sits on the closing fence (or EOF); loop's ++ steps past it
    }
    const line = raw.trim();
    if (/^>\s?/.test(line)) { flushPara(); closeList(); quote.push(line.replace(/^>\s?/, "")); continue; }
    closeQuote();
    if (!line) { flushPara(); closeList(); continue; }
    // GFM table — header row followed by a delimiter row (|---|---|)
    if (line.includes("|") && i + 1 < lines.length && tableDelim(lines[i + 1])) {
      flushPara(); closeList();
      const headers = tableRow(line);
      const aligns = tableRow(lines[i + 1]).map(tableAlign);
      i++; // consume delimiter row
      const body = [];
      while (i + 1 < lines.length) {
        const peek = lines[i + 1];
        if (!peek.trim() || !peek.includes("|") || tableDelim(peek)) break;
        body.push(tableRow(peek)); i++;
      }
      let t = "<table><thead><tr>";
      headers.forEach((h, k) => { t += `<th${alignAttr(aligns[k])}>${inline(h)}</th>`; });
      t += "</tr></thead><tbody>";
      for (const r of body) {
        t += "<tr>";
        for (let k = 0; k < headers.length; k++) t += `<td${alignAttr(aligns[k])}>${inline(r[k] || "")}</td>`;
        t += "</tr>";
      }
      out += t + "</tbody></table>";
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const lv = Math.min(h[1].length + 1, 4); out += `<h${lv}>${inline(h[2])}</h${lv}>`; continue; }
    const ol = line.match(/^(\d{1,3})[.)]\s+(.*)$/);
    if (ol) { flushPara(); if (listType !== "ol") { closeList(); out += "<ol>"; listType = "ol"; } out += `<li>${inline(ol[2])}</li>`; continue; }
    if (/^[-*+]\s+/.test(line)) { flushPara(); if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; } out += `<li>${inline(line.replace(/^[-*+]\s+/, ""))}</li>`; continue; }
    para.push(line);
  }
  flushPara(); closeList(); closeQuote();
  return out;
}

// Copilot's headless replies open with a little narration ("Let me read…") before the
// real answer. Fold that leading narration into a compact, collapsible steps trace so the
// final answer stays clean, and stream the answer body through the shared markdown renderer.
function splitAnswer(text) {
  const lines = (text || "").split(/\r?\n/);
  const isMarker = (l) => /^(#{1,6}\s|`{3,}|>\s|\||\*\*)/.test(l) || /^\s*([-*+]\s|\d{1,3}[.)]\s)/.test(l);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { const l = lines[i].trim(); if (!l) continue; if (isMarker(l)) { idx = i; break; } }
  if (idx <= 0) return { steps: [], answer: text };
  const steps = lines.slice(0, idx).map((s) => s.trim()).filter(Boolean);
  if (!steps.length || !steps.every((s) => s.length < 200)) return { steps: [], answer: text };
  return { steps, answer: lines.slice(idx).join("\n") };
}
function renderAsk(acc, streaming) {
  const { steps, answer } = splitAnswer(acc);
  const hasAnswer = answer.trim().length > 0;
  let html = "";
  if (steps.length) {
    const label = hasAnswer ? `Copilot read the code · ${steps.length} step${steps.length > 1 ? "s" : ""}` : "Reading the code";
    html += `<details class="ask-steps"${hasAnswer ? "" : " open"}>` +
      `<summary><span class="ask-steps-ic">✦</span><span>${label}</span>${!hasAnswer && streaming ? '<span class="ask-dots">…</span>' : ""}</summary>` +
      `<ul>${steps.map((s) => `<li>${inline(s)}</li>`).join("")}</ul></details>`;
  }
  if (hasAnswer) html += `<div class="ask-body">${md(answer)}${streaming ? '<span class="ask-caret"></span>' : ""}</div>`;
  else if (!steps.length) html += `<div class="ask-body"><span class="ask-thinking">Thinking<span class="ask-dots">…</span></span></div>`;
  return html;
}

// ---- state ----
const S = { nav: null, view: "overview", pageId: null, page: null, currentFile: null, activeBlock: null, fileCache: {}, collapsed: {}, hasWiki: true, hasOpt: false };

// flat page order across sections — used for the numbered eyebrow
function pageOrder() {
  const flat = [];
  (S.nav.sections || []).forEach((sec) => sec.pages.forEach((p) => flat.push({ ...p, section: sec.section })));
  return flat;
}

// ---- shell ----
async function loadNav() {
  S.nav = await api("/api/nav");
  $("#repo-chip").textContent = S.nav.repoName;
  const badge = $("#drift-badge");
  if (S.nav.driftCount > 0) { badge.hidden = false; badge.textContent = S.nav.driftCount; }
  else badge.hidden = true;
  renderRail();
}
function renderRail() {
  const nav = $("#wiki-nav"); nav.innerHTML = "";
  const q = ($("#search").value || "").toLowerCase();
  for (const sec of S.nav.sections) {
    const pages = sec.pages.filter((p) => !q || p.title.toLowerCase().includes(q));
    if (!pages.length) continue;
    const collapsed = !!S.collapsed[sec.section] && !q;
    const head = el("button", "nav-section" + (collapsed ? " collapsed" : ""));
    head.innerHTML = `<span class="chev">▾</span><span>${esc(sec.section)}</span><span class="count">${pages.length}</span>`;
    const group = el("div", "nav-group" + (collapsed ? " hidden" : ""));
    head.onclick = () => { S.collapsed[sec.section] = !S.collapsed[sec.section]; renderRail(); };
    nav.appendChild(head);
    for (const p of pages) {
      const item = el("div", "nav-item" + (S.view === "wiki" && S.pageId === p.id ? " active" : ""));
      item.innerHTML = `<span>${esc(p.title)}</span><span class="status ${p.drifted ? "drift" : ""}" title="${p.drifted ? "code changed under this page" : "anchors verified"}"></span>`;
      item.onclick = () => (location.hash = `#/wiki/${p.id}`);
      group.appendChild(item);
    }
    nav.appendChild(group);
  }
  const foot = $("#rail-foot");
  foot.innerHTML = `
    <div class="foot-line"><span>${S.nav.fileCount} files · ${S.nav.pageCount} pages</span><span class="cov">${S.nav.coverage}% anchored</span></div>
    <div class="foot-bar"><span style="width:${S.nav.coverage}%"></span></div>`;
}
function setTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === S.view));
}
// Tabs light up only for the bundles that exist: Overview/Wiki/Diagrams/Drift need
// the fey-create bundle; Optimize needs a fey-improve run. A missing bundle greys
// its tabs out (and explains why on hover) instead of erroring.
function applyTabAvailability() {
  document.querySelectorAll(".tab").forEach((t) => {
    const v = t.dataset.view;
    const needsWiki = v === "overview" || v === "wiki" || v === "diagrams" || v === "drift";
    const ok = needsWiki ? S.hasWiki : (v === "optimize" ? S.hasOpt : true);
    t.classList.toggle("disabled", !ok);
    if (!ok) t.setAttribute("title", needsWiki
      ? "Run the fey:create skill to generate the Overview, Wiki, Diagrams and Drift views"
      : "Run the olo:improve skill to start an optimization run");
    else t.removeAttribute("title");
  });
}

// ---- router ----
async function route() {
  const fallback = S.hasWiki ? "#/overview" : (S.hasOpt ? "#/optimize" : "#/overview");
  const [, view, pageId] = (location.hash || fallback).split("/");
  S.view = view || (S.hasWiki ? "overview" : "optimize");
  if (typeof closeAsk === "function") closeAsk();
  document.querySelector(".body").classList.toggle("rail-hidden", S.view !== "wiki");
  const stage = $("#stage");
  stage.innerHTML = '<div class="loading">Loading…</div>';
  setTabs();
  // A view whose bundle isn't generated yet gets a friendly empty state, not a 404.
  const wikiView = S.view === "overview" || S.view === "wiki" || S.view === "diagrams" || S.view === "drift";
  if (wikiView && !S.hasWiki) {
    stage.innerHTML = "";
    stage.appendChild(el("div", "scroll view-fade", emptyState("No wiki bundle yet",
      "The Overview, Wiki, Diagrams and Drift views come from <strong>fey-create</strong>. Run the <code>fey:create</code> skill on this repo to generate them" +
      (S.hasOpt ? " — meanwhile, the <strong>Optimize</strong> tab is ready." : "."))));
    return;
  }
  try {
    if (S.view === "wiki") { S.pageId = pageId || (S.nav.sections[0] && S.nav.sections[0].pages[0].id); await renderWiki(); }
    else if (S.view === "diagrams") await renderDiagrams(pageId);
    else if (S.view === "drift") await renderDrift();
    else if (S.view === "optimize") await renderOptimize();
    else await renderOverview();
    renderRail();
  } catch (e) {
    stage.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

// ---- overview ----
function bar(pct) {
  const cls = pct >= 75 ? "" : pct >= 50 ? "mid" : "low";
  return `<div class="bar ${cls}"><span style="width:${pct}%"></span></div><span class="pct">${pct}%</span>`;
}
async function renderOverview() {
  const o = await api("/api/overview");
  const stage = $("#stage");
  const stats = [
    ["Files indexed", o.stats.filesIndexed, ""],
    ["Wiki pages", o.stats.wikiPages, ""],
    ["Lines anchored", o.stats.linesAnchoredPct + "%", "teal"],
    ["Pages drifted", o.stats.drifted, o.stats.drifted ? "warn" : ""],
  ];
  const arch = o.architecture.map((g) => `
    <div class="arch-group">
      <div><div class="arch-name">${esc(g.group)}</div><div class="arch-path">${esc(g.path || "")}</div></div>
      <div class="arch-files">
        ${g.files.map((f) => `<div class="arch-file"><div class="fname">${esc(f.file.split("/").pop())}</div>${bar(f.coverage)}</div>`).join("")}
      </div>
    </div>`).join("");

  // START HERE — a genuine reading sequence, so the numbering carries meaning
  const path = (o.pages || []).slice(0, 3).map((p, i) => `
    <a class="path-card" href="#/wiki/${p.id}">
      <div class="path-num">${String(i + 1).padStart(2, "0")}</div>
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.blurb || "")}</p>
      <div class="path-meta"><span>${esc(p.section)}</span><span>·</span><span>${p.sources} source${p.sources === 1 ? "" : "s"}</span><span class="arrow">→</span></div>
    </a>`).join("");
  const driftCard = o.drift && o.drift.count
    ? `<a class="path-card drift" href="#/drift">
        <div class="path-num">DRIFT</div>
        <h3>${o.drift.count} change${o.drift.count === 1 ? "" : "s"} to reconcile</h3>
        <p>The working tree has uncommitted edits under documented code. Re-verify the affected claims before you trust them.</p>
        <div class="path-meta"><span>Review drift</span><span class="arrow">→</span></div>
      </a>`
    : "";

  const view = el("div", "scroll view-fade");
  view.innerHTML = `
    <div class="ov">
      <div class="eyebrow">Repository</div>
      <h1 class="ov-title">${esc(o.repoName)}</h1>
      <p class="ov-desc">${esc(o.description)}</p>
      <div class="stat-row">
        ${stats.map(([k, v, c]) => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v ${c}">${v}</div></div>`).join("")}
      </div>

      <div class="arch">
        <div class="section-head"><span class="section-label">Architecture</span><h2>How the code is laid out</h2><span class="section-note">${esc(o.strategy || "")} layout</span></div>
        ${arch}
      </div>

      <div class="starthere">
        <div class="section-head"><span class="section-label">Start here</span><h2>A path through the codebase</h2><span class="section-note">read top to bottom</span></div>
        <div class="path">${path}${driftCard}</div>
      </div>
    </div>`;
  stage.innerHTML = ""; stage.appendChild(view);
}

// ---- wiki ----
async function getFile(pathRel) {
  if (S.fileCache[pathRel]) return S.fileCache[pathRel];
  const f = await api(`/api/file?path=${encodeURIComponent(pathRel)}`);
  S.fileCache[pathRel] = f; return f;
}
async function renderWiki() {
  S.page = await api(`/api/page/${S.pageId}`);
  S.fileCache = {};
  const stage = $("#stage");
  const wrap = el("div", "wiki view-fade");
  wrap.innerHTML = `
    <div class="doc"><div class="scroll"><div class="doc-inner" id="doc-inner"></div></div></div>
    <div class="code">
      <div class="code-head"><span class="status-dot"></span><span class="fname" id="code-file">—</span><span class="hint">click a line → its explanation</span></div>
      <div class="code-scroll" id="code-scroll"></div>
    </div>`;
  stage.innerHTML = ""; stage.appendChild(wrap);

  const inner = $("#doc-inner", wrap);
  const sources = S.page.sources.join(", ") || "—";
  inner.appendChild(elHead(sources));
  S.page.blocks.forEach((b) => inner.appendChild(renderBlock(b)));
  inner.appendChild(verifyFoot());

  const first = S.page.blocks.find((b) => b.anchors.length);
  if (first) activateBlock(first.id);
}
function elHead(sources) {
  const order = pageOrder();
  const idx = order.findIndex((p) => p.id === S.pageId);
  const num = idx >= 0 ? String(idx + 1).padStart(2, "0") : "01";
  const head = el("div");
  head.innerHTML = `
    <div class="doc-kicker eyebrow">${esc(S.page.section)} <span class="num">· ${num}</span></div>
    <div class="doc-title-row">
      <h1 class="doc-title">${esc(S.page.title)}</h1>
      <button class="page-ask" title="Ask Copilot about this whole page">✦ ask</button>
    </div>
    <div class="doc-intro">${md((S.page.intro || "").replace(/^\s*#\s+.*(\r?\n)?/, ""))}</div>
    <div class="meta-strip">
      <div><div class="k">Sources</div><div class="v">${esc(sources)}</div></div>
      <div><div class="k">Anchors</div><div class="v">${S.page.anchorCount} line ranges</div></div>
      <div><div class="k">Claims</div><div class="v">${S.page.blocks.length}</div></div>
    </div>`;
  $(".page-ask", head).onclick = () => {
    const sel = (window.getSelection && window.getSelection().toString()) || "";
    openAsk({ id: null, anchors: S.page.blocks.flatMap((b) => b.anchors) }, sel);
  };
  return head;
}
function verifyFoot() {
  const foot = el("div", "verify-foot");
  const render = () => {
    foot.innerHTML = `
      <div class="vf-head">
        <span class="vf-q">Is this page accurate against the code?</span>
        <span class="vf-acts"><button class="vf-confirm">Confirm</button><button class="vf-flag">Flag an issue</button></span>
      </div>
      <form class="vf-form hidden">
        <textarea class="vf-text" rows="3" placeholder="What's off on this page? e.g. “the retry behaviour described here no longer matches place_order”."></textarea>
        <div class="vf-form-acts"><button type="button" class="vf-cancel">Cancel</button><button type="submit" class="vf-save">Save note</button></div>
      </form>
      <div class="vf-notes">${renderPageNotes(S.page.notes)}</div>`;
    const form = $(".vf-form", foot);
    $(".vf-flag", foot).onclick = () => { form.classList.toggle("hidden"); if (!form.classList.contains("hidden")) $(".vf-text", foot).focus(); };
    $(".vf-cancel", foot).onclick = () => form.classList.add("hidden");
    $(".vf-confirm", foot).onclick = async (e) => {
      e.currentTarget.disabled = true;
      const r = await api(`/api/page-note/${S.pageId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "confirm", text: "" }) });
      S.page.notes = r.notes; render();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = $(".vf-text", foot).value.trim();
      if (!text) { form.classList.add("hidden"); return; }
      const r = await api(`/api/page-note/${S.pageId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "flag", text }) });
      S.page.notes = r.notes; render();
    };
  };
  render();
  return foot;
}
function ago(iso) {
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
}
function renderPageNotes(notes) {
  const list = notes || [];
  const flags = list.filter((n) => n.type === "flag");
  const lastConfirm = [...list].reverse().find((n) => n.type === "confirm");
  let html = "";
  if (lastConfirm && (!flags.length || new Date(lastConfirm.at) > new Date(flags[flags.length - 1].at)))
    html += `<div class="pn-confirm">✓ Confirmed accurate · ${ago(lastConfirm.at)}</div>`;
  if (flags.length)
    html += `<div class="pn-flags"><div class="pn-flags-head">Reader notes</div>${flags.slice().reverse().map((f) => `<div class="pn-flag"><p>${inline(f.text)}</p><span class="pn-when">${ago(f.at)}</span></div>`).join("")}</div>`;
  return html;
}
function renderBlock(b) {
  const node = el("div", "block");
  node.dataset.id = b.id;
  const chips = b.anchors.map((a) =>
    `<span class="ref-chip ${b.drifted ? "drift" : ""}" data-file="${esc(a.file)}" data-s="${a.startLine}" data-e="${a.endLine}">${esc(a.file.split("/").pop())}:${a.startLine}-${a.endLine}</span>`
  ).join("");
  node.innerHTML = `
    <div class="prose">${md(b.prose)}</div>
    <div class="chips">${chips}</div>
    <div class="block-tools">
      <button class="ask" title="Ask Copilot about this section">✦ ask</button>
      <button class="edit">✎ edit</button>
      <button class="lock ${b.locked ? "on" : ""}">${b.locked ? "🔒 locked" : "lock"}</button>
    </div>`;
  node.addEventListener("click", (e) => { if (e.target.closest(".block-tools")) return; activateBlock(b.id); });
  node.addEventListener("contextmenu", (e) => {
    const sel = (window.getSelection && window.getSelection().toString()) || "";
    e.preventDefault();
    activateBlock(b.id);
    openAsk(b, sel);
  });
  node.querySelectorAll(".ref-chip").forEach((c) =>
    c.addEventListener("click", (e) => { e.stopPropagation(); activateBlock(b.id); lightLines(c.dataset.file, +c.dataset.s, +c.dataset.e); })
  );
  $(".ask", node).onclick = (e) => { e.stopPropagation(); const sel = (window.getSelection && window.getSelection().toString()) || ""; openAsk(b, sel); };
  $(".edit", node).onclick = (e) => { e.stopPropagation(); startEdit(b, node); };
  $(".lock", node).onclick = (e) => { e.stopPropagation(); flag(b, "locked"); };
  return node;
}
// ---- interactive Q&A drawer (streams a headless copilot answer) ----
let ASK = { mode: "wiki", block: null, flow: null, diagram: null, controller: null };
function ensureAskPanel() {
  let panel = $("#ask-panel");
  if (panel) return panel;
  panel = el("div");
  panel.id = "ask-panel";
  panel.className = "ask-panel";
  panel.innerHTML = `
    <div class="ask-head">
      <div class="ask-ctx" id="ask-ctx"></div>
      <button class="ask-close" title="Close">✕</button>
    </div>
    <form class="ask-form" id="ask-form">
      <textarea class="ask-q" id="ask-q" rows="2" placeholder="Ask a clarifying question — e.g. “what does this change actually do, and why?”"></textarea>
      <div class="ask-form-acts">
        <span class="ask-hint">↵ to ask · Shift+↵ for newline</span>
        <button type="submit" class="ask-send">Ask ✦</button>
      </div>
    </form>
    <div class="ask-answer" id="ask-answer"><div class="ask-idle">Answers are generated locally by Copilot. It reads the relevant files in your repo — read-only — to answer in depth. No changes are made.</div></div>`;
  document.body.appendChild(panel);
  panel.querySelector(".ask-close").onclick = closeAsk;
  const form = panel.querySelector("#ask-form");
  const q = panel.querySelector("#ask-q");
  form.onsubmit = (e) => { e.preventDefault(); submitAsk(); };
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAsk(); } });
  // Clicking a frozen (already-asked) box starts a fresh question.
  q.addEventListener("focus", () => { if (q.readOnly) unfreezeAsk(); });
  return panel;
}
function unfreezeAsk() {
  const q = $("#ask-q"); if (!q) return;
  q.readOnly = false; q.classList.remove("frozen"); q.value = ""; q.focus();
  const send = $(".ask-send"); if (send) { send.textContent = "Ask ✦"; send.disabled = false; }
}
function openAsk(block, selection) {
  const panel = ensureAskPanel();
  ASK.mode = "wiki"; ASK.block = block; ASK.flow = null; ASK.diagram = null;
  ASK.selection = (selection || "").trim();
  const nAnchors = block.anchors.length;
  const files = [...new Set(block.anchors.map((a) => a.file.split("/").pop()))];
  const scopeLabel = block.id ? `${nAnchors} anchored range${nAnchors === 1 ? "" : "s"}` : `whole page · ${nAnchors} anchored ranges`;
  const sel = ASK.selection ? `<div class="ask-sel">“${esc(ASK.selection.slice(0, 220))}${ASK.selection.length > 220 ? "…" : ""}”</div>` : "";
  $("#ask-ctx").innerHTML = `
    <div class="ask-kicker">Ask about</div>
    <div class="ask-where">${esc(S.page.title)}</div>
    <div class="ask-scope">${scopeLabel}${files.length ? ` · ${esc(files.slice(0, 4).join(", "))}${files.length > 4 ? "…" : ""}` : ""}</div>
    ${sel}`;
  panel.classList.add("open");
  const q = $("#ask-q");
  q.readOnly = false; q.classList.remove("frozen"); q.value = "";
  const send = $(".ask-send"); if (send) { send.textContent = "Ask ✦"; send.disabled = false; }
  q.focus();
}
function openAskDiff(flow, selection) {
  const panel = ensureAskPanel();
  ASK.mode = "diff"; ASK.flow = flow; ASK.block = null; ASK.diagram = null;
  ASK.selection = (selection || "").trim();
  const files = [...new Set(flow.files.map((f) => f.file.split("/").pop()))];
  const authorTxt = flow.author === "ai" ? "AI-led change" : flow.author === "human" ? "Human edit" : flow.author === "mixed" ? "AI + human" : "change";
  const sel = ASK.selection ? `<div class="ask-sel">“${esc(ASK.selection.slice(0, 220))}${ASK.selection.length > 220 ? "…" : ""}”</div>` : "";
  $("#ask-ctx").innerHTML = `
    <div class="ask-kicker">Ask about this change</div>
    <div class="ask-where">${esc(flow.title)}</div>
    <div class="ask-scope">${authorTxt} · ${flow.fileCount} file${flow.fileCount === 1 ? "" : "s"}${files.length ? ` · ${esc(files.slice(0, 4).join(", "))}${files.length > 4 ? "…" : ""}` : ""}</div>
    ${sel}`;
  panel.classList.add("open");
  const q = $("#ask-q");
  q.readOnly = false; q.classList.remove("frozen"); q.value = "";
  const send = $(".ask-send"); if (send) { send.textContent = "Ask ✦"; send.disabled = false; }
  q.focus();
}
function openAskDiagram(diagram, selection) {
  const panel = ensureAskPanel();
  ASK.mode = "diagram"; ASK.diagram = diagram; ASK.block = null; ASK.flow = null;
  ASK.selection = (selection || "").trim();
  const files = [...new Set((diagram.sources || []).map((f) => f.split("/").pop()))];
  const nNodes = (diagram.nodes || []).length;
  const sel = ASK.selection ? `<div class="ask-sel">“${esc(ASK.selection.slice(0, 220))}${ASK.selection.length > 220 ? "…" : ""}”</div>` : "";
  $("#ask-ctx").innerHTML = `
    <div class="ask-kicker">Ask about this flow</div>
    <div class="ask-where">${esc(diagram.title)}</div>
    <div class="ask-scope">${esc(diagram.entry)} · ${nNodes} step${nNodes === 1 ? "" : "s"}${files.length ? ` · ${esc(files.slice(0, 4).join(", "))}${files.length > 4 ? "…" : ""}` : ""}</div>
    ${sel}`;
  panel.classList.add("open");
  const q = $("#ask-q");
  q.readOnly = false; q.classList.remove("frozen"); q.value = "";
  const send = $(".ask-send"); if (send) { send.textContent = "Ask ✦"; send.disabled = false; }
  q.focus();
}
function closeAsk() {
  if (ASK.controller) { try { ASK.controller.abort(); } catch { /* noop */ } ASK.controller = null; }
  const panel = $("#ask-panel");
  if (panel) panel.classList.remove("open");
}
async function submitAsk() {
  const q = $("#ask-q");
  // A frozen box means the last answer is still shown — treat the button as "ask again".
  if (q.readOnly) { unfreezeAsk(); return; }
  const query = q.value.trim();
  if (!query) return;
  if (ASK.mode === "diff" ? !ASK.flow : ASK.mode === "diagram" ? !ASK.diagram : !ASK.block) return;
  const answer = $("#ask-answer");
  const send = $(".ask-send");
  if (ASK.controller) { try { ASK.controller.abort(); } catch { /* noop */ } }
  const controller = new AbortController();
  ASK.controller = controller;
  // Freeze the question in place — it stays in the box, so there's no echoed line below.
  q.readOnly = true; q.classList.add("frozen");
  send.disabled = true; send.textContent = "Asking…";
  answer.innerHTML = renderAsk("", true);
  const payload = ASK.mode === "diff"
    ? { flowId: ASK.flow.id, selection: ASK.selection || "", query }
    : ASK.mode === "diagram"
    ? { diagramId: ASK.diagram.id, selection: ASK.selection || "", query }
    : { pageId: S.pageId, blockId: ASK.block.id, selection: ASK.selection || "", query };
  try {
    const res = await fetch("/api/ask", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) { answer.innerHTML = `<div class="ask-err">Couldn't reach the Q&A service (${res.status}).</div>`; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let acc = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
      if (acc.startsWith("__OLO_ERR__")) { answer.innerHTML = `<div class="ask-err">${esc(acc.replace("__OLO_ERR__", ""))}</div>`; continue; }
      const stick = answer.scrollHeight - answer.scrollTop - answer.clientHeight < 48;
      answer.innerHTML = renderAsk(acc, true);
      if (stick) answer.scrollTop = answer.scrollHeight;
    }
    if (acc.startsWith("__OLO_ERR__")) { /* already rendered */ }
    else if (!acc.trim()) answer.innerHTML = `<div class="ask-err">No answer was returned.</div>`;
    else answer.innerHTML = renderAsk(acc, false);
  } catch (err) {
    if (err && err.name === "AbortError") { answer.innerHTML = `<div class="ask-idle">Stopped.</div>`; }
    else { answer.innerHTML = `<div class="ask-err">${esc(err && err.message ? err.message : String(err))}</div>`; }
  } finally {
    if (ASK.controller === controller) ASK.controller = null;
    send.disabled = false; send.textContent = "Ask again";
  }
}
async function activateBlock(id) {
  S.activeBlock = id;
  document.querySelectorAll(".block").forEach((n) => n.classList.toggle("active", n.dataset.id === id));
  const b = S.page.blocks.find((x) => x.id === id);
  if (b && b.anchors[0]) await lightLines(b.anchors[0].file, b.anchors[0].startLine, b.anchors[0].endLine);
}
async function lightLines(file, s, e) {
  if (S.currentFile !== file) await showFile(file);
  document.querySelectorAll(".cl").forEach((n) => n.classList.remove("lit", "lit-edge", "pulse"));
  const scroll = $("#code-scroll"); let firstLit = null;
  for (let n = s; n <= e; n++) {
    const row = scroll.querySelector(`.cl[data-n="${n}"]`);
    if (row) { row.classList.add("lit", "pulse"); if (n === s) row.classList.add("lit-edge"); if (!firstLit) firstLit = row; }
  }
  if (firstLit) firstLit.scrollIntoView({ block: "center", behavior: "smooth" });
}
async function showFile(file) {
  const f = await getFile(file);
  S.currentFile = file;
  $("#code-file").textContent = file;
  const scroll = $("#code-scroll");
  const pre = el("pre", "src");
  // map line -> block whose primary anchor covers it
  const cover = (n) => S.page.blocks.find((b) => b.anchors[0] && b.anchors[0].file === file && n >= b.anchors[0].startLine && n <= b.anchors[0].endLine);
  f.lines.forEach((l) => {
    const row = el("div", "cl");
    row.dataset.n = l.n;
    row.innerHTML = `<span class="g">${l.n}</span><span class="t">${esc(l.text) || " "}</span>`;
    const b = cover(l.n);
    if (b) row.onclick = () => activateBlock(b.id);
    pre.appendChild(row);
  });
  scroll.innerHTML = ""; scroll.appendChild(pre);
}
async function flag(b, key) {
  b[key] = !b[key];
  await api(`/api/block/${b.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: b[key] }) });
  const node = document.querySelector(`.block[data-id="${b.id}"]`);
  node.replaceWith(renderBlock(b));
  if (S.activeBlock === b.id) activateBlock(b.id);
}
function startEdit(b, node) {
  const ta = el("textarea", "editor"); ta.value = b.prose;
  $(".prose", node).replaceWith(ta); ta.focus();
  const save = async () => {
    await api(`/api/block/${b.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prose: ta.value }) });
    b.prose = ta.value; b.origin = "human-edited";
    node.replaceWith(renderBlock(b)); activateBlock(b.id);
  };
  ta.addEventListener("blur", save);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); } });
}

// ---- drift (inline accordion) ----
// The Drift view reads the working tree as a set of LOGICAL FLOWS — clusters of
// related diffs, each with a narrative and its own collapsible code evidence —
// rather than a flat file-by-file list.
let DRIFT = null;
const EXPANDED = new Set(); // flow ids whose code/claims are currently unfolded
const CRUX = 14; // lines shown before a big diff collapses to its crux

async function renderDrift() {
  DRIFT = await api("/api/drift");
  const stage = $("#stage");
  const view = el("div", "scroll view-fade");
  if (!DRIFT.isRepo) {
    view.innerHTML = emptyState("Not a git repository", "Drift is measured from <code>git diff</code>. Initialise git in this repo to track documentation drift.");
    stage.innerHTML = ""; stage.appendChild(view); return;
  }
  if (!DRIFT.hasDiff || !DRIFT.flows.length) {
    view.innerHTML = emptyState("Nothing to reconcile", "The working tree matches the last commit. Every anchored claim still lines up with its code.");
    stage.innerHTML = ""; stage.appendChild(view); return;
  }
  const open = DRIFT.count;
  const files = new Set(DRIFT.flows.flatMap((f) => f.files.map((x) => x.file))).size;
  const added = DRIFT.flows.reduce((s, f) => s + f.changed.added, 0);
  const nFlows = DRIFT.flows.length;
  view.innerHTML = `
    <div class="drift-view">
      <div class="drift-top">
        <div><div class="eyebrow">Working tree</div><h1 class="drift-title">Changes to reconcile</h1></div>
        <div class="drift-tally">${driftTally(open, nFlows)}</div>
      </div>
      <p class="drift-lede">${files} changed file${files === 1 ? "" : "s"} · +${added} line${added === 1 ? "" : "s"}, read as ${nFlows} flow${nFlows === 1 ? "" : "s"} of intent.</p>
      <div class="flow-list" id="flow-list"></div>
    </div>`;
  stage.innerHTML = ""; stage.appendChild(view);
  remountFlows();
}
function driftTally(open, nFlows) {
  if (open === 0) return "All reviewed";
  return `${open} of ${nFlows} flow${nFlows === 1 ? "" : "s"} to review`;
}
function remountFlows() {
  const list = $("#flow-list");
  if (!list) return;
  const n = DRIFT.flows.length;
  list.innerHTML = DRIFT.flows.map((fl, i) => flowCardHtml(fl, i, n)).join("");
  [...list.children].forEach((card, i) => wireCard(card, i));
}

function authorTag(author) {
  if (author === "ai") return `<span class="fa fa-ai">🤖 AI-led</span>`;
  if (author === "human") return `<span class="fa fa-human">✋ Human edit</span>`;
  if (author === "mixed") return `<span class="fa fa-mixed">AI + human</span>`;
  return `<span class="fa fa-unknown">Origin unclear</span>`;
}
function flowStateChip(fl) {
  if (fl.reviewed) return `<span class="fs-reviewed">✓ Reviewed</span>`;
  if (!fl.affected.length) return `<span class="fs-plain">${fl.isNew ? "new file" : "no claims"}</span>`;
  const n = fl.affected.length;
  return `<span class="fs-open">${n} claim${n === 1 ? "" : "s"}${fl.reviewedCount ? ` · ${fl.reviewedCount} reviewed` : ""}</span>`;
}
// The collapsed-flow toggle summarizes what's inside without showing any code.
function expandLabel(fl) {
  const parts = [`${fl.fileCount} file${fl.fileCount === 1 ? "" : "s"}`, `<span class="ev-add">+${fl.changed.added}</span> <span class="ev-del">−${fl.changed.removed}</span>`];
  if (fl.affected.length) parts.push(`${fl.affected.length} claim${fl.affected.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
function flowCardHtml(fl, i, n) {
  const showIntent = (fl.author === "ai" || fl.author === "mixed") && fl.intent;
  const src = fl.sessionId
    ? `<span class="flow-src">from conversation <code>${esc(fl.sessionId.slice(0, 8))}</code>${fl.turn != null ? ` · turn ${fl.turn}` : ""}</span>`
    : "";
  const intent = showIntent
    ? `<div class="flow-intent"><span class="flow-intent-label">Stated intent</span><p>${esc(fl.intent)}</p>${src}</div>`
    : "";
  const evidence = fl.files.map((ff, fi) => fileBlockHtml(ff, fi)).join("");
  const open = EXPANDED.has(fl.id);
  return `<article class="flow author-${fl.author}${fl.reviewed ? " reviewed" : ""}${open ? " open" : ""}" data-fi="${i}" data-flow="${esc(fl.id)}">
    <header class="flow-head">
      <span class="flow-marker">Flow ${i + 1}<span class="flow-of"> / ${n}</span></span>
      ${authorTag(fl.author)}
      ${fl.confidence ? confidenceDot(fl.confidence) : ""}
      <span class="flow-spacer"></span>
      <span class="flow-state">${flowStateChip(fl)}</span>
      <button class="flow-ask" title="Ask Copilot a clarifying question about this change">✦ ask</button>
    </header>
    <h2 class="flow-title">${esc(fl.title)}</h2>
    ${fl.summary ? `<p class="flow-summary">${esc(fl.summary)}</p>` : ""}
    ${intent}
    <button class="flow-expand" aria-expanded="${open ? "true" : "false"}">
      <span class="fx-chev">›</span>
      <span class="fx-open">Review the change · ${expandLabel(fl)}</span>
      <span class="fx-close">Hide the code &amp; claims</span>
    </button>
    <div class="flow-body">
      <div class="flow-evidence">
        <div class="evi-head">Evidence · ${fl.fileCount} file${fl.fileCount === 1 ? "" : "s"} · <span class="ev-add">+${fl.changed.added}</span> <span class="ev-del">−${fl.changed.removed}</span></div>
        ${evidence}
      </div>
      ${claimsHtml(fl)}
    </div>
  </article>`;
}
function fileBlockHtml(ff, fi) {
  const stat = ff.hunks.reduce((a, h) => { a.add += h.added; a.del += h.removed; return a; }, { add: 0, del: 0 });
  const hunks = ff.hunks.map((h, hi) => hunkBlockHtml(h, fi, hi)).join("");
  return `<div class="evi-file">
    <div class="evi-file-head">
      ${ff.isNew ? `<span class="new-badge">NEW</span>` : ""}
      <span class="evi-path">${esc(ff.file)}</span>
      <span class="evi-stat"><span class="ev-add">+${stat.add}</span> <span class="ev-del">−${stat.del}</span></span>
      <span class="evi-spacer"></span>
      <a class="evi-open" href="${esc(ff.openHref)}" title="Open ${esc(ff.abs)} in your editor">open in editor <span class="ext">↗</span></a>
    </div>
    ${hunks}
  </div>`;
}
function hunkBlockHtml(h, fi, hi) {
  const collapsible = h.lines.length > CRUX;
  const author = h.note ? h.note.author : "unknown";
  const label = author === "ai" ? "What the agent changed" : author === "human" ? "What the author changed" : "What changed";
  const why = h.note && h.note.rationale
    ? `<div class="evi-why why-${author}"><span class="evi-why-label">${label}</span><p>${esc(h.note.rationale)}</p></div>`
    : "";
  const claims = h.affected && h.affected.length
    ? `<div class="hunk-claims"><div class="hc-head">Claim${h.affected.length === 1 ? "" : "s"} anchored to this change</div>${h.affected.map(claimRowHtml).join("")}</div>`
    : "";
  return `<div class="evi-hunk">
    ${why}
    <div class="evi-diff" data-ff="${fi}" data-fh="${hi}" data-expanded="0">
      <div class="evi-loc">${esc(h.header || "")}</div>
      <pre class="diff-pre">${renderDiff(h.lines, false)}</pre>
      ${collapsible ? `<button class="evi-toggle">${fullLabel(h.lines)}</button>` : ""}
    </div>
    ${claims}
  </div>`;
}
function claimRowHtml(a) {
  const also = a.alsoTouches > 0
    ? `<span class="claim-also" title="This claim also rests on ${a.alsoTouches} other change${a.alsoTouches === 1 ? "" : "s"} in this flow — approving here reviews it everywhere">↔ ${a.alsoTouches} other change${a.alsoTouches === 1 ? "" : "s"}</span>`
    : "";
  return `<div class="claim-row${a.verified ? " reviewed" : ""}">
    <a class="claim-meta" href="#/wiki/${esc(a.pageId)}">
      <span class="claim-title">${esc(a.pageTitle)}</span>
      <span class="claim-loc">${esc(a.symbol || "whole file")} · lines ${a.range[0]}–${a.range[1]}${a.locked ? " · 🔒 locked" : ""}</span>
    </a>
    ${also}
    <button class="approve" data-block="${esc(a.blockId)}">${a.verified ? "✓ Reviewed" : "Approve"}</button>
  </div>`;
}
function fullLabel(lines) { return `Show full diff · ${lines.length} lines`; }
function cruxWindow(lines) {
  if (lines.length <= CRUX) return { start: 0, end: lines.length, collapsible: false };
  let first = -1, last = -1;
  lines.forEach((l, i) => { if (l.sign !== " ") { if (first < 0) first = i; last = i; } });
  if (first < 0) { first = 0; last = Math.min(lines.length, CRUX) - 1; }
  let start = Math.max(0, first - 2), end = Math.min(lines.length, last + 3);
  if (end - start > CRUX) end = start + CRUX;
  return { start, end, collapsible: true };
}
function renderDiff(lines, expanded) {
  const w = cruxWindow(lines);
  if (!w.collapsible || expanded) return lines.map(diffLine).join("");
  let html = "";
  if (w.start > 0) html += `<div class="dl fold">⋯ ${w.start} line${w.start === 1 ? "" : "s"} above</div>`;
  html += lines.slice(w.start, w.end).map(diffLine).join("");
  const rest = lines.length - w.end;
  if (rest > 0) html += `<div class="dl fold">⋯ ${rest} more line${rest === 1 ? "" : "s"}</div>`;
  return html;
}
function diffLine(l) {
  const cls = l.sign === "+" ? "add" : l.sign === "-" ? "del" : "";
  const no = l.sign === "-" ? "" : (l.newNo || "");
  return `<div class="dl ${cls}"><span class="no">${no}</span><span class="sign">${l.sign === " " ? "" : l.sign}</span><span class="tx">${esc(l.text) || " "}</span></div>`;
}
function claimsHtml(fl) {
  // Claims now render inline at each change (see hunkBlockHtml). Only surface a
  // flow-level note when there's nothing to anchor them to.
  if (fl.affected.length) return "";
  return `<div class="flow-claims empty"><span class="fc-empty">${fl.isNew
    ? "Net-new — document this once it lands so its claims are anchored."
    : "No wiki claim is anchored to these lines yet — a coverage gap worth documenting."}</span></div>`;
}
function wireCard(card, fi) {
  const exp = card.querySelector(".flow-expand");
  if (exp) exp.onclick = () => {
    const id = card.dataset.flow;
    const open = card.classList.toggle("open");
    if (open) EXPANDED.add(id); else EXPANDED.delete(id);
    exp.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const askBtn = card.querySelector(".flow-ask");
  if (askBtn) askBtn.onclick = (e) => {
    e.stopPropagation();
    const sel = (window.getSelection && window.getSelection().toString()) || "";
    openAskDiff(DRIFT.flows[fi], sel);
  };
  // Right-click anywhere in the change (e.g. over a diff line you've selected) to ask about it.
  card.addEventListener("contextmenu", (e) => {
    if (e.target.closest("a, button")) return;
    const sel = (window.getSelection && window.getSelection().toString()) || "";
    e.preventDefault();
    openAskDiff(DRIFT.flows[fi], sel);
  });
  card.querySelectorAll(".evi-toggle").forEach((btn) => {
    btn.onclick = () => {
      const diff = btn.closest(".evi-diff");
      const ff = +diff.dataset.ff, fh = +diff.dataset.fh;
      const lines = DRIFT.flows[fi].files[ff].hunks[fh].lines;
      const expanded = diff.dataset.expanded === "1";
      diff.dataset.expanded = expanded ? "0" : "1";
      diff.querySelector(".diff-pre").innerHTML = renderDiff(lines, !expanded);
      btn.textContent = expanded ? fullLabel(lines) : "Collapse diff";
    };
  });
  card.querySelectorAll(".approve").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const blockId = btn.dataset.block;
      const aff = DRIFT.flows[fi].affected.find((a) => a.blockId === blockId);
      const next = !(aff && aff.verified);
      btn.disabled = true;
      try {
        await api(`/api/verify/${blockId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewed: next }) });
      } catch { btn.disabled = false; return; }
      // a claim can rest on more than one flow AND on more than one change —
      // update every occurrence so inline rows and badges all stay in sync
      DRIFT.flows.forEach((fl) => {
        fl.affected.forEach((a) => { if (a.blockId === blockId) a.verified = next; });
        fl.files.forEach((ff) => ff.hunks.forEach((h) => (h.affected || []).forEach((a) => { if (a.blockId === blockId) a.verified = next; })));
      });
      DRIFT.flows.forEach((fl) => {
        fl.reviewedCount = fl.affected.filter((a) => a.verified).length;
        fl.reviewed = fl.affected.length > 0 && fl.reviewedCount === fl.affected.length;
      });
      remountFlows();
      syncDriftChrome();
    };
  });
}
function syncDriftChrome() {
  const open = DRIFT.flows.filter((f) => f.affected.length > 0 && !f.reviewed).length;
  const tally = $(".drift-tally");
  if (tally) tally.textContent = driftTally(open, DRIFT.flows.length);
  const badge = $("#drift-badge");
  if (open > 0) { badge.hidden = false; badge.textContent = open; } else badge.hidden = true;
}
function confidenceDot(level) {
  const map = { high: "conf-high", medium: "conf-med", low: "conf-low" };
  const label = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
  return `<span class="conf ${map[level] || "conf-low"}" title="${label[level] || label.low}"><span class="conf-dot"></span>${(level || "low")[0].toUpperCase()}${(level || "low").slice(1)}</span>`;
}
function emptyState(title, body) {
  return `<div class="empty"><div class="mark"></div><h2>${esc(title)}</h2><p>${body}</p></div>`;
}

// ---- optimize (auto-improve loop) ----
// Renders the fey-improve run (from /api/opt) as one more fey view: the run
// headline + hill-climb graph up top, then a collapsible iteration log and a
// collapsible rubric stacked beneath. Same visual language as the rest of fey —
// green (--verified) is a kept improvement, red is a rejected step, violet
// (--ai) is the baseline / AI provenance.
const optFmt = (n) => (n == null ? "—" : (Math.round(n * 10) / 10).toString());
const optSigned = (n) => (n == null ? "" : (n >= 0 ? "+" : "") + optFmt(n));
const E = (s) => esc(String(s == null ? "" : s));
const IN = (s) => inline(String(s == null ? "" : s));

let OPT_TIP = null;
function optTipEl() { if (!OPT_TIP) { OPT_TIP = el("div", "opt-tip"); document.body.appendChild(OPT_TIP); } return OPT_TIP; }
function optHideTip() { if (OPT_TIP) OPT_TIP.classList.remove("on"); }
function optMoveTip(e) {
  if (!OPT_TIP) return;
  const pad = 14, w = OPT_TIP.offsetWidth, h = OPT_TIP.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  OPT_TIP.style.left = x + "px"; OPT_TIP.style.top = y + "px";
}
function optShowTip(e, it) {
  const t = optTipEl();
  const dcls = it.delta == null ? "" : it.delta > 0 ? "up" : it.delta < 0 ? "down" : "";
  const badge = it.baseline ? "" : it.kept === false ? `<span class="opt-tip-badge rej">rejected</span>`
    : it.committed ? `<span class="opt-tip-badge kept">kept · committed</span>` : `<span class="opt-tip-badge kept">kept</span>`;
  t.innerHTML =
    `<div class="opt-tip-h">${E(it.baseline ? "baseline" : "iteration " + it.n)}</div>` +
    `<div class="opt-tip-score">${optFmt(it.total)}<span class="unit">/100</span>${it.delta != null ? `<span class="d ${dcls}">${optSigned(it.delta)}</span>` : ""}</div>` +
    (it.summary ? `<div class="opt-tip-sum">${E(it.summary)}</div>` : "") + badge;
  t.classList.add("on"); optMoveTip(e);
}
// Namespaced-SVG hill climb so each point can close over its iteration object.
function optClimbChart(iters) {
  const wrap = el("div", "opt-chart");
  if (!iters.length) { wrap.innerHTML = `<div class="opt-chart-empty">No iterations yet — record a baseline to start the climb.</div>`; return wrap; }
  const W = 940, H = 320, padL = 46, padR = 22, padT = 20, padB = 36, N = iters.length;
  const xFor = (i) => padL + (N === 1 ? 0 : (i / (N - 1)) * (W - padL - padR));
  const yFor = (v) => padT + (1 - v / 100) * (H - padT - padB);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "opt-svg"); svg.setAttribute("role", "img");
  const mk = (tag, a) => { const n = document.createElementNS(NS, tag); for (const k in a) n.setAttribute(k, a[k]); return n; };
  for (const gv of [0, 25, 50, 75, 100]) {
    const y = yFor(gv);
    svg.appendChild(mk("line", { class: "opt-grid", x1: padL, y1: y, x2: W - padR, y2: y }));
    const t = mk("text", { class: "opt-axis", x: padL - 8, y: y + 3, "text-anchor": "end" }); t.textContent = gv; svg.appendChild(t);
  }
  iters.forEach((it, i) => { const t = mk("text", { class: "opt-axis", x: xFor(i), y: H - 12, "text-anchor": "middle" }); t.textContent = it.baseline ? "base" : it.n; svg.appendChild(t); });
  const bp = iters.map((it, i) => [xFor(i), yFor(it.bestSoFar != null ? it.bestSoFar : it.total)]);
  const areaD = `M ${bp[0][0]} ${yFor(0)} ` + bp.map((p) => `L ${p[0]} ${p[1]}`).join(" ") + ` L ${bp[bp.length - 1][0]} ${yFor(0)} Z`;
  svg.appendChild(mk("path", { class: "opt-best-area", d: areaD }));
  svg.appendChild(mk("path", { class: "opt-best-line", d: `M ` + bp.map((p) => `${p[0]} ${p[1]}`).join(" L ") }));
  svg.appendChild(mk("path", { class: "opt-try-line", d: `M ` + iters.map((it, i) => `${xFor(i)} ${yFor(it.total)}`).join(" L ") }));
  iters.forEach((it, i) => { if (it.kept === false) svg.appendChild(mk("line", { class: "opt-drop", x1: xFor(i), y1: yFor(it.total), x2: xFor(i), y2: yFor(it.bestSoFar != null ? it.bestSoFar : it.total) })); });
  iters.forEach((it, i) => {
    const cls = it.baseline ? "base" : it.kept === false ? "rej" : "kept";
    const c = mk("circle", { class: `opt-pt ${cls}`, cx: xFor(i), cy: yFor(it.total), r: 5.5 });
    c.addEventListener("mouseenter", (e) => optShowTip(e, it));
    c.addEventListener("mousemove", optMoveTip);
    c.addEventListener("mouseleave", optHideTip);
    svg.appendChild(c);
  });
  wrap.appendChild(svg);
  return wrap;
}
function optDirCards(dirs) {
  if (!dirs.length) return `<p class="opt-note">No directions recorded yet. The skill writes them to <code>.fey/improve/directions.json</code> after exploring the code.</p>`;
  return `<div class="opt-dir-grid">${dirs.map((d, i) => `
    <div class="opt-dir-card">
      <div class="opt-dir-num">DIRECTION ${String(i + 1).padStart(2, "0")}</div>
      <h3>${E(d.title || "Untitled")}</h3>
      <p>${IN(d.description || "")}</p>
      ${d.rationale ? `<div class="opt-dir-why"><b>Why it matters.</b> ${IN(d.rationale)}</div>` : ""}
    </div>`).join("")}</div>`;
}
function optIterCard(it, crit, critTitle) {
  const state = it.baseline ? "base" : it.kept === false ? "rej" : it.kept ? "kept" : "";
  const dcls = it.delta == null ? "flat" : it.delta > 0 ? "up" : it.delta < 0 ? "down" : "flat";
  const badgeCls = it.baseline ? "base" : it.kept === false ? "rej" : it.kept ? "kept" : "pending";
  const badgeTxt = it.baseline ? "baseline" : it.kept === false ? "rejected" : it.committed ? "kept · committed" : it.kept ? "kept" : "pending";
  let cs = "";
  if (it.perCriterion) {
    const chips = crit.map((c) => {
      const pc = it.perCriterion[c.id]; if (!pc || pc.score == null) return "";
      return `<div class="opt-cs"><div class="opt-cs-k">${E(critTitle[c.id])}</div><div class="opt-cs-v">${optFmt(pc.score)}<span class="of"> / ${optFmt(c.max || 10)}</span></div>${pc.note ? `<div class="opt-cs-note">${E(pc.note)}</div>` : ""}</div>`;
    }).join("");
    if (chips) cs = `<div class="opt-cs-row">${chips}</div>`;
  }
  let props = "";
  if (it.proposals && it.proposals.length) {
    const items = it.proposals.map((p) => `<div class="opt-prop">
      <div class="opt-prop-top"><span class="opt-prop-dir">${E(p.direction || "general")}</span>${p.picked ? `<span class="opt-prop-pick">applied</span>` : ""}</div>
      <div class="opt-prop-idea">${IN(p.idea || p.title || "")}</div>
      ${p.detail || p.proposedChanges ? `<div class="opt-prop-body">${IN(p.detail || p.proposedChanges || "")}</div>` : ""}
      ${p.expectedImpact ? `<div class="opt-prop-impact">expected impact: ${IN(p.expectedImpact)}</div>` : ""}
    </div>`).join("");
    props = `<div class="opt-props"><div class="opt-props-head">${it.proposals.length} parallel proposal${it.proposals.length === 1 ? "" : "s"} explored</div>${items}</div>`;
  }
  return `<article class="opt-iter ${state}">
    <header class="opt-iter-head">
      <span class="opt-iter-n">${it.baseline ? "BASE" : "#" + it.n}</span>
      <span class="opt-iter-title">${E(it.label || ("iteration " + it.n))}</span>
      ${it.delta != null ? `<span class="opt-iter-delta ${dcls}">${optSigned(it.delta)}</span>` : ""}
      <span class="opt-iter-score">${optFmt(it.total)}</span>
      <span class="opt-iter-badge ${badgeCls}">${badgeTxt}</span>
      <span class="opt-iter-chev">›</span>
    </header>
    <div class="opt-iter-body">
      ${it.summary ? `<div class="opt-iter-summary">${IN(it.summary)}</div>` : ""}
      ${it.commitSha ? `<div class="opt-iter-commit">committed as <code>${E(it.commitSha)}</code></div>` : ""}
      ${cs}${props}
    </div>
  </article>`;
}
function optRubricBody(D) {
  const rub = D.rubric || { criteria: [] };
  const crit = rub.criteria || [];
  const kept = D.iterations.filter((i) => i.kept !== false);
  const ref = kept.length ? kept.reduce((a, b) => (b.total >= a.total ? b : a)) : null;
  if (!crit.length) return `<p class="opt-note">No rubric yet — the skill authors it into <code>.fey/improve/rubric.json</code>.</p>`;
  const rows = crit.map((c) => {
    const pc = ref && ref.perCriterion ? ref.perCriterion[c.id] : null;
    const scoreCell = pc && pc.score != null
      ? `<div class="opt-crit-score">${optFmt(pc.score)}</div><div class="opt-crit-bar"><span style="width:${Math.max(0, Math.min(100, pc.norm))}%"></span></div>`
      : `<div class="opt-crit-score"><span class="opt-crit-maxl">—</span></div>`;
    return `<tr>
      <td><div class="opt-crit-title">${E(c.title || c.id)}</div>${c.description ? `<div class="opt-crit-desc">${IN(c.description)}</div>` : ""}${c.direction ? `<span class="opt-crit-dir">${E(c.direction)}</span>` : ""}</td>
      <td class="num"><div class="opt-crit-weight">${optFmt(c.weight)}</div><div class="opt-crit-maxl">max ${optFmt(c.max || 10)}</div></td>
      <td class="num">${scoreCell}</td>
    </tr>`;
  }).join("");
  const refLabel = ref ? `scores shown: ${ref.baseline ? "baseline" : "iter " + ref.n} · ${optFmt(ref.total)}/100` : "";
  return `<p class="opt-note">${E(rub.notes || "Weighted criteria. The single 0–100 score is a weight-normalized average — the number every step must beat to be kept.")}${refLabel ? ` <span class="opt-note-ref">${refLabel}</span>` : ""}</p>
    <table class="opt-rubric"><thead><tr><th>Criterion</th><th class="num">Weight</th><th class="num">Score</th></tr></thead><tbody>${rows}</tbody></table>`;
}
async function renderOptimize() {
  optHideTip();
  const stage = $("#stage");
  let D;
  try { D = await api("/api/opt"); }
  catch (e) {
    stage.innerHTML = "";
    stage.appendChild(el("div", "scroll view-fade", emptyState("No optimization run yet",
      "This tab renders a <strong>fey-improve</strong> auto-improve run from <code>.fey/improve/</code>. Start one with <code>fey-improve init &lt;repo&gt;</code>, then follow the fey-improve skill.")));
    return;
  }
  const s = D.summary, iters = D.iterations;
  const view = el("div", "scroll view-fade");
  const logCards = iters.slice().reverse();
  const crit = (D.rubric && D.rubric.criteria) || [];
  const critTitle = {}; crit.forEach((c) => (critTitle[c.id] = c.title || c.id));

  view.innerHTML = `
    <div class="opt-view">
      <div class="opt-head">
        <div class="opt-head-left">
          <div class="eyebrow">AUTO-IMPROVE RUN</div>
          <h1 class="opt-title">${E(s.title || "Optimization run")}</h1>
          <div class="opt-sub"><span class="opt-target">${s.target === "diff" ? "diff-scoped" : "whole codebase"}</span> ${s.workBranch && s.workBranch !== s.sourceBranch ? `<span class="opt-branch" title="all optimization commits land on this branch; merge it back into ${E(s.sourceBranch)} when you're happy">⎇ ${E(s.workBranch)} <span class="opt-branch-arrow">→</span> ${E(s.sourceBranch)}</span>` : ""} ${E(s.scope || "")}</div>
        </div>
        <div class="opt-score">
          <div class="opt-score-now">${optFmt(s.bestTotal)}<span class="unit">/100</span></div>
          <div class="opt-score-cap">BEST RUBRIC SCORE</div>
          ${s.gain != null ? `<div class="opt-score-gain ${s.gain > 0 ? "up" : "flat"}">${optSigned(s.gain)} from baseline ${optFmt(s.baselineTotal)}</div>` : ""}
        </div>
      </div>

      <div class="opt-stats">
        <div class="opt-stat"><div class="opt-stat-k">DIRECTIONS</div><div class="opt-stat-v ai">${s.directionsCount}</div></div>
        <div class="opt-stat"><div class="opt-stat-k">RUBRIC CRITERIA</div><div class="opt-stat-v">${s.criteriaCount}</div></div>
        <div class="opt-stat"><div class="opt-stat-k">STEPS TRIED</div><div class="opt-stat-v">${s.steps}</div></div>
        <div class="opt-stat"><div class="opt-stat-k">IMPROVEMENTS KEPT</div><div class="opt-stat-v up">${s.kept}</div></div>
        <div class="opt-stat"><div class="opt-stat-k">BASELINE</div><div class="opt-stat-v">${optFmt(s.baselineTotal)}</div></div>
      </div>

      <div class="opt-sec-head"><span class="opt-sec-label">HILL CLIMB</span><h2>Score per iteration</h2><span class="opt-sec-note">${iters.length} point${iters.length === 1 ? "" : "s"}</span></div>
      <div class="opt-chart-card">
        <div class="opt-legend">
          <span class="opt-lg"><span class="sw best"></span>best so far</span>
          <span class="opt-lg"><span class="sw kept"></span>kept step</span>
          <span class="opt-lg"><span class="sw rej"></span>rejected step</span>
          <span class="opt-lg"><span class="sw base"></span>baseline</span>
        </div>
        <div id="opt-chart-host"></div>
      </div>

      <div class="opt-sec-head"><span class="opt-sec-label">DIRECTIONS</span><h2>Where this run looks for gains</h2></div>
      ${optDirCards(D.directions)}

      <section class="opt-section open" data-sec="log">
        <button class="opt-section-head">
          <span class="opt-sec-chev">›</span>
          <span class="opt-section-label">Iteration log</span>
          <span class="opt-section-note">${logCards.length} entr${logCards.length === 1 ? "y" : "ies"} · newest first</span>
        </button>
        <div class="opt-section-body">
          ${logCards.length ? `<div class="opt-iter-list">${logCards.map((it) => optIterCard(it, crit, critTitle)).join("")}</div>` : `<p class="opt-note">No iterations yet. Record a baseline with <code>fey-improve record --baseline</code>.</p>`}
        </div>
      </section>

      <section class="opt-section open" data-sec="rubric">
        <button class="opt-section-head">
          <span class="opt-sec-chev">›</span>
          <span class="opt-section-label">Rubric</span>
          <span class="opt-section-note">${s.criteriaCount} criteri${s.criteriaCount === 1 ? "on" : "a"}</span>
        </button>
        <div class="opt-section-body">${optRubricBody(D)}</div>
      </section>
    </div>`;

  stage.innerHTML = ""; stage.appendChild(view);
  const host = view.querySelector("#opt-chart-host");
  if (host) host.appendChild(optClimbChart(iters));
  view.querySelectorAll(".opt-section-head").forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("open")));
  view.querySelectorAll(".opt-iter-head").forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("open")));
}

// ---- diagrams (anchored flow maps) ----
// One entry-point flow per diagram: vertical worldlines (lanes), calls as
// exchanges down the page. The signature interaction mirrors the wiki — clicking
// a node lights the exact code it is anchored to in the side panel.
const DG_LANE_W = 158, DG_X0 = 92, DG_ROW_H = 46, DG_Y0 = 84, DG_LABEL_Y = 34, DG_PAD_R = 40, DG_PAD_B = 44;
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
const trunc = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

async function renderDiagrams(pickId) {
  const stage = $("#stage");
  const index = await api("/api/diagrams").catch((e) => ({ __err: e.message }));
  if (index.__err || !index.diagrams || !index.diagrams.length) {
    stage.innerHTML = `<div class="dg-empty view-fade">
      <div class="dg-empty-mark" aria-hidden="true">⤳</div>
      <h2>No diagrams yet</h2>
      <p>Flow diagrams map how control moves from each entry point through the code — parsed, not run, with every step anchored to real lines.</p>
      <p class="dg-empty-cmd">Author them per entry point, then build:<br><code>fey diagrams build &lt;repo&gt;</code></p>
    </div>`;
    return;
  }
  S.diagrams = index.diagrams; S.dgActive = null; S.dgFile = null;

  const n = index.diagrams.length;
  const wrap = el("div", "diagrams view-fade");
  wrap.innerHTML = `
    <div class="dg-main">
      <div class="dg-listhead">
        <h1 class="dg-h1">Flow diagrams</h1>
        <p class="dg-listsub">${n} entry point${n === 1 ? "" : "s"} into this codebase — read from the source, not run. Expand one to trace how control moves; click any step to see the exact code.</p>
      </div>
      <div class="dg-list" id="dg-list"></div>
    </div>
    <div class="code">
      <div class="code-head"><span class="status-dot"></span><span class="fname" id="code-file">—</span><span class="hint">click a step → its code</span></div>
      <div class="code-scroll" id="code-scroll"><div class="dg-code-idle">Select a step in a flow to see the code it stands for.</div></div>
    </div>`;
  stage.innerHTML = ""; stage.appendChild(wrap);

  const list = $("#dg-list", wrap);
  const cards = [];
  for (const meta of index.diagrams) {
    const card = el("div", "dg-card");
    const altN = meta.branches || 0;
    const metaBits = `${meta.nodes} step${meta.nodes === 1 ? "" : "s"}`
      + (altN ? ` · ${altN} alt path${altN === 1 ? "" : "s"}` : "")
      + (meta.unresolved ? ` · ${meta.unresolved} unresolved` : "");
    card.innerHTML = `
      <div class="dg-card-head" role="button" tabindex="0">
        <span class="chev">▸</span>
        <span class="dg-card-kind ${esc(meta.kind)}">${esc(meta.kind.replace("-", " "))}</span>
        <span class="dg-card-title">${esc(meta.title)}</span>
        <span class="dg-card-entry mono">${esc(meta.entry)}</span>
        <span class="dg-card-meta mono">${metaBits}</span>
        <span class="dg-card-ask" role="button" tabindex="0" title="Ask Copilot about this flow">✦ ask</span>
      </div>
      <div class="dg-card-body"></div>`;
    const head = $(".dg-card-head", card);
    head.addEventListener("click", (e) => { if (e.target.closest(".dg-card-ask")) return; toggleCard(card, meta); });
    head.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); toggleCard(card, meta); } });
    const askBtn = $(".dg-card-ask", card);
    const fireAsk = async (e) => { e.stopPropagation(); e.preventDefault(); const d = await loadCard(card, meta); const sel = (window.getSelection && window.getSelection().toString()) || ""; openAskDiagram(d, sel); };
    askBtn.addEventListener("click", fireAsk);
    askBtn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fireAsk(e); });
    list.appendChild(card);
    cards.push({ card, meta });
  }

  // open the requested (or first) card
  const want = (pickId && index.diagrams.some((d) => d.id === pickId)) ? pickId : index.diagrams[0].id;
  const target = cards.find((c) => c.meta.id === want) || cards[0];
  await openCard(target.card, target.meta);
}

// Lazily fetch + render a card's flow body (idempotent).
async function loadCard(card, meta) {
  if (card._diagram) return card._diagram;
  const d = await api(`/api/diagrams/${meta.id}`);
  card._diagram = d;
  const body = $(".dg-card-body", card);
  body.innerHTML = `
    ${d.summary ? `<p class="dg-summary">${esc(d.summary)}</p>` : ""}
    <div class="dg-canvas"></div>
    ${(d.branches && d.branches.length) ? `<div class="dg-branches"></div>` : ""}
    <div class="dg-foot">
      <span class="dg-legend"><span class="dg-lg-solid"></span> resolved call</span>
      <span class="dg-legend"><span class="dg-lg-dash"></span> unresolved (dynamic / external)</span>
      <span class="dg-foot-note">Parsed statically — a plausible control path, not a trace. There is no timing.</span>
    </div>`;
  drawFlowInto($(".dg-canvas", body), d.lanes, d.nodes, d);
  if (d.branches && d.branches.length) {
    const bwrap = $(".dg-branches", body);
    bwrap.innerHTML = `<div class="dg-branches-head">Alternate paths</div><div class="dg-branches-sub">Other ways control can flow through this entry point — error paths, early returns, fallbacks.</div>`;
    d.branches.forEach((br) => {
      const sec = el("div", "dg-branch");
      sec.innerHTML = `<button class="dg-branch-head"><span class="chev">▸</span> ${esc(br.label)}</button><div class="dg-branch-body"></div>`;
      const bbody = $(".dg-branch-body", sec);
      $(".dg-branch-head", sec).onclick = () => { sec.classList.toggle("open"); if (sec.classList.contains("open") && !bbody.dataset.drawn) { drawFlowInto(bbody, d.lanes, br.nodes, d); bbody.dataset.drawn = "1"; } };
      bwrap.appendChild(sec);
    });
  }
  return d;
}

async function openCard(card, meta) {
  const d = await loadCard(card, meta);
  card.classList.add("open");
  S.diagram = d;
  const entry = d.nodes.find((x) => x.parent == null) || d.nodes[0];
  if (entry) dgSelect(entry);
  try { history.replaceState(null, "", `#/diagrams/${meta.id}`); } catch (_) {}
  return d;
}

function toggleCard(card, meta) {
  if (card.classList.contains("open")) { card.classList.remove("open"); return; }
  openCard(card, meta);
}

// Build one flow SVG (lanes as worldlines, nodes as exchanges) into `host` and
// wire node interactivity. `nodes` may be the main path or a branch's path.
function drawFlowInto(host, lanes, nodes, diagram) {
  host.innerHTML = "";
  if (!nodes.length) { host.innerHTML = `<div class="dg-code-idle">This path has no steps.</div>`; return; }
  // lane x positions, in declared order but only for lanes actually used
  const used = lanes.filter((l) => nodes.some((n) => n.lane === l.id));
  const laneX = {}; used.forEach((l, i) => (laneX[l.id] = DG_X0 + i * DG_LANE_W));
  const byId = {}; nodes.forEach((n) => (byId[n.id] = n));
  const yOf = (n, i) => DG_Y0 + i * DG_ROW_H;
  const rows = nodes.map((n, i) => ({ n, y: yOf(n, i) }));
  const width = Math.max(DG_X0 + (used.length - 1) * DG_LANE_W + DG_PAD_R + 60, 360);
  const height = DG_Y0 + nodes.length * DG_ROW_H + DG_PAD_B;

  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "dg-svg", role: "img" });

  // lane extents
  const firstY = {}, lastY = {};
  for (const { n, y } of rows) { firstY[n.lane] = Math.min(firstY[n.lane] ?? 1e9, y); lastY[n.lane] = Math.max(lastY[n.lane] ?? 0, y); }
  for (const l of used) {
    const x = laneX[l.id];
    svg.appendChild(svgEl("line", { x1: x, y1: firstY[l.id] - 18, x2: x, y2: lastY[l.id] + 18, class: "dg-lane" }));
    const lab = svgEl("text", { x, y: DG_LABEL_Y, "text-anchor": "middle", class: "dg-lane-label" + (l.kind === "external" ? " ext" : "") });
    lab.textContent = trunc(l.label, 20);
    svg.appendChild(lab);
  }

  // time axis
  svg.appendChild(svgEl("line", { x1: 28, y1: DG_Y0 - 22, x2: 28, y2: height - DG_PAD_B, class: "dg-axis" }));
  const tl = svgEl("text", { x: 28, y: DG_Y0 - 30, "text-anchor": "middle", class: "dg-axis-label" }); tl.textContent = "order"; svg.appendChild(tl);

  // exchange edges + node vertices
  for (const { n, y } of rows) {
    const x = laneX[n.lane];
    const parent = n.parent != null ? byId[n.parent] : null;
    if (!parent) {
      // entry vertex
      const g = svgEl("g", { class: "dg-node dg-entry-node", "data-id": n.id, tabindex: "0" });
      g.appendChild(svgEl("circle", { cx: x, cy: y, r: 5, class: "dg-dot-entry" }));
      const t = svgEl("text", { x: x + 12, y: y + 4, class: "dg-node-label dg-entry-label" }); t.textContent = n.name + "()";
      g.appendChild(t);
      g.appendChild(hitRect(x, y, width));
      svg.appendChild(g);
      continue;
    }
    const px = laneX[parent.lane];
    const dashed = n.resolved === false;
    const mk = dashed ? "url(#dg-arrow-un)" : "url(#dg-arrow)";
    const g = svgEl("g", { class: "dg-node" + (dashed ? " dg-unresolved" : ""), "data-id": n.id, tabindex: "0" });
    if (px === x) {
      // self-call within a lane: a small kink
      g.appendChild(svgEl("path", { d: `M${x} ${y - DG_ROW_H * 0.34} q26 ${DG_ROW_H * 0.17} 0 ${DG_ROW_H * 0.34}`, class: "dg-edge", "marker-end": mk }));
    } else {
      g.appendChild(svgEl("line", { x1: px, y1: y, x2: x, y2: y, class: "dg-edge", "marker-end": mk }));
    }
    g.appendChild(svgEl("circle", { cx: px, cy: y, r: 3, class: "dg-dot-src" }));
    g.appendChild(svgEl("circle", { cx: x, cy: y, r: 4, class: "dg-dot" }));
    const anchor = px === x ? "start" : (x > px ? "start" : "end");
    const lx = px === x ? x + 30 : (x > px ? px + 10 : px - 10);
    const t = svgEl("text", { x: lx, y: y - 7, "text-anchor": anchor, class: "dg-node-label" });
    t.textContent = n.name + "()" + (dashed ? "  ?" : "");
    g.appendChild(t);
    g.appendChild(hitRect(Math.min(px, x), y, width));
    svg.appendChild(g);
  }

  // arrowhead markers (resolved = green, unresolved = amber)
  const defs = svgEl("defs", {});
  for (const [id, cls] of [["dg-arrow", "dg-arrowhead"], ["dg-arrow-un", "dg-arrowhead un"]]) {
    const marker = svgEl("marker", { id, viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto" });
    marker.appendChild(svgEl("path", { d: "M2 1L8 5L2 9", class: cls }));
    defs.appendChild(marker);
  }
  svg.insertBefore(defs, svg.firstChild);

  host.appendChild(svg);

  // wire interactivity
  svg.querySelectorAll(".dg-node").forEach((g) => {
    const n = byId[g.dataset.id];
    g.addEventListener("click", () => dgSelect(n));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dgSelect(n); } });
    if (n.note) { g.addEventListener("mouseenter", (e) => dgTip(e, n)); g.addEventListener("mouseleave", dgTipHide); }
  });
}
// a transparent full-width band so the whole row is clickable/hoverable
function hitRect(xFrom, y, width) {
  return svgEl("rect", { x: 0, y: y - DG_ROW_H / 2, width, height: DG_ROW_H, fill: "transparent", class: "dg-hit" });
}

function dgSelect(node) {
  S.dgActive = node.id;
  document.querySelectorAll(".dg-node").forEach((g) => g.classList.toggle("sel", g.dataset.id === node.id));
  if (node.file && node.startLine) dgLight(node.file, node.startLine, node.endLine, node);
  else {
    $("#code-file").textContent = "—";
    $("#code-scroll").innerHTML = `<div class="dg-code-idle">“${esc(node.name)}” is unresolved — a dynamic or external call with no source to show.</div>`;
  }
}
async function dgLight(file, s, e, node) {
  if (S.dgFile !== file) await dgShowFile(file, node);
  const scroll = $("#code-scroll");
  scroll.querySelectorAll(".cl").forEach((n) => n.classList.remove("lit", "lit-edge", "pulse"));
  let first = null;
  for (let n = s; n <= e; n++) {
    const row = scroll.querySelector(`.cl[data-n="${n}"]`);
    if (row) { row.classList.add("lit", "pulse"); if (n === s) row.classList.add("lit-edge"); if (!first) first = row; }
  }
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
}
async function dgShowFile(file) {
  const f = await getFile(file);
  S.dgFile = file;
  $("#code-file").textContent = file;
  const scroll = $("#code-scroll");
  const pre = el("pre", "src");
  f.lines.forEach((l) => {
    const row = el("div", "cl");
    row.dataset.n = l.n;
    row.innerHTML = `<span class="g">${l.n}</span><span class="t">${esc(l.text) || " "}</span>`;
    pre.appendChild(row);
  });
  scroll.innerHTML = ""; scroll.appendChild(pre);
}
let DG_TIP = null;
function dgTip(e, node) {
  dgTipHide();
  DG_TIP = el("div", "dg-tip", esc(node.note));
  document.body.appendChild(DG_TIP);
  const r = e.currentTarget.getBoundingClientRect();
  DG_TIP.style.left = (r.left + 20) + "px";
  DG_TIP.style.top = (r.top - 4) + "px";
}
function dgTipHide() { if (DG_TIP) { DG_TIP.remove(); DG_TIP = null; } }

// ---- boot ----
$("#search").addEventListener("input", renderRail);
window.addEventListener("hashchange", route);

// Boot tolerantly: either bundle may be absent. If fey-create hasn't run there's
// no wiki manifest (nav 404s); if fey-improve hasn't run there's no optimize log.
// We detect what exists, grey out the tabs that don't, and land on a tab that does.
async function boot() {
  let repoName = "";
  try { await loadNav(); S.hasWiki = true; repoName = S.nav.repoName || ""; }
  catch { S.hasWiki = false; S.nav = { repoName: "", sections: [], fileCount: 0, pageCount: 0, coverage: 0, driftCount: 0 }; }
  try { const o = await api("/api/opt"); S.hasOpt = true; repoName = repoName || o.repoName || ""; }
  catch { S.hasOpt = false; }
  if (!S.hasWiki) {
    S.nav.repoName = repoName;
    $("#repo-chip").textContent = repoName || "—";
    const badge = $("#drift-badge"); if (badge) badge.hidden = true;
  }
  applyTabAvailability();
  const noHash = !location.hash || location.hash === "#" || location.hash === "#/";
  if (noHash && !S.hasWiki && S.hasOpt) { location.hash = "#/optimize"; return; } // hashchange → route()
  route();
}
boot();
