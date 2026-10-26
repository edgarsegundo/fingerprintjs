#!/usr/bin/env bash
# One-time setup on the VPS: generates the secrets and the tenants and writes fingerprint/config/config.json.
# If config.json already exists it asks for confirmation and keeps a backup, because new secrets invalidate every key in use.
#
# Usage (on the VPS, from the repository clone, after rebuild.sh has built the image and dist/):
#   ./init-config.sh
set -euo pipefail

FP_REPO="$(cd "$(dirname "$0")" && pwd)"
PROXY="$HOME/Repos/reverse-proxy-config"
IMAGE="fingerprint-server:latest"
CONFIG_DIR="$PROXY/fingerprint/config"
CONFIG="$CONFIG_DIR/config.json"
ORIGIN="https://app.empregoaqui.com.br"
COLLECTOR_PATH="/static/pw-3f9a.js"

if sudo test -f "$CONFIG"; then
  echo "Já existe um config.json em $CONFIG"
  echo
  echo "Se você sobrescrever, TUDO é gerado de novo:"
  echo "  - as chaves públicas e secretas dos tenants mudam (o PWA e qualquer backend que usa as antigas param de funcionar);"
  echo "  - o nonceSecret e o ipHashSecret mudam (o hash de IP guardado antes deixa de bater com os novos)."
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

# new-tenant prints "Public key (...):  pk_..." and "Secret key (...):  sk_..." lines.
new_tenant() {
  local out
  out="$(cli new-tenant "$1")"
  PUBLIC_KEY="$(printf '%s\n' "$out" | sed -n 's/^Public key .*:  //p')"
  SECRET_KEY="$(printf '%s\n' "$out" | sed -n 's/^Secret key .*:  //p')"
  if [ -z "$PUBLIC_KEY" ] || [ -z "$SECRET_KEY" ]; then
    echo "Não consegui ler as chaves do tenant $1." >&2
    exit 1
  fi
}

new_tenant pwa
PWA_PK="$PUBLIC_KEY"; PWA_SK="$SECRET_KEY"
new_tenant teste
TESTE_PK="$PUBLIC_KEY"; TESTE_SK="$SECRET_KEY"

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
  "tenants": [
    {
      "id": "pwa",
      "publicKey": "$PWA_PK",
      "secretKeySha256": ["$(sha256 "$PWA_SK")"],
      "allowedOrigins": ["$ORIGIN"],
      "settings": {
        "identity": { "storedId": { "enabled": false } },
        "privacy": { "ipStorage": "hash" },
        "retention": { "eventsDays": 60 }
      }
    },
    {
      "id": "teste",
      "publicKey": "$TESTE_PK",
      "secretKeySha256": ["$(sha256 "$TESTE_SK")"],
      "allowedOrigins": ["http://127.0.0.1:8081"],
      "settings": { "identity": { "storedId": { "enabled": false } } }
    }
  ]
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

GUARDE AGORA no gerenciador de senhas (as chaves secretas NÃO são gravadas em lugar nenhum):

  tenant pwa
    publicKey: $PWA_PK
    secretKey: $PWA_SK

  tenant teste
    publicKey: $TESTE_PK
    secretKey: $TESTE_SK

Se o servidor já estiver no ar, recarregue com: docker compose kill -s HUP fingerprint
(os segredos novos só valem depois disso; o PWA precisa da nova publicKey do tenant pwa).

Próximo passo: a senha do banco no .env do proxy e o serviço no docker-compose.yml (guia, seção E3).
EOF
