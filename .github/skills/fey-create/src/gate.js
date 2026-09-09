"use strict";
// Coverage-gate config. Lives at <repo>/.fey/create/gate.json and is read by the
// `fey gate` command (and the agentStop hook). All fields optional; defaults
// below apply when the file is absent.
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  minTotalCoverage: 90, // whole-repo % of lines that must be anchored
  minFileCoverage: 80,  // every non-excluded file must reach this %
  exclude: [],          // glob-ish paths to skip in the per-file check
};

// Minimal glob matcher: `**` -> any chars, `*` -> any chars except "/".
function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function loadGateConfig(repoRoot) {
  const p = path.join(repoRoot, ".fey", "create", "gate.json");
  let user = {};
  if (fs.existsSync(p)) {
    try { user = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { throw new Error(`invalid .fey/create/gate.json: ${e.message}`); }
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.exclude = Array.isArray(cfg.exclude) ? cfg.exclude : [];
  const matchers = cfg.exclude.map(globToRe);
  cfg.isExcluded = (rel) => matchers.some((re) => re.test(rel));
  return cfg;
}

module.exports = { loadGateConfig, DEFAULTS };
