"use strict";
// Deterministic BUILD (reduce) for anchored flow diagrams.
//
// Mirrors the wiki's parallel-authoring merge: in the fan-out flow, one subagent
// authors one entry-point flow in its own context and writes it to a scratch slot
//
//   .fey/create/diagrams/scratch/<id>/diagram.json   (conforms to references/diagram.schema.json)
//
// `fey diagrams build` assembles every scratch diagram into
//
//   .fey/create/diagrams/<id>.json     one validated flow per entry point
//   .fey/create/diagrams/index.json    the browsable list the Diagrams tab reads
//
// WITHOUT an LLM in the loop: it validates each diagram's shape (unique node ids,
// a single root, parent links forming a tree with no cycles, lane references) and
// — the fey golden rule — that every anchor resolves against the span catalog
// produced by `fey index`. It writes only when the WHOLE set is valid, so one bad
// diagram never corrupts the bundle. Fail loudly, leave existing files untouched.
const fs = require("fs");
const path = require("path");
const M = require("./manifest");
const { makeSpan } = require("./coverage");

function diagramsDir(repoRoot) {
  return path.join(repoRoot, ".fey", "create", "diagrams");
}
function scratchDir(repoRoot) {
  return path.join(diagramsDir(repoRoot), "scratch");
}

// Scratch slot names (kebab ids), sorted for a deterministic build order.
function listScratchIds(repoRoot) {
  const dir = scratchDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const KINDS = ["http-route", "cli", "main", "handler", "export", "job", "test", "other"];

// Validate one node group (the main `nodes` array or a branch's `nodes`) against
// the lane set and the span catalog. `label` is used only for error messages.
// Returns a list of error strings (empty = valid).
function validateNodeGroup(diagram, nodes, laneIds, manifest, label) {
  const errs = [];
  if (!Array.isArray(nodes) || !nodes.length) {
    errs.push(`${label}: nodes must be a non-empty array`);
    return errs;
  }
  const ids = new Set();
  const orders = new Set();
  let roots = 0;
  for (const n of nodes) {
    if (!n || typeof n !== "object") { errs.push(`${label}: a node is not an object`); continue; }
    const nid = n.id;
    if (!nid || typeof nid !== "string") { errs.push(`${label}: a node is missing a string id`); continue; }
    if (ids.has(nid)) errs.push(`${label}: duplicate node id "${nid}"`);
    ids.add(nid);
    if (!n.name || typeof n.name !== "string") errs.push(`${label}: node "${nid}" missing name`);
    if (!n.lane || !laneIds.has(n.lane)) errs.push(`${label}: node "${nid}" lane "${n.lane}" not declared in lanes`);
    if (!Number.isInteger(n.order)) errs.push(`${label}: node "${nid}" order must be an integer`);
    else { if (orders.has(n.order)) errs.push(`${label}: duplicate order ${n.order} (node "${nid}")`); orders.add(n.order); }
    if (n.parent == null) roots++;
    const resolved = n.resolved !== false; // defaults to true
    if (resolved) {
      if (!n.anchor || typeof n.anchor !== "string") {
        errs.push(`${label}: node "${nid}" is resolved but has no anchor (set resolved:false or add an anchor)`);
      } else if (!makeSpan(manifest, n.anchor)) {
        errs.push(`${label}: node "${nid}" anchor "${n.anchor}" does not resolve against manifest.spans (or a valid <file>#L<start>-<end>)`);
      }
    } else if (n.anchor) {
      errs.push(`${label}: node "${nid}" is resolved:false and must not carry an anchor`);
    }
  }
  if (roots !== 1) errs.push(`${label}: expected exactly one root (parent:null), found ${roots}`);
  // Parent links: every parent exists; links form a tree reachable from the root (no cycles).
  const byId = new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]));
  for (const n of nodes) {
    if (!n || !n.id) continue;
    if (n.parent != null && !byId.has(n.parent)) errs.push(`${label}: node "${n.id}" parent "${n.parent}" is not a node in this diagram`);
  }
  if (!errs.length) {
    // walk up from each node to a root; a missing/looping chain is a cycle or orphan.
    for (const n of nodes) {
      let cur = n, steps = 0;
      const seen = new Set();
      while (cur && cur.parent != null) {
        if (seen.has(cur.id)) { errs.push(`${label}: cycle detected at node "${n.id}"`); break; }
        seen.add(cur.id);
        cur = byId.get(cur.parent);
        if (++steps > nodes.length) { errs.push(`${label}: parent chain for "${n.id}" never reaches a root`); break; }
      }
    }
  }
  return errs;
}

// Full validation of one diagram object. Returns { errors, meta } — meta is the
// index entry when valid.
function validateDiagram(diagram, manifest, idFromDir) {
  const errs = [];
  if (!diagram || typeof diagram !== "object") return { errors: [`${idFromDir}: diagram.json is not an object`] };
  const id = diagram.id;
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) errs.push(`${idFromDir}: id "${id}" must be kebab-case (^[a-z0-9][a-z0-9-]*$)`);
  if (idFromDir && id && id !== idFromDir) errs.push(`${idFromDir}: id "${id}" must match its scratch folder name`);
  for (const f of ["entry", "title", "kind"]) if (!diagram[f] || typeof diagram[f] !== "string") errs.push(`${id || idFromDir}: missing "${f}"`);
  if (diagram.kind && !KINDS.includes(diagram.kind)) errs.push(`${id || idFromDir}: kind "${diagram.kind}" is not one of ${KINDS.join("|")}`);
  const lanes = diagram.lanes;
  if (!Array.isArray(lanes) || !lanes.length) errs.push(`${id || idFromDir}: lanes must be a non-empty array`);
  const laneIds = new Set();
  for (const l of lanes || []) {
    if (!l || !l.id || !l.label) { errs.push(`${id || idFromDir}: every lane needs id + label`); continue; }
    if (laneIds.has(l.id)) errs.push(`${id || idFromDir}: duplicate lane id "${l.id}"`);
    laneIds.add(l.id);
  }
  errs.push(...validateNodeGroup(diagram, diagram.nodes, laneIds, manifest, `${id || idFromDir}`));
  if (diagram.branches != null) {
    if (!Array.isArray(diagram.branches)) errs.push(`${id || idFromDir}: branches must be an array`);
    else diagram.branches.forEach((br, i) => {
      if (!br || !br.label || !Array.isArray(br.nodes)) { errs.push(`${id || idFromDir}: branch ${i} needs a label + nodes`); return; }
      errs.push(...validateNodeGroup(diagram, br.nodes, laneIds, manifest, `${id || idFromDir} · branch "${br.label}"`));
    });
  }
  const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
  const unresolved = nodes.filter((n) => n && n.resolved === false).length;
  const meta = errs.length ? null : {
    id,
    entry: diagram.entry,
    title: diagram.title,
    kind: diagram.kind,
    language: diagram.language || "",
    summary: diagram.summary || "",
    lanes: (lanes || []).length,
    nodes: nodes.length,
    unresolved,
    branches: Array.isArray(diagram.branches) ? diagram.branches.length : 0,
  };
  return { errors: errs, meta };
}

// Build: validate every scratch diagram, then write the whole set atomically-ish
// (only if all valid). Returns { ok, written, errors, index }.
function buildDiagrams(repoRoot, opts = {}) {
  const manifest = M.loadManifest(repoRoot);
  if (!manifest) return { ok: false, errors: ["no .fey/create/manifest.json — run `fey index` first"] };
  const ids = listScratchIds(repoRoot);
  if (!ids.length) return { ok: false, errors: [`no diagrams in ${path.relative(repoRoot, scratchDir(repoRoot))}/ — author .fey/create/diagrams/scratch/<id>/diagram.json first`] };

  const errors = [];
  const built = []; // { meta, diagram }
  const seenIds = new Set();
  for (const dirId of ids) {
    const file = path.join(scratchDir(repoRoot), dirId, "diagram.json");
    if (!fs.existsSync(file)) { errors.push(`${dirId}: missing diagram.json`); continue; }
    let diagram;
    try { diagram = readJson(file); } catch (e) { errors.push(`${dirId}: invalid JSON — ${e.message}`); continue; }
    const { errors: errs, meta } = validateDiagram(diagram, manifest, dirId);
    if (errs.length) { errors.push(...errs); continue; }
    if (seenIds.has(meta.id)) { errors.push(`duplicate diagram id "${meta.id}"`); continue; }
    seenIds.add(meta.id);
    built.push({ meta, diagram });
  }
  if (errors.length) return { ok: false, errors };

  // Write only after the whole set validated.
  const dir = diagramsDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  // Remove stale per-diagram files that are no longer in the scratch set.
  for (const f of fs.readdirSync(dir)) {
    if (f === "scratch" || f === "index.json") continue;
    if (f.endsWith(".json") && !seenIds.has(f.replace(/\.json$/, ""))) fs.rmSync(path.join(dir, f));
  }
  built.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  for (const { meta, diagram } of built) {
    fs.writeFileSync(path.join(dir, `${meta.id}.json`), JSON.stringify(diagram, null, 2) + "\n");
  }
  const index = { version: 1, diagrams: built.map((b) => b.meta) };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");

  if (opts.clean) fs.rmSync(scratchDir(repoRoot), { recursive: true, force: true });
  return { ok: true, written: built.map((b) => b.meta.id), errors: [], index };
}

// --- read helpers for the server (read-only) ---
function loadIndex(repoRoot) {
  try { return readJson(path.join(diagramsDir(repoRoot), "index.json")); }
  catch { return null; }
}
function loadDiagram(repoRoot, id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id || "")) return null;
  try { return readJson(path.join(diagramsDir(repoRoot), `${id}.json`)); }
  catch { return null; }
}

module.exports = { buildDiagrams, validateDiagram, loadIndex, loadDiagram, diagramsDir, scratchDir, KINDS };
