#!/usr/bin/env bash
# One-time migration on the VPS: moves the tenants of config.json into the database (with the SAME keys, so the PWA and
# any backend keep working), makes a key for the operator, and takes "tenants" out of the file. From then on the tenants
# are changed in the settings panel (/dashboard/config) and the edits are no longer lost when init-config.sh runs.
#
# Run it after ./rebuild.sh (the running container needs the import-tenants command). Safe to run again: a tenant that is
# already in the database is not touched, and the operator key is made only if the file has none.
#
# Usage (on the VPS, from the repository clone):
#   ./migrate-tenants.sh
set -euo pipefail

PROXY="$HOME/Repos/reverse-proxy-config"
IMAGE="fingerprint-server:latest"
CONTAINER="fingerprint"
CONFIG_DIR="$PROXY/fingerprint/config"
CONFIG="$CONFIG_DIR/config.json"
BACKUP="$CONFIG.pre-import-$(date +%Y%m%d-%H%M%S)"

die() { echo "$1" >&2; exit 1; }

sudo test -f "$CONFIG" || die "$CONFIG não existe."
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || die "O container $CONTAINER não está em execução."
# Only looks at the code of the container. Do NOT run the command to test it: the container has FP_CONFIG set, so
# "import-tenants --help" would not show help, it would run the import.
docker exec "$CONTAINER" grep -q "import-tenants" dist/cli.js ||
  die "O container não conhece import-tenants. Rode ./rebuild.sh primeiro."

has_admin_key="$(sudo docker run --rm -v "$CONFIG_DIR":/config:ro "$IMAGE" node -e \
  "const c=JSON.parse(require('fs').readFileSync('/config/config.json','utf8'));console.log((c.adminKeySha256||[]).length>0?'yes':'no')")"
tenants_in_file="$(sudo docker run --rm -v "$CONFIG_DIR":/config:ro "$IMAGE" node -e \
  "const c=JSON.parse(require('fs').readFileSync('/config/config.json','utf8'));console.log((c.tenants||[]).length)")"

echo "Tenants no config.json: $tenants_in_file. Chave de operador já configurada: $has_admin_key."
echo
echo "== 1/5  Simulação da cópia dos tenants para o banco (nada é gravado) =="
docker exec "$CONTAINER" node dist/cli.js import-tenants --config /config/config.json --dry-run 2>&1 | grep -v Warning | grep -v trace-warnings || true
echo
read -r -p "Continuar? Digite 'migrar' para confirmar [Enter cancela]: " answer
[ "$answer" = "migrar" ] || { echo "Cancelado. Nada foi alterado."; exit 0; }

echo
echo "== 2/5  Cópia de segurança do config.json =="
sudo cp -p "$CONFIG" "$BACKUP"
echo "Cópia: $BACKUP"

echo
echo "== 3/5  Copiando os tenants para o banco, com as mesmas chaves =="
docker exec "$CONTAINER" node dist/cli.js import-tenants --config /config/config.json 2>&1 | grep -v Warning | grep -v trace-warnings

echo
echo "== 4/5  Chave de operador e tirar 'tenants' do arquivo =="
ADMIN_KEY=""
ADMIN_HASH=""
if [ "$has_admin_key" = "no" ]; then
  out="$(docker run --rm "$IMAGE" node dist/cli.js admin-key 2>/dev/null)"
  ADMIN_KEY="$(printf '%s\n' "$out" | sed -n 's/^Admin key .*:  //p')"
  [ -n "$ADMIN_KEY" ] || die "Não consegui gerar a chave de operador."
  ADMIN_HASH="$(printf '%s' "$ADMIN_KEY" | sha256sum | cut -d' ' -f1)"
fi
sudo docker run --rm -v "$CONFIG_DIR":/config -e ADMIN_HASH="$ADMIN_HASH" "$IMAGE" node -e "
const fs = require('fs')
const path = '/config/config.json'
const config = JSON.parse(fs.readFileSync(path, 'utf8'))
config.tenants = []
if (process.env.ADMIN_HASH) config.adminKeySha256 = [...(config.adminKeySha256 || []), process.env.ADMIN_HASH]
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
console.log('config.json atualizado')
"

echo
echo "== 5/5  Reiniciando e conferindo =="
( cd "$PROXY" && docker compose restart "$CONTAINER" >/dev/null 2>&1 )
healthy=""
for _ in $(seq 1 20); do
  sleep 3
  if [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER")" = "healthy" ]; then
    healthy="yes"
    break
  fi
done
if [ -z "$healthy" ]; then
  echo "O servidor não ficou saudável. Voltando o config.json anterior." >&2
  sudo cp -p "$BACKUP" "$CONFIG"
  ( cd "$PROXY" && docker compose restart "$CONTAINER" >/dev/null 2>&1 )
  die "Revertido. Veja: docker compose logs --tail 30 $CONTAINER"
fi
echo "Servidor saudável."

if [ -n "$ADMIN_KEY" ]; then
  echo
  echo "Tenants agora no banco (a chave pública NÃO deve ter mudado):"
  curl -s -m 10 "https://id.empregoaqui.com.br:8443/admin/v1/tenants" -H "Authorization: Bearer $ADMIN_KEY" |
    docker run --rm -i "$IMAGE" node -e "
let t='';process.stdin.on('data',d=>t+=d).on('end',()=>{try{for(const x of JSON.parse(t).tenants)console.log(' ',x.id,x.source,x.publicKey)}catch(e){console.log('  (não consegui ler a resposta)')}})"
  echo
  echo "CHAVE DE OPERADOR (aparece só agora; guarde no gerenciador de senhas):"
  echo "  $ADMIN_KEY"
  echo
  read -r -p "Gravar também no .env deste projeto como FP_ADM_KEY? [s/N]: " save
  if [ "$save" = "s" ] || [ "$save" = "S" ]; then
    printf '\nFP_ADM_KEY=%s\n' "$ADMIN_KEY" >> "$(cd "$(dirname "$0")" && pwd)/.env"
    chmod 600 "$(cd "$(dirname "$0")" && pwd)/.env"
    echo "Gravado em .env (opção 8 do help.sh mostra a chave e o endereço)."
  fi
fi

echo
echo "Pronto. Painel de configuração: https://id.empregoaqui.com.br:8443/dashboard/config"
echo "Cópia do arquivo antigo (tem os hashes das chaves dos tenants; apague quando não precisar): $BACKUP"
