// Récupère les dernières annonces de la rubrique Immobilier de petitesannonces.pf.
// Le site expose un flux RSS par rubrique : https://www.petitesannonces.pf/rss.php?r=1
// (r=1 = Immobilier, 50 annonces les plus récentes). Les identifiants d'annonce
// sont croissants, ce qui permet de détecter les nouveautés de façon fiable.

import { fetchWithRetry, decodeEntities, extractContacts } from '../util.js';

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
  const contacts = extractContacts(title, text);
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
    contactName: '',
    phones: contacts.phones,
    emails: contacts.emails,
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
 * Lit la page de liste Immobilier, qui marque « (PRO) » les annonces de
 * professionnels. Renvoie une table identifiant -> 'pro' | 'particulier'.
 */
export async function sellerMap(pages = 2) {
  const map = new Map();
  for (let p = 1; p <= pages; p++) {
    const res = await fetchWithRetry(`${BASE}/annonces.php?r=1${p > 1 ? `&p=${p}` : ''}`, { headers: { Accept: 'text/html' } }, { retries: 3, timeoutMs: 25000 });
    const html = Buffer.from(await res.arrayBuffer()).toString('latin1');
    const cards = html.split(/<a class="lda"/).slice(1);
    for (const card of cards) {
      const id = card.match(/tahiti=(\d+)/)?.[1];
      if (id) map.set(id, /class=["']?pra|\(PRO\)/i.test(card) ? 'pro' : 'particulier');
    }
  }
  return map;
}

/**
 * Détermine le type d'annonceur d'un lot d'annonces : d'abord par la page de
 * liste, puis page par page pour celles qui n'y figurent pas.
 */
export async function enrichBatch(items, { maxDetail = 20 } = {}) {
  if (!items.length) return items;
  try {
    const map = await sellerMap(2);
    for (const it of items) if (map.has(it.sourceId)) it.seller = map.get(it.sourceId);
  } catch (err) {
    console.warn(`[petitesannonces] page de liste indisponible : ${err.message}`);
  }
  // Page de l'annonce : type d'annonceur si inconnu, et coordonnées pour les particuliers (liste noire)
  for (const it of items.filter((i) => (i.seller === 'inconnu' || i.seller === 'particulier') && !i.detailFetched).slice(0, maxDetail)) {
    try { await enrich(it); } catch (err) { console.warn(`[petitesannonces] détail ${it.sourceId} indisponible : ${err.message}`); }
  }
  return items;
}

/**
 * Dernier recours si le site reste injoignable : les annonces d'agences portent
 * presque toujours une référence (« - LM22658 », « VA21099 ») ou un préfixe d'agence.
 */
export function guessSeller(item) {
  const t = `${item.title} ${item.description}`;
  if (/(^|[\s-])[A-Z]{2}\d{4,6}\b/.test(item.title) || /^[A-Z]{3,}-/.test(item.title)) return 'pro';
  if (/particulier\s+(à|a)\s+particulier|pas\s+d['’ ]\s*agence|sans\s+(frais\s+d['’]\s*)?agence|agences?\s+((et|,)\s*\S+\s+)*s['’]abstenir/i.test(t)) return 'particulier';
  return 'inconnu';
}

/**
 * Complète une annonce depuis sa page : particulier ou professionnel, date de
 * publication. La page affiche « N° 2400657 (PRO) » pour les professionnels.
 */
export async function enrich(item) {
  const res = await fetchWithRetry(item.url, { headers: { Accept: 'text/html' } }, { retries: 2, timeoutMs: 25000 });
  const html = Buffer.from(await res.arrayBuffer()).toString('latin1');
  // Bloc « CONTACTS & INFOS » : téléphone, e-mail, prénom saisis par l'annonceur
  const block = html.match(/CONTACTS &amp; INFOS<\/h3>\s*<p>([\s\S]*?)<\/p>/i);
  if (block) {
    const txt = decodeEntities(block[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const found = extractContacts(txt);
    item.phones = [...new Set([...(item.phones || []), ...found.phones])];
    item.emails = [...new Set([...(item.emails || []), ...found.emails])];
    const name = txt.match(/Contact\s*:\s*([A-Za-zÀ-ÿ' -]{2,30}?)(?=\s*(?:\+?\d|-|$))/i);
    if (name) item.contactName = name[1].trim();
  }
  item.detailFetched = true;
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
