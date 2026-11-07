import { Readable } from 'node:stream';
import { google, drive_v3 } from 'googleapis';
import { getTokenRefreshClient, loopbackAdapter, type GoogleTransportOverrides } from './googleOAuth.js';

const APP_FOLDER_NAME = 'My-Atomic-Notes';

/** Bound on each Drive HTTP request, including a media upload or download. */
export const DRIVE_REQUEST_TIMEOUT_MS = 20000;

/** Test seam only: a loopback Google origin and a shorter Drive timeout. */
export type DriveClientOverrides = GoogleTransportOverrides & { timeout?: number };

/**
 * The Drive library's own retry is kept only for a read that got no response at all (a reset keep-alive
 * socket, for example). It never resends a POST or PATCH and never retries a timeout. Its retry of a 429
 * or 5xx answer is off, because [withDriveRetry] retries those already: the two layers together sent up
 * to 16 requests per read under a rate-limit storm. A rate-limited read is now sent at most 4 times, the
 * same bound as a write.
 */
const DRIVE_RETRY_CONFIG = { statusCodesToRetry: [] as [number, number][] };

export function driveClient(accessToken: string, refreshToken: string, overrides: DriveClientOverrides = {}): drive_v3.Drive {
  const auth = getTokenRefreshClient(overrides);
  auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth, timeout: overrides.timeout ?? DRIVE_REQUEST_TIMEOUT_MS,
    retryConfig: DRIVE_RETRY_CONFIG,
    ...(overrides.origin ? { adapter: loopbackAdapter(overrides.origin) } : {}) });
}

/** The Drive calls that one request makes for one user. */
export type DriveCalls = {
  createNoteFile(parentId: string, filename: string, content: object): Promise<drive_v3.Schema$File>;
  updateNoteFile(fileId: string, content: object): Promise<drive_v3.Schema$File>;
  deleteNoteFile(fileId: string): Promise<void>;
  getNoteFileContent(fileId: string): Promise<Record<string, unknown>>;
  ensureAppFolders(): Promise<{ notesId: string }>;
};

/**
 * Drive calls for one user's tokens that share one OAuth client and one Drive client. A route builds one
 * per request, after loading that user's tokens, and drops it when the request ends. Never keep one in
 * module scope or reuse it for another user or request: it holds that user's credentials, including an
 * access token the library may refresh during the request.
 *
 * Within the request, a token refreshed after a 401 is used by every later call and concurrent refreshes
 * merge into one, instead of every call building a client and refreshing the stale token for itself.
 */
export function driveSession(accessToken: string, refreshToken: string, overrides: DriveClientOverrides = {}): DriveCalls {
  const drive = driveClient(accessToken, refreshToken, overrides);
  return {
    createNoteFile: (parentId, filename, content) => createNoteFileWith(drive, parentId, filename, content),
    updateNoteFile: (fileId, content) => updateNoteFileWith(drive, fileId, content),
    deleteNoteFile: (fileId) => deleteNoteFileWith(drive, fileId),
    getNoteFileContent: (fileId) => getNoteFileContentWith(drive, fileId),
    ensureAppFolders: async () => ({ notesId: await findOrCreateFolder(drive, APP_FOLDER_NAME) }),
  };
}

export async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId?: string,
): Promise<string> {
  const q = [
    `mimeType = 'application/vnd.google-apps.folder'`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `trashed = false`,
    parentId ? `'${parentId}' in parents` : `'root' in parents`,
  ].join(' and ');

  const existing = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  if (existing.data.files?.length) return existing.data.files[0].id!;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });
  return created.data.id!;
}

/** Ensures "My-Atomic-Notes" exists in the user's Drive. Called once, on first connect. */
export async function ensureAppFolders(accessToken: string, refreshToken: string) {
  const drive = driveClient(accessToken, refreshToken);
  const notesId = await findOrCreateFolder(drive, APP_FOLDER_NAME);
  return { notesId };
}

const quoteQueryValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Drive and MongoDB cannot commit together, so a create can succeed and the
 * metadata commit after it fail. Filenames are the note ID, so a retry looks
 * for that file first and rewrites it instead of leaving a second copy.
 * That guard is only as good as the name lookup: it assumes Drive lists a file
 * it has just committed. Google documents pre-generated IDs (driveGeneration.ts,
 * not yet wired into /push) as the duplicate-proof way to retry an ambiguous create.
 */
export async function createNoteFileWith(drive: drive_v3.Drive, parentId: string, filename: string, content: object) {
  const media = () => ({ mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) });
  const fields = 'id, headRevisionId, modifiedTime';
  const found = await drive.files.list({
    q: `name = '${quoteQueryValue(filename)}' and '${quoteQueryValue(parentId)}' in parents and trashed = false`,
    fields: 'files(id)', spaces: 'drive', pageSize: 1,
  });
  const existingId = found.data.files?.[0]?.id;
  if (existingId) return (await drive.files.update({ fileId: existingId, media: media(), fields })).data;
  return (await drive.files.create({
    requestBody: { name: filename, parents: [parentId], mimeType: 'application/json' }, media: media(), fields,
  })).data;
}

export async function createNoteFile(
  accessToken: string,
  refreshToken: string,
  parentId: string,
  filename: string,
  content: object,
) {
  return createNoteFileWith(driveClient(accessToken, refreshToken), parentId, filename, content);
}

export async function updateNoteFileWith(drive: drive_v3.Drive, fileId: string, content: object) {
  const res = await drive.files.update({
    fileId,
    requestBody: { trashed: false },
    media: { mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) },
    fields: 'id, headRevisionId, modifiedTime',
  });
  return res.data;
}

export async function updateNoteFile(
  accessToken: string,
  refreshToken: string,
  fileId: string,
  content: object,
) {
  return updateNoteFileWith(driveClient(accessToken, refreshToken), fileId, content);
}

/** Trashes rather than permanently deletes — gives the user a recovery window via Drive's own trash. */
export async function deleteNoteFileWith(drive: drive_v3.Drive, fileId: string) {
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

export async function deleteNoteFile(accessToken: string, refreshToken: string, fileId: string) {
  await deleteNoteFileWith(driveClient(accessToken, refreshToken), fileId);
}

export async function getFileRevision(accessToken: string, refreshToken: string, fileId: string) {
  const drive = driveClient(accessToken, refreshToken);
  const res = await drive.files.get({ fileId, fields: 'headRevisionId, modifiedTime' });
  return res.data;
}

/**
 * Downloads and parses a `.atomic` file's actual content. Added alongside
 * the pull/sync endpoints — the first pass of this backend only ever wrote
 * Drive content, never read it back, which is fine for per-note CRUD (the
 * client already has what it just wrote) but not for pull, which needs to
 * hand back content the client doesn't have yet.
 */
export async function getNoteFileContentWith(drive: drive_v3.Drive, fileId: string) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
  return res.data as Record<string, unknown>;
}

export async function getNoteFileContent(accessToken: string, refreshToken: string, fileId: string) {
  return getNoteFileContentWith(driveClient(accessToken, refreshToken), fileId);
}

/** True when Google answered "not found": the file or its folder was deleted outside the app. */
export function isDriveNotFound(error: unknown): boolean {
  const e = error as { code?: number | string; status?: number | string; response?: { status?: number | string } } | null;
  return [e?.code, e?.status, e?.response?.status].some((value) => value === 404 || value === '404');
}

/**
 * True for Google's "slow down" answers (429, and 403 with a rate-limit reason) and for passing 5xx errors.
 * Google asks clients to retry these with exponential backoff; everything else (404, 401, 400) is final.
 */
export function isDriveRetryable(error: unknown): boolean {
  type Reason = { reason?: string };
  const e = error as {
    code?: number | string; status?: number | string; errors?: Reason[];
    response?: { status?: number | string; data?: { error?: { errors?: Reason[] } } };
  } | null;
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (status !== 403) return false;
  const reasons = [...(e?.errors ?? []), ...(e?.response?.data?.error?.errors ?? [])].map((r) => r?.reason);
  return reasons.some((r) => r === 'userRateLimitExceeded' || r === 'rateLimitExceeded');
}

/**
 * Runs one Drive call, retrying [isDriveRetryable] failures after 0.5 s, 1 s, then 2 s (plus up to 0.5 s of
 * jitter, so parallel writes do not retry in step). Every call made through it is safe to repeat: updates and
 * reads are idempotent, and a create reruns its name lookup first (see [createNoteFileWith]).
 *
 * A timeout or a dropped connection is never retried here: Google may have committed the write, and
 * the caller reports the row as failed so the App retries it later. The Drive library does not retry
 * these answers itself (see [driveClient]), so each attempt here is one request.
 */
export async function withDriveRetry<T>(
  call: () => Promise<T>,
  { attempts = 4, baseMs = 500, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isDriveRetryable(error)) throw error;
      await sleep(baseMs * 2 ** (attempt - 1) + Math.random() * baseMs);
    }
  }
}
