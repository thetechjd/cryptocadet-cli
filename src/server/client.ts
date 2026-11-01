// The client's coupling to the cryptocadet server.
//
// QuoteClient is the narrow money-path contract (the three fields from the architecture
// overview) the agent surface depends on. ServerClient extends it with the SELLER /
// REMOTE catalog + subscription + history endpoints — none of which are locally
// authoritative: they are a CLI front-end over the server's postgres, written through
// the authenticated API. The client verifies serverSig and RE-VALIDATES quotes against
// local policy regardless of what the server says — the server is never trusted.

import type { SignedQuote, QuotePurpose } from '../types/quote.js';

export interface QuoteRequest {
  token: string;
  recipient: string;
  amount?: string; // server may compute; per-call pricing is server-owned
  purpose: QuotePurpose;
}

/** Narrow money-path contract used by the agent tools + signer. */
export interface QuoteClient {
  requestQuote(req: QuoteRequest): Promise<SignedQuote>;
  getQuoteById(quoteId: string): Promise<SignedQuote>;
  finalize(quoteId: string, txHash: string): Promise<{ status: 'recorded' | 'duplicate' }>;
}

// ---- SELLER / REMOTE domain (authoritative copy lives in server postgres) ----

export interface Product {
  id: string;
  name: string;
  /** token contract address, lowercased */
  token: string;
  /** unit price in token base units, decimal string (never a number) */
  unitPrice: string;
  active: boolean;
  /** gateway items: the URL slug (/v4/g/<handle>/<slug>) */
  slug?: string | null;
  visibility?: 'paid' | 'free' | 'private';
}

export interface Subscription {
  id: string;
  token: string;
  /** per-pull amount, base units */
  amount: string;
  /** seconds between pulls */
  interval: number;
  status: 'active' | 'cancelled';
}

export interface HistoryItem {
  quoteId: string;
  token: string;
  recipient: string;
  amount: string;
  txHash: string | null;
  status: string;
  at: number;
}

/** A read-only balance snapshot the client pushes for dashboard display. */
export interface BalanceSnapshot {
  token: string;
  symbol: string;
  decimals: number;
  balance: string; // base units
  reserve: string; // base units
  spendable: string; // base units
}

/** A low-float alert the client raises for the dashboard. */
export interface TopupAlertInput {
  token: string;
  symbol: string;
  agentAddress: string;
  shortfall: string; // base units
}

/** Fields that put a product behind the 402 gateway at /v4/g/<handle>/<slug>. */
export interface GatewayProductFields {
  slug?: string;
  kind?: 'hosted' | 'proxy';
  visibility?: 'paid' | 'free' | 'private';
  description?: string;
  /** hosted: the content served after payment */
  content?: string;
  contentType?: string;
  /** proxy: the seller's https origin */
  originUrl?: string;
}

/** A private item shared with one person (they pay with card credits). */
export interface Grant {
  id: string;
  email: string;
  mode: 'unlock' | 'per_query';
  /** unlock mode: whether they have paid their one-time unlock */
  unlocked: boolean;
  createdAt: number;
}

export interface SellerClient {
  listProducts(): Promise<Product[]>;
  /** `token` omitted → the chain's USDC (required for gateway products). */
  createProduct(p: { name: string; token?: string; unitPrice: string } & GatewayProductFields): Promise<Product>;
  /** Claim the seller handle used in gateway URLs (/v4/g/<handle>/<slug>). */
  setHandle(handle: string): Promise<{ id: string; handle: string }>;
  /** Private items: share with one person by email (pay once to unlock, or per query). */
  listGrants(productId: string): Promise<Grant[]>;
  addGrant(productId: string, email: string, mode: 'unlock' | 'per_query'): Promise<Grant>;
  revokeGrant(productId: string, grantId: string): Promise<{ id: string; revoked: boolean }>;
  /** The HMAC secret proxied calls to your origin are signed with (X-CryptoCadet-Signature). */
  originSecret(): Promise<{ originSecret: string }>;
  rotateOriginSecret(): Promise<{ originSecret: string }>;
  updateProduct(id: string, patch: Partial<Pick<Product, 'name' | 'unitPrice' | 'active'>>): Promise<Product>;
  disableProduct(id: string): Promise<Product>;
  setPayout(token: string, address: string): Promise<{ token: string; address: string }>;
  listSubs(): Promise<Subscription[]>;
  createSub(s: { token: string; amount: string; interval: number }): Promise<Subscription>;
  cancelSub(id: string): Promise<Subscription>;
  history(): Promise<HistoryItem[]>;
  // ---- read-only display snapshots pushed FOR the dashboard ----
  /** Push the local policy as a display-only snapshot. The server is NOT authoritative;
   *  policy stays editable only via the CLI. */
  putPolicy(policy: unknown): Promise<{ ok: true; updatedAt: number }>;
  putBalances(balances: BalanceSnapshot[]): Promise<{ ok: true; count: number; updatedAt: number }>;
  raiseTopupAlerts(alerts: TopupAlertInput[]): Promise<{ ok: true; count: number }>;
}

// ---- BUYER domain: card-funded credits + agent spend tokens ----

export interface CreditsSummary {
  /** micro-USD available to agents */
  credits: string;
  /** micro-USD earned as a seller, awaiting payout */
  earnings: string;
  entries: Array<{ id: string; bucket: string; kind: string; amount: string; ref: string | null; at: number }>;
}

export interface AgentTokenInfo {
  id: string;
  name: string;
  perCallCap: string | null;
  dailyCap: string | null;
  allowedSellers: string[] | null;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface BuyerClient {
  credits(): Promise<CreditsSummary>;
  /** Start a Stripe Checkout top-up; `amount` in micro-USD. Returns the URL to pay at. */
  creditsCheckout(amount: string): Promise<{ sessionId: string; url: string; amount: string }>;
  /** Settle a Checkout session (fallback if the webhook hasn't landed yet). */
  creditsVerify(sessionId: string): Promise<{ status: string; amount?: string }>;
  /** Issue an agent spend token (caps in micro-USD). The raw token is returned ONCE. */
  createAgentToken(t: { name: string; perCallCap?: string; dailyCap?: string; allowedSellers?: string[] }): Promise<AgentTokenInfo & { token: string }>;
  listAgentTokens(): Promise<AgentTokenInfo[]>;
  revokeAgentToken(id: string): Promise<AgentTokenInfo>;
}

export type ServerClient = QuoteClient & SellerClient & BuyerClient;

/** Resolves the Authorization header value, or null when unauthenticated. */
export type AuthProvider = () => Promise<string | null>;

/** HTTP implementation against the `/v4/` namespace. REMOTE endpoints attach the auth
 *  header (from the OS-keychain-backed credential); the quote endpoints attach it too
 *  when present (quote_payment is authenticated). */
export function httpServerClient(baseUrl: string, getAuth?: AuthProvider): ServerClient {
  const base = baseUrl.replace(/\/$/, '');

  async function req<T>(path: string, init: RequestInit = {}, requireAuth = false): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
    const auth = getAuth ? await getAuth() : null;
    if (auth) headers['authorization'] = auth;
    else if (requireAuth) throw new Error('not authenticated: run `cryptocadet login` first');
    const r = await fetch(`${base}${path}`, { ...init, headers });
    if (!r.ok) {
      // Surface the server's reason ({ error, code }) — "failed: 422" alone is undebuggable.
      let detail = '';
      try {
        const b = (await r.json()) as { error?: string; code?: string };
        detail = [b.code, b.error].filter(Boolean).join(': ');
      } catch {
        /* non-JSON body */
      }
      throw new Error(`${init.method ?? 'GET'} ${path} failed: ${r.status}${detail ? ` (${detail})` : ''}`);
    }
    return (await r.json()) as T;
  }

  return {
    // ---- money path ----
    requestQuote: (body) => req('/v4/quotes', { method: 'POST', body: JSON.stringify(body) }, true),
    getQuoteById: (quoteId) => req(`/v4/quotes/${encodeURIComponent(quoteId)}`, {}, true),
    finalize: (quoteId, txHash) => req('/v4/payments/finalize', { method: 'POST', body: JSON.stringify({ quoteId, txHash }) }, true),

    // ---- seller / remote (write-through to postgres) ----
    listProducts: () => req('/v4/products', {}, true),
    createProduct: (p) => req('/v4/products', { method: 'POST', body: JSON.stringify(p) }, true),
    updateProduct: (id, patch) => req(`/v4/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, true),
    setHandle: (handle) => req('/v4/accounts/me', { method: 'PATCH', body: JSON.stringify({ handle }) }, true),
    listGrants: (productId) => req(`/v4/products/${encodeURIComponent(productId)}/grants`, {}, true),
    addGrant: (productId, email, mode) =>
      req(`/v4/products/${encodeURIComponent(productId)}/grants`, { method: 'POST', body: JSON.stringify({ email, mode }) }, true),
    revokeGrant: (productId, grantId) =>
      req(`/v4/products/${encodeURIComponent(productId)}/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' }, true),
    originSecret: () => req('/v4/accounts/me/origin-secret', {}, true),
    rotateOriginSecret: () => req('/v4/accounts/me/origin-secret/rotate', { method: 'POST' }, true),
    disableProduct: (id) => req(`/v4/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }, true),
    setPayout: (token, address) => req('/v4/payout', { method: 'PUT', body: JSON.stringify({ token, address }) }, true),
    listSubs: () => req('/v4/subscriptions', {}, true),
    createSub: (s) => req('/v4/subscriptions', { method: 'POST', body: JSON.stringify(s) }, true),
    cancelSub: (id) => req(`/v4/subscriptions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, true),
    history: () => req('/v4/payments/history', {}, true),

    // ---- read-only display snapshots pushed for the dashboard ----
    putPolicy: (policy) => req('/v4/policy', { method: 'PUT', body: JSON.stringify(policy) }, true),
    putBalances: (balances) => req('/v4/balances', { method: 'PUT', body: JSON.stringify(balances) }, true),
    raiseTopupAlerts: (alerts) => req('/v4/topup/alerts', { method: 'POST', body: JSON.stringify({ alerts }) }, true),

    // ---- buyer: credits + agent tokens ----
    credits: () => req('/v4/credits', {}, true),
    creditsCheckout: (amount) => req('/v4/credits/checkout', { method: 'POST', body: JSON.stringify({ amount }) }, true),
    creditsVerify: (sessionId) => req('/v4/credits/verify', { method: 'POST', body: JSON.stringify({ sessionId }) }, true),
    createAgentToken: (t) => req('/v4/agents', { method: 'POST', body: JSON.stringify(t) }, true),
    listAgentTokens: () => req('/v4/agents', {}, true),
    revokeAgentToken: (id) => req(`/v4/agents/${encodeURIComponent(id)}/revoke`, { method: 'POST' }, true),
  };
}
