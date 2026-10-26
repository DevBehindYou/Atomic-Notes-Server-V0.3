import { getStagingEnvIssues } from '../lib/stagingEnv.js';

// Deliberately does not load .env, print values, import the app, or contact services.
const issues = getStagingEnvIssues();
if (issues.length) {
  for (const issue of issues) console.error(`${issue.name}: ${issue.problem}`);
  process.exitCode = 1;
} else {
  console.log('Staging configuration shape passed. The owner must separately confirm resource and secret isolation.');
}
