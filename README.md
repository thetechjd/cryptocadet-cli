# @cryptocadet/cli — Local Signer + Policy Engine (v4 Instruction 01)

The buyer-side spending component of CryptoCadet v4. Holds a **dedicated agent hot
wallet** with a bounded float, enforces a **local policy** as the *sole* spending
control (no smart account, no on-chain caveat enforcer), and signs ERC-20 payments on
**Base**. The user's **main wallet key never enters this package** in any code path.

> This is the CLIENT package. The cryptocadet **server holds no keys and must never
> import this module.**

## The load-bearing guarantee

Every signing decision passes through [`evaluate()`](src/policy/evaluate.ts) — pure,
synchronous, **fail-closed** (any error/missing field/unparseable amount ⇒ DENY). There
is **exactly one** signing call site for the agent payment path, and it is gated on
`gate.allow === true`:

- The gate + single broadcast live in [`PaymentSigner.pay()`](src/signer/signer.ts).
- The real key-signing primitive (`sendTransfer`) is wired in exactly one place,
  [`liveBroadcaster`](src/signer/live-broadcaster.ts), which is the production tail of
  that single gated path.
- [`test/single-gate.test.ts`](test/single-gate.test.ts) proves this by source
  inspection — add a second payment-signing path and it fails.

The only other transaction-signing path is [`sweep`](src/revoke/sweep.ts) — the
human-only revocation drain, never registered on the agent transport.

## Trust model & blast radius

The detached signer unlocks the agent key from the **OS keychain** (one OS
authorization) and holds the plaintext only in process memory for the session — never
on disk. Anything that can read this process's memory while it runs can obtain the agent
key. **This is why the float is bounded: the blast radius is the float, never the main
wallet.** Top-up from the main wallet is always a human action; nothing auto-drains it.

## Locked decisions

- **Network:** Base only (8453 mainnet / 84532 Sepolia). **Asset:** USDC default, other
  ERC-20s per the local allowlist. **No native-token spending, ever.**
- **Fee-on-transfer tokens: rejected at allowlist time** (`edit_allowlist` refuses
  them; `evaluate()` refuses them as a backstop). Settlement would otherwise
  under-deliver.
- **Subscription floor:** spendable = `balance − subscriptionReserve`. Per-call payments
  may never cross the reserve (`evaluate()` step 6).
- **`pay` takes a server-issued `quoteId` only** — never a raw recipient/amount. A
  poisoned "pay 0xattacker" instruction has no quote to ride on, and a forged quote
  fails the recipient allowlist.
- **Revoke = `rotate` + `sweep`.** Sweep is **balance-discovery-driven** (inbound
  Transfer-log scan), so a forgotten long-tail token is drained too; native gas is
  drained last.

## Surfaces

The client is one binary (`cryptocadet`, alias `ccx`) serving both roles — an account can
be both buyer and seller. Commands are grouped on two axes: local-vs-remote state, and
agent-exposed-vs-human-only.

**Agent-facing MCP (exactly four verbs — [`AGENT_TOOL_NAMES`](src/mcp/agent-tools.ts)):**
`check_balance`, `quote_payment`, `pay`, `dry_run`. Wired in [runtime.ts](src/runtime.ts)
via `buildAgentTools` only; [test/command-surface.test.ts](test/command-surface.test.ts)
proves the two surfaces are disjoint.

**LOCAL state — human-only (keys + policy, never leave the machine):** `init`,
`wallet:show`, `policy:show`, `policy:set` (caps/reserve/escalation), `allowlist:add`/
`allowlist:remove` (tokens + recipients), `topup:request` (human-approved, no auto-drain),
`rotate` (`--and-sweep --to`), `sweep --to <addr>`, `reserve:check`.

**REMOTE state — server postgres via authenticated API (seller/buyer, no key risk):**
`login`/`logout`, `product:list|create|update|disable`, `payout:set`,
`subs:list|create|cancel`, `history`.

**`mcp:serve [--detach|--stop|--status]`** — RDK detach pattern: PID file under
`~/.cryptocadet`, keychain unlock on detached start, clean stop/status.

## Two secrets, two keychain entries

The **agent wallet key** (`keychainRef`) and the **server credential** (`serverAuthRef`,
API key or JWT) are different secrets with different blast radii and live in **separate**
OS-keychain entries. The server credential is never written to a plaintext dotfile.
Heavy/native/optional deps (e.g. `keytar`) install **on first use** via
[`requireDep`](src/util/require-dep.ts), never at package-install time.

## On-disk layout — `~/.cryptocadet/`

`agent.key.enc` (AES-256-GCM, data key in OS keychain) · `policy.json` (sole
enforcement) · `ledger.sqlite` (idempotency + pending-tx) · `config.json` (non-secret).

## Build / test

```bash
pnpm install
pnpm typecheck     # tsc --noEmit, strict
pnpm test          # vitest — adversarial diagnostics 1–14
pnpm build         # emits dist/, bin: cryptocadet
```

Requires Node ≥ 22.5 (built-in `node:sqlite`). No native modules; the OS keychain is
reached via `keytar` if present, else the platform CLI (`secret-tool`/`security`).
