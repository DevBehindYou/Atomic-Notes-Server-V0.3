import assert from 'node:assert/strict';
import test from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { readLogoutRecoveryBody, LOGOUT_RECOVERY_BODY_BYTES } from '../src/lib/logoutRecoveryBody.js';

const request = (body?: BodyInit) => new Request('http://localhost/fixture', { method: 'POST', body });
const refused = async (operation: Promise<unknown>, status: number, code: string) => {
  try { await operation; assert.fail('Expected bounded body refusal'); }
  catch (error) {
    assert.ok(error instanceof HTTPException); assert.equal(error.status, status);
    assert.deepEqual(await error.getResponse().json(), { error: code });
  }
};

test('recovery body accepts the maximum bounded manifest', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const body = { attemptId: id, previousSessionHash: 'a'.repeat(64),
    batches: Array.from({ length: 5 }, () => ({ requestId: id, fingerprint: 'b'.repeat(64),
      rowIds: Array.from({ length: 50 }, () => id), wireBytes: 2500000 })) };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < LOGOUT_RECOVERY_BODY_BYTES);
  assert.deepEqual(await readLogoutRecoveryBody(request(JSON.stringify(body))), body);
});
test('recovery body accepts exactly the byte boundary', async () => {
  assert.deepEqual(await readLogoutRecoveryBody(request('{}' + ' '.repeat(LOGOUT_RECOVERY_BODY_BYTES - 2))), {});
});
test('oversized stream is canceled even with a false Content-Length', async () => {
  let canceled = 0, pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(LOGOUT_RECOVERY_BODY_BYTES + 1)); },
    cancel() { canceled++; },
  });
  const r = new Request('http://localhost/fixture', { method: 'POST', body: stream,
    headers: { 'content-length': '0' }, duplex: 'half' } as RequestInit & { duplex: 'half' });
  await refused(readLogoutRecoveryBody(r), 413, 'logout_recovery_payload_too_large');
  assert.equal(canceled, 1); assert.ok(pulls <= 2);
});
for (const [name, body] of [
  ['JSON', '{'], ['UTF-8', new Uint8Array([255])], ['empty body', undefined],
] as const) {
  test(`invalid ${name} has a fixed body refusal`, async () => {
    await refused(readLogoutRecoveryBody(request(body)), 400, 'invalid_json');
  });
}
test('read errors do not expose the stream failure', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.error(new Error('Public synthetic stream failure'));
  } });
  const r = new Request('http://localhost/fixture', { method: 'POST', body: stream, duplex: 'half' }
    as RequestInit & { duplex: 'half' });
  await refused(readLogoutRecoveryBody(r), 400, 'invalid_json');
});
