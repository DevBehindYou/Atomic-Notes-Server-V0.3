# AppServer isolated Vercel staging

This prepares the App API for a **new** project named `atomic-notes-app-server-staging`.
It does not configure or deploy the existing production project. The separately
deployed WebAppServer uses a different Vercel project. Its current gateway
foundation needs no database, OAuth credentials or application secrets. Future
browser-session configuration is separate, while note and wallet mutations must
delegate to the reviewed AppServer authority rather than introducing a competing
database/financial writer.

## Project settings

Create the project in the owner's intended Vercel team, using this repository's
root as Root Directory. Select **Other** (`framework: null`), Node.js **22.x**,
install `npm ci`, build `npm run build`, and output `public`. Keep the checked-in
`vercel.json`: one explicit Node function at `api/index.ts`, `bom1`, 300-second
maximum duration, and `/api/(.*)` rewritten to `/api`. Do not turn on Hono
framework autodetection or add a second entrypoint on top of this configuration.
The existing Web Standard `export default { fetch: app.fetch }` handler is
[supported by Vercel](https://vercel.com/docs/functions/functions-api-reference).

Use the dedicated project's stable alias
`https://atomic-notes-app-server-staging.vercel.app` (verify the actual assigned
alias before registering OAuth). Vercel calls this new project's stable target
**Production**; its application role is still **staging**. Select this new
project's Production scope when setting the variables below. If branch Preview
deployments are also enabled, configure their Preview scope separately and keep
OAuth on a stable staging hostname. Never relink the existing production
project, import its variables, promote a deployment into it, or reuse its data.

## Owner-configured variables

The owner enters credentials directly in Vercel's Environment Variables UI. Do
not paste credentials into chat, source files, CLI arguments, build logs, or PRs.
Do not pull an existing project's environment. The checked-in
[`staging.env.example`](../staging.env.example) contains names and non-secret
settings only; it is not a usable credential set and is never auto-loaded.

| Variable | Staging requirement |
| --- | --- |
| `MONGODB_URI` | New isolated Atlas replica-set deployment, staging-only database user and network policy. Transactions require a replica set. Never use the production URI/user. |
| `MONGODB_DB_NAME` | Explicitly `atomic_notes_app_staging` (or `atomic_notes_app_staging_<lowercase-test-suffix>`). No fallback database. Restrict the DB user to this staging database. |
| `GOOGLE_CLIENT_ID` | New **Web application** OAuth client in a separate staging Google Cloud project with Drive API enabled. This ID is also the native client's `serverClientId`. |
| `GOOGLE_CLIENT_SECRET` | Secret belonging to that staging Web OAuth client, configured only on the server. |
| `GOOGLE_REDIRECT_URI` | Exact registered HTTPS callback, normally `https://atomic-notes-app-server-staging.vercel.app/api/auth/callback`. |
| `TOKEN_ENCRYPTION_KEY` | New staging-only base64 value decoding to exactly 32 bytes. Owner generates and stores it privately. Rotating it makes existing encrypted staging Google tokens unreadable. |
| `ADMIN_API_KEY` | New staging-only secret containing at least 32 bytes. Only trusted server-side controller/test tooling may use it. |
| `ALLOWED_ORIGIN` | Optional comma-separated exact HTTPS browser origins. Leave unset for native-only tests; use only intended staging browser origins if needed. CORS does not authenticate native apps. |
| `ATOMIC_LOGOUT_SYNC_ENABLED` | Optional `true` or `false`. Leave unset for the existing default behavior unless the accepted staging test plan specifically enables it. |
| `COIN_EXPIRY_ACTIVATED_AT` | Leave unset for baseline staging. Activating coin-expiry policy is a separate, explicit acceptance decision. |

`NODE_ENV`/`VERCEL_ENV` are platform-managed. `PORT` is local-development only.
No Vercel token, bypass secret, MongoDB URI, OAuth secret, token-encryption key,
or admin key belongs in an APK or browser bundle.

Resource isolation cannot be established by checking variable formats. Before
the first functional login, the owner confirms the cluster, database permissions,
OAuth project/client, and every secret are independent of real production and
any unrelated application. Do not create a duplicate WebApp wallet or note store
as a shortcut to deployment. Use dedicated Google **test accounts** with no
real notes, and add them as test users on the staging consent screen. Keep the
current scopes (`openid`, `email`, `profile`, `drive.file`); do not broaden Drive
access. Native testing also requires matching staging Android/iOS OAuth client
registrations for the test app's package/signature and the same staging Web
client ID. Browser callback registration alone does not prove native sign-in.

## Verification before deployment

On Node 22 with installed lockfile dependencies:

```text
npm run check:deployment
npm run typecheck
npm test
```

`check:deployment` compiles the source, checks the explicit Vercel config/static
output, then cold-starts both `api/index.ts` and `dist/api/index.js` in child
processes with public synthetic configuration and network access blocked. It
checks `/api/health` is 200 with `{ "ok": true }`, an unknown route is 404, admin
health rejects missing credentials, and missing production configuration fails
at import. It never loads `.env` or uses a live database/Google account.

The owner can run `npm run check:staging-env` in an approved environment with
the staging variables already injected. It loads no env file, contacts no
service, mutates no database, and reports **names and problems only**. It checks
the existing runtime-required variables, explicit staging database/callback,
browser-origin format, and optional logout flag. Passing is a configuration
shape check, not proof of resource isolation or functional acceptance. Do not
invoke this against a production environment or add production values to make
it pass.

## Deployment and functional acceptance

After source review and owner configuration, deploy only to the new staging
project and record its project ID, commit SHA, deployment URL, target scope and
build status. Inspect the Vercel build output: exactly the intended `api/index`
Node function plus `public/robots.txt`; no duplicate framework function. A local
TypeScript build and smoke are not a Vercel build/deployment result. Keep this
as a required deployed check rather than rewriting the working handler without
a concrete failure.

Before DB-backed tests, the owner runs the existing `db:indexes` procedure only
with this staging URI/database injected. That command may load local `.env`, so
use an isolated clean staging checkout with no local env file and inspect its
target privately first. It performs database writes; never run it with an
unknown/default or production target. No automatic data migration or cleanup is
part of this preparation.

Record separate evidence for these gates:

1. Deployment is READY, intended function exists, `/api/health` is 200, and
   `/robots.txt` disallows crawling. Health proves app liveness only.
2. Admin health through trusted server-side tooling reports no configuration
   issues and DB connectivity on staging. Do not publish raw admin responses or
   upstream errors that may contain provider details. Connectivity does not
   establish transaction/index correctness.
3. Staging browser OAuth validates its state binding/callback, and Android
   native `POST /api/auth/google/mobile` exchanges a fresh staging server auth
   code. Verify offline Drive consent and a returning test login separately.
4. Against disposable staging accounts/data: note creation/edit/importance,
   sync/recovery, Drive readback, logout/session revocation, and existing
   financial/ledger acceptance suites. Preserve current auth and wallet rules.
   These checks can write staging data and need the isolated resources first.
5. Actual device acceptance and app upgrade/data retention remain separate
   gates; neither CI nor a green health endpoint completes them.

Vercel Deployment Protection can intercept Android API requests before this
server sees them: browser login/share links do not automatically authorize the
native HTTP client. Owner-controlled automation can use a protection bypass
from trusted server/test tooling only. **Never bundle an admin key or Vercel
protection bypass secret into the APK.** For direct native acceptance the owner
must explicitly choose a reachable staging endpoint/protection policy; normal
App API authentication remains required. See
[Vercel's protection bypass documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

If configuration or acceptance fails, stop use of this staging deployment and
redeploy a known staging commit after correcting the issue. Do not fall back to
production APIs/accounts or delete databases to make a test pass.
