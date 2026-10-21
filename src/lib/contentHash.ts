import { createHash } from 'node:crypto';

/**
 * A fingerprint of what a note holds: its content and the flags that are written to Drive with it.
 * A push whose fingerprint equals the stored one changes nothing, so the Drive write is skipped.
 * It is computed from the parsed row, so key order is fixed by the schema.
 */
export function noteContentHash(row: {
  kind: string; title: string; body: string; items: unknown[]; pinned: boolean; important?: boolean; enc_v: number; payload: string | null;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([row.kind, row.title, row.body, row.items, row.pinned, row.enc_v, row.payload,
      ...(row.important === true ? [true] : [])]))
    .digest('hex');
}

/** Old clients omit importance; preserve the stored value before hashing/writing. */
export function resolveNoteImportance<T extends { important?: boolean }>(row: T, current?: { important?: boolean } | null): T {
  return row.important === undefined && current?.important !== undefined ? { ...row, important: current.important } : row;
}
