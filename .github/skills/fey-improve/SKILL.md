---
name: fey-improve
description: >-
  Run a Karpathy-style auto-improve (hill-climbing) loop over a codebase or a set
  of diffs, in any language. Copilot explores the code, names concrete optimization
  directions, authors a weighted rubric, scores the current state as a baseline,
  then fans parallel agents out to propose improvements, applies one step, re-scores,
  and commits ONLY when deterministic gates pass, protected criteria hold, and the
  rubric score improves by the configured minimum — repeating until it stops improving.
  The run is rendered as the "Optimize" tab of fey's own dashboard (`fey serve`) —
  the directions, the rubric, and the full hill-climb graph. Use when the user asks to
  "optimize this codebase", "auto-improve", "hill climb", "self-improve the code", or
  "run an improvement loop".
---

# fey-improve — auto-improve loop for any codebase

fey-improve turns "make this better" into a disciplined loop with a scoreboard.
You (Copilot) do the thinking; the CLI keeps score and enforces hard safety rules:

> **A change is kept only if every deterministic gate passes, protected criteria
> do not regress, and the weighted rubric score improves by the configured minimum.**
> Otherwise there is no commit — revert and try a different direction.

Everything the loop remembers lives in an in-repo `.fey/improve/` folder (a subfolder of
fey's own `.fey/` bundle) as plain, hand-editable JSON. The run is shown as the
**Optimize** tab of fey's dashboard — there is no separate viewer. The loop is
**language-agnostic**: it judges Python, Java,
React/TS, Go, anything — because *you* score the code against a rubric, rather than
running language-specific rules.

## The loop at a glance

```
init ─▶ 1. explore ─▶ directions.json
              │
              ▼
        2. author rubric ─▶ rubric.json
              │
              ▼
        3. baseline eval ─▶ record --baseline        (iteration 0)
              │
        ┌─────▼──────────────────────────────────────┐
        │ 4. fan out parallel agents ─▶ scratch/      │
        │ 5. apply ONE step                            │
        │ 6. re-eval ─▶ record ─▶ commit-if-better    │◀─ repeat
        │      improved? commit & keep : revert        │
        └──────────────────────────────────────────────┘
              │  (no improvement for K rounds, or user stops)
              ▼
        view in fey's Optimize tab (`fey serve`)
              │
              ▼
              user reviews ─▶ finalize (land on source as uncommitted changes)
                              └ or merge (fey-opt-<branch> ─▶ source)
```

## Golden rules

- **The gates and rubric are the judges.** Every decision to keep or discard a step is
  made by deterministic hard checks plus the weighted score, never by vibes. If a useful
  property is missing, update the gate or rubric before evaluating another candidate;
  do not override a failed result.
- **One step at a time.** Explore many ideas in parallel, but apply exactly one
  coherent change per iteration so the score cleanly attributes to it.
- **Start from a clean tree.** Before each step, the working tree must be clean
  (everything committed). This is what makes `commit-if-better` and `revert` safe.
- **Objective signals first.** If the repo has tests / a build / a linter, run them
  through `.fey/improve/gate.json`. They are hard pass/fail gates, not points that
  another criterion can compensate for.
- **Never fabricate or omit scores.** Judge the actual code state you just produced
  and score every rubric criterion. `record` rejects missing, unknown, invalid, or
  out-of-range values and binds the evaluation to the current git state.
- **Protected means protected.** Mark correctness, security, compatibility, or data
  integrity criteria with `"protected": true`; they cannot regress even when the total
  score rises.
- **Do not bypass the CLI.** Never run direct `git add`, `git commit`, `git restore`,
  `git reset`, or merge commands inside an active run. The lifecycle hook blocks these
  because they bypass the evidence and revert contracts.

## Step 0 — Initialize (isolate in a worktree)

Decide the **target** with the user's intent:
- `--target codebase` — optimize the whole repository (default).
- `--target diff` — optimize only what a set of diffs touched (pair with `--scope`,
  e.g. `--scope "git diff main...HEAD"`).

```
fey-improve init <repo> --target codebase --title "Optimize <repo>"
```

`init` does two things, in order:

1. **Quarantines the run in a dedicated git worktree.** It first commits any pending
   work on the current branch (a "checkpoint" commit so nothing is lost and the
   branch point is clean), then checks out `fey-opt-<current-branch>` in a **separate
   worktree folder** (a sibling directory, e.g. `<repo>.fey-opt-<branch>`). The whole
   loop runs there — **your own checkout is never disturbed**, so you can keep working
   on the source branch in parallel. Every scaffold file and every optimization commit
   lands on the work branch, inside that worktree. If a worktree for the branch already
   exists it resumes there; on detached-HEAD it warns and stays put.
   - `--no-worktree` — use an in-place branch checkout instead (swap `fey-opt-*` into
     the current folder, the legacy behavior).
   - `--no-branch` — optimize in place on the current branch (no isolation at all).
   - `--branch <name>` / `--worktree-path <dir>` — override the branch name / location.
2. **Scaffolds `.fey/improve/`** (in the worktree) with empty `directions.json`,
   `rubric.json`, `history.json`, `gate.json`, and `scratch/`, and records
   `sourceBranch`/`workBranch`/`worktreePath`/`mainWorktree` in `run.json`. It also drops
   a small pointer in the shared git dir so `finalize`/`merge`/`cleanup` can find the run.

Confirm the repo is a **git repo**. `init` prints the **worktree path** — run the rest
of the loop (every `record`, `commit-if-better`, `revert`, and `fey serve`) against
**that path**, not the original checkout. Tell the user their source branch is untouched
and that they'll review the result at the end.

## Step 1 — Explore and name directions

Read enough of the codebase (or the diffs, for a diff run) to understand what it does
and where it could get better. Then write **3–6 concrete optimization directions** to
`.fey/improve/directions.json`. Directions are the axes of improvement — not tasks.

```jsonc
[
  {
    "id": "perf-hotpath",
    "title": "Hot-path performance",
    "description": "Reduce time/allocations in the request→response critical path.",
    "rationale": "Profiling shows `handleOrder` re-parses config on every call."
  },
  {
    "id": "readability",
    "title": "Readability & cohesion",
    "description": "Smaller functions, clearer names, less duplication.",
    "rationale": "Several 150+ line functions mix IO, validation, and business logic."
  },
  { "id": "robustness", "title": "Error handling & edge cases", "description": "…", "rationale": "…" }
]
```

Pick directions that fit **this** codebase. For a diff run, derive them from what the
diffs are trying to accomplish.

## Step 2 — Author the rubric

Turn the directions into **weighted, scorable criteria** in `.fey/improve/rubric.json`.
Each criterion is scored `0..max` (default 10); weights set relative importance. Tie
each criterion to a direction via `direction` (the direction `id`) so the dashboard
can group them.

```jsonc
{
  "scale": "0..10 per criterion",
  "notes": "Higher is better. Correctness gates everything: a failing build caps it at 0.",
  "criteria": [
    { "id": "correctness", "title": "Tests & build pass", "description": "All existing tests green; build clean.", "weight": 3, "max": 10, "direction": "robustness", "protected": true },
    { "id": "hotpath",     "title": "Hot-path efficiency", "description": "Fewer redundant ops/allocations on the critical path.", "weight": 2, "max": 10, "direction": "perf-hotpath" },
    { "id": "cohesion",    "title": "Function cohesion",   "description": "Single-responsibility functions, low duplication.", "weight": 2, "max": 10, "direction": "readability" },
    { "id": "clarity",     "title": "Naming & clarity",    "description": "Intent-revealing names, minimal surprise.", "weight": 1, "max": 10, "direction": "readability" }
  ]
}
```

Keep it small (4–8 criteria). Include at least one **objective** criterion backed by
tests/build/lint so the loop can't drift into subjective-only scoring.

Configure the hard gates in `.fey/improve/gate.json`. `init` writes safe defaults;
replace the command list and scope with values discovered from the repository:

```jsonc
{
  "minDelta": 1,
  "protectedCriteria": ["correctness"],
  "requiredChecks": [
    { "name": "tests", "command": "npm test", "timeoutSec": 300 },
    { "name": "typecheck", "command": "npm run typecheck", "timeoutSec": 300 }
  ],
  "finalChecks": [
    { "name": "full validation", "command": "npm test", "timeoutSec": 600 }
  ],
  "allowedPaths": ["src/**", "test/**"],
  "deniedPaths": [".github/workflows/release.yml"],
  "maxFilesChanged": 20,
  "maxLinesChanged": 800,
  "maxIterations": 20,
  "allowDependencyChanges": false,
  "forbidBinaryFiles": true,
  "scanSecrets": true
}
```

- Empty `allowedPaths` means the whole repository is in scope.
- Dependency manifests and lockfiles are blocked unless `allowDependencyChanges` is true.
- Added content is checked for high-confidence credential/private-key patterns.
- Binary files and oversized steps are rejected by default.
- `finalChecks` falls back to `requiredChecks` when empty.
- A check may use one cross-platform `command`, or separate `bash` and `powershell`
  commands when the repository's validation syntax differs by operating system.

Run the deterministic preflight after authoring directions, rubric, and gate config:

```
fey-improve preflight <worktree-path>
```

## Step 3 — Baseline evaluation

Score the code **as it is right now**, before any change. Write the scores file under
`.fey/improve/scratch/` so it stays with the run without becoming a code change. Map
every criterion id to a score (or `{score, note}`):

```jsonc
// baseline-scores.json
{
  "correctness": { "score": 10, "note": "42/42 tests pass, build clean" },
  "hotpath":     { "score": 5,  "note": "config re-parsed per call" },
  "cohesion":    { "score": 4,  "note": "handleOrder is 160 lines" },
  "clarity":     { "score": 6 }
}
```

```
fey-improve record <repo> --scores baseline-scores.json --baseline \
  --label "baseline" --summary "starting point before optimization"
```

`record --baseline` requires a code-clean worktree, runs every `requiredChecks` command,
validates the complete score vector, and records the git/evaluator fingerprint. It also
sets the run status to `running`. This is iteration 0 — the first point on the
hill-climb chart and the bar to beat.

## Step 4 — Fan out parallel improvement proposals

Before dispatching proposals, mark the phase:

```
fey-improve status <repo> --set proposing
```

For the next iteration `n`, use the **task tool** to launch several **task or custom
proposal agents** in parallel — ideally one per direction — each answering: *"What
single change would most improve THIS direction?"* Do not use the built-in
`general-purpose` agent for proposal gating because it does not emit subagent lifecycle
hooks. Each agent writes a JSON proposal into
`.fey/improve/scratch/iter-<n>/<name>.json`:

```jsonc
// .fey/improve/scratch/iter-1/perf-hotpath.json
{
  "direction": "perf-hotpath",
  "idea": "Cache parsed config once at startup instead of per request.",
  "detail": "Lift `parseConfig()` out of `handleOrder` into a module-level memo.",
  "expectedImpact": "hotpath 5→8; no behavior change; tests unaffected",
  "risk": "low"
}
```

Give each agent full context (repo path, the direction, the rubric) and tell it to
**write the proposal file, not to edit code**. These are the candidate moves; the
dashboard shows them under the iteration they informed. The `subagentStart` hook repeats
this contract, and `subagentStop` validates the proposal files before allowing completion.

After proposals are present:

```
fey-improve status <repo> --set running
```

This transition independently validates the proposal directory and refuses to continue
if proposal-phase agents changed production code, so correctness does not depend on hook
delivery alone.

## Step 5 — Apply exactly ONE step

Review the proposals and pick the single most promising move (highest expected rubric
gain for acceptable risk). **Apply just that one change** to the actual code. Do not
combine several proposals — one coherent change per iteration keeps attribution clean.
Optionally mark the chosen proposal with `"picked": true` in its scratch file.

## Step 6 — Re-evaluate, then commit only if better

Re-score **every** criterion for the new state, write a new scores file under scratch,
and record it. `record` itself runs the configured objective commands and rejects scope,
dependency, binary, secret, size, or score-integrity failures:

```
fey-improve record <repo> --scores iter1-scores.json \
  --label "cache parsed config" --summary "lifted parseConfig to a startup memo"
```

Then run the gate:

```
fey-improve commit-if-better <repo>
```

- **Accepted:** the worktree still matches the recorded fingerprint, objective checks
  passed, protected criteria did not regress, and the total improved by at least
  `minDelta`. The CLI stages only the evaluated code paths plus `.fey/improve/`, commits,
  stamps the short SHA, and marks the step **kept**.
- **Rejected:** the CLI commits nothing and exits non-zero. Run:
  ```
  fey-improve revert <repo>
  ```
  to restore tracked code to HEAD and remove brand-new untracked candidate files. The
  rejected step stays on the dashboard in red. Then try a **different** direction.

You can inspect the hard gate separately:

```
fey-improve candidate-check <repo>          # includes objective commands
fey-improve candidate-check <repo> --quick  # structural/scope/security checks only
```

`.fey/improve/` is committed alongside the code so the run log is versioned with the
change it justifies.

## Step 7 — Repeat until it stops climbing

Loop steps 4–6. Stop when any of:
- **No improvement for K consecutive rounds** (K≈3) — you're at a local optimum.
- The user says stop, or a target score is reached.
- Every direction has been meaningfully explored and further ideas are marginal.

Increment `n` each round. Keep status accurate through the CLI:

```
fey-improve status <repo> --set proposing
fey-improve status <repo> --set running
fey-improve status <repo> --set paused
fey-improve status <repo> --set done
```

The stop hook only allows a clean run to end when it is deliberately `paused` or `done`.
Setting `done` runs the full handoff gate and commits the final run-state update.

## Step 8 — View it in fey's dashboard

The run is rendered as the **Optimize** tab of fey's own viewer — there is no separate
dashboard. Start (or reuse) fey's server **against the worktree** (that's where the run
lives during the loop):

```
fey serve <worktree-path>
```

The **Optimize** tab renders on its own — it reads only `.fey/improve/`, so it works
even if `fey-create` was never run on this repo (the Overview / Wiki / Diagrams / Drift
tabs simply grey out until a wiki bundle exists). Open the **Optimize** tab. It stacks, top to bottom:
- **Run headline + hill-climb chart** — the best score + gain, the identified
  directions, and the chart: a green "best so far" frontier over the dashed line of
  every attempt, kept steps in green, rejected steps hollow in red (hover any point).
- **Iteration log** (collapsible) — every step (newest first), each expandable to its
  summary, per-criterion scores, commit SHA, and the parallel proposals that fed it.
- **Rubric** (collapsible) — the weighted criteria and the current best state's
  per-criterion scores.

## Step 9 — Hand the run back (finalize, or merge)

The whole run lives on `fey-opt-<source>` in its own worktree; the source branch and
the user's own checkout are untouched. Once the user has reviewed the run (in the
Optimize tab and in the branch's commit history) and is happy, hand it back. **This is
always user-initiated** — never do it without the user's explicit go-ahead.

Before asking for approval, mark the run done and show the deterministic handoff result:

```
fey-improve status <worktree-path> --set done
fey-improve handoff-check <worktree-path>
```

**Default — `finalize` (land as uncommitted changes to review):**

```
fey-improve finalize <repo>       # <repo> = the user's ORIGINAL checkout, not the worktree
```

This lands the run's **net code changes onto the source branch as UNCOMMITTED edits**
(via a `git merge --squash` + unstage), so they show up as pending changes the user
reviews in their editor or fey's **Drift** tab, then commits whatever they want to keep.
The `.fey/improve/` run log rides along as **untracked** files — invisible to the Drift
code diff, but still powering the Optimize tab when they `fey serve` the source repo.
Requirements: the worktree's last step is committed (clean), and the source checkout is
on `sourceBranch` and clean.

> After `finalize`, the source-branch working tree carries the optimization changes
> **uncommitted** — so they auto-populate the Drift diff viewer live (`git diff HEAD`),
> no re-run of `fey-create` needed for the raw diff. (Re-run `fey-create` only if you
> want the rich authorship/intent/flow narrative rewritten for those changes.)

**Alternative — `merge` (fold the branch back as a commit):**

```
fey-improve merge <repo> [--into <branch>]
```

A `--no-ff` merge of `fey-opt-<source>` into the source branch (run from the main
checkout), keeping the whole run as one revertible unit of history. Refuses a dirty tree.

**Clean up** the worktree/branch when done:

```
fey-improve cleanup <repo> [--delete-branch]
```

If they'd rather not do either, the branch is an ordinary branch — they can cherry-pick,
keep, or delete it themselves.

## Files you write vs. files the CLI writes
| File | Owner |
| --- | --- |
| `.fey/improve/run.json` | `init` (CLI) — includes `sourceBranch`/`workBranch`/`worktreePath`/`mainWorktree`; you may edit `status`/`title` |
| `.fey/improve/directions.json` | **you** (Step 1) |
| `.fey/improve/rubric.json` | **you** (Step 2) |
| `.fey/improve/gate.json` | **you** (Step 2) — objective commands, scope, limits, protected criteria |
| `.fey/improve/scratch/iter-<n>/*.json` | **you / parallel agents** (Step 4) |
| `.fey/improve/history.json` | `record` (CLI) — scores plus bound evaluation evidence; never hand-edit |

## CLI reference

```
fey-improve init  <repo> --target codebase|diff [--title "…"] [--scope "…"] [--no-worktree] [--no-branch] [--branch <name>] [--worktree-path <dir>]
fey-improve preflight <repo> [--basic] [--json]
fey-improve candidate-check <repo> [--baseline] [--quick] [--json]
fey-improve record <repo> --scores <file.json> [--label "…"] [--summary "…"] [--baseline]
fey-improve status <repo> [--json] [--set exploring|proposing|running|paused|interrupted|done]
fey-improve commit-if-better <repo> [--message "…"]
fey-improve revert <repo>
fey-improve stop-check <repo> [--json]
fey-improve handoff-check <repo> [--json]
fey-improve finalize <repo>                   # land the run on the source branch as UNCOMMITTED changes (default hand-off)
fey-improve merge  <repo> [--into <branch>]   # alt: --no-ff merge of fey-opt-<source> back into source
fey-improve cleanup <repo> [--delete-branch]  # remove the run's worktree (and optionally its branch)
```

`init` checkpoints the current branch, then checks out `fey-opt-<current-branch>` in a
dedicated **worktree** (use `--no-worktree` for an in-place checkout, `--no-branch` for
no isolation). Run every later command and `fey serve` against the **worktree path**
`init` prints. `finalize` lands the result as uncommitted changes on the source branch;
`merge` folds the branch back as a commit; `cleanup` tears the worktree down. The
dashboard is fey's Optimize tab — run `fey serve <worktree-path>` to view a run.
