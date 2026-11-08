import { createHash } from 'node:crypto';

/**
 * CI verification provenance (C46): which source and lockfile a run tested,
 * with which runtime, and whether any uploaded artifact contains a secret.
 * Reports carry names, digests and counts only, never a secret or its
 * position in a file.
 */

export const STEP_OUTCOMES = ['success', 'failure', 'cancelled', 'skipped'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number] | 'unavailable';

export type SecretFinding = { file: string; kind: string };

export type VerificationReport = {
  version: 1;
  scope: string;
  sourceHead: string | null;
  lockSha256: string;
  runtime: { node: string; npm: string | null };
  steps: Record<string, StepOutcome>;
  artifacts: { scanned: number; findings: SecretFinding[] };
  canaryDetected: boolean;
  outcome: 'pass' | 'fail';
};

const HEAD = /^[0-9a-f]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+$/;

/**
 * Shapes of credentials this project handles. Each is matched as a whole
 * token, so a proof that mentions a variable name does not match.
 */
const PATTERNS: ReadonlyArray<[kind: string, pattern: RegExp]> = [
  ['private_key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['google_access_token', /\bya29\.[0-9A-Za-z_-]{20,}/],
  ['google_refresh_token', /\b1\/\/0[0-9A-Za-z_-]{20,}/],
  ['google_client_secret', /\bGOCSPX-[0-9A-Za-z_-]{20,}/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/],
  ['credentialed_uri', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s/@"']+@/i],
];

/** Environment variable names whose values must never appear in artifacts. */
export const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CANARY)$/;

/** Secret values to look for: named secrets and credentialed URIs, 8+ chars. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (SECRET_NAME.test(name) || /:\/\/[^\s/@]+:[^\s/@]+@/.test(value)) values.add(value);
  }
  return [...values];
}

/** Every secret or credential shape found in [files]; values are not kept. */
export function scanForSecrets(
  files: ReadonlyArray<{ name: string; text: string }>, secrets: readonly string[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, text } of files) {
    const kinds = new Set<string>();
    for (const secret of secrets) if (secret && text.includes(secret)) kinds.add('environment_secret');
    for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) kinds.add(kind);
    for (const kind of [...kinds].sort()) findings.push({ file: name, kind });
  }
  return findings;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function outcome(value: string | undefined): StepOutcome {
  return (STEP_OUTCOMES as readonly string[]).includes(value ?? '') ? value as StepOutcome : 'unavailable';
}

/**
 * Builds the report. It passes only when the source head is a full SHA,
 * every recorded step succeeded, the scanner found its own canary (so it is
 * known to work) and no artifact contains a secret.
 */
export function buildVerificationReport(input: {
  sourceHead: string | undefined;
  lockBytes: Uint8Array;
  node: string;
  npm: string | undefined;
  steps: Record<string, string | undefined>;
  artifacts: ReadonlyArray<{ name: string; text: string }>;
  secrets: readonly string[];
  canary: string;
}): VerificationReport {
  const head = input.sourceHead?.trim().toLowerCase() ?? '';
  const steps = Object.fromEntries(Object.entries(input.steps).map(([k, v]) => [k, outcome(v)]));
  const canaryDetected = input.canary.length >= 16
    && scanForSecrets([{ name: 'canary-control', text: `x${input.canary}x` }], [input.canary]).length === 1;
  const findings = scanForSecrets(input.artifacts, [...input.secrets, input.canary]);
  const sourceHead = HEAD.test(head) ? head : null;
  const pass = sourceHead !== null && canaryDetected && findings.length === 0
    && Object.values(steps).every(v => v === 'success');
  return {
    version: 1,
    scope: 'Server CI source, lockfile, runtime, step outcomes and artifact secret scan',
    sourceHead,
    lockSha256: sha256Hex(input.lockBytes),
    runtime: {
      node: VERSION.test(input.node) ? input.node : 'unknown',
      npm: input.npm && VERSION.test(input.npm.trim()) ? input.npm.trim() : null,
    },
    steps,
    artifacts: { scanned: input.artifacts.length, findings },
    canaryDetected,
    outcome: pass ? 'pass' : 'fail',
  };
}
