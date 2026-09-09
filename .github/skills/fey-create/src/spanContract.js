"use strict";
// The span contract — the frozen boundary between *extraction* (a built-in or a
// repo-generated indexer) and everything downstream (manifest, server, viewer).
//
// A generated indexer only has to emit MINIMAL raw spans:
//     { file, symbol, kind?, startLine, endLine }
// fey derives `id` (= "<file>#<symbol>") and `hash` itself and validates every
// span against the real file, so a hand- or agent-written indexer can never
// corrupt the bundle: bad spans are rejected with actionable errors.
const fs = require("fs");
const path = require("path");
const { contentHash } = require("./indexer");

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// Read a file's lines once, memoized per index run.
function fileCache(repoRoot) {
  const cache = new Map();
  return (relFile) => {
    if (cache.has(relFile)) return cache.get(relFile);
    const abs = path.resolve(repoRoot, relFile);
    let lines = null;
    // guard against path escapes (../../etc)
    const within = toPosix(path.relative(repoRoot, abs));
    if (!within.startsWith("..") && !path.isAbsolute(within) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    }
    cache.set(relFile, lines);
    return lines;
  };
}

// Normalize + validate a raw span list into the canonical keyed spans map.
// Returns { spans, errors, warnings }. `errors` being non-empty means the
// extraction is rejected (the caller should fail the index and let the indexer
// be fixed). `warnings` are non-fatal (e.g. duplicate ids collapsed).
function normalizeSpans(raw, repoRoot) {
  const errors = [];
  const warnings = [];
  const spans = {};
  const getLines = fileCache(repoRoot);

  if (!Array.isArray(raw)) {
    return { spans, errors: ["indexer output: expected `spans` to be an array"], warnings };
  }

  raw.forEach((s, i) => {
    const where = `span[${i}]`;
    if (!s || typeof s !== "object") return errors.push(`${where}: not an object`);

    const file = typeof s.file === "string" ? toPosix(s.file.trim()) : null;
    const symbol = typeof s.symbol === "string" ? s.symbol.trim() : null;
    const kind = typeof s.kind === "string" && s.kind.trim() ? s.kind.trim() : "symbol";
    const startLine = Number(s.startLine);
    const endLine = Number(s.endLine);

    if (!file) return errors.push(`${where}: missing/invalid "file"`);
    if (!symbol) return errors.push(`${where} (${file}): missing/invalid "symbol"`);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine))
      return errors.push(`${where} (${file}#${symbol}): startLine/endLine must be integers`);

    const lines = getLines(file);
    if (lines === null) return errors.push(`${where}: file not found in repo: ${file}`);
    const lineCount = lines.length;
    if (startLine < 1 || endLine < startLine || endLine > lineCount)
      return errors.push(
        `${where} (${file}#${symbol}): line range ${startLine}-${endLine} out of bounds (file has ${lineCount} lines)`
      );

    const id = `${file}#${symbol}`;
    if (spans[id]) {
      warnings.push(`duplicate span id "${id}" — keeping the first occurrence`);
      return;
    }
    const hash = contentHash(lines.slice(startLine - 1, endLine).join("\n"));
    spans[id] = { id, file, symbol, kind, startLine, endLine, hash };
  });

  return { spans, errors, warnings };
}

module.exports = { normalizeSpans };
