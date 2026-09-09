"use strict";
// Per-page memory notes.
//
// When a human reviews a wiki page they can confirm it or flag what's wrong. Both
// land in .fey/create/page-notes.json as a small, append-only memory for that page — a
// running record of "what a reader found off here" that the fey skill can read on
// the next regeneration.
//
// Schema:
//   { "version": 1, "pages": { "<pageId>": [ { "type": "flag"|"confirm", "text": "...", "at": "<iso>" } ] } }
const fs = require("fs");
const path = require("path");

function notesPath(repoRoot) {
  return path.join(repoRoot, ".fey", "create", "page-notes.json");
}

function loadPageNotes(repoRoot) {
  try {
    const j = JSON.parse(fs.readFileSync(notesPath(repoRoot), "utf8"));
    return j && j.pages && typeof j.pages === "object" ? { version: 1, pages: j.pages } : { version: 1, pages: {} };
  } catch {
    return { version: 1, pages: {} };
  }
}

function savePageNotes(repoRoot, data) {
  fs.mkdirSync(path.dirname(notesPath(repoRoot)), { recursive: true });
  fs.writeFileSync(notesPath(repoRoot), JSON.stringify(data, null, 2));
}

function notesFor(repoRoot, pageId) {
  return loadPageNotes(repoRoot).pages[pageId] || [];
}

function addNote(repoRoot, pageId, type, text) {
  const data = loadPageNotes(repoRoot);
  const list = (data.pages[pageId] = data.pages[pageId] || []);
  list.push({ type: type === "confirm" ? "confirm" : "flag", text: String(text || "").slice(0, 2000), at: new Date().toISOString() });
  savePageNotes(repoRoot, data);
  return list;
}

module.exports = { notesPath, loadPageNotes, savePageNotes, notesFor, addNote };
