// Envoi des notifications Web Push (fonctionne sur iPhone à partir d'iOS 16.4
// quand l'application est ajoutée à l'écran d'accueil).

import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { matchesPrefs } from './store.js';

// Par défaut, seules les annonces de particuliers déclenchent une notification.
export const NOTIFY_PRO = /^(1|true|oui|yes)$/i.test(process.env.NOTIFY_PRO || '');

export function loadVapidKeys(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  console.log('[push] clés VAPID générées dans', file);
  return keys;
}

export class Notifier {
  constructor(store, { vapid, subject }) {
    this.store = store;
    this.vapid = vapid;
    webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  }

  buildPayload(newListings) {
    if (newListings.length === 1) {
      const l = newListings[0];
      const seller = l.seller === 'particulier' ? 'Particulier' : l.seller === 'pro' ? (l.agency || 'Pro') : '';
      const details = [l.priceLabel, l.location, seller, `N° ${l.sourceId}`].filter(Boolean).join(' · ');
      return {
        title: `Nouvelle annonce · ${l.source}`,
        body: details ? `${l.title}\n${details}` : l.title,
        url: l.url,
        tag: l.id,
        image: l.image,
      };
    }
    const bySource = {};
    for (const l of newListings) bySource[l.source] = (bySource[l.source] || 0) + 1;
    const summary = Object.entries(bySource).map(([s, n]) => `${n} sur ${s}`).join(', ');
    return {
      title: `${newListings.length} nouvelles annonces immobilières`,
      body: `${summary}\n${newListings.slice(0, 3).map((l) => `• ${l.title}`).join('\n')}`,
      url: '/',
      tag: `batch-${Date.now()}`,
    };
  }

  /** Notifie chaque abonné des annonces qui correspondent à ses préférences. */
  async notify(newListings) {
    let sent = 0;
    if (!NOTIFY_PRO) {
      const before = newListings.length;
      newListings = newListings.filter((l) => l.seller === 'particulier');
      if (before !== newListings.length) console.log(`[push] ${before - newListings.length} annonce(s) de professionnels ou d'annonceur incertain non notifiée(s)`);
    }
    const delivered = new Map();
    for (const sub of [...this.store.subscriptions]) {
      const relevant = newListings.filter((l) => matchesPrefs(l, sub.prefs));
      if (!relevant.length) continue;
      const payload = JSON.stringify(this.buildPayload(relevant));
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime },
          payload,
          { TTL: 60 * 60 * 6, urgency: 'high' },
        );
        sent++;
        for (const l of relevant) delivered.set(l.id, l);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log('[push] abonnement expiré, suppression');
          this.store.removeSubscription(sub.endpoint);
        } else {
          console.error('[push] échec d\'envoi :', err.statusCode || '', err.body || err.message);
        }
      }
    }
    if (delivered.size) this.store.addNotifications([...delivered.values()]);
    return sent;
  }

  async sendTest(sub) {
    const payload = JSON.stringify({
      title: 'Nick Immobilier ✅',
      body: 'Les notifications fonctionnent. Vous serez prévenu dès qu\'une nouvelle annonce paraît.',
      url: '/',
      tag: 'test',
    });
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 300 });
  }
}
