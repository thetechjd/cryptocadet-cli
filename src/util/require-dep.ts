// On-demand dependency install (the RDK `requireDep` lesson): heavy/native/optional deps
// are NOT installed at package-install time. They install on first use of the command
// that needs them. This keeps `npm i -g @cryptocadet/cli` light and avoids forcing a
// native toolchain (keytar/node-gyp) on users who never detach the signer.
//
// `ethers` is a hard runtime dependency (every spending path needs it) and is NOT lazy.
// This helper is for optional extras like `keytar`.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

function detectInstaller(): { cmd: string; args: (pkg: string) => string[] } {
  // Prefer the manager that ran us, else fall back to npm.
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return { cmd: 'pnpm', args: (p) => ['add', p] };
  if (ua.startsWith('yarn')) return { cmd: 'yarn', args: (p) => ['add', p] };
  if (ua.startsWith('bun')) return { cmd: 'bun', args: (p) => ['add', p] };
  return { cmd: 'npm', args: (p) => ['install', p] };
}

export interface RequireDepOptions {
  /** Set false to skip the install attempt and only probe (returns null if absent). */
  autoInstall?: boolean;
  /** version/range to install, default latest */
  version?: string;
}

/** Ensure an optional dependency is importable, installing it on first use if needed.
 *  Returns the loaded module, or null if it is absent and could not be installed. */
export async function requireDep<T = unknown>(pkg: string, opts: RequireDepOptions = {}): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ pkg as string)) as T;
  } catch {
    /* not installed yet */
  }
  if (opts.autoInstall === false) return null;

  const spec = opts.version ? `${pkg}@${opts.version}` : pkg;
  const inst = detectInstaller();
  process.stderr.write(`installing optional dependency ${spec} (first use)...\n`);
  const r = spawnSync(inst.cmd, inst.args(spec), { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`failed to install ${spec}; continuing without it\n`);
    return null;
  }
  try {
    // Bust the import cache via require for freshly-installed CJS/ESM.
    return nodeRequire(pkg) as T;
  } catch {
    try {
      return (await import(/* @vite-ignore */ pkg as string)) as T;
    } catch {
      return null;
    }
  }
}
