#!/usr/bin/env node
// Build the self-contained brew/curl binaries.
//
//   1. esbuild  src/cli/index.ts  ->  dist/cli.cjs   (ESM source bundled to a single CJS file)
//   2. @yao-pkg/pkg dist/cli.cjs  ->  one binary per Node 24 target
//   3. tar.gz each binary + generate dist/bin/SHA256SUMS
//
// Toolchain is @yao-pkg/pkg (the archived vercel/pkg cannot build Node 22/24). Node 24 base
// makes node:sqlite unflagged (the ledger requires it) and dodges yao-pkg's Node 22
// Standard-mode regression. Run on Node >= 22 (Node 24 recommended). Windows is deferred for
// v4.0 (no keychain shell-out branch yet); see Instruction 07.
//
// The binary bundle is NOT the npm channel. npm ships tsc output (dist/cli/index.js) and keeps
// the lazy dep-install from v4-05; this bundle disables it via the CRYPTOCADET_BINARY banner.

import { build } from 'esbuild';
import { exec as pkgExec } from '@yao-pkg/pkg';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_BUNDLE = join(ROOT, 'dist', 'cli.cjs');
const OUT_BIN_DIR = join(ROOT, 'dist', 'bin');

// One binary per target. Format: node24-<platform>-<arch>. Keep the asset names in lockstep
// with install.sh (osArchToAsset) and the Homebrew formula.
const TARGETS = [
  { pkg: 'node24-macos-arm64', asset: 'cryptocadet-macos-arm64' },
  { pkg: 'node24-macos-x64', asset: 'cryptocadet-macos-x64' },
  { pkg: 'node24-linux-x64', asset: 'cryptocadet-linux-x64' },
  { pkg: 'node24-linux-arm64', asset: 'cryptocadet-linux-arm64' },
  // Windows deferred for v4.0 — enable node24-win-x64 only alongside a Windows keychain path.
];

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

async function bundle() {
  console.error(`[1/3] esbuild -> ${OUT_BUNDLE}`);
  await build({
    entryPoints: [join(ROOT, 'src', 'cli', 'index.ts')],
    outfile: OUT_BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    // Self-contained: ethers, zod, and @modelcontextprotocol/sdk (imported dynamically in
    // mcp-server.ts) are bundled. Only the optional native keychain lib stays external so a
    // missing keytar degrades to the security/secret-tool shell-out instead of a build error.
    // node:* builtins are external automatically under platform:node.
    external: ['keytar'],
    // ESM idioms in the source resolved for the CJS output:
    //  - import.meta.url  -> a file:// URL derived from CJS __filename
    //  - CRYPTOCADET_BINARY marks the self-contained build so require-dep skips lazy install
    define: { 'import.meta.url': '__cjsImportMetaUrl' },
    banner: {
      js: [
        "const __cjsImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
        "process.env.CRYPTOCADET_BINARY = process.env.CRYPTOCADET_BINARY ?? '1';",
      ].join('\n'),
    },
    logLevel: 'info',
    minify: false,
  });
}

async function compile() {
  console.error(`[2/3] @yao-pkg/pkg -> ${OUT_BIN_DIR}`);
  mkdirSync(OUT_BIN_DIR, { recursive: true });
  for (const t of TARGETS) {
    const outPath = join(OUT_BIN_DIR, t.asset + (t.pkg.includes('win') ? '.exe' : ''));
    console.error(`      ${t.pkg} -> ${outPath}`);
    // --public + --public-packages "*" make pkg embed PLAIN JS instead of precompiled V8
    // bytecode. Bytecode is produced by the build host's V8 and rejected by the target's V8
    // when they differ ("[pkg] V8 rejected the bytecode cache ..."); this bites cross-target
    // builds on Node 24 too, so the flags are mandatory, not target-specific. Only tradeoff is
    // readable JS inside the binary — a non-issue (the source is on GitHub).
    await pkgExec([
      OUT_BUNDLE,
      '--targets', t.pkg,
      '--output', outPath,
      '--public',
      '--public-packages', '*',
      '--options', 'no-warnings',
    ]);
  }
}

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

async function packageAndChecksum() {
  console.error(`[3/3] tar.gz + SHA256SUMS`);
  const sums = [];
  for (const t of TARGETS) {
    const isWin = t.pkg.includes('win');
    const binName = t.asset + (isWin ? '.exe' : '');
    const binPath = join(OUT_BIN_DIR, binName);
    if (!existsSync(binPath)) throw new Error(`missing built binary: ${binPath}`);
    // Archive contains the plain `cryptocadet` binary so `bin.install "cryptocadet"` and the
    // curl installer both find a predictable name after extraction.
    const stagedName = 'cryptocadet' + (isWin ? '.exe' : '');
    const staged = join(OUT_BIN_DIR, stagedName);
    spawnSync('cp', [binPath, staged], { stdio: 'inherit' });
    spawnSync('chmod', ['+x', staged]);
    const archive = `${t.asset}.tar.gz`;
    const r = spawnSync('tar', ['-czf', join(OUT_BIN_DIR, archive), '-C', OUT_BIN_DIR, stagedName], {
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error(`tar failed for ${archive}`);
    spawnSync('rm', ['-f', staged]);
    sums.push(`${await sha256(join(OUT_BIN_DIR, archive))}  ${archive}`);
  }
  writeFileSync(join(OUT_BIN_DIR, 'SHA256SUMS'), sums.join('\n') + '\n');
  console.error('\nBuilt artifacts in dist/bin:');
  console.error(sums.map((s) => '  ' + s).join('\n'));
  console.error(`\nversion ${version}. Attach dist/bin/*.tar.gz + SHA256SUMS to the GitHub release.`);
}

const onlyBundle = process.argv.includes('--bundle-only');
await bundle();
if (!onlyBundle) {
  await compile();
  await packageAndChecksum();
}
