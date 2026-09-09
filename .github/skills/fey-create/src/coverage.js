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

// Resolve a span id to a span. Falls back to a synthesized line-range span for
// ids of the form "path/to/file.ext#L10-25", so any file in any language can be
// cited even when no symbol was auto-extracted.
function makeSpan(manifest, spanId) {
  const s = manifest.spans[spanId];
  if (s) return s;
  const m = /^(.+)#L(\d+)-(\d+)$/.exec(spanId);
  if (m) {
    const startLine = +m[2], endLine = Math.max(+m[3], +m[2]);
    return { id: spanId, file: m[1], symbol: `lines ${startLine}\u2013${endLine}`, kind: "range", startLine, endLine, hash: "" };
  }
  return null;
}

// Which lines of each file are anchored by some wiki block (deduped).
function anchoredRangesByFile(manifest) {
  const byFile = {};
  const seen = new Set();
  for (const page of manifest.pages) {
    for (const block of page.blocks) {
      for (const spanId of block.anchors) {
        if (seen.has(spanId)) continue;
        seen.add(spanId);
        const span = makeSpan(manifest, spanId);
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
  const ranges = anchoredRangesByFile(manifest);
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
  };
}

module.exports = { fileLineCount, makeSpan, computeCoverage };
