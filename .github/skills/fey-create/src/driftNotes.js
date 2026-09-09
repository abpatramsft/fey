"use strict";
// Drift attribution notes.
//
// `.fey/create/drift-notes.json` is a cache that answers "WHY did this change, and was it
// AI or human?" for each diff hunk. It is authored by the fey skill (which can
// query the conversation history via the session store) and merely SERVED by the
// server — the same generate-then-serve split as the rest of fey. Authoring it is a
// REQUIRED part of every create run: without a note per live hunk the Drift view
// renders changes as "Unattributed", and the agentStop drift-gate blocks the stop
// (see `fey drift-gate` / `fey stop-check`). Notes are keyed by the hunk SIGNATURE
// (see gitdiff.js), so they attach to the live diff as long as that change exists
// and quietly stop matching once the code changes again.
//
// Schema:
//   {
//     "version": 1,
//     "flows": [                          // optional: the logical grouping of the diff
//       {
//         "id": "lifecycle-events",       // stable slug
//         "title": "Complete the order lifecycle event stream",
//         "summary": "One or two sentences narrating what this cluster of changes does.",
//         "changeSets": ["Order lifecycle events"]  // note.changeSet labels that belong here
//       }
//     ],
//     "notes": {
//       "<hunkSig>": {
//         "file": "orders/service.py",
//         "author": "ai" | "human" | "unknown",
//         "rationale": "One or two sentences: why this change was made.",
//         "aiIntent": "The agent's stated intent (present when author === 'ai').",
//         "confidence": "high" | "medium" | "low",
//         "sessionId": "3c9c5c…",       // source conversation (optional)
//         "turn": 21,                     // source turn index (optional)
//         "changeSet": "Add map-reduce"   // overarching intent shared by sibling hunks (optional)
//       }
//     }
//   }
//
// `flows` is optional. When present, it lets the skill name and describe each
// cluster of related hunks; the server joins a hunk to a flow via its
// `changeSet` label. When absent, the server synthesizes one flow per distinct
// changeSet label (plus an "Other changes" bucket), so the Drift view is always
// flow-organized.
const fs = require("fs");
const path = require("path");

function notesPath(repoRoot) {
  return path.join(repoRoot, ".fey", "create", "drift-notes.json");
}

function loadDriftNotes(repoRoot) {
  const p = notesPath(repoRoot);
  if (!fs.existsSync(p)) return { notes: {}, flows: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      notes: j && j.notes && typeof j.notes === "object" ? j.notes : {},
      flows: normalizeFlows(j && j.flows),
    };
  } catch {
    return { notes: {}, flows: [] };
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "flow";
}

// Normalize the optional, skill-authored `flows` array. Each flow declares which
// changeSet labels it owns; bad entries are dropped rather than trusted blindly.
function normalizeFlows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const title = typeof f.title === "string" ? f.title.trim() : "";
    if (!title) continue;
    let id = typeof f.id === "string" && f.id.trim() ? slug(f.id) : slug(title);
    while (seen.has(id)) id += "-x";
    seen.add(id);
    const changeSets = Array.isArray(f.changeSets)
      ? f.changeSets.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim())
      : [];
    out.push({ id, title, summary: typeof f.summary === "string" ? f.summary.trim() : "", changeSets });
  }
  return out;
}

// Look up the note for one hunk signature, normalizing the author field so the
// UI can rely on it.
function noteFor(notes, sig) {
  const n = notes[sig];
  if (!n) return null;
  const author = n.author === "ai" || n.author === "human" ? n.author : "unknown";
  return {
    author,
    rationale: typeof n.rationale === "string" ? n.rationale : "",
    aiIntent: typeof n.aiIntent === "string" ? n.aiIntent : "",
    confidence: ["high", "medium", "low"].includes(n.confidence) ? n.confidence : "low",
    sessionId: typeof n.sessionId === "string" ? n.sessionId : "",
    turn: Number.isInteger(n.turn) ? n.turn : null,
    changeSet: typeof n.changeSet === "string" ? n.changeSet : "",
  };
}

module.exports = { notesPath, loadDriftNotes, noteFor, slug };
