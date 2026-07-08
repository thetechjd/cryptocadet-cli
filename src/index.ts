// @cryptocadet/cli public surface. The policy engine is the load-bearing export.

export { evaluate } from './policy/evaluate.js';
export type { Decision, PolicyContext } from './policy/evaluate.js';
export type { Policy, AllowedToken } from './types/policy.js';
export { emptyPolicy } from './types/policy.js';
export type { SignedQuote, UnsignedQuote, QuoteForPolicy, QuotePurpose } from './types/quote.js';
export { verifyQuote } from './quote/verify.js';
export { canonicalQuoteBytes, stripSig } from './quote/canonical.js';
export { PaymentSigner } from './signer/signer.js';
export type { PayResult, PayOptions, SignerDeps, Broadcaster, BroadcastResult } from './signer/signer.js';
export { Ledger } from './ledger/ledger.js';
export type { PaymentRow, PaymentStatus } from './ledger/ledger.js';
export { reconcilePending } from './signer/reconcile.js';
export { reserveCheck } from './subscription/reserve.js';
export { sweep, discoverTokens } from './revoke/sweep.js';
export { rotate } from './revoke/rotate.js';
export { AGENT_TOOL_NAMES, buildAgentTools } from './mcp/agent-tools.js';
export type { AgentToolName } from './mcp/agent-tools.js';
export { buildRuntime } from './runtime.js';
export { httpServerClient } from './server/client.js';
export type { QuoteClient, ServerClient, SellerClient, Product, Subscription, HistoryItem, AuthProvider, BalanceSnapshot, TopupAlertInput } from './server/client.js';
export { dashboardSync, buildBalanceSnapshots, buildTopupAlerts } from './dashboard/sync.js';
export type { SyncReport } from './dashboard/sync.js';
export { buildMcpServer, connectStdio } from './mcp/mcp-server.js';
export {
  fetchWithPayment,
  parseChallenge,
  selectRequirement,
  requirementChainId,
  buildPaymentProof,
} from './x402/x402.js';
export type { PaymentRequirement, Challenge402, X402Deps, X402Result, PaySettlement } from './x402/x402.js';
export { grantSubscriptionApproval, revokeSubscriptionApproval, validateGrant } from './subscription/grant.js';
export type { GrantDeps, GrantRequest, GrantReport } from './subscription/grant.js';
export { executePull, runCollectorOnce } from './collector/executor.js';
export type { PullInstruction, ExecutorDeps, ExecOutcome, PullClient, TickSummary } from './collector/executor.js';
export { collectorClient } from './collector/internal-client.js';
export { collectorInit, collectorServeOnce, collectorServeLoop } from './collector/serve.js';
export { renderBanner, colorSupported, BRAND } from './brand/banner.js';
export { runInit, refuseMainWalletKey } from './init/wizard.js';
export type { InitOptions, InitSummary, WizardIO, Role, Network } from './init/wizard.js';
export { scaffoldPolicy, USDC_BY_CHAIN } from './init/policy-scaffold.js';
export { checkNode, detectKeychainBackend, detectExistingInstall } from './init/preflight.js';
export { registerWithHost, detectMcpHosts, manualSnippet, buildServerEntry } from './init/mcp-host.js';
export { storeCredential, readCredential, clearCredential, authHeader } from './server/auth.js';
export type { StoredCredential, CredentialKind } from './server/auth.js';
export { buildTopupRequest } from './topup/topup.js';
export type { TopupRequest, TopupTarget } from './topup/topup.js';
export { requireDep } from './util/require-dep.js';
export * as mcpLifecycle from './mcp/lifecycle.js';
