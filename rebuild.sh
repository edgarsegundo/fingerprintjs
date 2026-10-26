#!/usr/bin/env bash
# Install or update the fingerprint server on the VPS: pull, build the image and the browser scripts,
# refresh the collector and restart the containers. Safe to run again at any time.
#
# Usage (on the VPS, from the repository clone):
#   ./rebuild.sh [--no-pull] [--no-restart]
#
# It never touches config.json, the .env, the certificate or the nginx files. The first install still needs
# parts B to E of docs/plano/instalar-na-vps-passo-a-passo-*.md (DNS, database, certificate, config.json).
set -euo pipefail

FP_REPO="$(cd "$(dirname "$0")" && pwd)"
PROXY="$HOME/Repos/reverse-proxy-config"
IMAGE="fingerprint-server:latest"
PULL=1
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --no-restart) RESTART=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -f "$PROXY/docker-compose.yml" ]; then
  echo "docker-compose.yml não encontrado em $PROXY" >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$1"; }

cd "$FP_REPO"

if [ "$PULL" = 1 ]; then
  step "Atualizando o código (git pull)"
  git pull --ff-only
fi
git log --oneline -1

step "Construindo a imagem $IMAGE"
docker build -f server/Dockerfile -t "$IMAGE" .

step "Gerando dist/fp.min.js e dist/fp-loader.min.js"
docker run --rm -v "$FP_REPO":/w -w /w node:22 sh -c \
  "npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --ignore-engines && npx --yes yarn@1.22.22 build"
ls -l dist/fp.min.js dist/fp-loader.min.js

# Folders that receive fp-loader.min.js. The loader must be served by each site itself (not by the fingerprint server),
# so a blocked port 8443 cannot hide it. Each site needs two copies: the source public/ folder (survives the next
# deploy, which runs rsync --delete on the served folder) and the served folder (live right now, no redeploy needed).
LOADER_DESTINATIONS=(
  # app.empregoaqui.com.br
  "$HOME/Repos/emprego/pwa/public"
  /var/www/app.empregoaqui.com.br
  # empregoaqui.com.br
  # "$HOME/Repos/fastvistos/public/emprego"
  # /var/www/emprego
  # contrataraqui.com.br
  # "$HOME/Repos/fastvistos/public/contratar"
  # /var/www/contratar
  # fastvistos.com.br
  # "$HOME/Repos/fastvistos/public/fastvistos"
  # /var/www/fastvistos
)

step "Copiando o carregador (fp-loader.min.js) para os sites"
for dest in "${LOADER_DESTINATIONS[@]}"; do
  if [ ! -d "$dest" ]; then
    echo "  $dest não existe, pulei" >&2
  elif cmp -s dist/fp-loader.min.js "$dest/fp-loader.min.js" 2>/dev/null; then
    echo "  $dest já está atualizado"
  else
    cp dist/fp-loader.min.js "$dest/fp-loader.min.js" 2>/dev/null || sudo cp dist/fp-loader.min.js "$dest/fp-loader.min.js"
    echo "  copiado para $dest"
  fi
done

CONFIG="$PROXY/fingerprint/config"
if [ ! -f "$CONFIG/config.json" ]; then
  echo
  echo "Imagem e scripts prontos, mas $CONFIG/config.json não existe." >&2
  echo "Faça as partes B a E do guia (DNS, banco, certificado, config.json) e rode este script de novo." >&2
  exit 0
fi

step "Validando a configuração"
docker run --rm -v "$CONFIG":/config:ro "$IMAGE" \
  node -e "require('./dist/config').loadConfig('/config/config.json'); console.log('configuração válida')"

step "Atualizando o coletor servido pelo servidor"
sudo cp dist/fp.min.js "$CONFIG/collector.js"
sudo chown 1000:1000 "$CONFIG/collector.js"

if [ -x "$PROXY/fingerprint/sync-cert.sh" ]; then
  step "Sincronizando o certificado"
  sudo "$PROXY/fingerprint/sync-cert.sh"
fi

if [ "$RESTART" = 1 ]; then
  step "Reiniciando os containers"
  cd "$PROXY"
  services="fingerprint"
  if docker compose config --services | grep -qx fp-report; then
    services="fingerprint fp-report"
  fi
  # shellcheck disable=SC2086
  docker compose up -d --force-recreate $services
  sleep 20
  latest_image="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
  for s in $services; do
    printf '%s: ' "$s"
    docker inspect --format '{{.State.Health.Status}}' "$s"
    if [ "$(docker inspect --format '{{.Image}}' "$s")" = "$latest_image" ]; then
      echo "  usa a imagem nova"
    else
      echo "  ATENÇÃO: $s NÃO está com a imagem recém-construída" >&2
    fi
  done
fi

cat <<EOF

Pronto.
Carregador para o PWA: $FP_REPO/dist/fp-loader.min.js
  copie para public/ do PWA e faça o deploy do PWA (guia, seção G2).
EOF
