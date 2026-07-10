# Releasing `@cryptocadet/cli` — node-environment build

**One JS artifact, three installers, all platforms (macOS / Linux / Windows).** There is no
per-platform compiled binary. Every channel sets up a Node runtime and runs the same package:

- **npm** — `npm i -g @cryptocadet/cli` (runs under the user's Node ≥ 22.5).
- **curl** — `install.sh` (macOS/Linux) and `install.ps1` (Windows) bootstrap a private, pinned
  Node (latest v24, SHA256-verified against nodejs.org) under `~/.cryptocadet-cli`, npm-install the
  package there, and drop `cryptocadet`/`ccx` launchers on PATH. Works even with no system Node.
- **brew** — the formula `depends_on "node"` and installs the published npm package into libexec.

The optional native keychain (`@napi-rs/keyring`, N-API so it works on Node 20/22/24) is pulled as
an `optionalDependency` on all three channels — it's the ONLY working secret store on Windows and
the preferred one on macOS/Linux (with `security`/`secret-tool` CLI fallbacks).

## Namespaces (independent — don't conflate)
- **Source + releases + install.sh/ps1:** `thetechjd/cryptocadet-cli` (GitHub).
- **npm:** `@cryptocadet/cli` (the `@cryptocadet` scope on npmjs.com).
- **Homebrew tap:** `thetechjd/homebrew-cryptocadet-cli` → `brew install thetechjd/cryptocadet-cli/cryptocadet`.
- **Domain:** `cryptocadet.app` hosts `install.sh` + `install.ps1`.

## One-time setup
1. Host `../install.sh` and `../install.ps1` at `https://cryptocadet.app/` (landing site `public/`).
2. Create `thetechjd/homebrew-cryptocadet-cli` with `Formula/cryptocadet.rb` (copy from
   [homebrew/cryptocadet.rb](homebrew/cryptocadet.rb)).
3. Repo secrets: `NPM_TOKEN` (publish rights to `@cryptocadet`), optional `TAP_GITHUB_TOKEN`
   (contents:write on the tap, for auto-updating the formula sha256).

## Cut a release
```
npm version patch          # bump package.json (patch|minor|major)
git push && git push --tags
```
The tag drives [.github/workflows/release.yml](../.github/workflows/release.yml): `npm publish`
(build via `prepare`, gate via `prepublishOnly` = typecheck + tests), create the GitHub Release
(notes only), and — if `TAP_GITHUB_TOKEN` is set — rewrite the formula's url version + sha256 (of
the npm tarball) and push the tap.

### Manual fallback
```
npm publish                                   # prepare builds dist/, prepublishOnly gates
sha=$(curl -fsSL https://registry.npmjs.org/@cryptocadet/cli/-/cli-<ver>.tgz | sha256sum | awk '{print $1}')
# edit the tap Formula/cryptocadet.rb: url cli-<ver>.tgz, version <ver>, sha256 <sha>
```

## Per-version checklist
```
[ ] npm version <patch|minor|major>; git push && git push --tags
[ ] Workflow green: npm shows the new version; GitHub Release created
[ ] npm:   npm i -g @cryptocadet/cli && cryptocadet init      (macOS, Linux, Windows)
[ ] curl:  install.sh on a clean Linux/macOS box (no system Node) -> cryptocadet init
[ ] ps1:   install.ps1 on Windows -> cryptocadet init
[ ] Keychain unlock verified on each OS (Windows uses @napi-rs/keyring)
[ ] brew:  formula sha256 updated; brew install works on macOS arm+intel and Linux
```

## Release gate
The maintainer pushing the tag is the gate — that act triggers publish + release + tap update.
Claude Code never pushes tags or publishes; it builds/tests locally only.
