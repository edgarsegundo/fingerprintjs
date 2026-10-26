#!/bin/bash
# Helper menu for operating the fingerprint server on the VPS: shell into the database, statistics about the visits,
# reachability (who could not reach the server), health and logs. Reads MYSQL_USERPASS from .env next to this script.
#
# The statistics are plain SQL on the tables of the server (events, identity_resolutions). The risk score and the
# tamper evidence are computed when a visit is read, so they are not in the database: use the dashboard for those.

cd "$(dirname "$0")" || exit 1

DB_USER="fp"
DB_NAME="fingerprint"
PROXY="$HOME/Repos/reverse-proxy-config"
UTC_OFFSET_SECONDS=-10800 # hours shown in Brasília time

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

# Runs the SQL on stdin in the MySQL container, as the fp user, printed as a table. The password goes through
# MYSQL_PWD so it does not show up in the process list.
mysql_run() {
  load_env || return 1
  local pass="${MYSQL_USERPASS//\"/}" # remove aspas, se houver
  if [ -z "$pass" ]; then
    echo "Erro: MYSQL_USERPASS está vazio no .env."
    return 1
  fi
  { echo "SET time_zone = '+00:00';"; cat; } |
    docker exec -i -e MYSQL_PWD="$pass" mysql mysql -u"$DB_USER" -t --default-character-set=utf8mb4 "$DB_NAME"
}

# ---- Statistics -------------------------------------------------------------------------------------------------

# The tenant (the site) and the window the statistics look at. Both are validated because they go into SQL.
ask_scope() {
  read -r -p "Tenant [${T:-pwa}]: " answer
  T="${answer:-${T:-pwa}}"
  if ! [[ "$T" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "Tenant inválido."
    T=""
    return 1
  fi
  read -r -p "Últimos quantos dias [${D:-30}]: " answer
  D="${answer:-${D:-30}}"
  if ! [[ "$D" =~ ^[0-9]{1,4}$ ]] || [ "$D" -lt 1 ]; then
    echo "Número de dias inválido."
    D=""
    return 1
  fi
}

# Pieces shared by the queries. `r` is the identity decision of the visit (it can be missing for an old visit).
set_pieces() {
  BRT="FROM_UNIXTIME(FLOOR(e.received_at / 1000) + ($UTC_OFFSET_SECONDS))"
  FROM_VISITS="events e LEFT JOIN identity_resolutions r ON r.tenant_id = e.tenant_id AND r.request_id = e.request_id"
  WHERE_WINDOW="e.tenant_id = '$T' AND e.received_at >= UNIX_TIMESTAMP() * 1000 - $D * 86400000"
  UA="JSON_UNQUOTE(JSON_EXTRACT(e.network_json, '\$.headers.values.\"user-agent\"'))"
  BROWSER="CASE
    WHEN $UA IS NULL THEN 'sem user-agent'
    WHEN $UA LIKE '%Instagram%' THEN 'Instagram (app)'
    WHEN $UA LIKE '%FBAN%' OR $UA LIKE '%FBAV%' THEN 'Facebook (app)'
    WHEN $UA LIKE '%SamsungBrowser%' THEN 'Samsung Internet'
    WHEN $UA LIKE '%Edg/%' OR $UA LIKE '%EdgA/%' THEN 'Edge'
    WHEN $UA LIKE '%OPR/%' THEN 'Opera'
    WHEN $UA LIKE '%Firefox/%' OR $UA LIKE '%FxiOS%' THEN 'Firefox'
    WHEN $UA LIKE '%CriOS%' THEN 'Chrome (iOS)'
    WHEN $UA LIKE '%Chrome/%' THEN 'Chrome ou Brave'
    WHEN $UA LIKE '%Safari/%' THEN 'Safari'
    ELSE 'outro' END"
  SYSTEM="CASE
    WHEN $UA IS NULL THEN 'sem user-agent'
    WHEN $UA LIKE '%Android%' THEN 'Android'
    WHEN $UA LIKE '%iPhone%' OR $UA LIKE '%iPad%' THEN 'iOS'
    WHEN $UA LIKE '%Windows%' THEN 'Windows'
    WHEN $UA LIKE '%Macintosh%' THEN 'macOS'
    WHEN $UA LIKE '%CrOS%' THEN 'ChromeOS'
    WHEN $UA LIKE '%Linux%' THEN 'Linux'
    ELSE 'outro' END"
}

stats_summary() {
  mysql_run <<SQL
SELECT COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       COUNT(DISTINCT e.linked_id) AS contas,
       SUM(e.linked_id IS NULL) AS visitas_sem_conta,
       $BRT_MIN AS primeira_visita,
       $BRT_MAX AS ultima_visita
FROM $FROM_VISITS WHERE $WHERE_WINDOW;
SQL
}

stats_per_day() {
  mysql_run <<SQL
SELECT DATE($BRT) AS dia,
       COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       SUM(e.linked_id IS NOT NULL) AS com_conta,
       SUM(JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched')) = 'false') AS aparelhos_novos
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY dia ORDER BY dia DESC LIMIT 60;
SQL
}

stats_per_hour() {
  mysql_run <<SQL
SELECT LPAD(HOUR($BRT), 2, '0') AS hora,
       COUNT(*) AS visitas,
       REPEAT('#', ROUND(40 * COUNT(*) / MAX(COUNT(*)) OVER ())) AS grafico
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY hora ORDER BY hora;
SQL
}

stats_recognition() {
  echo "== Cada visita: aparelho já conhecido ou novo =="
  mysql_run <<SQL
SELECT CASE JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched'))
         WHEN 'true' THEN 'reconhecida (aparelho já conhecido)'
         WHEN 'false' THEN 'aparelho novo'
         ELSE 'sem decisão' END AS situacao,
       COUNT(*) AS visitas,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY situacao ORDER BY visitas DESC;
SQL
  echo
  echo "== Qualidade da decisão =="
  mysql_run <<SQL
SELECT SUM(JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.ambiguous')) = 'true') AS ambiguas,
       SUM(JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.learned')) = 'false') AS nao_ensinaram_o_motor,
       ROUND(AVG(JSON_EXTRACT(r.resolution_json, '\$.candidates')), 1) AS candidatos_comparados_em_media,
       COUNT(*) AS visitas
FROM $FROM_VISITS WHERE $WHERE_WINDOW;
SQL
  echo
  echo "ambiguas: outro aparelho chegou quase tão perto; nao_ensinaram_o_motor: navegadores de privacidade ou com"
  echo "adulteração alta, que não alteram o perfil de nenhum aparelho. O motor ainda não está calibrado: não há"
  echo "probabilidade confiável, só a decisão."
}

stats_guest_vs_account() {
  mysql_run <<SQL
SELECT IF(e.linked_id IS NULL, 'sem conta (visitante)', 'com conta') AS tipo,
       COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY tipo;
SQL
}

stats_accounts_per_device() {
  echo "Quantos aparelhos têm 1, 2, 3... contas diferentes (o que decide a regra de abuso)."
  mysql_run <<SQL
SELECT contas, COUNT(*) AS aparelhos FROM (
  SELECT r.device_id, COUNT(DISTINCT e.linked_id) AS contas
  FROM $FROM_VISITS WHERE $WHERE_WINDOW AND e.linked_id IS NOT NULL AND r.device_id IS NOT NULL
  GROUP BY r.device_id
) por_aparelho
GROUP BY contas ORDER BY contas;
SQL
}

stats_devices_many_accounts() {
  echo "Aparelhos com 3 ou mais contas. Olhe o caso antes de concluir: família, lan house e aparelhos iguais são legítimos."
  mysql_run <<SQL
SELECT r.device_id AS aparelho,
       COUNT(DISTINCT e.linked_id) AS contas,
       COUNT(*) AS visitas,
       MIN($BRT) AS primeira,
       MAX($BRT) AS ultima
FROM $FROM_VISITS WHERE $WHERE_WINDOW AND e.linked_id IS NOT NULL AND r.device_id IS NOT NULL
GROUP BY r.device_id HAVING contas >= 3 ORDER BY contas DESC, visitas DESC LIMIT 30;
SQL
}

stats_devices_per_account() {
  echo "Contas vistas em mais de um aparelho (normal: celular e computador; navegadores que embaralham sinais também)."
  mysql_run <<SQL
SELECT e.linked_id AS conta,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       COUNT(*) AS visitas,
       MAX($BRT) AS ultima
FROM $FROM_VISITS WHERE $WHERE_WINDOW AND e.linked_id IS NOT NULL AND r.device_id IS NOT NULL
GROUP BY e.linked_id HAVING aparelhos > 1 ORDER BY aparelhos DESC, visitas DESC LIMIT 30;
SQL
}

stats_top_devices() {
  mysql_run <<SQL
SELECT r.device_id AS aparelho,
       COUNT(*) AS visitas,
       COUNT(DISTINCT e.linked_id) AS contas,
       COUNT(DISTINCT e.ip) AS enderecos,
       MIN($BRT) AS primeira,
       MAX($BRT) AS ultima
FROM $FROM_VISITS WHERE $WHERE_WINDOW AND r.device_id IS NOT NULL
GROUP BY r.device_id ORDER BY visitas DESC LIMIT 20;
SQL
}

stats_top_addresses() {
  echo "Endereços (IP) com mais visitas. Muitos aparelhos num endereço só costuma ser rede compartilhada (operadora, empresa)."
  echo "Se o tenant guarda o IP como hash (privacy.ipStorage), o endereço aparece como um código."
  mysql_run <<SQL
SELECT e.ip AS endereco,
       COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       COUNT(DISTINCT e.linked_id) AS contas,
       MAX($BRT) AS ultima
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY e.ip ORDER BY visitas DESC LIMIT 20;
SQL
}

stats_browsers() {
  echo "== Navegador (pelo User-Agent; o Brave se declara como Chrome) =="
  mysql_run <<SQL
SELECT $BROWSER AS navegador,
       COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY navegador ORDER BY visitas DESC;
SQL
  echo
  echo "== Sistema =="
  mysql_run <<SQL
SELECT $SYSTEM AS sistema,
       COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY sistema ORDER BY visitas DESC;
SQL
  echo
  echo "== Navegador x aparelho novo (quem embaralha sinais tende a virar aparelho novo a cada visita) =="
  mysql_run <<SQL
SELECT $BROWSER AS navegador,
       COUNT(*) AS visitas,
       SUM(JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched')) = 'false') AS aparelhos_novos,
       ROUND(100 * SUM(JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched')) = 'false') / COUNT(*), 1) AS pct_novos
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY navegador ORDER BY visitas DESC;
SQL
}

# One characteristic of the device read from the payload: the ten most common values and how many devices have each.
stat_component() {
  local title="$1" path="$2"
  echo "== $title =="
  mysql_run <<SQL
SELECT JSON_EXTRACT(e.payload_json, '$path') AS valor,
       COUNT(*) AS visitas,
       COUNT(DISTINCT r.device_id) AS aparelhos,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY valor ORDER BY visitas DESC LIMIT 10;
SQL
  echo
}

stats_characteristics() {
  echo "(esta é a consulta mais pesada: lê o conteúdo de cada visita da janela)"
  echo
  stat_component "Idioma principal" '$.components.languages.value[0][0]'
  stat_component "Fuso horário" '$.components.timezone.value'
  stat_component "Plataforma" '$.components.platform.value'
  stat_component "Resolução da tela" '$.components.screenResolution.value'
  stat_component "Núcleos de processador" '$.components.hardwareConcurrency.value'
  stat_component "Memória (GB, só alguns navegadores informam)" '$.components.deviceMemory.value'
}

stats_network() {
  echo "== Impressão TLS (JA4): a conexão em si; vem do servidor, não do navegador =="
  mysql_run <<SQL
SELECT COALESCE(e.ja4, '-') AS ja4, COUNT(*) AS visitas, COUNT(DISTINCT r.device_id) AS aparelhos
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY ja4 ORDER BY visitas DESC LIMIT 10;
SQL
  echo
  echo "== HTTP, TLS e proxy =="
  mysql_run <<SQL
SELECT JSON_UNQUOTE(JSON_EXTRACT(e.network_json, '\$.httpVersion')) AS http,
       JSON_UNQUOTE(JSON_EXTRACT(e.network_json, '\$.viaProxy')) AS via_proxy,
       COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.network_json, '\$.tlsStatus')), 'ok') AS tls,
       COUNT(*) AS visitas
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY http, via_proxy, tls ORDER BY visitas DESC;
SQL
  echo
  echo "== Listas de endereço (datacenter, Tor...; só existem se você configurou ipLists) e país =="
  mysql_run <<SQL
SELECT IF(JSON_LENGTH(JSON_EXTRACT(e.network_json, '\$.ipIntel.tags')) = 0, 'nenhuma',
          CAST(JSON_EXTRACT(e.network_json, '\$.ipIntel.tags') AS CHAR)) AS listas,
       COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.network_json, '\$.ipIntel.country')), '-') AS pais,
       COUNT(*) AS visitas
FROM $FROM_VISITS WHERE $WHERE_WINDOW
GROUP BY listas, pais ORDER BY visitas DESC LIMIT 15;
SQL
}

stats_device_history() {
  read -r -p "Código do aparelho (ex.: v_AbC...): " device
  if ! [[ "$device" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "Código inválido."
    return
  fi
  mysql_run <<SQL
SELECT $BRT AS quando, e.linked_id AS conta, e.ip AS endereco, $BROWSER AS navegador,
       JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched')) AS reconhecido
FROM $FROM_VISITS WHERE e.tenant_id = '$T' AND r.device_id = '$device'
ORDER BY e.received_at DESC LIMIT 50;
SQL
}

stats_account_history() {
  read -r -p "Id da conta (linkedId): " account
  if ! [[ "$account" =~ ^[A-Za-z0-9_.:-]{1,128}$ ]]; then
    echo "Id inválido."
    return
  fi
  mysql_run <<SQL
SELECT $BRT AS quando, r.device_id AS aparelho, e.ip AS endereco, $BROWSER AS navegador,
       JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched')) AS reconhecido
FROM $FROM_VISITS WHERE e.tenant_id = '$T' AND e.linked_id = '$account'
ORDER BY e.received_at DESC LIMIT 50;
SQL
}

stats_menu() {
  T="${T:-pwa}"
  D="${D:-30}"
  ask_scope || return
  while true; do
    set_pieces
    BRT_MIN="MIN($BRT)"
    BRT_MAX="MAX($BRT)"
    echo ""
    echo "==== Estatísticas: tenant '$T', últimos $D dias (horas de Brasília) ===="
    echo " 1) Resumo geral"
    echo " 2) Visitas por dia"
    echo " 3) Visitas por hora do dia"
    echo " 4) Reconhecimento: aparelhos novos x já conhecidos"
    echo " 5) Visitantes sem conta x com conta"
    echo " 6) Quantas contas por aparelho"
    echo " 7) Aparelhos com 3 ou mais contas"
    echo " 8) Contas vistas em mais de um aparelho"
    echo " 9) Aparelhos que mais voltam"
    echo "10) Endereços (IP): visitas, aparelhos e contas"
    echo "11) Navegadores e sistemas"
    echo "12) Características: idioma, fuso, tela, processador, memória"
    echo "13) Rede: JA4, HTTP, TLS, listas de IP e país"
    echo "14) Histórico de um aparelho"
    echo "15) Histórico de uma conta"
    echo " t) Trocar tenant ou período"
    echo " v) Voltar"
    read -r -p "Escolha: " stat_opt
    echo "..."
    case $stat_opt in
      1) stats_summary ;;
      2) stats_per_day ;;
      3) stats_per_hour ;;
      4) stats_recognition ;;
      5) stats_guest_vs_account ;;
      6) stats_accounts_per_device ;;
      7) stats_devices_many_accounts ;;
      8) stats_devices_per_account ;;
      9) stats_top_devices ;;
      10) stats_top_addresses ;;
      11) stats_browsers ;;
      12) stats_characteristics ;;
      13) stats_network ;;
      14) stats_device_history ;;
      15) stats_account_history ;;
      t|T) ask_scope ;;
      v|V) return ;;
      *) echo "Opção inválida." ;;
    esac
  done
}

# ---- Visits, reachability, health, logs -------------------------------------------------------------------------

recent_visits() {
  T="${T:-pwa}"
  D="${D:-30}"
  read -r -p "Tenant [$T]: " answer
  T="${answer:-$T}"
  if ! [[ "$T" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "Tenant inválido."
    return
  fi
  set_pieces
  mysql_run <<SQL
SELECT $BRT AS quando, r.device_id AS aparelho, e.linked_id AS conta, e.ip AS endereco, $BROWSER AS navegador,
       CASE JSON_UNQUOTE(JSON_EXTRACT(r.resolution_json, '\$.matched'))
         WHEN 'true' THEN 'conhecido' WHEN 'false' THEN 'NOVO' ELSE '-' END AS situacao
FROM $FROM_VISITS WHERE e.tenant_id = '$T'
ORDER BY e.received_at DESC LIMIT 25;
SQL
}

reachability() {
  if ! docker ps --format '{{.Names}}' | grep -qx fp-report; then
    echo "O container fp-report não está em execução (Parte H do guia de instalação)."
    return
  fi
  read -r -p "Últimos quantos dias [30]: " days
  days="${days:-30}"
  if ! [[ "$days" =~ ^[0-9]{1,4}$ ]]; then
    echo "Número de dias inválido."
    return
  fi
  docker exec fp-report node dist/cli.js reachability-summary --db /data/reach.db --days "$days" 2> /dev/null
  echo
  echo "Para a fração de visitantes afetados: avisos 'script_unreachable' ÷ visitas do mesmo período (estatística 1)."
}

health() {
  echo "== Containers =="
  for c in fingerprint fp-report mysql nginx; do
    if docker ps --format '{{.Names}}' | grep -qx "$c"; then
      printf '%-12s %s  (saúde: %s)\n' "$c" "$(docker inspect --format '{{.State.Status}} desde {{.State.StartedAt}}' "$c")" \
        "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem healthcheck{{end}}' "$c")"
    else
      printf '%-12s NÃO está em execução\n' "$c"
    fi
  done
  echo
  echo "== Servidor responde? =="
  curl -s -m 5 https://id.empregoaqui.com.br:8443/readyz || echo "sem resposta"
  echo
  echo
  echo "== Certificado =="
  echo | openssl s_client -connect id.empregoaqui.com.br:8443 -servername id.empregoaqui.com.br 2> /dev/null |
    openssl x509 -noout -subject -enddate 2> /dev/null || echo "não consegui ler"
  echo
  echo "== Disco =="
  df -h / | tail -1
  echo
  echo "== Tamanho das tabelas do banco (MB) =="
  mysql_run <<SQL
SELECT table_name AS tabela, table_rows AS linhas_aprox, ROUND((data_length + index_length) / 1024 / 1024, 1) AS mb
FROM information_schema.tables WHERE table_schema = '$DB_NAME' ORDER BY (data_length + index_length) DESC LIMIT 10;
SQL
  echo
  echo "== Visitas por tenant (todas as datas) =="
  mysql_run <<SQL
SELECT tenant_id AS tenant, COUNT(*) AS visitas,
       FROM_UNIXTIME(FLOOR(MIN(received_at) / 1000) + ($UTC_OFFSET_SECONDS)) AS primeira,
       FROM_UNIXTIME(FLOOR(MAX(received_at) / 1000) + ($UTC_OFFSET_SECONDS)) AS ultima
FROM events GROUP BY tenant_id;
SQL
}

logs() {
  echo "1) fingerprint, últimas 100 linhas"
  echo "2) fingerprint, só erros"
  echo "3) fingerprint, acompanhar (Ctrl+C para sair)"
  echo "4) fp-report, últimas 100 linhas"
  read -r -p "Escolha: " log_opt
  case $log_opt in
    1) docker logs --tail 100 fingerprint ;;
    2) docker logs --tail 1000 fingerprint 2>&1 | grep -iE "error|warn|refus|forbidden|unauthor|\"status\":(4|5)" | tail -50 ;;
    3) docker logs -f --tail 20 fingerprint ;;
    4) docker logs --tail 100 fp-report ;;
    *) echo "Opção inválida." ;;
  esac
}

# Lets the statistics be tried without the menu (tests source this file).
if [ "${HELP_SOURCE_ONLY:-}" = 1 ]; then
  return 0 2> /dev/null || exit 0
fi

while true; do
  echo ""
  echo "==== Main Menu ===="
  echo "1) Entrar no MySQL (banco $DB_NAME, usuário $DB_USER)"
  echo "2) Estatísticas das visitas (aparelhos, contas, navegadores, rede...)"
  echo "3) Últimas visitas"
  echo "4) Quem não alcançou o servidor (porta bloqueada, bloqueadores)"
  echo "5) Saúde: containers, certificado, disco, tamanho do banco"
  echo "6) Logs do servidor"
  echo "q) Sair"
  read -r -p "Choose an option: " opt
  echo "..."
  case $opt in
    1)
      if load_env; then
        DB_PASSWORD="${MYSQL_USERPASS//\"/}" # remove aspas, se houver
        if [ -z "$DB_PASSWORD" ]; then
          echo "Erro: MYSQL_USERPASS está vazio no .env."
        else
          echo "Conectando ao MySQL no Docker..."
          docker exec -it -e MYSQL_PWD="$DB_PASSWORD" mysql mysql -u"$DB_USER" "$DB_NAME"
        fi
      fi
      ;;
    2) stats_menu ;;
    3) recent_visits ;;
    4) reachability ;;
    5) health ;;
    6) logs ;;
    q|Q) exit 0 ;;
    *) echo "Invalid option." ;;
  esac
done
