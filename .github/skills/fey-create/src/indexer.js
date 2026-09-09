"use strict";
// Language-agnostic indexer. Walks a repo and extracts "citable spans"
// (functions, classes, methods, …) with stable symbol-path ids, current line
// ranges, and a content hash for staleness detection.
//
// Extraction quality is best-effort and per-language:
//   • TypeScript / JavaScript  — TypeScript compiler API (exact)
//   • Python                   — indentation-aware scanner (def / class / methods)
//   • Brace languages          — a generic brace scanner (Go, Rust, Java, C#,
//                                C/C++, Kotlin, Swift, Scala, PHP, …)
//   • anything else            — no auto spans, but the file is still listed and
//                                can be cited with a line-range anchor (file#L10-25)
//
// The server never re-parses source: it only consumes {file, symbol, startLine,
// endLine, hash}. So adding a language means adding an extractor here — nothing
// else in fey is language-specific.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _ts = null;
function getTs() {
  if (!_ts) _ts = require("typescript");
  return _ts;
}

function contentHash(text) {
  return crypto
    .createHash("sha256")
    .update(text.replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// file discovery
// ---------------------------------------------------------------------------
const SOURCE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyi",
  "go", "rs",
  "java", "kt", "kts", "scala",
  "cs",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
  "swift", "php",
]);
const IGNORE_DIRS = new Set([
  "node_modules", ".fey", "__pycache__", "venv", "env", "dist", "build",
  "target", "vendor", "site-packages", ".gradle", "coverage", "bin", "obj",
]);
function ignoredDir(name) {
  return name.startsWith(".") || IGNORE_DIRS.has(name) || name.endsWith(".egg-info");
}
function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDir(entry.name)) walk(path.join(dir, entry.name), out);
    } else {
      const ext = extOf(entry.name);
      if (SOURCE_EXT.has(ext) && !entry.name.endsWith(".d.ts")) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out;
}

function relOf(absFile, repoRoot) {
  return path.relative(repoRoot, absFile).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript — compiler API
// ---------------------------------------------------------------------------
function indexTs(rel, src) {
  const ts = getTs();
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const spans = [];
  const lineOf = (node, atEnd) =>
    sf.getLineAndCharacterOfPosition(atEnd ? node.getEnd() : node.getStart(sf)).line + 1;
  const textOf = (node) => src.slice(node.getStart(sf), node.getEnd());
  const add = (symbol, kind, node) =>
    spans.push({
      id: `${rel}#${symbol}`, file: rel, symbol, kind,
      startLine: lineOf(node, false), endLine: lineOf(node, true), hash: contentHash(textOf(node)),
    });

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, "function", node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      const cls = node.name.text;
      add(cls, "class", node);
      node.members.forEach((m) => {
        if (ts.isConstructorDeclaration(m)) add(`${cls}.constructor`, "method", m);
        else if (ts.isMethodDeclaration(m) && m.name) add(`${cls}.${m.name.getText(sf)}`, "method", m);
      });
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((d) => {
        if (d.name && ts.isIdentifier(d.name) && d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          add(d.name.text, "function", d);
        }
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return spans;
}

// ---------------------------------------------------------------------------
// Python — indentation-aware
// ---------------------------------------------------------------------------
function indentWidth(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}
function indexPython(rel, src) {
  const lines = src.split(/\r?\n/);
  const spans = [];
  const classes = []; // enclosing classes: { indent, name }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = indentWidth(m[1]);
    const kw = m[2];
    const name = m[3];
    while (classes.length && classes[classes.length - 1].indent >= indent) classes.pop();
    const prefix = classes.map((c) => c.name).join(".");
    const symbol = prefix ? `${prefix}.${name}` : name;

    // body extends while following non-blank lines are more indented
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentWidth(lines[j]) > indent) end = j;
      else break;
    }
    // include contiguous decorators directly above
    let start = i;
    for (let k = i - 1; k >= 0; k--) {
      if (/^\s*@[A-Za-z_]/.test(lines[k]) && indentWidth(lines[k]) === indent) start = k;
      else break;
    }
    const kind = kw === "class" ? "class" : prefix ? "method" : "function";
    spans.push({
      id: `${rel}#${symbol}`, file: rel, symbol, kind,
      startLine: start + 1, endLine: end + 1, hash: contentHash(lines.slice(start, end + 1).join("\n")),
    });
    if (kw === "class") classes.push({ indent, name });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Brace languages — generic scanner
// ---------------------------------------------------------------------------
const NOT_NAME = new Set([
  "if", "else", "for", "while", "switch", "do", "try", "catch", "finally",
  "return", "new", "with", "when", "match", "select", "defer", "go", "case",
  "using", "lock", "unsafe", "await", "yield", "throw", "synchronized",
  "func", "fn", "function", "def", "var", "let", "const", "foreach", "sizeof",
  "typeof", "in", "of", "where", "as",
]);
const CONTAINER_KW = /\b(class|struct|interface|enum|trait|impl|namespace|module|protocol|object|record)\s+([A-Za-z_]\w*)/;
// leading keywords that mean the block is control flow, not a declaration
const CTRL_LEAD = new Set([
  "if", "else", "for", "while", "switch", "do", "try", "catch", "finally",
  "synchronized", "with", "when", "using", "lock", "return", "select",
  "defer", "go", "foreach", "case", "default", "unsafe", "match",
]);

function headerName(header) {
  const firstWord = (header.match(/[A-Za-z_]\w*/) || [])[0];
  if (firstWord && CTRL_LEAD.has(firstWord)) return null;
  const c = header.match(CONTAINER_KW);
  if (c) {
    const kw = c[1];
    return { name: c[2], kind: kw === "object" || kw === "record" ? "class" : kw };
  }
  // function-like: the last "name(" in the header (handles receivers, modifiers)
  let last = null, m, re = /([A-Za-z_]\w*)\s*\(/g;
  while ((m = re.exec(header))) last = m;
  if (last && !NOT_NAME.has(last[1])) return { name: last[1], kind: "function" };
  return null;
}
function indexBrace(rel, src) {
  const spans = [];
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const lines = src.split(/\r?\n/);
  const stack = []; // { name, kind, startLine } | null (anonymous)
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "{") {
      let h = i - 1;
      while (h >= 0 && !"{};".includes(src[h])) h--;
      const header = src.slice(h + 1, i);
      const info = headerName(header);
      if (info) {
        const startPos = h + 1 + (header.length - header.trimStart().length);
        stack.push({ name: info.name, kind: info.kind, startLine: lineAt(startPos) });
      } else {
        stack.push(null);
      }
      i++; continue;
    }
    if (c === "}") {
      const top = stack.pop();
      if (top) {
        const nested = stack.filter(Boolean).length > 0;
        const qualified = stack.filter(Boolean).map((x) => x.name).concat(top.name).join(".");
        const endLine = lineAt(i);
        spans.push({
          id: `${rel}#${qualified}`, file: rel, symbol: qualified,
          kind: nested && top.kind === "function" ? "method" : top.kind,
          startLine: top.startLine, endLine,
          hash: contentHash(lines.slice(top.startLine - 1, endLine).join("\n")),
        });
      }
      i++; continue;
    }
    i++;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
const BRACE_EXT = new Set([
  "go", "rs", "java", "kt", "kts", "scala", "cs",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "swift", "php",
]);
function indexFile(absFile, repoRoot) {
  const rel = relOf(absFile, repoRoot);
  const src = fs.readFileSync(absFile, "utf8");
  const ext = extOf(absFile);
  try {
    if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return indexTs(rel, src);
    if (ext === "py" || ext === "pyi") return indexPython(rel, src);
    if (BRACE_EXT.has(ext)) return indexBrace(rel, src);
  } catch {
    /* best-effort: a malformed file just yields no spans */
  }
  return [];
}

function indexRepo(repoRoot) {
  const files = walk(repoRoot, []);
  const spans = {};
  for (const f of files.sort()) {
    for (const span of indexFile(f, repoRoot)) spans[span.id] = span;
  }
  return spans;
}

function listFiles(repoRoot) {
  return walk(repoRoot, []).map((f) => relOf(f, repoRoot)).sort();
}

module.exports = { indexRepo, indexFile, listFiles, contentHash };
