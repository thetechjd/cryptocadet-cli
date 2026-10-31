#!/usr/bin/env node
// The `cryptocadet` binary (alias `ccx`).
//
// Commands are grouped by local state (wallet, policy) vs remote state (the server's
// catalog, credits, history). Agents pay with `cryptocadet fetch <url>`: every payment goes
// through the single policy-gated signer, or spends card-funded credits capped server-side.

import { fileURLToPath } from 'node:url';
import { parseUnits, formatUnits } from 'ethers';
import { runInit, refuseMainWalletKey, type InitOptions } from '../init/wizard.js';
import { createReadlineIO, silentIO } from '../init/prompts.js';
import { renderBanner } from '../brand/banner.js';
import { editAllowlist, setRecipient, setLimit, setReserve } from './human-verbs.js';
import { parseSignedQuote, resolveQuoteRaw } from './checkout.js';
import { readFileSync } from 'node:fs';
import { login, logout, makeServerClient } from './seller.js';
import { agentTokenRef, storeAgentToken, clearAgentToken, readAgentToken } from '../server/agent-token.js';
import { rotateAgent } from '../revoke/rotate.js';
import { sweep } from '../revoke/sweep.js';
import { reserveCheck } from '../subscription/reserve.js';
import { buildTopupRequest, type TopupTarget } from '../topup/topup.js';
import { dashboardSync } from '../dashboard/sync.js';
import { collectorInit, collectorServeOnce, collectorServeLoop } from '../collector/serve.js';
import { treasuryInit, treasuryServeLoop, treasuryServeOnce } from '../treasury/serve.js';
import { loadConfig } from '../config/config.js';
import { loadPolicy } from '../config/policy-store.js';
import { unlockAgentPrivateKey } from '../custody/keystore.js';
import { makeProvider, makeWallet } from '../chain/provider.js';
import { tokenBalance, approveToken } from '../chain/erc20.js';
import { ensureGas, liveSwapExecutor } from '../chain/swap.js';
import { USDC_BY_CHAIN } from '../init/policy-scaffold.js';
import { grantSubscriptionApproval, revokeSubscriptionApproval } from '../subscription/grant.js';
import { Ledger } from '../ledger/ledger.js';
import { buildRuntime } from '../runtime.js';
import { createRequire } from 'node:module';

function pkgVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
function req(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing --${name}`);
  return v;
}
function out(o: unknown): void {
  console.log(JSON.stringify(o, null, 2));
}
/** Collect repeated `token=amount` positional pairs (multi-asset top-up / reserve check). */
function kvPairs(args: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^(0x[0-9a-fA-F]{40})=(\d+)$/);
    if (m) map[m[1]!.toLowerCase()] = m[2]!;
  }
  return map;
}

async function spendableTable() {
  const cfg = loadConfig();
  const policy = loadPolicy();
  const provider = makeProvider(cfg);
  // v4 pays in USDC on Base only, so show exactly that token (plus ETH for gas below), not
  // every token a policy may list. rdk parses agentAddress/chainId/tokens[].balance.
  const token = USDC_BY_CHAIN[cfg.chainId];
  const balance = await tokenBalance(provider, token, cfg.agentAddress);
  const reserve = policy.subscriptionReserve[token] ?? '0';
  const spendable = (BigInt(balance) - BigInt(reserve) < 0n ? 0n : BigInt(balance) - BigInt(reserve)).toString();
  const tokens = [{ token, symbol: 'USDC', balance, reserve, spendable, amount: `${formatUnits(balance, 6)} USDC` }];
  // Native ETH pays gas for every payment (USDC can't), so show it alongside the tokens.
  const wei = await provider.getBalance(cfg.agentAddress);
  const swap = policy.gasSwap;
  const lowGas = wei < BigInt(swap?.minWei || '100000000000000');
  return {
    agentAddress: cfg.agentAddress,
    chainId: cfg.chainId,
    network: cfg.chainId === 8453 ? 'Base mainnet' : 'Base Sepolia (testnet)',
    eth: { balance: wei.toString(), amount: `${formatUnits(wei, 18)} ETH` },
    tokens,
    ...(lowGas
      ? {
          gas:
            swap?.enabled
              ? 'ETH is low: a small amount of USDC will be swapped for gas before the next payment (needs a little ETH to start if the balance is 0).'
              : 'ETH is low: send a little ETH on Base to this address so payments can pay gas.',
        }
      : {}),
  };
}

const VERBS = [
  'init', 'wallet:show', 'policy:show', 'policy:set', 'allowlist:add', 'allowlist:remove',
  'topup:request', 'checkout', 'rotate', 'sweep', 'reserve:check', 'subs:grant', 'subs:revoke',
  'login', 'logout', 'product:list', 'product:create', 'product:update', 'product:disable',
  'payout:set', 'subs:list', 'subs:create', 'subs:cancel', 'history', 'dashboard:sync',
  'collector:init', 'collector:serve', 'treasury:init', 'treasury:serve',
  'handle:set', 'credits:show', 'credits:buy', 'credits:verify',
  'agent-token:create', 'agent-token:list', 'agent-token:revoke', 'agent-token:clear', 'fetch',
  'version',
];

/** "$4.25" / "4.25" → micro-USD base units (USDC has 6 decimals, 1 USD = 1 USDC). */
function usdToMicros(raw: string, name: string): string {
  const v = raw.replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`--${name} must be a USD amount like 5 or 2.50`);
  return parseUnits(v, 6).toString();
}
/** micro-USD → "$4.00" (cents always shown; sub-cent digits kept when present). */
function microsToUsd(m: string | null): string | null {
  if (m === null) return null;
  const [whole, frac = ''] = formatUnits(BigInt(m), 6).split('.');
  return `$${whole}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** Repeated `--header 'Name: value'` flags. */
function headerFlags(args: string[]): Record<string, string> {
  const h: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a !== '--header') return;
    const raw = args[i + 1] ?? '';
    const at = raw.indexOf(':');
    if (at <= 0) throw new Error(`--header must be 'Name: value', got: ${raw}`);
    h[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  });
  return h;
}

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  // Version handshake — lets a driver (e.g. rdk) capability-gate against a minimum
  // CLI version before invoking newer verbs like `checkout`. JSON on stdout, exit 0.
  if (verb === 'version' || verb === '--version' || verb === '-v') {
    out({ version: pkgVersion() });
    return;
  }
  switch (verb) {
    // ===================== LOCAL state — human-only =====================
    case 'init': {
      refuseMainWalletKey(process.argv); // never accept a main wallet key, in any mode
      const json = has(args, 'json');
      const yes = has(args, 'yes');
      // --chain testnet|mainnet is accepted as an alias for --network.
      const chainAlias = flag(args, 'chain');
      const network = (flag(args, 'network') ??
        (chainAlias === 'testnet' ? 'base-sepolia' : chainAlias === 'mainnet' ? 'base-mainnet' : undefined)) as
        | 'base-sepolia'
        | 'base-mainnet'
        | undefined;

      if (!json && !has(args, 'no-banner')) console.log(renderBanner());

      const io = yes || json ? silentIO() : createReadlineIO();
      const role = flag(args, 'role');
      const rpc = flag(args, 'rpc');
      const server = flag(args, 'server');
      const pubkey = flag(args, 'pubkey');
      const apiKey = flag(args, 'api-key');
      const kind = flag(args, 'kind');
      const payout = flag(args, 'payout');
      const opts: InitOptions = {
        yes: yes || json,
        json,
        ...(role ? { role: role as 'buyer' | 'seller' | 'both' } : {}),
        ...(network ? { network } : {}),
        ...(rpc ? { rpcUrl: rpc } : {}),
        ...(server ? { serverBaseUrl: server } : {}),
        ...(pubkey ? { serverQuotePubKey: pubkey } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(kind ? { apiKeyKind: kind as 'apikey' | 'jwt' } : {}),
        ...(payout ? { payout } : {}),
      };
      const summary = await runInit(opts, { io });
      if (json) out(summary);
      break;
    }
    case 'wallet:show':
      out(await spendableTable());
      break;
    case 'policy:show':
      out(loadPolicy());
      break;
    case 'policy:set': {
      // caps, reserve, escalation threshold
      const kind = req(flag(args, 'kind'), 'kind'); // perTx | daily | requireHumanAbove | reserve
      const token = req(flag(args, 'token'), 'token');
      // Amount may be given as raw base units (--amount) or human token units (--usdc 50).
      // The base-unit form is the classic foot-gun: `--amount 50` means 0.00005 USDC, not $50.
      const usdcFlag = flag(args, 'usdc');
      const decimals = loadPolicy().allowlist[token.toLowerCase()]?.decimals;
      let amount: string;
      if (usdcFlag !== undefined) {
        if (decimals === undefined)
          throw new Error(
            `--usdc requires ${token} to be in the allowlist so its decimals are known; add it first (allowlist:add) or pass --amount in base units`,
          );
        amount = parseUnits(usdcFlag, decimals).toString(); // throws on a malformed decimal
      } else {
        amount = req(flag(args, 'amount'), 'amount');
      }
      // Echo the interpreted amount to stderr (stdout stays pure JSON for machine consumers).
      const human = decimals !== undefined ? `${formatUnits(amount, decimals)} tokens` : `${amount} base units`;
      console.error(`policy:set ${kind} ${token.toLowerCase()} = ${amount} base units (${human})`);
      if (kind === 'reserve') out(setReserve(token, amount));
      else out(setLimit(kind as 'perTx' | 'daily' | 'requireHumanAbove', token, amount));
      break;
    }
    case 'allowlist:add': {
      const kind = req(flag(args, 'kind'), 'kind'); // token | recipient
      if (kind === 'recipient') out(setRecipient('add', req(flag(args, 'address'), 'address')));
      else
        out(
          editAllowlist('add', req(flag(args, 'token'), 'token'), {
            symbol: req(flag(args, 'symbol'), 'symbol'),
            decimals: Number(req(flag(args, 'decimals'), 'decimals')),
            feeOnTransfer: has(args, 'fee-on-transfer'),
          }),
        );
      break;
    }
    case 'allowlist:remove': {
      const kind = req(flag(args, 'kind'), 'kind');
      if (kind === 'recipient') out(setRecipient('remove', req(flag(args, 'address'), 'address')));
      else out(editAllowlist('remove', req(flag(args, 'token'), 'token')));
      break;
    }
    case 'topup:request': {
      const cfg = loadConfig();
      const policy = loadPolicy();
      const provider = makeProvider(cfg);
      const targets: TopupTarget[] = Object.entries(kvPairs(args)).map(([token, target]) => ({ token, target }));
      if (targets.length === 0) throw new Error('topup:request needs at least one <token>=<targetBaseUnits> pair');
      const balances: Record<string, string> = {};
      for (const t of targets) balances[t.token] = await tokenBalance(provider, t.token, cfg.agentAddress);
      const request = buildTopupRequest(cfg.agentAddress, policy, (t) => balances[t] ?? '0', targets);
      // alert-and-approve: emit the request; NO auto-drain from the main wallet.
      out({ ...request, note: 'human action required: transfer the shortfall from your main wallet to agentAddress' });
      break;
    }
    case 'rotate': {
      const cfg = loadConfig();
      const provider = makeProvider(cfg);
      const json = has(args, 'json');
      const yes = has(args, 'yes');
      const toOverride = flag(args, 'to');
      // Prompt only with a real terminal and no bypass flag. Scripts / --yes / --json
      // proceed non-interactively (back-compat with `rotate --and-sweep [--to]`).
      const interactive = Boolean(process.stdin.isTTY) && !json && !yes;

      if (interactive) {
        const io = createReadlineIO();
        // Rotation destroys the old key irreversibly — warn and confirm before anything.
        process.stderr.write(
          '⚠  Rotating replaces your agent wallet and PERMANENTLY destroys the current key.\n' +
          `   current agent: ${cfg.agentAddress}\n` +
          '   Funds left in the old wallet become unrecoverable once the key is gone.\n' +
          '   (This does NOT change your server API key.)\n',
        );
        if (!(await io.confirm('Rotate the agent key now?', false))) {
          out({ rotated: false, cancelled: true });
          break;
        }
        // Offer to rescue the old wallet's funds — default to the new agent wallet.
        const destLabel = toOverride ?? 'the new agent wallet';
        const doSweep = await io.confirm(`Transfer any funds from the old wallet to ${destLabel} first?`, true);
        out(await rotateAgent({ provider, sweep: doSweep, sweepTo: toOverride }));
        break;
      }

      // Non-interactive: sweep only when explicitly requested (--and-sweep or --to).
      const doSweep = has(args, 'and-sweep') || Boolean(toOverride);
      out(await rotateAgent({ provider, sweep: doSweep, sweepTo: toOverride }));
      break;
    }
    case 'sweep': {
      const cfg = loadConfig();
      const provider = makeProvider(cfg);
      const wallet = makeWallet(await unlockAgentPrivateKey(cfg.keychainRef), provider);
      out(await sweep(provider, wallet, req(flag(args, 'to'), 'to')));
      break;
    }
    case 'subs:grant':
    case 'subs:revoke': {
      // Human-only capped approval to a subscription collector. Delegates PULL authority
      // up to --cap; the cap is the enforcement (per-call policy doesn't gate transferFrom).
      const cfg = loadConfig();
      const provider = makeProvider(cfg);
      const wallet = makeWallet(await unlockAgentPrivateKey(cfg.keychainRef), provider);
      // The approve tx needs native ETH for gas; top up from USDC first if the wallet is short.
      const gasExec = liveSwapExecutor(wallet, provider, cfg.chainId, USDC_BY_CHAIN[cfg.chainId], cfg.agentAddress);
      const approve = async (token: string, spender: string, amount: string) => {
        await ensureGas(loadPolicy(), gasExec);
        const tx = await approveToken(wallet, token, spender, amount);
        await tx.wait();
        return { txHash: tx.hash };
      };
      const token = req(flag(args, 'token'), 'token');
      const collector = req(flag(args, 'collector'), 'collector');
      if (verb === 'subs:revoke') {
        out(await revokeSubscriptionApproval({ approve }, { token, collector }));
      } else {
        out(await grantSubscriptionApproval({ policy: loadPolicy(), approve }, { token, collector, cap: req(flag(args, 'cap'), 'cap') }));
      }
      break;
    }
    case 'reserve:check': {
      const cfg = loadConfig();
      const policy = loadPolicy();
      const provider = makeProvider(cfg);
      const ledger = new Ledger();
      const nextPull = kvPairs(args);
      const balances: Record<string, string> = {};
      for (const t of new Set([...Object.keys(policy.allowlist), ...Object.keys(nextPull)]))
        balances[t] = await tokenBalance(provider, t, cfg.agentAddress);
      out(
        reserveCheck({
          policy,
          balance: (t) => balances[t] ?? '0',
          spentLast24h: (t) => ledger.spentLast24h(t),
          nextPull,
        }),
      );
      ledger.close();
      break;
    }
    case 'checkout': {
      // Pay a merchant-supplied SignedQuote (the quote is issued by the SELLER's server
      // account, so the buyer cannot re-fetch it by id — it is passed in full). The signer
      // re-verifies serverSig against the pinned pubkey and re-runs local policy before the
      // single gated broadcast, so transport of the quote need not be trusted.
      const quoteJson = flag(args, 'quote-json');
      const quoteFile = flag(args, 'quote-file');
      const raw = resolveQuoteRaw({
        ...(quoteJson !== undefined ? { json: quoteJson } : {}),
        ...(quoteFile !== undefined ? { file: quoteFile } : {}),
        // Only read stdin when it is piped, so an interactive run doesn't hang on fd 0.
        ...(process.stdin.isTTY ? {} : { stdin: () => readFileSync(0, 'utf8') }),
      });
      const quote = parseSignedQuote(raw);
      // `--approve` (alias `--yes`) confirms an ESCALATE decision out-of-band; it can only
      // rescue an above-threshold quote whose every other check already passed.
      const humanApproved = has(args, 'approve') || has(args, 'yes');
      // Allowlist the merchant's payout up front (fail-closed policy ships with none) so
      // the payment isn't REFUSED for an un-trusted recipient. Opt-in via the flag.
      if (has(args, 'allowlist-recipient')) setRecipient('add', quote.recipient);
      const rt = await buildRuntime();
      try {
        out(await rt.signer.pay(quote, { humanApproved }));
      } finally {
        rt.close();
      }
      break;
    }

    // ===================== REMOTE state — server postgres via API =====================
    case 'login':
      out(await login((flag(args, 'kind') ?? 'apikey') as 'apikey' | 'jwt', req(flag(args, 'value'), 'value')));
      break;
    case 'logout':
      out(await logout());
      break;
    case 'product:list':
      out(await (await makeServerClient()).listProducts());
      break;
    case 'product:create': {
      // A --slug puts the product behind the 402 gateway at /v4/g/<handle>/<slug> (USDC-priced;
      // --token may be omitted). Price: --price in base units, or --usd for dollars.
      const slug = flag(args, 'slug');
      const token = flag(args, 'token');
      if (!token && !slug) throw new Error('missing --token (only gateway products, with --slug, default to USDC)');
      const contentFile = flag(args, 'content-file');
      const usd = flag(args, 'usd');
      const p = await (await makeServerClient()).createProduct({
        name: req(flag(args, 'name'), 'name'),
        ...(token ? { token: token.toLowerCase() } : {}),
        unitPrice: usd !== undefined ? usdToMicros(usd, 'usd') : req(flag(args, 'price'), 'price'),
        ...(slug ? { slug } : {}),
        ...(flag(args, 'kind') ? { kind: flag(args, 'kind') as 'hosted' | 'proxy' } : {}),
        ...(flag(args, 'visibility') ? { visibility: flag(args, 'visibility') as 'paid' | 'free' | 'private' } : {}),
        ...(flag(args, 'description') ? { description: flag(args, 'description')! } : {}),
        ...(contentFile ? { content: readFileSync(contentFile, 'utf8') } : {}),
        ...(flag(args, 'content-type') ? { contentType: flag(args, 'content-type')! } : {}),
        ...(flag(args, 'origin-url') ? { originUrl: flag(args, 'origin-url')! } : {}),
      });
      out(p);
      break;
    }
    case 'handle:set':
      out(await (await makeServerClient()).setHandle(req(flag(args, 'handle'), 'handle')));
      break;

    // ===================== BUYER: card credits + agent spend tokens (human-only) =====================
    case 'credits:show': {
      const c = await (await makeServerClient()).credits();
      out({ credits: microsToUsd(c.credits), earnings: microsToUsd(c.earnings), creditsMicros: c.credits, entries: c.entries.slice(0, 10) });
      break;
    }
    case 'credits:buy': {
      // Card top-up on Stripe Checkout. Pay at the printed URL; the webhook credits the balance
      // (`credits:verify --session` settles it by hand if the webhook is slow).
      const r = await (await makeServerClient()).creditsCheckout(usdToMicros(req(flag(args, 'usd'), 'usd'), 'usd'));
      out({ pay: r.url, sessionId: r.sessionId, amount: microsToUsd(r.amount) });
      break;
    }
    case 'credits:verify':
      out(await (await makeServerClient()).creditsVerify(req(flag(args, 'session'), 'session')));
      break;
    case 'agent-token:create': {
      // Issue a capped spend token for THIS machine's agent and keep it in the OS keychain.
      // It is never printed: the agent uses it through fetch_paid, and only towards the
      // configured CryptoCadet origin.
      const cfg = loadConfig();
      const perCall = flag(args, 'per-call-usd');
      const daily = flag(args, 'daily-usd');
      const sellers = flag(args, 'sellers');
      const created = await (await makeServerClient()).createAgentToken({
        name: req(flag(args, 'name'), 'name'),
        ...(perCall ? { perCallCap: usdToMicros(perCall, 'per-call-usd') } : {}),
        ...(daily ? { dailyCap: usdToMicros(daily, 'daily-usd') } : {}),
        ...(sellers ? { allowedSellers: sellers.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      });
      const { token, ...info } = created;
      await storeAgentToken(agentTokenRef(cfg.keychainRef), token);
      out({ ...info, perCallCap: microsToUsd(info.perCallCap), dailyCap: microsToUsd(info.dailyCap), storedInKeychain: true });
      break;
    }
    case 'agent-token:list': {
      const cfg = loadConfig();
      const tokens = await (await makeServerClient()).listAgentTokens();
      out({
        tokenOnThisMachine: (await readAgentToken(agentTokenRef(cfg.keychainRef))) !== null,
        tokens: tokens.map((t) => ({ ...t, perCallCap: microsToUsd(t.perCallCap), dailyCap: microsToUsd(t.dailyCap) })),
      });
      break;
    }
    case 'agent-token:revoke':
      out(await (await makeServerClient()).revokeAgentToken(req(flag(args, 'id'), 'id')));
      break;
    case 'agent-token:clear':
      // Forget the token on this machine (the agent falls back to USDC). Revoke it too
      // (agent-token:revoke) if it may have leaked.
      await clearAgentToken(agentTokenRef(loadConfig().keychainRef));
      out({ ok: true });
      break;
    case 'fetch': {
      // Fetch a URL, paying an HTTP 402 if needed: card-funded credits on a CryptoCadet
      // gateway (agent-token:create), else USDC from the agent wallet within local policy.
      // --approve confirms a payment above a requireHumanAbove threshold, if one is set.
      const url = args[0] && !args[0].startsWith('--') ? args[0] : req(flag(args, 'url'), 'url');
      const rt = await buildRuntime();
      try {
        out(
          await rt.fetchPaid({
            url,
            ...(flag(args, 'method') ? { method: flag(args, 'method')! } : {}),
            ...(flag(args, 'data') !== undefined ? { body: flag(args, 'data')! } : {}),
            headers: headerFlags(args),
          }, { humanApproved: has(args, 'approve') }),
        );
      } finally {
        rt.close();
      }
      break;
    }
    case 'product:update': {
      const patch: Record<string, unknown> = {};
      if (flag(args, 'name')) patch['name'] = flag(args, 'name');
      if (flag(args, 'price')) patch['unitPrice'] = flag(args, 'price');
      out(await (await makeServerClient()).updateProduct(req(flag(args, 'id'), 'id'), patch));
      break;
    }
    case 'product:disable':
      out(await (await makeServerClient()).disableProduct(req(flag(args, 'id'), 'id')));
      break;
    case 'payout:set':
      out(await (await makeServerClient()).setPayout(req(flag(args, 'token'), 'token').toLowerCase(), req(flag(args, 'address'), 'address')));
      break;
    case 'subs:list':
      out(await (await makeServerClient()).listSubs());
      break;
    case 'subs:create':
      out(
        await (await makeServerClient()).createSub({
          token: req(flag(args, 'token'), 'token').toLowerCase(),
          amount: req(flag(args, 'amount'), 'amount'),
          interval: Number(req(flag(args, 'interval'), 'interval')),
        }),
      );
      break;
    case 'subs:cancel':
      out(await (await makeServerClient()).cancelSub(req(flag(args, 'id'), 'id')));
      break;
    case 'history':
      out(await (await makeServerClient()).history());
      break;
    case 'dashboard:sync':
      // Push read-only policy + balance + low-float snapshots for the dashboard to render.
      out(await dashboardSync());
      break;
    case 'collector:init':
      // Generate the seller-side collector (spender) wallet buyers approve for pulls.
      out(await collectorInit());
      break;
    case 'collector:serve': {
      // Keyed collector loop: claim cap-checked pulls, sign transferFrom, report results.
      if (has(args, 'once')) {
        out(await collectorServeOnce());
        break;
      }
      const intervalMs = Number(flag(args, 'interval') ?? '60000');
      const stop = await collectorServeLoop(intervalMs, (s) =>
        console.error(`[collector] claimed=${s.claimed} executed=${s.executed} failed=${s.failed}`),
      );
      console.error(`cryptocadet collector serving every ${intervalMs}ms`);
      process.on('SIGINT', () => {
        stop();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        stop();
        process.exit(0);
      });
      break;
    }

    // ===================== Treasury (CryptoCadet operator only) =====================
    case 'treasury:init':
      // Generate the operator treasury wallet that pays sellers their USDC earnings.
      out(await treasuryInit());
      break;
    case 'treasury:serve': {
      // Keyed payout loop: claim PENDING payouts, send USDC, report tx hashes.
      if (has(args, 'once')) {
        out(await treasuryServeOnce());
        break;
      }
      const intervalMs = Number(flag(args, 'interval') ?? '60000');
      const stop = await treasuryServeLoop(intervalMs, (t) =>
        console.error(`[treasury] claimed=${t.claimed} sent=${t.sent} failed=${t.failed}`),
      );
      console.error(`cryptocadet treasury serving every ${intervalMs}ms`);
      process.on('SIGINT', () => {
        stop();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        stop();
        process.exit(0);
      });
      break;
    }

    default:
      console.error(`unknown verb: ${verb ?? '(none)'}\nverbs: ${VERBS.join(', ')}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
