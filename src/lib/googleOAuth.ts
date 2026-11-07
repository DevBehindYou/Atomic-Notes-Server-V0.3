import { google } from 'googleapis';

// drive.file, not drive/drive.readonly: the app can only see and manage files it
// creates itself. This is deliberate — it keeps the OAuth consent screen honest
// ("this app can only touch its own notes, not your whole Drive") and it keeps the
// app out of Google's restricted-scope verification/CASA assessment process, which
// full Drive access would require once you have real users.
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * A second client, deliberately built with NO redirect_uri. Native mobile
 * sign-in (the Flutter app's `google_sign_in` package, configured with
 * `serverClientId`) hands back a one-time `serverAuthCode` instead of a web
 * redirect's `code` — but Google's token endpoint still checks the
 * redirect_uri used at exchange time against the one used to obtain the
 * code, and a native sign-in used none. Exchanging a serverAuthCode with
 * the redirect-configured client above fails with redirect_uri_mismatch;
 * this is the fix, not a duplicate for its own sake.
 */
export function getOAuthClientForServerAuthCode() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
}

export function getAuthUrl(state: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    // prompt: 'consent' forces Google to hand back a refresh_token even if the user
    // has authorized this app before — without it, a returning user's second login
    // silently omits the refresh_token and background sync breaks.
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export async function exchangeCode(code: string) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Bound on each request to Google's token endpoint. The OAuth library sets no
 * timeout of its own, so a stalled refresh held a push or pull, and its per-user
 * notes lock, until the platform ended the function. Drive requests set their own.
 */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10000;

/** Test seam only: send every Google request to a loopback origin. Production callers pass nothing. */
export type GoogleTransportOverrides = { origin?: string };
type Adapter = NonNullable<NonNullable<ConstructorParameters<typeof google.auth.OAuth2>[0] & object>['transporterOptions']>['adapter'];

/** Rewrites token, Drive and Drive upload URLs to [origin], keeping path and query. */
export function loopbackAdapter(origin: string): Adapter {
  return (options, next) => {
    const url = new URL(options.url);
    options.url = new URL(`${url.pathname}${url.search}`, origin);
    return next(options);
  };
}

/**
 * The OAuth client behind Server-side Drive work and token refresh, including the
 * refresh the Drive library makes by itself after a 401/403. Sign-in uses [getOAuthClient].
 */
export function getTokenRefreshClient(overrides: GoogleTransportOverrides = {}) {
  return new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    // One client serves all of a request's Drive calls (driveSession). After a refresh it holds an expiry,
    // and without this flag a 401 for a call that was sent with the old token before the refresh would
    // fail instead of refreshing and replaying once, as every call did when each built its own client.
    forceRefreshOnFailure: true,
    // Requests that set their own timeout (every Drive call) keep it; this bounds the token requests.
    transporterOptions: { timeout: GOOGLE_TOKEN_TIMEOUT_MS,
      ...(overrides.origin ? { adapter: loopbackAdapter(overrides.origin) } : {}) },
  });
}

export async function refreshAccessToken(refreshToken: string, overrides: GoogleTransportOverrides = {}) {
  const client = getTokenRefreshClient(overrides);
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials;
}

/** True when Google says the stored refresh token no longer works (revoked, or expired after 7 days in Testing). */
export function isInvalidGrant(error: unknown): boolean {
  const e = error as { message?: string; response?: { data?: { error?: string } } } | null;
  return e?.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(e?.message ?? '');
}

export type GoogleProfile = { sub?: string; email?: string; email_verified?: boolean; name?: string };

/** OpenID Connect userinfo for an access token this Server obtained itself. Null if Google refuses. */
export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile | null> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000),
  });
  return response.ok ? await response.json() as GoogleProfile : null;
}
