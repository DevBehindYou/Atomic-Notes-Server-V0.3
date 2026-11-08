// Records which source and lockfile this CI run verified and refuses to let a
// secret reach an uploaded artifact (C46). Run from the repository root after
// the tests, before any artifact is uploaded:
//
//   node --import tsx src/scripts/recordVerification.ts
//
// Reads ATOMIC_VERIFY_SOURCE_HEAD, ATOMIC_VERIFY_NPM, ATOMIC_CI_CANARY and one
// ATOMIC_VERIFY_<STEP> outcome per step. Writes ci-server-verification-proof.json.
// Exits 1 only when artifacts must not be uploaded: a secret was found, the
// scanner's own canary was not detected, or the source head is unknown. Failed
// test steps are recorded in the report; they already fail the job.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { buildVerificationReport, secretValues } from '../lib/verificationProvenance.js';

const OUTPUT = 'ci-server-verification-proof.json';
const STEPS = ['install', 'typecheck', 'audit', 'deployment', 'unit', 'integration', 'clientFixture'];
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

const env = process.env;
const oversized: string[] = [];
const artifacts = readdirSync('.')
  .filter(name => /^ci-[\w.-]+\.json$/.test(name) && name !== OUTPUT)
  .sort()
  .flatMap(name => {
    const stat = statSync(name);
    if (!stat.isFile()) return [];
    // Too large to scan is itself a failure, reported as a finding below.
    if (stat.size > MAX_ARTIFACT_BYTES) { oversized.push(name); return []; }
    return [{ name, text: readFileSync(name, 'utf8') }];
  });

const report = buildVerificationReport({
  sourceHead: env.ATOMIC_VERIFY_SOURCE_HEAD,
  lockBytes: readFileSync('package-lock.json'),
  node: process.version,
  npm: env.ATOMIC_VERIFY_NPM,
  steps: Object.fromEntries(STEPS.map(step => [step, env[`ATOMIC_VERIFY_${step.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`]])),
  artifacts,
  secrets: secretValues(env),
  canary: env.ATOMIC_CI_CANARY ?? '',
});

if (oversized.length) {
  report.artifacts.findings.push(...oversized.map(file => ({ file, kind: 'too_large_to_scan' })));
  report.outcome = 'fail';
}

writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outcome: report.outcome, scanned: report.artifacts.scanned,
  findings: report.artifacts.findings, steps: report.steps }));
const unsafe = report.artifacts.findings.length > 0 || !report.canaryDetected || report.sourceHead === null;
process.exitCode = unsafe ? 1 : 0;
