# Fey production and packaging roadmap

Packaging is intentionally deferred until the improve safety gates have had real-world
use. When packaging begins, use the plan below rather than adding an npm post-install
script that copies files into a user's Copilot configuration.

## Recommended distribution model

Ship Fey primarily as a **GitHub Copilot plugin**, with a companion scoped npm package
for the deterministic command-line tools.

- The plugin is the user-facing product. It bundles `fey-create`, `fey-improve`, hooks,
  and future `fey-*` custom agents in one installable and updateable unit.
- The npm package exposes `fey` and `fey-improve` for direct terminal, CI, and `npx`
  usage.
- Both artifacts are produced from one source tree and carry the same semantic version.
- The plugin includes the runtime needed by its skills. Installing the plugin must not
  require a second npm installation.
- Do not use npm lifecycle scripts to modify `~/.copilot` or a user's repositories.

## Target repository shape

```text
fey/
├── plugin/fey/
│   ├── plugin.json
│   ├── skills/
│   │   ├── fey-create/
│   │   └── fey-improve/
│   ├── agents/
│   ├── hooks/
│   │   └── hooks.json
│   └── runtime/
├── packages/fey-cli/
│   ├── package.json
│   ├── bin/fey.js
│   ├── bin/fey-improve.js
│   └── src/
└── .github/plugin/
    └── marketplace.json
```

Use a scoped npm name such as `@OWNER/fey` and expose both executables:

```json
{
  "bin": {
    "fey": "bin/fey.js",
    "fey-improve": "bin/fey-improve.js"
  }
}
```

## Release phases

1. **Direct GitHub plugin install**
   - Add `plugin.json` and the canonical plugin directory.
   - Support `copilot plugin install OWNER/REPO:plugin/fey`.
   - Verify install, update, disable, enable, and uninstall behavior.
2. **Scoped npm CLI**
   - Publish the shared runtime with `fey` and `fey-improve` binaries.
   - Support `npx @OWNER/fey ...` and optional global installation.
   - Make plugin and npm builds consume the same tested source.
3. **Marketplace distribution**
   - Add `.github/plugin/marketplace.json`.
   - Initially publish through an owned marketplace.
   - Consider submission to `awesome-copilot` or another established marketplace for
     discovery.
4. **Team and enterprise installation**
   - Document declarative plugin pinning through `.github/copilot/settings.json`.
   - Keep repository-level hooks available for Copilot cloud agent environments.
   - Support exact tag or commit-SHA pinning for reproducible installations.
5. **Offline and controlled environments**
   - Attach a versioned plugin archive, npm tarball, checksums, and SBOM to each GitHub
     release.

## Packaging acceptance gates

Before the first public release:

- Add an explicit open-source or commercial license.
- Remove `"private": true` from the publishable package only.
- Add a changelog and semantic-version release policy.
- Validate `plugin.json`, `marketplace.json`, hook JSON, skill frontmatter, and npm
  package contents in CI.
- Run the fey-improve end-to-end fixture on Windows, Linux, and macOS.
- Smoke-test installation from a local path, GitHub repository, marketplace, npm
  tarball, and `npx`.
- Test the supported Node.js versions and use an actively supported LTS as the minimum.
- Publish npm provenance, checksums, and an SBOM.
- Document update, rollback, uninstall, data locations, network behavior, and the
  security implications of installing hooks and executable skills.
- Clearly distinguish traffic initiated by Fey itself from traffic initiated by the
  user's local Copilot CLI.

## Future custom agents

Add agents only when their permissions and responsibilities are meaningfully distinct:

- `fey-improve-scout`: read-only exploration and proposal generation.
- `fey-improve-evaluator`: runs configured checks and records evidence without editing
  production code.
- `fey-improve-adversary`: reviews a candidate for regressions, scope creep, and rubric
  gaming.

The main agent remains responsible for selecting and applying exactly one proposal.
Separating proposal, implementation, and evaluation reduces self-grading bias.
