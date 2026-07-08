# CryptoCadet v4 — Architecture Overview (read first, reference always)

This is the greater-picture spec. Every component spec references it. It defines
what v4 is, the three trust domains it splits into, the boundary rules that must
never be violated, the locked design facts, and the shared contract that lets the
pieces talk. It is not a build instruction by itself. It is the map.

## What v4 is

CryptoCadet v4 is a Base-only, USDC-default crypto payment rail with agentic
capability. It lets an autonomous agent (or a human) pay for things and run
subscriptions inside hard, locally enforced limits, without exposing the wallet
where the money actually lives. It is its own business with its own landing page,
subscription plans, and enterprise clients. RetroDeck/RDK is the first and largest
consumer of the rail, not the only one, and v4 is not a RetroDeck-specific
component.

v4 is net-new. It does not share a database, a deployable, or a host with
CryptoCadet v3. v3 stays frozen and intact for its existing in-house clients. The
only thing crossing from v3 is a set of harvested correctness lessons (see
`v4-00-v3-review-and-harvest.md`).

## The three trust domains

These are three separate repos and three separate deployables, not three folders
in one app. They are separated on purpose so that a security property becomes a
physical fact rather than a matter of discipline.

| Domain | Repo (proposed) | Holds | Never holds |
|---|---|---|---|
| Client package | `cryptocadet-cli` (`@cryptocadet/cli`) | agent hot-wallet key, local policy, signer, agent MCP surface | the user's main wallet key |
| Server | `cryptocadet-server` (`/v4/` namespace) | postgres, quote issuance, on-chain verification, finalize, subscription pull engine | any private wallet key |
| Dashboard | `cryptocadet-dashboard` (Next.js) | authenticated views, write-through to server API | any key, any policy-write |

Proposed names are my call since you did not specify; rename freely, but keep the
three repos separate. The decisive reason for separate repos over a monorepo: the
server must be physically unable to import the signer. A separate repo guarantees
that. If you want an RDK-style monorepo for the client alone (e.g. `packages/cli`,
`packages/core`), that is fine, but the server stays out of it.

## Cardinal boundary rules (violations are defects, not preferences)

1. Private keys live ONLY in the client package, on the user's machine. Never in
   the server, never in the dashboard, never serialized over any API.
2. The user's MAIN wallet key appears in NO code path anywhere. The client holds
   only a dedicated agent hot-wallet key carrying a bounded float. Top-up from the
   main wallet is always a human action; nothing auto-drains the main wallet.
3. The server computes but is never trusted. The client independently re-validates
   every server-issued instruction against local policy before signing. A
   compromised or MITM'd server response must not be able to move funds.
4. Postgres is the single source of truth for products, pricing, preferences, and
   payout (receiving) addresses. The client and dashboard are both authenticated
   clients of it. There is no second authoritative copy of this data anywhere.
5. The ONLY locally authoritative state is keys + the local policy file. Policy is
   enforced locally and is the sole enforcement (no smart account, no on-chain
   caveat). The dashboard renders policy READ ONLY; policy is edited only via
   human-only CLI verbs on the machine that holds the keys.
6. Agent-facing MCP verbs never include key, limit, allowlist, rotate, or sweep
   operations. Those are human-only and are not registered on the agent transport.

## Locked design facts (consolidated)

- Network: Base only, represented as data (a `supported_networks` row), not as an
  API version. Asset: USDC default; other ERC-20s allowed per the local allowlist.
  No native-token spending. ERC-20 only.
- Custody: dedicated agent hot wallet + bounded float. Float is two buckets: a
  subscription reserve (untouchable by per-call spending) and a spendable working
  balance.
- Top-up: alert-and-approve or human batch pre-fund. No auto-drain from main.
- Payment shapes: PUSH for x402 per-call (agent signs and submits), ERC-20 PULL
  for subscriptions (capped `approve`/Permit2, vendor `transferFrom`). Native-token
  subscriptions are not offered.
- Pricing: USDC default is trivial. Arbitrary-token (pool-derived, liquidity-floored)
  pricing is a paid-for-later per-client capability, not built in v4 launch.
- SmartMoney and multi-chain optimization are dead. Do not reintroduce them.
- Roles are symmetric: an account can be both seller (receives) and buyer (pays).
  The client is one binary with two scoped config sections and two MCP surfaces.
- Revocation = rotate keypair + sweep float, sweep driven by on-chain balance
  discovery (every token), both first-class fast CLI verbs.
- The detached signer process unlocks its key via the OS keychain.
- The `pay` verb takes a server-issued quote id only, never a raw recipient/amount.

## Shared client/server contract (the only coupling between domains)

The client depends on the server through exactly three things. Stub these and the
client is fully buildable and testable before the server exists.

```typescript
// 1. The signed quote the server issues and the client verifies + executes.
//    serverSig is over a canonical serialization of every field except serverSig.
//    Signing key is a dedicated Ed25519 quote-signing key, NOT a wallet key.
export interface SignedQuote {
  quoteId: string;          // uuid v4
  chainId: 8453;            // Base mainnet (84532 on the testnet build)
  token: string;            // ERC-20 contract address, lowercased
  recipient: string;        // payout address, EIP-55 checksummed
  amount: string;           // token base units, decimal string (never a number)
  purpose: 'per_call' | 'subscription_setup';
  expiresAt: number;        // unix seconds; client rejects if past
  serverSig: string;        // Ed25519 signature, base64
}

// 2. The server's quote-signing PUBLIC key, pinned in the client config.
//    config.json: { "serverQuotePubKey": "<base64 ed25519 pubkey>" }

// 3. The finalize endpoint the client calls after a confirmed on-chain tx.
//    Idempotent on quoteId.
//    POST /v4/payments/finalize  { quoteId, txHash } -> { status: 'recorded' | 'duplicate' }
```

The client verifies `serverSig` against `serverQuotePubKey`, then re-validates the
quote against local policy, then signs the ERC-20 transfer, then calls finalize.
Provenance verification is defense-in-depth; the local policy re-check is the real
backstop, because a compromised server could sign a malicious-but-valid quote.

## Spec manifest and reading order

1. `v4-00-v3-review-and-harvest.md` — run against v3 first. Produces the
   confirmation-depth, idempotency, nonce/replay, and ERC-20-decimals lessons the
   server and client builds depend on. Prerequisite for both.
2. `v4-overview-architecture.md` — this file. Read before any component build.
3. `v4-client-package.md` — the installable CLI + agent wallet. Contains the
   signer as its core module.
   - `v4-01-local-signer-and-policy-engine.md` — the load-bearing module inside
     the client package. Build to its acceptance criterion (single signing call
     site gated on `evaluate().allow === true`).
4. `v4-server-quote-and-verify.md` — the hosted backend, `/v4/` namespace.
5. `v4-dashboard.md` — the Next.js read-only-policy client.

Build order: harvest, then client (against stubbed server contract) in parallel
with server, then dashboard once the server API exists. Client and server can be
built concurrently because their only coupling is the three-field contract above.
