import { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';
import { migrateAtomicFile, type AtomicFileV1 } from '../types/atomicFile.js';
import { remoteNoteRowSchema } from '../types/noteWire.js';

/** Preparation only: no production route imports this adapter yet. */
export async function generateNoteFileIdsWith(drive: drive_v3.Drive, count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('generation_count_invalid');
  const { data } = await drive.files.generateIds({ count, space: 'drive', type: 'files', fields: 'ids' });
  const ids = data.ids;
  if (!Array.isArray(ids) || ids.length !== count || ids.some((id) => typeof id !== 'string' || !id) ||
      new Set(ids).size !== count) throw new Error('generation_ids_invalid');
  return [...ids];
}

function checkedContent(content: unknown): AtomicFileV1 {
  const note = migrateAtomicFile(content);
  // Deletion belongs to Mongo metadata, not AtomicFile content. Validate a live
  // content projection using current wire bounds and plaintext/cipher refusal.
  remoteNoteRowSchema.parse({ ...note, deleted: false, created_at: note.createdAt, updated_at: note.updatedAt,
    enc_v: note.encV, base_version: 0 });
  return note;
}

/** Create-only generation: caller must durably retain the generated ID first.
 * Never discover by name, overwrite, untrash or delete an existing file.
 * A repeated create may report 409; accept it only after exact readback.
 */
export async function createNoteGenerationWith(drive: drive_v3.Drive, fileId: string,
  parentId: string, content: unknown): Promise<{ id: string; replayed: boolean }> {
  if (!fileId || !parentId) throw new Error('generation_identity_invalid');
  const expected = checkedContent(content);
  let replayed = false;
  try {
    const created = await drive.files.create({
      requestBody: { id: fileId, name: `${expected.id}.${fileId}.atomic`, parents: [parentId], mimeType: 'application/json' },
      media: { mimeType: 'application/json', body: Readable.from(JSON.stringify(expected)) }, fields: 'id',
    });
    if (created.data.id !== fileId) throw new Error('generation_identity_mismatch');
  } catch (error) {
    const e = error as { code?: number | string; status?: number | string; response?: { status?: number | string } } | null;
    if (![e?.code, e?.status, e?.response?.status].some((code) => code === 409 || code === '409')) throw error;
    replayed = true;
  }
  const metadata = (await drive.files.get({ fileId, fields: 'id,parents,mimeType,trashed' })).data;
  if (metadata.id !== fileId || metadata.trashed || metadata.mimeType !== 'application/json' ||
      !metadata.parents?.includes(parentId)) throw new Error('generation_identity_mismatch');
  const raw = (await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' })).data;
  const actual = checkedContent(raw);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('generation_content_mismatch');
  return { id: fileId, replayed };
}
