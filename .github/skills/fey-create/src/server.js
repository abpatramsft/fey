"use strict";
// Local fey server. Serves three views (Overview, Wiki, Drift) plus the JSON
// they read. Anchors resolve against the manifest's span snapshot; DRIFT is
// computed purely from `git diff` (per the product spec).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { listFiles } = require("./indexer");
const M = require("./manifest");
const { isGitRepo, collectDiff, hunkSignature } = require("./gitdiff");
const { loadDriftNotes, noteFor, slug } = require("./driftNotes");
const { loadVerifications, isBlockVerified, setVerified } = require("./verify");
const PN = require("./pageNotes");
const DG = require("./diagrams");

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

// Resolve a span id to a span, and count lines/coverage — shared with the CLI.
const { fileLineCount, makeSpan, computeCoverage } = require("./coverage");

// shared stats + per-file coverage (thin wrapper over computeCoverage)
function statsAndCoverage(repoRoot, manifest) {
  const cov = computeCoverage(repoRoot, manifest);
  return {
    files: cov.files,
    filesIndexed: cov.filesIndexed,
    wikiPages: manifest.pages.length,
    linesAnchoredPct: cov.totalPct,
    cov: (rel) => (cov.perFile[rel] ? cov.perFile[rel].pct : 0),
  };
}

// --- git-based drift ---
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// Dominant authorship of a cluster of hunk notes: if both an AI and a human
// touched it, it's "mixed"; otherwise the single known author, else "unknown".
function aggAuthor(notes) {
  const known = new Set(notes.map((n) => n.author).filter((a) => a === "ai" || a === "human"));
  if (known.has("ai") && known.has("human")) return "mixed";
  if (known.has("ai")) return "ai";
  if (known.has("human")) return "human";
  return "unknown";
}
function aggConfidence(notes) {
  const rank = { high: 3, medium: 2, low: 1 };
  let best = 0, val = "";
  for (const n of notes) { if ((rank[n.confidence] || 0) > best) { best = rank[n.confidence]; val = n.confidence; } }
  return val;
}
// The first line number a reviewer should jump to when opening the file.
function firstChangedLine(hunks) {
  for (const h of hunks) for (const l of h.lines) if (l.sign === "+" && l.newNo) return l.newNo;
  for (const h of hunks) for (const l of h.lines) if (l.newNo) return l.newNo;
  return 1;
}

function computeDrift(repoRoot, manifest) {
  if (!isGitRepo(repoRoot)) return { isRepo: false, hasDiff: false, count: 0, items: [], flows: [] };
  const files = collectDiff(repoRoot);
  const { notes, flows: flowDefs } = loadDriftNotes(repoRoot);
  const verifData = loadVerifications(repoRoot);

  // Enumerate every anchored claim once, with its live spans + review state.
  const blocks = [];
  for (const page of manifest.pages) {
    for (const block of page.blocks) {
      const spans = block.anchors.map((id) => makeSpan(repoRoot, manifest, id)).filter(Boolean);
      blocks.push({
        pageId: page.id, pageTitle: page.title, blockId: block.id,
        symbol: (spans[0] || {}).symbol || "", locked: !!block.locked, spans,
        verified: isBlockVerified(repoRoot, manifest, verifData, block),
      });
    }
  }
  // Which claims sit on a set of touched line ranges (deduped by block).
  function affectedFor(rangesByFile) {
    const out = [];
    for (const b of blocks) {
      let hit = null;
      for (const sp of b.spans) {
        const ranges = rangesByFile.get(sp.file);
        if (ranges && ranges.some(([s, e]) => overlaps(s, e, sp.startLine, sp.endLine))) { hit = sp; break; }
      }
      if (hit) out.push({ pageId: b.pageId, pageTitle: b.pageTitle, blockId: b.blockId, symbol: hit.symbol || b.symbol, range: [hit.startLine, hit.endLine], locked: b.locked, verified: b.verified });
    }
    return out;
  }

  // Per-file items — kept lean; used only for the Overview/nav page dots.
  const items = files.map((f) => {
    const touched = f.hunks.map((h) => [h.newStart, h.newStart + Math.max(h.newCount, 1) - 1]);
    const affected = affectedFor(new Map([[f.file, touched]]));
    return { file: f.file, isNew: !!f.isNew, affected };
  });

  // --- cluster hunks into logical flows ---
  const csToFlow = new Map();
  const flowDefById = new Map();
  flowDefs.forEach((fd, i) => { flowDefById.set(fd.id, { ...fd, order: i }); for (const cs of fd.changeSets) csToFlow.set(cs, fd.id); });
  const acc = new Map();
  const synthOrder = new Map();
  let synthN = 0;
  function ensureFlow(id, title, summary, order) {
    if (!acc.has(id)) acc.set(id, { id, title, summary, order, files: new Map(), ranges: new Map(), notes: [] });
    return acc.get(id);
  }
  for (const f of files) {
    for (const h of f.hunks) {
      const sig = hunkSignature(f.file, h);
      const note = noteFor(notes, sig);
      const cs = note && note.changeSet ? note.changeSet : "";
      let id, title, summary, order;
      if (cs && csToFlow.has(cs)) {
        const fd = flowDefById.get(csToFlow.get(cs));
        id = fd.id; title = fd.title; summary = fd.summary; order = fd.order;
      } else if (cs) {
        id = "cs-" + slug(cs);
        if (!synthOrder.has(id)) synthOrder.set(id, 1000 + synthN++);
        title = cs; summary = ""; order = synthOrder.get(id);
      } else {
        id = "other"; title = "Other changes"; summary = "Changes not yet grouped into a flow."; order = 9999;
      }
      const flow = ensureFlow(id, title, summary, order);
      if (!flow.files.has(f.file)) flow.files.set(f.file, { file: f.file, isNew: !!f.isNew, hunks: [] });
      const added = h.lines.filter((l) => l.sign === "+").length;
      const removed = h.lines.filter((l) => l.sign === "-").length;
      flow.files.get(f.file).hunks.push({ header: `@@ ${h.newStart},${h.newCount} @@`, sig, note, lines: h.lines, added, removed, range: [h.newStart, h.newStart + Math.max(h.newCount, 1) - 1] });
      if (!flow.ranges.has(f.file)) flow.ranges.set(f.file, []);
      flow.ranges.get(f.file).push([h.newStart, h.newStart + Math.max(h.newCount, 1) - 1]);
      if (note) flow.notes.push(note);
    }
  }
  const flows = [...acc.values()].sort((a, b) => a.order - b.order).map((fl) => {
    const affected = affectedFor(fl.ranges);
    const reviewedCount = affected.filter((a) => a.verified).length;
    const intentNote = fl.notes.find((n) => n.author === "ai" && n.aiIntent) || null;
    const srcNote = fl.notes.find((n) => n.sessionId) || null;
    const filesArr = [...fl.files.values()].map((ff) => {
      const firstLine = firstChangedLine(ff.hunks);
      const abs = path.resolve(repoRoot, ff.file);
      return { file: ff.file, isNew: ff.isNew, abs, openHref: "vscode://file/" + abs.replace(/\\/g, "/") + ":" + firstLine, firstLine, hunks: ff.hunks };
    });
    const changed = filesArr.reduce((a, ff) => { ff.hunks.forEach((h) => { a.added += h.added; a.removed += h.removed; }); return a; }, { added: 0, removed: 0 });
    // Attach each affected claim to a SINGLE change (dedupe in display order) so it
    // can be reviewed inline; badge how many other changes in this flow it also rests on.
    const perHunk = [];
    filesArr.forEach((ff) => ff.hunks.forEach((h) => { h.affected = []; perHunk.push({ file: ff.file, h }); }));
    const touch = new Map();
    perHunk.forEach((p) => { p.claims = affectedFor(new Map([[p.file, [p.h.range]]])); p.claims.forEach((c) => touch.set(c.blockId, (touch.get(c.blockId) || 0) + 1)); });
    const seenClaim = new Set();
    perHunk.forEach((p) => {
      for (const c of p.claims) {
        if (seenClaim.has(c.blockId)) continue;
        seenClaim.add(c.blockId);
        p.h.affected.push({ ...c, alsoTouches: (touch.get(c.blockId) || 1) - 1 });
      }
      delete p.claims;
    });
    return {
      id: fl.id, title: fl.title, summary: fl.summary,
      author: aggAuthor(fl.notes), confidence: aggConfidence(fl.notes),
      intent: intentNote ? intentNote.aiIntent : "",
      sessionId: srcNote ? srcNote.sessionId : "", turn: srcNote ? srcNote.turn : null,
      files: filesArr, affected, reviewedCount,
      reviewed: affected.length > 0 && reviewedCount === affected.length,
      severity: affected.length ? "HIGH" : "MED",
      isNew: filesArr.length > 0 && filesArr.every((ff) => ff.isNew),
      changed, fileCount: filesArr.length,
    };
  });
  // Flows that carry unreviewed claims are the real work-to-do.
  const count = flows.filter((f) => f.affected.length > 0 && !f.reviewed).length;
  return { isRepo: true, hasDiff: files.length > 0, count, items, flows };
}

// --- interactive Q&A (headless copilot) ---
// Locate a directly-spawnable copilot binary. Prefer a real .exe on Windows so
// we can pass a long multi-line prompt as a single argv with no shell escaping.
let _copilot;
function resolveCopilot() {
  if (_copilot !== undefined) return _copilot;
  if (process.env.FEY_COPILOT_BIN) { _copilot = { cmd: process.env.FEY_COPILOT_BIN, shell: false }; return _copilot; }
  if (process.platform !== "win32") { _copilot = { cmd: "copilot", shell: false }; return _copilot; }
  try {
    const lines = execFileSync("where.exe", ["copilot"], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = lines.find((s) => /\.exe$/i.test(s));
    if (exe) { _copilot = { cmd: exe, shell: false }; return _copilot; }
    const cmd = lines.find((s) => /\.cmd$/i.test(s));
    if (cmd) { _copilot = { cmd, shell: true }; return _copilot; }
  } catch { /* not on PATH */ }
  _copilot = null; return _copilot;
}

// Gather what a reader is asking about: the wiki prose for the block(s) plus the
// exact code LOCATIONS (file + line range + symbol) each claim is anchored to. We
// hand Copilot references, not file contents — it has read access to the repo, so
// it can open these files (and anything related) and answer in more depth. Keeping
// the prompt to references also keeps it small regardless of how big the code is.
function askContext(repoRoot, manifest, pageId, blockId) {
  const page = manifest.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const prose = M.loadPage(repoRoot, page.md);
  const blocks = blockId ? page.blocks.filter((b) => b.id === blockId) : page.blocks;
  if (!blocks.length) return null;
  const proseText = blocks.map((b) => prose.blocks[b.id] || "").filter(Boolean).join("\n\n");
  const refs = [];
  const seen = new Set();
  for (const sid of [...new Set(blocks.flatMap((b) => b.anchors))]) {
    const s = makeSpan(repoRoot, manifest, sid);
    if (!s) continue;
    const key = `${s.file}:${s.startLine}-${s.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ file: s.file, startLine: s.startLine, endLine: s.endLine, symbol: s.symbol || "" });
  }
  return { pageTitle: page.title, section: page.section || "Wiki", prose: proseText, refs, sources: [...new Set(refs.map((r) => r.file))] };
}

function askPrompt(repoName, ctx, selection, query) {
  const L = [];
  L.push(`You are the codebase guide for the "${repoName}" repository, answering a reader's question about one section of its fey wiki — documentation where every claim is anchored to specific lines of code. You have full read access to this repository: open the referenced files below (and any related code you need) to give a thorough, accurate, well-grounded answer. Cite file paths and line numbers. Do not propose or make any edits.`);
  L.push(`\n## Wiki section\n${ctx.section} \u203a ${ctx.pageTitle}`);
  if (ctx.prose) L.push(`\n## What the wiki says here\n${ctx.prose}`);
  if (selection && selection.trim()) L.push(`\n## The reader highlighted this text\n"${selection.trim()}"`);
  if (ctx.refs.length) {
    L.push(`\n## Code this section is anchored to — read these files as needed`);
    for (const r of ctx.refs) L.push(`- ${r.file} lines ${r.startLine}-${r.endLine}${r.symbol ? ` — ${r.symbol}` : ""}`);
  }
  L.push(`\n## Reader's question\n${query.trim()}`);
  return L.join("\n");
}

// Same idea as askContext, but for a Drift "flow" — a clustered, uncommitted change.
// We hand Copilot the change's intent + per-hunk rationale + the actual diff, and let
// it open the changed files itself for the surrounding context.
function askDiffContext(repoRoot, manifest, flowId) {
  const drift = computeDrift(repoRoot, manifest);
  if (!drift.flows) return null;
  const fl = drift.flows.find((f) => f.id === flowId);
  if (!fl) return null;
  const files = fl.files.map((ff) => ({
    file: ff.file, isNew: ff.isNew,
    hunks: ff.hunks.map((h) => ({
      author: h.note ? h.note.author : "unknown",
      rationale: h.note && h.note.rationale ? h.note.rationale : "",
      range: h.range,
      diff: h.lines.map((l) => `${l.sign}${l.text}`).join("\n"),
    })),
  }));
  return {
    title: fl.title, summary: fl.summary, author: fl.author, intent: fl.intent,
    files, sources: [...new Set(fl.files.map((ff) => ff.file))],
  };
}

function askDiffPrompt(repoName, ctx, selection, query) {
  const who = ctx.author === "ai" ? "an AI agent" : ctx.author === "human" ? "a human author" : ctx.author === "mixed" ? "an AI agent and a human" : "an unknown author";
  const L = [];
  L.push(`You are the code-change guide for the "${repoName}" repository, helping a reviewer understand an uncommitted change (a "drift flow" in its fey wiki). You have full read access to this repository — open the changed files below (and any related code) to explain the change accurately and answer in depth. Cite file paths and line numbers. Do not propose or make any edits.`);
  L.push(`\n## The change\n${ctx.title}${ctx.summary ? ` — ${ctx.summary}` : ""}`);
  L.push(`Attributed to: ${who}.`);
  if (ctx.intent) L.push(`Stated intent behind it: ${ctx.intent}`);
  for (const f of ctx.files) {
    L.push(`\n## ${f.isNew ? "New file" : "Changed file"}: ${f.file}`);
    for (const h of f.hunks) {
      if (h.rationale) L.push(`Rationale (${h.author}): ${h.rationale}`);
      L.push(`Around lines ${h.range[0]}-${h.range[1]}:`);
      L.push("```diff\n" + h.diff + "\n```");
    }
  }
  if (selection && selection.trim()) L.push(`\n## The reader highlighted this text\n"${selection.trim()}"`);
  L.push(`\n## Reader's question\n${query.trim()}`);
  return L.join("\n");
}

// --- Diagrams tab: ask about one entry-point flow ---
// Same idea as askContext: hand Copilot the flow's summary plus a *reference* to
// each anchored call (file + line range + symbol), not the code, and let it open
// those files itself. Keeps the prompt small no matter how deep the flow.
function askDiagramContext(repoRoot, manifest, diagramId) {
  const diagram = DG.loadDiagram(repoRoot, diagramId);
  if (!diagram) return null;
  const refs = [];
  const seen = new Set();
  for (const n of diagram.nodes || []) {
    if (!n.anchor) continue;
    const s = makeSpan(repoRoot, manifest, n.anchor);
    if (!s) continue;
    const key = `${s.file}:${s.startLine}-${s.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ file: s.file, startLine: s.startLine, endLine: s.endLine, symbol: s.symbol || n.name });
  }
  const steps = (diagram.nodes || []).slice().sort((a, b) => a.order - b.order)
    .map((n) => `${n.name}()${n.resolved === false ? " [external/unresolved]" : ""}${n.note ? ` — ${n.note}` : ""}`);
  return {
    entry: diagram.entry, title: diagram.title, kind: diagram.kind,
    summary: diagram.summary || "", steps, refs, sources: [...new Set(refs.map((r) => r.file))],
  };
}

function askDiagramPrompt(repoName, ctx, selection, query) {
  const L = [];
  L.push(`You are the codebase guide for the "${repoName}" repository, answering a reader's question about one control-flow diagram in its fey wiki — a statically-parsed map of how one entry point flows through the code, where every step is anchored to specific lines. You have full read access to this repository: open the referenced files below (and any related code) to give a thorough, accurate answer grounded in the real flow. Cite file paths and line numbers. Do not propose or make any edits.`);
  L.push(`\n## Entry-point flow\n${ctx.title} — ${ctx.entry}${ctx.kind ? ` (${ctx.kind})` : ""}`);
  if (ctx.summary) L.push(`\n## What this flow does\n${ctx.summary}`);
  if (ctx.steps && ctx.steps.length) L.push(`\n## The call path (in order)\n${ctx.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  if (selection && selection.trim()) L.push(`\n## The reader highlighted this text\n"${selection.trim()}"`);
  if (ctx.refs.length) {
    L.push(`\n## Code this flow is anchored to — read these files as needed`);
    for (const r of ctx.refs) L.push(`- ${r.file} lines ${r.startLine}-${r.endLine}${r.symbol ? ` — ${r.symbol}` : ""}`);
  }
  L.push(`\n## Reader's question\n${query.trim()}`);
  return L.join("\n");
}

function copilotAskArgs(repoRoot) {
  const args = [
    "-C", repoRoot,
    "-s",
    "--no-ask-user",
    "--available-tools", "view", "rg", "glob",
    "--allow-all-tools",
    "--deny-tool=write",
    "--deny-tool=shell",
  ];
  if (process.env.FEY_ASK_MODEL) args.push("--model", process.env.FEY_ASK_MODEL);
  return args;
}

// --- Optimize tab: read the fey-improve run log from `.fey/improve/` ---
// fey-improve writes its whole run (directions, rubric, per-iteration history,
// parallel proposals) as plain JSON under `.fey/improve/` — a subfolder of this same
// bundle. The scoring is already baked into history.json at record time, so here
// we only read the files, compute the running "best so far" line the hill-climb
// chart draws, attach each step's scratch proposals, and summarize. Read-only.
function loadOptJson(repoRoot, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, ".fey", "improve", name), "utf8")); }
  catch { return fallback; }
}
function loadOptScratch(repoRoot, n) {
  const dir = path.join(repoRoot, ".fey", "improve", "scratch", `iter-${n}`);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch { /* skip */ }
  }
  return out;
}
function buildOpt(repoRoot) {
  const run = loadOptJson(repoRoot, "run.json", null);
  if (!run) return null;
  const directions = loadOptJson(repoRoot, "directions.json", []);
  const rubric = loadOptJson(repoRoot, "rubric.json", { criteria: [] });
  const history = loadOptJson(repoRoot, "history.json", []).slice().sort((a, b) => a.n - b.n);

  let bestSoFar = null;
  const iterations = history.map((h) => {
    if (h.kept !== false) bestSoFar = bestSoFar == null ? h.total : Math.max(bestSoFar, h.total);
    return { ...h, bestSoFar, proposals: h.baseline ? [] : loadOptScratch(repoRoot, h.n) };
  });

  const kept = history.filter((h) => h.kept !== false);
  const best = kept.length ? kept.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const baseline = history.find((h) => h.baseline) || null;
  const committed = history.filter((h) => h.committed);
  return {
    run, directions, rubric, iterations,
    summary: {
      title: run.title,
      target: run.target,
      scope: run.scope,
      status: run.status,
      sourceBranch: run.sourceBranch || null,
      workBranch: run.workBranch || null,
      baselineTotal: baseline ? baseline.total : null,
      bestTotal: best ? best.total : null,
      bestIteration: best ? best.n : null,
      gain: best && baseline ? Math.round((best.total - baseline.total) * 10) / 10 : null,
      steps: history.filter((h) => !h.baseline).length,
      kept: committed.length,
      directionsCount: directions.length,
      criteriaCount: (rubric.criteria || []).length,
    },
  };
}

// Resolve one diagram for the viewer: attach the anchored file + line range +
// symbol to every node (so a click can light the exact code), and pass lanes and
// branches through. Read-only; returns null if the diagram doesn't exist.
function resolveDiagram(repoRoot, manifest, id) {
  const diagram = DG.loadDiagram(repoRoot, id);
  if (!diagram) return null;
  const resolveNode = (n) => {
    const s = n.anchor ? makeSpan(repoRoot, manifest, n.anchor) : null;
    return {
      id: n.id, name: n.name, lane: n.lane, parent: n.parent == null ? null : n.parent,
      order: n.order, resolved: n.resolved !== false, note: n.note || "",
      anchor: n.anchor || null,
      file: s ? s.file : null, startLine: s ? s.startLine : null, endLine: s ? s.endLine : null, symbol: s ? s.symbol : null,
    };
  };
  return {
    id: diagram.id, entry: diagram.entry, title: diagram.title, kind: diagram.kind,
    language: diagram.language || "", summary: diagram.summary || "",
    lanes: diagram.lanes || [],
    nodes: (diagram.nodes || []).map(resolveNode).sort((a, b) => a.order - b.order),
    branches: (diagram.branches || []).map((br) => ({ label: br.label, nodes: (br.nodes || []).map(resolveNode).sort((a, b) => a.order - b.order) })),
    sources: [...new Set((diagram.nodes || []).map((n) => n.anchor && makeSpan(repoRoot, manifest, n.anchor)).filter(Boolean).map((s) => s.file))],
  };
}

function serve(repoRoot, port) {
  const viewerDir = path.join(__dirname, "viewer");
  const repoName = path.basename(path.resolve(repoRoot));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "api") {
        // Optimize tab reads its own `.fey/improve/` log and does not require a wiki
        // manifest — handle it before the manifest gate below.
        if (parts[1] === "opt") {
          const data = buildOpt(repoRoot);
          if (!data) return json(res, 404, { error: "no .fey/improve/run.json — run `fey-improve init` first" });
          return json(res, 200, { repoName, ...data });
        }
        // Liveness probe for the agentStop dashboard gate. Answers "is a fey
        // dashboard actually up for this repo?" without needing a wiki manifest,
        // so it works for create-only, improve-only, or both. Returns which
        // bundles are present so the checker can report precisely.
        if (parts[1] === "health") {
          return json(res, 200, {
            ok: true,
            product: "fey",
            repoName,
            port,
            pid: process.pid,
            bundles: {
              create: fs.existsSync(path.join(repoRoot, ".fey", "create", "manifest.json")),
              improve: fs.existsSync(path.join(repoRoot, ".fey", "improve", "run.json")),
            },
          });
        }
        const manifest = M.loadManifest(repoRoot);
        if (!manifest) return json(res, 404, { error: "no .fey/create/manifest.json — run `fey index` first" });

        if (parts[1] === "overview") {
          const st = statsAndCoverage(repoRoot, manifest);
          const drift = computeDrift(repoRoot, manifest);
          const driftPages = new Set(drift.items.flatMap((i) => i.affected.filter((a) => !a.verified).map((a) => a.pageId)));
          const architecture = (manifest.architecture || []).map((g) => ({
            group: g.group,
            path: g.path,
            files: g.files.map((rel) => ({ file: rel, coverage: st.cov(rel) })),
          }));
          const pages = manifest.pages.map((p) => ({
            id: p.id,
            title: p.title,
            section: p.section || "Wiki",
            blurb: p.blurb || "",
            sources: [...new Set(p.blocks.flatMap((b) => b.anchors.map((s) => (makeSpan(repoRoot, manifest, s) || {}).file).filter(Boolean)))].length,
            drifted: driftPages.has(p.id),
          }));
          return json(res, 200, {
            repoName,
            description: manifest.description || "",
            strategy: manifest.strategy,
            stats: {
              filesIndexed: st.filesIndexed,
              wikiPages: st.wikiPages,
              linesAnchoredPct: st.linesAnchoredPct,
              drifted: drift.count,
            },
            drift: { isRepo: drift.isRepo, hasDiff: drift.hasDiff, count: drift.count },
            architecture,
            pages,
          });
        }

        if (parts[1] === "nav") {
          const st = statsAndCoverage(repoRoot, manifest);
          const drift = computeDrift(repoRoot, manifest);
          const driftFiles = new Set(drift.items.flatMap((i) => i.affected.filter((a) => !a.verified).map((a) => a.pageId)));
          const sections = [];
          const byName = {};
          for (const p of manifest.pages) {
            const name = p.section || "Wiki";
            if (!byName[name]) { byName[name] = { section: name, pages: [] }; sections.push(byName[name]); }
            byName[name].pages.push({ id: p.id, title: p.title, drifted: driftFiles.has(p.id) });
          }
          return json(res, 200, {
            repoName,
            strategy: manifest.strategy,
            driftCount: drift.count,
            coverage: st.linesAnchoredPct,
            fileCount: st.filesIndexed,
            pageCount: st.wikiPages,
            sections,
          });
        }

        if (parts[1] === "page" && parts[2]) {
          const page = manifest.pages.find((p) => p.id === parts[2]);
          if (!page) return json(res, 404, { error: "page not found" });
          const drift = computeDrift(repoRoot, manifest);
          const driftedBlocks = new Set(drift.items.flatMap((i) => i.affected.map((a) => a.blockId)));
          const prose = M.loadPage(repoRoot, page.md);
          const resolve = (spanId) => {
            const s = makeSpan(repoRoot, manifest, spanId);
            return s ? { id: spanId, file: s.file, symbol: s.symbol, kind: s.kind, startLine: s.startLine, endLine: s.endLine } : null;
          };
          const blocks = page.blocks.map((b) => ({
            id: b.id,
            prose: prose.blocks[b.id] || "",
            anchors: b.anchors.map(resolve).filter(Boolean),
            origin: b.origin,
            locked: !!b.locked,
            anchorPinned: !!b.anchorPinned,
            drifted: driftedBlocks.has(b.id),
          }));
          const anchorCount = blocks.reduce((n, b) => n + b.anchors.length, 0);
          const sources = [...new Set(blocks.flatMap((b) => b.anchors.map((a) => a.file)))];
          return json(res, 200, { id: page.id, title: page.title, section: page.section || "Wiki", intro: prose.intro, blocks, anchorCount, sources, notes: PN.notesFor(repoRoot, page.id) });
        }

        if (parts[1] === "file") {
          const rel = url.searchParams.get("path");
          const abs = path.join(repoRoot, rel || "");
          if (!rel || !path.resolve(abs).startsWith(path.resolve(repoRoot)) || !fs.existsSync(abs)) {
            return json(res, 404, { error: "file not found" });
          }
          const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/).map((text, i) => ({ n: i + 1, text }));
          return json(res, 200, { file: rel, lines });
        }

        if (parts[1] === "drift") {
          return json(res, 200, computeDrift(repoRoot, manifest));
        }

        if (parts[1] === "diagrams" && !parts[2]) {
          const index = DG.loadIndex(repoRoot);
          if (!index) return json(res, 404, { error: "no .fey/create/diagrams/index.json — run `fey diagrams build` first" });
          return json(res, 200, { repoName, ...index });
        }

        if (parts[1] === "diagrams" && parts[2]) {
          const d = resolveDiagram(repoRoot, manifest, parts[2]);
          if (!d) return json(res, 404, { error: "diagram not found" });
          return json(res, 200, d);
        }

        if (parts[1] === "block" && parts[2] && req.method === "POST") {
          const body = await readBody(req);
          const page = manifest.pages.find((p) => p.blocks.some((b) => b.id === parts[2]));
          if (!page) return json(res, 404, { error: "block not found" });
          const block = page.blocks.find((b) => b.id === parts[2]);
          if (typeof body.prose === "string") { M.writeBlockProse(repoRoot, page.md, block.id, body.prose); block.origin = "human-edited"; }
          if (typeof body.locked === "boolean") block.locked = body.locked;
          if (typeof body.anchorPinned === "boolean") block.anchorPinned = body.anchorPinned;
          M.saveManifest(repoRoot, manifest);
          return json(res, 200, { ok: true });
        }

        if (parts[1] === "verify" && parts[2] && req.method === "POST") {
          const body = await readBody(req);
          const page = manifest.pages.find((p) => p.blocks.some((b) => b.id === parts[2]));
          if (!page) return json(res, 404, { error: "claim not found" });
          const block = page.blocks.find((b) => b.id === parts[2]);
          const on = body.reviewed !== false;
          setVerified(repoRoot, manifest, block, on);
          return json(res, 200, { ok: true, reviewed: on });
        }

        if (parts[1] === "page-note" && parts[2] && req.method === "POST") {
          const body = await readBody(req);
          if (!manifest.pages.some((p) => p.id === parts[2])) return json(res, 404, { error: "page not found" });
          const notes = PN.addNote(repoRoot, parts[2], body.type, body.text);
          return json(res, 200, { ok: true, notes });
        }

        if (parts[1] === "ask" && req.method === "POST") {
          const body = await readBody(req);
          const query = (body.query || "").toString().trim();
          if (!query) return json(res, 400, { error: "empty query" });
          let prompt;
          if (body.flowId) {
            const ctx = askDiffContext(repoRoot, manifest, body.flowId);
            if (!ctx) return json(res, 404, { error: "unknown flow" });
            prompt = askDiffPrompt(repoName, ctx, body.selection || "", query);
          } else if (body.diagramId) {
            const ctx = askDiagramContext(repoRoot, manifest, body.diagramId);
            if (!ctx) return json(res, 404, { error: "unknown diagram" });
            prompt = askDiagramPrompt(repoName, ctx, body.selection || "", query);
          } else {
            const ctx = askContext(repoRoot, manifest, body.pageId, body.blockId);
            if (!ctx) return json(res, 404, { error: "unknown page/block" });
            prompt = askPrompt(repoName, ctx, body.selection || "", query);
          }
          const cop = resolveCopilot();
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          if (!cop) { res.end("__OLO_ERR__Copilot CLI not found on PATH. Install it and make sure `copilot` is available, then retry."); return; }
          // Pass the prompt over stdin, NOT as a -p argv. The prompt is compact for wiki
          // asks (file references) but can be larger for diff asks; stdin keeps us safe
          // from the OS command-line limit (Windows ~32KB → spawn ENAMETOOLONG) either way.
          // copilot reads stdin as the prompt when -p is omitted.
          const args = copilotAskArgs(repoRoot);
          let child;
          try { child = spawn(cop.cmd, args, { cwd: repoRoot, shell: cop.shell }); }
          catch (e) { res.end("__OLO_ERR__Could not launch copilot: " + (e && e.message ? e.message : e)); return; }
          try { child.stdin.on("error", () => { /* EPIPE if child exits early */ }); child.stdin.write(prompt); child.stdin.end(); }
          catch { /* child already gone */ }
          const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 180000);
          child.stdout.on("data", (d) => { try { res.write(d); } catch { /* client gone */ } });
          child.stderr.on("data", () => { /* progress noise — swallow */ });
          child.on("error", (e) => { clearTimeout(killer); try { res.end("__OLO_ERR__" + (e && e.message ? e.message : e)); } catch { /* noop */ } });
          child.on("close", () => { clearTimeout(killer); try { res.end(); } catch { /* noop */ } });
          req.on("close", () => { clearTimeout(killer); try { child.kill(); } catch { /* noop */ } });
          return;
        }

        return json(res, 404, { error: "unknown api route" });
      }

      // static viewer
      let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const abs = path.join(viewerDir, file);
      if (!abs.startsWith(viewerDir) || !fs.existsSync(abs)) { res.writeHead(404); return res.end("not found"); }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[path.extname(abs)] || "text/plain" });
      res.end(fs.readFileSync(abs));
    } catch (err) {
      json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  server.listen(port, () => {
    writeServeRunfile(repoRoot, port);
    console.log(`fey serving ${repoName} at http://localhost:${port}`);
  });
}

// A small runtime marker the agentStop dashboard gate reads to discover the live
// port (and confirm it was fey that started the server). It lives under `.fey/`,
// which drift already ignores, so it never shows up as a change. Best-effort:
// serving must never fail because we couldn't write or clean this file.
function serveRunfilePath(repoRoot) {
  return path.join(repoRoot, ".fey", "serve.json");
}

function writeServeRunfile(repoRoot, port) {
  try {
    const dir = path.join(repoRoot, ".fey");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      serveRunfilePath(repoRoot),
      JSON.stringify({ product: "fey", port, pid: process.pid, url: `http://localhost:${port}`, startedAt: new Date().toISOString() }, null, 2)
    );
    const cleanup = () => { try { fs.unlinkSync(serveRunfilePath(repoRoot)); } catch {} };
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  } catch {}
}

module.exports = { serve, copilotAskArgs };
