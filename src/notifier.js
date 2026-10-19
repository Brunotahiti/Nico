// Envoi des notifications Web Push (fonctionne sur iPhone à partir d'iOS 16.4
// quand l'application est ajoutée à l'écran d'accueil).

import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { matchesPrefs } from './store.js';

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
      const details = [l.priceLabel, l.location, seller].filter(Boolean).join(' · ');
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
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log('[push] abonnement expiré, suppression');
          this.store.removeSubscription(sub.endpoint);
        } else {
          console.error('[push] échec d\'envoi :', err.statusCode || '', err.body || err.message);
        }
      }
    }
    return sent;
  }

  async sendTest(sub) {
    const payload = JSON.stringify({
      title: 'Méthode Nico ✅',
      body: 'Les notifications fonctionnent. Vous serez prévenu dès qu\'une nouvelle annonce paraît.',
      url: '/',
      tag: 'test',
    });
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 300 });
  }
}
