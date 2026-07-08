// readline-backed WizardIO for interactive init, plus a silent IO for --yes / --json runs
// (which never call prompt/confirm). Human output goes to stdout; in JSON mode the CLI
// suppresses it and prints only the machine-readable summary.

import * as readline from 'node:readline/promises';
import type { WizardIO } from './wizard.js';

export function createReadlineIO(): WizardIO {
  return {
    isTTY: Boolean(process.stdout.isTTY),
    print: (msg = '') => process.stdout.write(`${msg}\n`),
    async prompt(question, def) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (await rl.question(`${question}${def ? ` [${def}]` : ''}: `)).trim();
        return ans || def || '';
      } finally {
        rl.close();
      }
    },
    async confirm(question, def = false) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (await rl.question(`${question} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
        if (!ans) return def;
        return ans === 'y' || ans === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

/** Non-interactive IO: printing is a no-op; prompting is a hard error (never reached in
 *  --yes mode, where every value comes from a flag or a conservative default). */
export function silentIO(): WizardIO {
  return {
    isTTY: false,
    print: () => {},
    prompt: async () => {
      throw new Error('interactive prompt required but running non-interactively (pass the value as a flag)');
    },
    confirm: async () => {
      throw new Error('interactive confirm required but running non-interactively');
    },
  };
}
