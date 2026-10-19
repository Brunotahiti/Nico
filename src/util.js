const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetch avec délai d'attente et nouvelles tentatives (les sites polynésiens
 * coupent parfois la connexion).
 */
export async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr-FR,fr;q=0.9', ...(options.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
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
