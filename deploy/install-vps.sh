#!/usr/bin/env bash
# Installe et lance Méthode Nico sur un VPS Debian/Ubuntu, avec HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/Brunotahiti/Nico/claude/gallant-hopper-e2wyec/deploy/install-vps.sh | sudo -E bash
#
# Variables facultatives (à placer après « sudo », ex. : | sudo ACCESS_CODE=x DOMAIN=y bash) :
#   DOMAIN=immo.mondomaine.pf   nom de domaine pointant vers le VPS (sinon : <ip>.sslip.io, sans rien à configurer)
#   ACCESS_CODE=monsecret       code demandé dans l'application pour s'abonner (fortement conseillé)
#   CHECK_INTERVAL_MIN=5        fréquence de vérification des sites
#   REPO / BRANCH               dépôt et branche à déployer
#
# Si un Traefik tourne déjà sur le serveur, l'application s'y branche (étiquettes Docker).
# Sinon, un Caddy est lancé pour obtenir le certificat HTTPS.
set -euo pipefail

# Le script met à jour le dépôt qui le contient pendant son exécution : on travaille sur une copie.
if [ "${INSTALL_SELF_COPY:-}" != "1" ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  _copy="$(mktemp /tmp/install-vps.XXXXXX.sh)"; cp "${BASH_SOURCE[0]}" "$_copy"
  INSTALL_SELF_COPY=1 exec bash "$_copy" "$@"
fi

REPO="${REPO:-https://github.com/Brunotahiti/Nico.git}"
BRANCH="${BRANCH:-claude/gallant-hopper-e2wyec}"
APP_DIR="${APP_DIR:-/opt/veille-immo}"
CHECK_INTERVAL_MIN="${CHECK_INTERVAL_MIN:-5}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
envget() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
envset() { if grep -qE "^$1=" .env 2>/dev/null; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }

if [ "$(id -u)" -ne 0 ]; then echo "Lancez ce script avec sudo." >&2; exit 1; fi

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Installation de Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  log "Installation du plugin docker compose"
  apt-get update -qq && apt-get install -y -qq docker-compose-plugin
fi

# 2. Code
if [ -d "$APP_DIR/.git" ]; then
  log "Mise à jour du code dans $APP_DIR"
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" checkout -q "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  log "Téléchargement du code dans $APP_DIR"
  command -v git >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq git)
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
touch .env
mkdir -p data

# 3. Domaine : si aucun n'est fourni, on utilise <ip>.sslip.io (résout vers l'IP, certificat Let's Encrypt possible)
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN="$(envget DOMAIN)"
  if [ -z "$DOMAIN" ]; then
    IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
    DOMAIN="$(echo "$IP" | tr . -).sslip.io"
  fi
fi

# 4. Fichier .env (les valeurs existantes sont conservées sauf si on en passe de nouvelles)
log "Configuration (.env)"
envset DOMAIN "$DOMAIN"
[ -n "$(envget CHECK_INTERVAL_MIN)" ] || envset CHECK_INTERVAL_MIN "$CHECK_INTERVAL_MIN"
[ -n "$(envget VAPID_SUBJECT)" ] || envset VAPID_SUBJECT "mailto:${VAPID_SUBJECT:-veille-immo@$DOMAIN}"
if [ -n "${ACCESS_CODE:-}" ]; then envset ACCESS_CODE "$ACCESS_CODE"; else [ -n "$(envget ACCESS_CODE)" ] || envset ACCESS_CODE ""; fi
[ -n "${FETCH_RELAY_URL:-}" ] && envset FETCH_RELAY_URL "$FETCH_RELAY_URL"
[ -n "${FETCH_RELAY_KEY:-}" ] && envset FETCH_RELAY_KEY "$FETCH_RELAY_KEY"

# 5. Traefik déjà présent ?
TRAEFIK="$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /traefik/ {print $1; exit}')"

if [ -n "$TRAEFIK" ]; then
  log "Traefik détecté (conteneur « $TRAEFIK ») : l'application s'y branche"

  # Réseau Docker de Traefik (premier réseau autre que bridge/host)
  # Toutes les étiquettes des conteneurs en cours : on y lit le réseau, le résolveur et le point d'entrée utilisés par les autres applications
  ALL_LABELS="$(docker ps -q | xargs -r docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' 2>/dev/null || true)"
  TRAEFIK_NETWORK="${TRAEFIK_NETWORK:-$(envget TRAEFIK_NETWORK)}"
  if [ -z "$TRAEFIK_NETWORK" ]; then
    # a) réseau propre de Traefik (hors bridge/host)
    TRAEFIK_NETWORK="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$TRAEFIK" | grep -vE '^(bridge|host|none)$' | head -1)"
  fi
  if [ -z "$TRAEFIK_NETWORK" ]; then
    # b) étiquette traefik.docker.network la plus utilisée par les autres applications
    TRAEFIK_NETWORK="$(echo "$ALL_LABELS" | grep -oE '^traefik\.docker\.network=[A-Za-z0-9_.-]+' | cut -d= -f2 | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
  fi
  if [ -z "$TRAEFIK_NETWORK" ]; then
    # c) réseau le plus utilisé par les conteneurs exposés via Traefik
    TRAEFIK_NETWORK="$(docker ps -q | xargs -r docker inspect -f '{{if index .Config.Labels "traefik.enable"}}{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}{{end}}' 2>/dev/null | grep -vE '^(host|none)$' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
  fi
  if [ -z "$TRAEFIK_NETWORK" ] && [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$TRAEFIK")" = "host" ]; then
    # d) Traefik en mode host : il atteint n'importe quel réseau bridge
    TRAEFIK_NETWORK="bridge"
  fi
  TRAEFIK_CERTRESOLVER="${TRAEFIK_CERTRESOLVER:-$(envget TRAEFIK_CERTRESOLVER)}"
  if [ -z "$TRAEFIK_CERTRESOLVER" ]; then
    TRAEFIK_CERTRESOLVER="$(echo "$ALL_LABELS" | grep -oE 'tls\.certresolver=[A-Za-z0-9_-]+' | cut -d= -f2 | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
  fi
  if [ -z "$TRAEFIK_CERTRESOLVER" ]; then
    # Sinon dans les arguments de Traefik
    TRAEFIK_CERTRESOLVER="$(docker inspect -f '{{join .Args " "}} {{join .Config.Cmd " "}}' "$TRAEFIK" | grep -oE 'certificatesresolvers\.[A-Za-z0-9_-]+' | head -1 | cut -d. -f2)"
  fi
  TRAEFIK_ENTRYPOINT="${TRAEFIK_ENTRYPOINT:-$(envget TRAEFIK_ENTRYPOINT)}"
  if [ -z "$TRAEFIK_ENTRYPOINT" ]; then
    TRAEFIK_ENTRYPOINT="$(echo "$ALL_LABELS" | grep -oE 'routers\.[A-Za-z0-9_-]+\.entrypoints=[A-Za-z0-9_,-]+' | cut -d= -f2 | tr ',' '\n' | grep -iE 'secure|https|443' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')"
  fi
  if [ -z "$TRAEFIK_ENTRYPOINT" ]; then
    TRAEFIK_ENTRYPOINT="$(docker inspect -f '{{join .Args " "}} {{join .Config.Cmd " "}}' "$TRAEFIK" | grep -oE 'entrypoints\.[A-Za-z0-9_-]+\.address=:443' | head -1 | cut -d. -f2)"
  fi
  TRAEFIK_ENTRYPOINT="${TRAEFIK_ENTRYPOINT:-websecure}"

  if [ -z "$TRAEFIK_NETWORK" ] || [ -z "$TRAEFIK_CERTRESOLVER" ]; then
    warn "Impossible de déterminer automatiquement la configuration de Traefik."
    echo "   Réseau trouvé      : ${TRAEFIK_NETWORK:-?}"
    echo "   Résolveur trouvé   : ${TRAEFIK_CERTRESOLVER:-?}"
    echo "   Relancez en précisant TRAEFIK_NETWORK=... TRAEFIK_CERTRESOLVER=... devant la commande."
    exit 1
  fi
  echo "   réseau=$TRAEFIK_NETWORK  point d'entrée=$TRAEFIK_ENTRYPOINT  résolveur=$TRAEFIK_CERTRESOLVER  domaine=$DOMAIN"
  if docker inspect -f '{{join .Args " "}} {{join .Config.Cmd " "}}' "$TRAEFIK" | grep -q "certificatesresolvers.$TRAEFIK_CERTRESOLVER.acme.dnschallenge" && echo "$DOMAIN" | grep -q 'sslip.io'; then
    warn "Le résolveur « $TRAEFIK_CERTRESOLVER » utilise un défi DNS : un domaine sslip.io ne pourra pas obtenir de certificat."
    echo "   Relancez avec DOMAIN=immo.votre-domaine (sous-domaine de votre zone DNS) devant la commande."
  fi
  envset TRAEFIK_NETWORK "$TRAEFIK_NETWORK"
  envset TRAEFIK_ENTRYPOINT "$TRAEFIK_ENTRYPOINT"
  envset TRAEFIK_CERTRESOLVER "$TRAEFIK_CERTRESOLVER"

  # Nettoie une éventuelle tentative précédente avec Caddy
  docker compose -f docker-compose.prod.yml down --remove-orphans >/dev/null 2>&1 || true

  log "Construction et démarrage"
  docker compose -f docker-compose.traefik.yml up -d --build --remove-orphans
  COMPOSE_FILE_USED="docker-compose.traefik.yml"
else
  log "Aucun Traefik : lancement avec Caddy (HTTPS automatique, domaine : $DOMAIN)"
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  fi
  DOMAIN="$DOMAIN" docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
  COMPOSE_FILE_USED="docker-compose.prod.yml"
fi

sleep 5
docker compose -f "$COMPOSE_FILE_USED" ps

log "Terminé. Ouvrez https://$DOMAIN sur votre iPhone (Safari), puis Partager → Sur l'écran d'accueil."
echo "   Journal : cd $APP_DIR && docker compose -f $COMPOSE_FILE_USED logs -f app"
[ -n "$(envget ACCESS_CODE)" ] || echo "Conseil : relancez avec ACCESS_CODE=unsecret pour empêcher des inconnus de s'abonner."
