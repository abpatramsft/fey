"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const G = require("./gates");
const S = require("./store");

const WRITE_TOOLS = new Set(["edit", "create", "apply_patch", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitRoot(start) {
  try {
    return path.resolve(start, git(start, ["rev-parse", "--show-toplevel"]));
  } catch {
    return path.resolve(start);
  }
}

function gitCommonDir(repoRoot) {
  try {
    return path.resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]));
  } catch {
    return null;
  }
}

function readPointer(repoRoot) {
  const common = gitCommonDir(repoRoot);
  if (!common) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(common, "fey-improve-run.json"), "utf8"));
  } catch {
    return null;
  }
}

function resolveContext(cwd) {
  const repoRoot = gitRoot(cwd);
  const directRun = path.join(repoRoot, G.IMPROVE_DIR, "run.json");
  if (fs.existsSync(directRun)) {
    const run = S.loadRun(repoRoot);
    if (!run.worktreePath || path.resolve(run.worktreePath) === path.resolve(repoRoot)) {
      return {
        repoRoot,
        runRoot: repoRoot,
        run,
        inRunRoot: true,
        pointer: readPointer(repoRoot),
      };
    }
  }
  const pointer = readPointer(repoRoot);
  if (pointer && pointer.worktreePath && fs.existsSync(path.join(pointer.worktreePath, G.IMPROVE_DIR, "run.json"))) {
    return {
      repoRoot,
      runRoot: path.resolve(pointer.worktreePath),
      run: S.loadRun(pointer.worktreePath),
      inRunRoot: path.resolve(pointer.worktreePath) === path.resolve(repoRoot),
      pointer,
    };
  }
  return { repoRoot, runRoot: null, run: null, inRunRoot: false, pointer: null };
}

function parseArgs(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function collectStringPaths(value, out = [], key = "") {
  if (typeof value === "string") {
    if (/^(?:path|file|filePath|target|destination)$/i.test(key)) out.push(value);
    for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(match[1].trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringPaths(entry, out, key);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectStringPaths(child, out, childKey);
  }
  return out;
}

function relativeToRun(runRoot, cwd, candidate) {
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
  const relative = path.relative(runRoot, absolute);
  if (!relative) return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return G.normalizePath(relative);
}

function commandText(args) {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "script", "cmd"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return "";
}

function directGitMutation(command) {
  const segments = String(command || "").split(/(?:\r?\n|&&|\|\||;)/).map((segment) => segment.trim());
  const mutating = new Set([
    "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit",
    "merge", "mv", "push", "rebase", "reset", "restore", "rm", "stash", "switch", "worktree",
  ]);
  for (const segment of segments) {
    const match = /\bgit(?:\.exe)?\b/i.exec(segment);
    if (!match) continue;
    const tokens = segment.slice(match.index + match[0].length).match(/"[^"]*"|'[^']*'|\S+/g) || [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (["-C", "-c", "--git-dir", "--work-tree"].includes(token)) {
        index += 2;
        continue;
      }
      if (/^--(?:git-dir|work-tree)=/.test(token) || token === "--no-pager") {
        index++;
        continue;
      }
      break;
    }
    const subcommand = String(tokens[index] || "").replace(/^['"]|['"]$/g, "").toLowerCase();
    if (!mutating.has(subcommand)) continue;
    if (subcommand === "branch" && !/\s-(?:D|d)\b/.test(segment)) continue;
    if (subcommand === "worktree" && !/\b(remove|prune)\b/i.test(segment)) continue;
    if (subcommand === "push" && !/--force|-f\b/i.test(segment)) continue;
    return subcommand;
  }
  return null;
}

function handoffCommand(command) {
  return /\bfey-improve(?:\.js)?\s+(finalize|merge|cleanup)\b/i.test(String(command || ""));
}

function deny(reason) {
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}

function handleSessionStart(context) {
  if (!context.runRoot) return {};
  if (!context.inRunRoot) {
    return {
      additionalContext: [
        `An active fey-improve run exists in ${context.runRoot}.`,
        `This checkout (${context.repoRoot}) is the source checkout, not the optimization worktree.`,
        "Use the worktree for improvement steps; source-checkout edits may make finalization conflict.",
      ].join("\n"),
    };
  }
  const config = G.loadGateConfig(context.runRoot);
  return {
    additionalContext: [
      `Active fey-improve run: "${context.run.title}" (${context.run.status}).`,
      `Work only in ${context.runRoot}.`,
      `Acceptance requires at least +${config.minDelta} points, no protected-criterion regression, and all deterministic gates to pass.`,
      `Limits: ${config.maxFilesChanged} files, ${config.maxLinesChanged} changed lines, ${config.maxIterations} iterations.`,
      "Use fey-improve record and commit-if-better; do not commit directly.",
    ].join("\n"),
  };
}

function handlePreToolUse(context, payload) {
  if (!context.runRoot || !context.inRunRoot) return {};
  const toolName = String(payload.toolName || payload.tool_name || "").toLowerCase();
  const args = parseArgs(payload.toolArgs == null ? payload.tool_input : payload.toolArgs);
  if (!WRITE_TOOLS.has(toolName) && !SHELL_TOOLS.has(toolName)) return {};

  if (SHELL_TOOLS.has(toolName)) {
    const command = commandText(args);
    if (handoffCommand(command)) {
      return {
        permissionDecision: "ask",
        permissionDecisionReason: "Finalizing, merging, or cleaning up an improvement run requires explicit user approval.",
      };
    }
    const mutation = directGitMutation(command);
    if (mutation) {
      return deny(`Direct git ${mutation} is disabled inside an active fey-improve worktree. Use fey-improve commit-if-better, revert, finalize, merge, or cleanup so the run remains gated and traceable.`);
    }
    return {};
  }

  if (context.run.status === "done") {
    return deny('The improvement run is marked "done". Set it back to running before editing the worktree.');
  }

  const cwd = payload.cwd || context.repoRoot;
  const paths = collectStringPaths(args);
  const config = G.loadGateConfig(context.runRoot);
  const history = S.loadHistory(context.runRoot);
  const hasBaseline = history.some((iteration) => iteration.baseline);
  for (const candidate of paths) {
    const relative = relativeToRun(context.runRoot, cwd, candidate);
    if (relative == null) return deny(`Write target is outside the optimization worktree: ${candidate}`);
    if (G.isRuntimePath(relative)) {
      if (context.run.status === "proposing" && !relative.startsWith(".fey/improve/scratch/")) {
        return deny("While proposals are running, subagents may write only to .fey/improve/scratch/.");
      }
      if (hasBaseline && /^\.fey\/improve\/(?:directions|gate|history|rubric|run)\.json$/i.test(relative)) {
        return deny(`"${relative}" is frozen after baseline. Use fey-improve commands, or start a new run if the rubric or gate must change.`);
      }
      continue;
    }
    if (context.run.status === "proposing") {
      return deny("Proposal agents must not edit production code; write a proposal JSON file under .fey/improve/scratch/.");
    }
    if (config.allowedPaths.length && !G.matchesAny(relative, config.allowedPaths)) {
      return deny(`Write target "${relative}" is outside .fey/improve/gate.json allowedPaths.`);
    }
    if (config.deniedPaths.length && G.matchesAny(relative, config.deniedPaths)) {
      return deny(`Write target "${relative}" matches .fey/improve/gate.json deniedPaths.`);
    }
  }
  return {};
}

function handlePostToolUse(context, payload) {
  if (!context.runRoot || !context.inRunRoot || context.run.status !== "running") return {};
  const toolName = String(payload.toolName || payload.tool_name || "").toLowerCase();
  if (!WRITE_TOOLS.has(toolName)) return {};
  const history = S.loadHistory(context.runRoot);
  if (!history.some((iteration) => iteration.baseline)) return {};
  const changes = G.collectChanges(context.runRoot);
  if (!changes.fileCount) return {};
  const result = G.evaluateCandidate(context.runRoot, { baseline: false, runObjectiveChecks: false });
  if (result.pass) return {};
  return {
    additionalContext: [
      "The latest edit currently violates the fey-improve candidate gate.",
      result.report,
      "Resolve these issues before recording the iteration.",
    ].join("\n\n"),
  };
}

function handlePostToolUseFailure(context, payload) {
  if (!context.runRoot || !context.inRunRoot) return {};
  const toolName = payload.toolName || payload.tool_name || "tool";
  return {
    additionalContext: [
      `${toolName} failed during an active fey-improve run.`,
      "Keep the current iteration isolated. Inspect the failure, restore a valid candidate, then rerun candidate-check before recording.",
      "If abandoning the candidate, use fey-improve revert.",
    ].join("\n"),
  };
}

function handleSubagentStart(context) {
  if (!context.runRoot || !context.inRunRoot || context.run.status !== "proposing") return {};
  const history = S.loadHistory(context.runRoot);
  const iteration = G.nextIterationNumber(history);
  return {
    additionalContext: [
      `This is proposal phase for fey-improve iteration ${iteration}.`,
      "Do not edit production code.",
      `Write exactly one proposal JSON to .fey/improve/scratch/iter-${iteration}/ using the contract in fey-improve/SKILL.md.`,
      "The proposal must include direction, idea, detail, expectedImpact, and risk.",
    ].join("\n"),
  };
}

function handleSubagentStop(context) {
  if (!context.runRoot || !context.inRunRoot || context.run.status !== "proposing") return {};
  const result = G.validateProposals(context.runRoot);
  if (result.pass) return {};
  return {
    decision: "block",
    reason: `${result.report}\n\nFix the proposal scratch output before completing the subagent.`,
  };
}

function logError(context, payload) {
  if (!context.runRoot || !context.inRunRoot) return {};
  const common = gitCommonDir(context.runRoot);
  if (!common) return {};
  const error = payload.error || {};
  const record = {
    timestamp: new Date().toISOString(),
    context: payload.errorContext || payload.error_context || "unknown",
    recoverable: !!payload.recoverable,
    name: String(error.name || "Error").slice(0, 120),
  };
  try {
    fs.appendFileSync(path.join(common, "fey-improve-errors.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {}
  return {};
}

function handleAgentStop(context) {
  if (!context.runRoot || !context.inRunRoot) return {};
  const result = G.evaluateStop(context.runRoot);
  if (result.pass) return {};
  return {
    decision: "block",
    reason: `${result.report}\n\nResolve every item, or deliberately pause the clean run with \`fey-improve status ${context.runRoot} --set paused\`.`,
  };
}

function handleHook(event, payload = {}) {
  const cwd = payload.cwd || process.cwd();
  const context = resolveContext(cwd);
  switch (event) {
    case "sessionStart": return handleSessionStart(context, payload);
    case "preToolUse": return handlePreToolUse(context, payload);
    case "postToolUse": return handlePostToolUse(context, payload);
    case "postToolUseFailure": return handlePostToolUseFailure(context, payload);
    case "subagentStart": return handleSubagentStart(context, payload);
    case "subagentStop": return handleSubagentStop(context, payload);
    case "errorOccurred": return logError(context, payload);
    case "agentStop": return handleAgentStop(context, payload);
    default: return {};
  }
}

module.exports = {
  collectStringPaths,
  directGitMutation,
  handleHook,
  handoffCommand,
  resolveContext,
};
