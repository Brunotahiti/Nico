// Relais HTTP minimal pour Cloudflare Workers (offre gratuite).
//
// Pourquoi : petitesannonces.pf bloque certaines adresses de datacenters ; le
// serveur de veille passe alors par ce relais, qui va chercher la page à sa place.
//
// Mise en place (2 minutes) :
//   1. https://dash.cloudflare.com → Workers & Pages → Create → Start with Hello World → Deploy
//   2. Edit code → remplacer tout le contenu par ce fichier → Deploy
//   3. Settings → Variables and Secrets → ajouter RELAY_KEY (secret) = une longue chaîne au choix
//   4. Noter l'adresse du worker (https://xxx.yyy.workers.dev) et, sur le serveur :
//        sudo env FETCH_RELAY_URL=https://xxx.yyy.workers.dev FETCH_RELAY_KEY=<la même chaîne> \
//            bash /opt/veille-immo/deploy/install-vps.sh

const ALLOWED_DEFAULT = 'petitesannonces.pf,petites-annonces.pf,immobilier.pf';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const target = u.searchParams.get('url');
    if (!target) return new Response('Paramètre url manquant', { status: 400 });
    if (env.RELAY_KEY && request.headers.get('x-relay-key') !== env.RELAY_KEY) {
      return new Response('Non autorisé', { status: 401 });
    }
    let t;
    try { t = new URL(target); } catch { return new Response('URL invalide', { status: 400 }); }
    const allowed = (env.ALLOWED_HOSTS || ALLOWED_DEFAULT).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.some((d) => t.hostname === d || t.hostname.endsWith(`.${d}`))) {
      return new Response('Hôte non autorisé', { status: 403 });
    }
    // Certains hébergeurs coupent une partie des connexions venant de Cloudflare : on réessaie.
    let upstream;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        upstream = await fetch(t.toString(), {
          headers: {
            'User-Agent': UA,
            Accept: request.headers.get('accept') || '*/*',
            'Accept-Language': 'fr-FR,fr;q=0.9',
          },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (upstream.status < 500) break;
      } catch (err) {
        upstream = new Response(`Relais : ${err.message}`, { status: 502 });
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    const headers = new Headers({
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
