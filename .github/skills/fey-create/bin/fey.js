#!/usr/bin/env node
"use strict";
// fey CLI:
//   fey index <repoDir> [--builtin]  (re)build the span catalog into .fey/create/manifest.json
//   fey serve <repoDir> [--port N]   run the local wiki viewer
//
// Indexing is pluggable. If the repo contains a generated indexer at
// `.fey/create/indexer.mjs` (or .cjs/.js), fey runs THAT — a per-repo extractor the fey
// skill authored for this codebase — and validates its output against the span
// contract. Otherwise it falls back to the built-in multi-language indexer.
const path = require("path");
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");
const { indexRepo } = require("../src/indexer");
const { normalizeSpans } = require("../src/spanContract");
const { computeCoverage } = require("../src/coverage");
const { loadGateConfig } = require("../src/gate");
const { merge } = require("../src/merge");
const { buildDiagrams } = require("../src/diagrams");
const { diffHunks } = require("../src/gitdiff");
const { loadDriftNotes } = require("../src/driftNotes");
const M = require("../src/manifest");
const { serve } = require("../src/server");

const GENERATED_INDEXERS = ["indexer.mjs", "indexer.cjs", "indexer.js"];

function findGeneratedIndexer(repoRoot) {
  for (const name of GENERATED_INDEXERS) {
    const p = path.join(repoRoot, ".fey", "create", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Run a repo-generated indexer and return its validated span map. The indexer is
// a Node script invoked as `node <indexer> <repoRoot>` that prints a JSON object
// `{ "spans": [ { file, symbol, kind?, startLine, endLine }, ... ] }` to stdout
// (logs, if any, go to stderr). Throws with an actionable message on any problem.
function runGeneratedIndexer(indexerPath, repoRoot) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [indexerPath, repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = (e.stderr || e.message || "").toString().trim();
    throw new Error(`generated indexer failed to run:\n${err}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const head = stdout.slice(0, 300);
    throw new Error(
      `generated indexer did not print valid JSON to stdout (logs must go to stderr).\nGot: ${head}`
    );
  }

  const rawSpans = Array.isArray(parsed) ? parsed : parsed && parsed.spans;
  const { spans, errors, warnings } = normalizeSpans(rawSpans, repoRoot);
  if (errors.length) {
    throw new Error(
      `generated indexer produced ${errors.length} invalid span(s):\n  - ` +
        errors.slice(0, 20).join("\n  - ") +
        (errors.length > 20 ? `\n  … and ${errors.length - 20} more` : "")
    );
  }
  for (const w of warnings) console.warn(`fey: warning: ${w}`);
  return spans;
}

function cmdIndex(repoRoot, opts) {
  const generated = opts.builtin ? null : findGeneratedIndexer(repoRoot);
  let spans, source;
  if (generated) {
    spans = runGeneratedIndexer(generated, repoRoot);
    source = path.relative(repoRoot, generated).split(path.sep).join("/");
  } else {
    spans = indexRepo(repoRoot);
    source = "built-in";
  }

  let manifest = M.loadManifest(repoRoot);
  if (!manifest) {
    manifest = {
      version: 1,
      strategy: "unset",
      strategyRationale: "Run the fey skill to author pages.",
      spans: {},
      pages: [],
    };
  }
  manifest.spans = spans; // refresh snapshot; pages/blocks are preserved
  M.saveManifest(repoRoot, manifest);
  console.log(
    `fey: indexed ${Object.keys(spans).length} spans via ${source} -> .fey/create/manifest.json`
  );
}

function cmdCoverage(repoRoot, opts) {
  const manifest = M.loadManifest(repoRoot);
  if (!manifest) {
    console.error("fey: no .fey/create/manifest.json — run `fey index` first");
    process.exit(1);
  }
  const cov = computeCoverage(repoRoot, manifest);
  if (opts.json) {
    console.log(JSON.stringify({ totalPct: cov.totalPct, filesIndexed: cov.filesIndexed, perFile: cov.perFile, invalidAnchors: cov.invalidAnchors }, null, 2));
    return;
  }
  console.log(`fey coverage: ${cov.totalPct}% of lines anchored (${cov.anchoredLines}/${cov.totalLines}), ${cov.filesIndexed} files`);
  for (const rel of cov.files) {
    const f = cov.perFile[rel];
    console.log(`  ${String(f.pct).padStart(3)}%  ${rel}  (${f.anchored}/${f.total})`);
  }
  if (cov.invalidAnchors.length) {
    console.log(`  INVALID  ${cov.invalidAnchors.length} page anchor(s) do not resolve against the current repository`);
  }
}

// Evaluate the coverage gate. Returns { skipped, pass, report }.
function evaluateGate(repoRoot) {
  const manifest = M.loadManifest(repoRoot);
  if (!manifest) {
    return { skipped: true, pass: true, report: "fey gate: no .fey/create/manifest.json in this repo — nothing to gate." };
  }
  const cfg = loadGateConfig(repoRoot);
  const cov = computeCoverage(repoRoot, manifest);

  const totalPass = cov.totalPct >= cfg.minTotalCoverage;
  const anchorFails = cov.invalidAnchors || [];
  const fileFails = [];
  for (const rel of cov.files) {
    const f = cov.perFile[rel];
    if (f.total === 0) continue;            // empty file: nothing to cover
    if (cfg.isExcluded(rel)) continue;      // opted out in gate.json
    if (f.pct < cfg.minFileCoverage) fileFails.push({ rel, ...f });
  }
  const pass = totalPass && fileFails.length === 0 && anchorFails.length === 0;

  const lines = [];
  lines.push(`fey coverage gate: ${pass ? "PASSED" : "FAILED"}`);
  lines.push(`Thresholds (.fey/create/gate.json): total >= ${cfg.minTotalCoverage}%, per-file >= ${cfg.minFileCoverage}%`);
  lines.push("");
  lines.push(`Total coverage: ${cov.totalPct}%  (need >= ${cfg.minTotalCoverage}%)  ${totalPass ? "OK" : "MISS"}`);
  if (anchorFails.length) {
    lines.push("");
    lines.push("Invalid page anchors:");
    for (const a of anchorFails.slice(0, 40)) {
      lines.push(`  [ ] ${a.pageId || "unknown page"} / ${a.blockId || "unknown block"} -> ${a.spanId}`);
    }
    if (anchorFails.length > 40) lines.push(`  ... and ${anchorFails.length - 40} more`);
  }
  if (fileFails.length) {
    lines.push("");
    lines.push(`Files below ${cfg.minFileCoverage}%:`);
    for (const f of fileFails.sort((a, b) => a.pct - b.pct)) {
      lines.push(`  ${String(f.pct).padStart(3)}%  ${f.rel}  (${f.anchored}/${f.total} lines)`);
    }
  }
  if (!pass) {
    lines.push("");
    lines.push("To pass: add wiki claims that anchor to the uncovered code above -- edit");
    lines.push(".fey/create/pages/*.md and add blocks whose anchors point at spans in those files");
    lines.push("(use `fey coverage` to see per-file detail). If a file legitimately needs no");
    lines.push('docs, add it to "exclude" in .fey/create/gate.json.');
  }
  return { skipped: false, pass, report: lines.join("\n") };
}

function cmdGate(repoRoot) {
  const { pass, report } = evaluateGate(repoRoot);
  console.log(report);
  process.exit(pass ? 0 : 1);
}

// Evaluate the DRIFT-ATTRIBUTION gate: every live diff hunk the Drift view shows
// must have a note in .fey/create/drift-notes.json. This is what makes the "why
// did this change, and was it AI?" narration compulsory rather than optional —
// the wiki isn't "done" while the working tree has unexplained changes.
// Returns { skipped, pass, report }. Skips when there's no create bundle (nothing
// to attribute against) or the repo has no uncommitted changes.
function evaluateDriftGate(repoRoot) {
  const manifest = M.loadManifest(repoRoot);
  if (!manifest) {
    return { skipped: true, pass: true, report: "fey drift-gate: no .fey/create/manifest.json — no wiki to attribute drift against." };
  }
  const d = diffHunks(repoRoot);
  if (!d.isRepo) {
    return { skipped: true, pass: true, report: "fey drift-gate: not a git repository — no drift to explain." };
  }
  const { notes } = loadDriftNotes(repoRoot);
  const flat = [];
  for (const f of d.files || []) for (const h of f.hunks) flat.push({ sig: h.sig, file: f.file, explained: !!notes[h.sig] });
  if (flat.length === 0) {
    return { skipped: true, pass: true, report: "fey drift-gate: no uncommitted changes — nothing to explain." };
  }
  const unexplained = flat.filter((h) => !h.explained);
  const pass = unexplained.length === 0;

  const lines = [];
  lines.push(`fey drift-gate: ${pass ? "PASSED" : "FAILED"}`);
  lines.push(`${flat.length} hunk(s) in the working tree; ${unexplained.length} still unexplained.`);
  if (!pass) {
    lines.push("");
    lines.push("These hunks have no attribution in .fey/create/drift-notes.json, so the Drift");
    lines.push('view renders them "Unattributed" instead of narrated. Explain each one:');
    for (const h of unexplained.slice(0, 40)) lines.push(`  [ ] ${h.sig}  ${h.file}`);
    if (unexplained.length > 40) lines.push(`  … and ${unexplained.length - 40} more`);
    lines.push("");
    lines.push("Run `fey diff-hunks <repo> --json`, attribute each hunk from the local session");
    lines.push('store, and write .fey/create/drift-notes.json (see SKILL.md "Explaining drift").');
  }
  return { skipped: false, pass, report: lines.join("\n") };
}

// Evaluate the DASHBOARD gate: is a fey dashboard actually being served for this
// repo? Reads the runfile fey serve drops at .fey/serve.json, then probes
// /api/health on that port to confirm a live fey server answers. Returns a
// Promise<{ skipped, pass, report }>. Never skips on presence of `.fey` — the
// whole point is to force the agent to serve the dashboard.
function evaluateDashboard(repoRoot) {
  return new Promise((resolve) => {
    const runfile = path.join(repoRoot, ".fey", "serve.json");
    const fail = (why) => resolve({
      skipped: false, pass: false,
      report: [
        "fey dashboard: NOT SERVED",
        why,
        "",
        "Start it (in the background so it survives the turn) and leave it running:",
        "  fey serve <repo>",
      ].join("\n"),
    });
    let info;
    try {
      if (!fs.existsSync(runfile)) return fail("No .fey/serve.json — no fey server has been started for this repo.");
      info = JSON.parse(fs.readFileSync(runfile, "utf8"));
    } catch {
      return fail("Could not read .fey/serve.json — start the server again.");
    }
    const port = Number(info && info.port);
    if (!port) return fail("No port recorded in .fey/serve.json — start the server again.");

    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const h = JSON.parse(body);
          if (res.statusCode === 200 && h && h.ok && h.product === "fey") {
            return resolve({ skipped: false, pass: true, report: `fey dashboard: LIVE at http://localhost:${port} (${h.repoName || "repo"}).` });
          }
        } catch {}
        fail(`Something is on port ${port} but it isn't a fey dashboard — restart fey serve.`);
      });
    });
    req.on("timeout", () => { req.destroy(); fail(`fey server on port ${port} did not respond — restart it.`); });
    req.on("error", () => fail(`Nothing is listening on port ${port} — the fey server isn't running.`));
  });
}

// The single umbrella the agentStop hook calls. Guarded by the presence of a
// `.fey` folder so it NEVER traps the agent in unrelated repos: no `.fey` → skip
// silently. When `.fey` exists it enforces, in order, coverage + drift
// attribution + a live dashboard, and prints one combined actionable report.
async function cmdStopCheck(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, ".fey"))) {
    process.exit(0); // not a fey repo — allow the stop, say nothing.
  }
  const checks = [
    { name: "coverage", ...evaluateGate(repoRoot) },
    { name: "drift", ...evaluateDriftGate(repoRoot) },
    { name: "dashboard", ...(await evaluateDashboard(repoRoot)) },
  ];
  const failed = checks.filter((c) => !c.skipped && !c.pass);
  const out = [];
  for (const c of checks) { out.push(c.report); out.push(""); }
  console.log(out.join("\n").trimEnd());
  process.exit(failed.length ? 1 : 0);
}

function cmdMerge(repoRoot, opts) {
  const { ok, report } = merge(repoRoot, opts);
  console.log(report);
  process.exit(ok ? 0 : 1);
}

// Deterministic reduce for the Diagrams tab: validate every authored flow in
// .fey/create/diagrams/scratch/<id>/ and, only if the whole set is valid, write the
// per-diagram files + index.json. No LLM in the loop — anchors are checked
// against the span catalog, so a diagram can never cite code that isn't there.
function cmdDiagrams(repoRoot, opts) {
  const r = buildDiagrams(repoRoot, opts);
  if (!r.ok) {
    console.error(`fey diagrams: build failed — ${r.errors.length} error(s):`);
    for (const e of r.errors) console.error(`  - ${e}`);
    console.error("fey diagrams: nothing written; existing diagrams left unchanged. Fix the scratch files and re-run.");
    process.exit(1);
  }
  console.log(`fey diagrams: built ${r.written.length} diagram(s) → .fey/create/diagrams/  (${r.written.join(", ")})`);
  if (opts.clean) console.log("fey diagrams: cleaned .fey/create/diagrams/scratch/");
  console.log("View them in the Diagrams tab: fey serve <repoDir>");
}

// Deterministic foundation for drift attribution. Prints the current diff as a
// flat list of hunks, each with a stable signature and its existing note (if any),
// so the fey skill knows exactly which hunks still need a "why did this change"
// explanation written into .fey/create/drift-notes.json.
function cmdDiffHunks(repoRoot, opts) {
  const d = diffHunks(repoRoot);
  const { notes } = loadDriftNotes(repoRoot);
  const flat = [];
  for (const f of d.files || []) {
    for (const h of f.hunks) {
      flat.push({
        sig: h.sig,
        file: f.file,
        newStart: h.newStart,
        newCount: h.newCount,
        added: h.added,
        removed: h.removed,
        explained: !!notes[h.sig],
        addedLines: opts.full ? h.lines.filter((l) => l.sign === "+").map((l) => l.text) : undefined,
      });
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ isRepo: d.isRepo, hasDiff: d.hasDiff, hunks: flat }, null, 2));
    return;
  }
  if (!d.isRepo) return console.log("fey diff-hunks: not a git repository — no drift to explain.");
  if (!d.hasDiff) return console.log("fey diff-hunks: no uncommitted changes.");
  const unexplained = flat.filter((h) => !h.explained).length;
  console.log(`fey diff-hunks: ${flat.length} hunk(s) across ${d.files.length} file(s); ${unexplained} unexplained.`);
  for (const h of flat) {
    console.log(`  ${h.explained ? "[x]" : "[ ]"} ${h.sig}  ${h.file}  +${h.added}/-${h.removed}  @${h.newStart}`);
  }
  if (unexplained) console.log("\nWrite a note per unexplained hunk into .fey/create/drift-notes.json (see SKILL.md `Explaining drift`).");
}

function main() {
  const [cmd, dirArg, ...rest] = process.argv.slice(2);
  const repoRoot = path.resolve(dirArg || ".");
  if (cmd === "index") {
    try {
      return cmdIndex(repoRoot, { builtin: rest.includes("--builtin") });
    } catch (e) {
      console.error(`fey: index failed — ${e.message}`);
      console.error("fey: manifest left unchanged. Fix .fey/create/indexer.mjs and re-run (or use --builtin).");
      process.exit(1);
    }
  }
  if (cmd === "coverage") return cmdCoverage(repoRoot, { json: rest.includes("--json") });
  if (cmd === "gate") return cmdGate(repoRoot);
  if (cmd === "drift-gate") {
    const { pass, report } = evaluateDriftGate(repoRoot);
    console.log(report);
    process.exit(pass ? 0 : 1);
  }
  if (cmd === "stop-check") return cmdStopCheck(repoRoot);
  if (cmd === "merge") return cmdMerge(repoRoot, { clean: rest.includes("--clean") });
  if (cmd === "diagrams") {
    // `fey diagrams build <repoDir>` — the subcommand occupies the dirArg slot,
    // so the repo is the next token.
    const sub = dirArg;
    if (sub && sub !== "build") { console.error(`fey diagrams: unknown subcommand "${sub}" (expected: build)`); process.exit(1); }
    const repo = path.resolve(rest.find((a) => !a.startsWith("--")) || ".");
    return cmdDiagrams(repo, { clean: rest.includes("--clean") });
  }
  if (cmd === "diff-hunks") return cmdDiffHunks(repoRoot, { json: rest.includes("--json"), full: rest.includes("--full") });
  if (cmd === "serve") {
    const pi = rest.indexOf("--port");
    const port = pi >= 0 ? Number(rest[pi + 1]) : 4177;
    return serve(repoRoot, port);
  }
  console.log("usage: fey <index|merge|diagrams build|diff-hunks|coverage|gate|drift-gate|stop-check|serve> <repoDir> [--port N] [--builtin] [--json] [--full] [--clean]");
  process.exit(1);
}

main();
