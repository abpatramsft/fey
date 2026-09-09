"use strict";
// Manifest = structured source of truth (spans snapshot, page/block structure,
// anchors, provenance, lock state). Prose lives in .fey/create/pages/*.md for human
// readability; blocks are keyed by "<!-- olo:<blockId> -->" markers.
const fs = require("fs");
const path = require("path");

// fey keeps its bundle under <repo>/.fey, split by phase:
//   .fey/create   — the wiki/diagrams phase (this skill)
//   .fey/improve  — the auto-improve phase (fey-improve skill)
function feyDir(repoRoot) {
  return path.join(repoRoot, ".fey");
}
function createDir(repoRoot) {
  return path.join(repoRoot, ".fey", "create");
}
function improveDir(repoRoot) {
  return path.join(repoRoot, ".fey", "improve");
}
function manifestPath(repoRoot) {
  return path.join(createDir(repoRoot), "manifest.json");
}
function pagePath(repoRoot, mdFile) {
  return path.join(createDir(repoRoot), mdFile);
}

function loadManifest(repoRoot) {
  const p = manifestPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveManifest(repoRoot, manifest) {
  fs.mkdirSync(createDir(repoRoot), { recursive: true });
  fs.writeFileSync(manifestPath(repoRoot), JSON.stringify(manifest, null, 2) + "\n");
}

// Parse a page's markdown into { intro, blocks: { id -> prose } } using markers.
function parsePage(md) {
  const marker = /<!--\s*olo:([A-Za-z0-9_-]+)\s*-->/g;
  const result = { intro: "", blocks: {} };
  let match;
  const hits = [];
  while ((match = marker.exec(md)) !== null) {
    hits.push({ id: match[1], start: match.index, contentStart: marker.lastIndex });
  }
  if (hits.length === 0) {
    result.intro = md.trim();
    return result;
  }
  result.intro = md.slice(0, hits[0].start).trim();
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : md.length;
    result.blocks[hit.id] = md.slice(hit.contentStart, end).trim();
  });
  return result;
}

function loadPage(repoRoot, mdFile) {
  return parsePage(fs.readFileSync(pagePath(repoRoot, mdFile), "utf8"));
}

// Rewrite a single block's prose in the markdown file, preserving everything else.
function writeBlockProse(repoRoot, mdFile, blockId, prose) {
  const p = pagePath(repoRoot, mdFile);
  const md = fs.readFileSync(p, "utf8");
  const marker = new RegExp(`(<!--\\s*olo:${blockId}\\s*-->)([\\s\\S]*?)(?=<!--\\s*olo:|$)`);
  if (!marker.test(md)) throw new Error(`block ${blockId} not found in ${mdFile}`);
  const next = md.replace(marker, `$1\n${prose.trim()}\n\n`);
  fs.writeFileSync(p, next);
}

module.exports = {
  feyDir,
  createDir,
  improveDir,
  loadManifest,
  saveManifest,
  loadPage,
  parsePage,
  writeBlockProse,
};
