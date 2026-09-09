"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const S = require("./store");

const IMPROVE_DIR = path.join(".fey", "improve");
const RUNTIME_PATHS = [".fey/"];

const DEFAULTS = {
  minDelta: 1,
  protectedCriteria: [],
  requiredChecks: [],
  finalChecks: [],
  allowedPaths: [],
  deniedPaths: [],
  maxFilesChanged: 20,
  maxLinesChanged: 800,
  maxIterations: 20,
  allowDependencyChanges: false,
  forbidBinaryFiles: true,
  scanSecrets: true,
};

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "pipfile",
  "pipfile.lock",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  "composer.json",
  "composer.lock",
]);

const SECRET_PATTERNS = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isRuntimePath(rel) {
  const normalized = normalizePath(rel);
  return RUNTIME_PATHS.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding === null ? null : "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitRepo(repoRoot) {
  try {
    return git(repoRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function currentBranch(repoRoot) {
  try {
    return git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error && error.code === "ENOENT") throw new Error(`missing ${normalizePath(file)}`);
    throw new Error(`invalid JSON in ${normalizePath(file)}: ${error.message}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function hashObject(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function asStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const out = value.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (out.length !== value.length) errors.push(`${field} must contain only non-empty strings`);
  return out;
}

function normalizeChecks(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const seen = new Set();
  const checks = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${field}[${i}] must be an object`);
      continue;
    }
    const name = String(raw.name || "").trim();
    const command = String(raw.command || "").trim();
    const bash = String(raw.bash || "").trim();
    const powershell = String(raw.powershell || "").trim();
    const timeoutSec = raw.timeoutSec == null ? 300 : Number(raw.timeoutSec);
    if (!name) errors.push(`${field}[${i}].name is required`);
    if (!command && !bash && !powershell) {
      errors.push(`${field}[${i}] requires command, bash, or powershell`);
    }
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 3600) {
      errors.push(`${field}[${i}].timeoutSec must be between 1 and 3600`);
    }
    if (name && seen.has(name)) errors.push(`${field} contains duplicate check name "${name}"`);
    seen.add(name);
    if (name && (command || bash || powershell) && Number.isFinite(timeoutSec) && timeoutSec > 0 && timeoutSec <= 3600) {
      checks.push({ name, ...(command ? { command } : {}), ...(bash ? { bash } : {}), ...(powershell ? { powershell } : {}), timeoutSec });
    }
  }
  return checks;
}

function loadGateConfig(repoRoot) {
  const file = path.join(repoRoot, IMPROVE_DIR, "gate.json");
  const user = readJsonFile(file, {});
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new Error(".fey/improve/gate.json must contain a JSON object");
  }
  const raw = { ...DEFAULTS, ...user };
  const errors = [];
  const config = {
    minDelta: Number(raw.minDelta),
    protectedCriteria: asStringArray(raw.protectedCriteria, "protectedCriteria", errors),
    requiredChecks: normalizeChecks(raw.requiredChecks, "requiredChecks", errors),
    finalChecks: normalizeChecks(raw.finalChecks, "finalChecks", errors),
    allowedPaths: asStringArray(raw.allowedPaths, "allowedPaths", errors).map(normalizePath),
    deniedPaths: asStringArray(raw.deniedPaths, "deniedPaths", errors).map(normalizePath),
    maxFilesChanged: Number(raw.maxFilesChanged),
    maxLinesChanged: Number(raw.maxLinesChanged),
    maxIterations: Number(raw.maxIterations),
    allowDependencyChanges: raw.allowDependencyChanges,
    forbidBinaryFiles: raw.forbidBinaryFiles,
    scanSecrets: raw.scanSecrets,
  };
  for (const field of ["minDelta", "maxFilesChanged", "maxLinesChanged", "maxIterations"]) {
    if (!Number.isFinite(config[field]) || config[field] < (field === "minDelta" ? 0 : 1)) {
      errors.push(`${field} must be ${field === "minDelta" ? "zero or greater" : "a positive number"}`);
    }
  }
  for (const field of ["allowDependencyChanges", "forbidBinaryFiles", "scanSecrets"]) {
    if (typeof config[field] !== "boolean") errors.push(`${field} must be true or false`);
  }
  if (errors.length) throw new Error(`invalid .fey/improve/gate.json:\n- ${errors.join("\n- ")}`);
  if (!config.finalChecks.length) config.finalChecks = config.requiredChecks;
  return config;
}

function defaultGateFile() {
  return {
    minDelta: DEFAULTS.minDelta,
    protectedCriteria: DEFAULTS.protectedCriteria,
    requiredChecks: DEFAULTS.requiredChecks,
    finalChecks: DEFAULTS.finalChecks,
    allowedPaths: DEFAULTS.allowedPaths,
    deniedPaths: DEFAULTS.deniedPaths,
    maxFilesChanged: DEFAULTS.maxFilesChanged,
    maxLinesChanged: DEFAULTS.maxLinesChanged,
    maxIterations: DEFAULTS.maxIterations,
    allowDependencyChanges: DEFAULTS.allowDependencyChanges,
    forbidBinaryFiles: DEFAULTS.forbidBinaryFiles,
    scanSecrets: DEFAULTS.scanSecrets,
  };
}

function validateDirections(directions) {
  const errors = [];
  if (!Array.isArray(directions) || !directions.length) return ["directions.json must contain at least one direction"];
  const ids = new Set();
  for (let i = 0; i < directions.length; i++) {
    const direction = directions[i];
    if (!direction || typeof direction !== "object" || Array.isArray(direction)) {
      errors.push(`directions[${i}] must be an object`);
      continue;
    }
    const id = String(direction.id || "").trim();
    if (!id) errors.push(`directions[${i}].id is required`);
    else if (ids.has(id)) errors.push(`duplicate direction id "${id}"`);
    ids.add(id);
    if (!String(direction.title || "").trim()) errors.push(`directions[${i}].title is required`);
    if (!String(direction.description || "").trim()) errors.push(`directions[${i}].description is required`);
  }
  return errors;
}

function validateRubric(rubric, directions = []) {
  const errors = [];
  if (!rubric || typeof rubric !== "object" || Array.isArray(rubric)) return ["rubric.json must contain an object"];
  const criteria = rubric.criteria;
  if (!Array.isArray(criteria) || !criteria.length) return ["rubric.json must contain at least one criterion"];
  if (criteria.length > 20) errors.push("rubric.json may contain at most 20 criteria");
  const directionIds = new Set((directions || []).map((d) => d && d.id).filter(Boolean));
  const ids = new Set();
  for (let i = 0; i < criteria.length; i++) {
    const criterion = criteria[i];
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
      errors.push(`criteria[${i}] must be an object`);
      continue;
    }
    const id = String(criterion.id || "").trim();
    const weight = Number(criterion.weight);
    const max = criterion.max == null ? 10 : Number(criterion.max);
    if (!id) errors.push(`criteria[${i}].id is required`);
    else if (ids.has(id)) errors.push(`duplicate criterion id "${id}"`);
    ids.add(id);
    if (!String(criterion.title || "").trim()) errors.push(`criteria[${i}].title is required`);
    if (!Number.isFinite(weight) || weight <= 0) errors.push(`criterion "${id || i}" must have a positive weight`);
    if (!Number.isFinite(max) || max <= 0) errors.push(`criterion "${id || i}" must have a positive max`);
    if (criterion.protected != null && typeof criterion.protected !== "boolean") {
      errors.push(`criterion "${id || i}".protected must be true or false`);
    }
    if (criterion.direction && directionIds.size && !directionIds.has(criterion.direction)) {
      errors.push(`criterion "${id || i}" references unknown direction "${criterion.direction}"`);
    }
  }
  return errors;
}

function normalizeScoreValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { score: Number(value.score), note: value.note == null ? "" : String(value.note) };
  }
  return { score: Number(value), note: "" };
}

function validateScores(rubric, rawScores) {
  const errors = [];
  if (!rawScores || typeof rawScores !== "object" || Array.isArray(rawScores)) {
    return ["scores file must contain an object keyed by criterion id"];
  }
  const criteria = rubric.criteria || [];
  const ids = new Set(criteria.map((criterion) => criterion.id));
  for (const criterion of criteria) {
    if (!Object.prototype.hasOwnProperty.call(rawScores, criterion.id)) {
      errors.push(`missing score for criterion "${criterion.id}"`);
      continue;
    }
    const normalized = normalizeScoreValue(rawScores[criterion.id]);
    const max = criterion.max == null ? 10 : Number(criterion.max);
    if (!Number.isFinite(normalized.score)) errors.push(`score for "${criterion.id}" must be a number`);
    else if (normalized.score < 0 || normalized.score > max) {
      errors.push(`score for "${criterion.id}" must be between 0 and ${max}`);
    }
  }
  for (const id of Object.keys(rawScores)) {
    if (!ids.has(id)) errors.push(`scores file contains unknown criterion "${id}"`);
  }
  return errors;
}

function splitNull(value) {
  return String(value || "").split("\0").filter(Boolean);
}

function listUntracked(repoRoot) {
  return splitNull(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .map(normalizePath)
    .filter((rel) => !isRuntimePath(rel));
}

function trackedChangedFiles(repoRoot) {
  return splitNull(git(repoRoot, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--", ".", ":(exclude).fey"]))
    .map(normalizePath)
    .filter((rel) => !isRuntimePath(rel));
}

function isBinaryBuffer(buffer) {
  const length = Math.min(buffer.length, 8192);
  for (let i = 0; i < length; i++) if (buffer[i] === 0) return true;
  return false;
}

function countLines(buffer) {
  if (!buffer.length) return 0;
  let lines = 1;
  for (const byte of buffer) if (byte === 10) lines++;
  return lines;
}

function collectChanges(repoRoot) {
  const untracked = listUntracked(repoRoot);
  const tracked = trackedChangedFiles(repoRoot);
  const files = [...new Set([...tracked, ...untracked])].sort();
  const stats = new Map();
  const numstat = git(repoRoot, ["diff", "--no-renames", "--numstat", "HEAD", "--", ".", ":(exclude).fey"]);
  for (const line of numstat.split(/\r?\n/)) {
    if (!line) continue;
    const [addedRaw, removedRaw, ...pathParts] = line.split("\t");
    const rel = normalizePath(pathParts.join("\t"));
    const binary = addedRaw === "-" || removedRaw === "-";
    stats.set(rel, {
      path: rel,
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary,
      untracked: false,
    });
  }
  for (const rel of untracked) {
    const absolute = path.join(repoRoot, ...rel.split("/"));
    let buffer = Buffer.alloc(0);
    let binary = false;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) buffer = Buffer.from(fs.readlinkSync(absolute));
      else buffer = fs.readFileSync(absolute);
      binary = isBinaryBuffer(buffer);
    } catch {
      binary = false;
    }
    stats.set(rel, {
      path: rel,
      added: binary ? 0 : countLines(buffer),
      removed: 0,
      binary,
      untracked: true,
    });
  }
  const entries = files.map((rel) => stats.get(rel) || {
    path: rel,
    added: 0,
    removed: 0,
    binary: false,
    untracked: untracked.includes(rel),
  });
  return {
    files,
    entries,
    fileCount: files.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0),
    removed: entries.reduce((sum, entry) => sum + entry.removed, 0),
    lineCount: entries.reduce((sum, entry) => sum + entry.added + entry.removed, 0),
    binaryFiles: entries.filter((entry) => entry.binary).map((entry) => entry.path),
    untracked,
  };
}

function globToRegExp(glob) {
  const normalized = normalizePath(glob);
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function matchesAny(rel, globs) {
  return globs.some((glob) => globToRegExp(glob).test(normalizePath(rel)));
}

function isDependencyFile(rel) {
  const normalized = normalizePath(rel).toLowerCase();
  const base = path.posix.basename(normalized);
  return DEPENDENCY_FILES.has(base) ||
    /^requirements(?:[._-].+)?\.txt$/.test(base) ||
    /^packages\.lock\.json$/.test(base) ||
    /^directory\.packages\.props$/.test(base);
}

function scanAddedContent(repoRoot, untracked) {
  const findings = [];
  let currentFile = null;
  const diff = git(repoRoot, ["diff", "--no-renames", "--no-ext-diff", "--no-color", "--unified=0", "HEAD", "--", ".", ":(exclude).fey"]);
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = normalizePath(line.slice(6));
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(line.slice(1))) findings.push({ path: currentFile || "tracked diff", type: pattern.name });
    }
  }
  for (const rel of untracked) {
    const absolute = path.join(repoRoot, ...rel.split("/"));
    let text;
    try {
      const buffer = fs.readFileSync(absolute);
      if (isBinaryBuffer(buffer)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(text)) findings.push({ path: rel, type: pattern.name });
    }
  }
  return findings;
}

function stateFingerprint(repoRoot) {
  const hash = crypto.createHash("sha256");
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  hash.update(`head:${head}\n`);
  hash.update(git(repoRoot, ["diff", "--no-renames", "--binary", "HEAD", "--", ".", ":(exclude).fey"], { encoding: null }));
  for (const rel of listUntracked(repoRoot).sort()) {
    hash.update(`\nuntracked:${rel}\n`);
    const absolute = path.join(repoRoot, ...rel.split("/"));
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) hash.update(`symlink:${fs.readlinkSync(absolute)}`);
      else hash.update(fs.readFileSync(absolute));
    } catch {
      hash.update("<missing>");
    }
  }
  return { head, fingerprint: hash.digest("hex") };
}

function tail(value, max = 2000) {
  const text = String(value || "").trim();
  return text.length <= max ? text : text.slice(text.length - max);
}

function runChecks(repoRoot, checks) {
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    let displayCommand = check.command || check.powershell || check.bash || "";
    try {
      const options = {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: check.timeoutSec * 1000,
        windowsHide: true,
      };
      let stdout;
      if (process.platform === "win32" && check.powershell) {
        displayCommand = check.powershell;
        stdout = execFileSync("pwsh", ["-NoProfile", "-Command", check.powershell], options);
      } else if (process.platform !== "win32" && check.bash) {
        displayCommand = check.bash;
        stdout = execFileSync("bash", ["-lc", check.bash], options);
      } else if (check.command) {
        displayCommand = check.command;
        stdout = execSync(check.command, options);
      } else {
        throw new Error(`check "${check.name}" has no command for ${process.platform}`);
      }
      results.push({
        name: check.name,
        command: displayCommand,
        pass: true,
        exitCode: 0,
        durationMs: Date.now() - started,
        output: tail(stdout),
      });
    } catch (error) {
      const timedOut = error && (error.code === "ETIMEDOUT" || error.signal === "SIGTERM");
      results.push({
        name: check.name,
        command: displayCommand,
        pass: false,
        exitCode: Number.isInteger(error && error.status) ? error.status : null,
        timedOut,
        durationMs: Date.now() - started,
        output: tail(`${error && error.stdout ? error.stdout : ""}\n${error && error.stderr ? error.stderr : ""}`),
      });
    }
  }
  return results;
}

function loadState(repoRoot, { requireRubric = true } = {}) {
  const errors = [];
  if (!fs.existsSync(repoRoot)) errors.push(`repository path does not exist: ${repoRoot}`);
  if (!isGitRepo(repoRoot)) errors.push("target is not a git repository");
  const improveDir = path.join(repoRoot, IMPROVE_DIR);
  let run = null;
  let directions = [];
  let rubric = null;
  let history = [];
  let config = null;
  if (!errors.length) {
    try { run = readJsonFile(path.join(improveDir, "run.json")); } catch (error) { errors.push(error.message); }
    try { directions = readJsonFile(path.join(improveDir, "directions.json"), []); } catch (error) { errors.push(error.message); }
    try { rubric = readJsonFile(path.join(improveDir, "rubric.json"), null); } catch (error) { errors.push(error.message); }
    try { history = readJsonFile(path.join(improveDir, "history.json"), []); } catch (error) { errors.push(error.message); }
    try { config = loadGateConfig(repoRoot); } catch (error) { errors.push(error.message); }
  }
  if (run) {
    if (run.version !== 1) errors.push(`unsupported run.json version ${run.version}`);
    if (!run.target || !["codebase", "diff"].includes(run.target)) errors.push("run.json target must be codebase or diff");
    if (run.worktreePath && path.resolve(run.worktreePath) !== path.resolve(repoRoot)) {
      errors.push(`this run belongs to worktree ${run.worktreePath}, not ${repoRoot}`);
    }
    const branch = currentBranch(repoRoot);
    if (run.workBranch && branch && branch !== run.workBranch) {
      errors.push(`current branch is "${branch}", but the run expects "${run.workBranch}"`);
    }
  }
  if (!Array.isArray(history)) errors.push("history.json must contain an array");
  if (requireRubric) {
    errors.push(...validateDirections(directions));
    errors.push(...validateRubric(rubric, directions));
    if (rubric && Array.isArray(rubric.criteria) && config) {
      const criterionIds = new Set(rubric.criteria.map((criterion) => criterion && criterion.id).filter(Boolean));
      const unknownProtected = config.protectedCriteria.filter((id) => !criterionIds.has(id));
      if (unknownProtected.length) errors.push(`protectedCriteria references unknown criteria: ${unknownProtected.join(", ")}`);
    }
  }
  return { pass: errors.length === 0, errors, run, directions, rubric, history, config };
}

function formatReport(title, pass, lines = []) {
  return [`${title}: ${pass ? "PASSED" : "FAILED"}`, ...lines].join("\n");
}

function evaluatePreflight(repoRoot, options = {}) {
  const state = loadState(repoRoot, options);
  const lines = [];
  if (state.errors.length) {
    lines.push("", ...state.errors.map((error) => `- ${error}`));
  } else {
    const candidates = state.history.filter((iteration) => !iteration.baseline);
    if (candidates.length > state.config.maxIterations) {
      state.errors.push(`history has ${candidates.length} candidate iterations; configured maximum is ${state.config.maxIterations}`);
    }
    lines.push(`worktree: ${repoRoot}`);
    lines.push(`branch: ${currentBranch(repoRoot) || "unknown"}`);
    lines.push(`status: ${state.run.status || "unknown"}`);
    lines.push(`iterations: ${state.history.length}`);
    lines.push(`required checks: ${state.config.requiredChecks.length}`);
  }
  state.pass = state.errors.length === 0;
  state.report = formatReport("fey-improve preflight", state.pass, state.pass ? lines : ["", ...state.errors.map((error) => `- ${error}`)]);
  return state;
}

function evaluateCandidate(repoRoot, { baseline = false, runObjectiveChecks = true } = {}) {
  const state = evaluatePreflight(repoRoot, { requireRubric: true });
  const errors = [...state.errors];
  let changes = { files: [], entries: [], fileCount: 0, added: 0, removed: 0, lineCount: 0, binaryFiles: [], untracked: [] };
  let checks = [];
  let fingerprint = null;
  let rubricHash = null;
  let gateHash = null;
  let directionsHash = null;
  if (!errors.length) {
    const baselines = state.history.filter((iteration) => iteration.baseline);
    const candidates = state.history.filter((iteration) => !iteration.baseline);
    if (baseline && candidates.length) errors.push("cannot replace the baseline after candidate iterations exist");
    if (!baseline && baselines.length !== 1) errors.push("record exactly one baseline before evaluating a candidate");
    if (!baseline && candidates.length >= state.config.maxIterations && !candidates.some((iteration) => iteration.kept == null)) {
      errors.push(`maximum candidate iterations reached (${state.config.maxIterations})`);
    }
    changes = collectChanges(repoRoot);
    if (baseline && changes.fileCount) {
      errors.push(`baseline must have no code changes; found ${changes.fileCount} changed file(s)`);
    }
    if (!baseline && !changes.fileCount) errors.push("candidate has no code changes");
    if (changes.fileCount > state.config.maxFilesChanged) {
      errors.push(`candidate changes ${changes.fileCount} files; maximum is ${state.config.maxFilesChanged}`);
    }
    if (changes.lineCount > state.config.maxLinesChanged) {
      errors.push(`candidate changes ${changes.lineCount} lines; maximum is ${state.config.maxLinesChanged}`);
    }
    if (state.config.allowedPaths.length) {
      const outside = changes.files.filter((rel) => !matchesAny(rel, state.config.allowedPaths));
      if (outside.length) errors.push(`files outside allowedPaths: ${outside.join(", ")}`);
    }
    if (state.config.deniedPaths.length) {
      const denied = changes.files.filter((rel) => matchesAny(rel, state.config.deniedPaths));
      if (denied.length) errors.push(`files matched deniedPaths: ${denied.join(", ")}`);
    }
    if (!state.config.allowDependencyChanges) {
      const dependencies = changes.files.filter(isDependencyFile);
      if (dependencies.length) errors.push(`dependency manifests or lockfiles changed without opt-in: ${dependencies.join(", ")}`);
    }
    if (state.config.forbidBinaryFiles && changes.binaryFiles.length) {
      errors.push(`binary files are not allowed in an improvement step: ${changes.binaryFiles.join(", ")}`);
    }
    if (state.config.scanSecrets) {
      const findings = scanAddedContent(repoRoot, changes.untracked);
      if (findings.length) {
        errors.push(`possible secret material detected: ${findings.map((finding) => `${finding.type} in ${finding.path}`).join(", ")}`);
      }
    }
    if (runObjectiveChecks) {
      checks = runChecks(repoRoot, state.config.requiredChecks);
      const failed = checks.filter((check) => !check.pass);
      if (failed.length) errors.push(`required checks failed: ${failed.map((check) => check.name).join(", ")}`);
    }
    fingerprint = stateFingerprint(repoRoot);
    rubricHash = hashObject(state.rubric);
    gateHash = hashObject(state.config);
    directionsHash = hashObject(state.directions);
    if (!baseline) {
      const baselineIteration = baselines[0];
      const baselineEvaluation = baselineIteration && baselineIteration.evaluation;
      if (!baselineEvaluation) {
        errors.push("baseline has no bound evaluation evidence; record the baseline again");
      } else {
        if (baselineEvaluation.rubricHash !== rubricHash) errors.push("rubric changed after baseline; start a new run or replace the baseline before evaluating candidates");
        if (baselineEvaluation.gateHash !== gateHash) errors.push("gate configuration changed after baseline; start a new run or replace the baseline before evaluating candidates");
        if (baselineEvaluation.directionsHash && baselineEvaluation.directionsHash !== directionsHash) {
          errors.push("directions changed after baseline; start a new run or replace the baseline before evaluating candidates");
        }
      }
    }
  }
  const pass = errors.length === 0;
  const lines = [
    `mode: ${baseline ? "baseline" : "candidate"}`,
    `files: ${changes.fileCount}`,
    `lines: +${changes.added}/-${changes.removed}`,
  ];
  for (const check of checks) {
    lines.push(`check ${check.name}: ${check.pass ? "PASS" : "FAIL"} (${check.durationMs}ms)`);
    if (!check.pass && check.output) lines.push(`  ${check.output.replace(/\r?\n/g, "\n  ")}`);
  }
  if (errors.length) lines.push("", ...errors.map((error) => `- ${error}`));
  return {
    ...state,
    pass,
    errors,
    changes,
    checks,
    fingerprint: fingerprint && fingerprint.fingerprint,
    headSha: fingerprint && fingerprint.head,
    rubricHash,
    gateHash,
    directionsHash,
    report: formatReport("fey-improve candidate gate", pass, lines),
  };
}

function protectedCriterionIds(config, rubric) {
  const ids = new Set(config.protectedCriteria);
  for (const criterion of rubric.criteria || []) if (criterion.protected) ids.add(criterion.id);
  return [...ids];
}

function evaluateAcceptance(repoRoot, latest, priorBest) {
  const candidate = evaluateCandidate(repoRoot, { baseline: false, runObjectiveChecks: false });
  const errors = [...candidate.errors];
  if (!latest || latest.baseline) errors.push("no pending candidate iteration to accept");
  if (latest && latest.kept !== null) errors.push(`iteration ${latest.n} has already been decided`);
  if (latest && candidate.fingerprint && latest.evaluation) {
    if (latest.evaluation.fingerprint !== candidate.fingerprint) {
      errors.push("working tree changed after evaluation; record the candidate again before committing");
    }
    if (latest.evaluation.rubricHash !== candidate.rubricHash) {
      errors.push("rubric changed after evaluation; record the candidate again");
    }
    if (latest.evaluation.gateHash !== candidate.gateHash) {
      errors.push("gate configuration changed after evaluation; record the candidate again");
    }
    if (latest.evaluation.directionsHash && latest.evaluation.directionsHash !== candidate.directionsHash) {
      errors.push("directions changed after evaluation; record the candidate again");
    }
    const failedRecorded = (latest.evaluation.checks || []).filter((check) => !check.pass);
    if (failedRecorded.length) errors.push(`recorded objective checks failed: ${failedRecorded.map((check) => check.name).join(", ")}`);
  } else if (latest) {
    errors.push("iteration has no bound evaluation evidence; record it again with the current fey-improve version");
  }
  if (latest && candidate.rubric) {
    const recomputed = S.scoreIteration(candidate.rubric, latest.scores).total;
    if (recomputed !== latest.total) errors.push(`stored total ${latest.total} does not match recomputed total ${recomputed}`);
  }
  if (priorBest && candidate.rubric) {
    const recomputed = S.scoreIteration(candidate.rubric, priorBest.scores).total;
    if (recomputed !== priorBest.total) errors.push(`previous best total ${priorBest.total} does not match recomputed total ${recomputed}`);
  }
  if (latest && priorBest) {
    const delta = Math.round((latest.total - priorBest.total) * 10) / 10;
    if (delta < candidate.config.minDelta) {
      errors.push(`score delta ${delta} is below required minimum ${candidate.config.minDelta}`);
    }
    for (const id of protectedCriterionIds(candidate.config, candidate.rubric)) {
      const before = priorBest.scores && priorBest.scores[id] ? Number(priorBest.scores[id].score) : NaN;
      const after = latest.scores && latest.scores[id] ? Number(latest.scores[id].score) : NaN;
      if (Number.isFinite(before) && Number.isFinite(after) && after < before) {
        errors.push(`protected criterion "${id}" regressed from ${before} to ${after}`);
      }
    }
  }
  const pass = errors.length === 0;
  return {
    ...candidate,
    pass,
    errors,
    report: formatReport(
      "fey-improve acceptance gate",
      pass,
      errors.length ? ["", ...errors.map((error) => `- ${error}`)] : [
        `score: ${latest ? latest.total : "n/a"}`,
        `previous best: ${priorBest ? priorBest.total : "n/a"}`,
        `minimum delta: ${candidate.config ? candidate.config.minDelta : "n/a"}`,
      ]
    ),
  };
}

function codeTreeClean(repoRoot) {
  return collectChanges(repoRoot).fileCount === 0;
}

function evaluateStop(repoRoot) {
  const state = evaluatePreflight(repoRoot, { requireRubric: false });
  const errors = [...state.errors];
  let changes = { fileCount: 0, files: [] };
  if (!errors.length) {
    changes = collectChanges(repoRoot);
    if (changes.fileCount) errors.push(`working tree has uncommitted code changes: ${changes.files.join(", ")}`);
    const latest = state.history.length ? state.history.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    if (!state.history.some((iteration) => iteration.baseline)) errors.push("baseline has not been recorded");
    if (latest && latest.kept === null) errors.push(`iteration ${latest.n} is still pending; commit-if-better or revert it`);
    if (!["paused", "done"].includes(state.run.status)) {
      errors.push(`run status is "${state.run.status || "unknown"}"; set it to paused or done before stopping`);
    }
  }
  const pass = errors.length === 0;
  return {
    ...state,
    pass,
    errors,
    changes,
    report: formatReport(
      "fey-improve stop check",
      pass,
      pass
        ? [`status: ${state.run.status}`, "no pending candidate or uncommitted code changes"]
        : ["", ...errors.map((error) => `- ${error}`)]
    ),
  };
}

function evaluateFinalize(repoRoot, { requireDone = true } = {}) {
  const state = evaluatePreflight(repoRoot, { requireRubric: true });
  const errors = [...state.errors];
  let checks = [];
  if (!errors.length) {
    const changes = collectChanges(repoRoot);
    if (changes.fileCount) errors.push(`optimization worktree has uncommitted code changes: ${changes.files.join(", ")}`);
    const latest = state.history.length ? state.history.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    if (latest && latest.kept === null) errors.push(`iteration ${latest.n} is still pending`);
    if (!state.history.some((iteration) => iteration.baseline)) errors.push("baseline has not been recorded");
    if (!state.history.some((iteration) => !iteration.baseline && iteration.kept === true)) {
      errors.push("run has no kept improvement to hand off");
    }
    if (requireDone && state.run.status !== "done") errors.push(`run status must be "done", currently "${state.run.status}"`);
    checks = runChecks(repoRoot, state.config.finalChecks);
    const failed = checks.filter((check) => !check.pass);
    if (failed.length) errors.push(`final checks failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  const pass = errors.length === 0;
  const lines = checks.map((check) => `check ${check.name}: ${check.pass ? "PASS" : "FAIL"} (${check.durationMs}ms)`);
  if (errors.length) lines.push("", ...errors.map((error) => `- ${error}`));
  return {
    ...state,
    pass,
    errors,
    checks,
    report: formatReport("fey-improve handoff gate", pass, lines),
  };
}

function nextIterationNumber(history) {
  if (!history.length) return 0;
  const pending = history.find((iteration) => !iteration.baseline && iteration.kept === null);
  if (pending) return pending.n;
  return Math.max(...history.map((iteration) => iteration.n)) + 1;
}

function validateProposals(repoRoot) {
  const state = evaluatePreflight(repoRoot, { requireRubric: true });
  const errors = [...state.errors];
  const proposals = [];
  let iteration = null;
  if (!errors.length) {
    iteration = nextIterationNumber(state.history);
    const dir = path.join(repoRoot, IMPROVE_DIR, "scratch", `iter-${iteration}`);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`could not read proposal directory: ${error.message}`);
    }
    if (!files.length) errors.push(`no proposal JSON files found in .fey/improve/scratch/iter-${iteration}/`);
    const directionIds = new Set(state.directions.map((direction) => direction.id));
    for (const file of files) {
      let proposal;
      try {
        proposal = readJsonFile(path.join(dir, file));
      } catch (error) {
        errors.push(error.message);
        continue;
      }
      const prefix = `.fey/improve/scratch/iter-${iteration}/${file}`;
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        errors.push(`${prefix} must contain an object`);
        continue;
      }
      if (!directionIds.has(proposal.direction)) errors.push(`${prefix} has unknown direction "${proposal.direction || ""}"`);
      for (const field of ["idea", "detail", "expectedImpact", "risk"]) {
        if (!String(proposal[field] || "").trim()) errors.push(`${prefix}.${field} is required`);
      }
      if (proposal.picked != null && typeof proposal.picked !== "boolean") errors.push(`${prefix}.picked must be true or false`);
      proposals.push(proposal);
    }
  }
  const pass = errors.length === 0;
  return {
    ...state,
    pass,
    errors,
    iteration,
    proposals,
    report: formatReport(
      "fey-improve proposal gate",
      pass,
      pass
        ? [`iteration: ${iteration}`, `valid proposals: ${proposals.length}`]
        : ["", ...errors.map((error) => `- ${error}`)]
    ),
  };
}

function removeUntrackedCode(repoRoot) {
  const removed = [];
  for (const rel of listUntracked(repoRoot)) {
    const absolute = path.resolve(repoRoot, ...rel.split("/"));
    const relative = path.relative(repoRoot, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to remove untracked path outside repository: ${rel}`);
    }
    fs.rmSync(absolute, { force: true });
    removed.push(rel);
    let parent = path.dirname(absolute);
    while (path.resolve(parent) !== path.resolve(repoRoot)) {
      try {
        if (fs.readdirSync(parent).length) break;
        fs.rmdirSync(parent);
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
  }
  return removed;
}

module.exports = {
  DEFAULTS,
  IMPROVE_DIR,
  codeTreeClean,
  collectChanges,
  currentBranch,
  defaultGateFile,
  evaluateAcceptance,
  evaluateCandidate,
  evaluateFinalize,
  evaluatePreflight,
  evaluateStop,
  hashObject,
  isGitRepo,
  isRuntimePath,
  loadGateConfig,
  matchesAny,
  nextIterationNumber,
  normalizePath,
  protectedCriterionIds,
  readJsonFile,
  removeUntrackedCode,
  runChecks,
  stateFingerprint,
  validateDirections,
  validateProposals,
  validateRubric,
  validateScores,
};
