import { createHash } from 'node:crypto';
import { userSchema } from './collections.js';
import { assertSanitized } from './queryDiagnostics.js';
import {
  IDENTITY_CONTRACT_VERSION, identityFromLegacy, identityKey, isAccountId, isFolderId, libraryFromLegacy, subjectError,
  type IdentityRecordV1, type LibraryRecordV1,
} from '../lib/identityContract.js';

// C28 dry-run planner. Pure: takes projected users/google_accounts rows and returns
// the identity/library records a future backfill WOULD create, plus classified problems.
// There is no apply mode. Identity is matched by Google subject only, never by email.
//
// Determinism: users are ordered by a type-tagged code-unit key of _id, independent of
// input order. Each entry is hashed, and the hashes are chained from a digest of the
// whole projected input. A window of `limit` users ends with a checkpoint that names
// the input digest, position, last user reference and chain value. Resuming recomputes
// the prefix and refuses if any of them differ, so a resumed run yields exactly the
// remainder of the uninterrupted plan, or nothing.

export type UserRow = { _id: unknown; email?: unknown; displayName?: unknown; createdAt?: unknown; updatedAt?: unknown };
export type AccountRow = { _id: unknown; userId?: unknown; googleAccountId?: unknown; driveRootFolderId?: unknown; createdAt?: unknown };

/** Blocking problems stop the account's identity or library mapping. Advisory problems do not. */
export const BLOCKING_PROBLEMS = [
  'user_id_not_uuid', 'no_google_account', 'multiple_google_accounts', 'subject_invalid', 'subject_email_shaped',
  'subject_duplicate', 'folder_missing', 'folder_invalid', 'folder_shared',
] as const;
/** Email is contact metadata in the target model; these never block a subject-keyed mapping. */
export const ADVISORY_PROBLEMS = [
  'email_missing', 'email_malformed', 'email_not_normalized', 'email_duplicate', 'legacy_reader_rejects_user',
] as const;
export type Problem = typeof BLOCKING_PROBLEMS[number] | typeof ADVISORY_PROBLEMS[number];
const PROBLEMS: readonly Problem[] = [...BLOCKING_PROBLEMS, ...ADVISORY_PROBLEMS];
const BLOCKING = new Set<Problem>(BLOCKING_PROBLEMS);

export type PlanEntry = {
  userRef: string;
  disposition: 'ready' | 'blocked';
  identities: IdentityRecordV1[];
  library: LibraryRecordV1 | null;
  problems: Problem[];
  entryHash: string;
};

export const SAMPLE_LIMIT = 5;
export const MAX_LIMIT = 100_000;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Truncated, domain-separated one-way references. Never the id, email, subject or folder itself. */
export const userRef = (id: unknown) => sha(`atomic-c28-user:${typeof id}:${String(id)}`).slice(0, 16);
const DIGEST = 20;

const sortKey = (id: unknown) => typeof id === 'string' ? `0${id}` : `1${typeof id}:${String(id)}`;
const byKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonical = (value: unknown) => value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : 'invalid-date')
  : value === undefined ? { missing: true } : typeof value === 'object' && value !== null ? { type: typeof value, text: String(value) } : value;

/** Digest of every projected field the planner reads, in planner order. */
function inputDigest(users: readonly UserRow[], accounts: readonly AccountRow[]): string {
  const hash = createHash('sha256').update('atomic-c28-input-v1\n');
  for (const u of users) {
    hash.update(JSON.stringify(['u', sortKey(u._id), canonical(u.email), canonical(u.displayName), canonical(u.createdAt), canonical(u.updatedAt)]));
    hash.update('\n');
  }
  for (const a of accounts) {
    hash.update(JSON.stringify(['a', sortKey(a._id), canonical(a.userId), canonical(a.googleAccountId), canonical(a.driveRootFolderId), canonical(a.createdAt)]));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, DIGEST);
}
const chainStart = (digest: string) => sha(`atomic-c28-plan-v1|${digest}`).slice(0, DIGEST);
const chainNext = (chain: string, entryHash: string) => sha(`${chain}|${entryHash}`).slice(0, DIGEST);

export type Checkpoint = { processed: number; lastUserRef: string; chain: string; inputDigest: string };
const CHECKPOINT = /^c28\.1\.(\d{1,9})\.([0-9a-f]{16})\.([0-9a-f]{20})\.([0-9a-f]{20})$/;
export const formatCheckpoint = (c: Checkpoint) => `c28.1.${c.processed}.${c.lastUserRef}.${c.chain}.${c.inputDigest}`;
export function parseCheckpoint(token: string): Checkpoint {
  const match = CHECKPOINT.exec(token);
  if (!match || +match[1] < 1) throw new Error('identity_plan_checkpoint_invalid');
  return { processed: +match[1], lastUserRef: match[2], chain: match[3], inputDigest: match[4] };
}

type Index = {
  users: UserRow[];
  accounts: AccountRow[];
  accountsByUser: Map<string, AccountRow[]>;
  subjectCount: Map<string, number>;
  folderUsers: Map<string, Set<string>>;
  emailUsers: Map<string, Set<string>>;
  orphans: { missingUser: number; invalidUserId: number };
};

function buildIndex(inputUsers: readonly UserRow[], inputAccounts: readonly AccountRow[]): Index {
  const users = [...inputUsers].sort((a, b) => byKey(sortKey(a._id), sortKey(b._id)));
  const accounts = [...inputAccounts].sort((a, b) => byKey(sortKey(a._id), sortKey(b._id)));
  const known = new Set<string>();
  for (const u of users) {
    const key = sortKey(u._id);
    if (known.has(key)) throw new Error('identity_plan_duplicate_user_id'); // impossible for a Mongo _id
    known.add(key);
  }
  const index: Index = { users, accounts, accountsByUser: new Map(), subjectCount: new Map(), folderUsers: new Map(),
    emailUsers: new Map(), orphans: { missingUser: 0, invalidUserId: 0 } };
  for (const a of accounts) {
    // Exact-equality subject collisions, across every row (also orphans): the unique index may be absent.
    if (typeof a.googleAccountId === 'string') index.subjectCount.set(a.googleAccountId, (index.subjectCount.get(a.googleAccountId) ?? 0) + 1);
    if (typeof a.userId !== 'string') { index.orphans.invalidUserId++; continue; }
    if (!known.has(sortKey(a.userId))) { index.orphans.missingUser++; continue; }
    const list = index.accountsByUser.get(a.userId) ?? [];
    list.push(a);
    index.accountsByUser.set(a.userId, list);
    if (typeof a.driveRootFolderId === 'string') {
      const owners = index.folderUsers.get(a.driveRootFolderId) ?? new Set<string>();
      owners.add(a.userId);
      index.folderUsers.set(a.driveRootFolderId, owners);
    }
  }
  for (const u of users) {
    if (typeof u.email !== 'string' || u.email.trim() === '') continue;
    const normalized = u.email.trim().toLowerCase();
    const owners = index.emailUsers.get(normalized) ?? new Set<string>();
    owners.add(sortKey(u._id));
    index.emailUsers.set(normalized, owners);
  }
  return index;
}

function planUser(user: UserRow, index: Index): PlanEntry {
  const problems = new Set<Problem>();
  const id = user._id;
  const validId = isAccountId(id);
  if (!validId) problems.add('user_id_not_uuid');
  const accounts = typeof id === 'string' ? index.accountsByUser.get(id) ?? [] : [];
  if (accounts.length === 0) problems.add('no_google_account');
  if (accounts.length > 1) problems.add('multiple_google_accounts');

  const identities: IdentityRecordV1[] = [];
  for (const account of accounts) {
    const subject = account.googleAccountId;
    const duplicate = typeof subject === 'string' && (index.subjectCount.get(subject) ?? 0) > 1;
    if (duplicate) problems.add('subject_duplicate');
    const invalid = subjectError(subject);
    if (invalid) problems.add(invalid === 'subject_email_shaped' ? 'subject_email_shaped' : 'subject_invalid');
    if (invalid || !validId || duplicate) continue;
    const parsed = identityFromLegacy(id, subject);
    if (!parsed.ok) throw new Error('identity_plan_contract_disagreement'); // validated above
    identities.push(parsed.value);
  }
  identities.sort((a, b) => byKey(identityKey(a), identityKey(b)));

  let library: LibraryRecordV1 | null = null;
  if (accounts.length === 1) {
    const [account] = accounts;
    const folder = account.driveRootFolderId;
    if (folder === null || folder === undefined || folder === '') problems.add('folder_missing');
    else if (!isFolderId(folder)) problems.add('folder_invalid');
    else if ((index.folderUsers.get(folder)?.size ?? 0) > 1) problems.add('folder_shared');
    else if (identities.length === 1) {
      const parsed = libraryFromLegacy(id, account.googleAccountId, folder);
      if (parsed.ok) library = parsed.value;
    }
  }

  if (user.email === undefined || user.email === null || (typeof user.email === 'string' && user.email.trim() === '')) {
    problems.add('email_missing');
  } else if (typeof user.email !== 'string' || !userSchema.shape.email.safeParse(user.email).success) {
    problems.add('email_malformed');
  }
  if (typeof user.email === 'string' && user.email.trim() !== '') {
    if (user.email !== user.email.trim().toLowerCase()) problems.add('email_not_normalized');
    if ((index.emailUsers.get(user.email.trim().toLowerCase())?.size ?? 0) > 1) problems.add('email_duplicate');
  }
  if (!userSchema.safeParse({ _id: user._id, email: user.email, displayName: user.displayName,
    createdAt: user.createdAt, updatedAt: user.updatedAt }).success) problems.add('legacy_reader_rejects_user');

  const ordered = PROBLEMS.filter(problem => problems.has(problem));
  const disposition = ordered.some(problem => BLOCKING.has(problem)) ? 'blocked' : 'ready';
  const entryHash = sha(`atomic-c28-entry-v1\n${JSON.stringify([sortKey(id), disposition, identities.map(identityKey),
    library ? [identityKey(library.owner), library.locator.folderId] : null, ordered])}`);
  return { userRef: userRef(id), disposition, identities, library, problems: ordered, entryHash };
}

export type PlanOptions = { limit?: number; resume?: string };
export type IdentityPlan = {
  inputDigest: string;
  entries: PlanEntry[];
  window: { start: number; processed: number; total: number; complete: boolean };
  planDigest: string;
  checkpoint: string | null;
  index: Pick<Index, 'orphans'> & { collisions: Collisions; population: { users: number; googleAccounts: number } };
};
type Collisions = { emailGroups: number; emailUsers: number; subjectGroups: number; subjectAccounts: number;
  folderGroups: number; folderUsers: number };

/** Plans one window. Holds clear identifiers in memory only; see `planReport` for the sanitized view. */
export function planIdentityMigration(users: readonly UserRow[], accounts: readonly AccountRow[], options: PlanOptions = {}): IdentityPlan {
  const limit = options.limit ?? MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('identity_plan_limit_invalid');
  const index = buildIndex(users, accounts);
  const digest = inputDigest(index.users, index.accounts);
  let chain = chainStart(digest);
  let start = 0;
  if (options.resume !== undefined) {
    const checkpoint = parseCheckpoint(options.resume);
    if (checkpoint.inputDigest !== digest) throw new Error('identity_plan_checkpoint_stale');
    if (checkpoint.processed > index.users.length) throw new Error('identity_plan_checkpoint_mismatch');
    for (let i = 0; i < checkpoint.processed; i++) chain = chainNext(chain, planUser(index.users[i], index).entryHash);
    if (chain !== checkpoint.chain || userRef(index.users[checkpoint.processed - 1]._id) !== checkpoint.lastUserRef) {
      throw new Error('identity_plan_checkpoint_mismatch');
    }
    start = checkpoint.processed;
  }
  const entries: PlanEntry[] = [];
  for (let i = start; i < index.users.length && entries.length < limit; i++) {
    const entry = planUser(index.users[i], index);
    chain = chainNext(chain, entry.entryHash);
    entries.push(entry);
  }
  const processed = start + entries.length;
  const complete = processed === index.users.length;
  const groups = (map: Map<string, Set<string>>) => [...map.values()].filter(set => set.size > 1);
  const email = groups(index.emailUsers), folder = groups(index.folderUsers);
  const subject = [...index.subjectCount.values()].filter(n => n > 1);
  return {
    inputDigest: digest, entries, window: { start, processed, total: index.users.length, complete }, planDigest: chain,
    checkpoint: complete ? null : formatCheckpoint({ processed, lastUserRef: entries.at(-1)!.userRef, chain, inputDigest: digest }),
    index: { orphans: { ...index.orphans }, population: { users: index.users.length, googleAccounts: index.accounts.length },
      collisions: { emailGroups: email.length, emailUsers: email.reduce((n, s) => n + s.size, 0), subjectGroups: subject.length,
        subjectAccounts: subject.reduce((n, c) => n + c, 0), folderGroups: folder.length, folderUsers: folder.reduce((n, s) => n + s.size, 0) } },
  };
}

export type IndexCatalog = { usersEmailUnique: boolean; usersEmailCaseInsensitive: boolean; googleSubjectUnique: boolean;
  googleUserIdUnique: boolean };
export type IdentityPlanReport = {
  version: 1; tool: 'c28-identity-migration-plan'; contractVersion: typeof IDENTITY_CONTRACT_VERSION;
  mode: 'read-only' | 'in-process'; database: 'operator-selected' | 'caller-selected'; applied: false; snapshot: boolean;
  population: { users: number; googleAccounts: number; orphanGoogleAccounts: { missingUser: number; invalidUserId: number } };
  collisions: Collisions;
  catalog: IndexCatalog | null;
  window: IdentityPlan['window'] & { resumed: boolean };
  dispositions: { ready: number; blocked: number };
  planned: { identities: number; libraries: number };
  problems: Record<Problem, number>;
  samples: Partial<Record<Problem, string[]>>;
  digests: { input: string; plan: string };
  checkpoint: string | null;
};

/** Counts, truncated references and digests only. Throws if anything identifying slipped in. */
export function planReport(plan: IdentityPlan, meta: { mode?: IdentityPlanReport['mode']; database?: IdentityPlanReport['database'];
  snapshot?: boolean; catalog?: IndexCatalog | null; resumed: boolean }): IdentityPlanReport {
  const problems = Object.fromEntries(PROBLEMS.map(problem => [problem, 0])) as Record<Problem, number>;
  const samples: Partial<Record<Problem, string[]>> = {};
  const dispositions = { ready: 0, blocked: 0 };
  const planned = { identities: 0, libraries: 0 };
  for (const entry of plan.entries) {
    dispositions[entry.disposition]++;
    planned.identities += entry.identities.length;
    if (entry.library) planned.libraries++;
    for (const problem of entry.problems) {
      problems[problem]++;
      const list = samples[problem] ??= [];
      if (list.length < SAMPLE_LIMIT) list.push(entry.userRef);
    }
  }
  const report: IdentityPlanReport = {
    version: 1, tool: 'c28-identity-migration-plan', contractVersion: IDENTITY_CONTRACT_VERSION,
    mode: meta.mode ?? 'in-process', database: meta.database ?? 'caller-selected', applied: false, snapshot: meta.snapshot ?? false,
    population: { ...plan.index.population, orphanGoogleAccounts: plan.index.orphans }, collisions: plan.index.collisions,
    catalog: meta.catalog ?? null, window: { ...plan.window, resumed: meta.resumed }, dispositions, planned, problems, samples,
    digests: { input: plan.inputDigest, plan: plan.planDigest }, checkpoint: plan.checkpoint,
  };
  assertSanitized(report);
  return report;
}

/** True when this window or the global index found anything that would block a backfill. */
export const hasBlockingFindings = (report: IdentityPlanReport) => report.dispositions.blocked > 0
  || report.population.orphanGoogleAccounts.missingUser > 0 || report.population.orphanGoogleAccounts.invalidUserId > 0
  || report.collisions.subjectGroups > 0;
