import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { installLoopbackOnlyNetwork, socketMeter } from './loadCharacterizeCore.js';

// C48: the loopback stand-in for Google Drive, run as its own process by tests/loadCharacterize.ts so
// its stored files and work do not count toward the App Server's memory or CPU. It answers the Drive v3
// calls the notes route makes (name lookup, multipart create, media update, trash, media download).
// Synthetic content only; nothing here can reach Google. Controlled over IPC:
//   configure { latencyMs, faultStatus, faultMs }  latency per answer; for faultMs from now, every
//                                                  request is answered faultStatus (429 or 503)
//   reset                                          restart the in-flight high-water mark
//   stats                                          counters since start
if (!process.send) throw new Error('load_drive_fixture_requires_ipc');
installLoopbackOnlyNetwork();

const ACCESS = 'Bearer atomic-load-access';
const files = new Map<string, { name: string; body: string; trashed: boolean }>();
const stats = { requests: 0, faulted: 0, foreignAuth: 0, maxInFlight: 0 };
let inFlight = 0, nextId = 0, latencyMs = 0, faultStatus = 0, faultUntil = 0;

const server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on('data', (part: Buffer) => parts.push(part));
  req.on('end', () => {
    stats.requests++; inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    res.once('close', () => { inFlight--; });
    if (req.headers.authorization !== ACCESS) stats.foreignAuth++;
    const send = (status: number, body: string) => {
      const answer = () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
      if (latencyMs > 0) setTimeout(answer, latencyMs); else answer();
    };
    if (faultStatus && Date.now() < faultUntil) {
      stats.faulted++;
      const reason = faultStatus === 429 ? 'rateLimitExceeded' : 'backendError';
      return send(faultStatus, JSON.stringify({ error: { code: faultStatus, message: 'synthetic fault', errors: [{ reason }] } }));
    }
    const body = Buffer.concat(parts).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://loopback');
    const fileId = url.pathname.match(/\/files\/([^/]+)$/)?.[1];
    if (req.method === 'GET' && !fileId) {
      const name = url.searchParams.get('q')?.match(/name = '([^']+)'/)?.[1];
      return send(200, JSON.stringify({ files: [...files].filter(([, f]) => f.name === name && !f.trashed).map(([id]) => ({ id })) }));
    }
    if (req.method === 'POST') {
      const name = body.match(/"name":"([^"]+)"/)?.[1], content = body.match(/(\{"version":1[^\r\n]*\})/)?.[1];
      if (!name || !content) return send(400, JSON.stringify({ error: { code: 400, message: 'synthetic bad upload' } }));
      const id = `synthetic-load-file-${++nextId}`;
      files.set(id, { name, body: content, trashed: false });
      return send(200, JSON.stringify({ id, headRevisionId: `synthetic-revision-${stats.requests}` }));
    }
    const file = fileId ? files.get(fileId) : undefined;
    if (!file) return send(404, JSON.stringify({ error: { code: 404, message: 'synthetic not found' } }));
    if (req.method === 'PATCH') {
      const content = body.match(/(\{"version":1[^\r\n]*\})/)?.[1];
      if (content) file.body = content;
      if (/"trashed":true/.test(body)) file.trashed = true;
      if (/"trashed":false/.test(body)) file.trashed = false;
      return send(200, JSON.stringify({ id: fileId, headRevisionId: `synthetic-revision-${stats.requests}` }));
    }
    return send(200, file.body);
  });
});
const transport = socketMeter(server);
server.keepAliveTimeout = 30000;
server.listen(0, '127.0.0.1');
await once(server, 'listening');

process.on('message', (message: { id: number; type: string; latencyMs?: number; faultStatus?: number; faultMs?: number }) => {
  if (message.type === 'configure') {
    latencyMs = Math.max(0, Math.min(Number(message.latencyMs ?? 0), 10000));
    faultStatus = message.faultStatus === 429 || message.faultStatus === 503 ? message.faultStatus : 0;
    faultUntil = faultStatus ? Date.now() + Math.max(0, Math.min(Number(message.faultMs ?? 0), 60000)) : 0;
    process.send!({ id: message.id, ok: true });
  } else if (message.type === 'reset') {
    stats.maxInFlight = inFlight;
    process.send!({ id: message.id, ok: true });
  } else if (message.type === 'stats') {
    let storedBytes = 0;
    for (const file of files.values()) storedBytes += file.body.length;
    const { bytesIn, bytesOut } = transport();
    process.send!({ id: message.id, ...stats, files: files.size, storedBytes, transportIn: bytesIn, transportOut: bytesOut });
  } else if (message.type === 'close') {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready', port: (server.address() as AddressInfo).port });
