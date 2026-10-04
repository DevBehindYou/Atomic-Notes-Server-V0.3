import { randomUUID } from 'node:crypto';

/** Test-only: reject credentials, remote seeds, selected databases and URI option drift. */
export function fixtureDatabase(uri: string | undefined, selectedDatabase?: string): string {
  if (selectedDatabase !== undefined) throw new Error('fixture_database_must_be_generated');
  let parsed: URL;
  try { parsed = new URL(uri ?? ''); }
  catch { throw new Error('fixture_requires_canonical_local_replica_set'); }
  const options = [...parsed.searchParams.entries()];
  if (parsed.protocol !== 'mongodb:' || parsed.hostname !== '127.0.0.1' ||
      !parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65535 || parsed.username || parsed.password ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      options.length !== 2 || parsed.hash ||
      parsed.searchParams.get('replicaSet') !== 'rs0' ||
      parsed.searchParams.get('directConnection') !== 'true' ||
      !options.every(([key]) => key === 'replicaSet' || key === 'directConnection')) {
    throw new Error('fixture_requires_canonical_local_replica_set');
  }
  return `atomic_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function assertFixtureCleanup(actual: string, expected: string): void {
  if (!/^atomic_test_[a-f0-9]{20}$/.test(expected) || actual !== expected) {
    throw new Error('fixture_cleanup_identity_mismatch');
  }
}
