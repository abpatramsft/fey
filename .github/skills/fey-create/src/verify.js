"use strict";
// Claim verification stamps ("Mark reviewed").
//
// A claim (a wiki block) is flagged in Drift only because its anchored code has
// uncommitted changes. When a human reviews the claim and finds the prose still
// holds, they stamp it: we record a hash of the block's anchored code AS IT IS
// NOW into .fey/create/verifications.json. The claim then reads as "Reviewed" and drops
// out of the drift-to-reconcile set — until that code changes AGAIN, at which
// point the hash stops matching and the claim re-surfaces on its own.
//
// This is git-independent (no commit required) and human-editable, matching the
// rest of fey's generate-then-serve philosophy.
//
// Schema:
//   { "version": 1, "verified": { "<blockId>": { "hash": "<contentHash>", "at": "<iso>" } } }
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { makeSpan } = require("./coverage");

function verifyPath(repoRoot) {
  return path.join(repoRoot, ".fey", "create", "verifications.json");
}

function loadVerifications(repoRoot) {
  try {
    const j = JSON.parse(fs.readFileSync(verifyPath(repoRoot), "utf8"));
    return j && j.verified && typeof j.verified === "object" ? { version: 1, verified: j.verified } : { version: 1, verified: {} };
  } catch {
    return { version: 1, verified: {} };
  }
}

function saveVerifications(repoRoot, data) {
  fs.mkdirSync(path.dirname(verifyPath(repoRoot)), { recursive: true });
  fs.writeFileSync(verifyPath(repoRoot), JSON.stringify(data, null, 2));
}

// Hash the CURRENT text of every line range this block is anchored to. If any of
// that code changes, the hash changes — which is exactly when a prior review
// should stop counting.
function blockContentHash(repoRoot, manifest, block) {
  const parts = [];
  for (const spanId of block.anchors) {
    const s = makeSpan(manifest, spanId);
    if (!s) { parts.push(`${spanId}:?`); continue; }
    let slice = "";
    try {
      const lines = fs.readFileSync(path.join(repoRoot, s.file), "utf8").split(/\r?\n/);
      slice = lines.slice(s.startLine - 1, s.endLine).join("\n");
    } catch { slice = ""; }
    parts.push(`${s.file}#${s.startLine}-${s.endLine}\n${slice}`);
  }
  return crypto.createHash("sha1").update(parts.join("\n--\n")).digest("hex").slice(0, 16);
}

function isBlockVerified(repoRoot, manifest, verifData, block) {
  const rec = verifData.verified[block.id];
  if (!rec) return false;
  return rec.hash === blockContentHash(repoRoot, manifest, block);
}

// Stamp or clear a block's review. Returns the updated data.
function setVerified(repoRoot, manifest, block, on) {
  const data = loadVerifications(repoRoot);
  if (on) data.verified[block.id] = { hash: blockContentHash(repoRoot, manifest, block), at: new Date().toISOString() };
  else delete data.verified[block.id];
  saveVerifications(repoRoot, data);
  return data;
}

module.exports = { verifyPath, loadVerifications, saveVerifications, blockContentHash, isBlockVerified, setVerified };
