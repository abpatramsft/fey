# Diagrams contract (the standard every subagent follows)

This is the fixed rulebook for authoring one **anchored flow diagram** per entry point.
fey's Diagrams tab draws loose Feynman-style flow maps — each module is a *worldline*
(a vertical lane) and each call is an *exchange* down the page — but unlike a throwaway
SVG, every node is **anchored to real code**, so clicking it lights the exact lines. The
one thing that is frozen is the output shape (`diagram.schema.json`); how you read the
source to produce it is up to you, per codebase.

Follow this exactly so the deterministic reducer (`fey diagrams build`) accepts your
work. A diagram that breaks a rule fails the build and leaves the existing set untouched
— nothing you write can corrupt the bundle, and nothing can be hallucinated.

## Golden rule: anchor-then-draw (same as the wiki)

You may **only** anchor a node to a span id the indexer produced — `"<file>#<Symbol>"`
from `manifest.spans` — or to a line-range anchor `"<file>#L<start>-<end>"` (every line
of every file is citable this way). **Never invent a file, symbol, or line.** If you
can't tie a call to a definition (dynamic dispatch, reflection, an external library),
mark it `"resolved": false` and omit its anchor — it renders dashed and honest.

## The two fixed jobs

1. **Discover the entry points** — wherever control enters from outside: HTTP routes,
   CLI commands, `main`, exported public API, event/message handlers, background jobs,
   test entries. Infer how they're registered from the code in front of you, not from a
   fixed list. A repo usually has several.
2. **For each chosen entry point, walk one ordered call path and emit it** as a diagram
   file conforming to `diagram.schema.json`.

Everything about *how* you parse — full AST, a lexical call-site scan, reusing the
project's own tooling — is your choice, made per codebase. A lexical scan that resolves
names is usually enough for a readable flow. See `parsing-approach.md` for the decision
procedure and the general walk; it's a method, not a lookup table.

## What each fan-out subagent writes

One subagent per entry point, each writing to its own scratch slot (disjoint — two
subagents never author the same diagram id):

```
.fey/create/diagrams/scratch/<id>/diagram.json
```

`<id>` is the diagram's kebab-case slug (also its `id` field and its URL). Return only a
one-line receipt (id + node count + how many nodes were unresolved), **not** the JSON —
keep the orchestrator's context small.

## The walk (independent of how you parsed)

From the entry function:

- Maintain a running `order` counter (entry node is `order: 0`) and a stack of parent
  node ids.
- Visit calls in **source order**; for each, emit a node with `name`, `lane`,
  `parent` = current top of stack, `order` = next counter, and `anchor` = the span id of
  the **callee's definition** (or a line-range anchor to the call site if the definition
  is external/unresolved — then set `resolved: false` and omit the anchor).
- If a call resolves to **project code**, you may recurse (push it as the new parent). If
  it's external or unresolvable, emit it `resolved: false` and don't recurse.
- Stop recursing at a **depth cap** (≈4-5) or when leaving project code, so the path
  stays finite and readable. Aim for **8-40 nodes** — past ~60 the diagram is truncated.

## Lanes (worldlines) — where the readability comes from

- Group **coarsely**: one lane per module / package / directory / layer / class — never
  one lane per file. A dozen lanes reads well; a hundred is noise.
- Give the entry point its own lane first (it reads left-to-right in call order).
- Fold utility/helper modules into a single `common` lane if they'd otherwise sprawl.
- Every `node.lane` must reference a lane declared in `lanes`. Put external calls in an
  `external` lane (kind `"external"`), which pairs naturally with `resolved: false`.

## Anchoring rules (enforced by the reducer)

- `resolved: true` (the default) → the node **must** carry an `anchor` that resolves
  against `manifest.spans` or is a valid `#L<start>-<end>` range for a file that exists.
- `resolved: false` → **no** anchor; renders dashed, needs no definition.
- Prefer a **symbol** anchor (`file#Symbol`) over a line range when the indexer produced
  one for the callee — it survives edits better and reads clearer.

## Structural rules (enforced by the reducer)

- `id` matches `^[a-z0-9][a-z0-9-]*$` and is unique across the run.
- Node `id`s are unique within a diagram; there is exactly one **root** (`parent: null`),
  and it has `order: 0`.
- Every non-null `parent` names another node in the same diagram; parent links form a
  **tree** (no cycles, every node reachable from the root).
- `order` values are integers, unique, and start at 0 (gaps are tolerated but discouraged).
- `lanes` is non-empty; every `node.lane` exists in it.

## Branches (optional — alternate paths)

At a conditional, the main arm stays in `nodes`; put alternate arms (error path, cache
miss, retry, fallback) in `branches`, each `{ "label": "...", "nodes": [ ... ] }` using
the same node shape and anchoring rules. Enumerate arms honestly — static parsing lists
them but can't say which runs most often. Branches are optional; a clean main path is a
complete, acceptable diagram on its own.

## Fidelity — say it plainly

These diagrams are **parsed, not run**: there is no timing, branch selection and dynamic
dispatch resolve only as well as your parse allows, and some edges are unresolvable by
any static method. Unresolved edges are marked (dashed). That honesty is the trade for
working on any codebase, in any language, without executing it. Don't overclaim by
marking a guess `resolved: true`.

## Example (minimal, valid)

```jsonc
{
  "id": "post-checkout",
  "entry": "POST /checkout",
  "title": "Checkout request",
  "kind": "http-route",
  "language": "python",
  "summary": "Validates the cart, prices it with any promo code, then persists the order.",
  "lanes": [
    { "id": "api",     "label": "api/routes",   "kind": "layer" },
    { "id": "orders",  "label": "orders",       "kind": "module" },
    { "id": "pricing", "label": "pricing",      "kind": "module" },
    { "id": "external","label": "external",     "kind": "external" }
  ],
  "nodes": [
    { "id": "n0", "name": "checkout",      "lane": "api",     "anchor": "api/routes.py#checkout",           "parent": null, "order": 0 },
    { "id": "n1", "name": "validate_cart", "lane": "orders",  "anchor": "orders/service.py#validate_cart",   "parent": "n0", "order": 1, "note": "raises on empty cart" },
    { "id": "n2", "name": "price_order",   "lane": "pricing", "anchor": "pricing/engine.py#price_order",     "parent": "n0", "order": 2 },
    { "id": "n3", "name": "apply_promo",   "lane": "pricing", "anchor": "pricing/engine.py#apply_promo",     "parent": "n2", "order": 3 },
    { "id": "n4", "name": "save",          "lane": "external","parent": "n0", "order": 4, "resolved": false, "note": "ORM — external" }
  ]
}
```
