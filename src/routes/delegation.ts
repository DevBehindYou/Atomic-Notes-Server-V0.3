import { Hono } from 'hono';
import { delegationVerifyFromEnv } from '../lib/capabilities.js';
import { DELEGATION_CONTRACT, DELEGATION_CONTRACT_VERSION, verifyDelegationAssertion,
  type DelegationVerifierOptions } from '../lib/delegation.js';

const MAX_BODY_BYTES = 4096;
const JSON_MEDIA_TYPE = /^application\/json\s*(;|$)/i;

/**
 * POST /api/delegation/verify (C38), DISABLED. With the gate off nothing is registered,
 * so the path is the app's ordinary unknown-route 404. With the gate on but no verifier
 * wiring (the deployed default: no keys, replay store or subject records exist) it
 * answers 503. It reads no session, wallet, Energy or billing state and is not wired
 * to any notes route: a verified assertion authorizes nothing by itself yet.
 *
 * Only the `assertion` field is read. Any caller-supplied `accountId`, user id or
 * token is ignored; the account comes from the verified claims re-checked against the
 * App Server's own record. The response never echoes the assertion or any token.
 */
export function createDelegationRoute(options: { enabled?: boolean; verifier?: DelegationVerifierOptions } = {}) {
  const route = new Hono();
  if (!(options.enabled ?? delegationVerifyFromEnv())) return route;
  route.post('/verify', async c => {
    c.header('Cache-Control', 'no-store');
    if (!options.verifier) return c.json({ error: 'delegation_unavailable' }, 503);
    const invalid = () => c.json({ error: 'delegation_request_invalid' }, 400);
    if (!JSON_MEDIA_TYPE.test(c.req.header('content-type') ?? '')) return invalid();
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return invalid();
    let body: unknown;
    try { body = JSON.parse(text); } catch { return invalid(); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
    const result = await verifyDelegationAssertion((body as Record<string, unknown>).assertion, options.verifier);
    if (!result.ok) return c.json({ error: result.error }, 401);
    const { iss, sub, scope, exp } = result.claims;
    return c.json({ verified: true, contract: DELEGATION_CONTRACT, version: DELEGATION_CONTRACT_VERSION, iss, sub, scope, exp });
  });
  return route;
}

export default createDelegationRoute();
