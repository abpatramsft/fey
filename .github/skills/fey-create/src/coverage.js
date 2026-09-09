"use strict";
// Coverage = the single source of truth for "how much of the code the wiki
// explains". A source line is *anchored* if it falls inside a span that some wiki
// block cites. Both the server (Overview stats + per-file bars) and the CLI
// coverage/gate commands compute coverage here, so the numbers can never disagree.
const fs = require("fs");
const path = require("path");
const { listFiles } = require("./indexer");

function fileLineCount(abs) {
  if (!fs.existsSync(abs)) return 0;
  return fs.readFileSync(abs, "utf8").split(/\r?\n/).length;
}

function repoFileLines(repoRoot, relFile) {
  if (typeof relFile !== "string" || !relFile.trim() || path.isAbsolute(relFile)) return null;
  const file = relFile.trim().replace(/\\/g, "/");
  const abs = path.resolve(repoRoot, ...file.split("/"));
  const relative = path.relative(repoRoot, abs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const realRoot = fs.realpathSync(repoRoot);
    const realFile = fs.realpathSync(abs);
    const realRelative = path.relative(realRoot, realFile);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
    if (!fs.statSync(realFile).isFile()) return null;
    return { file, abs: realFile, lines: fs.readFileSync(realFile, "utf8").split(/\r?\n/) };
  } catch {
    return null;
  }
}

// Resolve and validate a span against the current repository. Named spans are
// rechecked so a corrupted/stale manifest cannot escape the repo; synthesized
// line ranges must point at an existing file and stay inside its current bounds.
function makeSpan(repoRoot, manifest, spanId) {
  if (!repoRoot || !manifest || typeof spanId !== "string") return null;
  const catalog = manifest.spans && typeof manifest.spans === "object" ? manifest.spans : {};
  const stored = catalog[spanId];
  if (stored) {
    const source = repoFileLines(repoRoot, stored.file);
    const startLine = Number(stored.startLine);
    const endLine = Number(stored.endLine);
    if (!source || !Number.isInteger(startLine) || !Number.isInteger(endLine) ||
        startLine < 1 || endLine < startLine || endLine > source.lines.length) return null;
    return { ...stored, file: source.file, startLine, endLine };
  }
  const m = /^(.+)#L([1-9]\d*)-([1-9]\d*)$/.exec(spanId);
  if (m) {
    const startLine = Number(m[2]), endLine = Number(m[3]);
    const source = repoFileLines(repoRoot, m[1]);
    if (!source || endLine < startLine || endLine > source.lines.length) return null;
    return { id: spanId, file: source.file, symbol: `lines ${startLine}\u2013${endLine}`, kind: "range", startLine, endLine, hash: "" };
  }
  return null;
}

// Which lines of each file are anchored by some wiki block (deduped).
function anchoredRangesByFile(repoRoot, manifest) {
  const byFile = {};
  const seen = new Set();
  for (const page of manifest.pages || []) {
    for (const block of page.blocks || []) {
      for (const spanId of block.anchors || []) {
        if (seen.has(spanId)) continue;
        seen.add(spanId);
        const span = makeSpan(repoRoot, manifest, spanId);
        if (!span) continue;
        (byFile[span.file] = byFile[span.file] || []).push([span.startLine, span.endLine]);
      }
    }
  }
  return byFile;
}

function coveredLineCount(ranges) {
  const marked = new Set();
  for (const [a, b] of ranges) for (let n = a; n <= b; n++) marked.add(n);
  return marked.size;
}

// Full coverage report for a repo + manifest.
//   { totalPct, totalLines, anchoredLines, filesIndexed,
//     perFile: { rel: { total, anchored, pct } }, files: [rel] }
function computeCoverage(repoRoot, manifest) {
  const files = listFiles(repoRoot);
  const ranges = anchoredRangesByFile(repoRoot, manifest);
  const invalidAnchors = [];
  for (const page of manifest.pages || []) {
    for (const block of page.blocks || []) {
      for (const spanId of block.anchors || []) {
        if (!makeSpan(repoRoot, manifest, spanId)) {
          invalidAnchors.push({ pageId: page.id || "", blockId: block.id || "", spanId });
        }
      }
    }
  }
  const perFile = {};
  let totalLines = 0, anchoredLines = 0;
  for (const rel of files) {
    const total = fileLineCount(path.join(repoRoot, rel));
    const anchored = coveredLineCount(ranges[rel] || []);
    perFile[rel] = { total, anchored, pct: total ? Math.round((anchored / total) * 100) : 0 };
    totalLines += total;
    anchoredLines += anchored;
  }
  return {
    files,
    filesIndexed: files.length,
    totalLines,
    anchoredLines,
    totalPct: totalLines ? Math.round((anchoredLines / totalLines) * 100) : 0,
    perFile,
    invalidAnchors,
  };
}

module.exports = { fileLineCount, makeSpan, computeCoverage, repoFileLines };
