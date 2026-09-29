import type { NotificationDoc } from '../db/collections.js';

/**
 * The support page on the Atomic Notes website: where to support, and how the early-supporter coins are sent.
 * The notifications themselves name no payment platform; the page does.
 */
export const SUPPORT_URL = 'https://atomic-notes-community.vercel.app/support-atomic-notes';

type WelcomeText = Pick<NotificationDoc, '_id' | 'type' | 'subject' | 'description' | 'priority' | 'action' | 'actionUrl'>;

/**
 * The three messages every new account finds in its notification center. They use the "new" audience, so they
 * reach accounts created on or after the moment they were published, and nobody who signed up before.
 * The ids are fixed so `npm run notifications:welcome` can be run again to update the wording.
 * Newest first in the feed, so the order here is the reverse of how they read: the welcome is published last.
 */
export const WELCOME_NOTIFICATIONS: readonly WelcomeText[] = [
  {
    _id: '6f1d7c52-3b8e-4a61-9c0e-2a5b8d4e7f13',
    type: 'general',
    subject: 'Get Atomic Coins early',
    description:
      'Atomic Notes is built by one developer. Support the project at the amount you choose, share your Atomic '
      + 'Notes account email, and the developer will send you Atomic Coins as an early-supporter reward.',
    priority: 'low',
    action: 'Support Atomic Notes',
    actionUrl: SUPPORT_URL,
  },
  {
    _id: '3c9a41e8-7d25-4f6b-b1a0-5e8c2d7f9a64',
    type: 'atomic_energy',
    subject: 'Your welcome gift: 5 Atomic Coins',
    description:
      'We added 5 Atomic Coins to your account. Open Atomic Energy and tap Convert coins to energy: each coin adds '
      + '40 energy, enough for 8 automatic syncs. Or save up 10 coins to unlock Antimatter, with room for 40 notes.',
    priority: 'normal',
    action: 'Open Energy',
    actionUrl: '/energypage',
  },
  {
    _id: 'a2e87b19-5f4c-4d3a-8e6b-0c1f9d2a7b58',
    type: 'new_update',
    subject: 'Welcome to the new Atomic Notes',
    description:
      'Your notes save on this phone first and work offline. Sync sends each note to a private My-Atomic-Notes '
      + 'folder in your own Google Drive. Turn on Encryption in Settings to seal every note before it leaves the '
      + 'phone. No AI, no ads, no trackers.',
    priority: 'normal',
    action: null,
    actionUrl: null,
  },
];
