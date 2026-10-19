// Récupère les dernières annonces de la rubrique Immobilier de petitesannonces.pf.
// Le site expose un flux RSS par rubrique : https://www.petitesannonces.pf/rss.php?r=1
// (r=1 = Immobilier, 50 annonces les plus récentes). Les identifiants d'annonce
// sont croissants, ce qui permet de détecter les nouveautés de façon fiable.

import { fetchWithRetry, decodeEntities } from '../util.js';

export const SOURCE = 'petitesannonces.pf';
// Le site répond aussi sous www.petites-annonces.pf (avec tiret) ; on garde la forme
// sans tiret, acceptée par le relais tel que déployé.
const BASE = 'https://www.petitesannonces.pf';
const FEED_URL = `${BASE}/rss.php?r=1`;

function kindOf(category) {
  const c = category.toLowerCase();
  if (c.startsWith('vends')) return 'vente';
  if (c.startsWith('loue') || c.includes('saisonni')) return 'location';
  return 'autre';
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseItem(block) {
  const link = tag(block, 'link');
  const idMatch = link.match(/tahiti=(\d+)/);
  if (!idMatch) return null;
  const sourceId = idMatch[1];
  const title = decodeEntities(tag(block, 'title'));
  const category = decodeEntities(tag(block, 'category'));
  let description = tag(block, 'description');
  description = description.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  // Prix en fin de description : "Prix : 170 000 XPF"
  const priceMatch = description.match(/Prix\s*:\s*([\d\s .]+)\s*XPF/i);
  const price = priceMatch ? Number(priceMatch[1].replace(/[^\d]/g, '')) || null : null;
  // Texte lisible sans la ligne "Categorie: ..." ni les balises
  let text = description
    .replace(/Categorie\s*:\s*<a[^>]*>[^<]*<\/a>\s*(<br\s*\/?>)?/i, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/Prix\s*:\s*[\d\s .]+\s*XPF/i, '');
  text = decodeEntities(text).replace(/\s+/g, ' ').trim();
  const pubDate = tag(block, 'pubDate');
  return {
    id: `pa-${sourceId}`,
    source: SOURCE,
    sourceId,
    title,
    kind: kindOf(category),
    category,
    location: '',
    island: '',
    price,
    priceLabel: price ? `${price.toLocaleString('fr-FR')} XPF` : '',
    area: null,
    agency: '',
    seller: 'inconnu', // précisé ensuite par enrich()
    description: text.slice(0, 300),
    image: null,
    url: link.replace(/^http:/, 'https:'),
    publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
  };
}

export function parseFeed(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const item = parseItem(m[1]);
    if (item) items.push(item);
  }
  // Tri décroissant par identifiant (= ordre de publication)
  items.sort((a, b) => Number(b.sourceId) - Number(a.sourceId));
  return items;
}

/**
 * Complète une annonce depuis sa page : particulier ou professionnel, date de
 * publication. La page affiche « N° 2400657 (PRO) » pour les professionnels.
 */
export async function enrich(item) {
  const res = await fetchWithRetry(item.url, { headers: { Accept: 'text/html' } }, { retries: 2, timeoutMs: 25000 });
  const html = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const head = html.match(/N&deg;\s*(\d+)([^<]*)<br>\s*Du\s+(\d{2})\/(\d{2})\/(\d{2})/i);
  if (head && head[1] === item.sourceId) {
    item.seller = /\(PRO\)/i.test(head[2]) ? 'pro' : 'particulier';
    if (!item.publishedAt) item.publishedAt = `20${head[5]}-${head[4]}-${head[3]}T00:00:00.000Z`;
  } else {
    item.seller = /\(PRO\)/.test(html) ? 'pro' : 'particulier';
  }
  return item;
}

/**
 * Renvoie les annonces immobilières les plus récentes (les plus récentes en premier).
 * Les annonces "Recherche immobilier" (demandes, pas des offres) sont exclues.
 */
export async function fetchLatest() {
  const res = await fetchWithRetry(FEED_URL, { headers: { Accept: 'application/rss+xml, text/xml' } });
  const xml = await res.text();
  return parseFeed(xml).filter((it) => !/^recherche/i.test(it.category));
}
