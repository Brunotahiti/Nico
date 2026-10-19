#!/usr/bin/env bash
# Déploie sur le VPS depuis votre machine (ou depuis une session Claude) via SSH.
# Variables attendues :
#   VPS_HOST      adresse IP ou nom du VPS
#   VPS_USER      utilisateur SSH (défaut : root)
#   VPS_SSH_KEY   contenu de la clé privée SSH (facultatif si votre agent SSH est configuré)
#   DOMAIN, ACCESS_CODE, CHECK_INTERVAL_MIN   transmis au script d'installation
set -euo pipefail
: "${VPS_HOST:?VPS_HOST manquant}"
VPS_USER="${VPS_USER:-root}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo claude/gallant-hopper-e2wyec)}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
KEY_FILE=""
if [ -n "${VPS_SSH_KEY:-}" ]; then
  KEY_FILE="$(mktemp)"; printf '%s\n' "$VPS_SSH_KEY" > "$KEY_FILE"; chmod 600 "$KEY_FILE"
  SSH_OPTS+=(-i "$KEY_FILE" -o IdentitiesOnly=yes)
  trap 'rm -f "$KEY_FILE"' EXIT
fi

REMOTE_ENV="BRANCH=$BRANCH"
[ -n "${DOMAIN:-}" ] && REMOTE_ENV+=" DOMAIN=$DOMAIN"
[ -n "${ACCESS_CODE:-}" ] && REMOTE_ENV+=" ACCESS_CODE=$ACCESS_CODE"
[ -n "${CHECK_INTERVAL_MIN:-}" ] && REMOTE_ENV+=" CHECK_INTERVAL_MIN=$CHECK_INTERVAL_MIN"

SUDO=""; [ "$VPS_USER" != "root" ] && SUDO="sudo"
echo "Connexion à $VPS_USER@$VPS_HOST…"
ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" "$SUDO env $REMOTE_ENV bash -s" < "$(dirname "$0")/install-vps.sh"
