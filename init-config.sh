#!/usr/bin/env bash
# Setup on the VPS: generates the secrets of the server and a key for the operator, and writes
# fingerprint/config/config.json. It makes NO tenants: they live in the database and are made and changed in the settings
# panel (https://<host>:8443/dashboard/config), with the operator key. A tenant that is still listed in an existing
# config.json must be moved first with ./migrate-tenants.sh, or its keys would be lost.
# If config.json already exists it asks for confirmation and keeps a backup.
#
# Usage (on the VPS, from the repository clone, after rebuild.sh has built the image and dist/):
#   ./init-config.sh
set -euo pipefail

FP_REPO="$(cd "$(dirname "$0")" && pwd)"
PROXY="$HOME/Repos/reverse-proxy-config"
IMAGE="fingerprint-server:latest"
CONFIG_DIR="$PROXY/fingerprint/config"
CONFIG="$CONFIG_DIR/config.json"
COLLECTOR_PATH="/static/pw-3f9a.js"

if sudo test -f "$CONFIG"; then
  echo "Já existe um config.json em $CONFIG"
  echo
  tenants_in_file="$(sudo docker run --rm -v "$CONFIG_DIR":/config:ro "$IMAGE" node -e \
    "const c=JSON.parse(require('fs').readFileSync('/config/config.json','utf8'));console.log((c.tenants||[]).length)" 2>/dev/null || echo 0)"
  if [ "$tenants_in_file" != "0" ]; then
    echo "O config.json ainda lista $tenants_in_file tenant(s). Sobrescrever apagaria as chaves deles." >&2
    echo "Rode antes ./migrate-tenants.sh (copia os tenants para o banco com as mesmas chaves)." >&2
    exit 1
  fi
  echo "Se você sobrescrever:"
  echo "  - o nonceSecret e o ipHashSecret mudam (o hash de IP guardado antes deixa de bater com os novos);"
  echo "  - a chave de operador muda (a anterior deixa de valer);"
  echo "  - as chaves dos tenants NÃO mudam: eles estão no banco."
  echo "O arquivo atual será guardado em uma cópia de segurança antes."
  echo
  read -r -p "Sobrescrever? Digite 'sobrescrever' para confirmar [Enter cancela]: " answer
  if [ "$answer" != "sobrescrever" ]; then
    echo "Cancelado. Nada foi alterado."
    exit 0
  fi
  BACKUP="$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
  sudo cp -p "$CONFIG" "$BACKUP"
  echo "Cópia de segurança: $BACKUP"
  echo
fi
if [ ! -f "$FP_REPO/dist/fp.min.js" ]; then
  echo "dist/fp.min.js não existe. Rode ./rebuild.sh antes." >&2
  exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Imagem $IMAGE não existe. Rode ./rebuild.sh antes." >&2
  exit 1
fi

cli() { docker run --rm "$IMAGE" node dist/cli.js "$@"; }
sha256() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

NONCE_SECRET="$(cli nonce-secret)"
IP_HASH_SECRET="$(cli nonce-secret)"

# admin-key prints "Admin key (...):  adm_..." and the JSON with its hash.
ADMIN_OUT="$(cli admin-key)"
ADMIN_KEY="$(printf '%s\n' "$ADMIN_OUT" | sed -n 's/^Admin key .*:  //p')"
if [ -z "$ADMIN_KEY" ]; then
  echo "Não consegui gerar a chave de operador." >&2
  exit 1
fi

sudo mkdir -p "$CONFIG_DIR"
umask 077
sudo tee "$CONFIG" >/dev/null <<EOF
{
  "listen": { "host": "0.0.0.0", "port": 8443 },
  "tls": { "certFile": "/config/cert.pem", "keyFile": "/config/key.pem" },
  "dashboard": true,
  "nonceSecret": "$NONCE_SECRET",
  "ipHashSecret": "$IP_HASH_SECRET",
  "database": {
    "type": "mysql",
    "host": "mysql",
    "port": 3306,
    "user": "fp",
    "database": "fingerprint",
    "connectionLimit": 6,
    "lockConnections": 4
  },
  "collectorFile": "/config/collector.js",
  "collectorPath": "$COLLECTOR_PATH",
  "adminKeySha256": ["$(sha256 "$ADMIN_KEY")"],
  "tenants": []
}
EOF

sudo cp "$FP_REPO/dist/fp.min.js" "$CONFIG_DIR/collector.js"
sudo chown -R 1000:1000 "$CONFIG_DIR"
sudo chmod 600 "$CONFIG"

echo
echo "Validando a configuração..."
sudo docker run --rm -v "$CONFIG_DIR":/config:ro "$IMAGE" \
  node -e "require('./dist/config').loadConfig('/config/config.json'); console.log('configuração válida')"

cat <<EOF

config.json criado em $CONFIG

GUARDE AGORA no gerenciador de senhas (a chave NÃO é gravada em lugar nenhum):

  chave de operador: $ADMIN_KEY

Ela entra no painel de configuração. Os tenants (por exemplo o do PWA) são criados lá, em "Novo tenant", e a chave
secreta de cada um aparece uma vez, na criação.

Se o servidor já estiver no ar, reinicie: docker compose restart fingerprint
Painel: https://id.empregoaqui.com.br:8443/dashboard/config

Próximo passo: a senha do banco no .env do proxy e o serviço no docker-compose.yml (guia, seção E3).
EOF
