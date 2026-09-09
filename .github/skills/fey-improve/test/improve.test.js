"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const productRoot = path.resolve(__dirname, "..", "..", "..", "..");
const gatesModule = require("../src/gates");
const hooksModule = require("../src/hooks");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  const expected = options.expect == null ? 0 : options.expect;
  if (expected === 0 && result.status !== 0) {
    assert.fail(`command failed (${result.status}): ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  if (expected !== 0 && result.status === 0) {
    assert.fail(`command unexpectedly passed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(repo, ...args) {
  return run("git", args, { cwd: repo }).stdout.trim();
}

function nodeCli(bin, args, options = {}) {
  return run(process.execPath, [bin, ...args], options);
}

function hook(hookBin, event, payload, cwd) {
  const result = nodeCli(hookBin, [event], {
    cwd,
    input: JSON.stringify(payload),
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] || "{}");
}

async function waitForHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fey server did not become healthy on port ${port}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

test("hook command classification blocks direct git mutations", () => {
  assert.equal(hooksModule.directGitMutation("git status --short"), null);
  assert.equal(hooksModule.directGitMutation("git commit -am test"), "commit");
  assert.equal(hooksModule.directGitMutation("git -C . reset --hard"), "reset");
  assert.equal(hooksModule.directGitMutation("git -c core.quotepath=false mv old new"), "mv");
  assert.equal(hooksModule.directGitMutation("git push origin main"), null);
  assert.equal(hooksModule.directGitMutation("git push --force origin main"), "push");
});

test("objective checks select the platform-specific command", () => {
  const result = gatesModule.runChecks(process.cwd(), [{
    name: "platform command",
    bash: "printf platform-ok",
    powershell: "Write-Output platform-ok",
    timeoutSec: 10,
  }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].pass, true);
  assert.match(result[0].output, /platform-ok/);
});

test("init refuses a dirty source tree unless checkpoint is explicit", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fey-improve-dirty-"));
  const repo = path.join(tempRoot, "sample");
  const worktree = path.join(tempRoot, "worktree");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(repo, { recursive: true });
  write(path.join(repo, "app.js"), "module.exports = 1;\n");
  run("git", ["init", "-b", "main"], { cwd: repo });
  git(repo, "config", "user.name", "Fey Test");
  git(repo, "config", "user.email", "fey-test@example.invalid");
  git(repo, "add", "app.js");
  git(repo, "commit", "-m", "baseline");
  write(path.join(repo, "app.js"), "module.exports = 2;\n");

  const improveBin = path.join(productRoot, ".github", "skills", "fey-improve", "bin", "fey-improve.js");
  const refused = nodeCli(improveBin, ["init", repo], { cwd: repo, expect: 1 });
  assert.match(`${refused.stdout}\n${refused.stderr}`, /working tree is dirty/);
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1");
  assert.match(git(repo, "status", "--porcelain"), /app\.js/);

  nodeCli(improveBin, ["init", repo, "--checkpoint", "--worktree-path", worktree], { cwd: repo });
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "2");
  assert.equal(git(repo, "status", "--porcelain"), "");
  nodeCli(improveBin, ["cleanup", repo, "--delete-branch"], { cwd: repo });
});

test("fey-improve gates and hooks work end to end on a sample repository", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fey-improve-e2e-"));
  const repo = path.join(tempRoot, "sample");
  const worktree = path.join(tempRoot, "sample.fey-opt-main");
  let server = null;
  t.after(async () => {
    await stopProcess(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(path.join(productRoot, ".github"), path.join(repo, ".github"), { recursive: true });
  write(path.join(repo, "src", "sum.js"), [
    '"use strict";',
    "",
    "function sum(values) {",
    "  let total = 0;",
    "  for (const value of values) total += value;",
    "  return total;",
    "}",
    "",
    "module.exports = { sum };",
    "",
  ].join("\n"));
  write(path.join(repo, "test.js"), [
    '"use strict";',
    'const assert = require("node:assert/strict");',
    'const { sum } = require("./src/sum");',
    "assert.equal(sum([1, 2, 3]), 6);",
    "assert.equal(sum([]), 0);",
    'console.log("sample tests passed");',
    "",
  ].join("\n"));
  writeJson(path.join(repo, "package.json"), {
    name: "fey-improve-sample",
    private: true,
    scripts: { test: "node test.js" },
  });
  write(path.join(repo, ".github", "workflows", "ci.yml"), "name: sample\n");

  run("git", ["init", "-b", "main"], { cwd: repo });
  git(repo, "config", "user.name", "Fey Test");
  git(repo, "config", "user.email", "fey-test@example.invalid");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "sample baseline");

  const improveBin = path.join(repo, ".github", "skills", "fey-improve", "bin", "fey-improve.js");
  nodeCli(improveBin, ["init", repo, "--target", "codebase"], { cwd: repo });
  assert.ok(fs.existsSync(path.join(worktree, ".fey", "improve", "run.json")));

  const workImproveBin = path.join(worktree, ".github", "skills", "fey-improve", "bin", "fey-improve.js");
  const workFeyBin = path.join(worktree, ".github", "skills", "fey-create", "bin", "fey.js");
  const hookBin = path.join(worktree, ".github", "hooks", "fey-hook.js");
  const improveDir = path.join(worktree, ".fey", "improve");

  writeJson(path.join(improveDir, "directions.json"), [{
    id: "clarity",
    title: "Implementation clarity",
    description: "Make the sample implementation more concise without changing behavior.",
    rationale: "The loop should prove it can gate a small, safe refactor.",
  }]);
  writeJson(path.join(improveDir, "rubric.json"), {
    scale: "0..10 per criterion",
    criteria: [
      {
        id: "correctness",
        title: "Tests pass",
        description: "The sample assertions pass.",
        direction: "clarity",
        weight: 1,
        max: 10,
        protected: true,
      },
      {
        id: "clarity",
        title: "Implementation clarity",
        description: "The implementation is concise and readable.",
        direction: "clarity",
        weight: 3,
        max: 10,
      },
    ],
  });
  writeJson(path.join(improveDir, "gate.json"), {
    minDelta: 1,
    protectedCriteria: ["correctness"],
    requiredChecks: [{ name: "sample tests", command: "node test.js", timeoutSec: 30 }],
    finalChecks: [{ name: "sample tests", command: "node test.js", timeoutSec: 30 }],
    allowedPaths: ["src/**"],
    deniedPaths: [],
    maxFilesChanged: 3,
    maxLinesChanged: 100,
    maxIterations: 6,
    allowDependencyChanges: false,
    forbidBinaryFiles: true,
    scanSecrets: true,
  });
  const baselineScores = path.join(improveDir, "scratch", "baseline-scores.json");
  writeJson(baselineScores, {
    correctness: { score: 10, note: "sample tests pass" },
    clarity: { score: 5, note: "loop is explicit but verbose" },
  });

  nodeCli(workImproveBin, [
    "record", worktree,
    "--scores", baselineScores,
    "--baseline",
    "--label", "baseline",
  ], { cwd: worktree });

  const sessionContext = hook(hookBin, "sessionStart", {
    cwd: worktree,
    sessionId: "test-session",
  }, worktree);
  assert.match(sessionContext.additionalContext, /Active fey-improve run/);

  const deniedCommit = hook(hookBin, "preToolUse", {
    cwd: worktree,
    toolName: "powershell",
    toolArgs: { command: "git commit -am bypass" },
  }, worktree);
  assert.equal(deniedCommit.permissionDecision, "deny");
  const frozenGate = hook(hookBin, "preToolUse", {
    cwd: worktree,
    toolName: "edit",
    toolArgs: { path: ".fey/improve/gate.json" },
  }, worktree);
  assert.equal(frozenGate.permissionDecision, "deny");

  nodeCli(workImproveBin, ["status", worktree, "--set", "proposing"], { cwd: worktree });
  const proposalDir = path.join(improveDir, "scratch", "iter-1");
  const proposalWriteDenied = hook(hookBin, "preToolUse", {
    cwd: worktree,
    toolName: "edit",
    toolArgs: { path: "src/sum.js" },
  }, worktree);
  assert.equal(proposalWriteDenied.permissionDecision, "deny");
  const missingProposal = hook(hookBin, "subagentStop", {
    cwd: worktree,
    agentName: "task",
    response: "nothing written",
  }, worktree);
  assert.equal(missingProposal.decision, "block");
  writeJson(path.join(proposalDir, "clarity.json"), {
    direction: "clarity",
    idea: "Use Array.prototype.reduce.",
    detail: "Replace the manual accumulator loop with a direct reduce expression.",
    expectedImpact: "Clarity improves without changing behavior.",
    risk: "low",
  });
  const proposalStart = hook(hookBin, "subagentStart", {
    cwd: worktree,
    agentName: "task",
  }, worktree);
  assert.match(proposalStart.additionalContext, /proposal phase/i);
  assert.deepEqual(hook(hookBin, "subagentStop", {
    cwd: worktree,
    agentName: "task",
    response: "proposal written",
  }, worktree), {});
  nodeCli(workImproveBin, ["status", worktree, "--set", "running"], { cwd: worktree });

  write(path.join(worktree, "src", "sum.js"), [
    '"use strict";',
    "",
    "function sum(values) {",
    "  return values.reduce((total, value) => total + value, 0);",
    "}",
    "",
    "module.exports = { sum };",
    "",
  ].join("\n"));
  const postEdit = hook(hookBin, "postToolUse", {
    cwd: worktree,
    toolName: "edit",
    toolArgs: { path: "src/sum.js" },
    toolResult: { resultType: "success", textResultForLlm: "edited" },
  }, worktree);
  assert.deepEqual(postEdit, {});

  const candidateScores = path.join(improveDir, "scratch", "iter-1-scores.json");
  writeJson(candidateScores, {
    correctness: { score: 10, note: "sample tests pass" },
    clarity: { score: 8, note: "single expression with the same behavior" },
  });
  nodeCli(workImproveBin, [
    "record", worktree,
    "--scores", candidateScores,
    "--label", "use reduce",
    "--summary", "replace the manual accumulator with reduce",
  ], { cwd: worktree });
  const historyFile = path.join(improveDir, "history.json");
  const history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  const candidate = history.find((iteration) => iteration.n === 1);
  const candidateTotal = candidate.total;
  candidate.total = 99;
  writeJson(historyFile, history);
  const tamperedTotal = nodeCli(workImproveBin, ["commit-if-better", worktree], {
    cwd: worktree,
    expect: 1,
  });
  assert.match(`${tamperedTotal.stdout}\n${tamperedTotal.stderr}`, /does not match recomputed total/);
  candidate.total = candidateTotal;
  writeJson(historyFile, history);
  nodeCli(workImproveBin, ["commit-if-better", worktree], { cwd: worktree });
  assert.equal(git(worktree, "status", "--porcelain"), "");

  const deniedMove = hook(hookBin, "preToolUse", {
    cwd: worktree,
    toolName: "powershell",
    toolArgs: { command: "git -c core.quotepath=false mv .github/workflows/ci.yml src/ci.yml" },
  }, worktree);
  assert.equal(deniedMove.permissionDecision, "deny");
  git(worktree, "mv", ".github/workflows/ci.yml", "src/ci.yml");
  const renameFailure = nodeCli(workImproveBin, ["candidate-check", worktree, "--quick"], {
    cwd: worktree,
    expect: 1,
  });
  assert.match(`${renameFailure.stdout}\n${renameFailure.stderr}`, /\.github\/workflows\/ci\.yml/);
  nodeCli(workImproveBin, ["revert", worktree], { cwd: worktree });
  assert.equal(fs.existsSync(path.join(worktree, ".github", "workflows", "ci.yml")), true);
  assert.equal(fs.existsSync(path.join(worktree, "src", "ci.yml")), false);
  assert.equal(git(worktree, "status", "--porcelain"), "");

  write(path.join(worktree, "README.md"), "out of scope\n");
  const scopeHook = hook(hookBin, "postToolUse", {
    cwd: worktree,
    toolName: "create",
    toolArgs: { path: "README.md" },
    toolResult: { resultType: "success", textResultForLlm: "created" },
  }, worktree);
  assert.match(scopeHook.additionalContext, /outside allowedPaths/);
  const scopeFailure = nodeCli(workImproveBin, ["candidate-check", worktree, "--quick"], {
    cwd: worktree,
    expect: 1,
  });
  assert.match(`${scopeFailure.stdout}\n${scopeFailure.stderr}`, /outside allowedPaths/);
  fs.rmSync(path.join(worktree, "README.md"));

  write(path.join(worktree, "src", "secret.js"), "const key = `-----BEGIN PRIVATE KEY-----`;\n");
  const secretFailure = nodeCli(workImproveBin, ["candidate-check", worktree, "--quick"], {
    cwd: worktree,
    expect: 1,
  });
  assert.match(`${secretFailure.stdout}\n${secretFailure.stderr}`, /possible secret material/);
  fs.rmSync(path.join(worktree, "src", "secret.js"));

  write(path.join(worktree, "src", "extra.js"), "module.exports = 42;\n");
  const regressingScores = path.join(improveDir, "scratch", "iter-2-scores.json");
  writeJson(regressingScores, {
    correctness: { score: 9, note: "claimed regression for gate testing" },
    clarity: { score: 10, note: "extra helper is very clear" },
  });
  nodeCli(workImproveBin, [
    "record", worktree,
    "--scores", regressingScores,
    "--label", "protected regression",
  ], { cwd: worktree });
  const rejection = nodeCli(workImproveBin, ["commit-if-better", worktree], {
    cwd: worktree,
    expect: 1,
  });
  assert.match(`${rejection.stdout}\n${rejection.stderr}`, /protected criterion "correctness" regressed/);
  nodeCli(workImproveBin, ["revert", worktree], { cwd: worktree });
  assert.equal(fs.existsSync(path.join(worktree, "src", "extra.js")), false);
  assert.equal(git(worktree, "status", "--porcelain"), "");

  const toolFailure = run(process.execPath, [hookBin, "postToolUseFailure"], {
    cwd: worktree,
    input: JSON.stringify({
      cwd: worktree,
      toolName: "powershell",
      error: "sample failure",
    }),
    expect: 1,
  });
  assert.equal(toolFailure.status, 2);
  assert.match(toolFailure.stdout, /Keep the current iteration isolated/);
  hook(hookBin, "errorOccurred", {
    cwd: worktree,
    error: { name: "SampleError", message: "not persisted" },
    errorContext: "tool_execution",
    recoverable: true,
  }, worktree);
  const commonDir = git(worktree, "rev-parse", "--git-common-dir");
  const errorLog = path.resolve(worktree, commonDir, "fey-improve-errors.jsonl");
  assert.match(fs.readFileSync(errorLog, "utf8"), /"name":"SampleError"/);
  assert.doesNotMatch(fs.readFileSync(errorLog, "utf8"), /not persisted/);

  const runningStop = nodeCli(workImproveBin, ["stop-check", worktree], {
    cwd: worktree,
    expect: 1,
  });
  assert.match(runningStop.stdout, /set it to paused or done/);
  nodeCli(workImproveBin, ["status", worktree, "--set", "paused"], { cwd: worktree });

  const port = 46000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, [workFeyBin, "serve", worktree, "--port", String(port)], {
    cwd: worktree,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const health = await waitForHealth(port);
  assert.equal(health.ok, true);

  const stopDecision = hook(hookBin, "agentStop", {
    cwd: worktree,
    sessionId: "test-session",
    stopReason: "end_turn",
    stop_hook_active: false,
  }, worktree);
  assert.deepEqual(stopDecision, {});
  await stopProcess(server);
  server = null;

  nodeCli(workImproveBin, ["status", worktree, "--set", "done"], { cwd: worktree });
  nodeCli(workImproveBin, ["handoff-check", worktree], { cwd: worktree });
  assert.equal(git(worktree, "status", "--porcelain"), "?? .fey/serve.json");

  nodeCli(improveBin, ["finalize", repo], { cwd: repo });
  assert.match(fs.readFileSync(path.join(repo, "src", "sum.js"), "utf8"), /reduce/);
  assert.match(git(repo, "status", "--porcelain"), /src\/sum\.js/);
  assert.deepEqual(hooksModule.handleHook("preToolUse", {
    cwd: repo,
    toolName: "edit",
    toolArgs: { path: "src/sum.js" },
  }), {});
  assert.deepEqual(hooksModule.handleHook("agentStop", { cwd: repo }), {});

  nodeCli(improveBin, ["cleanup", repo, "--delete-branch"], { cwd: repo });
  assert.equal(fs.existsSync(worktree), false);
});
