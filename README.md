<p align="center">
  <img src="docs/assets/fey-mark.svg" width="84" alt="Fey mark">
</p>

<h1 align="center">fey</h1>

<p align="center">
  <strong>Documentation that can point to the line.</strong><br>
  Turn a repository into an anchored wiki, clickable flow maps, narrated drift,<br>
  and a gated improvement loop for GitHub Copilot CLI.
</p>

<p align="center">
  <a href="https://abpatramsft.github.io/fey/">Website</a> ·
  <a href="https://abpatramsft.github.io/fey/getting-started.html">Getting started</a> ·
  <a href="https://abpatramsft.github.io/fey/principles.html">Design principles</a>
</p>

---

Fey gives generative documentation a deterministic spine:

- **Copilot explains** the architecture, flows, decisions, and changes.
- **Fey validates** every source anchor, page merge, diagram, coverage gate, score,
  worktree fingerprint, and keep-or-revert decision.
- **You keep the result** as ordinary Markdown and JSON under `.fey/`.

Fey has two skills:

| Skill | What it does |
|---|---|
| `fey-create` | Builds an explainable codebase wiki with Overview, Wiki, Diagrams, and Drift views. |
| `fey-improve` | Runs an isolated hill-climbing loop and keeps only candidates that clear hard gates and improve the rubric. |

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli)
- Node.js 18+
- Git for Drift and `fey-improve`
- PowerShell 7 on Windows when repository hooks are enabled

No package installation is required for the normal flow. JavaScript and TypeScript use
the compiler API when the optional `typescript` package is installed in
`.github/skills/fey-create/`, and fall back to the dependency-free brace scanner
otherwise.

## Install in a repository

Clone Fey somewhere accessible, then copy the skills and optional hooks into the
repository you want to explain.

### macOS / Linux

```bash
git clone https://github.com/abpatramsft/fey.git /tmp/fey

mkdir -p .github/skills .github/hooks
cp -R /tmp/fey/.github/skills/fey-create .github/skills/
cp -R /tmp/fey/.github/skills/fey-improve .github/skills/
cp /tmp/fey/.github/hooks/fey-hook.* .github/hooks/
```

### Windows PowerShell

```powershell
git clone https://github.com/abpatramsft/fey.git "$env:TEMP\fey"

New-Item -ItemType Directory -Force .github\skills, .github\hooks | Out-Null
Copy-Item -Recurse -Force "$env:TEMP\fey\.github\skills\fey-create" .github\skills\
Copy-Item -Recurse -Force "$env:TEMP\fey\.github\skills\fey-improve" .github\skills\
Copy-Item -Force "$env:TEMP\fey\.github\hooks\fey-hook.*" .github\hooks\
```

You can install only `fey-create` when the repository does not need the improve loop.
The hook bundle is optional; it adds lifecycle guardrails but the CLIs work without it.

For personal use across projects, place the skill directories under
`~/.copilot/skills/`.

## Create the first explainable wiki

Start Copilot CLI in the target repository:

```bash
copilot
```

Then ask:

```text
Use fey to generate an explainable wiki for this repository.
```

Copilot follows the `fey-create` skill:

1. Inspects the repository and its entry points.
2. Writes a small repository-specific indexer.
3. Runs and validates the source-span catalog.
4. Authors wiki pages using only accepted anchors.
5. Optionally builds anchored control-flow diagrams.
6. Attributes any visible working-tree drift.
7. Starts the local viewer.

Open the viewer again later:

```bash
node .github/skills/fey-create/bin/fey.js serve .
```

The default address is <http://localhost:4177>.

## What the viewer contains

| View | Question it answers |
|---|---|
| **Overview** | What is this repository, how is it divided, and where should I begin? |
| **Wiki** | What does this section do, and which exact source lines support the explanation? |
| **Diagrams** | How does control move from a real entry point through the system? |
| **Drift** | What changed in the working tree, why, and was it AI-led, human, or mixed? |
| **Optimize** | Which improvement attempts were kept or rejected, and what evidence drove the decision? |

## The anchor contract

An indexer emits real source spans:

```json
{
  "file": "src/orders/service.py",
  "symbol": "OrderService.place_order",
  "kind": "method",
  "startLine": 24,
  "endLine": 68
}
```

Fey validates the file, bounds, and uniqueness, then derives a citable ID:

```text
src/orders/service.py#OrderService.place_order
```

Any file can also use a direct line-range anchor:

```text
config/routes.yaml#L14-27
```

Pages and resolved diagram nodes may cite only accepted anchors. When prose and source
disagree, the source is the evidence.

## Run the improve loop

Ask Copilot:

```text
Use fey-improve to optimize this repository.
```

The default flow:

1. Requires a clean source checkout, then creates a sibling worktree on `fey-opt-<branch>`.
2. Names repository-specific improvement directions.
3. Authors a weighted rubric and hard gate configuration.
4. Records a clean baseline with objective command evidence.
5. Collects parallel proposals without editing production code.
6. Applies exactly one candidate.
7. Re-runs checks and records a git-state fingerprint.
8. Commits only when the candidate clears every gate and improves by `minDelta`.
9. Restores tracked files and removes new candidate files when rejected.
10. Hands accepted work back only after final checks and user review.

`init` refuses pending changes. Commit or stash them first. Add `--checkpoint` only when
you explicitly want Fey to stage and commit every current tracked and untracked change
before creating the worktree.

Key commands:

```bash
node .github/skills/fey-improve/bin/fey-improve.js init <repo> --target codebase
node .github/skills/fey-improve/bin/fey-improve.js preflight <worktree>
node .github/skills/fey-improve/bin/fey-improve.js record <worktree> --scores <file.json> --baseline
node .github/skills/fey-improve/bin/fey-improve.js candidate-check <worktree>
node .github/skills/fey-improve/bin/fey-improve.js record <worktree> --scores <file.json>
node .github/skills/fey-improve/bin/fey-improve.js commit-if-better <worktree>
node .github/skills/fey-improve/bin/fey-improve.js revert <worktree>
node .github/skills/fey-improve/bin/fey-improve.js status <worktree> --set done
node .github/skills/fey-improve/bin/fey-improve.js finalize <repo>
```

See the complete [Improve guide](https://abpatramsft.github.io/fey/improve.html).

## Hard gates

`.fey/improve/gate.json` controls:

- required and final test/build/lint/type-check commands;
- protected rubric criteria that may not regress;
- minimum accepted score delta;
- allowed and denied paths;
- maximum files, changed lines, and iterations;
- dependency-manifest opt-in;
- binary-file rejection; and
- high-confidence secret scanning.

Evaluation evidence is bound to the current git state. Changing code, rubric, directions,
or gate configuration after recording invalidates acceptance.

## Optional lifecycle hooks

The repository hook bundle:

- injects active run context at session start;
- blocks direct git mutations that bypass the improve gate;
- confines proposal-phase writes to scratch;
- reports scope and hygiene problems after edits;
- validates proposal output;
- adds recovery guidance after tool failures; and
- blocks handoff while create or improve readiness checks fail.

Hooks are a no-op in repositories without Fey state.

## Repository output

```text
.fey/
├── serve.json
├── create/
│   ├── indexer.mjs
│   ├── manifest.json
│   ├── pages/*.md
│   ├── diagrams/
│   ├── drift-notes.json
│   └── gate.json
└── improve/
    ├── run.json
    ├── directions.json
    ├── rubric.json
    ├── gate.json
    ├── history.json
    └── scratch/
```

Commit this bundle when the explanation and improvement record should travel with the
code, or ignore it when Fey is being used as disposable local analysis.

## Development check

The end-to-end test creates a disposable sample repository and exercises worktree
isolation, hooks, objective checks, accepted and rejected iterations, score tampering,
rename scope escapes, secret detection, exact revert, dashboard readiness, finalization,
and cleanup:

```bash
node --test .github/skills/fey-improve/test/improve.test.js
```

## Documentation website

The static product and reference site lives entirely in [`docs/`](docs/). GitHub Pages
should use **Deploy from a branch**, branch **main**, folder **/docs**.

```bash
python docs/tests/check_site.py
```

The Playwright smoke test validates every public page at desktop and mobile widths:

```bash
python /path/to/with_server.py \
  --server "python -m http.server 4173 --directory docs" \
  --port 4173 \
  -- python docs/tests/playwright_smoke.py
```

## Project status

Fey is an early-stage public project. The current repository-first installation is
intentional. The planned Copilot plugin, npm CLI, marketplace distribution, and release
gates are tracked in [`improvement.md`](improvement.md).

The product and visual principles are documented at
[abpatramsft.github.io/fey](https://abpatramsft.github.io/fey/).
