// Boucle de surveillance : interroge chaque site, détecte les annonces jamais
// vues, les mémorise et déclenche les notifications.

import * as immobilier from './scrapers/immobilier.js';
import * as petitesannonces from './scrapers/petitesannonces.js';

const SOURCES = [immobilier, petitesannonces];
const MAX_ENRICH_PER_CYCLE = 20;

export class Watcher {
  constructor(store, notifier, { intervalMs }) {
    this.store = store;
    this.notifier = notifier;
    this.intervalMs = intervalMs;
    this.running = false;
    this.timer = null;
  }

  start() {
    const loop = async () => {
      try {
        await this.checkOnce();
      } catch (err) {
        console.error('[watch] erreur inattendue :', err);
      } finally {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async checkOnce() {
    if (this.running) return { skipped: true };
    this.running = true;
    const firstRun = !this.store.state.initialized;
    const fresh = [];
    try {
      for (const mod of SOURCES) {
        const previous = this.store.state.sourcesStatus[mod.SOURCE] || {};
        const status = { checkedAt: new Date().toISOString(), ok: true, error: null, count: 0, lastOkAt: previous.lastOkAt || null };
        try {
          const items = await mod.fetchLatest();
          status.count = items.length;
          status.lastOkAt = status.checkedAt;
          const freshHere = [];
          for (const item of items) {
            if (this.store.hasSeen(item.source, item.sourceId)) continue;
            this.store.markSeen(item.source, item.sourceId);
            item.seenAt = new Date().toISOString();
            freshHere.push(item);
          }
          // Détails complémentaires (particulier / pro…) pour les nouveautés seulement
          if (mod.enrich && !firstRun) {
            for (const item of freshHere.slice(0, MAX_ENRICH_PER_CYCLE)) {
              try { await mod.enrich(item); } catch (err) { console.warn(`[watch] détail ${item.id} indisponible : ${err.message}`); }
            }
          }
          fresh.push(...freshHere);
        } catch (err) {
          status.ok = false;
          status.error = err.message;
          console.error(`[watch] ${mod.SOURCE} : ${err.message}`);
        }
        this.store.state.sourcesStatus[mod.SOURCE] = status;
      }

      // Les plus récentes en premier dans la liste affichée
      fresh.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || Number(b.sourceId) - Number(a.sourceId));
      this.store.addListings(fresh);
      this.store.state.lastCheck = new Date().toISOString();
      this.store.state.initialized = true;
      this.store.save();

      let sent = 0;
      if (firstRun) {
        console.log(`[watch] premier passage : ${fresh.length} annonces mémorisées, aucune notification envoyée`);
      } else if (fresh.length) {
        console.log(`[watch] ${fresh.length} nouvelle(s) annonce(s) : ${fresh.map((l) => l.title).join(' | ')}`);
        sent = await this.notifier.notify(fresh);
        console.log(`[watch] ${sent} notification(s) envoyée(s)`);
      } else {
        console.log('[watch] rien de nouveau');
      }
      return { fresh: fresh.length, sent, firstRun };
    } finally {
      this.running = false;
    }
  }
}
