import { createHash } from 'node:crypto';

/** Existing operation identity; key and array order are part of the envelope. */
export const fingerprintOf = (rows: unknown[], mode: string) =>
  createHash('sha256').update(JSON.stringify({ rows, mode })).digest('hex');
