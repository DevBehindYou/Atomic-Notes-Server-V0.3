import { getEnvIssues, type EnvIssue } from './env.js';

/** An opt-in staging preflight. It never connects or changes runtime policy. */
export function getStagingEnvIssues(env: NodeJS.ProcessEnv = process.env): EnvIssue[] {
  const issues = getEnvIssues(env);
  if (!/^atomic_notes_app_staging(?:_[a-z0-9]+)?$/.test(env.MONGODB_DB_NAME ?? '')) {
    issues.push({ name: 'MONGODB_DB_NAME', problem: 'must explicitly name atomic_notes_app_staging or a lowercase test suffix' });
  }
  try {
    const callback = new URL(env.GOOGLE_REDIRECT_URI ?? '');
    if (!/^atomic-notes-app-server-staging(?:-[a-z0-9-]+)?\.vercel\.app$/.test(callback.hostname)
      || callback.protocol !== 'https:' || callback.port || callback.username || callback.password
      || callback.pathname !== '/api/auth/callback' || callback.search || callback.hash) {
      throw new Error('invalid staging callback');
    }
  } catch {
    issues.push({ name: 'GOOGLE_REDIRECT_URI', problem: 'must use the dedicated AppServer staging project HTTPS callback' });
  }
  // Native Android requests have no browser origin. An empty list is valid for
  // native-only testing; any browser allowlist must contain exact HTTPS origins.
  if (env.ALLOWED_ORIGIN?.trim()) {
    const origins = env.ALLOWED_ORIGIN.split(',').map(value => value.trim());
    if (origins.length > 10 || origins.some(value => {
      try {
        const url = new URL(value);
        return url.protocol !== 'https:' || url.origin !== value || url.hostname.includes('*')
          || Boolean(url.username || url.password);
      } catch { return true; }
    })) {
      issues.push({ name: 'ALLOWED_ORIGIN', problem: 'must contain at most ten exact HTTPS origins without paths or wildcards' });
    }
  }
  if (env.ATOMIC_LOGOUT_SYNC_ENABLED !== undefined && !['true', 'false'].includes(env.ATOMIC_LOGOUT_SYNC_ENABLED)) {
    issues.push({ name: 'ATOMIC_LOGOUT_SYNC_ENABLED', problem: 'must be true, false, or unset' });
  }
  return issues;
}
