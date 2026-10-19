// Récupère les dernières annonces publiées sur immobilier.pf.
// Le site est une application AngularJS qui consomme une API REST interne :
//   GET /api/bid/light?page=0&size=N&sort=createdDate,desc&filter={...}&customFilter={...}
// On réutilise exactement cet appel (c'est celui que fait le navigateur).

import { fetchWithRetry, slugify } from '../util.js';

export const SOURCE = 'immobilier.pf';
const BASE = 'https://www.immobilier.pf';

// Correspondance type d'annonce -> segment d'URL (repris du code du site)
const BID_TYPE_PARAM = {
  1: 'vente',
  2: 'location',
  3: 'saisonnier',
  4: 'promotion',
  5: 'colocation',
  6: 'autre',
  7: 'construction',
};

// Catégorie normalisée pour les filtres de l'application
function kindOf(typeId) {
  if (typeId === 1 || typeId === 4 || typeId === 7) return 'vente';
  if (typeId === 2 || typeId === 3 || typeId === 5) return 'location';
  return 'autre';
}

export function buildUrl(bid) {
  const r = bid.realty || {};
  const segments = [
    BID_TYPE_PARAM[bid.type?.id] || 'vente',
    r.category?.label ? slugify(r.category.label) : '',
    r.type?.label ? slugify(r.type.label) : '',
    r.localization?.parent?.label ? slugify(r.localization.parent.label) : '',
    r.localization?.label ? slugify(r.localization.label) : '',
    String(bid.id),
  ].filter(Boolean);
  return `${BASE}/${segments.join('/')}`;
}

function buildTitle(bid) {
  const r = bid.realty || {};
  const parts = [];
  if (bid.type?.label) parts.push(bid.type.label);
  if (r.category?.label) parts.push(r.category.label);
  if (r.type?.label) parts.push(r.type.label);
  let title = parts.join(' ');
  if (r.localization?.label) title += ` à ${r.localization.label}`;
  return title || `Annonce ${bid.id}`;
}

function normalize(bid) {
  const r = bid.realty || {};
  const photo = Array.isArray(r.photos) && r.photos.length ? r.photos[0] : null;
  const priceAmount = bid.isPriceHidden ? null : bid.price?.amount ?? null;
  return {
    id: `immo-${bid.id}`,
    source: SOURCE,
    sourceId: String(bid.id),
    title: buildTitle(bid),
    kind: kindOf(bid.type?.id),
    category: r.category?.label || '',
    location: r.localization?.label || '',
    island: r.localization?.parent?.label || '',
    price: priceAmount,
    priceLabel: bid.isPriceHidden ? 'Prix non communiqué' : bid.price?.formatedPrice || '',
    area: r.area ?? null,
    agency: r.agency?.name || '',
    seller: r.agency ? 'pro' : 'particulier',
    description: (bid.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    image: photo?.relativeThumbUrl ? `${BASE}/media/${photo.relativeThumbUrl}` : null,
    url: buildUrl(bid),
    publishedAt: bid.createdDate || null,
  };
}

/**
 * Renvoie les `size` annonces les plus récentes (les plus récentes en premier).
 */
export async function fetchLatest({ size = 60 } = {}) {
  const params = new URLSearchParams({
    page: '0',
    size: String(size),
    sort: 'createdDate,desc',
    filter: JSON.stringify({ isAvailable: true }),
    customFilter: JSON.stringify({}),
  });
  const res = await fetchWithRetry(`${BASE}/api/bid/light?${params}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json();
  const items = Array.isArray(data.content) ? data.content : [];
  return items.map(normalize);
}
