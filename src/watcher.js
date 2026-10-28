// Boucle de surveillance : interroge chaque site, détecte les annonces jamais
// vues, les mémorise et déclenche les notifications.

import * as immobilier from './scrapers/immobilier.js';
import * as petitesannonces from './scrapers/petitesannonces.js';
import { proEmailDomain } from './util.js';

const SOURCES = [immobilier, petitesannonces];
const MAX_ENRICH_PER_CYCLE = 20;
const MAX_PENDING_TRIES = 3; // passages (≈ 15 min) avant décision par déduction

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

  /** Repère les annonces notifiées qui ont été retirées du site (déjà louées ou vendues). */
  async checkAvailability() {
    const todo = this.store.notificationsToCheck();
    if (!todo.length) return;
    let removed = 0;
    for (const n of todo) {
      const mod = SOURCES.find((m) => m.SOURCE === n.source);
      if (!mod?.checkOnline) continue;
      try {
        const online = await mod.checkOnline(n);
        this.store.setNotificationOnline(n.id, online);
        if (!online) { removed++; console.log(`[watch] annonce retirée du site : ${n.title}`); }
      } catch (err) {
        // Site injoignable : on réessaiera au prochain passage
      }
    }
    this.store.save();
    if (removed) console.log(`[watch] ${removed} annonce(s) retirée(s) signalée(s)`);
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
          // Type d'annonceur (particulier / pro) pour les nouveautés, et nouvel essai pour celles en attente
          if (!firstRun && mod.enrichBatch) {
            const pending = (this.store.state.pending || []).filter((p) => p.source === mod.SOURCE);
            await mod.enrichBatch([...freshHere, ...pending], { maxDetail: MAX_ENRICH_PER_CYCLE });
          }
          fresh.push(...freshHere);
        } catch (err) {
          status.ok = false;
          status.error = err.message;
          console.error(`[watch] ${mod.SOURCE} : ${err.message}`);
        }
        this.store.state.sourcesStatus[mod.SOURCE] = status;
      }

      // Faux particuliers : une adresse e-mail au nom d'une agence (ex. …@manea-immo.com) les trahit
      for (const item of fresh) {
        const d = item.seller !== 'pro' ? proEmailDomain(item) : null;
        if (d) { item.seller = 'pro'; item.sellerReason = `adresse d'agence (${d})`; console.log(`[watch] ${item.title} : reclassée pro, ${item.sellerReason}`); }
      }

      // Annonces dont l'annonceur reste inconnu : on attend le passage suivant plutôt que de risquer une annonce pro
      const toNotify = [];
      const stillPending = [];
      const previousPending = firstRun ? [] : (this.store.state.pending || []);
      for (const item of [...previousPending, ...fresh]) {
        if (item.seller !== 'inconnu') {
          toNotify.push(item);
          continue;
        }
        item.pendingTries = (item.pendingTries || 0) + 1;
        if (item.pendingTries < MAX_PENDING_TRIES) { stillPending.push(item); continue; }
        const mod = SOURCES.find((m) => m.SOURCE === item.source);
        item.seller = mod?.guessSeller ? mod.guessSeller(item) : 'inconnu';
        item.sellerGuessed = true;
        toNotify.push(item);
      }
      this.store.state.pending = stillPending;
      // Met à jour dans la liste affichée le type d'annonceur des annonces sorties de l'attente
      for (const item of previousPending) {
        const shown = this.store.listings.find((l) => l.id === item.id);
        if (shown) Object.assign(shown, { seller: item.seller, publishedAt: shown.publishedAt || item.publishedAt });
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
      } else if (fresh.length || toNotify.length) {
        if (fresh.length) console.log(`[watch] ${fresh.length} nouvelle(s) annonce(s) : ${fresh.map((l) => `${l.title} [${l.seller}]`).join(' | ')}`);
        if (stillPending.length) console.log(`[watch] ${stillPending.length} annonce(s) en attente de vérification de l'annonceur`);
        sent = toNotify.length ? await this.notifier.notify(toNotify) : 0;
        console.log(`[watch] ${sent} notification(s) envoyée(s)`);
      } else {
        console.log('[watch] rien de nouveau');
      }
      await this.checkAvailability();
      return { fresh: fresh.length, sent, firstRun };
    } finally {
      this.running = false;
    }
  }
}
