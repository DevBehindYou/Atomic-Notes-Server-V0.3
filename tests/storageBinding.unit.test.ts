import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  BINDING_COMMAND_TYPES, DROPBOX_ISSUER, LEGACY_GOOGLE_SETUP_KEY, MAX_RETIRED_LOCATORS, applyBindingCommand, bindingFromLegacyGoogle,
  checkRecordInvariants, transition, type BindingActor, type BindingCommand, type BindingCommandType, type BindingRecord, type BindingStore,
  type Locator,
} from '../src/lib/storageBinding.js';
import {
  assertDisposableBindingTarget, createMemoryBindingStore, createMongoBindingStore, readLegacyGoogleBindings,
} from '../src/db/storageBindingStore.js';

// C29: pure binding state machine and its CAS port. No database: the in-memory store has the Mongo store's semantics.
const T0 = 1_900_000_000_000;
const LEASE = 60_000;
const account = randomUUID();
// The trailing '_' keeps labels distinct after padding (fr1 and fr10 must differ).
const tok = (label: string) => `tok_${label}_`.padEnd(20, '0');
const SUB = '109876543210987654321';
const G = (holder: string, subject = SUB): BindingActor => ({ provider: 'google_drive', issuer: 'https://accounts.google.com', subject,
  holder: tok(`h${holder}`) });
const D = (holder: string, subject = 'dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc'): BindingActor => ({ provider: 'dropbox',
  issuer: DROPBOX_ISSUER, subject, holder: tok(`h${holder}`) });
const L1: Locator = { kind: 'drive_folder', folderId: '1AbCdEfGhIjKlMnOp_q-R' };
const L2: Locator = { kind: 'drive_folder', folderId: '1ZyXwVuTsRqPoNmLk_j-I' };
const K1 = tok('key1'), K2 = tok('key2'), K3 = tok('key3');

function ok(record: BindingRecord | null, command: BindingCommand, now = T0, id = account): BindingRecord {
  const result = transition(id, record, command, now);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(checkRecordInvariants(result.record), []);
  return result.record;
}
const errorOf = (record: BindingRecord | null, command: BindingCommand, now = T0) => {
  const result = transition(account, record, command, now);
  return result.ok ? (result.changed ? result.record.state : 'noop') : result.error;
};

const reserve = (actor: BindingActor, token: string, extra: object = {}): BindingCommand =>
  ({ type: 'reserve', actor, token, leaseMs: LEASE, ...extra });
const begin = (actor: BindingActor, token: string, idempotencyKey = K1): BindingCommand =>
  ({ type: 'begin_provisioning', actor, token, idempotencyKey, leaseMs: LEASE });
const complete = (actor: BindingActor, token: string, locator: Locator = L1, idempotencyKey = K1): BindingCommand =>
  ({ type: 'complete_provisioning', actor, token, idempotencyKey, locator });
const pause = (record: BindingRecord, reason: 'consent_revoked' | 'provider_unavailable' = 'consent_revoked'): BindingCommand =>
  ({ type: 'pause', reason, expectedGeneration: record.generation });
const reconnect = (actor: BindingActor, token: string, idempotencyKey?: string): BindingCommand =>
  ({ type: 'reconnect', actor, token, leaseMs: LEASE, ...(idempotencyKey ? { idempotencyKey } : {}) });
const resume = (actor: BindingActor, token: string): BindingCommand => ({ type: 'resume_provisioning', actor, token, leaseMs: LEASE });

/** Every reachable state, each built only through the transition function. */
function states() {
  const reserved = ok(null, reserve(G('a'), tok('r1')));
  const provisioning = ok(reserved, begin(G('a'), tok('r1')));
  const active = ok(provisioning, complete(G('a'), tok('r1')));
  const paused = ok(active, pause(active));
  const reconnecting = ok(paused, reconnect(G('b'), tok('r2')));
  const released = ok(reserved, { type: 'release', actor: G('a'), token: tok('r1') });
  return { reserved, provisioning, active, paused, reconnecting, released };
}

test('transition table: every state x command outcome matches the specification', () => {
  const s = states();
  const records: Record<string, BindingRecord | null> = { none: null, ...s };
  const token = (record: BindingRecord | null) => record?.lease?.token ?? tok('r1');
  const command = (type: BindingCommandType, record: BindingRecord | null): BindingCommand => {
    switch (type) {
      case 'reserve': return reserve(D('z'), tok('rz'));
      case 'begin_provisioning': return begin(G('a'), token(record));
      case 'complete_provisioning': return complete(G('a'), token(record));
      case 'fail_provisioning': return { type, actor: G('a'), token: token(record), evidence: 'provider_confirmed_absent' };
      case 'resume_provisioning': return resume(G('b'), tok('rb'));
      case 'release': return { type, actor: G('a'), token: token(record) };
      case 'pause': return { type, reason: 'consent_revoked', expectedGeneration: record?.generation ?? 0 };
      case 'reconnect': return reconnect(G('c'), tok('rc'), K2);
      case 'confirm_reconnect': return { type, actor: G('a'), token: token(record), locator: L1 };
      case 'fail_reconnect': return { type, actor: G('a'), token: token(record), reason: 'locator_unavailable' };
      case 'reprovision': return { type, actor: G('c'), token: tok('rc'), leaseMs: LEASE, idempotencyKey: K3, replaceLocator: L1 };
    }
  };
  // Rows: current state. Columns: command. Cell: resulting state, `noop`, or the refusal.
  const I = 'invalid_state', N = 'not_bound';
  const expected: Record<string, Record<BindingCommandType, string>> = {
    none: { reserve: 'reserved', begin_provisioning: N, complete_provisioning: N, fail_provisioning: N, resume_provisioning: N, release: N,
      pause: N, reconnect: N, confirm_reconnect: N, fail_reconnect: N, reprovision: N },
    reserved: { reserve: 'binding_reserved', begin_provisioning: 'provisioning', complete_provisioning: I, fail_provisioning: I,
      resume_provisioning: I, release: 'released', pause: N, reconnect: I, confirm_reconnect: I, fail_reconnect: I, reprovision: I },
    provisioning: { reserve: 'binding_reserved', begin_provisioning: 'noop', complete_provisioning: 'active', fail_provisioning: 'paused',
      resume_provisioning: 'provisioning_in_progress', release: I, pause: 'paused', reconnect: I, confirm_reconnect: I, fail_reconnect: I,
      reprovision: I },
    active: { reserve: 'binding_active', begin_provisioning: I, complete_provisioning: 'noop', fail_provisioning: I, resume_provisioning: I,
      release: I, pause: 'paused', reconnect: 'noop', confirm_reconnect: 'noop', fail_reconnect: I, reprovision: I },
    paused: { reserve: 'binding_paused', begin_provisioning: I, complete_provisioning: I, fail_provisioning: I, resume_provisioning: I,
      release: I, pause: 'noop', reconnect: 'reconnecting', confirm_reconnect: I, fail_reconnect: I, reprovision: 'provisioning' },
    reconnecting: { reserve: 'binding_reserved', begin_provisioning: I, complete_provisioning: I, fail_provisioning: I, resume_provisioning: I,
      release: I, pause: 'paused', reconnect: 'reconnect_in_progress', confirm_reconnect: 'active', fail_reconnect: 'paused', reprovision: I },
    released: { reserve: 'reserved', begin_provisioning: I, complete_provisioning: I, fail_provisioning: I, resume_provisioning: I,
      release: 'noop', pause: N, reconnect: N, confirm_reconnect: I, fail_reconnect: I, reprovision: I },
  };
  let cells = 0;
  for (const [name, record] of Object.entries(records)) {
    for (const type of BINDING_COMMAND_TYPES) {
      const cmd = command(type, record);
      const result = transition(account, record, cmd, T0 + 1);
      const actual = result.ok ? (result.changed ? result.record.state : 'noop') : result.error;
      assert.equal(actual, expected[name][type], `${name} x ${type}`);
      if (result.ok) {
        assert.deepEqual(checkRecordInvariants(result.record), [], `${name} x ${type}`);
        assert.equal(result.record.generation, (record?.generation ?? 0) + (result.changed ? 1 : 0), `${name} x ${type} generation`);
        if (!result.changed) assert.deepEqual(result.record, record);
      }
      cells++;
    }
  }
  assert.equal(cells, 7 * 11);
});

test('locators survive pause, revoked consent and reconnect; replacement is explicit and retained', () => {
  const s = states();
  assert.deepEqual(s.paused.locator, L1, 'revoked consent keeps the locator');
  assert.equal(s.paused.pauseReason, 'consent_revoked');
  assert.deepEqual(s.reconnecting.locator, L1);
  // A reconnect that finds a different folder is refused; the record is unchanged.
  assert.equal(errorOf(s.reconnecting, { type: 'confirm_reconnect', actor: G('b'), token: tok('r2'), locator: L2 }), 'locator_mismatch');
  const back = ok(s.reconnecting, { type: 'confirm_reconnect', actor: G('b'), token: tok('r2'), locator: L1 });
  assert.equal(back.state, 'active');
  assert.deepEqual(back.locator, L1);
  // A verified-missing folder pauses again, keeping the locator.
  const missing = ok(s.reconnecting, { type: 'fail_reconnect', actor: G('b'), token: tok('r2'), reason: 'locator_unavailable' });
  assert.deepEqual([missing.state, missing.pauseReason, missing.locator], ['paused', 'locator_unavailable', L1]);
  // Reprovision must name the locator it replaces; the old one moves to retiredLocators.
  const reprov = (replaceLocator: Locator): BindingCommand => ({ type: 'reprovision', actor: G('c'), token: tok('rc'), leaseMs: LEASE,
    idempotencyKey: K3, replaceLocator });
  assert.equal(errorOf(missing, reprov(L2)), 'locator_mismatch');
  assert.equal(errorOf(missing, { ...reprov(L1), actor: G('c', '999') } as BindingCommand), 'owner_mismatch');
  const fresh = ok(missing, reprov(L1));
  assert.deepEqual([fresh.state, fresh.locator, fresh.retiredLocators, fresh.idempotencyKey], ['provisioning', null, [L1], K3]);
  const replaced = ok(fresh, complete(G('c'), tok('rc'), L2, K3));
  assert.deepEqual([replaced.locator, replaced.retiredLocators], [L2, [L1]]);
  // The retired list is bounded; a full list refuses further replacement.
  const full = { ...missing, retiredLocators: Array.from({ length: MAX_RETIRED_LOCATORS }, () => L2) };
  assert.equal(errorOf(full, reprov(L1)), 'retired_locator_limit');
});

test('reconnect requires the same provider and exact identity; email is not an input', () => {
  const { paused } = states();
  assert.equal(errorOf(paused, reconnect(G('x', '109876543210987654322'), tok('rx'))), 'owner_mismatch');
  assert.equal(errorOf(paused, reconnect(G('x', SUB.toUpperCase() + 'a'), tok('rx'))), 'owner_mismatch');
  assert.equal(errorOf(paused, reconnect(D('x'), tok('rx'))), 'provider_mismatch');
  assert.equal(errorOf(paused, reconnect(G('x', 'person@example.test'), tok('rx'))), 'invalid_actor', 'email-shaped subject');
  // The alternate Google issuer form canonicalises to the same owner.
  assert.equal(errorOf(paused, reconnect({ ...G('x'), issuer: 'accounts.google.com' }, tok('rx'))), 'reconnecting');
  // A Google identity cannot claim a Dropbox binding, and vice versa.
  assert.equal(errorOf(null, reserve({ ...G('x'), provider: 'dropbox' }, tok('rx'))), 'provider_identity_mismatch');
  assert.equal(errorOf(null, reserve({ ...D('x'), provider: 'google_drive' }, tok('rx'))), 'provider_identity_mismatch');
});

test('lease takeover: only an expired reservation, never provisioning or reconnect by another identity', () => {
  const s = states();
  const after = T0 + LEASE + 1;
  // reserved: live lease refused for everyone else; expired lease can be taken by any valid identity.
  assert.equal(errorOf(s.reserved, reserve(D('z'), tok('rz')), T0 + LEASE - 1), 'binding_reserved');
  const taken = ok(s.reserved, reserve(D('z'), tok('rz')), after);
  assert.deepEqual([taken.provider, taken.lease?.token, taken.generation], ['dropbox', tok('rz'), s.reserved.generation + 1]);
  assert.equal(errorOf(taken, begin(G('a'), tok('r1')), after), 'provider_mismatch', 'the old holder is fenced out');
  // provisioning: another identity or provider is refused even after expiry; the same owner resumes with the same key.
  assert.equal(errorOf(s.provisioning, resume(D('z'), tok('rz')), after), 'binding_reserved');
  assert.equal(errorOf(s.provisioning, resume(G('x', '1234567'), tok('rz')), after), 'binding_reserved');
  assert.equal(errorOf(s.provisioning, reserve(G('a'), tok('rz')), after), 'binding_reserved');
  const resumed = ok(s.provisioning, resume(G('b'), tok('rb')), after);
  assert.deepEqual([resumed.idempotencyKey, resumed.lease?.token], [K1, tok('rb')]);
  assert.equal(errorOf(resumed, complete(G('a'), tok('r1')), after), 'stale_lease', 'the crashed holder cannot finish over the resumer');
  // reconnecting: same owner may take over an expired lease; another identity never.
  assert.equal(errorOf(s.reconnecting, reconnect(G('x', '1234567'), tok('rz')), after), 'owner_mismatch');
  assert.equal(errorOf(s.reconnecting, reconnect(G('c'), tok('rc')), after), 'reconnecting');
});

test('unknown setup outcome is never treated as failure; revoked consent mid-provisioning keeps the key', () => {
  const { provisioning } = states();
  assert.equal(errorOf(provisioning, { type: 'fail_provisioning', actor: G('a'), token: tok('r1'), evidence: 'timeout' } as never),
    'unknown_outcome_not_failure');
  // Consent revoked while the provider call is in flight.
  const paused = ok(provisioning, pause(provisioning));
  assert.deepEqual([paused.state, paused.idempotencyKey, paused.locator, paused.lease], ['paused', K1, null, null]);
  assert.equal(errorOf(paused, complete(G('a'), tok('r1'))), 'invalid_state', 'a late completion cannot bypass the pause');
  // Reconnect resumes provisioning with the ORIGINAL key, ignoring a new one, so the re-check finds the earlier folder.
  const again = ok(paused, reconnect(G('b'), tok('r2'), K2));
  assert.deepEqual([again.state, again.idempotencyKey], ['provisioning', K1]);
  const active = ok(again, complete(G('b'), tok('r2'), L1, K1));
  assert.deepEqual(active.locator, L1);
  // Verified absence pauses without a key; the next reconnect needs a new one.
  const failed = ok(provisioning, { type: 'fail_provisioning', actor: G('a'), token: tok('r1'), evidence: 'provider_confirmed_absent' });
  assert.deepEqual([failed.state, failed.pauseReason, failed.idempotencyKey], ['paused', 'setup_failed', null]);
  assert.equal(errorOf(failed, reconnect(G('b'), tok('r2'))), 'idempotency_key_required');
  assert.equal(ok(failed, reconnect(G('b'), tok('r2'), K2)).idempotencyKey, K2);
});

test('stale generation and stale tokens are refused; pause requires the generation it observed', () => {
  const { active } = states();
  assert.equal(errorOf(active, { type: 'pause', reason: 'provider_unavailable' } as never), 'invalid_command');
  const paused = ok(active, pause(active));
  const reconnecting = ok(paused, reconnect(G('b'), tok('r2')));
  const fresh = ok(reconnecting, { type: 'confirm_reconnect', actor: G('b'), token: tok('r2'), locator: L1 });
  // A pause observed under the old credential (generation of `active`) must not pause the freshly reconnected binding.
  assert.equal(errorOf(fresh, pause(active)), 'stale_generation');
  assert.equal(errorOf(fresh, { ...reconnect(G('b'), tok('r9')), expectedGeneration: active.generation } as BindingCommand), 'noop');
  assert.equal(errorOf(paused, { ...reconnect(G('b'), tok('r9')), expectedGeneration: active.generation } as BindingCommand),
    'stale_generation');
  assert.equal(errorOf(paused, { ...reconnect(G('b'), tok('r9')), expectedGeneration: paused.generation } as BindingCommand), 'reconnecting');
  assert.equal(errorOf(reconnecting, { type: 'confirm_reconnect', actor: G('b'), token: tok('wrong'), locator: L1 }), 'stale_lease');
  assert.equal(errorOf(null, reserve(G('a'), tok('r1'), { expectedGeneration: 3 })), 'stale_generation');
});

test('command validation is strict and never partially applied', () => {
  const { reserved } = states();
  assert.equal(errorOf(null, reserve(G('a'), 'short')), 'invalid_token');
  assert.equal(errorOf(null, reserve({ ...G('a'), holder: 'x' }, tok('r1'))), 'invalid_actor');
  assert.equal(errorOf(null, { ...reserve(G('a'), tok('r1')), leaseMs: 999 } as BindingCommand), 'invalid_lease');
  assert.equal(errorOf(null, { ...reserve(G('a'), tok('r1')), leaseMs: 15 * 60 * 1000 + 1 } as BindingCommand), 'invalid_lease');
  assert.equal(errorOf(reserved, begin(G('a'), tok('r1'), 'bad key')), 'invalid_idempotency_key');
  assert.equal(errorOf(null, { type: 'drop_everything' } as never), 'invalid_command');
  const provisioning = ok(reserved, begin(G('a'), tok('r1')));
  assert.equal(errorOf(provisioning, complete(G('a'), tok('r1'), { kind: 'dropbox_namespace', namespaceId: '123' })), 'invalid_locator');
  assert.equal(errorOf(provisioning, complete(G('a'), tok('r1'), L1, K2)), 'idempotency_key_mismatch');
  // A tampered stored record is refused rather than transitioned.
  assert.equal(errorOf({ ...provisioning, locator: L1 }, complete(G('a'), tok('r1'))), 'binding_record_invalid');
  assert.equal(transition(randomUUID(), provisioning, complete(G('a'), tok('r1')), T0).ok, false, 'record of another account');
  const frozen = Object.freeze(structuredClone(provisioning));
  ok(frozen, complete(G('a'), tok('r1')));
  assert.deepEqual(frozen, provisioning, 'the current record is not modified');
});

/** Interleaving: every racer reads the same snapshot and computes a valid transition; then all CAS in order. */
async function interleave(store: BindingStore, id: string, commands: BindingCommand[], now: number) {
  const reads = await Promise.all(commands.map(() => store.get(id)));
  const results = reads.map((current, index) => transition(id, current, commands[index], now));
  const outcomes: string[] = [];
  for (const [index, result] of results.entries()) {
    assert.ok(result.ok && result.changed, `racer ${index} computed a transition on the shared snapshot`);
    outcomes.push(await store.compareAndSet(id, reads[index]?.generation ?? null, result.record));
  }
  return outcomes;
}

test('races: two devices, two providers and takeovers resolve to exactly one winner through the CAS', async () => {
  const store = createMemoryBindingStore();
  const id = randomUUID();
  // Two devices of the same owner and one Dropbox identity reserve simultaneously.
  const racers = [reserve(G('a'), tok('ra')), reserve(G('b'), tok('rb')), reserve(D('c'), tok('rc'))];
  assert.deepEqual(await interleave(store, id, racers, T0), ['ok', 'conflict', 'conflict']);
  // The losers retry through the service and see the winner's reservation.
  for (const racer of racers.slice(1)) assert.deepEqual(await applyBindingCommand(store, id, racer, () => T0),
    { ok: false, error: 'binding_reserved' });
  assert.equal((await store.get(id))!.lease!.token, tok('ra'));
  // The winner's own retry is an idempotent no-op.
  assert.equal((await applyBindingCommand(store, id, racers[0], () => T0) as { changed: boolean }).changed, false);

  // Takeover after expiry racing the original holder's begin: both computed against the same snapshot, one wins.
  const late = T0 + LEASE + 5;
  const outcomes = await interleave(store, id, [begin(G('a'), tok('ra')), reserve(D('c'), tok('rc'))], late);
  assert.deepEqual(outcomes, ['ok', 'conflict']);
  assert.deepEqual(await applyBindingCommand(store, id, reserve(D('c'), tok('rc')), () => late), { ok: false, error: 'binding_reserved' });
  assert.equal((await store.get(id))!.state, 'provisioning');

  // Crash after the provider call: two devices of the owner resume after expiry; one wins, the key is unchanged.
  const later = late + LEASE + 5;
  assert.deepEqual(await interleave(store, id, [resume(G('b'), tok('rb')), resume(G('d'), tok('rd'))], later), ['ok', 'conflict']);
  assert.deepEqual(await applyBindingCommand(store, id, resume(G('d'), tok('rd')), () => later),
    { ok: false, error: 'provisioning_in_progress' });
  const resumed = (await store.get(id))!;
  assert.deepEqual([resumed.idempotencyKey, resumed.lease!.token], [K1, tok('rb')]);
  // The crashed original holder completing with its old token is refused; the resumer completes.
  assert.deepEqual(await applyBindingCommand(store, id, complete(G('a'), tok('ra')), () => later), { ok: false, error: 'stale_lease' });
  const done = await applyBindingCommand(store, id, complete(G('b'), tok('rb')), () => later);
  assert.ok(done.ok && done.record.state === 'active');

  // Revoked consent racing a reconnect on the same generation: exactly one applies.
  const active = (await store.get(id))!;
  const pausedRecord = ok(active, pause(active), later, id);
  await store.compareAndSet(id, active.generation, pausedRecord);
  const race = await interleave(store, id, [reconnect(G('a'), tok('r7')), reconnect(G('b'), tok('r8'))], later);
  assert.deepEqual(race, ['ok', 'conflict']);
  const current = (await store.get(id))!;
  assert.deepEqual([current.state, current.locator], ['reconnecting', L1]);
});

test('one reservation per owner identity across accounts', async () => {
  const store = createMemoryBindingStore();
  const [a, b] = [randomUUID(), randomUUID()];
  assert.ok((await applyBindingCommand(store, a, reserve(G('a'), tok('ra')), () => T0)).ok);
  assert.deepEqual(await applyBindingCommand(store, b, reserve(G('b'), tok('rb')), () => T0), { ok: false, error: 'identity_bound_elsewhere' });
  assert.equal(await store.get(b), null);
  // Released reservations free the identity.
  assert.ok((await applyBindingCommand(store, a, { type: 'release', actor: G('a'), token: tok('ra') }, () => T0)).ok);
  assert.ok((await applyBindingCommand(store, b, reserve(G('b'), tok('rb')), () => T0)).ok);
});

test('the service reports contention instead of looping forever', async () => {
  const inner = createMemoryBindingStore();
  const always: BindingStore = { get: id => inner.get(id), compareAndSet: async () => 'conflict' };
  assert.deepEqual(await applyBindingCommand(always, account, reserve(G('a'), tok('ra')), () => T0, 3), { ok: false, error: 'contention' });
});

// ---------------------------------------------------------------------------
// Property-style randomized interleavings
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('randomized interleavings preserve every invariant (300 seeds x 120 steps)', async (t) => {
  const LEASE_REQUIRED = new Set<BindingCommandType>(['begin_provisioning', 'complete_provisioning', 'fail_provisioning', 'release',
    'confirm_reconnect', 'fail_reconnect']);
  const totals: Record<string, number> = {};
  const bump = (key: string) => { totals[key] = (totals[key] ?? 0) + 1; };
  for (let seed = 1; seed <= 300; seed++) {
    const rand = prng(seed);
    const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
    const store = createMemoryBindingStore();
    const accounts = [randomUUID(), randomUUID()];
    // Two devices of one Google owner, one Dropbox owner, one other Google owner.
    const actors = [G('a'), G('b'), D('c'), G('d', '555555555555')];
    // The simulated provider is idempotent per key: a re-check with the same key finds the same folder.
    const folderFor = (key: string): Locator => ({ kind: 'drive_folder', folderId: `f_${key}` });
    const nsFor = (key: string): Locator => ({ kind: 'dropbox_namespace', namespaceId: String(key.length * 7919 + key.charCodeAt(4)) });
    const locatorFor = (actor: BindingActor, key: string) => actor.provider === 'google_drive' ? folderFor(key) : nsFor(key);
    const tokens = new Map<string, string[]>(); // per actor+account
    const everLocators = new Map<string, Locator[]>();
    let now = T0, serial = 0;
    const pending = new Map<number, { id: string; snapshot: BindingRecord | null; command: BindingCommand; at: number }>();

    const choose = (actorIndex: number, id: string, snapshot: BindingRecord | null): BindingCommand => {
      const actor = actors[actorIndex];
      const mine = tokens.get(`${actorIndex}:${id}`) ?? [];
      const leaseToken = snapshot?.lease?.token;
      const token = leaseToken && mine.includes(leaseToken) && rand() < 0.85 ? leaseToken : mine.length && rand() < 0.5 ? pick(mine) : (() => {
        const fresh = tok(`s${seed}n${++serial}`); tokens.set(`${actorIndex}:${id}`, [...mine, fresh]); return fresh; })();
      const key = snapshot?.idempotencyKey && rand() < 0.8 ? snapshot.idempotencyKey : tok(`k${seed}n${++serial}`);
      const leaseMs = pick([1000, 5000, LEASE]);
      const gen = rand() < 0.15 ? { expectedGeneration: Math.max(0, (snapshot?.generation ?? 0) - 1) } : {};
      // Mostly the commands a real client would send next from this state, plus uniformly random noise.
      const plausible: Record<string, BindingCommandType[]> = { none: ['reserve'], released: ['reserve'],
        reserved: ['begin_provisioning', 'begin_provisioning', 'release', 'reserve'],
        provisioning: ['complete_provisioning', 'complete_provisioning', 'fail_provisioning', 'resume_provisioning', 'pause'],
        active: ['pause', 'reconnect', 'complete_provisioning'], paused: ['reconnect', 'reconnect', 'reprovision', 'pause'],
        reconnecting: ['confirm_reconnect', 'confirm_reconnect', 'fail_reconnect', 'reconnect', 'pause'] };
      switch (rand() < 0.75 ? pick(plausible[snapshot?.state ?? 'none']) : pick(BINDING_COMMAND_TYPES)) {
        case 'reserve': return { type: 'reserve', actor, token, leaseMs, ...gen };
        case 'begin_provisioning': return { type: 'begin_provisioning', actor, token, idempotencyKey: key, leaseMs, ...gen };
        case 'complete_provisioning': return { type: 'complete_provisioning', actor, token, idempotencyKey: key,
          locator: locatorFor(actor, key), ...gen };
        case 'fail_provisioning': return { type: 'fail_provisioning', actor, token, evidence: 'provider_confirmed_absent', ...gen };
        case 'resume_provisioning': return { type: 'resume_provisioning', actor, token, leaseMs, ...gen };
        case 'release': return { type: 'release', actor, token, ...gen };
        case 'pause': return { type: 'pause', reason: pick(['consent_revoked', 'provider_unavailable'] as const),
          expectedGeneration: rand() < 0.8 ? snapshot?.generation ?? 0 : Math.max(0, (snapshot?.generation ?? 0) - 1) };
        case 'reconnect': return { type: 'reconnect', actor, token, leaseMs, idempotencyKey: key, ...gen };
        case 'confirm_reconnect': return { type: 'confirm_reconnect', actor, token,
          locator: snapshot?.locator && rand() < 0.8 ? snapshot.locator : locatorFor(actor, key), ...gen };
        case 'fail_reconnect': return { type: 'fail_reconnect', actor, token, reason: pick(['locator_unavailable', 'provider_unavailable',
          'consent_revoked'] as const), ...gen };
        case 'reprovision': return { type: 'reprovision', actor, token, leaseMs, idempotencyKey: tok(`k${seed}n${++serial}`),
          replaceLocator: snapshot?.locator ?? locatorFor(actor, key), ...gen };
      }
    };

    for (let step = 0; step < 120; step++) {
      now += pick([0, 0, 250, 1500, 7000, LEASE + 1]);
      const actorIndex = Math.floor(rand() * actors.length);
      const held = pending.get(actorIndex);
      if (!held || rand() < 0.35) {
        // Phase 1: read a snapshot and decide; the commit happens in a later, interleaved step.
        const id = pick(accounts);
        const snapshot = await store.get(id);
        pending.set(actorIndex, { id, snapshot, command: choose(actorIndex, id, snapshot), at: now });
        continue;
      }
      // Phase 2: evaluate on the (possibly stale) snapshot and CAS.
      pending.delete(actorIndex);
      const { id, snapshot, command } = held;
      const result = transition(id, snapshot, command, now);
      if (!result.ok) { bump(`refused:${result.error}`); continue; }
      if (!result.changed) { bump('noop'); continue; }
      const outcome = await store.compareAndSet(id, snapshot?.generation ?? null, result.record);
      bump(`cas:${outcome}`);
      if (outcome !== 'ok') continue;
      bump(`commit:${command.type}`);
      const prev = snapshot, next = result.record;
      const label = `seed ${seed} step ${step} ${command.type}`;
      assert.deepEqual(checkRecordInvariants(next), [], label);
      // I1: generation advances by exactly one per committed write.
      assert.equal(next.generation, (prev?.generation ?? 0) + 1, label);
      if (prev) {
        // I3: owner/provider fixed once a provider effect may exist.
        if (['provisioning', 'active', 'paused', 'reconnecting'].includes(prev.state)) {
          assert.equal(next.ownerKey, prev.ownerKey, label);
          assert.equal(next.provider, prev.provider, label);
        }
        if (next.ownerKey !== prev.ownerKey) {
          assert.ok(prev.state === 'released' || (prev.state === 'reserved' && now >= prev.lease!.expiresAt), label);
        }
        // I2: a lease token changes hands only after expiry.
        if (prev.lease && next.lease && next.lease.token !== prev.lease.token) assert.ok(now >= prev.lease.expiresAt, label);
        // I2: lease-bound commands only commit with the current token.
        if (LEASE_REQUIRED.has(command.type)) assert.equal((command as { token: string }).token, prev.lease?.token, label);
        // I4: an idempotency key is only dropped by completion or provider-verified failure.
        if (prev.idempotencyKey !== null && next.idempotencyKey !== prev.idempotencyKey) {
          assert.ok(next.state === 'active' || (command.type === 'fail_provisioning' && next.pauseReason === 'setup_failed'), label);
        }
        // I5: a locator is never lost: it stays, or explicit reprovision appends it to retiredLocators.
        if (prev.locator) {
          assert.ok(isDeepStrictEqual(next.locator, prev.locator)
            || (command.type === 'reprovision' && isDeepStrictEqual(next.retiredLocators.at(-1), prev.locator)), label);
        }
        assert.deepEqual(next.retiredLocators.slice(0, prev.retiredLocators.length), prev.retiredLocators, label);
      }
      if (next.locator) everLocators.set(id, [...(everLocators.get(id) ?? []), next.locator]);
      // I7: at most one reserved binding per owner identity across accounts.
      const live = store.snapshot().filter(record => record.reserved).map(record => record.ownerKey);
      assert.equal(new Set(live).size, live.length, label);
    }
    // I5 globally: every locator ever recorded is still the current locator or retired.
    for (const record of store.snapshot()) {
      for (const locator of everLocators.get(record.accountId) ?? []) {
        assert.ok(isDeepStrictEqual(record.locator, locator) || record.retiredLocators.some(r => isDeepStrictEqual(r, locator)),
          `seed ${seed} lost a locator`);
      }
    }
  }
  t.diagnostic(`BINDING_PROPERTY_TOTALS ${JSON.stringify(totals)}`);
  // The generator actually exercised the interesting paths.
  for (const key of ['commit:reserve', 'commit:begin_provisioning', 'commit:complete_provisioning', 'commit:pause', 'commit:reconnect',
    'commit:confirm_reconnect', 'commit:resume_provisioning', 'commit:reprovision', 'commit:fail_provisioning', 'commit:release',
    'cas:conflict', 'cas:identity_conflict', 'refused:stale_lease', 'refused:stale_generation', 'refused:binding_reserved',
    'refused:owner_mismatch', 'refused:provider_mismatch']) {
    assert.ok((totals[key] ?? 0) > 0, `property run never produced ${key}: ${JSON.stringify(totals)}`);
  }
});

// ---------------------------------------------------------------------------
// Legacy Google adapter and disabled integration
// ---------------------------------------------------------------------------

test('legacy Google rows map read-only: folder preserved byte for byte, unfinished setup is resumable provisioning', () => {
  const userId = randomUUID();
  const row = Object.freeze({ userId, googleAccountId: SUB, driveRootFolderId: '1AbC_d-9xyz' });
  const mapped = bindingFromLegacyGoogle([row], T0);
  assert.ok(mapped.ok);
  assert.deepEqual(checkRecordInvariants(mapped.record), []);
  assert.deepEqual([mapped.record.state, mapped.record.generation, mapped.record.origin, mapped.record.locator],
    ['active', 0, 'legacy_google', { kind: 'drive_folder', folderId: '1AbC_d-9xyz' }]);
  assert.deepEqual(mapped.record.owner, { issuer: 'https://accounts.google.com', subject: SUB });
  assert.deepEqual(row, { userId, googleAccountId: SUB, driveRootFolderId: '1AbC_d-9xyz' }, 'input untouched');
  // The legacy binding behaves like any other: pause and reconnect keep the Drive folder.
  const paused = ok(mapped.record, pause(mapped.record), T0, userId);
  const back = ok(ok(paused, reconnect(G('a'), tok('r1')), T0, userId),
    { type: 'confirm_reconnect', actor: G('a'), token: tok('r1'), locator: { kind: 'drive_folder', folderId: '1AbC_d-9xyz' } }, T0, userId);
  assert.deepEqual(back.locator, { kind: 'drive_folder', folderId: '1AbC_d-9xyz' });

  const unfinished = bindingFromLegacyGoogle([{ ...row, driveRootFolderId: null }], T0);
  assert.ok(unfinished.ok);
  assert.deepEqual([unfinished.record.state, unfinished.record.idempotencyKey, unfinished.record.lease],
    ['provisioning', LEGACY_GOOGLE_SETUP_KEY, null]);
  assert.equal(transition(userId, unfinished.record, resume(D('x'), tok('rx')), T0).ok, false, 'not stealable');
  assert.equal(ok(unfinished.record, resume(G('a'), tok('r1')), T0, userId).idempotencyKey, LEGACY_GOOGLE_SETUP_KEY);

  assert.deepEqual(bindingFromLegacyGoogle([row, row], T0), { ok: false, error: 'multiple_google_accounts' });
  assert.deepEqual(bindingFromLegacyGoogle([{ ...row, driveRootFolderId: 'bad folder/..' }], T0), { ok: false, error: 'folder_invalid' });
  assert.deepEqual(bindingFromLegacyGoogle([{ ...row, googleAccountId: 'a@b.test' }], T0), { ok: false, error: 'invalid_subject' });
  assert.deepEqual(bindingFromLegacyGoogle([{ ...row, userId: 'legacy-user-0001' }], T0), { ok: false, error: 'invalid_account_id' });
});

test('integration is disabled: no route or app module imports the binding service, and the Mongo store refuses real targets', async () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path); else if (path.endsWith('.ts')) files.push(path);
  } };
  walk('src');
  walk('api');
  const importers = files.filter(path => !/storageBinding(Store)?\.ts$/.test(path) && /storageBinding/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(importers, []);

  const disposable = `atomic_test_${'a'.repeat(20)}`;
  assertDisposableBindingTarget({ dbName: disposable, collectionName: 'disposable_storage_bindings' });
  for (const target of [{ dbName: 'atomic_notes', collectionName: 'disposable_storage_bindings' },
    { dbName: disposable, collectionName: 'users' }, { dbName: disposable, collectionName: 'google_accounts' },
    { dbName: disposable, collectionName: 'storage_bindings' }, { dbName: 'atomic_test_short', collectionName: 'disposable_storage_bindings' }]) {
    assert.throws(() => createMongoBindingStore(target as never), /binding_store_disposable_target_required/, JSON.stringify(target));
  }
  await assert.rejects(readLegacyGoogleBindings({ databaseName: 'atomic_notes' } as never, T0), /binding_store_disposable_target_required/);
});
