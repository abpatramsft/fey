"use strict";
// Shared git-diff parsing + stable hunk signatures.
//
// Both the server (Drift view) and the CLI (`fey diff-hunks`, the attribution
// step) parse the working-tree diff the same way here, so a hunk gets the SAME
// signature everywhere. That signature is the key that ties a live diff hunk to a
// cached explanation in .fey/create/drift-notes.json — see driftNotes.js.
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Drift never wants to talk about fey's own bundle or CI config, so these path
// prefixes are dropped from BOTH tracked changes and net-new files.
const EXCLUDE_PREFIXES = [".github/", ".fey/"];
function isExcluded(file) {
  const f = file.replace(/\\/g, "/");
  return EXCLUDE_PREFIXES.some((p) => f === p.slice(0, -1) || f.startsWith(p));
}
// Cap a huge new file so the Drift view never dumps thousands of lines into the DOM.
const MAX_NEW_FILE_LINES = 600;

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function isGitRepo(repoRoot) {
  try {
    git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

// The uncommitted diff against HEAD (falling back to the index/worktree diff in a
// repo with no commits yet).
function rawDiff(repoRoot) {
  try {
    return git(repoRoot, ["diff", "HEAD", "--unified=3", "--no-color"]);
  } catch {
    try {
      return git(repoRoot, ["diff", "--unified=3", "--no-color"]);
    } catch {
      return "";
    }
  }
}

function parseDiff(raw) {
  const files = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      cur = { file: null, hunks: [] };
      files.push(cur);
    } else if (line.startsWith("+++ b/")) {
      if (cur) cur.file = line.slice(6);
    } else if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (cur && m) {
        cur.hunks.push({ newStart: +m[3], newCount: m[4] ? +m[4] : 1, lines: [], _old: +m[1], _new: +m[3] });
      }
    } else if (cur && cur.hunks.length) {
      const h = cur.hunks[cur.hunks.length - 1];
      const sign = line[0];
      if (sign === "+") h.lines.push({ sign: "+", newNo: h._new++, text: line.slice(1) });
      else if (sign === "-") h.lines.push({ sign: "-", oldNo: h._old++, text: line.slice(1) });
      else if (sign === " ") h.lines.push({ sign: " ", oldNo: h._old++, newNo: h._new++, text: line.slice(1) });
    }
  }
  return files.filter((f) => f.file && f.hunks.length);
}

// A stable id for a hunk that survives line-number shifts: it hashes the file
// path plus the ADDED lines' text (trailing whitespace trimmed). If the added
// code changes, the signature changes — which is correct, because the rationale
// was about that specific code. Removals-only hunks hash their removed text so
// pure deletions are still attributable.
function hunkSignature(file, hunk) {
  const added = hunk.lines.filter((l) => l.sign === "+").map((l) => l.text.replace(/\s+$/, ""));
  const basis = added.length
    ? added.join("\n")
    : hunk.lines.filter((l) => l.sign === "-").map((l) => l.text.replace(/\s+$/, "")).join("\n");
  return crypto.createHash("sha1").update(file + "\n" + basis).digest("hex").slice(0, 16);
}

// Net-new files that are ready to be committed: untracked and NOT gitignored
// (`--exclude-standard` honours .gitignore / .git/info/exclude). Paths come back
// repo-relative with forward slashes, matching parseDiff's `+++ b/<path>`.
function untrackedFiles(repoRoot) {
  try {
    return git(repoRoot, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Synthesize a "new file" diff entry: every line is an addition, starting at 1.
// This is how a brand-new file shows up in Drift without the user having to
// `git add -N` it first. Binary files are skipped; very large files are capped.
function newFileEntry(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.includes(0)) return null; // binary — nothing useful to show
  let rawLines = buf.toString("utf8").split("\n");
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  let truncated = false;
  if (rawLines.length > MAX_NEW_FILE_LINES) {
    rawLines = rawLines.slice(0, MAX_NEW_FILE_LINES);
    truncated = true;
  }
  const lines = rawLines.map((t, i) => ({ sign: "+", newNo: i + 1, text: t }));
  if (truncated) {
    lines.push({ sign: " ", newNo: rawLines.length + 1, text: `… (new file truncated at ${MAX_NEW_FILE_LINES} lines in Drift view)` });
  }
  return { file: relPath, isNew: true, hunks: [{ newStart: 1, newCount: lines.length, lines, _old: 0, _new: lines.length + 1 }] };
}

// The full working-tree change set fey cares about: tracked changes vs HEAD PLUS
// net-new (untracked, non-ignored) files, with .github/ and .fey/ filtered out of
// both. Single source of truth for the server (Drift view) and the CLI.
function collectDiff(repoRoot) {
  const tracked = parseDiff(rawDiff(repoRoot)).filter((f) => !isExcluded(f.file));
  const created = untrackedFiles(repoRoot)
    .filter((f) => !isExcluded(f))
    .map((f) => newFileEntry(repoRoot, f))
    .filter(Boolean);
  return [...tracked, ...created];
}

// Parse the current change set into a flat list of hunks with signatures. Used by
// the CLI attribution step and re-used by the server.
function diffHunks(repoRoot) {
  if (!isGitRepo(repoRoot)) return { isRepo: false, hasDiff: false, files: [] };
  const files = collectDiff(repoRoot).map((f) => ({
    file: f.file,
    isNew: !!f.isNew,
    hunks: f.hunks.map((h) => ({
      sig: hunkSignature(f.file, h),
      newStart: h.newStart,
      newCount: h.newCount,
      added: h.lines.filter((l) => l.sign === "+").length,
      removed: h.lines.filter((l) => l.sign === "-").length,
      lines: h.lines,
    })),
  }));
  return { isRepo: true, hasDiff: files.length > 0, files };
}

module.exports = { isGitRepo, rawDiff, parseDiff, hunkSignature, collectDiff, diffHunks, untrackedFiles, isExcluded };
