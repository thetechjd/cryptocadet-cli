#!/usr/bin/env node
// The `cryptocadet` binary (alias `ccx`).
//
// Command surface is grouped on two axes: local-vs-remote state, and
// agent-exposed-vs-human-only. EVERY verb in this file is HUMAN-ONLY — none of them are
// registered on the agent transport. The agent transport exposes exactly the four verbs
// in src/mcp/agent-tools.ts (check_balance, quote_payment, pay, dry_run) and nothing
// else; `mcp:serve` wires only those.

import { fileURLToPath } from 'node:url';
import { runInit, refuseMainWalletKey, type InitOptions } from '../init/wizard.js';
import { createReadlineIO, silentIO } from '../init/prompts.js';
import { renderBanner } from '../brand/banner.js';
import { editAllowlist, setRecipient, setLimit, setReserve } from './human-verbs.js';
import { login, logout, makeServerClient } from './seller.js';
import { rotate } from '../revoke/rotate.js';
import { sweep } from '../revoke/sweep.js';
import { reserveCheck } from '../subscription/reserve.js';
import { buildTopupRequest, type TopupTarget } from '../topup/topup.js';
import { dashboardSync } from '../dashboard/sync.js';
import { collectorInit, collectorServeOnce, collectorServeLoop } from '../collector/serve.js';
import { loadConfig } from '../config/config.js';
import { loadPolicy } from '../config/policy-store.js';
import { unlockAgentPrivateKey } from '../custody/keystore.js';
import { makeProvider, makeWallet } from '../chain/provider.js';
import { tokenBalance, approveToken } from '../chain/erc20.js';
import { grantSubscriptionApproval, revokeSubscriptionApproval } from '../subscription/grant.js';
import { Ledger } from '../ledger/ledger.js';
import { buildRuntime } from '../runtime.js';
import { AGENT_TOOL_NAMES } from '../mcp/agent-tools.js';
import { buildMcpServer, connectStdio } from '../mcp/mcp-server.js';
import { createRequire } from 'node:module';

function pkgVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
import { startDetached, stop, status, writePid, clearPid } from '../mcp/lifecycle.js';

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
  const tokens: Array<{ token: string; symbol: string; balance: string; reserve: string; spendable: string }> = [];
  for (const token of Object.keys(policy.allowlist)) {
    const balance = await tokenBalance(provider, token, cfg.agentAddress);
    const reserve = policy.subscriptionReserve[token] ?? '0';
    const spendable = (BigInt(balance) - BigInt(reserve) < 0n ? 0n : BigInt(balance) - BigInt(reserve)).toString();
    tokens.push({ token, symbol: policy.allowlist[token]!.symbol, balance, reserve, spendable });
  }
  return { agentAddress: cfg.agentAddress, chainId: cfg.chainId, tokens };
}

const VERBS = [
  'init', 'wallet:show', 'policy:show', 'policy:set', 'allowlist:add', 'allowlist:remove',
  'topup:request', 'rotate', 'sweep', 'reserve:check', 'subs:grant', 'subs:revoke',
  'login', 'logout', 'product:list', 'product:create', 'product:update', 'product:disable',
  'payout:set', 'subs:list', 'subs:create', 'subs:cancel', 'history', 'dashboard:sync',
  'collector:init', 'collector:serve',
  'mcp:serve',
];

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
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
        ...(has(args, 'register-host') ? { registerHost: true } : {}),
      };
      const summary = await runInit(opts, { io });
      if (has(args, 'serve')) startDetached(fileURLToPath(import.meta.url));
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
      const amount = req(flag(args, 'amount'), 'amount');
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
      if (has(args, 'and-sweep')) {
        const cfg = loadConfig();
        const provider = makeProvider(cfg);
        const oldWallet = makeWallet(await unlockAgentPrivateKey(cfg.keychainRef), provider);
        const swept = await sweep(provider, oldWallet, req(flag(args, 'to'), 'to'));
        out({ swept, rotated: await rotate() });
      } else out(await rotate());
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
      const approve = async (token: string, spender: string, amount: string) => {
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
    case 'product:create':
      out(
        await (await makeServerClient()).createProduct({
          name: req(flag(args, 'name'), 'name'),
          token: req(flag(args, 'token'), 'token').toLowerCase(),
          unitPrice: req(flag(args, 'price'), 'price'),
        }),
      );
      break;
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

    // ===================== MCP serve lifecycle =====================
    case 'mcp:serve': {
      if (has(args, 'status')) {
        out(status());
        break;
      }
      if (has(args, 'stop')) {
        out(stop());
        break;
      }
      if (has(args, 'detach')) {
        const pid = startDetached(fileURLToPath(import.meta.url));
        out({ detached: true, pid });
        break;
      }
      // Foreground: build the live runtime (unlock key, reconcile pending) and register
      // ONLY the four agent verbs. `--foreground` is the detached child; a bare run is
      // attached. Either way we record our own pid for status/stop and clear it on exit.
      const rt = await buildRuntime();
      writePid(process.pid);
      // stdout is the MCP JSON-RPC channel — ALL logging stays on stderr.
      console.error(`cryptocadet mcp serving agent=${rt.agentAddress} tools=[${rt.toolNames.join(', ')}]`);
      console.error(`registered agent tools: ${AGENT_TOOL_NAMES.join(', ')}`);
      const mcp = buildMcpServer(rt.tools, { name: 'cryptocadet', version: pkgVersion() });
      const closeTransport = await connectStdio(mcp);
      const shutdown = () => {
        clearPid();
        void closeTransport();
        rt.close();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      // The stdio transport reads stdin and keeps the process (and the in-memory key) alive
      // for the session; the key is dropped when the process exits.
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
