#!/usr/bin/env bash
# Installe et lance Veille immo Tahiti sur un VPS Debian/Ubuntu, avec HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/Brunotahiti/Nico/claude/gallant-hopper-e2wyec/deploy/install-vps.sh | sudo bash
#
# Variables facultatives (à placer avant la commande) :
#   DOMAIN=immo.mondomaine.pf   nom de domaine pointant vers le VPS (sinon : <ip>.sslip.io, sans rien à configurer)
#   ACCESS_CODE=monsecret       code demandé dans l'application pour s'abonner (fortement conseillé)
#   CHECK_INTERVAL_MIN=5        fréquence de vérification des sites
#   REPO / BRANCH               dépôt et branche à déployer
set -euo pipefail

REPO="${REPO:-https://github.com/Brunotahiti/Nico.git}"
BRANCH="${BRANCH:-claude/gallant-hopper-e2wyec}"
APP_DIR="${APP_DIR:-/opt/veille-immo}"
CHECK_INTERVAL_MIN="${CHECK_INTERVAL_MIN:-5}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

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

# 3. Domaine : si aucun n'est fourni, on utilise <ip>.sslip.io (résout vers l'IP, certificat Let's Encrypt possible)
if [ -z "${DOMAIN:-}" ]; then
  if [ -f .env ] && grep -q '^DOMAIN=' .env; then
    DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
  else
    IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
    DOMAIN="$(echo "$IP" | tr . -).sslip.io"
  fi
fi

# 4. Fichier .env (créé une seule fois, puis conservé)
if [ ! -f .env ]; then
  log "Création du fichier .env"
  {
    echo "DOMAIN=$DOMAIN"
    echo "CHECK_INTERVAL_MIN=$CHECK_INTERVAL_MIN"
    echo "VAPID_SUBJECT=mailto:${VAPID_SUBJECT:-veille-immo@$DOMAIN}"
    echo "ACCESS_CODE=${ACCESS_CODE:-}"
  } > .env
else
  # met à jour le domaine ou le code d'accès s'ils sont passés explicitement
  [ -n "${DOMAIN:-}" ] && sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env
  [ -n "${ACCESS_CODE:-}" ] && sed -i "s|^ACCESS_CODE=.*|ACCESS_CODE=$ACCESS_CODE|" .env
fi
mkdir -p data

# 5. Pare-feu (si ufw est actif)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

# 6. Lancement
log "Construction et démarrage (domaine : $DOMAIN)"
DOMAIN="$DOMAIN" docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
sleep 5
docker compose -f docker-compose.prod.yml ps

log "Terminé. Ouvrez https://$DOMAIN sur votre iPhone (Safari), puis Partager → Sur l'écran d'accueil."
[ -n "${ACCESS_CODE:-}" ] || echo "Conseil : relancez avec ACCESS_CODE=unsecret pour empêcher des inconnus de s'abonner."
