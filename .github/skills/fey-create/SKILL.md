---
name: fey-create
description: >-
  Generate an anchored, explainable wiki for a codebase. Unlike traditional docs,
  every claim links to a live code span (file + symbol + line range), so prose and
  code stay verifiably connected. Running the skill makes Copilot author an in-repo
  `.fey/create/` bundle (a structured manifest plus human-readable markdown); `fey serve`
  then presents it in a local UI with views — Overview, Wiki, Diagrams, and Drift. Use
  when the user asks to "generate a wiki", "explain this codebase", "document the
  flow", or "make the code explainable".
---

# fey — anchored, explainable codebase wiki

fey produces a wiki where **every doc claim is anchored to real code**. Links are the
source of truth: when prose and code disagree, the link wins. The bundle lives in the
repo under `.fey/create/` and is served locally.

Command examples use `fey` as shorthand. In the checked-in repository layout, invoke it
as `node .github/skills/fey-create/bin/fey.js`; for a personal or plugin installation,
resolve `bin/fey.js` from this skill's own directory.

## The flow (keep it simple)

1. **Index** — produce the `spans` catalog in `.fey/create/manifest.json`. Two ways:
   - **Generated indexer (preferred).** Inspect the repo, then *write* an indexer at
     `.fey/create/indexer.mjs` tailored to this codebase (see "Authoring the indexer"). Run
     `fey index <repo>` — fey executes your indexer, validates its output, and writes
     the spans. This adapts to any language mix; rules are not baked into fey.
   - **Built-in fallback.** If you don't write an indexer, `fey index` uses the built-in
     multi-language extractor. Force it with `fey index <repo> --builtin`.
   Either way, **never author spans by hand** — they come from a runnable, re-runnable
   indexer so re-indexing is deterministic and needs no AI.
2. **Author** — *you (Copilot)* generate the wiki: pick the page structure, write prose
   into `.fey/create/pages/*.md`, and fill in `manifest.json` (description, architecture,
   pages, blocks, anchors). This is the whole "generation" step.
3. **Attribute drift (required).** If the working tree has any uncommitted changes, narrate
   them: write `.fey/create/drift-notes.json` so every live diff hunk has a rationale + AI/human
   attribution (see "Explaining drift"). This is **not optional** — an un-narrated change
   renders as "Unattributed", and the agentStop gate (`fey stop-check`) blocks the hand-off
   until every hunk is explained.
4. **Serve (always).** Start `fey serve <repo>` yourself, in the background so it survives the
   turn — don't just tell the user to run it. The agentStop gate health-checks that a fey
   dashboard is actually live before letting the turn end.

## Golden rule: anchor-then-generate

You may **only** cite spans that the indexer produced (ids look like
`"<relPath>#<SymbolPath>"`, e.g. `src/router.ts#Router.handle`). Never invent a file,
symbol, or line number. This makes hallucinated links structurally impossible.

## Parallel authoring (map-reduce) — for larger repos

For a small repo, author every page yourself in one pass (the flow above). For a **large
or multi-module repo**, fan the *authoring* step out across parallel subagents so each one
works with a full, focused context on a disjoint slice — this improves depth and avoids
one giant context. Use the **`task` tool** (`general-purpose` agents, run in parallel).
The map-reduce is:

**1. Index first (once).** Run `fey index <repo>` to build the shared span catalog. Every
subagent anchors against this same catalog.

**2. Plan an EXCLUSIVE partition.** Split the repo into units with **disjoint file sets** —
one unit per module (module-first) or per entry-point flow (flow-first). Shared helpers
must belong to exactly one unit (put them in a dedicated `common` unit) so two subagents
never anchor the same code and produce competing claims. Record the plan in
`manifest.strategy`.

**3. Map — dispatch one subagent per unit.** Each subagent authors *only its unit* and
**writes to a scratchpad**, returning only a one-line receipt (not the prose) so your
context stays small. Each unit writes `.fey/create/scratch/<unitId>/`:
   - `unit.json` — `{ "pageId", "title", "section"?, "files"?: [...] }`
   - `page.md` — the page prose, each claim delimited by a `<!-- olo:<blockId> -->` marker
   - `blocks.json` — `[ { "id", "anchors": [spanId…], "origin"?, "locked"?, "anchorPinned"? } ]`

   Give each subagent: its file list, the span ids for those files (from
   `manifest.spans`), and the scratchpad contract above. Tell it to anchor every claim and
   cover its files well.

**4. Reduce — merge deterministically.** Run `fey merge <repo>`. This assembles every
`.fey/create/scratch/<unit>/` into `.fey/create/pages/*.md` + `manifest.pages` with **no LLM in the
loop**: it validates every anchor against the catalog, enforces block/page-id uniqueness
and marker↔block parity, respects existing locks, and writes **only if the whole set is
valid** (one bad unit fails the merge and leaves the manifest untouched — fix that unit
and re-run). Add `--clean` to remove the scratchpad after a successful merge.

**5. Overview + gate (you, globally).** After merge, author the small global bits yourself
— `manifest.description` and `manifest.architecture` — since they need the whole-repo view.
Then run `fey coverage` / `fey gate`; if a unit came up short, re-dispatch just that one
subagent (its scratch folder is the unit of retry).

This keeps the *bookkeeping* (partition, merge, validation) deterministic while the LLM
work stays confined to authoring each slice. A roadmap "factory" variant (approach B) moves
the orchestration itself into code via the Copilot SDK — see the product README.

## Authoring the indexer (`.fey/create/indexer.mjs`)

The indexer is a **per-repo Node script you write** after looking at the codebase — a real
codebase may mix languages, use unusual conventions, or need framework-aware extraction, so
one script tailored to it beats generic rules. Keep it deterministic and dependency-free.

**Contract (frozen — this is why serving stays constant):**
- Invoked as `node .fey/create/indexer.mjs <repoRoot>` with cwd = `<repoRoot>`.
- Prints **only** JSON to stdout: `{ "spans": [ { file, symbol, kind?, startLine, endLine }, … ] }`.
  Any logs/diagnostics go to **stderr**.
- Emit the *minimal* raw span; fey derives `id` (= `"<file>#<symbol>"`) and the content
  `hash`, and **validates** every span (file exists, `1 ≤ startLine ≤ endLine ≤ lineCount`,
  ids unique). Invalid output makes `fey index` fail with actionable errors and leaves the
  manifest untouched — fix the indexer and re-run.
- `file` is a repo-relative POSIX path; `symbol` is the citable name (qualify members, e.g.
  `OrderService.place_order`); `kind` is free-form (`class`/`function`/`method`/…).
- Use **Node built-ins only** (`node:fs`, `node:path`). Read-only. No network.

**References to crib from** (all live next to this SKILL.md):
- `references/indexer.template.mjs` — annotated skeleton with the full contract inline.
- `references/indexer.python.mjs` — a focused Python extractor (indentation-aware).
- `src/indexer.js` — the built-in multi-language extractor (TS compiler API, Python,
  brace scanner for Go/Rust/Java/C#/C++/…). This is also the automatic fallback.

Copy the closest one to `<repo>/.fey/create/indexer.mjs` and specialize it for the repo at hand.

## Language support

fey is **language-agnostic by construction**: the only language-specific code is the
indexer, and the indexer is generated per repo (or the built-in fallback, which covers
TypeScript/JavaScript via the compiler API, Python via an indentation scanner, and brace
languages — Go, Rust, Java, C#, C/C++, Kotlin, Swift, Scala, PHP). Everything downstream
treats spans as plain data. To support anything else, just teach the generated indexer to
emit spans for it.

**Universal line-range anchor.** When symbol extraction misses something (any language, any
file), you can still anchor to raw lines with an id of the form `"<relPath>#L<start>-<end>"`,
e.g. `orders/service.py#L14-27`. The server synthesizes the span, so *every* line of *every*
file is citable even without symbol extraction.

## The views

- **Overview** — repo name, one-paragraph description, four stats (files indexed, wiki
  pages, % of lines anchored, drift count), and an **architecture** breakdown: named
  layers, each listing files with a coverage bar. You author `manifest.description` and
  `manifest.architecture`; coverage and stats are computed.
- **Wiki** — the editorial doc. Left: prose claims (each with a code-ref chip). Right:
  the anchored file. Clicking a claim lights its exact lines; clicking a line jumps to
  the claim that explains it. Pages are grouped by `page.section` in the nav.
- **Diagrams** — anchored flow maps, one per entry point (see below).
- **Drift** — see below.

### Ask about a section (interactive Q&A)

Every wiki claim exposes an **✦ ask** action (shown on hover or when the claim is active;
also on right-click within the claim, which captures the reader's text selection), and the
page header has a page-level **✦ ask** for whole-page questions. It opens a side drawer
where the reader types a question. The server assembles compact context from the manifest —
the claim's prose plus **file references** for every anchor (path + line range + symbol),
**not** the code itself — and runs a **headless Copilot CLI** invocation. Because Copilot
has read access to the repo (`-C <repo>`), it opens those referenced files (and anything
related) itself and answers in more depth, streaming the reply back into the drawer as
Markdown. Passing references instead of code bodies also keeps the prompt small no matter
how large the anchored ranges are.

The same **✦ ask** also lives on every **Diagram node** (a step in a flow) and every
**Drift flow** (in the flow header, or right-click on
the change), so a reviewer can ask clarifying questions about an uncommitted change — "what
does this do?", "is it safe?", "why was it made?". Diff asks send `flowId` instead of
`pageId`; the server builds context from the flow's title, stated intent, attribution
(AI / human / mixed), each hunk's rationale, and the actual diff, then lets Copilot open the
changed files for the surrounding picture. Answers render with full Markdown (headings,
lists, tables, fenced code).

The invocation is `copilot -C <repo> -s --no-ask-user --available-tools view rg glob
--allow-all-tools --deny-tool=write --deny-tool=shell` with the prompt fed on **stdin**
(not `-p`, which would hit the OS command-line length limit → `spawn ENAMETOOLONG` on
large pages). It is non-interactive, clean output (`-s`), and **read-only by tool
availability**: the model can only view and search local files, while shell, write, web,
and MCP integrations are absent from its tool surface. This runs against the user's local
`copilot` binary and login. Set `FEY_COPILOT_BIN` to point at a specific binary and
`FEY_ASK_MODEL` to pin a model; if `copilot` isn't on `PATH`, the drawer shows a friendly
error.

## Diagrams = anchored flow maps

Diagrams draw the codebase's **control flows** — one per entry point — as loose,
Feynman-style lane maps: modules are vertical worldlines, each call is an exchange from
the caller's lane to the callee's, and **every node anchors to a real code span**, so
clicking a step lights the exact lines it stands for (same golden rule as the wiki).
This is a *plausible static control path*, not a runtime trace — there is no timing.

The data lives in `.fey/create/diagrams/`: one `<id>.json` per flow plus an `index.json`. It is
produced by the **same map-reduce pattern as wiki authoring** — fan out to subagents,
then reduce deterministically:

1. **Index first.** Diagrams anchor to `manifest.spans`, so `fey index <repo>` must have
   run. No manifest ⇒ nothing to anchor to.
2. **Discover entry points (you).** Scan for where control enters from outside — HTTP
   routes, CLI commands, `main`, exported functions, event/job handlers, test entries.
   Infer the patterns from the code in front of you; don't rely on a fixed list. Pick the
   most explanatory few (or all, for a small repo).
3. **Fan out — one subagent per entry point.** Give each subagent the
   **`references/diagrams-contract.md`** rulebook, the entry point, and the relevant
   `manifest.spans` ids. It walks calls from the entry, groups them into lanes, and
   **writes `.fey/create/diagrams/scratch/<id>/diagram.json`** — returning only a one-line
   receipt so your context stays small. Each node anchors to a span id (or a
   `<file>#L<start>-<end>` range); genuinely unresolvable calls (dynamic dispatch, external
   libs) are marked `resolved:false` and carry **no** anchor. Optional `branches` capture
   alternate paths (errors, early returns).
4. **Reduce — build deterministically.** Run `fey diagrams build <repo>`. This validates
   every scratch diagram (unique node ids; exactly one root; parent refs form a tree with
   no cycles; lane refs exist; kind in enum; id matches its folder; every anchor resolves
   against `manifest.spans`) and writes `<id>.json` + `index.json` **only if the whole set
   is valid** — one bad diagram fails the build and leaves existing output untouched (fix
   that scratch folder and re-run). Add `--clean` to remove the scratchpad after success.
   **No LLM in the reduce step** — the bookkeeping is deterministic.
5. **Serve.** `fey serve <repo>` renders the **Diagrams** tab: one **collapsible card per
   entry point** (expand to trace its flow), each with the lane map, the click-to-code
   panel, alternate-path (branch) sections, and a per-flow **✦ ask** drawer.

The output contract is frozen in **`references/diagram.schema.json`**; the authoring rules
subagents must follow are in **`references/diagrams-contract.md`**. Both are the single
source of truth — the reducer enforces the schema, so a subagent that violates it fails the
build rather than producing a wrong diagram.

## Drift = `git diff` + net-new files

Drift is computed from the working tree, not from content hashing:
- **Tracked changes** vs the last commit (`git diff HEAD`).
- **Net-new files** — untracked files that are ready to commit, found via
  `git ls-files --others --exclude-standard` (so anything in `.gitignore` is skipped).
  These show up as all-additions **without** the user having to `git add -N` first.

Both sources drop the `.github/` and `.fey/` prefixes (fey's own bundle and CI config
are never drift). The Drift view lists each changed/new file, tags new ones with a
**NEW** badge, flags claims whose anchored line ranges overlap a change (**HIGH**) vs
changes with no anchored claim (**MED**), and shows the diff. No diff and no new files →
"No drift". Do not build any other drift signal.

### Explaining drift (attribution) — "why did this change, and was it AI?"

Beyond flagging *what* changed, fey re-narrates the working tree as **logical flows**:
clusters of related diffs, each with a short title, a one-line summary, its dominant
author (AI vs human), and its stated intent — with the raw code kept as collapsible
evidence underneath. This is a **required** generate-then-serve step whenever the working
tree has uncommitted changes: you (the skill) author `.fey/create/drift-notes.json`; the
server clusters, renders, and links it. Skipping it leaves changes "Unattributed" and the
agentStop gate (`fey stop-check`) will block the turn until every hunk is explained. Protocol:

1. **List the hunks that need explaining.** Run:
   ```
   node <skill>/bin/fey.js diff-hunks <repoDir> --json
   ```
   Each hunk has a stable `sig` (a signature over the file path + added lines) and an
   `explained` flag. Only write notes for `explained: false` hunks; existing notes stay
   valid until that code changes again.

2. **Attribute each hunk from the workspace conversations.** Query the **local** session
   store (Copilot CLI sessions are local-only — the cloud store has nothing for them):
   - `session_files(session_id, file_path, tool_name, turn_index)` — which session/turn
     touched a file. **`file_path` is an absolute Windows path with backslashes**, so match
     on the *basename* or normalize separators; a POSIX `LIKE '%dir/file.py%'` will NOT match.
   - `turns(session_id, turn_index, user_message, assistant_response)` — the driving
     request + what the agent said it did (the rationale + AI intent).
   - **AI vs human:** presence of the file in `session_files` ⇒ the edit went through a
     Copilot tool ⇒ `author: "ai"`. Absence ⇒ `author: "human"` (hand-edit / unattributed).

3. **Adaptive fan-out.** For a small diff, attribute inline. For a large or ambiguous diff,
   fan out with `task` subagents — one per hunk (or per file) — each judging *which* candidate
   turn best explains its hunk. Only fan out the **judgment**; the `diff-hunks` + session
   queries are deterministic, do those centrally. Then run a **reduce step**: group hunks that
   share a session/turn into one `changeSet` with a single overarching intent, so N sibling
   hunks don't get N inconsistent rationales.

4. **Write `.fey/create/drift-notes.json`** — a per-hunk `notes` map (keyed by `sig`) plus an
   optional `flows` array that names and describes each cluster:
   ```json
   {
     "version": 1,
     "flows": [
       {
         "id": "promo-codes",
         "title": "Add promo-code support to orders",
         "summary": "Orders carry a discount field and pricing applies it at checkout.",
         "changeSets": ["Promo-code support"]
       }
     ],
     "notes": {
       "<sig>": {
         "file": "orders/models.py",
         "author": "ai",
         "rationale": "Added a discount field to Order to support promo codes.",
         "aiIntent": "Extend the order model so downstream pricing can apply discounts.",
         "confidence": "high",
         "sessionId": "3c9c5c7f…", "turn": 21,
         "changeSet": "Promo-code support"
       }
     }
   }
   ```
   `author` ∈ `ai|human|unknown`; `confidence` ∈ `high|medium|low`. `aiIntent` shows only
   when `author: "ai"`. Missing/mismatched sigs render as "Unattributed" — never fabricate.

   **Write rationales for a reader, not a changelog.** The `rationale` is the primary thing
   a reviewer reads — it should let them understand the change *without* reading the diff.
   Write 2–4 plain-language sentences that say what the code now does, how it differs from
   before, and why, naming the concrete symbols involved. Note anything a reviewer would want
   to confirm (e.g. "behaviour for the caller is unchanged", "runs before persistence"). The
   raw diff is shown underneath as secondary proof, so the rationale carries the understanding.

   **Flows.** The server joins each hunk to a flow via its note's `changeSet` label. A flow
   groups the hunks (across files) that carry any of its `changeSets`, aggregates their claims,
   and shows a dominant author (AI, human, or **mixed**) plus a representative stated intent.
   `flows` is **optional**: when omitted, the server synthesizes one flow per distinct
   `changeSet` label (titled by the label) and drops the rest into an **"Other changes"**
   bucket — so the Drift view is always flow-organized. Order the `flows` array in the reading
   order you want reviewers to walk. Set a `changeSet` even on human/unattributed hunks you
   want named as their own flow.

   **In the Drift view**, each flow is **collapsible**: a reviewer scans the flow titles,
   summaries, and stated intents first, then unfolds one flow to review its code. Inside a
   flow, every change leads with its plain-language rationale ("what this change does"), and
   the diff sits under it as a **crux** (a window around the change) that collapses larger
   hunks and net-new files behind a "Show full diff · N lines" toggle. Every file offers
   **open in editor** (`vscode://file/<abs>:<line>`) to jump to the exact line in VS Code.
   Any wiki **claim anchored to a change is shown inline directly under that change**, each
   with its own one-click **Approve** (see verification below). A claim is listed under just
   one change (the first it touches); if it also rests on other changes in the flow, an
   "↔ N other changes" badge says so, and approving it once reviews it everywhere.

### Reviewing drift — "Mark reviewed" (Option A verification)

Each claim flagged in Drift carries an **Approve** button. Approving records a
git-independent *verification stamp* in `.fey/create/verifications.json`, keyed by the block id:

```json
{ "version": 1, "verified": { "b4": { "hash": "e591e666f9b7785e", "at": "2026-…Z" } } }
```

`hash` is a content hash of the **current** text of that block's anchored line ranges. A
claim reads as **Reviewed** only while its stored hash still matches the live code, so the
moment that code changes again the stamp goes stale and the claim automatically re-surfaces
in Drift. No commit is required — a reviewer can clear drift for a claim they've confirmed
is still accurate, and the Drift badge counts only *unreviewed* claims. The server writes
this file; you never need to hand-author it.

### Page memory notes — Confirm / Flag

Every wiki page footer asks *"Is this page accurate against the code?"* with **Confirm**
and **Flag an issue**. Both append to `.fey/create/page-notes.json`, keyed by page id:

```json
{ "version": 1, "pages": { "order-lifecycle": [
  { "type": "flag", "text": "Retry behaviour no longer matches place_order.", "at": "2026-…Z" }
] } }
```

Flags carry the reviewer's note and render as amber "reader notes" under the page —
a lightweight, per-page memory of what's wrong, useful as context the next time you
regenerate that page. Confirms are stored with empty text as a freshness signal.

Both `verifications.json` and `page-notes.json` live under `.fey/create/`, so they are never
themselves counted as drift.

## Adaptive page IA

Read the codebase shape and choose, recording it in `manifest.strategy`:
- **flow-first** — clear entry point(s) + linear call graph → one page per entry-point
  lifecycle. Best for "how a request moves through this".
- **module-first** — library/SDK, broad export surface → one page per module.
- **hybrid** — monorepo → a page per package.

## Human-in-the-loop (respect locks)

Blocks carry `origin` (`generated` | `human-edited` | `human-authored`), `locked`, and
`anchorPinned`. On regeneration: never rewrite a `locked` block; treat an
`anchorPinned` link as ground truth. Only re-author unlocked `generated` blocks.

## Commands

The CLI ships **inside this skill folder** (`bin/fey.js`), so run it with node from
wherever this skill lives — no global install. `<repoDir>` is the repo you're documenting
(often `.`). The `.fey/create/` bundle is always created **inside `<repoDir>`**.

```
node <skill>/bin/fey.js index <repoDir>              # run <repoDir>/.fey/create/indexer.mjs if present,
                                                     #   else the built-in; validate + write spans
node <skill>/bin/fey.js index <repoDir> --builtin    # force the built-in indexer
node <skill>/bin/fey.js merge <repoDir> [--clean]    # reduce: assemble .fey/create/scratch/<unit>/ into
                                                     #   pages + manifest (validated); parallel authoring
node <skill>/bin/fey.js diagrams build <repoDir> [--clean]  # reduce: validate + assemble
                                                     #   .fey/create/diagrams/scratch/<id>/ into anchored flow maps
node <skill>/bin/fey.js diff-hunks <repoDir> [--json] # list working-tree diff hunks + stable sigs,
                                                     #   flagging which still need drift-notes.json
node <skill>/bin/fey.js coverage <repoDir> [--json]  # per-file + total anchored-line coverage
node <skill>/bin/fey.js gate <repoDir>               # check coverage vs .fey/create/gate.json (exit 1 if unmet)
node <skill>/bin/fey.js drift-gate <repoDir>         # check every working-tree hunk is attributed in
                                                     #   drift-notes.json (exit 1 if any is unexplained)
node <skill>/bin/fey.js stop-check <repoDir>         # agentStop umbrella: coverage + drift-gate + a live
                                                     #   dashboard. No-op unless <repoDir>/.fey exists.
node <skill>/bin/fey.js serve <repoDir> [--port N]   # run the local UI (default 4177)
```

`<skill>` is this folder's path. No dependencies are required for the generated-indexer
flow; `npm install` is only needed if you want the built-in **TypeScript/JavaScript**
extractor (it lazily uses the optional `typescript` package).

## Coverage & the quality gate

**Coverage** = the share of source lines that some wiki claim anchors to (see `fey
coverage`). Aim high: a page should explain the code, not gesture at it. Add blocks until
each important file is well covered.

An **agentStop hook** (`.github/hooks/fey-hook.*`) enforces readiness before the turn can
end. It runs `fey stop-check`, which is a **no-op in any repo without a `.fey/` folder** (so
it never traps unrelated work), and otherwise blocks the stop until all three hold:
1. **Coverage** clears the thresholds in `<repo>/.fey/create/gate.json`:

```jsonc
{ "minTotalCoverage": 90, "minFileCoverage": 80, "exclude": ["**/__init__.py", "**/*.test.ts"] }
```

2. **Drift is attributed** — every uncommitted diff hunk has a note in
   `.fey/create/drift-notes.json` (no "Unattributed" changes left).
3. **The dashboard is live** — `fey serve` is actually running for this repo. `serve` drops a
   `.fey/serve.json` runfile with its port; the gate health-checks `/api/health` on it. So
   always start `fey serve` (in the background) as part of a run — don't just suggest it.

Defaults (no gate file): total ≥ 90%, per-file ≥ 80%. When you're generating a wiki, use `fey
coverage`/`fey gate` to find the lowest-covered files and anchor more of them — add wiki
blocks whose anchors point at spans (or line-range anchors) in those files. If a file
genuinely needs no docs (generated code, tests, package markers), add it to `exclude`
rather than padding prose.

## Manifest shape (reference)

```jsonc
{
  "version": 1,
  "strategy": "flow-first",
  "description": "One paragraph: what this codebase is, in the reader's terms.",
  "architecture": [
    { "group": "Routing", "path": "src", "files": ["src/router.ts"] }
  ],
  "spans": { "src/router.ts#Router.handle": { "file", "symbol", "kind", "startLine", "endLine", "hash" } },
  "pages": [
    {
      "id": "request-lifecycle",
      "title": "Request Lifecycle",
      "section": "Architecture",
      "md": "pages/request-lifecycle.md",
      "blocks": [
        { "id": "b1", "anchors": ["src/index.ts#createApp"], "origin": "generated", "locked": false, "anchorPinned": false }
      ]
    }
  ]
}
```

Prose lives in `.fey/create/pages/<md>`; delimit each claim with a marker line
`<!-- olo:<blockId> -->` whose id matches a block. Every claim MUST have ≥1 anchor that
exists in `manifest.spans`.

Roadmap: a **code-first** view (auto flow/sequence diagram + code tour driven by the
same anchors) — no new data model needed.
