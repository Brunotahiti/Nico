# Nick Immobilier

Application web (PWA) qui surveille **immobilier.pf** et **petitesannonces.pf** et vous envoie une **notification sur votre iPhone** dès qu'une nouvelle annonce immobilière est publiée. Objectif : être le premier à voir les nouvelles annonces.

## Comment ça marche

- Un petit serveur Node.js interroge les deux sites toutes les 5 minutes (réglable) :
  - immobilier.pf : via l'API interne que le site utilise lui-même (`/api/bid/light`, triée par date de création).
  - petitesannonces.pf : via le flux RSS de la rubrique Immobilier (`rss.php?r=1`). Les annonces « Recherche immobilier » (demandes) sont ignorées.
- Chaque annonce jamais vue est mémorisée et déclenche une notification **Web Push** vers tous les appareils abonnés.
- L'application affiche l'historique des notifications reçues, regroupé par jour, avec un lien direct vers l'annonce d'origine.
- Seules les annonces de particuliers sont notifiées. Une liste noire (téléphone, e-mail, nom ou mot), dans les Réglages ou via « Ignorer cet annonceur », écarte les professionnels qui se présentent comme particuliers.
- Préférences facultatives par appareil : sites, type (vente / location / autre), prix maximum, mots-clés.
- Au tout premier démarrage, les annonces déjà en ligne sont mémorisées **sans** envoyer de notification (pas de rafale de 100 alertes).

## Pré-requis côté iPhone

Les notifications push web fonctionnent sur iPhone à partir d'**iOS 16.4**, uniquement quand le site est **ajouté à l'écran d'accueil** et servi en **HTTPS**.

1. Ouvrez l'adresse de votre serveur dans **Safari**.
2. Bouton **Partager** → **« Sur l'écran d'accueil »** → **Ajouter**.
3. Ouvrez l'application depuis l'écran d'accueil, touchez **Activer les notifications** et acceptez.
4. Touchez **Notification de test** pour vérifier.

## Installation

### Option A : VPS en une commande (HTTPS automatique)

Sur un VPS Debian/Ubuntu, en root :

```bash
curl -fsSL https://raw.githubusercontent.com/Brunotahiti/Nico/main/deploy/install-vps.sh | sudo ACCESS_CODE=unsecret bash
```

Le script installe Docker, télécharge le code dans `/opt/veille-immo` et lance l'application. Si un Traefik tourne déjà sur le serveur, l'application s'y branche automatiquement (réseau, point d'entrée et résolveur de certificats détectés depuis vos autres conteneurs) ; sinon un reverse proxy Caddy est lancé pour obtenir le certificat HTTPS. Sans nom de domaine, il utilise automatiquement `<ip-du-vps>.sslip.io`. Avec un domaine pointant vers le VPS : ajoutez `DOMAIN=immo.mondomaine.pf` après `sudo`. Relancer la commande met à jour l'application. Pour passer des variables à une installation déjà en place : `sudo env DOMAIN=… ACCESS_CODE=… bash /opt/veille-immo/deploy/install-vps.sh` (avec `sudo -E`, certaines configurations ignorent les variables).

Depuis votre ordinateur, `deploy/deploy-from-here.sh` fait la même chose via SSH (variables `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`).

### Option B : Docker Compose simple (NAS, Raspberry Pi, derrière votre propre proxy)

```bash
git clone <ce dépôt> veille-immo && cd veille-immo
docker compose up -d --build
```

Le serveur écoute sur le port 3000. L'état est conservé dans `./data`.

### Option C : Node.js directement

```bash
npm install
npm start
```

Variables d'environnement (voir `.env.example`) :

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port HTTP | `3000` |
| `DATA_DIR` | Dossier de l'état persistant | `./data` |
| `CHECK_INTERVAL_MIN` | Fréquence de vérification (minutes) | `5` |
| `VAPID_SUBJECT` | Contact transmis aux services push | `mailto:veille-immo@example.com` |
| `ACCESS_CODE` | Code demandé pour s'abonner (vide = ouvert) | vide |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Clés push ; générées automatiquement dans `DATA_DIR/vapid.json` si absentes | auto |

### HTTPS obligatoire

Safari n'autorise les notifications que sur une adresse `https://`. Solutions simples :

- **Hébergeur avec HTTPS inclus** : Railway, Fly.io, Render (plan payant ou « background worker » : sur un plan gratuit qui met le service en veille, la surveillance s'arrête). Déployez le `Dockerfile`, montez un volume sur `/data` ou renseignez `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` pour ne pas perdre les abonnements au redéploiement.
- **Chez vous** (NAS, Raspberry Pi) : mettez un reverse proxy devant (Caddy obtient un certificat tout seul) ou utilisez un tunnel type Cloudflare Tunnel / Tailscale Funnel.

Exemple Caddy (`Caddyfile`) :

```
immo.mondomaine.pf {
    reverse_proxy localhost:3000
}
```

### Protéger l'accès

Si le serveur est accessible publiquement, définissez `ACCESS_CODE`. L'application demandera ce code pour activer les notifications (la liste des annonces reste visible).

## Vérifier que les sources répondent

```bash
npm run check
```

Affiche les 5 dernières annonces de chaque site.

## API (pour information)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/config` | Clé publique VAPID, intervalle, préférences par défaut |
| GET | `/api/listings?limit=100` | Dernières annonces détectées + état des sources |
| POST | `/api/subscribe` | Enregistre un abonnement push et ses préférences |
| POST | `/api/unsubscribe` | Supprime un abonnement |
| POST | `/api/test-notification` | Envoie une notification de test |
| POST | `/api/check-now` | Force une vérification immédiate |

## Si le serveur ne peut pas joindre petitesannonces.pf

petitesannonces.pf est hébergé en Polynésie et bloque certaines plages d'adresses de datacenters (c'est le cas chez Hostinger). L'onglet « État » de l'application affiche alors le site en erreur. Solution : un relais gratuit sur Cloudflare Workers, par lequel le serveur va chercher le flux.

1. Créez un compte sur https://dash.cloudflare.com (gratuit), puis **Workers & Pages → Create → Start with Hello World → Deploy**.
2. **Edit code**, remplacez tout le contenu par le fichier `deploy/relay-worker.js`, puis **Deploy**.
3. **Settings → Variables and Secrets** : ajoutez un secret `RELAY_KEY` avec une longue chaîne de votre choix.
4. Notez l'adresse du worker (`https://xxx.yyy.workers.dev`) et, sur le serveur :

```bash
sudo env FETCH_RELAY_URL=https://xxx.yyy.workers.dev FETCH_RELAY_KEY=<la même chaîne> bash /opt/veille-immo/deploy/install-vps.sh
```

Seules les requêtes vers petitesannonces.pf passent par le relais (variable `FETCH_RELAY_HOSTS`).

## Limites à connaître

- Les deux sites peuvent changer leur structure ou leur API : la page « Surveillance » de l'application signale un site en erreur.
- immobilier.pf coupe parfois les connexions ; le programme réessaie automatiquement.
- Les notifications sont envoyées via les serveurs push d'Apple ; le serveur doit donc avoir accès à Internet en sortie.
