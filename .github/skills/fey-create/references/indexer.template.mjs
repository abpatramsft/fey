// references/indexer.template.mjs — ANNOTATED SKELETON for a per-repo indexer.
//
// The fey skill copies this to <yourRepo>/.fey/create/indexer.mjs and specializes it for
// whatever languages/conventions the repo actually uses. Keep it deterministic and
// dependency-free (Node built-ins only). It is read-only: it never writes files.
//
// ── The contract ────────────────────────────────────────────────────────────
// Invocation : node .fey/create/indexer.mjs <repoRoot>     (cwd = repoRoot)
// Output     : print ONLY this JSON to stdout —
//                { "spans": [ { file, symbol, kind?, startLine, endLine }, … ] }
//              Put logs/warnings on stderr, never stdout.
// Each span  : file      repo-relative POSIX path that exists
//              symbol    citable name; qualify members, e.g. "OrderService.place"
//              kind      free-form label: class | function | method | route | …
//              startLine 1-based, inclusive
//              endLine   1-based, inclusive, >= startLine, <= file line count
// fey derives `id` (= "<file>#<symbol>") and the content `hash`, then VALIDATES
// every span. Anything out of bounds / missing makes `fey index` fail loudly and
// leaves the manifest untouched — so iterate here until it passes.
//
// Tip: symbol extraction doesn't have to be perfect. Whatever you miss can still
// be cited from prose via a line-range anchor id like "path/file.ext#L10-25".
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] || ".");
const IGNORE = new Set([".fey", ".git", "node_modules", "dist", "build", "target", "vendor"]);

// 1) Decide which files to scan (extend for the repo's languages).
const SOURCE_EXT = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "rb", "…"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && !IGNORE.has(e.name)) walk(path.join(dir, e.name), out);
    } else {
      const ext = e.name.split(".").pop().toLowerCase();
      if (SOURCE_EXT.has(ext)) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join("/");

// 2) Extract spans from one file. Replace this with real logic per language —
//    e.g. indentation rules for Python, brace matching for C-likes, a regex pass
//    for a specific framework's route/handler declarations, etc.
function extract(relFile, src) {
  const spans = [];
  // const lines = src.split(/\r?\n/);
  // … find symbols, push { file: relFile, symbol, kind, startLine, endLine } …
  return spans;
}

// 3) Walk + emit. Never throw the whole run over one bad file: log to stderr.
const spans = [];
for (const abs of walk(repoRoot).sort()) {
  try {
    spans.push(...extract(rel(abs), fs.readFileSync(abs, "utf8")));
  } catch (e) {
    process.stderr.write(`skip ${rel(abs)}: ${e.message}\n`);
  }
}
process.stdout.write(JSON.stringify({ spans }));
