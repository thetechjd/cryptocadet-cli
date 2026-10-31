// CryptoCadetRouter deployments the client will pay through. Pinned HERE, not taken from
// the server: a routed quote names its router, and a compromised server could otherwise
// point an agent's approval at any contract. Base Sepolia has no deployment (direct pay).
//
// The router's payWithToken(payee, token, amount) pulls `amount` from the caller and sends
// the platform fee to the router owner and the rest to payee in the same tx; it never
// holds funds, and it can only pull from msg.sender, so nobody else can spend an approval.

export const KNOWN_ROUTERS: Readonly<Partial<Record<number, string>>> = {
  8453: '0xffe91f1582080c85f7651fa32de2186df1b9343b',
};

export function isKnownRouter(chainId: number, router: string): boolean {
  const known = KNOWN_ROUTERS[chainId];
  return known !== undefined && known === router.toLowerCase();
}
