// Sign the CLI in with a CryptoCadet web account (email + password). Same exchange as the
// web login at cryptocadet.app/v4/login: the identity API returns a JWT for the password,
// then the account's v4 API key for the JWT. The CLI stores that key in the OS keychain,
// so the web dashboard and the CLI act as one account. The password is sent once over
// HTTPS and never stored.

export const DEFAULT_IDENTITY_URL = 'https://apiv3.cryptocadet.app/api';

export function identityUrl(): string {
  return (process.env.CRYPTOCADET_IDENTITY_URL || DEFAULT_IDENTITY_URL).replace(/\/$/, '');
}

export class AccountLoginError extends Error {
  constructor(
    message: string,
    readonly code: 'BAD_CREDENTIALS' | 'UNVERIFIED' | 'UNREACHABLE' | 'NO_KEY',
  ) {
    super(message);
  }
}

export async function loginWithPassword(
  email: string,
  password: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const base = (opts.baseUrl ?? identityUrl()).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  let jwt: string;
  try {
    const res = await doFetch(`${base}/user/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    const data = (await res.json().catch(() => ({}))) as { sessionToken?: string; message?: string };
    if (!res.ok || !data.sessionToken) {
      if (/not verified/i.test(data.message ?? '')) {
        throw new AccountLoginError('confirm your email first: we just sent you a new link', 'UNVERIFIED');
      }
      throw new AccountLoginError('wrong email or password', 'BAD_CREDENTIALS');
    }
    jwt = data.sessionToken;
  } catch (e) {
    if (e instanceof AccountLoginError) throw e;
    throw new AccountLoginError(`sign-in service unreachable (${(e as Error).message})`, 'UNREACHABLE');
  }
  let apiKey = '';
  try {
    const res = await doFetch(`${base}/user/v4-session`, { headers: { authorization: `Bearer ${jwt}` } });
    if (res.ok) apiKey = String(((await res.json()) as { apiKey?: string }).apiKey ?? '');
  } catch (e) {
    throw new AccountLoginError(`sign-in service unreachable (${(e as Error).message})`, 'UNREACHABLE');
  }
  if (!apiKey) throw new AccountLoginError('signed in, but the account could not be set up; try again shortly', 'NO_KEY');
  return apiKey;
}
