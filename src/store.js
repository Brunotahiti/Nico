// Stockage persistant minimaliste dans un fichier JSON (pas de base de données
// à installer). Contient : annonces déjà vues, annonces récentes à afficher,
// abonnements push et clés VAPID.

import fs from 'node:fs';
import path from 'node:path';

const MAX_LISTINGS = 300; // annonces conservées pour l'affichage
const MAX_SEEN_PER_SOURCE = 5000; // identifiants mémorisés pour la détection

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = {
      seen: {}, // { source: [sourceId, ...] }
      listings: [], // annonces les plus récentes, la plus récente en premier
      subscriptions: [], // { endpoint, keys, prefs, createdAt }
      lastCheck: null,
      lastError: null,
      sourcesStatus: {},
      initialized: false,
    };
    this.load();
    this._seenSets = {};
    for (const [src, ids] of Object.entries(this.state.seen)) this._seenSets[src] = new Set(ids);
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state = { ...this.state, ...raw };
      }
    } catch (err) {
      console.error('[store] fichier d\'état illisible, repart de zéro :', err.message);
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  hasSeen(source, sourceId) {
    return this._seenSets[source]?.has(sourceId) ?? false;
  }

  markSeen(source, sourceId) {
    if (!this._seenSets[source]) this._seenSets[source] = new Set();
    if (!this.state.seen[source]) this.state.seen[source] = [];
    if (this._seenSets[source].has(sourceId)) return;
    this._seenSets[source].add(sourceId);
    this.state.seen[source].push(sourceId);
    if (this.state.seen[source].length > MAX_SEEN_PER_SOURCE) {
      const removed = this.state.seen[source].splice(0, this.state.seen[source].length - MAX_SEEN_PER_SOURCE);
      for (const id of removed) this._seenSets[source].delete(id);
    }
  }

  addListings(items) {
    const existing = new Set(this.state.listings.map((l) => l.id));
    const fresh = items.filter((l) => !existing.has(l.id));
    this.state.listings = [...fresh, ...this.state.listings].slice(0, MAX_LISTINGS);
  }

  get listings() {
    return this.state.listings;
  }

  get subscriptions() {
    return this.state.subscriptions;
  }

  upsertSubscription(sub, prefs) {
    const idx = this.state.subscriptions.findIndex((s) => s.endpoint === sub.endpoint);
    const record = {
      endpoint: sub.endpoint,
      keys: sub.keys,
      expirationTime: sub.expirationTime ?? null,
      prefs: normalizePrefs(prefs),
      createdAt: idx >= 0 ? this.state.subscriptions[idx].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) this.state.subscriptions[idx] = record;
    else this.state.subscriptions.push(record);
    this.save();
    return record;
  }

  removeSubscription(endpoint) {
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.state.subscriptions.length !== before) this.save();
  }
}

export const DEFAULT_PREFS = {
  sources: ['immobilier.pf', 'petitesannonces.pf'],
  kinds: ['vente', 'location', 'autre'],
  maxPrice: null,
  keywords: [],
};

export function normalizePrefs(prefs = {}) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  p.sources = Array.isArray(p.sources) ? p.sources.filter((s) => DEFAULT_PREFS.sources.includes(s)) : DEFAULT_PREFS.sources;
  p.kinds = Array.isArray(p.kinds) ? p.kinds.filter((k) => DEFAULT_PREFS.kinds.includes(k)) : DEFAULT_PREFS.kinds;
  p.maxPrice = Number.isFinite(Number(p.maxPrice)) && Number(p.maxPrice) > 0 ? Number(p.maxPrice) : null;
  p.keywords = Array.isArray(p.keywords)
    ? p.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 20)
    : [];
  return p;
}

/** Une annonce correspond-elle aux préférences d'un abonné ? */
export function matchesPrefs(listing, prefs) {
  const p = normalizePrefs(prefs);
  if (!p.sources.includes(listing.source)) return false;
  if (!p.kinds.includes(listing.kind)) return false;
  if (p.maxPrice && listing.price && listing.price > p.maxPrice) return false;
  if (p.keywords.length) {
    const hay = `${listing.title} ${listing.description} ${listing.location} ${listing.category}`.toLowerCase();
    if (!p.keywords.some((k) => hay.includes(k))) return false;
  }
  return true;
}
