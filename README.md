# @cryptocadet/cli — Local Signer + Policy Engine (v4 Instruction 01)

The buyer-side spending component of CryptoCadet v4. Holds a **dedicated agent hot
wallet** with a bounded float, enforces a **local policy** as the *sole* spending
control (no smart account, no on-chain caveat enforcer), and signs ERC-20 payments on
**Base**. The user's **main wallet key never enters this package** in any code path.

> This is the CLIENT package. The cryptocadet **server holds no keys and must never
> import this module.**

## Install

```
Linux / macOS:  curl -fsSL https://cryptocadet.app/install.sh | sh
macOS (brew):   brew install thetechjd/cryptocadet-cli/cryptocadet
Node (any):     npm i -g @cryptocadet/cli
```

The curl installer sets up a private, SHA256-verified Node 24 under `~/.cryptocadet-cli` and
installs this npm package (the same one brew and npm install). The npm channel needs
Node >= 22.5 (built-in `node:sqlite`). Windows: `install.ps1` or npm. The installer source is
[install.sh](install.sh); the copy served at cryptocadet.app lives in the v2 frontend's
`public/` and must be kept in sync.

## Quick start

```bash
cryptocadet init                      # creates an empty agent wallet on Base mainnet
```

Fund the agent one of two ways:

```bash
# 1. Crypto: send USDC (and a little ETH for gas) on Base to the printed agent address.

# 2. Card: sign in with your cryptocadet.app account, buy credits, give the agent a capped token.
cryptocadet login                     # same email + password as cryptocadet.app/v4/signup
cryptocadet credits:buy --usd 5       # opens Stripe Checkout
cryptocadet agent-token:create --name my-agent --per-call-usd 2 --daily-usd 5
```

Then pay for anything behind a CryptoCadet 402:

```bash
cryptocadet fetch https://api.v4.cryptocadet.app/v4/g/<seller>/<item>
```

`fetch` tries card credits first (only towards the CryptoCadet server), then USDC from the
agent wallet within local policy: $1 per payment and $5 per day by default, and each seller
allowlisted once (`fetch` prints the exact `allowlist:add` command when it refuses).

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

## Commands

One binary (`cryptocadet`, alias `ccx`); an account can be both buyer and seller. Agents use
the same CLI (e.g. `cryptocadet fetch`) or the library (`paidFetch`, `fetchWithPayment`).

**Pay:** `fetch <url> [--method M] [--data D] [--header 'K: V'] [--approve]` — fetch a URL and
settle its 402. `checkout --quote-json <json> | --quote-file <path> [--allowlist-recipient]
[--approve]` — pay a full merchant-supplied `SignedQuote` (a merchant's own server account
issues it, so the buyer can't re-fetch it by id). Both pay USDC only through the **same gated
`PaymentSigner.pay()`**: serverSig re-verified against the pinned pubkey, every field
re-checked against local policy, then the single broadcast. `--approve` confirms a payment
above a `requireHumanAbove` threshold if you set one (none by default).

**Card credits:** `credits:show`, `credits:buy --usd N`, `credits:verify --session <id>`,
`agent-token:create --name N [--per-call-usd X] [--daily-usd Y] [--sellers a,b]`,
`agent-token:list`, `agent-token:revoke --id`, `agent-token:clear`.

**Wallet + policy (local, never leave the machine):** `init`, `wallet:show`, `policy:show`,
`policy:set` (caps/reserve/escalation), `allowlist:add`/`allowlist:remove` (tokens +
recipients), `topup:request`, `rotate` (`--and-sweep --to`), `sweep --to <addr>`,
`reserve:check`.

**Account:** `login` (your cryptocadet.app email + password; `--email` to skip the prompt,
`CRYPTOCADET_PASSWORD` for scripts, or `--value <api key>` to store a raw key), `logout`.

**Seller (server API, no key risk):** `handle:set`,
`product:list|create|update|disable` (`product:create --slug --kind hosted|proxy --usd
--content-file` puts an item behind the 402 gateway), `payout:set`, `subs:list|create|cancel`,
`history`.

**Operators:** `collector:init|serve` (subscription pulls), `treasury:init|serve` (USDC
payouts of card-funded earnings).

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
