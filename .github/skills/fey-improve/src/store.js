"use strict";
// The deterministic heart of fey-improve. Everything the auto-improve loop
// remembers lives in a single `.fey/improve/` folder in the target repo (a subfolder
// of fey's own `.fey/` bundle), as plain JSON so it is inspectable, diffable, and
// editable by hand:
//
//   .fey/improve/
//     run.json          # the run: target (codebase|diff), scope, status, best
//     directions.json   # optimization directions Copilot identified
//     rubric.json       # weighted criteria the run is scored against
//     history.json      # every iteration + its score (the hill-climb series)
//     scratch/iter-<n>/ # per-agent improvement proposals for iteration <n>
//
// This module never calls an LLM. It only reads/writes that state and does the
// one piece of math the loop must not fudge: turning per-criterion scores into a
// single weighted total, so "did the rubric improve?" is decided by code.

const fs = require("fs");
const path = require("path");

const DIR = path.join(".fey", "improve");

function optDir(repoRoot) { return path.join(repoRoot, DIR); }
function filePath(repoRoot, name) { return path.join(optDir(repoRoot), name); }
function exists(repoRoot) { return fs.existsSync(filePath(repoRoot, "run.json")); }

function ensureDir(repoRoot) { fs.mkdirSync(optDir(repoRoot), { recursive: true }); }

function readJson(repoRoot, name, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath(repoRoot, name), "utf8")); }
  catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw new Error(`invalid .fey/improve/${name}: ${error.message}`);
  }
}
function writeJson(repoRoot, name, data) {
  ensureDir(repoRoot);
  fs.writeFileSync(filePath(repoRoot, name), JSON.stringify(data, null, 2) + "\n");
}

function loadRun(repoRoot) { return readJson(repoRoot, "run.json", null); }
function saveRun(repoRoot, run) { writeJson(repoRoot, "run.json", run); }
function loadDirections(repoRoot) { return readJson(repoRoot, "directions.json", []); }
function loadRubric(repoRoot) { return readJson(repoRoot, "rubric.json", null); }
function loadHistory(repoRoot) { return readJson(repoRoot, "history.json", []); }
function saveHistory(repoRoot, history) { writeJson(repoRoot, "history.json", history); }

// Normalize a scores object into { [criterionId]: { score, note } }. Accepts
// either a bare number or an { score, note } object per criterion, so the skill
// can write whichever is convenient.
function normalizeScores(scores) {
  const out = {};
  for (const [k, v] of Object.entries(scores || {})) {
    if (v && typeof v === "object") out[k] = { score: Number(v.score), note: v.note || "" };
    else out[k] = { score: Number(v), note: "" };
  }
  return out;
}

// The one calculation that must be deterministic: a single 0..100 score from the
// rubric weights and this iteration's per-criterion scores. Each criterion is
// normalized to its own max, weighted, and averaged. Missing/NaN scores are
// skipped (they do not silently count as zero). Returns { total, perCriterion }.
function scoreIteration(rubric, rawScores) {
  const criteria = (rubric && rubric.criteria) || [];
  const scores = normalizeScores(rawScores);
  const perCriterion = {};
  let num = 0, den = 0;
  for (const c of criteria) {
    const w = Number(c.weight) || 0;
    const max = Number(c.max) > 0 ? Number(c.max) : 10;
    const s = scores[c.id] ? scores[c.id].score : NaN;
    if (!Number.isFinite(s)) { perCriterion[c.id] = { score: null, norm: null, note: scores[c.id] ? scores[c.id].note : "" }; continue; }
    const clamped = Math.max(0, Math.min(s, max));
    const norm = clamped / max; // 0..1
    perCriterion[c.id] = { score: clamped, norm: Math.round(norm * 1000) / 10, note: scores[c.id].note };
    num += norm * w;
    den += w;
  }
  const total = den === 0 ? 0 : Math.round((num / den) * 1000) / 10; // 0..100, 1dp
  return { total, perCriterion };
}

// The best total among *kept* iterations (baseline counts). This is the bar a
// new step must beat to be an improvement — the current top of the hill.
function bestKept(history) {
  const kept = history.filter((h) => h.kept === true);
  if (!kept.length) return null;
  return kept.reduce((a, b) => (b.total > a.total ? b : a));
}

// Append an evaluated iteration to history. `kept` (whether the step is accepted)
// is decided later by the commit gate; a fresh entry starts pending (kept:null).
function recordIteration(repoRoot, { label, summary, scores, baseline, evaluation }) {
  const rubric = loadRubric(repoRoot);
  if (!rubric) throw new Error("no .fey/improve/rubric.json — author the rubric first");
  const history = loadHistory(repoRoot);
  const { total, perCriterion } = scoreIteration(rubric, scores);
  const prevBest = bestKept(history);
  const pending = !baseline ? history.find((h) => !h.baseline && h.kept === null) : null;
  const n = baseline ? 0 : (pending ? pending.n : (history.length ? Math.max(...history.map((h) => h.n)) + 1 : 0));
  const iter = {
    n,
    label: label || (baseline ? "baseline" : `iteration ${n}`),
    summary: summary || "",
    timestamp: new Date().toISOString(),
    scores: normalizeScores(scores),
    perCriterion,
    total,
    baseline: !!baseline,
    prevBest: prevBest ? prevBest.total : null,
    delta: prevBest ? Math.round((total - prevBest.total) * 10) / 10 : null,
    improved: baseline ? true : (prevBest ? total > prevBest.total : true),
    kept: baseline ? true : null, // decided by the commit gate
    committed: false,
    commitSha: null,
    evaluation: evaluation || null,
  };
  // baseline is always index 0 and replaces any existing baseline
  if (baseline) {
    const rest = history.filter((h) => !h.baseline);
    saveHistory(repoRoot, [iter, ...rest]);
  } else {
    const next = pending ? history.filter((h) => h !== pending) : history;
    next.push(iter);
    next.sort((a, b) => a.n - b.n);
    saveHistory(repoRoot, next);
  }
  const run = loadRun(repoRoot) || {};
  const best = bestKept(loadHistory(repoRoot));
  run.bestTotal = best ? best.total : total;
  run.bestIteration = best ? best.n : n;
  run.latestIteration = n;
  run.updatedAt = new Date().toISOString();
  saveRun(repoRoot, run);
  return iter;
}

// Mark the most recent iteration kept/committed (called by the commit gate once
// the improvement is confirmed and committed).
function markKept(repoRoot, n, { kept, commitSha }) {
  const history = loadHistory(repoRoot);
  const iter = history.find((h) => h.n === n);
  if (!iter) throw new Error(`iteration ${n} not found`);
  iter.kept = kept;
  iter.committed = !!commitSha;
  iter.commitSha = commitSha || null;
  saveHistory(repoRoot, history);
  const run = loadRun(repoRoot) || {};
  const best = bestKept(history);
  run.bestTotal = best ? best.total : null;
  run.bestIteration = best ? best.n : null;
  run.updatedAt = new Date().toISOString();
  saveRun(repoRoot, run);
  return iter;
}

// Read the parallel-agent proposals dropped into scratch/iter-<n>/ for display.
function loadScratch(repoRoot, n) {
  const dir = path.join(optDir(repoRoot), "scratch", `iter-${n}`);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch { /* skip bad file */ }
  }
  return out;
}

module.exports = {
  DIR, optDir, exists, ensureDir, readJson, writeJson,
  loadRun, saveRun, loadDirections, loadRubric, loadHistory, saveHistory,
  normalizeScores, scoreIteration, bestKept, recordIteration, markKept, loadScratch,
};
