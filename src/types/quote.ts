// The shared client/server contract. The server COMPUTES quotes and signs them with
// a dedicated Ed25519 quote-signing key (NOT a wallet key). The client verifies the
// signature for provenance, then RE-VALIDATES every field against local policy before
// signing anything. The server is never trusted to be correct or uncompromised.

export type QuotePurpose = 'per_call' | 'subscription_setup';

/** The signed quote the server issues and the client verifies + executes.
 *  serverSig is over a canonical serialization of every field EXCEPT serverSig. */
export interface SignedQuote {
  quoteId: string; // uuid v4
  chainId: 8453 | 84532; // Base mainnet (84532 on the testnet build)
  token: string; // ERC-20 contract address, lowercased
  recipient: string; // payout address, EIP-55 checksummed
  amount: string; // token base units, decimal string (never a number)
  purpose: QuotePurpose;
  expiresAt: number; // unix seconds; client rejects if past
  serverSig: string; // Ed25519 signature, base64
}

/** The fields, minus the signature, over which serverSig is computed. The canonical
 *  serialization MUST be identical on both sides; the server signs exactly this. */
export type UnsignedQuote = Omit<SignedQuote, 'serverSig'>;

/** The minimal shape the policy engine evaluates. Built from a verified SignedQuote. */
export interface QuoteForPolicy {
  quoteId: string;
  token: string; // contract address
  recipient: string; // payout address
  amount: string; // base units, decimal string
  chainId: number;
}
