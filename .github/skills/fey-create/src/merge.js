"use strict";
// Deterministic map-reduce MERGE for parallel authoring (approach A).
//
// In the fan-out flow, the repo is partitioned into disjoint units and one
// subagent authors each unit in its own context. To keep the merge out of any
// LLM's context (and impossible to hallucinate), each subagent writes its work to
// a scratchpad instead of returning prose:
//
//   .fey/create/scratch/<unitId>/
//     unit.json    { "pageId", "title", "section"?, "files"?: [...] }
//     page.md      prose with <!-- olo:<blockId> --> markers
//     blocks.json  [ { "id", "anchors": [spanId...], "origin"?, "locked"?, "anchorPinned"? } ]
//
// `fey merge` assembles every unit into .fey/create/pages/*.md + manifest.pages WITHOUT an
// LLM: it validates each anchor against the span catalog produced by `fey index`,
// enforces block/page id uniqueness and marker<->block parity, respects existing
// locks, and writes only when the WHOLE set is valid — so one bad unit never
// corrupts the wiki. This mirrors `fey index`: fail loudly, leave the manifest
// untouched on any error.
const fs = require("fs");
const path = require("path");
const M = require("./manifest");
const { makeSpan, fileLineCount } = require("./coverage");

function scratchDir(repoRoot) {
  return path.join(repoRoot, ".fey", "create", "scratch");
}

// Directory names under .fey/create/scratch/, sorted for a deterministic merge order.
function listUnitIds(repoRoot) {
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

// Load + shallow-validate one scratch unit. Returns { meta, blocks, md } or { errors }.
function readUnit(repoRoot, unitId) {
  const dir = path.join(scratchDir(repoRoot), unitId);
  const file = (f) => path.join(dir, f);
  const missing = ["unit.json", "page.md", "blocks.json"].filter((f) => !fs.existsSync(file(f)));
  if (missing.length) return { errors: [`${unitId}: missing ${missing.join(", ")}`] };

  let meta, blocks;
  try {
    meta = readJson(file("unit.json"));
  } catch (e) {
    return { errors: [`${unitId}/unit.json: invalid JSON (${e.message})`] };
  }
  try {
    blocks = readJson(file("blocks.json"));
  } catch (e) {
    return { errors: [`${unitId}/blocks.json: invalid JSON (${e.message})`] };
  }
  const md = fs.readFileSync(file("page.md"), "utf8");

  const errors = [];
  if (!meta || typeof meta.pageId !== "string" || !meta.pageId.trim())
    errors.push(`${unitId}/unit.json: needs a non-empty string "pageId"`);
  if (!meta || typeof meta.title !== "string" || !meta.title.trim())
    errors.push(`${unitId}/unit.json: needs a non-empty string "title"`);
  if (!Array.isArray(blocks)) errors.push(`${unitId}/blocks.json: must be a JSON array`);
  if (errors.length) return { errors };
  return { meta, blocks, md };
}

// Validate that a span id resolves against the catalog (named span) or a valid
// line-range span (path#L<a>-<b> within the file). Returns null if OK, else a reason.
function anchorProblem(repoRoot, manifest, anchor) {
  if (typeof anchor !== "string" || !anchor) return "anchor must be a non-empty string";
  const span = makeSpan(manifest, anchor);
  if (!span) return `anchor "${anchor}" is not in the span catalog and is not a valid line-range (path#L10-25)`;
  // Named catalog spans are already validated at index time; only re-check the
  // synthesized line-range form against the current file.
  if (span.kind === "range") {
    const lines = fileLineCount(path.join(repoRoot, span.file));
    if (lines === 0) return `anchor "${anchor}" points at a missing file`;
    if (span.startLine < 1 || span.endLine > lines)
      return `anchor "${anchor}" is out of range (file has ${lines} lines)`;
  }
  return null;
}

// Build the merged pages + page files in memory. Nothing is written here; the
// caller writes only when errors.length === 0. Returns:
//   { errors, warnings, pageEntries: [manifestPage], pageFiles: {rel: md}, stats }
function buildMerge(repoRoot, manifest) {
  const errors = [];
  const warnings = [];
  const unitIds = listUnitIds(repoRoot);
  if (unitIds.length === 0) {
    return { errors: ["no units found under .fey/create/scratch/ — nothing to merge"], warnings, pageEntries: [], pageFiles: {}, stats: {} };
  }

  // Existing locks: a page whose current manifest copy contains any locked block
  // is protected — we skip re-merging it so human-locked prose is never clobbered.
  const lockedPageIds = new Set(
    (manifest.pages || [])
      .filter((p) => (p.blocks || []).some((b) => b.locked))
      .map((p) => p.id)
  );

  const seenBlockIds = new Map(); // blockId -> unitId (first writer)
  const seenPageIds = new Map();  // pageId  -> unitId
  const pageEntries = [];
  const pageFiles = {};
  let mergedUnits = 0;
  let totalBlocks = 0;

  for (const unitId of unitIds) {
    const u = readUnit(repoRoot, unitId);
    if (u.errors) {
      errors.push(...u.errors);
      continue;
    }
    const { meta, blocks, md } = u;

    if (lockedPageIds.has(meta.pageId)) {
      warnings.push(`${unitId}: page "${meta.pageId}" has locked blocks in the current wiki — skipped (edit/unlock it manually)`);
      continue;
    }
    if (seenPageIds.has(meta.pageId)) {
      errors.push(`duplicate pageId "${meta.pageId}" in units ${seenPageIds.get(meta.pageId)} and ${unitId}`);
      continue;
    }
    seenPageIds.set(meta.pageId, unitId);

    // marker <-> block parity
    const markerIds = new Set(Object.keys(M.parsePage(md).blocks));
    const blockIds = blocks.map((b) => b && b.id);
    const entryBlocks = [];
    let unitOk = true;

    for (const b of blocks) {
      if (!b || typeof b.id !== "string" || !b.id) {
        errors.push(`${unitId}/blocks.json: every block needs a string "id"`);
        unitOk = false;
        continue;
      }
      if (seenBlockIds.has(b.id)) {
        errors.push(`duplicate block id "${b.id}" in units ${seenBlockIds.get(b.id)} and ${unitId}`);
        unitOk = false;
        continue;
      }
      seenBlockIds.set(b.id, unitId);
      if (!markerIds.has(b.id)) {
        errors.push(`${unitId}: block "${b.id}" has no <!-- olo:${b.id} --> marker in page.md`);
        unitOk = false;
      }
      if (!Array.isArray(b.anchors) || b.anchors.length === 0) {
        errors.push(`${unitId}: block "${b.id}" must have at least one anchor`);
        unitOk = false;
      } else {
        for (const a of b.anchors) {
          const problem = anchorProblem(repoRoot, manifest, a);
          if (problem) {
            errors.push(`${unitId}, block "${b.id}": ${problem}`);
            unitOk = false;
          }
        }
      }
      entryBlocks.push({
        id: b.id,
        anchors: b.anchors,
        origin: b.origin || "generated",
        locked: !!b.locked,
        anchorPinned: !!b.anchorPinned,
      });
    }

    // markers with no matching block
    for (const mId of markerIds) {
      if (!blockIds.includes(mId)) {
        errors.push(`${unitId}: page.md has a marker "olo:${mId}" with no matching block in blocks.json`);
        unitOk = false;
      }
    }

    if (!unitOk) continue;

    const rel = `pages/${meta.pageId}.md`;
    pageFiles[rel] = md;
    pageEntries.push({
      id: meta.pageId,
      title: meta.title,
      section: meta.section || "Wiki",
      md: rel,
      blocks: entryBlocks,
    });
    mergedUnits++;
    totalBlocks += entryBlocks.length;
  }

  return {
    errors,
    warnings,
    pageEntries,
    pageFiles,
    stats: { units: unitIds.length, mergedUnits, totalBlocks },
  };
}

// Perform the merge. Returns { ok, report }. Writes nothing on failure.
function merge(repoRoot, opts = {}) {
  const manifest = M.loadManifest(repoRoot);
  if (!manifest) {
    return { ok: false, report: "fey merge: no .fey/create/manifest.json — run `fey index` first." };
  }

  const { errors, warnings, pageEntries, pageFiles, stats } = buildMerge(repoRoot, manifest);

  if (errors.length) {
    const lines = [];
    lines.push(`fey merge: FAILED — ${errors.length} problem(s); manifest left unchanged.`);
    for (const e of errors.slice(0, 40)) lines.push(`  - ${e}`);
    if (errors.length > 40) lines.push(`  … and ${errors.length - 40} more`);
    lines.push("");
    lines.push("Fix the offending .fey/create/scratch/<unit>/ files and re-run `fey merge`.");
    return { ok: false, report: lines.join("\n") };
  }

  // Splice merged pages into the manifest: replace by id, keep untouched pages.
  const byId = new Map((manifest.pages || []).map((p) => [p.id, p]));
  for (const page of pageEntries) byId.set(page.id, page);
  manifest.pages = [...byId.values()];

  // Write page markdown, then the manifest (only after the whole set validated).
  const pagesDir = path.join(M.createDir(repoRoot), "pages");
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const [rel, md] of Object.entries(pageFiles)) {
    fs.writeFileSync(path.join(M.createDir(repoRoot), rel), md);
  }
  M.saveManifest(repoRoot, manifest);

  if (opts.clean) fs.rmSync(scratchDir(repoRoot), { recursive: true, force: true });

  const lines = [];
  lines.push(
    `fey merge: merged ${stats.mergedUnits}/${stats.units} unit(s) -> ${stats.totalBlocks} block(s) across ${pageEntries.length} page(s).`
  );
  for (const w of warnings) lines.push(`  warning: ${w}`);
  lines.push(opts.clean ? "Cleaned .fey/create/scratch/." : "Left .fey/create/scratch/ in place (kept for traceability; pass --clean to remove).");
  lines.push("Next: `fey coverage` to check depth, then `fey serve` to view.");
  return { ok: true, report: lines.join("\n") };
}

module.exports = { merge, buildMerge, listUnitIds };
