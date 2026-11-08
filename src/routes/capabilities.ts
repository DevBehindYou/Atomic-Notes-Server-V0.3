import { Hono } from 'hono';
import {
  CAPABILITY_HEADER, buildCapabilityDocument, capabilityResponse, delegationVerifyFromEnv, logoutSyncFromEnv,
} from '../lib/capabilities.js';

/**
 * GET /api/capabilities. Public and session-free like /api/health: it reads no database,
 * session, account or wallet, and describes contract versions only. Declarations sent
 * here are not remembered and change no other route.
 */
export function createCapabilitiesRoute(options: { logoutSync?: boolean; delegation?: boolean } = {}) {
  const document = buildCapabilityDocument({
    logoutSync: options.logoutSync ?? logoutSyncFromEnv(),
    delegation: options.delegation ?? delegationVerifyFromEnv(),
  });
  const route = new Hono();
  route.get('/', c => {
    const { status, body } = capabilityResponse(document, c.req.header(CAPABILITY_HEADER));
    c.header('Cache-Control', 'no-store');
    c.header('Vary', CAPABILITY_HEADER);
    return c.json(body, status);
  });
  return route;
}

export default createCapabilitiesRoute();
