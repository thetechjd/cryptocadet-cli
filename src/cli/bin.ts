#!/usr/bin/env node
// npm-channel launcher for `cryptocadet` / `ccx`.
//
// The ledger uses node:sqlite, which exists only on Node >= 22.5 and is behind the
// --experimental-sqlite flag until Node 24. The brew/curl binary embeds Node 24 and NEVER runs
// this file (its entry is the esbuild bundle of index.ts). The npm bin, however, runs under the
// user's Node — so here we:
//   1. give a clear, actionable error (not a raw ERR_UNKNOWN_BUILTIN_MODULE) if Node is too old, and
//   2. transparently re-exec ourselves with --experimental-sqlite when node:sqlite needs the flag.
//
// index.ts imports the ledger at module load, so the flag decision MUST happen here, before that
// import — which is why the bin is this launcher and not index.ts directly.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Silence only the node:sqlite ExperimentalWarning; keep every other warning intact.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : (warning as { message?: string } | undefined)?.message;
  if (typeof msg === 'string' && /experimental/i.test(msg) && /sqlite/i.test(msg)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const [maj, min] = process.versions.node.split('.').map(Number) as [number, number, number];
if (maj < 22 || (maj === 22 && min < 5)) {
  process.stderr.write(
    `cryptocadet needs Node >= 22.5 (you have v${process.versions.node}).\n` +
      `Upgrade Node, or install the standalone build that bundles its own runtime:\n` +
      `  brew install thetechjd/cryptocadet-cli/cryptocadet\n` +
      `  curl -fsSL https://cryptocadet.app/install.sh | sh\n`,
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
function sqliteReady(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

if (!sqliteReady() && !process.env.__CRYPTOCADET_SQLITE_REEXEC) {
  // Node 22.5–23.x: node:sqlite exists but is flagged. Re-run ourselves with the flag set. The
  // guard env var prevents an infinite loop if the flag somehow doesn't resolve the module.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, ['--experimental-sqlite', self, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, __CRYPTOCADET_SQLITE_REEXEC: '1' },
  });
  process.exit(r.status ?? 1);
}

// Node 24 (unflagged), or the re-exec'd child: hand off to the real CLI. index.ts runs main() itself.
void import('./index.js');
