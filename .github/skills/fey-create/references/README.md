# Reference indexers

Starting points the fey skill copies into a repo as `.fey/create/indexer.mjs` and then
specializes. An indexer is a small, dependency-free Node script that prints
`{ "spans": [ { file, symbol, kind?, startLine, endLine }, … ] }` to stdout. fey
validates every span before writing it, so these only need to get file paths and
line ranges right.

| File | Use it when |
|------|-------------|
| `indexer.template.mjs` | Starting from scratch — an annotated skeleton with the full contract inline. |
| `indexer.python.mjs` | The repo is mostly Python (indentation-aware `def`/`class` extraction). |

For a full multi-language reference (TypeScript compiler API, Python, and a brace
scanner for Go/Rust/Java/C#/C++/…), read `../src/indexer.js` — that's the built-in
fallback fey uses when a repo has no `.fey/create/indexer.mjs`.
