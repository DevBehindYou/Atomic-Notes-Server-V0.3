import { closeDb, getDb } from '../db/mongo.js';
import { collections } from '../db/collections.js';
import { WELCOME_NOTIFICATIONS } from '../lib/welcomeNotifications.js';

/**
 * Publishes (or updates) the three welcome notifications for new accounts.
 * Usage: npm run notifications:welcome
 *
 * A first run inserts them with the "new" audience: every account created from then on sees them, and nobody
 * who signed up earlier. A later run only rewrites the wording and keeps the original publish time, so the
 * set of accounts that see them does not change. Resolve or delete them in the Controller to stop them.
 */
const db = await getDb();
const now = Date.now();

for (const [i, n] of WELCOME_NOTIFICATIONS.entries()) {
  const result = await collections.notifications(db).updateOne(
    { _id: n._id },
    {
      $set: {
        type: n.type, subject: n.subject, description: n.description, priority: n.priority,
        action: n.action, actionUrl: n.actionUrl,
      },
      $setOnInsert: {
        status: 'active', icon: null, targetAudience: 'new', targetUserId: null,
        minAppVersion: null, maxAppVersion: null, dismissible: true, expiresAt: null,
        // One millisecond apart, in list order, so the feed (newest first) shows the welcome on top.
        createdAt: new Date(now + i),
      },
    },
    { upsert: true },
  );
  console.log(`${result.upsertedCount ? 'published' : 'updated'}: ${n.subject}`);
}

await closeDb();
