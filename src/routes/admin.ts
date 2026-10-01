import { httpError } from '../lib/httpError.js';
import { escapeRegex } from '../lib/validation.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../db/mongo.js';
import { collections, type NotificationDoc } from '../db/collections.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { computeControllerStats } from '../lib/adminStats.js';
import { logEvent } from '../lib/logs.js';
import { getEnvIssues } from '../lib/env.js';
import { NOTE_LIMIT } from '../lib/energy.js';
import { coinDetails, coinFingerprint, coinOperationId, creditCoinLot, prepareCoinWallet, readCoinWallet, recordCoinOperation, replayCoinOperation, requireCoinRequestId, spendCoinLots } from '../lib/coinLots.js';
import { AUDIENCES, audienceUserIds } from '../lib/notificationFeed.js';
import { checkLogin, controllerSessionEpoch, recordLoginFailure, recordLoginSuccess, revokeControllerSessions } from '../lib/controllerLogin.js';

const admin = new Hono();
admin.use('*', requireAdmin);

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
admin.get('/health', async (c) => {
  // Variable names and problems only, never values.
  const configuration = getEnvIssues();
  try {
    const db = await getDb();
    await collections.notifications(db).countDocuments({});
    return c.json({ coin_request_replay: true, db: true, dbError: null, configuration, time: new Date().toISOString() });
  } catch (e) {
    return c.json({ coin_request_replay: true, db: false, dbError: e instanceof Error ? e.message : 'DB error', configuration, time: new Date().toISOString() });
  }
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
admin.get('/stats', async (c) => {
  try {
    const db = await getDb();
    const stats = await computeControllerStats(db);
    return c.json({ stats });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to load stats' }, 500);
  }
});

// ---------------------------------------------------------------------------
// user lookup by email
// ---------------------------------------------------------------------------
admin.get('/user', async (c) => {
  const email = c.req.query('email')?.trim();
  if (!email) return c.json({ error: 'email is required' }, 400);

  const db = await getDb();
  const user = await collections.users(db).findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
  if (!user) return c.json({ error: 'No user with that email' }, 404);

  const wallet = await readCoinWallet(db, user._id);
  // No last_sign_in_at concept from Supabase auth.users anymore — the most
  // recent session's createdAt is the closest honest equivalent.
  const lastSession = await collections
    .sessions(db)
    .find({ userId: user._id })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  return c.json({
    user_id: user._id,
    email: user.email,
    username: wallet?.username ?? null,
    email_confirmed: true, // Google-verified at sign-in; there is no separate confirmation step
    last_sign_in_at: lastSession[0]?.createdAt.toISOString() ?? null,
    auth_created_at: user.createdAt.toISOString(),
    has_wallet: Boolean(wallet),
    coins: wallet?.coins ?? 0,
    coin_details: wallet?.coinLotsVersion === 1 ? await coinDetails(db, user._id) : null,
    energy: wallet?.energy ?? 0,
    energy_cap: wallet?.energyCap ?? 120,
    last_daily_grant_at: wallet?.lastDailyGrantAt?.toISOString() ?? null,
  });
});

const coinCursorSchema = z.object({ at: z.string().datetime(), id: z.string().min(1).max(100) });
admin.get('/coins', async (c) => {
  const userId = z.string().uuid().parse(c.req.query('user_id'));
  const cursor = c.req.query('cursor');
  if (cursor && cursor.length > 512) return c.json({ error: 'invalid_cursor' }, 400);
  const decoded = cursor ? coinCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())) : null;
  return c.json(await coinDetails(await getDb(), userId, decoded ? { at: new Date(decoded.at), id: decoded.id } : undefined));
});

// ---------------------------------------------------------------------------
// energy adjustment — direct port of Community's energy/route.ts logic,
// now living where the rest of the wallet-mutation logic already lives
// (lib/energy.ts's transactional pattern) instead of a second copy of it.
// ---------------------------------------------------------------------------
/** Largest single adjustment: well past any real grant, far below anything that loses integer precision. */
const MAX_ADJUST = 100_000;
// Coins and energy are whole numbers everywhere else (spend, convert, tiers); a fractional delta would leave a
// wallet holding part of a coin.
const adjustDelta = z.number().int().min(-MAX_ADJUST).max(MAX_ADJUST).default(0);
const adjustSchema = z
  .object({
    email: z.string().email().optional(),
    user_id: z.string().uuid().optional(),
    request_id: z.string().uuid().optional(),
    coins_delta: adjustDelta,
    energy_delta: adjustDelta,
    note: z.string().max(120).optional(),
  })
  .refine((b) => b.email || b.user_id, { message: 'email or user_id is required' })
  .refine((b) => b.coins_delta !== 0 || b.energy_delta !== 0, { message: 'nothing to adjust' });

admin.post('/energy', async (c) => {
  const body = adjustSchema.parse(await c.req.json());
  const db = await getDb();

  let resolvedUserId = body.user_id;
  if (!resolvedUserId && body.email) {
    const user = await collections.users(db).findOne({ email: { $regex: `^${escapeRegex(body.email)}$`, $options: 'i' } });
    if (!user) return c.json({ error: 'user not found' }, 404);
    resolvedUserId = user._id;
  }
  // Copied to a const: TypeScript doesn't carry the narrowing above into the
  // closure below (a `let` captured by a nested function is re-widened to
  // its declared type), so `resolvedUserId` inside withTransaction would
  // still type-check as `string | undefined` without this.
  const userId: string = resolvedUserId!;

  const result = await withTransaction(async (session) => {
    const col = collections.atomicUsers(db);
    const now = new Date();
    const fingerprint = coinFingerprint('adjust', [body.coins_delta, body.energy_delta, body.note?.trim() || '']);
    const replay = await replayCoinOperation(db, userId, body.request_id, fingerprint, session);
    if (replay) return { newCoins: replay.coins, newEnergy: replay.energy };
    let wallet = await col.findOne({ _id: userId }, { session });
    if (!wallet) {
      wallet = { _id: userId, username: '', noteLimit: NOTE_LIMIT.free, coins: 0, energy: 0, energyCap: 120,
        lastDailyGrantAt: null, lastStandardSyncAt: null, createdAt: now };
      await col.updateOne({ _id: userId }, { $setOnInsert: wallet }, { session, upsert: true });
    }
    wallet = await prepareCoinWallet(db, wallet, session, now);
    requireCoinRequestId(wallet, body.request_id);
    const curCoins = wallet?.coins ?? 0;
    const curEnergy = wallet?.energy ?? 0;
    const cap = wallet?.energyCap ?? 120;
    const newCoins = Math.max(0, curCoins + body.coins_delta);
    if (!Number.isSafeInteger(newCoins)) throw httpError('invalid_amount', 409);
    const newEnergy = Math.min(cap, Math.max(0, curEnergy + body.energy_delta));

    await col.updateOne(
      { _id: userId },
      {
        $set: { coins: newCoins, energy: newEnergy },
        $setOnInsert: {
          username: '',
          noteLimit: NOTE_LIMIT.free,
          energyCap: 120,
          lastDailyGrantAt: null,
          lastStandardSyncAt: null,
          createdAt: new Date(),
        },
      },
      { upsert: true, session },
    );

    const allocations = await spendCoinLots(db, wallet, Math.max(0, curCoins - newCoins), session);
    const operationId = body.request_id ? coinOperationId(userId, body.request_id) : undefined;
    if (newCoins > curCoins) await creditCoinLot(db, wallet, newCoins - curCoins, operationId!, session, now);
    await recordCoinOperation(db, { ...wallet, coins: newCoins, energy: newEnergy }, body.request_id, fingerprint, allocations, session, now);
    await collections.energyLedger(db).insertOne(
      {
        _id: randomUUID(),
        ...(operationId ? { coinOperationId: operationId, lotIds: newCoins > curCoins && wallet.coinLotsVersion === 1 ? [operationId] : allocations.map((a) => a.lotId) } : {}),
        userId,
        kind: 'admin_adjust',
        coinsDelta: newCoins - curCoins,
        energyDelta: newEnergy - curEnergy,
        resultingCoins: newCoins,
        resultingEnergy: newEnergy,
        // The App shows this note in the user's Activity list, so the default speaks to them.
        note: body.note?.trim() || 'Balance adjusted by Atomic Notes',
        createdAt: new Date(),
      },
      { session },
    );

    return { newCoins, newEnergy };
  });

  await logEvent(db, 'admin_energy_adjust', {
    userId,
    meta: { coinsDelta: body.coins_delta, energyDelta: body.energy_delta, note: body.note },
  });

  return c.json({ ok: true, user_id: userId, coins: result.newCoins, energy: result.newEnergy });
});

// ---------------------------------------------------------------------------
// notifications CRUD — wire shape is snake_case throughout, matching the
// live app's `notifications` table columns exactly (Controller's UI and the
// Flutter client, if notifications are ever wired up there, both expect
// these names). Internal storage is camelCase, per db/collections.ts.
// ---------------------------------------------------------------------------
function toWire(n: NotificationDoc) {
  return {
    id: n._id,
    type: n.type,
    subject: n.subject,
    description: n.description,
    priority: n.priority,
    status: n.status,
    action: n.action,
    action_url: n.actionUrl,
    icon: n.icon,
    target_audience: n.targetAudience,
    target_user_id: n.targetUserId,
    min_app_version: n.minAppVersion,
    max_app_version: n.maxAppVersion,
    dismissible: n.dismissible,
    created_at: n.createdAt.toISOString(),
    expires_at: n.expiresAt ? n.expiresAt.toISOString() : null,
  };
}

/** How many users each notification was published to (Active/Inactive only) and how many have read it. */
async function deliveryCounts(db: Awaited<ReturnType<typeof getDb>>, ids: string[]) {
  const [recipients, reads] = await Promise.all([
    collections.notificationRecipients(db).aggregate<{ _id: string; n: number }>([
      { $match: { notificationId: { $in: ids } } }, { $group: { _id: '$notificationId', n: { $sum: 1 } } },
    ]).toArray(),
    collections.notificationStates(db).aggregate<{ _id: string; n: number }>([
      { $match: { notificationId: { $in: ids }, readAt: { $ne: null } } }, { $group: { _id: '$notificationId', n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  return { recipients: new Map(recipients.map((r) => [r._id, r.n])), reads: new Map(reads.map((r) => [r._id, r.n])) };
}

admin.get('/notifications', async (c) => {
  const db = await getDb();
  const rows = await collections.notifications(db).find({}).sort({ createdAt: -1 }).toArray();
  const counts = await deliveryCounts(db, rows.map((n) => n._id));
  return c.json({
    rows: rows.map((n) => ({ ...toWire(n), recipients: counts.recipients.get(n._id) ?? null, reads: counts.reads.get(n._id) ?? 0 })),
  });
});

const createNotificationSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  status: z.enum(['active', 'resolved', 'expired']).optional(),
  action: z.string().nullable().optional(),
  action_url: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  target_audience: z.enum(AUDIENCES).optional(),
  target_user_id: z.string().uuid().nullable().optional(),
  target_email: z.string().email().nullable().optional(),
  min_app_version: z.string().nullable().optional(),
  max_app_version: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  dismissible: z.boolean().optional(),
});

admin.post('/notifications', async (c) => {
  const body = createNotificationSchema.parse(await c.req.json());
  const db = await getDb();

  let targetUserId = body.target_user_id ?? null;
  if (!targetUserId && body.target_email) {
    const user = await collections.users(db).findOne({ email: { $regex: `^${escapeRegex(body.target_email)}$`, $options: 'i' } });
    if (!user) return c.json({ error: 'target user not found' }, 404);
    targetUserId = user._id;
  }

  const doc: NotificationDoc = {
    _id: body.id ?? randomUUID(),
    type: body.type,
    subject: body.subject,
    description: body.description,
    priority: body.priority ?? 'normal',
    status: body.status ?? 'active',
    action: body.action ?? null,
    actionUrl: body.action_url ?? null,
    icon: body.icon ?? null,
    targetAudience: body.target_audience ?? 'all',
    targetUserId,
    minAppVersion: body.min_app_version ?? null,
    maxAppVersion: body.max_app_version ?? null,
    dismissible: body.dismissible !== false,
    createdAt: new Date(),
    expiresAt: body.expires_at ? new Date(body.expires_at) : null,
  };
  // Active and Inactive are decided now, while "who opened the App in the last 7 days" still means something:
  // anyone who later reads the feed has just opened it.
  let audienceSize: number;
  if (targetUserId) {
    audienceSize = 1;
  } else if (doc.targetAudience === 'active' || doc.targetAudience === 'inactive') {
    const userIds = await audienceUserIds(db, doc.targetAudience);
    if (userIds.length > 0) {
      await collections.notificationRecipients(db).insertMany(
        userIds.map((userId) => ({ _id: `${doc._id}:${userId}`, notificationId: doc._id, userId })),
        { ordered: false },
      );
    }
    audienceSize = userIds.length;
  } else if (doc.targetAudience === 'new') {
    // Nobody yet: it reaches accounts created from now on.
    audienceSize = 0;
  } else {
    audienceSize = await collections.users(db).countDocuments({});
  }
  await collections.notifications(db).insertOne(doc);
  return c.json({ row: toWire(doc), audience_size: audienceSize });
});

const patchNotificationBodySchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  status: z.enum(['active', 'resolved', 'expired']).optional(),
  action: z.string().nullable().optional(),
  action_url: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  target_user_id: z.string().uuid().nullable().optional(),
  min_app_version: z.string().nullable().optional(),
  max_app_version: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  dismissible: z.boolean().optional(),
});

/** snake_case request body -> the camelCase partial Mongo's $set expects. Plain
 * and explicit on purpose — a clever conditional-spread version of this risks
 * inferring a type TypeScript can't cleanly match against the driver's
 * update-filter type; this can't get that wrong. */
function notificationPatchFields(b: z.infer<typeof patchNotificationBodySchema>): Partial<NotificationDoc> {
  const fields: Partial<NotificationDoc> = {};
  if (b.type !== undefined) fields.type = b.type;
  if (b.subject !== undefined) fields.subject = b.subject;
  if (b.description !== undefined) fields.description = b.description;
  if (b.priority !== undefined) fields.priority = b.priority;
  if (b.status !== undefined) fields.status = b.status;
  if (b.action !== undefined) fields.action = b.action;
  if (b.action_url !== undefined) fields.actionUrl = b.action_url;
  if (b.icon !== undefined) fields.icon = b.icon;
  if (b.target_user_id !== undefined) fields.targetUserId = b.target_user_id;
  if (b.min_app_version !== undefined) fields.minAppVersion = b.min_app_version;
  if (b.max_app_version !== undefined) fields.maxAppVersion = b.max_app_version;
  if (b.expires_at !== undefined) fields.expiresAt = b.expires_at ? new Date(b.expires_at) : null;
  if (b.dismissible !== undefined) fields.dismissible = b.dismissible;
  return fields;
}

admin.patch('/notifications', async (c) => {
  const body = patchNotificationBodySchema.parse(await c.req.json());
  const fields = notificationPatchFields(body);
  const db = await getDb();
  if (Object.keys(fields).length === 0) return c.json({ error: 'no fields to update' }, 400);

  const result = await collections.notifications(db).findOneAndUpdate(
    { _id: body.id },
    { $set: fields },
    { returnDocument: 'after' },
  );
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json({ row: toWire(result) });
});

admin.delete('/notifications', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id is required' }, 400);
  const db = await getDb();
  await collections.notifications(db).deleteOne({ _id: id });
  // Its per-user state and recipient list mean nothing without it.
  await Promise.all([
    collections.notificationStates(db).deleteMany({ notificationId: id }),
    collections.notificationRecipients(db).deleteMany({ notificationId: id }),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Controller sign-in throttle and "log out everywhere". The Controller is stateless serverless functions, so
// the state both need lives here. The client is its IP address, stored only as a hash.
// ---------------------------------------------------------------------------
const loginAttemptSchema = z.object({
  client: z.string().min(1).max(200),
  result: z.enum(['check', 'failure', 'success']),
});

admin.post('/controller/login-attempts', async (c) => {
  const body = loginAttemptSchema.parse(await c.req.json());
  const db = await getDb();
  if (body.result === 'check') return c.json(await checkLogin(db, body.client));
  if (body.result === 'failure') return c.json(await recordLoginFailure(db, body.client));
  await recordLoginSuccess(db, body.client);
  return c.json({ allowed: true, retry_after_seconds: 0 });
});

admin.get('/controller/session-epoch', async (c) => {
  return c.json({ revoked_before: await controllerSessionEpoch(await getDb()) });
});

const epochSchema = z.object({ revoked_before: z.number().int().positive() });

admin.post('/controller/session-epoch', async (c) => {
  const { revoked_before: revokedBefore } = epochSchema.parse(await c.req.json());
  // A time far in the future would end every session to come as well; the Controller only ever sends "now".
  if (revokedBefore > Date.now() + 5 * 60 * 1000) return c.json({ error: 'revoked_before_in_future' }, 400);
  return c.json({ revoked_before: await revokeControllerSessions(await getDb(), revokedBefore) });
});

export default admin;
