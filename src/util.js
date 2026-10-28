const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Relais facultatif : certains hébergeurs polynésiens bloquent les adresses de
// datacenters. Si FETCH_RELAY_URL est défini, les requêtes vers les hôtes de
// FETCH_RELAY_HOSTS passent par ce relais (voir deploy/relay-worker.js).
const RELAY_URL = (process.env.FETCH_RELAY_URL || '').trim();
const RELAY_KEY = (process.env.FETCH_RELAY_KEY || '').trim();
const RELAY_HOSTS = (process.env.FETCH_RELAY_HOSTS || 'petitesannonces.pf,petites-annonces.pf')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export function relayFor(url) {
  if (!RELAY_URL) return null;
  const host = new URL(url).hostname.toLowerCase();
  if (!RELAY_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return null;
  return `${RELAY_URL}${RELAY_URL.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
}

export const relayEnabled = Boolean(RELAY_URL);

// Numéros polynésiens : 8 chiffres (40, 87, 88, 89…), éventuellement précédés de +689 ou 689.
const PHONE_RE = /(?:\+?\s?689[\s.\-]?)?(?:\b|(?<=\D))((?:4|8)\d(?:[\s.\-]?\d{2}){3})\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
/** Forme comparable d'un numéro : les 8 derniers chiffres. */
export const normPhone = (s) => digitsOnly(s).slice(-8);

/** Extrait téléphones et e-mails d'un texte libre. */
export function extractContacts(...texts) {
  const text = texts.filter(Boolean).join(' ');
  const phones = new Set();
  for (const m of text.matchAll(PHONE_RE)) { const n = normPhone(m[1]); if (n.length === 8) phones.add(n); }
  const emails = new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()));
  return { phones: [...phones], emails: [...emails] };
}

export function wordHit(text, entry) {
  // Mot ou expression de la liste noire présent dans le texte, en mot entier (« agence » ≠ « agencement »),
  // en ignorant les tournures qui le nient : « pas d'agence », « sans frais d'agence », « agences s'abstenir »…
  const norm = (s) => String(s || '').toLowerCase().replace(/[’`´]/g, "'").normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = norm(text), e = norm(entry).trim();
  if (!e) return false;
  const pat = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(^|[^a-z0-9])(${pat})(s|x)?(?=$|[^a-z0-9])`, 'g');
  let m;
  while ((m = re.exec(t))) {
    const start = m.index + m[1].length, end = start + m[2].length + (m[3] ? m[3].length : 0);
    const before = t.slice(Math.max(0, start - 30), start);
    const after = t.slice(end, end + 50);
    const negBefore = /(^|[^a-z])(pas|sans|aucune?|ni|non|hors|zero|0|jamais)\s+(de\s+)?(frais\s+)?(d'\s*|d\s+|de\s+|des\s+)?$/.test(before);
    const negAfter = /^\s*((,|et|ou|&|\/)\s*[a-z]+\s*)*(s'abstenir|s'abstiennent|merci de s'abstenir|non merci|non acceptee?s?|pas acceptee?s?|refusee?s?|exclue?s?|interdite?s?)/.test(after);
    if (!negBefore && !negAfter) return true;
  }
  return false;
}

/**
 * Une annonce correspond-elle à une entrée de la liste noire ?
 * Entrée avec « @ » : e-mail ; 6 chiffres ou plus : téléphone ; sinon : mot ou nom.
 */
export function blockedBy(listing, blocklist = []) {
  const hay = `${listing.title} ${listing.description} ${listing.contactName || ''} ${listing.agency || ''} ${(listing.emails || []).join(' ')}`.toLowerCase();
  const phones = listing.phones || [];
  const hayDigits = digitsOnly(`${listing.title} ${listing.description}`);
  for (const raw of blocklist) {
    const entry = String(raw || '').trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('@')) {
      if ((listing.emails || []).includes(entry) || hay.includes(entry)) return raw;
    } else if (digitsOnly(entry).length >= 6) {
      const p = normPhone(entry);
      if (phones.includes(p) || hayDigits.includes(p)) return raw;
    } else if (wordHit(hay, entry)) {
      return raw;
    }
  }
  return null;
}

// Messageries grand public : une adresse chez elles ne dit rien du statut de l'annonceur.
const PUBLIC_MAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|gmx|proton|protonmail|mail|email|orange|wanadoo|free|sfr|neuf|laposte|bbox|vini|mana|lagoon|caramail)\./i;
// Domaine d'adresse qui trahit une agence ou un professionnel de l'immobilier.
const PRO_DOMAIN = /(immo|immobil|agence|realty|realestate|estate|propert|habitat|gestion|syndic|transaction|invest|foncier|promot)/i;

export const emailDomain = (e) => String(e || '').toLowerCase().split('@')[1] || '';
export const isPublicMail = (e) => PUBLIC_MAIL.test(emailDomain(e));
/** Domaine d'agence trouvé parmi les e-mails de l'annonce (ex. manea-immo.com), sinon null. */
export function proEmailDomain(listing) {
  for (const e of listing.emails || []) {
    const d = emailDomain(e);
    if (d && !isPublicMail(e) && PRO_DOMAIN.test(d)) return d;
  }
  return null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetch avec délai d'attente et nouvelles tentatives (les sites polynésiens
 * coupent parfois la connexion).
 */
export async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 30000, relayRetries = 6 } = {}) {
  let lastError;
  const relayed = relayFor(url);
  const extra = relayed && RELAY_KEY ? { 'x-relay-key': RELAY_KEY } : {};
  // Via le relais, l'hébergeur distant coupe une partie des connexions : on insiste
  // davantage, et on change l'URL à chaque essai pour contourner tout cache intermédiaire.
  if (relayed) retries = Math.max(retries, relayRetries);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const target = relayed ? `${relayed}%26_%3D${Date.now()}${attempt}` : url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(target, {
        ...options,
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr-FR,fr;q=0.9', ...extra, ...(options.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${target}${relayed ? ' (via relais)' : ''}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep((relayed ? 2500 : 1500) * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// Même algorithme que le site immobilier.pf pour fabriquer ses URL.
export function slugify(str) {
  let a = String(str).trim().toLowerCase();
  const from = 'àáäâèéëêìíïîòóöôùúüûñç·/_,:;';
  const to = 'aaaaeeeeiiiioooouuuunc------';
  for (let i = 0; i < from.length; i++) a = a.split(from.charAt(i)).join(to.charAt(i));
  return a
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ecirc: 'ê', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', icirc: 'î', euro: '€', sup2: '²', deg: '°' };

export function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}
