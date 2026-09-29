import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/mongo.js';
import { requireAuth } from '../middleware/auth.js';
import { feedFor, markNotification, reachableNotification, toFeedWire } from '../lib/notificationFeed.js';

/**
 * The App's notification feed: what the Controller published to this user (Everyone, an Active/Inactive
 * audience they were part of, or them directly), with their own read and dismiss state.
 */
const notifications = new Hono();
notifications.use('*', requireAuth);

const appVersionSchema = z.string().max(32).regex(/^[0-9][0-9A-Za-z.+-]*$/).optional();
const idSchema = z.string().uuid();

notifications.get('/', async (c) => {
  const appVersion = appVersionSchema.parse(c.req.query('app_version') || undefined);
  const rows = await feedFor(await getDb(), c.get('userId') as string, appVersion);
  return c.json({ rows: rows.map(toFeedWire) });
});

notifications.post('/read-all', async (c) => {
  const db = await getDb();
  const userId = c.get('userId') as string;
  const appVersion = appVersionSchema.parse(c.req.query('app_version') || undefined);
  const unread = (await feedFor(db, userId, appVersion)).filter((item) => !item.state?.readAt);
  await Promise.all(unread.map((item) => markNotification(db, userId, item.notification._id)));
  return c.json({ ok: true, marked: unread.length });
});

notifications.post('/:id/read', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const db = await getDb();
  const userId = c.get('userId') as string;
  if (!(await reachableNotification(db, userId, id))) return c.json({ error: 'not_found' }, 404);
  await markNotification(db, userId, id);
  return c.json({ ok: true });
});

notifications.post('/:id/dismiss', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const db = await getDb();
  const userId = c.get('userId') as string;
  const notification = await reachableNotification(db, userId, id);
  if (!notification) return c.json({ error: 'not_found' }, 404);
  // Pinned by the Controller (a critical incident, a required update): it stays until it is resolved.
  if (!notification.dismissible) return c.json({ error: 'not_dismissible' }, 409);
  await markNotification(db, userId, id, { dismiss: true });
  return c.json({ ok: true });
});

export default notifications;
