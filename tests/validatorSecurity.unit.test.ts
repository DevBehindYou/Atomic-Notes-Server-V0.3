import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { legacyDateTimeSchema } from '../src/lib/legacyDateTime.js';
import { remoteNoteRowSchema } from '../src/types/noteWire.js';
import { atomicFileV1Schema } from '../src/types/atomicFile.js';
import { atomicUserSchema, logSchema, noteSchema } from '../src/db/collections.js';

const id = '11111111-1111-1111-1111-111111111111';
const created = '2026-09-14T18:00:00.123456Z';

test('oversized constrained collections reject before processing their members', () => {
  let arrayVisits = 0;
  const list = z.array(z.string().transform(value => { arrayVisits++; return value; })).max(2);
  assert.equal(list.safeParse(['a', 'b', 'c']).success, false);
  assert.equal(arrayVisits, 0);
  assert.deepEqual(list.parse(['a', 'b']), ['a', 'b']);
  assert.equal(arrayVisits, 2);
  let setVisits = 0;
  const set = z.set(z.string().transform(value => { setVisits++; return value; })).max(2);
  assert.equal(set.safeParse(new Set(['a', 'b', 'c'])).success, false);
  assert.equal(setVisits, 0);
});

test('legacy wire UUID shape, unknown stripping, key order and defaults remain compatible', () => {
  const parsed = remoteNoteRowSchema.parse({ id, user_id: 'discard-this-owner', kind: 'text', title: 'Legacy',
    body: 'Original', items: [{ t: 'Done', d: true }], pinned: false, deleted: false,
    created_at: created, enc_v: 0, payload: null });
  assert.equal(JSON.stringify(parsed), JSON.stringify({ id, kind: 'text', title: 'Legacy', body: 'Original',
    items: [{ text: 'Done', done: true }], pinned: false, deleted: false, created_at: created,
    enc_v: 0, payload: null, base_version: 0 }));
  assert.equal(Object.hasOwn(parsed, 'important'), false);
  assert.equal(Object.hasOwn(parsed, 'updated_at'), false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...parsed, id: 'bad-id' }).success, false);
});

test('saved file defaults and arbitrary log metadata preserve existing shapes', () => {
  const parsed = atomicFileV1Schema.parse({ version: 1, id, kind: 'text', title: 'Old file', body: 'Unchanged',
    createdAt: '2026-09-14T18:00:00Z', updatedAt: '2026-09-14T18:00:00Z' });
  assert.deepEqual(parsed.items, []); assert.equal(parsed.pinned, false);
  assert.equal(parsed.encV, 0); assert.equal(parsed.payload, null);
  assert.equal(Object.hasOwn(parsed, 'important'), false);
  const log = logSchema.parse({ _id: id, userId: null, event: 'synthetic', meta: { nested: [1, true, null] }, createdAt: new Date() });
  assert.deepEqual(log.meta, { nested: [1, true, null] });
});


test('integer compatibility retains legacy range and explicit safe revision bounds', () => {
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  const wallet = { _id: id, createdAt: new Date(), coins: unsafeInteger };
  assert.equal(atomicUserSchema.parse(wallet).coins, unsafeInteger);
  assert.equal(atomicUserSchema.parse({ ...wallet, coins: -unsafeInteger }).coins, -unsafeInteger);
  assert.equal(atomicUserSchema.safeParse({ ...wallet, coins: 1.5 }).success, false);
  assert.equal(atomicUserSchema.safeParse({ ...wallet, coins: Infinity }).success, false);
  assert.equal(atomicUserSchema.safeParse({ ...wallet, historySequence: unsafeInteger }).success, false);
  assert.equal(atomicUserSchema.parse({ ...wallet, historySequence: Number.MAX_SAFE_INTEGER }).historySequence, Number.MAX_SAFE_INTEGER);
  const wire = { id, kind: 'text', title: '', body: '', items: [], pinned: false, deleted: false,
    created_at: created, enc_v: 0, payload: null, base_version: unsafeInteger };
  assert.equal(remoteNoteRowSchema.parse(wire).base_version, unsafeInteger);
  assert.equal(remoteNoteRowSchema.safeParse({ ...wire, base_version: 0.5 }).success, false);
  const metadata = { _id: id, userId: id, folderId: null, kind: 'text', driveFileId: 'file',
    driveRevisionId: null, createdAt: new Date(), updatedAt: new Date(), lastSyncedAt: null };
  const note = noteSchema.parse(metadata);
  assert.equal(note.localVersion, 1);
  assert.equal(note.encV, 0);
  assert.equal(note.syncStatus, 'synced');
  assert.equal(Object.hasOwn(note, 'important'), false);
  assert.equal(Object.hasOwn(note, 'contentHash'), false);
});


test('legacy timestamp precision and offsets remain accepted without normalization', () => {
  const utc = legacyDateTimeSchema(), offset = legacyDateTimeSchema({ offset: true });
  for (const stamp of ['2026-10-24T12:13Z', '2026-10-24T12:13:14Z', '2026-10-24T12:13:14.123456Z',
    '2024-02-29T00:00Z', '2000-02-29T23:59:59Z']) {
    assert.equal(utc.parse(stamp), stamp);
    assert.equal(offset.parse(stamp), stamp);
  }
  for (const stamp of ['2026-10-24T12:13:14+0530', '2026-10-24T12:13+05:30', '2026-10-24T12:13:14-0700']) {
    assert.equal(offset.parse(stamp), stamp);
    assert.equal(utc.safeParse(stamp).success, false);
  }
  for (const stamp of ['2026-02-29T12:13Z', '1900-02-29T12:13Z', '2026-04-31T12:13Z',
    '2026-00-01T12:13Z', '2026-13-01T12:13Z', '2026-10-24T24:00Z', '2026-10-24T12:60Z',
    '2026-10-24T12:13:60Z', '2026-10-24T12:13', '2026-10-24T12:13+05', '2026-10-24T12:13.5Z']) {
    assert.equal(offset.safeParse(stamp).success, false, stamp);
    assert.equal(utc.safeParse(stamp).success, false, stamp);
  }
  const wire = { id, kind: 'text', title: '', body: '', items: [], pinned: false, deleted: false,
    created_at: '2026-10-24T12:13:14+0530', updated_at: '2026-10-24T12:13Z', enc_v: 0, payload: null };
  const parsed = remoteNoteRowSchema.parse(wire);
  assert.equal(parsed.created_at, wire.created_at); assert.equal(parsed.updated_at, wire.updated_at);
  const file = atomicFileV1Schema.parse({ version: 1, id, kind: 'text', title: '', body: '',
    createdAt: '2026-10-24T12:13Z', updatedAt: '2026-10-24T12:13Z' });
  assert.equal(file.createdAt, '2026-10-24T12:13Z');
});
