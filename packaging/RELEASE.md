# Releasing `@cryptocadet/cli` (Instruction 07)

Three install channels off one build: **brew** (macOS), **curl** (Linux/macOS), **npm** (any
Node ≥ 22.5). The brew/curl artifact is a self-contained `@yao-pkg/pkg` binary with Node 24
embedded — no node/npm/`node_modules` on the user's machine. npm is one channel of three.

## Canonical values (already filled — see [dist.config.sh](dist.config.sh))

Three independent namespaces — don't conflate them:
- **Source + releases + install.sh:** `thetechjd/cryptocadet-cli` (GitHub).
- **npm:** `@cryptocadet/cli` (register the `cryptocadet` scope on npmjs.com — this is an npm org,
  unrelated to GitHub, unavoidable for any `@scope/` package).
- **Homebrew tap:** `thetechjd/homebrew-cryptocadet-cli` — a plain repo under the existing thetechjd
  account, NO GitHub org (same as RDK's `homebrew-rdk`). Brew strips the `homebrew-` prefix →
  `brew install thetechjd/cryptocadet-cli/cryptocadet`. The formula's urls point at the thetechjd
  releases (same owner as source). Bare `brew install cryptocadet` is a later homebrew-core
  placement (earned via a maintainer-reviewed PR), not a naming choice.
- Domain: `cryptocadet.app`. These are the only environment-specific strings, already mirrored
  into the repo-root `install.sh`, [homebrew/cryptocadet.rb](homebrew/cryptocadet.rb), and README.

## One-time setup

1. Host the repo-root `../install.sh` at `https://cryptocadet.app/install.sh` (drop it in the
   landing site's `public/` on Vercel; also reachable raw at
   `raw.githubusercontent.com/thetechjd/cryptocadet-cli/main/install.sh`).
2. Create `thetechjd/homebrew-cryptocadet-cli` (plain repo, no org) with `Formula/cryptocadet.rb`
   (copied from [homebrew/cryptocadet.rb](homebrew/cryptocadet.rb)).
3. The `cryptocadet` npm org already exists for `@cryptocadet/cli`.
4. Add repo secrets (Settings → Secrets and variables → Actions):
   - `NPM_TOKEN` — npm automation token with publish rights to `@cryptocadet` (required for auto-publish).
   - `TAP_GITHUB_TOKEN` — PAT with `contents:write` on `thetechjd/homebrew-cryptocadet-cli` (optional;
     enables auto-updating the formula. Without it, that one step is skipped and you edit the formula
     by hand.)

## Cutting a release — the whole flow

Everything is automated by [.github/workflows/release.yml](../.github/workflows/release.yml). To
ship a version you only bump + push a tag:

```
npm version patch     # bumps package.json and makes the commit (patch|minor|major)
git push
git push --tags       # pushing the v* tag triggers the workflow
```

On that tag the workflow: builds all 4 binaries + `SHA256SUMS`, creates the GitHub Release with
them attached (the brew/curl download target), runs `npm publish`, and — if `TAP_GITHUB_TOKEN` is
set — rewrites the tap formula's version + sha256s and pushes it. Nothing is uploaded by hand.

### Manual fallback (if you ever skip CI)

```
pnpm install
pnpm run build:binary          # -> dist/bin/*.tar.gz + dist/bin/SHA256SUMS
git tag v0.1.1 && git push --tags
gh release create v0.1.1 dist/bin/*.tar.gz dist/bin/SHA256SUMS --generate-notes
npm publish
# then edit Formula/cryptocadet.rb version + sha256s (from SHA256SUMS) in the tap repo
```

Build host: Node ≥ 22 (Node 24 in CI). Windows (`node24-win-x64`) is deferred for v4.0 — no
keychain shell-out branch yet.

## Per-version checklist

```
[ ] Version bumped: npm version <patch|minor|major>
[ ] git push && git push --tags   (this drives the release workflow)
[ ] Workflow green: GitHub Release has 4 *.tar.gz + SHA256SUMS; npm shows the new version
[ ] Binaries tested on a machine WITHOUT Node (node:sqlite opens with no --experimental flag)
[ ] Keychain unlock verified from the BINARY (not just npm build) on each OS
[ ] Tap formula updated (auto if TAP_GITHUB_TOKEN set, else by hand) — version + per-arch sha256
[ ] brew install thetechjd/cryptocadet-cli/cryptocadet works on macOS (arm + intel)
[ ] curl install.sh works on Linux (clean docker image, no Node)
[ ] cryptocadet init runs cleanly from each installed channel
```

## ⚠ MANUAL / approval

The **maintainer pushing the tag is the release gate** — that single act triggers the build,
GitHub Release, and `npm publish`. Claude Code never pushes commits/tags, creates releases, edits
the tap repo, or publishes; it builds and tests locally only. Everything shipping happens through
the tag you push (or the manual-fallback commands you run).

**Acceptance:** from a clean environment with no Node, a brew-installed and a curl-installed
`cryptocadet` both run `init`, generate the agent wallet, and unlock the signer via the OS
keychain — no native-addon errors.
