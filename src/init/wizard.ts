// The `cryptocadet init` first-run wizard. Composes the custody/keychain machinery
// (instruction 01) and the server API client — it does NOT reimplement key handling.
//
// Hard boundaries enforced here:
//  - generates the AGENT hot-wallet key ONLY; never asks for / imports / stores a main
//    wallet key (refuseMainWalletKey guards the flag surface).
//  - writes only the two local-authoritative artifacts (keys + policy); all seller data
//    is written THROUGH the server API.
//  - re-run never regenerates or overwrites the agent key.

import { randomBytes } from 'node:crypto';
import { generateAndStoreAgentKey } from '../custody/keystore.js';
import { saveConfig, loadConfig, type Config } from '../config/config.js';
import { savePolicy, policyExists } from '../config/policy-store.js';
import { storeCredential } from '../server/auth.js';
import { httpServerClient } from '../server/client.js';
import { readCredential, authHeader } from '../server/auth.js';
import { paths } from '../config/paths.js';
import { scaffoldPolicy, USDC_BY_CHAIN } from './policy-scaffold.js';
import { checkNode, detectKeychainBackend, detectExistingInstall } from './preflight.js';

export type Role = 'buyer' | 'seller' | 'both';
export type Network = 'base-sepolia' | 'base-mainnet';

/** Canonical hosted CryptoCadet v4 server — the default the agent fetches quotes from. Override
 *  with --server (or the interactive prompt) to point at a local/staging server. */
export const DEFAULT_SERVER_URL = 'https://api.v4.cryptocadet.app';

const NETWORK: Record<Network, { chainId: 8453 | 84532; rpcUrl: string }> = {
  'base-sepolia': { chainId: 84532, rpcUrl: 'https://sepolia.base.org' },
  'base-mainnet': { chainId: 8453, rpcUrl: 'https://mainnet.base.org' },
};

export interface WizardIO {
  print(msg?: string): void;
  prompt(question: string, def?: string): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  isTTY: boolean;
}

export interface InitOptions {
  yes?: boolean; // non-interactive
  role?: Role;
  network?: Network;
  rpcUrl?: string;
  serverBaseUrl?: string;
  serverQuotePubKey?: string; // if omitted, fetched from the server
  apiKey?: string; // server login credential
  apiKeyKind?: 'apikey' | 'jwt';
  payout?: string; // seller payout address
  json?: boolean;
}

export interface InitDeps {
  io: WizardIO;
  fetchImpl?: typeof fetch;
}

export interface InitSummary {
  fresh: boolean;
  role: Role;
  network: Network;
  chainId: 8453 | 84532;
  agentAddress?: string;
  keychainRef?: string;
  policyPath: string;
  serverBaseUrl?: string;
  loggedIn: boolean;
  payoutSet: boolean;
  keychainBackend: string;
  keychainAvailable: boolean;
}

/** Refuse any attempt to supply a main wallet key. There is no code path that accepts one;
 *  this makes the refusal explicit and loud if a flag is passed. */
export function refuseMainWalletKey(argv: string[]): void {
  const banned = ['--private-key', '--privatekey', '--main-key', '--mnemonic', '--seed-phrase', '--secret-key'];
  const hit = argv.find((a) => banned.includes(a.toLowerCase()));
  if (hit) {
    throw new Error(
      `refusing ${hit}: CryptoCadet never takes your main wallet key. It generates a bounded AGENT wallet and you fund it in batches.`,
    );
  }
}

async function fetchServerPubKey(serverBaseUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const r = await fetchImpl(`${serverBaseUrl.replace(/\/$/, '')}/v4/quotes/pubkey`);
  if (!r.ok) throw new Error(`could not fetch server pubkey (${r.status}); pass --pubkey`);
  const d = (await r.json()) as { serverQuotePubKey?: string };
  if (!d.serverQuotePubKey) throw new Error('server did not return a quote pubkey');
  return d.serverQuotePubKey;
}

async function chooseRole(opts: InitOptions, io: WizardIO): Promise<Role> {
  if (opts.role) return opts.role;
  if (opts.yes) return 'buyer';
  const a = (await io.prompt('Configure which role? [buyer/seller/both]', 'buyer')).trim().toLowerCase();
  return a === 'seller' || a === 'both' ? (a as Role) : 'buyer';
}

// Base mainnet by default: the hosted server (DEFAULT_SERVER_URL) runs on mainnet, and a
// wallet configured for another chain than its server refuses every quote ("wrong chain").
async function chooseNetwork(opts: InitOptions, io: WizardIO): Promise<Network> {
  if (opts.network) return opts.network;
  if (opts.yes) return 'base-mainnet';
  const mainnet = await io.confirm('Use Base mainnet? (answer no only for a Sepolia testnet server)', true);
  return mainnet ? 'base-mainnet' : 'base-sepolia';
}

export async function runInit(opts: InitOptions, deps: InitDeps): Promise<InitSummary> {
  const { io } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const quiet = Boolean(opts.json);

  // ── 1. Preflight ──
  const node = checkNode();
  const kc = await detectKeychainBackend();
  if (!quiet) {
    if (!node.ok) io.print(`⚠ Node ${node.version} < required ${node.required}`);
    if (!kc.available) io.print(`⚠ keychain backend unavailable: ${kc.note} (the detached signer needs it)`);
  }
  const install = detectExistingInstall();
  const fresh = !(install.hasConfig && install.hasKey);

  // ── 2. Role + 4. Network ──
  const role = await chooseRole(opts, io);
  const network = await chooseNetwork(opts, io);
  const { chainId, rpcUrl } = NETWORK[network];

  const summary: InitSummary = {
    fresh,
    role,
    network,
    chainId,
    policyPath: paths.policy(),
    loggedIn: false,
    payoutSet: false,
    keychainBackend: kc.backend,
    keychainAvailable: kc.available,
  };

  // ── 5. Buyer setup ──
  const wantsBuyer = role === 'buyer' || role === 'both';
  let config: Config | null = fresh ? null : loadConfig();

  if (wantsBuyer && fresh) {
    const serverBaseUrl =
      opts.serverBaseUrl ?? (opts.yes ? DEFAULT_SERVER_URL : await io.prompt('CryptoCadet server URL', DEFAULT_SERVER_URL));
    if (!serverBaseUrl) throw new Error('a server URL is required (--server) so the agent can fetch quotes');
    const serverQuotePubKey = opts.serverQuotePubKey ?? (await fetchServerPubKey(serverBaseUrl, fetchImpl));

    const suffix = randomBytes(8).toString('hex');
    const keychainRef = `cryptocadet-agent-${suffix}`;
    const serverAuthRef = `cryptocadet-server-${suffix}`; // SEPARATE entry from the wallet key
    const { address } = await generateAndStoreAgentKey(keychainRef);

    config = { chainId, rpcUrl: opts.rpcUrl ?? rpcUrl, serverBaseUrl, serverQuotePubKey, keychainRef, serverAuthRef, agentAddress: address };
    saveConfig(config);
    if (!policyExists()) savePolicy(scaffoldPolicy(chainId));

    summary.agentAddress = address;
    summary.keychainRef = keychainRef;
    summary.serverBaseUrl = serverBaseUrl;

    if (!quiet) {
      io.print('');
      io.print(`Agent wallet: ${address}`);
      io.print('  This wallet starts EMPTY. Keep only a working float here; your main wallet key is');
      io.print('  never entered anywhere in this tool.');
      io.print(`  Policy at ${paths.policy()}: USDC, $1 per payment, $5 per day. Each seller must be`);
      io.print('  allowlisted once before the wallet pays them (`fetch` prints the exact command).');
    }
  } else if (wantsBuyer && !fresh) {
    // Re-run: NEVER regenerate the key.
    if (!quiet) io.print(`Existing install detected at ${install.root} — keeping the agent key (use \`cryptocadet rotate\` to rotate).`);
    if (!install.hasPolicy) savePolicy(scaffoldPolicy(config!.chainId));
    summary.agentAddress = config!.agentAddress;
    summary.keychainRef = config!.keychainRef;
    summary.serverBaseUrl = config!.serverBaseUrl;
  }

  // ── 6. Server authentication ──
  const serverAuthRef = config?.serverAuthRef;
  const apiKey = opts.apiKey ?? (opts.yes || !wantsBuyer ? undefined : (await io.prompt('Server API key (blank to skip)', '')).trim() || undefined);
  if (apiKey && serverAuthRef) {
    await storeCredential(serverAuthRef, { kind: opts.apiKeyKind ?? 'apikey', value: apiKey });
    summary.loggedIn = true;
  } else if (config) {
    summary.loggedIn = (await readCredential(config.serverAuthRef)) !== null;
  }

  // ── 7. Seller setup (written THROUGH the server, never stored locally) ──
  if ((role === 'seller' || role === 'both') && config) {
    const payout = opts.payout ?? (opts.yes ? undefined : (await io.prompt('Payout (receiving) address (blank to skip)', '')).trim() || undefined);
    if (payout) {
      const server = httpServerClient(config.serverBaseUrl, async () => {
        const c = await readCredential(config!.serverAuthRef);
        return c ? authHeader(c) : null;
      });
      await server.setPayout(USDC_BY_CHAIN[chainId], payout);
      summary.payoutSet = true;
    }
  }

  // ── 8. Summary ──
  if (!quiet) {
    io.print('');
    io.print('Setup complete.');
    if (summary.agentAddress) io.print(`  • Agent ${summary.agentAddress} on ${network}`);
    io.print('');
    io.print('Fund it one of two ways:');
    io.print(`  1. Crypto: send USDC (and a little ETH for gas) on Base to ${summary.agentAddress ?? 'the agent address'}`);
    io.print('  2. Card:   cryptocadet login            (your cryptocadet.app email + password)');
    io.print('             cryptocadet credits:buy --usd 5');
    io.print('             cryptocadet agent-token:create --name my-agent --daily-usd 5');
    io.print('');
    io.print('Then pay for anything behind a CryptoCadet 402:');
    io.print('  cryptocadet fetch https://api.v4.cryptocadet.app/v4/g/<seller>/<item>');
  }
  return summary;
}
