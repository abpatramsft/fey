#!/usr/bin/env node
"use strict";
// fey-improve CLI — the deterministic scaffolding for a Karpathy-style
// auto-improve (hill-climbing) loop over any codebase, in any language.
//
//   fey-improve init <repo> --target codebase|diff [--title "..."] [--checkpoint] [--no-worktree] [--no-branch]
//   fey-improve record <repo> --scores <file.json> [--label ..] [--summary ..] [--baseline]
//   fey-improve status <repo> [--json]
//   fey-improve commit-if-better <repo> [--message "..."]
//   fey-improve revert <repo>            # discard a rejected step (keeps .fey/improve log)
//   fey-improve finalize <repo>          # land the run on the source branch as uncommitted changes
//   fey-improve merge  <repo> [--into <branch>]  # merge the run branch back (user-confirmed)
//   fey-improve cleanup <repo> [--delete-branch] # remove the run's worktree/branch
//
// Isolation: `init` requires a clean current branch unless --checkpoint explicitly
// commits all pending work, then checks out `fey-opt-<current-branch>` in a dedicated git *worktree* (a
// separate folder) so the whole loop runs without disturbing the user's own
// checkout. Every optimization commit is quarantined on that branch. When done,
// `fey-improve finalize` lands the net result onto the source branch as
// UNCOMMITTED changes (the default hand-off — review in the editor / Drift tab,
// then commit what you want); `fey-improve merge` is the alternative that folds
// the branch back as a --no-ff merge commit. `--no-worktree` uses an in-place
// branch checkout instead; `--no-branch` optimizes in place on the current branch.
//
// The dashboard is NOT a separate app — the run is rendered as the "Optimize"
// tab of fey's own viewer (`fey serve <repo>`), reading the same `.fey/improve/`.
//
// The LLM (Copilot, driven by SKILL.md) does the thinking — exploring the code,
// naming optimization directions, authoring the rubric, judging each state
// against it, and fanning improvement ideas out to parallel agents. This CLI
// only persists that work and enforces the one hard rule: a step is committed
// *only if* the weighted rubric score went up.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const S = require("../src/store");
const G = require("../src/gates");

function readScoresArg(repoRoot, rest) {
  const i = rest.indexOf("--scores");
  if (i < 0 || !rest[i + 1]) throw new Error("--scores <file.json> is required");
  const p = path.isAbsolute(rest[i + 1]) ? rest[i + 1] : path.join(repoRoot, rest[i + 1]);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(`could not read scores file ${p}: ${error.message}`);
  }
}
function flagVal(rest, name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function isGitRepo(repoRoot) {
  try { git(repoRoot, ["rev-parse", "--is-inside-work-tree"]); return true; } catch { return false; }
}
function currentBranch(repoRoot) {
  try { return git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return null; }
}
function branchExists(repoRoot, name) {
  try { git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]); return true; } catch { return false; }
}
function workingTreeDirty(repoRoot) {
  try { return git(repoRoot, ["status", "--porcelain"]).length > 0; } catch { return false; }
}
function checkpointDirtyTree(repoRoot, source, rest) {
  if (!workingTreeDirty(repoRoot)) return;
  if (!rest.includes("--checkpoint")) {
    throw new Error("working tree is dirty — commit or stash it first, or rerun init with --checkpoint to explicitly commit all pending changes");
  }
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-m", `chore(fey-opt): checkpoint pending work on ${source} before optimization run`]);
  console.log(`fey-improve: checkpointed pending changes on ${source} because --checkpoint was supplied.`);
}
function optimizationTreeDirty(repoRoot) {
  const codeDirty = G.collectChanges(repoRoot).fileCount > 0;
  const stateDirty = git(repoRoot, ["status", "--porcelain", "--", ".fey/improve"]).length > 0;
  return codeDirty || stateDirty;
}
function printResult(result, rest) {
  if (rest.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(result.report);
}
function requirePass(result) {
  if (result.pass) return result;
  console.error(result.report);
  const error = new Error("gate failed");
  error.reported = true;
  throw error;
}

// The run's coordinates (source branch, work branch, the worktree it lives in, and
// the user's main checkout) are stashed in the *common* git dir so any worktree —
// the main one or the fey-opt one — can find them. This is what lets `finalize`
// and `merge`, run from either side, land the result on the right branch.
function gitCommonDir(repoRoot) {
  return path.resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]));
}
function pointerPath(repoRoot) { return path.join(gitCommonDir(repoRoot), "fey-improve-run.json"); }
function writePointer(repoRoot, data) {
  try { fs.writeFileSync(pointerPath(repoRoot), JSON.stringify(data, null, 2) + "\n"); } catch { /* best effort */ }
}
function readPointer(repoRoot) {
  try { return JSON.parse(fs.readFileSync(pointerPath(repoRoot), "utf8")); } catch { return null; }
}
function removePointer(repoRoot) { try { fs.unlinkSync(pointerPath(repoRoot)); } catch { /* ok */ } }
function runToPointer(run) {
  if (!run) return null;
  return { sourceBranch: run.sourceBranch, workBranch: run.workBranch, worktreePath: run.worktreePath, mainWorktree: run.mainWorktree };
}

// Where the fey-opt worktree lives by default: a sibling of the repo, clearly
// named, so it's easy to find and easy to delete. Kept out of the repo itself so
// it never shows up in the repo's own status/diff.
function defaultWorktreePath(repoRoot, work) {
  const base = path.basename(path.resolve(repoRoot));
  return path.resolve(repoRoot, "..", `${base}.${work}`);
}
// If a worktree is already checked out on `branch`, return its path (so we resume
// instead of trying to add a second worktree for the same branch, which git bans).
function worktreeForBranch(repoRoot, branch) {
  let out;
  try { out = git(repoRoot, ["worktree", "list", "--porcelain"]); } catch { return null; }
  for (const block of out.split(/\n\n+/)) {
    const wt = /^worktree (.+)$/m.exec(block);
    const br = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (wt && br && br[1] === branch) return wt[1];
  }
  return null;
}

// The default isolation strategy: run the whole loop inside a dedicated git
// *worktree* checked out on `fey-opt-<source>`. The user's own checkout is never
// disturbed — they keep working on the source branch while the loop runs in a
// separate folder. A dirty source branch is refused unless --checkpoint explicitly
// creates a checkpoint commit first.
// Returns { sourceBranch, workBranch, worktreePath, mainWorktree }.
function setupWorktree(repoRoot, rest) {
  const source = currentBranch(repoRoot);
  if (!source || source === "HEAD") {
    console.log("fey-improve: detached HEAD or no branch — running in place (no worktree).");
    return { sourceBranch: source || null, workBranch: source || null, worktreePath: repoRoot, mainWorktree: repoRoot };
  }
  // Already on an fey-opt branch? Resume in place, don't nest a worktree.
  if (/^fey-opt-/.test(source)) {
    console.log(`fey-improve: already on ${source} — resuming in place.`);
    return { sourceBranch: source.replace(/^fey-opt-/, ""), workBranch: source, worktreePath: repoRoot, mainWorktree: repoRoot };
  }
  const work = flagVal(rest, "--branch") || `fey-opt-${source}`;
  checkpointDirtyTree(repoRoot, source, rest);
  const existing = worktreeForBranch(repoRoot, work);
  let worktreePath = flagVal(rest, "--worktree-path") || defaultWorktreePath(repoRoot, work);
  if (existing) {
    worktreePath = existing;
    console.log(`fey-improve: resuming existing worktree for ${work} at ${worktreePath}.`);
  } else if (branchExists(repoRoot, work)) {
    git(repoRoot, ["worktree", "add", worktreePath, work]);
    console.log(`fey-improve: added worktree at ${worktreePath} on existing branch ${work}.`);
  } else {
    git(repoRoot, ["worktree", "add", worktreePath, "-b", work]);
    console.log(`fey-improve: created worktree at ${worktreePath} on new branch ${work} (from ${source}).`);
  }
  return { sourceBranch: source, workBranch: work, worktreePath: path.resolve(worktreePath), mainWorktree: path.resolve(repoRoot) };
}

// The legacy in-place isolation strategy (used with `--no-worktree`): require a
// clean current branch (or explicit --checkpoint), then check out `fey-opt-<source>`
// *in the same folder*. Every optimization commit lands there; the user merges it
// back with `fey-improve merge`. The default strategy is `setupWorktree`, which
// keeps the user's checkout usable. Returns { sourceBranch, workBranch }.
function setupWorkBranch(repoRoot, rest) {
  const source = currentBranch(repoRoot);
  if (!source || source === "HEAD") {
    console.log("fey-improve: detached HEAD or no branch — skipping isolated branch (working on current checkout).");
    return { sourceBranch: source || null, workBranch: source || null };
  }
  // Already on an fey-opt work branch? Treat as resume, don't nest.
  if (/^fey-opt-/.test(source)) {
    return { sourceBranch: source.replace(/^fey-opt-/, ""), workBranch: source };
  }
  const work = flagVal(rest, "--branch") || `fey-opt-${source}`;
  checkpointDirtyTree(repoRoot, source, rest);
  if (branchExists(repoRoot, work)) {
    git(repoRoot, ["checkout", work]);
    console.log(`fey-improve: resumed existing work branch ${work}.`);
  } else {
    git(repoRoot, ["checkout", "-b", work]);
    console.log(`fey-improve: branched ${work} from ${source} — all optimization commits land here.`);
  }
  return { sourceBranch: source, workBranch: work };
}

function cmdInit(repoRoot, rest) {
  const target = (flagVal(rest, "--target") || "codebase").toLowerCase();
  if (target !== "codebase" && target !== "diff") throw new Error('--target must be "codebase" or "diff"');
  const title = flagVal(rest, "--title") || `Optimize ${path.basename(path.resolve(repoRoot))}`;
  const scope = flagVal(rest, "--scope") || (target === "diff" ? "git diff HEAD" : "whole repository");

  // Isolate the run (unless disabled or not a git repo). By default the loop runs
  // in a dedicated *worktree* on `fey-opt-<source>` so the user's own checkout is
  // never disturbed. `--no-worktree` falls back to an in-place branch checkout;
  // `--no-branch` optimizes in place on the current branch. Isolation happens
  // BEFORE scaffolding so .fey/improve/ lands in the run's worktree and the
  // checkpoint commit contains only the user's own pending work.
  let sourceBranch = null, workBranch = null, worktreePath = repoRoot, mainWorktree = repoRoot;
  const isRepo = isGitRepo(repoRoot);
  const useBranch = !rest.includes("--no-branch") && isRepo;
  if (useBranch) {
    if (rest.includes("--no-worktree")) {
      ({ sourceBranch, workBranch } = setupWorkBranch(repoRoot, rest));
      worktreePath = repoRoot; mainWorktree = repoRoot;
    } else {
      ({ sourceBranch, workBranch, worktreePath, mainWorktree } = setupWorktree(repoRoot, rest));
    }
  }

  // The run lives wherever the work branch is checked out (the worktree, or the
  // repo itself for in-place runs). Scaffold and record there.
  const runRoot = worktreePath || repoRoot;
  S.ensureDir(runRoot);
  const run = {
    version: 1,
    title,
    target,
    scope,
    status: "exploring",
    sourceBranch,
    workBranch,
    worktreePath: path.resolve(worktreePath || repoRoot),
    mainWorktree: path.resolve(mainWorktree || repoRoot),
    bestTotal: null,
    bestIteration: null,
    latestIteration: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  S.saveRun(runRoot, run);
  if (!S.loadDirections(runRoot).length) S.writeJson(runRoot, "directions.json", []);
  if (!S.loadRubric(runRoot)) S.writeJson(runRoot, "rubric.json", { scale: "0..10 per criterion", criteria: [] });
  if (!S.loadHistory(runRoot).length) S.writeJson(runRoot, "history.json", []);
  if (!fs.existsSync(path.join(S.optDir(runRoot), "gate.json"))) S.writeJson(runRoot, "gate.json", G.defaultGateFile());
  fs.mkdirSync(path.join(S.optDir(runRoot), "scratch"), { recursive: true });

  // Drop a pointer in the shared git dir so `finalize`/`merge`/`cleanup` can find
  // the run from either the main checkout or the worktree.
  const separateWorktree = workBranch && workBranch !== sourceBranch && path.resolve(worktreePath) !== path.resolve(mainWorktree);
  if (isRepo && workBranch && workBranch !== sourceBranch) {
    writePointer(repoRoot, { sourceBranch, workBranch, worktreePath: path.resolve(worktreePath), mainWorktree: path.resolve(mainWorktree) });
  }

  console.log(`fey-improve: initialized .fey/improve/ for a ${target} run — "${title}"`);
  if (separateWorktree) {
    console.log(`  worktree: ${worktreePath}  (branch ${workBranch}; your ${sourceBranch} checkout is untouched)`);
    console.log(`  → run the rest of the loop and \`fey serve\` against the worktree path above.`);
    console.log(`  → when done, \`fey-improve finalize ${mainWorktree}\` lands the result on ${sourceBranch} as uncommitted changes to review.`);
  } else if (workBranch && workBranch !== sourceBranch) {
    console.log(`  branch: ${workBranch} (merge back into ${sourceBranch} when you're happy)`);
  }
  console.log("Next: write directions.json + rubric.json, then `record --baseline` (see SKILL.md).");
}

function cmdRecord(repoRoot, rest) {
  if (!S.exists(repoRoot)) throw new Error("no .fey/improve/ — run `fey-improve init` first");
  const scores = readScoresArg(repoRoot, rest);
  const baseline = rest.includes("--baseline");
  const state = G.evaluatePreflight(repoRoot, { requireRubric: true });
  requirePass(state);
  if (state.run.status === "done") throw new Error('run status is "done" — set it back to running before recording another iteration');
  const scoreErrors = G.validateScores(state.rubric, scores);
  if (scoreErrors.length) throw new Error(`invalid scores:\n- ${scoreErrors.join("\n- ")}`);
  const gate = requirePass(G.evaluateCandidate(repoRoot, { baseline, runObjectiveChecks: true }));
  const iter = S.recordIteration(repoRoot, {
    label: flagVal(rest, "--label"),
    summary: flagVal(rest, "--summary"),
    scores,
    baseline,
    evaluation: {
      fingerprint: gate.fingerprint,
      headSha: gate.headSha,
      rubricHash: gate.rubricHash,
      gateHash: gate.gateHash,
      directionsHash: gate.directionsHash,
      files: gate.changes.files,
      added: gate.changes.added,
      removed: gate.changes.removed,
      checks: gate.checks,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  });
  const run = S.loadRun(repoRoot);
  run.status = "running";
  run.updatedAt = new Date().toISOString();
  S.saveRun(repoRoot, run);
  const bar = iter.delta == null ? "" : ` (${iter.delta >= 0 ? "+" : ""}${iter.delta} vs best ${iter.prevBest})`;
  console.log(`fey-improve: recorded ${iter.label} — score ${iter.total}/100${bar}`);
  if (!iter.baseline) console.log(iter.improved ? "  ↑ improvement over current best." : "  ↓ not better than current best.");
}

function summarize(repoRoot) {
  const run = S.loadRun(repoRoot);
  const history = S.loadHistory(repoRoot);
  const best = S.bestKept(history);
  const latest = history.length ? history[history.length - 1] : null;
  return { run, history, best, latest, directions: S.loadDirections(repoRoot), rubric: S.loadRubric(repoRoot) };
}

function cmdStatus(repoRoot, rest) {
  if (!S.exists(repoRoot)) throw new Error("no .fey/improve/ — run `fey-improve init` first");
  const nextStatus = flagVal(rest, "--set");
  if (nextStatus) {
    const valid = new Set(["exploring", "proposing", "running", "paused", "interrupted", "done"]);
    if (!valid.has(nextStatus)) throw new Error(`--set must be one of: ${[...valid].join(", ")}`);
    const run = S.loadRun(repoRoot);
    const history = S.loadHistory(repoRoot);
    const latest = history.length ? history.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    if (["proposing", "paused", "done"].includes(nextStatus)) {
      const changes = G.collectChanges(repoRoot);
      if (changes.fileCount) throw new Error(`cannot set status to ${nextStatus} with uncommitted code changes: ${changes.files.join(", ")}`);
      if (latest && latest.kept === null) throw new Error(`cannot set status to ${nextStatus} while iteration ${latest.n} is pending`);
    }
    if (run.status === "proposing" && nextStatus === "running") {
      const changes = G.collectChanges(repoRoot);
      if (changes.fileCount) throw new Error(`proposal phase modified production code: ${changes.files.join(", ")}`);
      requirePass(G.validateProposals(repoRoot));
    }
    if (nextStatus === "proposing" && !history.some((iteration) => iteration.baseline)) {
      throw new Error("record a baseline before entering proposing status");
    }
    if (nextStatus === "done") requirePass(G.evaluateFinalize(repoRoot, { requireDone: false }));
    run.status = nextStatus;
    run.updatedAt = new Date().toISOString();
    S.saveRun(repoRoot, run);
    if (nextStatus === "done") {
      git(repoRoot, ["add", "-A", "--", ".fey/improve"]);
      const staged = git(repoRoot, ["diff", "--cached", "--name-only"]);
      if (staged) git(repoRoot, ["commit", "-m", "fey-opt: mark improvement run done"]);
    }
    console.log(`fey-improve: status set to ${nextStatus}.`);
    return;
  }
  const s = summarize(repoRoot);
  if (rest.includes("--json")) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`fey-improve: "${s.run.title}"  [${s.run.target}]  status=${s.run.status}`);
  if (s.run.workBranch && s.run.workBranch !== s.run.sourceBranch) console.log(`  branch: ${s.run.workBranch} → merges into ${s.run.sourceBranch}`);
  console.log(`  directions: ${s.directions.length} · rubric criteria: ${(s.rubric && s.rubric.criteria || []).length} · iterations: ${s.history.length}`);
  if (s.best) console.log(`  best: iteration ${s.best.n} @ ${s.best.total}/100 (${s.best.label})`);
  if (s.latest) console.log(`  latest: iteration ${s.latest.n} @ ${s.latest.total}/100  kept=${s.latest.kept}`);
}

function cmdPreflight(repoRoot, rest) {
  const result = G.evaluatePreflight(repoRoot, { requireRubric: !rest.includes("--basic") });
  printResult(result, rest);
  process.exit(result.pass ? 0 : 1);
}

function cmdCandidateCheck(repoRoot, rest) {
  const result = G.evaluateCandidate(repoRoot, {
    baseline: rest.includes("--baseline"),
    runObjectiveChecks: !rest.includes("--quick"),
  });
  printResult(result, rest);
  process.exit(result.pass ? 0 : 1);
}

function cmdStopCheck(repoRoot, rest) {
  if (!S.exists(repoRoot)) return;
  const result = G.evaluateStop(repoRoot);
  printResult(result, rest);
  process.exit(result.pass ? 0 : 1);
}

function cmdHandoffCheck(repoRoot, rest) {
  const result = G.evaluateFinalize(repoRoot, { requireDone: true });
  printResult(result, rest);
  process.exit(result.pass ? 0 : 1);
}

// The commit gate: commit the working tree *only if* the latest iteration beat
// the previous best. On no improvement it commits nothing and exits non-zero, so
// the skill knows to revert. `.fey/improve/` is always included so the run log is
// versioned alongside the code change it justifies.
function cmdCommitIfBetter(repoRoot, rest) {
  if (!S.exists(repoRoot)) throw new Error("no .fey/improve/ — run `fey-improve init` first");
  if (!isGitRepo(repoRoot)) throw new Error("not a git repository — cannot gate commits");
  const history = S.loadHistory(repoRoot);
  const latest = history.length ? history.reduce((a, b) => (b.n > a.n ? b : a)) : null;
  if (!latest || latest.baseline) throw new Error("no candidate iteration to commit (record a non-baseline iteration first)");
  const prior = history.filter((h) => h.n !== latest.n && h.kept === true);
  const priorBest = prior.length ? prior.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const acceptance = G.evaluateAcceptance(repoRoot, latest, priorBest);
  if (!acceptance.pass) {
    const rejectable = acceptance.errors.length &&
      acceptance.errors.every((error) => error.startsWith("score delta ") || error.startsWith("protected criterion "));
    if (rejectable) S.markKept(repoRoot, latest.n, { kept: false, commitSha: null });
    console.log(acceptance.report);
    console.log(`fey-improve: iteration ${latest.n} was NOT committed.`);
    if (!rejectable) console.log("  Fix the gate issue and record the candidate again before retrying.");
    console.log("  Run `fey-improve revert` to discard this step and try another direction.");
    process.exit(1);
  }
  const bar = priorBest ? priorBest.total : -Infinity;
  const msg = flagVal(rest, "--message") ||
    `optimize: ${latest.label} (rubric ${bar === -Infinity ? "baseline" : bar + "→"}${latest.total}/100)\n\n${latest.summary || ""}`.trim();
  git(repoRoot, ["add", "-A", "--", ...acceptance.changes.files, ".fey/improve"]);
  const staged = git(repoRoot, ["diff", "--cached", "--name-only"]);
  if (!staged) throw new Error("acceptance gate passed but there are no staged changes");
  git(repoRoot, ["commit", "-m", msg]);
  const sha = git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  S.markKept(repoRoot, latest.n, { kept: true, commitSha: sha });
  // markKept re-wrote the run log with the commit SHA it just learned; a commit
  // cannot contain its own hash, so fold that stamp into a tiny follow-up commit
  // to leave the tree clean (required before `merge`). The stored SHA points at
  // the code commit, which survives as this commit's parent.
  if (workingTreeDirty(repoRoot)) {
    git(repoRoot, ["add", "-A", "--", ".fey/improve"]);
    git(repoRoot, ["commit", "-m", `fey-opt: log iteration ${latest.n} kept (${latest.total}/100) @ ${sha}`]);
  }
  console.log(`fey-improve: committed iteration ${latest.n} (${latest.total}/100) as ${sha} — improvement kept.`);
}

// Discard a rejected step's code changes while preserving the .fey/improve log (so
// the rejected iteration stays visible on the dashboard). Tracked files are
// restored to HEAD; the run log under .fey/improve is explicitly excluded.
function cmdRevert(repoRoot) {
  if (!isGitRepo(repoRoot)) throw new Error("not a git repository");
  const before = G.collectChanges(repoRoot);
  const tracked = before.entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  if (tracked.length) git(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  const removed = G.removeUntrackedCode(repoRoot);
  const remaining = G.collectChanges(repoRoot);
  if (remaining.fileCount) throw new Error(`revert left code changes behind: ${remaining.files.join(", ")}`);
  const history = S.loadHistory(repoRoot);
  const latest = history.length ? history.reduce((a, b) => (b.n > a.n ? b : a)) : null;
  if (latest && !latest.baseline && latest.kept === null) S.markKept(repoRoot, latest.n, { kept: false, commitSha: null });
  const run = S.loadRun(repoRoot);
  if (run) {
    run.status = "running";
    run.updatedAt = new Date().toISOString();
    S.saveRun(repoRoot, run);
  }
  console.log(`fey-improve: reverted working-tree code changes and removed ${removed.length} untracked candidate file(s).`);
  // The rejected step's kept=false stamp lives in .fey/improve/history.json — commit
  // just that so the tree is clean (and the rejection stays on the dashboard).
  git(repoRoot, ["add", ".fey/improve"]);
  const staged = git(repoRoot, ["diff", "--cached", "--name-only"]);
  if (staged) git(repoRoot, ["commit", "-m", "fey-opt: log rejected step (reverted, not kept)"]);
}

// Merge the finished run back into its source branch. This is user-initiated —
// only run it once the user has reviewed the work branch and confirmed. Uses a
// --no-ff merge so the run stays as a reviewable, revertible unit of history.
function cmdMerge(repoRoot, rest) {
  if (!isGitRepo(repoRoot)) throw new Error("not a git repository");
  // Worktree run: merge happens in the *main* checkout (the work branch is checked
  // out in the worktree, so we can't check out the source branch there).
  const p = readPointer(repoRoot) || (S.exists(repoRoot) ? runToPointer(S.loadRun(repoRoot)) : null);
  if (p && p.worktreePath && p.mainWorktree && path.resolve(p.worktreePath) !== path.resolve(p.mainWorktree)) {
    const source = flagVal(rest, "--into") || p.sourceBranch;
    const work = p.workBranch;
    const main = p.mainWorktree;
    if (!source || !work) throw new Error("run pointer is missing source/work branch");
    requirePass(G.evaluateFinalize(p.worktreePath, { requireDone: true }));
    if (workingTreeDirty(main)) throw new Error(`your main checkout (${main}) is dirty — commit or stash first, then merge`);
    if (currentBranch(main) !== source) git(main, ["checkout", source]);
    git(main, ["merge", "--no-ff", work, "-m", `merge fey-opt run: ${work} into ${source}`]);
    console.log(`fey-improve: merged ${work} into ${source} in ${main} (--no-ff).`);
    console.log(`  Clean up the worktree when done: fey-improve cleanup ${main} --delete-branch`);
    return;
  }
  // In-place run (no separate worktree): original behavior.
  if (!S.exists(repoRoot)) throw new Error("no .fey/improve/ — nothing to merge");
  const run = S.loadRun(repoRoot) || {};
  const source = flagVal(rest, "--into") || run.sourceBranch;
  const work = run.workBranch || currentBranch(repoRoot);
  if (!source || !work || source === work) throw new Error("this run has no separate work branch to merge (source and work are the same)");
  requirePass(G.evaluateFinalize(repoRoot, { requireDone: true }));
  if (optimizationTreeDirty(repoRoot)) throw new Error("working tree is dirty — commit or revert the current step before merging");
  git(repoRoot, ["checkout", source]);
  git(repoRoot, ["merge", "--no-ff", work, "-m", `merge fey-opt run: ${run.title || work} into ${source}`]);
  console.log(`fey-improve: merged ${work} into ${source} (--no-ff). Review the merge, then delete ${work} if you're done:`);
  console.log(`  git branch -d ${work}`);
}

// Finalize a worktree run by landing its net result onto the source branch as
// UNCOMMITTED changes — so the user reviews them in their editor or fey's Drift
// tab, then commits what they want. This is the default hand-off (Option B): no
// merge commit, the changes simply show up as pending edits on the source branch.
function cmdFinalize(repoRoot, rest) {
  if (!isGitRepo(repoRoot)) throw new Error("not a git repository");
  const p = readPointer(repoRoot) || (S.exists(repoRoot) ? runToPointer(S.loadRun(repoRoot)) : null);
  if (!p || !p.workBranch || p.workBranch === p.sourceBranch) {
    throw new Error("no optimization run found to finalize (nothing to land)");
  }
  const { sourceBranch, workBranch, worktreePath, mainWorktree } = p;
  if (!worktreePath || !mainWorktree || path.resolve(worktreePath) === path.resolve(mainWorktree)) {
    throw new Error("this run was done in place (no separate worktree) — use `fey-improve merge` instead");
  }
  requirePass(G.evaluateFinalize(worktreePath, { requireDone: true }));
  if (optimizationTreeDirty(worktreePath)) {
    throw new Error(`the optimization worktree (${worktreePath}) has an uncommitted step — run \`fey-improve commit-if-better\` or \`revert\` there first`);
  }
  const mainBranch = currentBranch(mainWorktree);
  if (mainBranch !== sourceBranch) {
    throw new Error(`your main checkout (${mainWorktree}) is on "${mainBranch}", not "${sourceBranch}" — switch back to ${sourceBranch} before finalizing`);
  }
  if (workingTreeDirty(mainWorktree)) {
    throw new Error(`your main checkout has uncommitted changes — commit or stash them first (finalize lands the run's changes as fresh uncommitted edits on top of a clean tree)`);
  }
  // Land the run using git's own merge machinery, then unstage everything:
  //   • modified code files  → unstaged modifications (show up in fey's Drift tab)
  //   • the .fey/improve log  → untracked files (invisible to `git diff HEAD`, so
  //                             they don't clutter Drift, but still power the
  //                             Optimize tab when you `fey serve` the source repo)
  // `merge --squash` is robust against the source branch having moved since the
  // run started (real 3-way merge), unlike a raw patch apply.
  try {
    git(mainWorktree, ["merge", "--squash", workBranch]);
  } catch (e) {
    throw new Error(`could not cleanly land ${workBranch} onto ${sourceBranch} (merge conflicts — your source branch likely moved since the run started). Resolve the conflicts in ${mainWorktree}, or abort with \`git -C ${mainWorktree} reset --hard\` and merge manually. Details: ${e.message}`);
  }
  git(mainWorktree, ["reset", "-q"]);
  const changed = git(mainWorktree, ["diff", "--name-only"]).split("\n").filter(Boolean).length;

  console.log(`fey-improve: landed the optimization run onto ${sourceBranch} as UNCOMMITTED changes (${changed} file(s)) in ${mainWorktree}.`);
  console.log(`  Review them in your editor or fey's Drift tab (\`fey serve ${mainWorktree}\`), then commit what you want to keep.`);
  console.log(`  The ${workBranch} branch + worktree are kept for reference — remove them with \`fey-improve cleanup ${mainWorktree}\` when done.`);
}

// Tear down a finished run's worktree (and optionally its branch). Safe to run
// after `finalize` or `merge`. Removes the run pointer.
function cmdCleanup(repoRoot, rest) {
  if (!isGitRepo(repoRoot)) throw new Error("not a git repository");
  const p = readPointer(repoRoot);
  if (!p) throw new Error("no worktree run pointer found — nothing to clean up");
  if (p.worktreePath && p.mainWorktree && path.resolve(p.worktreePath) !== path.resolve(p.mainWorktree)) {
    try {
      git(repoRoot, ["worktree", "remove", p.worktreePath, "--force"]);
      console.log(`fey-improve: removed worktree ${p.worktreePath}.`);
    } catch (e) {
      console.log(`fey-improve: could not remove worktree (${e.message}) — remove it manually: git worktree remove --force ${p.worktreePath}`);
    }
  }
  if (rest.includes("--delete-branch") && p.workBranch) {
    try { git(repoRoot, ["branch", "-D", p.workBranch]); console.log(`fey-improve: deleted branch ${p.workBranch}.`); }
    catch (e) { console.log(`fey-improve: could not delete branch ${p.workBranch} (${e.message}).`); }
  }
  removePointer(repoRoot);
  console.log("fey-improve: cleanup done.");
}

function main() {
  const [cmd, dirArg, ...rest] = process.argv.slice(2);
  const repoRoot = path.resolve(dirArg || ".");
  try {
    if (cmd === "init") return cmdInit(repoRoot, rest);
    if (cmd === "preflight") return cmdPreflight(repoRoot, rest);
    if (cmd === "candidate-check") return cmdCandidateCheck(repoRoot, rest);
    if (cmd === "record") return cmdRecord(repoRoot, rest);
    if (cmd === "status") return cmdStatus(repoRoot, rest);
    if (cmd === "commit-if-better") return cmdCommitIfBetter(repoRoot, rest);
    if (cmd === "revert") return cmdRevert(repoRoot);
    if (cmd === "stop-check") return cmdStopCheck(repoRoot, rest);
    if (cmd === "handoff-check") return cmdHandoffCheck(repoRoot, rest);
    if (cmd === "finalize") return cmdFinalize(repoRoot, rest);
    if (cmd === "merge") return cmdMerge(repoRoot, rest);
    if (cmd === "cleanup") return cmdCleanup(repoRoot, rest);
    if (cmd === "serve") {
      console.error("fey-improve: the dashboard is now the \"Optimize\" tab of fey — run `fey serve " + (dirArg || ".") + "` instead.");
      process.exit(1);
    }
  } catch (e) {
    if (!e.reported) console.error(`fey-improve: ${e.message}`);
    process.exit(1);
  }
  console.log("usage: fey-improve <init|preflight|candidate-check|record|status|commit-if-better|revert|stop-check|handoff-check|finalize|merge|cleanup> <repoDir> [options]");
  console.log("  init safety: a dirty source tree is refused unless --checkpoint explicitly commits all pending changes");
  console.log("  (view the run in fey's dashboard: `fey serve <repoDir>` → Optimize tab)");
  process.exit(1);
}

main();
