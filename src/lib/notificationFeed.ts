import type { Db } from 'mongodb';
import { collections, type NotificationDoc, type NotificationStateDoc } from '../db/collections.js';

/** "Active" means the App was opened within this window: a daily energy grant or a sign-in counts. */
export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Most notifications one feed returns, newest first. */
export const FEED_LIMIT = 50;

/**
 * all: everyone, at any time. active / inactive: decided at publish time (see [audienceUserIds]).
 * new: accounts created on or after the notification was published, for welcome messages.
 */
export const AUDIENCES = ['all', 'active', 'inactive', 'new'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Users who opened the App within [ACTIVE_WINDOW_MS] of [now]. */
export async function recentlyActiveUserIds(db: Db, now = new Date()): Promise<Set<string>> {
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const [wallets, signIns] = await Promise.all([
    collections.atomicUsers(db).find({ lastDailyGrantAt: { $gte: cutoff } }, { projection: { _id: 1 } }).toArray(),
    collections.sessions(db).distinct('userId', { createdAt: { $gte: cutoff } }),
  ]);
  return new Set<string>([...wallets.map((w) => w._id), ...signIns]);
}

/**
 * Who an Active or Inactive notification goes to, decided when it is published. Deciding it later would not
 * work: anyone reading the feed has just opened the App, so everyone would look active by then.
 */
export async function audienceUserIds(db: Db, audience: 'active' | 'inactive', now = new Date()): Promise<string[]> {
  const active = await recentlyActiveUserIds(db, now);
  if (audience === 'active') return [...active];
  const everyone = await collections.users(db).find({}, { projection: { _id: 1 } }).toArray();
  return everyone.map((u) => u._id).filter((id) => !active.has(id));
}

/** Compares dotted versions numerically, so 1.18.2 is after 1.9. A missing or non-numeric part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('+')[0].split('.').map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether a notification's version range admits [appVersion]. An App that does not say its version sees everything. */
export function versionAllows(n: Pick<NotificationDoc, 'minAppVersion' | 'maxAppVersion'>, appVersion?: string | null): boolean {
  if (!appVersion) return true;
  if (n.minAppVersion && compareVersions(appVersion, n.minAppVersion) < 0) return false;
  if (n.maxAppVersion && compareVersions(appVersion, n.maxAppVersion) > 0) return false;
  return true;
}

/** The Mongo filter for active, unexpired notifications that reach [userId]. */
async function reachFilter(db: Db, userId: string, now: Date) {
  const [recipientOf, user] = await Promise.all([
    collections.notificationRecipients(db).distinct('notificationId', { userId }),
    collections.users(db).findOne({ _id: userId }, { projection: { createdAt: 1 } }),
  ]);
  return {
    status: 'active' as const,
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      {
        $or: [
          { targetUserId: userId },
          // Everyone: no target user and no audience that was resolved at publish time.
          { targetUserId: null, targetAudience: { $in: ['all', null] } },
          { _id: { $in: recipientOf } },
          // New accounts: published no later than this account was created.
          ...(user ? [{ targetUserId: null, targetAudience: 'new', createdAt: { $lte: user.createdAt } }] : []),
        ],
      },
    ],
  };
}

export type FeedItem = { notification: NotificationDoc; state: NotificationStateDoc | null };

/** What [userId] sees, newest first: reachable, in the version range and not dismissed. */
export async function feedFor(db: Db, userId: string, appVersion?: string | null, now = new Date()): Promise<FeedItem[]> {
  const candidates = await collections.notifications(db).find(await reachFilter(db, userId, now))
    .sort({ createdAt: -1 }).limit(FEED_LIMIT * 2).toArray();
  const inRange = candidates.filter((n) => versionAllows(n, appVersion));
  const states = await collections.notificationStates(db)
    .find({ userId, notificationId: { $in: inRange.map((n) => n._id) } }).toArray();
  const byId = new Map(states.map((s) => [s.notificationId, s]));
  return inRange
    .filter((n) => !byId.get(n._id)?.dismissedAt)
    .slice(0, FEED_LIMIT)
    .map((n) => ({ notification: n, state: byId.get(n._id) ?? null }));
}

/** The notification when it reaches [userId] (whatever its version range), else null. */
export async function reachableNotification(db: Db, userId: string, id: string, now = new Date()): Promise<NotificationDoc | null> {
  const filter = await reachFilter(db, userId, now);
  return collections.notifications(db).findOne({ ...filter, _id: id });
}

/** Records that [userId] read (and, with [dismiss], dismissed) notification [id]. Repeating it changes nothing. */
export async function markNotification(db: Db, userId: string, id: string, { dismiss = false, now = new Date() } = {}) {
  await collections.notificationStates(db).updateOne(
    { _id: `${userId}:${id}` },
    [{
      $set: {
        userId, notificationId: id,
        readAt: { $ifNull: ['$readAt', now] },
        dismissedAt: dismiss ? { $ifNull: ['$dismissedAt', now] } : { $ifNull: ['$dismissedAt', null] },
      },
    }],
    { upsert: true },
  );
}

/** The feed row the App reads (snake_case, like every other App payload). */
export function toFeedWire({ notification: n, state }: FeedItem) {
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
    dismissible: n.dismissible,
    created_at: n.createdAt.toISOString(),
    expires_at: n.expiresAt ? n.expiresAt.toISOString() : null,
    is_read: Boolean(state?.readAt),
    dismissed_at: state?.dismissedAt ? state.dismissedAt.toISOString() : null,
  };
}

