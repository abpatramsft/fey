"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { computeCoverage, makeSpan } = require("../src/coverage");
const { validateDiagram } = require("../src/diagrams");
const { indexFile } = require("../src/indexer");
const { copilotAskArgs } = require("../src/server");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sampleManifest(anchor) {
  return {
    version: 1,
    spans: {
      "src/sample.js#run": {
        id: "src/sample.js#run",
        file: "src/sample.js",
        symbol: "run",
        kind: "function",
        startLine: 1,
        endLine: 3,
        hash: "test",
      },
    },
    pages: [{
      id: "overview",
      title: "Overview",
      md: ".fey/create/pages/overview.md",
      blocks: [{ id: "claim", anchors: [anchor] }],
    }],
  };
}

test("line-range anchors must resolve inside current repository bounds", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fey-anchor-test-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(path.join(repo, "src", "sample.js"), "function run() {\n  return true;\n}\n");

  const manifest = sampleManifest("src/sample.js#L1-2");
  assert.ok(makeSpan(repo, manifest, "src/sample.js#run"));
  assert.ok(makeSpan(repo, manifest, "src/sample.js#L1-2"));
  assert.equal(makeSpan(repo, manifest, "src/sample.js#L1-9999"), null);
  assert.equal(makeSpan(repo, manifest, "src/sample.js#L3-2"), null);
  assert.equal(makeSpan(repo, manifest, "missing.js#L1-2"), null);
  assert.equal(makeSpan(repo, manifest, "../outside.js#L1-2"), null);
});

test("coverage and diagram validation reject invented line ranges", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fey-anchor-gate-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(path.join(repo, "src", "sample.js"), "function run() {\n  return true;\n}\n");
  const manifest = sampleManifest("src/sample.js#L1-9999");

  const coverage = computeCoverage(repo, manifest);
  assert.equal(coverage.totalPct, 0);
  assert.deepEqual(coverage.invalidAnchors, [{
    pageId: "overview",
    blockId: "claim",
    spanId: "src/sample.js#L1-9999",
  }]);

  const diagram = {
    id: "run",
    entry: "run",
    title: "Run",
    kind: "main",
    lanes: [{ id: "app", label: "App" }],
    nodes: [{
      id: "root",
      name: "run",
      lane: "app",
      parent: null,
      order: 0,
      anchor: "missing.js#L1-9999",
    }],
  };
  const validated = validateDiagram(diagram, manifest, "run", repo);
  assert.match(validated.errors.join("\n"), /does not resolve/);
});

test("coverage gate fails invalid one-pass manifest anchors", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fey-anchor-cli-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(path.join(repo, "src", "sample.js"), "function run() {\n  return true;\n}\n");
  write(
    path.join(repo, ".fey", "create", "manifest.json"),
    `${JSON.stringify(sampleManifest("src/sample.js#L1-9999"), null, 2)}\n`
  );
  write(
    path.join(repo, ".fey", "create", "gate.json"),
    `${JSON.stringify({ minTotalCoverage: 0, minFileCoverage: 0, exclude: [] }, null, 2)}\n`
  );
  const cli = path.resolve(__dirname, "..", "bin", "fey.js");
  const result = spawnSync(process.execPath, [cli, "gate", repo], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Invalid page anchors/);
});

test("Ask exposes only local read and search tools", () => {
  const args = copilotAskArgs("C:\\repo");
  assert.equal(args.includes("--allow-all"), false);
  assert.deepEqual(args.slice(args.indexOf("--available-tools") + 1, args.indexOf("--allow-all-tools")), ["view", "rg", "glob"]);
  assert.ok(args.includes("--deny-tool=write"));
  assert.ok(args.includes("--deny-tool=shell"));
});

test("JavaScript indexing falls back without the optional TypeScript package", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fey-js-index-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const file = path.join(repo, "sample.js");
  write(file, "function run() {\n  return true;\n}\n");
  const spans = indexFile(file, repo);
  assert.ok(spans.some((span) => span.symbol === "run"));
});
