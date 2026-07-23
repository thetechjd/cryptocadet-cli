// Assembles the live agent runtime: unlock the key, build provider/wallet, ledger,
// the gated PaymentSigner with the real broadcaster, the server client, and the
// four-verb agent tool registry. Reconciles PENDING payments on start.
//
// This is the only place the decrypted key meets the chain. The plaintext key lives in
// the wallet object for the session and is not written to disk.

import { loadConfig } from './config/config.js';
import { makePolicyProvider } from './config/policy-store.js';
import { unlockAgentPrivateKey } from './custody/keystore.js';
import { makeProvider, makeWallet, confirmationDepth } from './chain/provider.js';
import { ensureGas, liveSwapExecutor } from './chain/swap.js';
import { USDC_BY_CHAIN } from './init/policy-scaffold.js';
import { Ledger } from './ledger/ledger.js';
import { PaymentSigner } from './signer/signer.js';
import { liveBroadcaster, liveReadBalance } from './signer/live-broadcaster.js';
import { reconcilePending } from './signer/reconcile.js';
import { httpServerClient } from './server/client.js';
import { readCredential, authHeader } from './server/auth.js';
import { buildAgentTools, AGENT_TOOL_NAMES, type AgentTool, type AgentToolName } from './mcp/agent-tools.js';

export interface Runtime {
  agentAddress: string;
  tools: Record<AgentToolName, AgentTool>;
  toolNames: readonly AgentToolName[];
  readBalance: (token: string) => Promise<string>;
  /** The single gated signer. Exposed for the human-only `checkout` verb, which pays a
   *  merchant-supplied signed quote through the SAME `pay()` path the agent tools use —
   *  it adds NO new signing/broadcast call site (see test/single-gate.test.ts). */
  signer: PaymentSigner;
  close: () => void;
}

export async function buildRuntime(): Promise<Runtime> {
  const config = loadConfig();
  // A provider (not a snapshot) so a resident mcp:serve honors policy edits without a restart.
  const policyProvider = makePolicyProvider();
  const policy = policyProvider();
  if (policy.chainId !== config.chainId)
    throw new Error(`policy.chainId ${policy.chainId} != config.chainId ${config.chainId}`);

  const provider = makeProvider(config);
  const priv = await unlockAgentPrivateKey(config.keychainRef); // one OS authorization
  const wallet = makeWallet(priv, provider);

  const ledger = new Ledger();
  const confirmations = confirmationDepth(config.chainId, config.confirmationDepth);
  const server = httpServerClient(config.serverBaseUrl, async () => {
    const cred = await readCredential(config.serverAuthRef);
    return cred ? authHeader(cred) : null;
  });
  const readBalance = liveReadBalance(provider, config.agentAddress);

  // Just-in-time gas top-up: before an agent payment is signed, swap a bounded amount of
  // USDC→ETH if the wallet can't cover gas (policy.gasSwap governs whether/how much).
  const gasExec = liveSwapExecutor(wallet, provider, config.chainId, USDC_BY_CHAIN[config.chainId], config.agentAddress);
  const ensureGasBeforeSend = () => ensureGas(policyProvider(), gasExec).then(() => undefined);

  const signer = new PaymentSigner({
    policy: policyProvider,
    serverQuotePubKey: config.serverQuotePubKey,
    confirmations,
    ledger,
    readBalance,
    // Gas ensure is a PRE-FLIGHT (runs before the quote is claimed), not a broadcast
    // hook: a failed swap used to burn the quote as FAILED although nothing was signed.
    prepare: ensureGasBeforeSend,
    broadcast: liveBroadcaster(wallet),
    finalize: (quoteId, txHash) => server.finalize(quoteId, txHash).then(() => undefined),
  });

  // Reconcile any PENDING rows before serving — never re-pay, only resolve from chain.
  await reconcilePending(ledger, provider, confirmations, (q, t) => server.finalize(q, t).then(() => undefined));

  const tools = buildAgentTools({ policy: policyProvider, signer, server, readBalance });

  return {
    agentAddress: config.agentAddress,
    tools,
    toolNames: AGENT_TOOL_NAMES,
    readBalance,
    signer,
    close: () => ledger.close(),
  };
}
