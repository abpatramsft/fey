# fey — an explainable codebase wiki, driven by Copilot

fey turns any repository into a **wiki where every sentence is anchored to real code**.
Open a claim and the exact lines that back it light up; change the code and fey re-narrates
the diff as reviewable flows of intent and flags the claims that went stale. Ask it a
question and it answers by reading your code with Copilot — locally, read-only. It runs
entirely on your machine — no service, no upload.

The twist: fey is **language-agnostic by construction**. There is no hardcoded parser.
When you point Copilot at a repo, Copilot *writes a small extractor tailored to that
codebase*, fey runs and validates it, and then Copilot authors the prose. You get a wiki
that can't hallucinate links, because every link is checked against the source.

---

## What's in the box

This product mirrors the exact folders these files belong in — a repo's `.github/`:

```
fey-product/
  README.md                        ← you are here
  improvement.md                   ← deferred plugin/npm publishing plan
  .github/
    skills/
      fey-create/                  ← the skill + tool (Copilot loads SKILL.md)
        SKILL.md                   ← the instructions Copilot follows
        bin/fey.js                 ← the CLI: index | merge | diagrams | coverage | gate | serve
        src/                       ← indexer (built-in fallback), validator, coverage,
                                     diagrams reducer, server, viewer UI
        references/                ← starter indexers + the diagrams authoring contract
      fey-improve/                 ← sibling skill: the auto-improve (hill-climb) loop
        SKILL.md                   ← the loop protocol Copilot follows
        bin/fey-improve.js         ← CLI: preflight | record | candidate/commit/handoff gates
        src/store.js               ← deterministic scoring + `.fey/improve/` state
        src/gates.js               ← scope, checks, evidence, score, revert, and handoff gates
        src/hooks.js               ← lifecycle-hook policy for active improve runs
    hooks/
      fey-hook.json                ← readiness + improve lifecycle-hook registration
      fey-hook.js                  ← cross-platform hook dispatcher
      fey-hook.ps1 / fey-hook.sh   ← compatibility wrappers for the stop hook
```

To install, copy the skill folders into **your repo's `.github/skills/`** and, if you
want the quality gates, copy the hook files into `.github/hooks/`. Copilot discovers skills from
`.github/skills/`, and repository hooks from `.github/hooks/*.json`.

**Requirements:** Node.js 18+. No `npm install` needed for the normal flow. (Only run
`npm install` inside the skill folder if you want the built-in TypeScript/JavaScript
extractor, which uses the optional `typescript` package. Copilot-generated indexers need
zero dependencies.)

---

## Install

From this `fey-product/` folder, copy the pieces into the repo you want to document
(`<repo>`). Install the skill or skills you want to use; the hook bundle is optional.

```powershell
# Windows (PowerShell) — run from fey-product/
Copy-Item -Recurse -Force .github\skills\fey-create "<repo>\.github\skills\fey-create"
Copy-Item -Recurse -Force .github\skills\fey-improve "<repo>\.github\skills\fey-improve"
Copy-Item -Force .github\hooks\fey-hook.*     "<repo>\.github\hooks\"   # optional: the gate
```
```bash
# macOS / Linux — run from fey-product/
mkdir -p <repo>/.github/skills <repo>/.github/hooks
cp -r .github/skills/fey-create        <repo>/.github/skills/fey-create
cp -r .github/skills/fey-improve       <repo>/.github/skills/fey-improve
cp    .github/hooks/fey-hook.*  <repo>/.github/hooks/    # optional: the gate
```

Prefer fey in **every** repo without copying it each time? Put the skill in your user
skills directory instead (`~/.copilot/skills/fey-create`), and the hook still finds it. But the
checked-in `.github/skills/fey-create` layout is the simplest and travels with the repo.

After copying, your repo looks like:

```
<repo>/.github/
  skills/fey-create/          # explainability skill + viewer
  skills/fey-improve/         # gated auto-improve skill
  hooks/fey-hook.*            # lifecycle gates (optional)
```

---

## Use it with Copilot

Open the repo and ask Copilot, for example:

> **"Use fey to generate an explainable wiki for this repo."**

Other phrasings that trigger it: *"explain this codebase"*, *"document the flow"*, *"make
the code explainable"*, *"generate a wiki"*.

Copilot then, following the skill:

1. **Inspects** your repo — languages, layout, entry points.
2. **Writes `.fey/create/indexer.mjs`** — a small extractor tailored to *your* code, cribbed from
   the skill's `references/`. This file lives **in your repo**, so you can read and tweak it.
3. **Runs `fey index`** — fey executes that indexer, **validates** every span against the
   source (file exists, line range in bounds, ids unique), and writes the catalog. A bad
   indexer fails loudly and changes nothing, so Copilot iterates until it's clean.
4. **Authors the wiki** — picks the page structure, writes prose into `.fey/create/pages/*.md`,
   and fills `.fey/create/manifest.json`, anchoring each claim to a span from step 3.
5. **Draws the diagrams** *(optional)* — finds the entry points and fans out subagents to
   trace each flow into `.fey/create/diagrams/`, then `fey diagrams build` validates and assembles
   them for the Diagrams tab.
6. **Serves it** — `fey serve` opens the local UI.

Everything Copilot creates lands in a single `.fey/` bundle inside your repo, split into
two phases so each is easy to trace back to the run that produced it:

```
your-repo/
  .fey/
    create/                 # the "explain" phase (fey-create): wiki + diagrams
      indexer.mjs           # the per-repo extractor Copilot wrote (runnable, editable)
      manifest.json         # structure, anchors, provenance
      pages/*.md            # the wiki prose (human-readable, human-editable)
      diagrams/*.json       # optional: anchored flow maps for the Diagrams tab (one per entry point)
      scratch/              # kept per-unit authoring work (traceable provenance, not deleted)
      drift-notes.json      # per-change rationale + AI intent for the Drift view (required when the tree has changes)
      verifications.json    # optional: which claims a reviewer has marked reviewed
      page-notes.json       # optional: per-page Confirm / Flag memory notes
      gate.json             # optional: coverage thresholds for the gate
      serve.json            # runtime marker fey serve drops so the stop gate can find the live port
    improve/                # the "auto-improve" phase (fey-improve): the hill-climb run
      run.json              # run metadata (source/work branch, status, title)
      directions.json       # the optimization directions identified
      rubric.json           # the weighted scoring rubric
      gate.json             # hard checks, scope, limits, and protected criteria
      history.json          # per-iteration scores (the hill-climb graph)
      scratch/iter-<n>/     # kept parallel proposals per iteration (traceable, not deleted)
```

Commit `.fey/` to version the wiki and improvement runs alongside the code, or add it to
`.gitignore` — your call.

---

## Run the viewer yourself

You can (re)build and serve any time, without Copilot. With the skill installed at
`.github/skills/fey-create`, from your repo root:

```bash
# re-extract spans (runs .fey/create/indexer.mjs, or the built-in if none)
node .github/skills/fey-create/bin/fey.js index .

# open the local wiki at http://localhost:4177
node .github/skills/fey-create/bin/fey.js serve .
```

Add `--port N` to `serve`, or `--builtin` to `index` to force the built-in extractor.
(If you installed the skill elsewhere, point at that `bin/fey.js` instead.)

---

## Optional: readiness and improve-run hooks

The **`fey-hook`** remains a no-op outside repositories with Fey state. For a create run,
its `agentStop` check still requires:

1. **Coverage** — the wiki explains enough of the code (the share of source lines that some
   claim anchors to) to clear your thresholds.
2. **Drift is attributed** — every uncommitted diff hunk has a rationale + AI/human
   attribution in `drift-notes.json`, so the Drift view is narrated, never "Unattributed."
3. **The dashboard is live** — a `fey serve` is actually running for this repo (health-checked
   on the port it records in `.fey/serve.json`), so the run always ends with a viewable UI.

For an active improve run, the same hook bundle also:

- injects the worktree, status, score delta, and change limits at `sessionStart`;
- blocks direct git mutations that would bypass `commit-if-better`;
- confines proposal-phase writes to `.fey/improve/scratch/`;
- reports scope, secret, binary, dependency, and size violations after edits;
- validates proposal JSON before a proposal subagent can finish;
- supplies recovery guidance after tool failures; and
- blocks `agentStop` while a candidate is pending, code is dirty, or the run is not
  deliberately `paused` or `done`.

Check any of these any time:

```bash
node .github/skills/fey-create/bin/fey.js coverage .    # total + per-file breakdown
node .github/skills/fey-create/bin/fey.js gate .         # coverage pass/fail against your thresholds
node .github/skills/fey-create/bin/fey.js drift-gate .   # are all working-tree hunks attributed?
node .github/skills/fey-create/bin/fey.js stop-check .    # the full gate the hook runs (all three)
node .github/skills/fey-improve/bin/fey-improve.js preflight .
node .github/skills/fey-improve/bin/fey-improve.js candidate-check .
node .github/skills/fey-improve/bin/fey-improve.js stop-check .
node .github/skills/fey-improve/bin/fey-improve.js handoff-check .
```

Set the bar in `<repo>/.fey/create/gate.json`:

```jsonc
{
  "minTotalCoverage": 90,   // whole-repo % of lines that must be anchored
  "minFileCoverage": 80,    // every non-excluded file must reach this %
  "exclude": ["**/__init__.py", "**/*.test.ts", "main.py"]
}
```

**To enable it:** copy `.github/hooks/fey-hook.*` into your repo's `.github/hooks/` (see
Install). Copilot auto-loads `.github/hooks/*.json`, and the hook finds the tool at
`.github/skills/fey-create` automatically — no configuration. When a check is short, the hook
feeds Copilot exactly what's missing — under-covered files, unexplained hunks, or a
dashboard that isn't up — and makes it keep going until all three pass. The gate is a no-op
in repos without a `.fey/` folder, so it's harmless if left in place.

---

## Deep mode: parallel authoring (map-reduce)

On a large or multi-module repo, writing the whole wiki in one pass strains a single
context and tends to skim. fey supports a **map-reduce** authoring flow instead: Copilot
splits the repo into disjoint units and fans the *authoring* out across parallel subagents,
each working with a full, focused context on its own slice. This improves depth without
piling every file into one context.

The key to keeping it trustworthy is that the **merge is deterministic — no LLM in the
loop.** Each subagent writes its work to a per-unit scratchpad instead of returning prose:

```
your-repo/.fey/create/scratch/
  <unitId>/
    unit.json     # { "pageId", "title", "section"?, "files"?: [...] }
    page.md       # the page's prose, each claim marked <!-- olo:<blockId> -->
    blocks.json   # [ { "id", "anchors": [spanId…], "origin"?, "locked"?, ... } ]
```

Then one command reduces the scratchpad into the wiki:

```bash
node .github/skills/fey-create/bin/fey.js merge .          # assemble scratch units -> pages + manifest
node .github/skills/fey-create/bin/fey.js merge . --clean  # ...and remove the scratchpad after (optional)
```

By default the scratchpad is **kept** under `.fey/create/scratch/` so every page's
authoring work stays traceable to the run that produced it — pass `--clean` only if you
want it removed. `fey merge` validates every anchor against the span catalog, enforces
unique block/page ids and marker↔block parity, respects locked blocks, and writes **only
if the entire set is valid** — one bad unit fails the merge and leaves the wiki untouched,
so a hallucinated anchor can never slip in. If a unit comes up short on coverage, Copilot
re-dispatches just that one subagent (its scratch folder is the unit of retry).

Why this shape:
- **Context stays small** — subagents return a one-line receipt, not the prose; the
  filesystem is the shared memory between map and reduce.
- **Hallucinations are contained** — each unit is validated in isolation before it's
  accepted, and its raw output is preserved on disk for provenance.
- **Partial-crash safe** — completed scratch folders survive a session, so a re-run only
  redoes the missing units.

Copilot chooses one-pass vs map-reduce based on repo size; you don't have to ask for it.
See the skill's `SKILL.md` ("Parallel authoring") for the exact protocol.

---

## Roadmap: factory orchestration (approach B)

The parallel flow above is driven by Copilot's own subagent tool and lives entirely in the
skill's Markdown — so it ships as a drop-in and runs in any repo. A heavier variant is
possible for very large monorepos: move the **orchestration itself into code** using the
Copilot SDK's *agent factories*.

In a factory, a JavaScript `run` function partitions the repo, dispatches N subagents with
`ctx.parallel(units.map(u => () => ctx.agent(...)))`, and merges the results — all as
deterministic code, with enforced concurrency/credit limits and **resumable** runs (a run
that dies at unit 22 resumes from its journal rather than starting over). The leaf
subagents still do the same authoring; only the bookkeeping moves from prose into code.

The trade-off, and why it's roadmap rather than shipped: a factory is **session-scoped and
runtime-authored** via the SDK — it is *not* a file you can commit into `.github/skills/fey-create`
for others to reuse. Approach A (this product) puts the same map-reduce logic in `SKILL.md`,
so it travels with the repo and needs no SDK. Approach B would be invoked live in a session
when a repo is big enough to justify the extra machinery. The two share the same partition →
author → validate-merge → gate pipeline; B just hardens the orchestration.

---

## Sibling skill: `fey-improve` — the auto-improve loop

`fey-improve` is a second skill in this bundle. Where fey *explains* a codebase,
fey-improve *improves* it — a Karpathy-style hill-climbing loop that works on any
language:

1. **Explore** the codebase (or a set of diffs) and name concrete **optimization
   directions** — the axes worth pushing on.
2. **Author a weighted rubric** from those directions, then **score the current state**
   as a baseline.
3. **Fan out parallel agents** (Copilot's task tool), one per direction, each proposing a
   single change into a `scratch/` folder; apply **one** step.
4. **Re-score** and run the gate: `commit-if-better` commits only when objective checks,
   scope and hygiene gates pass, protected criteria hold, and the score clears `minDelta`;
   otherwise `revert` and try another direction. Repeat until it stops climbing.

Every run is **quarantined on its own branch.** `init` first checkpoints any pending work
on the current branch, then checks out `fey-opt-<current-branch>` — all scaffolding and
optimization commits land there, never on your source branch. When you're happy with the
run, `fey-improve merge <repo>` folds it back with a `--no-ff` merge (or use plain
`git merge`); it's always user-initiated. Pass `--no-branch` to `init` to optimize in place.

The rule that makes it trustworthy is the same spirit as fey's anchors: **a change is kept
only if its deterministic gates pass and its score improves by the configured minimum**.
Protected criteria cannot regress, objective commands must pass, every score is bound to the
evaluated git state, and rejected untracked files are removed. State lives in an
in-repo `.fey/improve/` folder (a subfolder of fey's own bundle: run, directions, rubric,
gate configuration, per-iteration evidence/history, and scratch proposals) as plain JSON.

```bash
fey-improve init  <repo> --target codebase   # checkpoints, branches to fey-opt-<branch>
# …Copilot writes directions.json + rubric.json, records a baseline,
#   then loops: propose → apply one → record → commit-if-better / revert…
fey serve <repo>                               # open the "Optimize" tab
fey-improve status <worktree> --set done       # full handoff gate + final checks
fey-improve finalize <repo>                    # once reviewed: land uncommitted changes
```

There is **no separate dashboard** — the run is rendered as a fourth tab, **Optimize**,
in fey's own viewer, stacked top to bottom: the run headline + the **hill-climb chart**
(a green "best so far" frontier over every attempt, kept steps green, rejected steps
hollow red, hover any point), then a collapsible **Iteration log** (every step, newest
first, expandable to its summary, per-criterion scores, commit SHA, and the parallel
proposals that fed it), then a collapsible **Rubric** (weighted criteria + the best
state's per-criterion scores). See `.github/skills/fey-improve/SKILL.md` for the full
protocol.

The built-in end-to-end test creates a disposable sample git repository and exercises
worktree isolation, objective checks, lifecycle hooks, accepted and rejected iterations,
rename/scope and secret defenses, exact revert, the live dashboard gate, finalization,
and cleanup:

```bash
node --test .github/skills/fey-improve/test/improve.test.js
```

---

## The views

- **Overview** — what the repo is, in one paragraph, plus an architecture map with a
  per-file coverage bar (how much of each file the wiki explains) and a suggested reading
  path.
- **Wiki** — prose on the left, code on the right. Click a claim to light its exact lines;
  click a line to jump to the claim that explains it. Claims are editable, and can be
  **locked** (never auto-rewritten) or **pinned** (anchor treated as ground truth). Every
  page ends with a review footer — **Confirm** it reads true, or **Flag an issue** with a
  note that's kept as a per-page memory for the next regeneration.
- **Diagrams** — the codebase's control flows drawn as loose, Feynman-style lane maps, one
  per entry point (HTTP route, CLI command, `main`, handler, …). See below.
- **Drift** — the uncommitted working tree, re-narrated as **logical flows of intent**
  rather than a raw diff. See below.

The views are **interactive**: select any section (a wiki claim, a whole page, a diagram
step, or a drift flow) and hit **✦ ask** to put a question to Copilot about it — see "Ask
fey anything".

### Diagrams: control flow you can click into

Point fey at a repo and it finds where control enters from outside — routes, CLI commands,
`main`, event handlers — and draws each as a **flow map**: modules become vertical
worldlines and every call is an exchange from caller to callee, loosely echoing a Feynman
diagram. It's the same anchored contract as the wiki: **every step links to a real code
span**, so clicking a node lights the exact lines it stands for, and calls fey can't resolve
statically (dynamic dispatch, external libs) are drawn dashed and honest rather than guessed.
Alternate paths — error branches, early returns — collapse into their own sections. Like the
wiki, diagrams are authored by fanning parallel Copilot subagents (one per entry point) into
`.fey/create/diagrams/scratch/`, then a **deterministic build** validates and assembles them — a
diagram that breaks the schema fails the build instead of rendering something wrong.

### Drift: the working tree as flows of intent

Drift is computed purely from `git diff` plus **net-new files** staged with intent-to-add
(`.github/` and `.fey/` are always ignored, so fey's own machinery never shows up as a
change). Instead of dumping the diff, fey clusters the changes into **logical flows** — each
a titled, plain-language story of *what changed and why*:

- **Authorship at a glance.** A left spine and a chip mark each flow as **AI-led**, **human
  edit**, or **mixed**, so provenance reads instantly. When a change came from a Copilot
  session, its **stated intent** is quoted alongside it.
- **Scan, then unfold.** Each flow is collapsible — read the titles, summaries, and intents
  first, then open one to review its evidence. Inside, every change leads with a
  plain-language rationale ("what this change does"), with the raw diff kept as secondary,
  collapsible proof and an *open in editor* link to the real file.
- **Review the claims it touches.** The wiki claims anchored to a change are shown inline
  with one-click **Approve** (mark reviewed). Reviewing is git-independent — you can clear a
  claim you've confirmed is still accurate without committing — and the Drift badge counts
  only the claims still awaiting review.

The rationale and intent come from a `.fey/create/drift-notes.json` that Copilot writes as a
required step of every run (the stop gate blocks a hand-off that leaves any hunk unexplained);
even so, fey degrades gracefully — with no notes file it still organizes the diff into one flow
per changed area, so the view is always flow-shaped and never just a wall of `+`/`-`.

### Ask fey anything (local Q&A)

Anywhere you see **✦ ask** — on a wiki section, a whole page, a diagram step, or a drift
flow — you can ask a
question in plain language and get a grounded answer streamed back. fey runs **Copilot
headlessly on your machine, read-only**: it passes the relevant file references (paths, line
ranges, the change's intent and rationale) and lets Copilot open those files to answer in
depth. Nothing is written; nothing leaves your machine. It's the fastest way to interrogate
an unfamiliar page — "what does this actually do, and why?" — or a diff you're reviewing.

---

## Why it's trustworthy

- **Links win.** When prose and code disagree, the code reference is the source of truth.
- **No invented anchors.** Copilot may only cite spans the indexer actually produced; fey
  validates them against the files. Hallucinated links are structurally impossible.
- **Deterministic re-runs.** Re-indexing just re-runs a script in your repo — no AI needed
  once the indexer exists.
- **Yours, offline, in-repo.** Prose is plain Markdown; structure is plain JSON. Nothing
  leaves your machine.

---

## FAQ

**Does it only work for TypeScript/Python?** No. Those are just the languages the *built-in
fallback* knows. For anything else, Copilot writes an indexer that fits your repo. And any
line in any file is always citable via a line-range anchor (`path/file.ext#L10-25`).

**Do I have to keep the tool in my repo?** The `.fey/` bundle must live in the repo. The
skill (`.github/skills/fey-create`) can live either in the repo (recommended — it travels with the
code and the hook finds it automatically) or in your user skills folder.

**Can I edit the wiki by hand?** Yes — edit `.fey/create/pages/*.md` directly, and lock blocks you
don't want regenerated.
