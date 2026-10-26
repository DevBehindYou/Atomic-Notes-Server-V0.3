import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

let attempts = 0;
const denied = () => { attempts++; throw new Error('network forbidden in deployment smoke'); };
net.connect = net.createConnection = denied;
net.Socket.prototype.connect = denied;
tls.connect = denied;
http.request = http.get = https.request = https.get = denied;
dns.lookup = dns.resolve = denied;
dns.promises.lookup = dns.promises.resolve = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();

const entry = pathToFileURL(resolve(process.argv[2])).href;
if (process.argv[3] === 'invalid') {
  await assert.rejects(import(entry), error => {
    assert.match(error.message, /Invalid Server configuration:/);
    assert.match(error.message, /MONGODB_URI not set/);
    return true;
  });
} else {
  const { default: handler } = await import(entry);
  assert.equal(typeof handler.fetch, 'function');
  const health = await handler.fetch(new Request('https://atomic-notes-app-server-staging.vercel.app/api/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const admin = await handler.fetch(new Request('https://atomic-notes-app-server-staging.vercel.app/api/admin/health'));
  assert.equal(admin.status, 401);
  const missing = await handler.fetch(new Request('https://atomic-notes-app-server-staging.vercel.app/api/no-such-route'));
  assert.equal(missing.status, 404);
}
assert.equal(attempts, 0, 'import, health, and unauthenticated routes must not contact MongoDB or Google');
console.log('entrypoint smoke passed with network blocked');
