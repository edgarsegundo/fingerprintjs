#!/bin/bash
# Helper menu for operating the fingerprint server on the VPS. Reads MYSQL_USERPASS from .env next to this script.

cd "$(dirname "$0")" || exit 1

DB_USER="fp"
DB_NAME="fingerprint"

# Loads KEY=VALUE lines from .env into the environment (no shell evaluation of the values).
load_env() {
  if [ ! -f .env ]; then
    echo "Erro: .env não encontrado em $(pwd). Crie com: MYSQL_USERPASS=sua-senha"
    return 1
  fi
  while IFS='=' read -r key value; do
    if [[ $key && $key != \#* ]]; then
      export "$key=$value"
    fi
  done < .env
}

while true; do
  echo ""
  echo "==== Main Menu ===="
  echo "1) Entrar no MySQL (banco $DB_NAME, usuário $DB_USER)"
  echo "q) Sair"
  read -p "Choose an option: " opt
  echo "..."
  case $opt in
    1)
      if load_env; then
        DB_PASSWORD="${MYSQL_USERPASS//\"/}"  # remove aspas, se houver
        if [ -z "$DB_PASSWORD" ]; then
          echo "Erro: MYSQL_USERPASS está vazio no .env."
        else
          echo "Conectando ao MySQL no Docker..."
          # The password goes through MYSQL_PWD so it does not show up in the process list.
          docker exec -it -e MYSQL_PWD="$DB_PASSWORD" mysql mysql -u"$DB_USER" "$DB_NAME"
        fi
      fi
      ;;
    q|Q)
      exit 0
      ;;
    *)
      echo "Invalid option."
      ;;
  esac
done
