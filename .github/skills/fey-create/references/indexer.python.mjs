// references/indexer.python.mjs — REFERENCE indexer for a Python codebase.
//
// Copy this to <yourRepo>/.fey/create/indexer.mjs and adapt it. It walks .py files and
// emits minimal raw spans as JSON on stdout. fey adds `id` + `hash` and validates
// every span, so you only get the file/symbol/line ranges right.
//
// Contract: `node .fey/create/indexer.mjs <repoRoot>`  ->  stdout: { "spans": [...] }
//           logs/diagnostics go to stderr.
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] || ".");
const IGNORE = new Set([".fey", ".git", "__pycache__", "venv", "env", "dist", "build", "node_modules"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && !IGNORE.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".py") && !e.name.endsWith(".pyi")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join("/");
const indentWidth = (line) => {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
};

// Indentation-aware: a def/class body is everything indented deeper than it.
// Methods are qualified by their enclosing class(es); decorators just above the
// def/class are folded into the span.
function extract(relFile, src) {
  const lines = src.split(/\r?\n/);
  const spans = [];
  const classes = []; // { indent, name }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = indentWidth(m[1]);
    const [, , kw, name] = m;
    while (classes.length && classes[classes.length - 1].indent >= indent) classes.pop();
    const prefix = classes.map((c) => c.name).join(".");
    const symbol = prefix ? `${prefix}.${name}` : name;

    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentWidth(lines[j]) > indent) end = j;
      else break;
    }
    let start = i;
    for (let k = i - 1; k >= 0; k--) {
      if (/^\s*@[A-Za-z_]/.test(lines[k]) && indentWidth(lines[k]) === indent) start = k;
      else break;
    }
    const kind = kw === "class" ? "class" : prefix ? "method" : "function";
    spans.push({ file: relFile, symbol, kind, startLine: start + 1, endLine: end + 1 });
    if (kw === "class") classes.push({ indent, name });
  }
  return spans;
}

const spans = [];
for (const abs of walk(repoRoot).sort()) {
  try {
    spans.push(...extract(rel(abs), fs.readFileSync(abs, "utf8")));
  } catch (e) {
    process.stderr.write(`skip ${rel(abs)}: ${e.message}\n`);
  }
}
process.stdout.write(JSON.stringify({ spans }));
