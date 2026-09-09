#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function readPayload() {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) return {};
  try { return JSON.parse(input); }
  catch (error) { throw new Error(`invalid hook payload JSON: ${error.message}`); }
}

function gitRoot(start) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return path.resolve(start);
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
}

function locateSkills(repoRoot) {
  const home = os.homedir();
  const feyHome = process.env.FEY_HOME ? path.resolve(process.env.FEY_HOME) : null;
  const improveRoot = firstExisting([
    path.join(repoRoot, ".github", "skills", "fey-improve"),
    feyHome && path.join(feyHome, "skills", "fey-improve"),
    feyHome && path.join(feyHome, "fey-improve"),
    path.join(home, ".copilot", "skills", "fey-improve"),
    path.join(home, ".agents", "skills", "fey-improve"),
  ]);
  const createBin = firstExisting([
    path.join(repoRoot, ".github", "skills", "fey-create", "bin", "fey.js"),
    feyHome && path.join(feyHome, "skills", "fey-create", "bin", "fey.js"),
    feyHome && path.join(feyHome, "fey-create", "bin", "fey.js"),
    feyHome && path.join(feyHome, "bin", "fey.js"),
    path.join(home, ".copilot", "skills", "fey-create", "bin", "fey.js"),
    path.join(home, ".agents", "skills", "fey-create", "bin", "fey.js"),
  ]);
  return { improveRoot, createBin };
}

function runCreateStopCheck(createBin, repoRoot) {
  if (!createBin) return { pass: true, output: "" };
  try {
    const output = execFileSync(process.execPath, [createBin, "stop-check", repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return { pass: true, output: output.trim() };
  } catch (error) {
    return {
      pass: false,
      output: `${error.stdout || ""}\n${error.stderr || ""}`.trim() || error.message,
    };
  }
}

function main() {
  const event = process.argv[2];
  if (!event) throw new Error("hook event argument is required");
  const payload = readPayload();
  const repoRoot = gitRoot(payload.cwd || process.cwd());
  const { improveRoot, createBin } = locateSkills(repoRoot);
  let improveResult = {};
  if (improveRoot) {
    const hooks = require(path.join(improveRoot, "src", "hooks.js"));
    improveResult = hooks.handleHook(event, payload) || {};
  } else if (fs.existsSync(path.join(repoRoot, ".fey", "improve", "run.json"))) {
    if (event === "preToolUse") {
      improveResult = {
        permissionDecision: "deny",
        permissionDecisionReason: "An active .fey/improve run exists, but the fey-improve skill cannot be found. Restore the skill before modifying the run.",
      };
    } else if (event === "agentStop" || event === "subagentStop") {
      improveResult = {
        decision: "block",
        reason: "An active .fey/improve run exists, but the fey-improve skill cannot be found. Restore the skill so its safety gates can run.",
      };
    }
  }

  if (event === "agentStop") {
    process.stdout.write(`${JSON.stringify({
      type: "progress",
      message: "Checking fey readiness and improvement-run safety...",
      temporary: true,
    })}\n`);
    const create = runCreateStopCheck(createBin, repoRoot);
    const reasons = [];
    if (!create.pass) reasons.push(create.output);
    if (improveResult.decision === "block") reasons.push(improveResult.reason);
    if (reasons.length) {
      const alreadyForced = payload.stop_hook_active
        ? "\n\nThis stop was already blocked once. Resolve the concrete failures rather than retrying unchanged."
        : "";
      process.stdout.write(`${JSON.stringify({ decision: "block", reason: `${reasons.join("\n\n")}${alreadyForced}` })}\n`);
      return;
    }
    process.stdout.write("{}\n");
    return;
  }

  if (event === "postToolUseFailure" && improveResult.additionalContext) {
    process.stdout.write(`${improveResult.additionalContext}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(improveResult)}\n`);
}

try {
  main();
} catch (error) {
  const event = process.argv[2];
  if (event === "preToolUse") {
    process.stdout.write(`${JSON.stringify({
      permissionDecision: "deny",
      permissionDecisionReason: `fey hook failed closed: ${error.message}`,
    })}\n`);
  } else if (event === "agentStop" || event === "subagentStop") {
    process.stdout.write(`${JSON.stringify({
      decision: "block",
      reason: `fey hook could not validate the run: ${error.message}`,
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      additionalContext: `fey hook warning: ${error.message}`,
    })}\n`);
  }
}
