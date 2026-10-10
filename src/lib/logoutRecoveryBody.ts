import { HTTPException } from 'hono/http-exception';

// Five manifests of fifty UUIDs fit well below this bound. Count raw UTF-8
// bytes, including whitespace; do not trust Content-Length or allocate a body
// of unbounded size just to reject it after JSON parsing.
export const LOGOUT_RECOVERY_BODY_BYTES = 16 * 1024;
const bodyError = (status: 400 | 413, code: string) => new HTTPException(status, {
  res: new Response(JSON.stringify({ error: code }), { status,
    headers: { 'content-type': 'application/json' } }),
});

export async function readLogoutRecoveryBody(request: Request): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!request.body) throw bodyError(400, 'invalid_json');
    reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > LOGOUT_RECOVERY_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* Preserve the fixed 413. */ }
        throw bodyError(413, 'logout_recovery_payload_too_large');
      }
      chunks.push(Uint8Array.from(next.value));
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw bodyError(400, 'invalid_json');
  } finally {
    reader?.releaseLock();
  }
}
