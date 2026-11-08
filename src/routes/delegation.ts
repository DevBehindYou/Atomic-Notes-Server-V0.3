import { Hono } from 'hono';
import { delegationVerifyFromEnv } from '../lib/capabilities.js';
import { DELEGATION_CONTRACT, DELEGATION_CONTRACT_VERSION, verifyDelegationAssertion,
  type DelegationVerifierOptions } from '../lib/delegation.js';

const MAX_BODY_BYTES = 4096;
const JSON_MEDIA_TYPE = /^application\/json\s*(;|$)/i;

/**
 * Reads at most [maxBytes] of a request body before anything else sees it, or null. A declared
 * Content-Length over the cap (or not a plain decimal) is refused unread. Otherwise bytes are counted
 * as they stream in: the read stops and the stream is cancelled as soon as the count passes the cap,
 * or passes a smaller declared length, so an oversized, chunked or falsely declared body is never
 * buffered past it. The bytes must be well-formed UTF-8; nothing is replaced with U+FFFD.
 */
async function readBoundedBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(/^\d{1,16}$/.test(declared) && Number(declared) <= maxBytes)) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return '';
  const limit = declared === null ? maxBytes : Number(declared);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    return null;
  }
}

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
    const text = await readBoundedBody(c.req.raw);
    if (text === null) return invalid();
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
