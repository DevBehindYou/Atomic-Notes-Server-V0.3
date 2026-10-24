import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

// Generated from a blank16x12 RGB image; public synthetic data only.
const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAwAEAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AP8AP/oAKACgAoA//9k=', 'base64');
export function jpegAt60000Bytes(): Buffer {
  const padding = 60000 - tinyJpeg.length - 4;
  const segmentLength = padding + 2;
  return Buffer.concat([tinyJpeg.subarray(0, 2), Buffer.from([0xff, 0xfe, segmentLength >> 8, segmentLength & 255]),
    Buffer.alloc(padding), tinyJpeg.subarray(2)]);
}

export function threeImageContent() {
  const encoded = jpegAt60000Bytes().toString('base64');
  return { title: 'Three synthetic images', body: JSON.stringify({ v: 2, tags: ['budget'], blocks: [
    { text: 'Synthetic text and checklist', checklist: false, done: false, styles: [] },
    { text: 'Completed synthetic task', checklist: true, done: true, styles: [] },
    ...Array.from({ length: 3 }, () => ({ text: '', checklist: false, done: false, styles: [], image: encoded })),
  ] }), items: [{ text: 'atomic-notes:rich-document:v2', done: false }] };
}

export function budgetRow() {
  return { id: randomUUID(), kind: 'text' as const, title: '', body: '', items: [] as Array<{ text: string; done: boolean }>,
    pinned: false, deleted: false, created_at: new Date().toISOString(), enc_v: 0 as const, payload: null as string | null, base_version: 0 };
}

// Match the App's base64(nonce12 ++ AES-GCMciphertext ++ tag16) envelope.
// This fixed public key belongs only to the synthetic fixture.
const fixtureKey = Buffer.alloc(32, 9);
export function sealFixtureContent(content: object): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', fixtureKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}
export function openFixtureContent(payload: string): unknown {
  const bytes = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', fixtureKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'));
}

export function rowAtWireBytes(target: number) {
  const row = budgetRow();
  const remaining = target - Buffer.byteLength(JSON.stringify({ ...row, encV: row.enc_v }));
  return { ...row, body: '€'.repeat(Math.floor(remaining / 3)) + 'a'.repeat(remaining % 3) };
}
