# Instalar na VPS, passo a passo: `id.empregoaqui.com.br`, Docker, TLS direto, MySQL, certificado Let's Encrypt, coletor no PWA e fase de observação

Palavras-chave: instalação em produção, VPS, Docker Compose, subdomínio `id.empregoaqui.com.br` (first-party do PWA `app.empregoaqui.com.br`), porta 8443, TLS direto (opção A), JA4, Let's Encrypt, certbot, MySQL dedicado, `FP_MYSQL_PASSWORD`, coletor no PWA, carregador, aviso de falha (porta 8443 bloqueada), fase de observação, só registrar, contas por aparelho, LGPD, rollback.

Escrito em 2026-10-19 e atualizado no mesmo dia para o domínio do PWA (`id.empregoaqui.com.br`) e para o medidor de quem não alcança o servidor (Parte H). O objetivo é o caminho realista: **subir um servidor de teste, colocar o coletor no PWA só registrando (sem decidir nada), observar por algumas semanas quantas contas aparecem por aparelho e só então escolher a regra com número na mão.**

> **Aviso importante.** Eu li o `docker-compose.yml`, o `app.empregoaqui.com.br.conf`, o `create_ssl.sh` e o `renew_all.sh` do seu `reverse-proxy-config`, mas **nada aqui foi executado na sua VPS**. Os comandos abaixo são os que eu usaria, e cada etapa tem uma verificação ("você deve ver"). Se uma verificação falhar, pare ali e me mostre a saída. Não pule etapas.

---

## 0. Resumo das decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Endereço | **`id.empregoaqui.com.br`** (subdomínio do domínio do PWA), porta **8443** | É do mesmo site do PWA (`app.empregoaqui.com.br`), então é first-party: bloqueadores e navegadores de privacidade tratam melhor que um domínio à parte. Um subdomínio novo não toca em nenhum site existente. |
| Como entra o tráfego | O servidor **termina o TLS ele mesmo** (opção A do `server/README.md`) | Só assim ele vê o JA4 e a ordem dos cabeçalhos do visitante. Atrás do nginx, esses sinais descreveriam o nginx. |
| Banco | **MySQL já existente na VPS, em um banco e usuário novos** | Você já opera esse MySQL. Veja `mysql-ou-sqlite-decisao-e-cuidados-em-producao-...md`. |
| Certificado | Let's Encrypt, **um certificado só para `id.empregoaqui.com.br`** | O servidor carrega um certificado e o renova sem reiniciar. |
| Papel no PWA | **Só registrar.** Nenhuma decisão, nenhum bloqueio | Você ainda não sabe quantas contas por aparelho é normal. |
| Quem não alcança a 8443 | **Medir** com o carregador e o receptor de avisos (Parte H) | Algumas redes só liberam a porta 443. Antes de pensar em mudar de porta, saiba quantos visitantes caem nisso. A mudança para a 443 fica documentada à parte (`usar-a-porta-443-para-o-fingerprint-...md`) e **não é recomendada agora**. |
| Código guardado (`storedId`) | **Desligado** | É um identificador gravado no aparelho. Precisa do parecer jurídico antes. |
| Regras de decisão | **Lista vazia** | Sem regra, o servidor só registra. |

## 1. O que **não** vai mudar

- **O nginx e a porta 443 ficam como estão.** Nenhum site existente é reconfigurado.
- O `docker-compose.yml` da proxy ganha **dois serviços novos** (`fingerprint` e, na Parte H, `fp-report`). Nada existente é alterado.
- **Duas adições ao nginx, ambas suas** (a regra do seu `CLAUDE.md` é que eu não mexo nele): um arquivo pequeno `sites/id.empregoaqui.com.br.conf` só para o certificado (Parte D, caminho A; o caminho B não toca no nginx) e um bloco `location = /fp-report` dentro do `sites/app.empregoaqui.com.br.conf` (Parte H). A Parte H é opcional.
- O `renew_all.sh` **não é alterado**: ele já renova todos os certificados da pasta `letsencrypt/live`, inclusive o novo.

## 2. Mapa das peças

```
Visitante (navegador do PWA, app.empregoaqui.com.br)
   │  1) carrega o carregador (fp-loader.min.js), que vem do próprio PWA, porta 443
   │  2) o carregador busca o coletor e manda os sinais por
   │     HTTPS direto: https://id.empregoaqui.com.br:8443   (TLS terminado pelo servidor, sem nginx)
   ▼
[container fingerprint]  porta 8443   ── MySQL (container "mysql", banco "fingerprint")
   │
   └─ guarda visitas, decide "mesmo aparelho ou novo", registra risco

   Se a rede do visitante bloqueia a 8443, o carregador avisa o PWA (porta 443):
   app.empregoaqui.com.br/fp-report ──nginx──► [container fp-report] ── arquivo SQLite com os avisos (Parte H)

nginx (443) ── PWA, API e os outros sites   ← não muda de lugar
certbot + renew_all.sh                ← renova o certificado de id.empregoaqui.com.br junto com os outros
```

## 3. Antes de começar

Tenha em mãos:

- [ ] Acesso SSH à VPS e permissão para rodar `docker` e `sudo`.
- [ ] O **endereço (origin) do seu PWA**: `https://app.empregoaqui.com.br`. É o que o servidor vai aceitar nas chamadas (`allowedOrigins`).
- [ ] O **IP público da VPS**.
- [ ] A porta **8443** livre na VPS (confira no passo 5).
- [ ] O código deste projeto **commitado e enviado ao GitHub** (veja o próximo item).

> **O código novo está sem commit.** Todo o trabalho desta sessão está no branch `v5.3.0-fork` como alterações não commitadas. Eu não commito (regra 7 do `CLAUDE.md`). Antes de instalar na VPS, **você** precisa fazer `git add`, `git commit` e `git push` do branch. Na VPS você vai clonar esse branch.

Variáveis que vou usar nos comandos (ajuste os caminhos e exporte na VPS):

```bash
export PROXY=/caminho/da/pasta/do/docker-compose.yml     # a pasta do repositório reverse-proxy-config na VPS
export FP_REPO=/caminho/onde/vai/ficar/o/fingerprintjs   # onde você vai clonar este projeto na VPS
export DOMINIO=id.empregoaqui.com.br
```

---

## Parte A: preparar o código na VPS

### A1. Clonar o projeto (na VPS)

```bash
git clone --branch v5.3.0-fork <URL-DO-SEU-REPOSITORIO> "$FP_REPO"
cd "$FP_REPO"
git log --oneline -3
```

**Você deve ver:** o seu último commit no topo. Para atualizar depois: `git pull` dentro de `$FP_REPO`.

### A2. Construir a imagem do servidor (na VPS)

```bash
cd "$FP_REPO"
docker build -f server/Dockerfile -t fingerprint-server:latest .
```

Leva alguns minutos. **Você deve ver:** `Successfully tagged fingerprint-server:latest`.

Confirme que a imagem roda:

```bash
docker run --rm fingerprint-server:latest node dist/cli.js nonce-secret
```

**Você deve ver:** uma linha longa de letras e números (é um segredo aleatório; é só um teste, não use este).

### A3. Gerar os scripts do navegador (o coletor e o carregador)

São dois arquivos JavaScript. O `fp.min.js` é o coletor e quem o serve é o servidor de fingerprint. O `fp-loader.min.js` é o carregador (cerca de 6 KB), que vai junto com os arquivos do PWA e avisa quando o coletor não é alcançado (Parte H). Gere os dois de uma vez, em um container temporário:

```bash
cd "$FP_REPO"
docker run --rm -v "$FP_REPO":/w -w /w node:22 sh -c \
  "npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --ignore-engines && npx --yes yarn@1.22.22 build"
ls -l dist/fp.min.js dist/fp-loader.min.js
```

**Você deve ver:** `dist/fp.min.js` (algumas dezenas de KB) e `dist/fp-loader.min.js` (cerca de 6 KB).

---

## Parte B: DNS, firewall e porta

### B1. DNS

No painel onde está o DNS de `empregoaqui.com.br`, crie:

| Tipo | Nome | Valor |
|---|---|---|
| **A** | `id` | o IP público da VPS |

- Crie **só o registro A**. Não crie `AAAA` (IPv6): o Docker só publica a porta em IPv4 por padrão, e um `AAAA` faria parte dos visitantes tentar IPv6 e falhar.
- Os registros que já existem em `empregoaqui.com.br` (o `app`, o `admin`, o próprio domínio) **não mudam**.
- Se o domínio tiver um registro curinga (`*`), o `id` vence o curinga, então não há conflito.

Aguarde propagar e confirme (de qualquer máquina):

```bash
dig +short id.empregoaqui.com.br
```

**Você deve ver:** o IP da VPS. Se vier vazio, espere uns minutos e repita.

### B2. Porta 8443 livre e aberta

Na VPS:

```bash
sudo ss -ltnp | grep ':8443' || echo "8443 livre"
```

**Você deve ver:** `8443 livre`. Se aparecer um programa, escolha outra porta (e troque o `8443` em todo o documento).

Abra a porta no firewall da VPS **e** no firewall do provedor (painel da nuvem), se existir:

```bash
# se usar ufw:
sudo ufw allow 8443/tcp
sudo ufw status
```

> O Docker publica portas passando por cima do `ufw`: uma porta publicada (`"8443:8443"`) fica aberta mesmo que o `ufw` não a libere. Se você quer restringir quem acessa, use o firewall do provedor ou regras na cadeia `DOCKER-USER`. Aqui a porta precisa ficar aberta ao público, então a regra do `ufw` é só para manter o seu registro em ordem.

---

## Parte C: banco de dados

Use um banco e um usuário **só deste projeto** (veja `mysql-ou-sqlite-decisao-e-cuidados-em-producao-...md`).

### C1. Criar o banco e o usuário (na VPS)

```bash
cd "$PROXY"
docker compose exec mysql mysql -uroot -p
```

Digite a senha de root do MySQL (a `DB_ROOT_PASSWORD` do seu `.env`). No prompt do MySQL, rode (troque a senha por uma longa e **só sua**):

```sql
CREATE DATABASE fingerprint CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'fp'@'%' IDENTIFIED BY 'TROQUE-POR-UMA-SENHA-LONGA';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON fingerprint.* TO 'fp'@'%';
FLUSH PRIVILEGES;
EXIT;
```

- O `'%'` aqui permite a conexão vinda do container na rede do Docker. O MySQL só escuta em `127.0.0.1` fora do Docker, então não fica exposto à internet.
- Anote a senha: ela vai para o arquivo `.env` na seção E2.

### C2. Conferir

```bash
docker compose exec mysql mysql -ufp -p -e "SHOW DATABASES;"
```

**Você deve ver:** `fingerprint` na lista (e `information_schema`).

---

## Parte D: certificado do `id.empregoaqui.com.br`

O servidor precisa de um certificado Let's Encrypt **para `id.empregoaqui.com.br`**. Há dois caminhos.

### Caminho A (recomendado): validação por HTTP, com um arquivo novo no nginx

**Vantagem:** a renovação passa a ser automática, pelo seu `renew_all.sh`. **Custo:** você adiciona **um arquivo pequeno** em `sites/`.

**D1. Criar o arquivo** `"$PROXY"/sites/id.empregoaqui.com.br.conf` com:

```nginx
# Só para o Let's Encrypt validar id.empregoaqui.com.br. O tráfego do servidor de fingerprint vai direto na porta 8443.
server {
    listen 80;
    listen [::]:80;
    server_name id.empregoaqui.com.br;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri =404;
    }

    location / {
        return 404;
    }
}
```

**D2. Testar e recarregar o nginx:**

```bash
cd "$PROXY"
docker exec -it nginx nginx -t
docker compose exec nginx nginx -s reload
```

**Você deve ver:** `syntax is ok` e `test is successful`. Se o teste falhar, **apague o arquivo novo** e me mostre o erro.

**D3. Emitir o certificado** (é o mesmo comando que o seu `create_ssl.sh` usa):

```bash
cd "$PROXY"
docker run -it --rm \
  -v "$(pwd)/certbot-challenges:/var/www/certbot" \
  -v "$(pwd)/letsencrypt:/etc/letsencrypt" \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  --config-dir /etc/letsencrypt \
  --work-dir /etc/letsencrypt/work \
  --logs-dir /etc/letsencrypt/logs \
  -d id.empregoaqui.com.br
```

Responda e-mail e aceite os termos. **Você deve ver:** `Successfully received certificate` e os caminhos em `letsencrypt/live/id.empregoaqui.com.br/`.

### Caminho B: validação por DNS, sem tocar no nginx

**Vantagem:** nenhum arquivo novo no nginx. **Custo:** a renovação **não** é automática (você refaz a cada ~60 dias), a não ser que use um plugin de DNS do seu provedor.

```bash
cd "$PROXY"
docker run -it --rm \
  -v "$(pwd)/letsencrypt:/etc/letsencrypt" \
  certbot/certbot certonly --manual --preferred-challenges dns \
  --config-dir /etc/letsencrypt --work-dir /etc/letsencrypt/work --logs-dir /etc/letsencrypt/logs \
  -d id.empregoaqui.com.br
```

O certbot mostra um registro `TXT` (`_acme-challenge.id`) para você criar no DNS. Crie, espere propagar e aperte Enter. **Anote no calendário** a data de expiração.

### D4. Conferir o certificado (nos dois caminhos)

```bash
sudo ls -l "$PROXY"/letsencrypt/live/id.empregoaqui.com.br/
```

**Você deve ver:** `fullchain.pem` e `privkey.pem`.

---

## Parte E: configurar e subir o servidor

### E1. A pasta de configuração e a cópia do certificado

O contêiner roda como o usuário `node` (uid 1000), e a chave do Let's Encrypt só é legível por root. Por isso o certificado é **copiado** para uma pasta própria, com o dono certo. Crie a pasta e o script de cópia:

```bash
sudo mkdir -p "$PROXY"/fingerprint/config
sudo tee "$PROXY"/fingerprint/sync-cert.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
# Copia o certificado de id.empregoaqui.com.br para a pasta do servidor de fingerprint, só se mudou.
set -euo pipefail
PROXY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PROXY_DIR/letsencrypt/live/id.empregoaqui.com.br"
DST="$PROXY_DIR/fingerprint/config"
changed=0
for pair in "fullchain.pem:cert.pem" "privkey.pem:key.pem"; do
  from="$SRC/${pair%%:*}"; to="$DST/${pair##*:}"
  if ! cmp -s "$from" "$to" 2>/dev/null; then
    cp -L "$from" "$to.new"
    chown 1000:1000 "$to.new"
    chmod 600 "$to.new"
    mv "$to.new" "$to"
    changed=1
  fi
done
[ "$changed" = 1 ] && echo "$(date -Is) certificado atualizado" || true
EOF
sudo chmod +x "$PROXY"/fingerprint/sync-cert.sh
sudo "$PROXY"/fingerprint/sync-cert.sh
sudo ls -l "$PROXY"/fingerprint/config/
```

**Você deve ver:** `cert.pem` e `key.pem` com dono `1000`. (A chave tem permissão 600.)

Agende para rodar de hora em hora, como root, para pegar as renovações:

```bash
( sudo crontab -l 2>/dev/null; echo "17 * * * * $PROXY/fingerprint/sync-cert.sh >> /var/log/fp-cert.log 2>&1" ) | sudo crontab -
sudo crontab -l | grep sync-cert
```

> **Por que não precisa reiniciar:** o servidor compara os arquivos do certificado a cada 10 minutos e passa a usar os novos para as conexões novas. Se uma renovação for pega no meio (certificado e chave que ainda não combinam), ele mantém o que funciona e registra o erro.

### E2. Gerar os segredos, os tenants e o `config.json`

Gere os segredos com a própria imagem (anote cada saída):

```bash
docker run --rm fingerprint-server:latest node dist/cli.js nonce-secret     # => NONCE_SECRET
docker run --rm fingerprint-server:latest node dist/cli.js nonce-secret     # => IP_HASH_SECRET (outro valor)
docker run --rm fingerprint-server:latest node dist/cli.js new-tenant pwa   # => tenant do seu PWA
docker run --rm fingerprint-server:latest node dist/cli.js new-tenant teste # => tenant só para o teste da Parte F
```

Cada `new-tenant` imprime um bloco JSON (com `publicKey` e `secretKeySha256`) e **uma chave secreta (`sk_...`) mostrada uma única vez**. **Guarde as chaves secretas em um gerenciador de senhas agora.** O servidor guarda só o hash dela.

Crie `"$PROXY"/fingerprint/config/config.json`, trocando os campos entre `<...>`:

```json
{
  "listen": { "host": "0.0.0.0", "port": 8443 },
  "tls": { "certFile": "/config/cert.pem", "keyFile": "/config/key.pem" },
  "nonceSecret": "<NONCE_SECRET>",
  "ipHashSecret": "<IP_HASH_SECRET>",
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
  "collectorPath": "/static/pw-3f9a.js",
  "tenants": [
    {
      "id": "pwa",
      "publicKey": "<publicKey do tenant pwa>",
      "secretKeySha256": ["<secretKeySha256 do tenant pwa>"],
      "allowedOrigins": ["https://app.empregoaqui.com.br"],
      "settings": {
        "identity": { "storedId": { "enabled": false } },
        "privacy": { "ipStorage": "hash" },
        "retention": { "eventsDays": 60 }
      }
    },
    {
      "id": "teste",
      "publicKey": "<publicKey do tenant teste>",
      "secretKeySha256": ["<secretKeySha256 do tenant teste>"],
      "allowedOrigins": ["http://127.0.0.1:8081"],
      "settings": { "identity": { "storedId": { "enabled": false } } }
    }
  ]
}
```

O que cada campo faz:

| Campo | Para que serve |
|---|---|
| `listen` | O servidor escuta em todas as interfaces, na 8443. |
| `tls` | Os arquivos copiados pelo script. O servidor termina o TLS. |
| `nonceSecret`, `ipHashSecret` | Segredos aleatórios (pelo menos 32 caracteres). O segundo é a chave do hash do IP. **Nunca os publique.** |
| `database` | O MySQL do Docker. A senha **não** vai aqui: vem de `FP_MYSQL_PASSWORD`. |
| `collectorFile` e `collectorPath` | O servidor entrega o script do navegador por um nome que você escolheu (mais difícil de bloquear por lista). |
| `allowedOrigins` | Só esses endereços podem chamar o servidor pelo navegador. |
| `storedId.enabled: false` | O código guardado fica **desligado** até o parecer jurídico. |
| `privacy.ipStorage: "hash"` | O IP é guardado só como um hash com chave: dá para saber que dois acessos vieram do mesmo IP, sem guardar o endereço. |
| `retention.eventsDays: 60` | Mantém 60 dias para a observação de algumas semanas. Veja o cuidado com disco na Parte I. |

Copie o script do navegador para a pasta de configuração e ajuste o dono:

```bash
sudo cp "$FP_REPO"/dist/fp.min.js "$PROXY"/fingerprint/config/collector.js
sudo chown -R 1000:1000 "$PROXY"/fingerprint/config
sudo chmod 600 "$PROXY"/fingerprint/config/config.json "$PROXY"/fingerprint/config/key.pem
```

Valide a configuração **antes** de subir (ela é checada na partida; um erro impede o servidor de subir, em vez de falhar depois):

```bash
docker run --rm -v "$PROXY"/fingerprint/config:/config:ro fingerprint-server:latest \
  node -e "require('./dist/config').loadConfig('/config/config.json'); console.log('configuração válida')"
```

**Você deve ver:** `configuração válida`. Se aparecer um erro, ele diz o campo.

### E3. Senha do banco e o serviço no `docker-compose.yml`

Acrescente a senha do banco ao `.env` da pasta `$PROXY` (o mesmo `.env` do `DB_ROOT_PASSWORD`):

```bash
echo 'FP_MYSQL_PASSWORD=A-MESMA-SENHA-DO-PASSO-C1' | sudo tee -a "$PROXY"/.env >/dev/null
sudo chmod 600 "$PROXY"/.env
```

Adicione este serviço ao `docker-compose.yml` (em `services:`, ao lado dos outros). **É só uma adição; não mexa nos serviços existentes:**

```yaml
  fingerprint:
    image: fingerprint-server:latest
    container_name: fingerprint
    restart: unless-stopped
    depends_on:
      - mysql
    environment:
      FP_MYSQL_PASSWORD: ${FP_MYSQL_PASSWORD}
    ports:
      - "8443:8443"
    volumes:
      - ./fingerprint/config:/config:ro
    networks:
      - proxy-network
```

### E4. Subir e verificar

```bash
cd "$PROXY"
docker compose up -d fingerprint
docker compose logs -f fingerprint
```

**Você deve ver**, nos logos, algo como `"route":"identity_ready"`, `"route":"purge"` e `"route":"started","port":8443`. `Ctrl+C` sai dos logs (o servidor continua).

Confirme que está saudável e com o certificado certo:

```bash
docker inspect --format '{{.State.Health.Status}}' fingerprint     # espere: healthy
curl -s https://id.empregoaqui.com.br:8443/readyz
echo | openssl s_client -connect id.empregoaqui.com.br:8443 -servername id.empregoaqui.com.br 2>/dev/null | openssl x509 -noout -subject -dates
```

**Você deve ver:** `healthy` (pode levar até 15 segundos), `{"ready":true}`, e o assunto `CN=id.empregoaqui.com.br` com as datas de validade.

Confirme que o MySQL recebeu as tabelas:

```bash
docker compose exec mysql mysql -ufp -p fingerprint -e "SHOW TABLES;"
```

**Você deve ver:** `events`, `identity_devices`, `identity_features`, `identity_resolutions`, `used_nonces`, `schema_migrations` e outras.

---

## Parte F: teste de ponta a ponta antes de ligar o PWA

Use o tenant `teste` e a página de teste local do seu Mac, apontada para o servidor da VPS. É aqui que você confirma o IP real e os sinais de rede.

### F1. Abrir a página de teste apontada para a VPS (no Mac)

No Mac, na pasta do projeto, sirva a página:

```bash
python3 -m http.server 8081 --bind 127.0.0.1
```

No navegador, abra (troque `<publicKey do tenant teste>`):

```
http://127.0.0.1:8081/tools/local-test/index.html?k=<publicKey do tenant teste>&api=https://id.empregoaqui.com.br:8443
```

Clique em **Send a visit**. **Você deve ver:** `Visit 1 sent.` e um `requestId`. Se aparecer `Failed:`, veja a tabela de problemas (Parte K).

### F2. Ver o que o servidor guardou (no Mac)

Guarde a chave do tenant teste em um arquivo temporário e use o `check.js`:

```bash
echo '{"publicKey":"<publicKey do tenant teste>","secretKey":"<sk_ do tenant teste>"}' > /tmp/vps-keys.json
FP_LOCAL_API=https://id.empregoaqui.com.br:8443 FP_LOCAL_KEYS=/tmp/vps-keys.json node tools/local-test/check.js
rm /tmp/vps-keys.json
```

### F3. Confirmar os sinais de rede (na VPS)

Este é o teste que o ambiente local não conseguia fazer:

```bash
cd "$PROXY"
docker compose exec fingerprint node dist/cli.js last-events --tenant teste --config /config/config.json
```

**Você deve ver**, na linha da sua visita:
- `ja4=` com um valor de verdade (não `-`). Isso prova que o servidor viu o início da conexão TLS.
- `viaProxy=false`. Isso prova que ninguém no meio descreveu a conexão no lugar do visitante.
- `ip=` com o **seu IP** de casa, e **não** `172.x.x.x` nem `10.x.x.x`. Se vier um IP de rede interna do Docker, pare aqui: o servidor não está vendo o IP real. Me mostre a saída.

### F4. Testar de uma rede diferente

No **celular, na rede móvel** (4G ou 5G, com o Wi-Fi desligado), abra `https://id.empregoaqui.com.br:8443/readyz`. **Você deve ver** `{"ready":true}`. Isso prova que a porta 8443 está acessível de fora da sua rede.

Se tudo passou, o servidor está pronto. Antes da Parte G, **remova o tenant `teste`** do `config.json` (ou deixe só enquanto testa) e recarregue com `docker compose kill -s HUP fingerprint`.

---

## Parte G: colocar o carregador no PWA, só registrando

### G1. O princípio

- O PWA carrega um arquivo pequeno, o **carregador** (`fp-loader.min.js`, cerca de 6 KB), que vem do próprio PWA (porta 443). Ele busca o coletor em `id.empregoaqui.com.br:8443`, coleta, envia e **nunca lança erro nem atrasa a tela**. Se algo falhar, ele só manda um aviso para o PWA (Parte H).
- Por que um carregador e não a tag `<script>` direta do coletor? Se a rede do visitante bloqueia a 8443, **o próprio script do coletor não carrega**, e um script que não carregou não pode avisar de nada. O carregador vem do PWA, então ele sempre existe.
- Chame depois que o cadastro deu certo. Nunca antes, nunca esperando.
- O `linkedId` é o **id interno da conta** (por exemplo, o id do usuário no seu banco). **Nunca o e-mail, nome ou telefone.** O coletor recusa um `linkedId` que pareça e-mail.
- **O backend não precisa mudar.** O servidor de fingerprint guarda as visitas sozinho. Você vai analisá-las depois, direto no banco (Parte I).

### G2. Pôr o carregador nos arquivos do PWA

O PWA é um projeto Vite. Copie o arquivo gerado no passo A3 para a pasta `public/` do projeto do PWA, para que ele seja publicado na raiz do site (no seu Mac, na pasta do projeto do PWA):

```bash
cp /caminho/do/fingerprintjs/dist/fp-loader.min.js /caminho/do/projeto-do-pwa/public/fp-loader.min.js
```

Depois do próximo deploy do PWA, confira de qualquer máquina:

```bash
curl -sI https://app.empregoaqui.com.br/fp-loader.min.js | head -3
```

**Você deve ver:** `HTTP/2 200` e `content-type: ... javascript`.

No `index.html` do PWA, uma linha antes do fim do `<body>`:

```html
<script src="/fp-loader.min.js" defer></script>
```

(O Vite pode avisar que esse script "não pode ser empacotado". É esperado: o arquivo é copiado como está.)

### G3. O código que registra a visita

No ponto do PWA onde o cadastro termina com sucesso (você já tem o id da conta nova):

```js
const FP = { ativo: true, api: 'https://id.empregoaqui.com.br:8443', chave: '<publicKey do tenant pwa>' }

function registrarVisita(contaId) {
  if (!FP.ativo || typeof FpLoader === 'undefined') return
  FpLoader.start({
    scriptUrl: `${FP.api}/static/pw-3f9a.js`, // o collectorPath do config.json
    endpoint: FP.api,
    publicKey: FP.chave,
    reportTo: '/fp-report', // o aviso de falha vai para o próprio PWA (Parte H)
    linkedId: String(contaId),
  })
}

// depois do cadastro bem-sucedido, sem await:
registrarVisita(novaConta.id)
```

- **`FP.ativo`** é o seu interruptor: ponha `false` para desligar sem mexer em mais nada.
- `FpLoader.start` **não lança erro e a promessa nunca é rejeitada**, então não precisa de `try/catch`. Ela resolve com `{ ok: true, requestId }` ou `{ ok: false, reason }`.
- Chame **sem `await`** onde o fluxo do cadastro não depende dele, para não atrasar a tela.
- Chame também no **login** (com o id da conta), se quiser ver as contas que voltam. Mais visitas por conta ajudam a contar aparelhos.
- Outras opções do carregador (`timeoutMs`, `probeTimeoutMs`, `successSampleRate`, `collectOptions`): `docs/collector.md`, seção "Loader".

### G4. Se o PWA tem Content-Security-Policy

Hoje o `app.empregoaqui.com.br.conf` não envia CSP. Se você tiver uma (no `index.html` ou por outro caminho), acrescente o servidor, senão o navegador bloqueia:

```
script-src ... https://id.empregoaqui.com.br:8443;
connect-src 'self' https://id.empregoaqui.com.br:8443;
worker-src ... blob:;
```

(`connect-src 'self'` já cobre o `/fp-report`.) Sem `worker-src blob:`, a leitura do worker é bloqueada (e o navegador imprime um erro no console). Se não quiser liberar, exclua esse sinal: passe `collectOptions: { exclude: ['workerContext'] }` ao `FpLoader.start`.

### G5. Service worker e cache do PWA

- O `vite-plugin-pwa` costuma guardar no cache os `.js` da pasta `public/`, então o `fp-loader.min.js` é atualizado a cada novo deploy do PWA (o `sw.js` e o `index.html` já são servidos sem cache pelo seu nginx). Isso basta.
- O script do coletor (de `id.empregoaqui.com.br`) é de outra origem: o service worker não o guarda. Não o ponha em cache para sempre.

### G6. Privacidade, antes de ligar para usuários reais

- Atualize a **política de privacidade** do PWA: diga que, para prevenir fraude e abuso (cadastros repetidos), são lidas características técnicas do navegador e guardado um resumo do endereço IP por até 60 dias. Se usar o aviso de falha da Parte H, diga também que, quando o coletor não é alcançado, é registrada a falha com a rede aproximada (sem o IP).
- Os modelos estão em `docs/plano/privacidade/` (LIA, RIPD, política). **Eles são rascunhos escritos sem revisão jurídica.** Mostre-os a quem revisa isso antes de ligar para usuários reais.
- O código guardado (`storedId`) **continua desligado**. Não o ligue sem esse parecer.

### G7. Ligar de forma gradual

1. Primeiro, ligue só para **você** (por exemplo, `FP.ativo` só se um parâmetro na URL estiver presente).
2. Confira no banco (Parte I) que as suas visitas chegam.
3. Depois ligue para todos. A carga de um cadastro é minúscula.

---

## Parte H: medir quem não alcança o servidor (porta 8443 bloqueada, bloqueadores)

**Para que serve.** Algumas redes (empresas, escolas, hotéis, alguns provedores) só deixam passar a porta 443, e alguns bloqueadores de rastreamento barram o coletor. Nesses casos a conexão **nem chega ao servidor**, então o servidor nunca vê a falha. Quem sabe é o navegador do visitante. O carregador (Parte G) percebe, descobre a causa mais provável e manda um aviso pequeno para o PWA. Um receptor guarda os avisos, e um comando faz o resumo. Assim você sabe **quantos visitantes caem nisso, por quê e de que redes**, antes de decidir se vale mudar de porta.

**É opcional**, mas recomendado: sem isso, quem não alcança o servidor simplesmente não aparece nos seus números, e você não sabe o tamanho do buraco.

### H1. O que fica guardado (e o que não)

| Guarda | Não guarda |
|---|---|
| O motivo da falha, a fase, o resultado da sonda, o tempo gasto | O endereço IP (nem inteiro, nem truncado) |
| Família do navegador (Chrome, Firefox, Safari, Edge...) e se é celular | O `User-Agent` inteiro |
| A rede (número e nome, se você der um arquivo de redes) | A URL da página, cookies, o `linkedId`, o e-mail |
| Um resumo com chave do bloco do IP (/24 ou /64), só para contar redes distintas | Qualquer coisa que permita voltar do resumo ao IP sem a chave |

O IP é usado **na hora**, só para achar a rede e calcular o resumo com chave. Os avisos ficam por 90 dias (`--keep-days`). Detalhes e limites: `detectar-bloqueio-da-porta-8443-e-do-coletor-aviso-de-falha-loader-receptor-asn-lgpd.md`.

### H2. O receptor como um segundo serviço do Docker

Ele usa **a mesma imagem** do servidor (`fingerprint-server:latest`), então não há nada novo para construir. Primeiro, descubra a rede do Docker onde o nginx está, para o receptor confiar no cabeçalho de IP que o nginx escreve:

```bash
cd "$PROXY"
docker network ls | grep proxy-network
docker network inspect <NOME-QUE-APARECEU> --format '{{(index .IPAM.Config 0).Subnet}}'
```

**Você deve ver:** uma faixa como `172.18.0.0/16`. Anote-a (é o `<FAIXA>` abaixo).

Crie a pasta do banco de avisos, com o dono certo:

```bash
sudo mkdir -p "$PROXY"/fingerprint/reports
sudo chown 1000:1000 "$PROXY"/fingerprint/reports
```

Acrescente este serviço ao `docker-compose.yml` (em `services:`, depois do `fingerprint`). Troque `<FAIXA>`:

```yaml
  fp-report:
    image: fingerprint-server:latest
    container_name: fp-report
    restart: unless-stopped
    command:
      - node
      - dist/cli.js
      - reachability-receiver
      - --db
      - /data/reach.db
      - --host
      - 0.0.0.0
      - --port
      - "8090"
      - --allowed-origin
      - https://app.empregoaqui.com.br
      - --trust-forwarded-from
      - "<FAIXA>"
      - --keep-days
      - "90"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
    volumes:
      - ./fingerprint/reports:/data
    networks:
      - proxy-network
```

Pontos importantes:

- **Sem `ports:`**: o receptor não fica exposto na internet. Só o nginx, dentro da rede do Docker, fala com ele.
- O `healthcheck` é trocado de propósito: o da imagem lê a configuração do servidor de fingerprint, que o receptor não tem.
- O endereço e o nome da rede (`proxy-network`) são os do seu `docker-compose.yml`. Se o seu usa outro nome, use o seu.

Suba e confira:

```bash
docker compose up -d fp-report
docker inspect --format '{{.State.Health.Status}}' fp-report
docker compose logs --tail 5 fp-report
```

**Você deve ver:** `healthy` (até 30 segundos) e `Receiver listening on 0.0.0.0:8090` nos logs. (O aviso `ExperimentalWarning: SQLite` é esperado.)

### H3. O trecho do nginx do PWA (você aplica; eu não mexo no nginx)

Dentro do bloco `server { ... }` de `"$PROXY"/sites/app.empregoaqui.com.br.conf`, junto do `location /api/`, acrescente:

```nginx
    # Avisos do carregador do fingerprint (Parte H do guia de instalação).
    # A resolução do nome é adiada de propósito: se o container fp-report estiver parado, só este endereço
    # responde 502, e o nginx continua subindo normalmente com todos os sites.
    location = /fp-report {
        limit_except POST { deny all; }
        client_max_body_size 8k;
        access_log off;

        resolver 127.0.0.11 valid=10s;
        set $fp_report http://fp-report:8090;
        proxy_pass $fp_report/report;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Troca o cabeçalho, não acrescenta: o que o visitante mandar nele é descartado.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_connect_timeout 2s;
        proxy_read_timeout 5s;
    }
```

Teste **antes** de recarregar (um erro aqui impede o recarregamento e nada muda):

```bash
cd "$PROXY"
docker exec -it nginx nginx -t
docker compose exec nginx nginx -s reload
```

**Você deve ver:** `syntax is ok`, `test is successful`. Se o teste falhar, **remova o bloco** e me mostre o erro.

### H4. Testar de ponta a ponta

**1) O receptor responde pelo PWA** (de qualquer máquina):

```bash
curl -i -X POST https://app.empregoaqui.com.br/fp-report \
  -H 'Origin: https://app.empregoaqui.com.br' -H 'Content-Type: text/plain' \
  --data '{"v":1,"reason":"script_unreachable","phase":"script","probe":"unreachable","elapsedMs":1234}'
```

**Você deve ver:** `HTTP/2 204`. Sem o cabeçalho `Origin` deve vir `403`. Um `GET` pelo PWA vem `403` do próprio nginx (`limit_except`); direto no receptor seria `405`.

**2) O resumo enxerga o aviso:**

```bash
cd "$PROXY"
docker compose exec fp-report node dist/cli.js reachability-summary --db /data/reach.db --days 1
```

**Você deve ver:** `Avisos recebidos: 1` e `script_unreachable` na lista.

**3) Um bloqueio de verdade, no navegador** (no Mac, com o PWA já com o carregador publicado):

1. Abra o PWA em uma **aba nova**. No DevTools (Chrome), aba **Network**, atualize a página, ache o pedido `pw-3f9a.js`, clique com o botão direito e escolha **Block request URL**.
2. Abra o PWA **em outra aba nova** (o aviso é enviado uma vez por aba), abra o console do DevTools e cole (troque a chave pela `publicKey` do tenant `pwa`; a visita não leva `linkedId`):

   ```js
   FpLoader.start({
     scriptUrl: 'https://id.empregoaqui.com.br:8443/static/pw-3f9a.js',
     endpoint: 'https://id.empregoaqui.com.br:8443',
     publicKey: '<publicKey do tenant pwa>',
     reportTo: '/fp-report',
   }).then(console.log)
   ```

   **Você deve ver:** `{ok: false, reason: 'script_blocked'}`.
3. Rode o resumo de novo. **Você deve ver:** `script_blocked` (a conexão com o servidor funciona; só o script foi barrado).
4. Para ver `script_unreachable`, acrescente temporariamente ao `/etc/hosts` do Mac a linha `127.0.0.1 id.empregoaqui.com.br` (a 8443 local não existe, a conexão é recusada). Repita o passo 2. **Remova a linha depois.**

**4) Apagar os avisos de teste** (só agora, antes de ligar para usuários; depois disso **não** apague):

```bash
cd "$PROXY"
docker compose stop fp-report
sudo rm -f "$PROXY"/fingerprint/reports/reach.db*
docker compose start fp-report
```

### H5. Opcional: saber de que rede (ASN)

Por padrão o resumo conta as redes por um código sem significado (`prefix 3fa9...`), útil só para saber **quantas redes diferentes** aparecem. Para ver **o nome** (por exemplo, a operadora), dê ao receptor um arquivo de faixas de IP com o número e o nome da rede.

- **O projeto não traz esse dado**, e eu não assumo o formato de nenhum provedor. Você baixa um arquivo, **confere a licença dele** (muitos exigem atribuição ou proíbem redistribuir) e diz ao receptor em quais colunas estão as coisas, contando a partir de 0.
- Exemplo com um arquivo `redes.csv` de colunas `primeiro-ip, último-ip, número-asn, nome`:

```
189.0.0.0,189.0.255.255,28573,"CLARO S.A."
```

Ponha o arquivo em `"$PROXY"/fingerprint/reports/redes.csv` e acrescente estas linhas ao `command:` do serviço `fp-report` (cada valor em uma linha, como as outras):

```yaml
      - --asn-file
      - /data/redes.csv
      - --asn-from
      - "0"
      - --asn-to
      - "1"
      - --asn-number
      - "2"
      - --asn-name
      - "3"
```

Se o arquivo traz a faixa em CIDR (`189.0.0.0/16`) em uma coluna só, **omita** `--asn-to`. Se a coluna estiver errada, o receptor **recusa subir** e diz a linha do erro, em vez de funcionar sem achar nada. Depois `docker compose up -d fp-report`. O arquivo só é lido na partida.

Só o **número e o nome da rede** são guardados. O IP continua sem ser gravado.

### H6. Ler o resumo

```bash
cd "$PROXY"
docker compose exec fp-report node dist/cli.js reachability-summary --db /data/reach.db --days 30
```

Opções: `--days n`, `--utc-offset -3` (o fuso das horas; o padrão é Brasília) e `--json`. O texto mostra:

- **Por motivo** e o que cada motivo quer dizer.
- **A sonda** (a conexão com o servidor funciona ou não, naquele momento).
- **Navegador e celular**, só entre as falhas.
- **Por hora do dia.** Um pico em todas as redes ao mesmo tempo indica **servidor fora do ar**, não rede bloqueando.
- **As redes que mais aparecem**, com quantos prefixos diferentes (uma rede com muitos avisos de um prefixo só pode ser um visitante insistente).

Como ler os motivos mais importantes:

| Motivo | Leitura provável |
|---|---|
| `script_unreachable` | O script não carregou e o servidor não responde: a **porta 8443 bloqueada pela rede**, ou o servidor fora do ar. É o caso que esta parte quer medir. |
| `script_blocked` | O script não carregou mas o servidor responde: **bloqueador de rastreadores**, política de conteúdo, ou regra de caminho. Trocar de porta não ajuda. Mudar o nome do script (`collectorPath`) pode ajudar. |
| `request_unreachable` | O script carregou mas o pedido não passou, e o servidor não responde. |
| `request_blocked` | O script carregou mas o pedido falhou e o servidor responde: bloqueador, **chave errada** ou **origem fora de `allowedOrigins`** (o servidor responde sem CORS, e o navegador só vê "falhou"). Se aparecer logo depois de instalar, confira esses dois. |
| `server_refused` | O servidor recusou. O `status` diz o que foi: 401 chave, 403 origem ou tenant suspenso, 422 consentimento, 429 limite. |
| `server_error` | O servidor falhou (5xx). |
| `timeout`, `collect_error`, `script_broken` | Lentidão, navegador incomum, ou versão errada do script. |

### H7. A fração, e o que fazer com ela

O resumo conta **avisos**, não a fração de visitantes afetados. Para a fração, divida pelo número de cadastros do PWA no mesmo período:

```
avisos unreachable (resumo) ÷ cadastros do período (seu banco)
```

Duas ressalvas: um aviso é enviado **uma vez por aba**, então um visitante que abre várias abas conta mais de uma vez; e quem fecha a página antes do aviso sai.

Quer um denominador pelo próprio receptor? Passe `successSampleRate: 0.05` ao `FpLoader.start`: 5% das visitas que **deram certo** mandam um aviso `ok`, e `ok × 20` estima as visitas que funcionaram.

**Minha sugestão, sem dado por trás** (ajuste com o que você vir):

| Fração de `script_unreachable` | O que eu faria |
|---|---|
| Abaixo de uns 1% | Nada. Seguir com a 8443. |
| Entre uns 1% e 5% | Olhar **de que redes** vêm. Se forem redes de empresa ou escola, esses visitantes tendem a ser os que menos criam contas repetidas. Pode não valer o esforço. |
| Acima de uns 5%, ou concentrado em operadoras grandes | Aí vale estudar a porta 443. Leia `usar-a-porta-443-para-o-fingerprint-...md`: há três rotas, nenhuma é trivial, e **nenhuma deve ser feita sem janela combinada** no servidor que hospeda os seus outros sites. |

### H8. Limites, ditos com franqueza

- A causa é uma **estimativa**. A sonda só diz se a conexão com o servidor funciona; não diz o motivo exato.
- **Não aparecem:** quem bloqueia o próprio carregador (arquivo do PWA), quem fecha a aba antes do aviso, e quem está sem internet (nesse caso o carregador não avisa, de propósito).
- O aviso vai para o **mesmo PWA, na porta 443**. Uma rede que bloqueia o próprio PWA não usaria o PWA de qualquer jeito.
- O nome da rede só é tão bom quanto o seu arquivo de faixas. Faixas de operadoras e de provedores se misturam.
- **O que não foi verificado:** o carregador foi testado no Chrome e no Firefox (testes automáticos) e ponta a ponta no Chrome. **Safari (Mac e iPhone) não foi testado.** O receptor depende de o navegador mandar o cabeçalho `Origin` no aviso (todos os principais mandam em `POST`); se o Safari não mandar, os avisos dele seriam recusados com 403. Teste um aviso pelo Safari antes de confiar nos números dele.
- **Disco, no pior caso.** O endereço é público e sem chave; o `Origin` é fácil de forjar. Quem o achasse poderia encher o banco até o limite total (600 avisos por minuto, cerca de 860 mil por dia, na casa de 100 a 200 MB por dia). A retenção de 90 dias limita o total, mas em ataque contínuo isso passa de 10 GB. Se você notar o arquivo crescendo sem os cadastros acompanharem, baixe `--rate-total` (por exemplo para 60) e `--keep-days`, ou tire o `location = /fp-report` do nginx.
- Nada disso mede a precisão do fingerprint. É um medidor de **alcance do coletor**.

---

## Parte I: observar por algumas semanas

**O que você vai olhar:** quantas contas aparecem por aparelho. **Não tome nenhuma decisão ainda.**

### I1. Antes: retenção e disco

- A retenção está em **60 dias** (`retention.eventsDays`). Confirme o espaço: cada visita guarda cerca de 45 KB. 1.000 cadastros por dia durante 60 dias são perto de 2,7 GB.
- Acompanhe o tamanho (na VPS, na semana 1 e depois uma vez por semana):

```bash
cd "$PROXY"
docker compose exec mysql mysql -uroot -p -e "
  SELECT table_name, ROUND((data_length + index_length) / 1024 / 1024) AS mb
  FROM information_schema.tables WHERE table_schema = 'fingerprint' ORDER BY mb DESC;"
df -h /
```

### I2. A consulta principal: quantas contas por aparelho

```bash
docker compose exec mysql mysql -uroot -p fingerprint -e "
SELECT contas, COUNT(*) AS aparelhos FROM (
  SELECT r.device_id, COUNT(DISTINCT e.linked_id) AS contas
  FROM identity_resolutions r
  JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
  WHERE r.tenant_id = 'pwa' AND e.linked_id IS NOT NULL
  GROUP BY r.device_id
) por_aparelho
GROUP BY contas ORDER BY contas;"
```

**Como ler:** a saída é uma tabela de duas colunas. Por exemplo:

| contas | aparelhos |
|---|---|
| 1 | 940 |
| 2 | 38 |
| 3 | 9 |
| 6 | 2 |

Quer dizer: 940 aparelhos criaram 1 conta, 38 criaram 2 contas, 9 criaram 3, e 2 aparelhos criaram 6.

### I3. Os aparelhos que mais chamam a atenção

```bash
docker compose exec mysql mysql -uroot -p fingerprint -e "
SELECT r.device_id, COUNT(DISTINCT e.linked_id) AS contas, COUNT(*) AS visitas,
       FROM_UNIXTIME(MIN(e.received_at) / 1000) AS primeira, FROM_UNIXTIME(MAX(e.received_at) / 1000) AS ultima
FROM identity_resolutions r
JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
WHERE r.tenant_id = 'pwa' AND e.linked_id IS NOT NULL
GROUP BY r.device_id HAVING contas >= 3 ORDER BY contas DESC LIMIT 30;"
```

### I4. Olhar um caso de perto

Ligue o painel só para você (em `config.json`: `"dashboard": true`, depois `docker compose kill -s HUP fingerprint`) e abra `https://id.empregoaqui.com.br:8443/dashboard/`. Cole a **chave secreta do tenant `pwa`** (ela fica só em memória da página). Filtre por `linkedId` e veja o aparelho, o risco e a evidência de adulteração. Em um aparelho com muitas contas, olhe se há explicação inocente (família, lan house, a mesma pessoa em outro navegador).

### I5. Rotina semanal (15 minutos)

1. Rode a consulta I2 e anote a tabela com a data.
2. Rode a I3 e olhe 5 aparelhos pelo painel.
3. Veja disco e `docker compose logs --tail 200 fingerprint | grep -i error`.
4. Anote quantos cadastros houve na semana (para saber a taxa de aparelhos com mais de uma conta).

### I6. Como escolher a regra "com número na mão"

Depois de 3 a 4 semanas, olhe a tabela da consulta I2:

1. **Veja onde a cauda começa.** Se 97% dos aparelhos têm 1 conta e 2,5% têm 2, mas só 0,3% têm 4 ou mais, "4 ou mais contas" é um bom ponto de partida, porque é raro entre pessoas normais.
2. **Comece com `review`, não bloqueio.** A decisão `review` só marca a visita; quem decide a ação é o seu backend, e no início ele pode só enviar para você olhar.
3. **A regra** vai em `rules.list` do tenant (veja `docs/regras.md` e `docs/configuracao.md`). Ela usa o fato `velocity.linkedIdsPerDevice`. O limite padrão do risco é **3 contas em 24 horas** (`risk.velocity.linkedIdsPerDevice.threshold`, janela `risk.velocity.windowMinutes`). Para o seu abuso (contas ao longo de dias), a janela de 24 horas pode ser curta: ajuste a janela com os números que você viu.
4. **Faça a regra valer só no registro primeiro** (decisão `review` sem ação) por mais uma ou duas semanas e compare com a sua leitura manual do painel.

### I7. O que a observação **não** diz

- **Não mede acerto.** Você não sabe quais contas são da mesma pessoa de verdade. Você só vê quantas contas o servidor ligou ao mesmo aparelho. Um número alto pode ser abuso, ou pode ser família, lan house ou aparelhos iguais.
- **Pode subestimar:** quem troca de navegador, de aparelho ou usa navegador anti-detecção aparece como outro aparelho.
- O motor ainda não foi calibrado com dados rotulados (`calibrated: false`).

---

## Parte J: operar e manter

| Tarefa | Comando (na VPS, em `$PROXY`) |
|---|---|
| Ver logs | `docker compose logs --tail 100 fingerprint` |
| Ver se está saudável | `docker inspect --format '{{.State.Health.Status}}' fingerprint` |
| Parar | `docker compose stop fingerprint` |
| Reiniciar | `docker compose restart fingerprint` |
| Recarregar a configuração sem reiniciar | `docker compose kill -s HUP fingerprint` (uma configuração com erro é recusada e a antiga continua) |
| Atualizar a versão | `cd $FP_REPO && git pull && docker build -f server/Dockerfile -t fingerprint-server:latest . && cd $PROXY && docker compose up -d fingerprint` |
| Ver o certificado | `echo \| openssl s_client -connect id.empregoaqui.com.br:8443 -servername id.empregoaqui.com.br 2>/dev/null \| openssl x509 -noout -dates` |
| Atualizar o coletor | Gere o `dist/fp.min.js` de novo (passo A3), copie para `fingerprint/config/collector.js` e `docker compose restart fingerprint`. |
| Atualizar o carregador | Gere o `dist/fp-loader.min.js` (passo A3), copie para `public/` do PWA e faça o deploy do PWA. |
| Resumo dos avisos de falha | `docker compose exec fp-report node dist/cli.js reachability-summary --db /data/reach.db --days 30` |
| Atualizar o receptor | Reconstrua a imagem (a mesma do servidor) e `docker compose up -d fingerprint fp-report`. |

**Backup:** inclua o banco `fingerprint` no backup do MySQL (ou decida conscientemente que não vale). Apagar uma visita não apaga as cópias de segurança; escreva isso na política de privacidade.

**Métricas no Prometheus (opcional):** o servidor expõe `/metrics` só com uma chave própria (`metricsKeySha256`). Veja `server/README.md` (seção Operations) e o seu `PROMETHEUS_SETUP.md`. Pode ficar para depois.

**Desligar de vez (rollback):**
1. No PWA, ponha `FP.ativo = false` (ou remova a chamada e a tag `<script>`).
2. `docker compose stop fingerprint fp-report` e, se quiser, remova o bloco `location = /fp-report` do nginx do PWA.
3. O PWA continua funcionando, porque a chamada nunca bloqueia o cadastro.
4. Os dados ficam no banco `fingerprint` até a retenção apagá-los. Para apagar tudo: `DROP DATABASE fingerprint;` (irreversível).

## Parte K: problemas comuns

| Sintoma | Causa provável e o que fazer |
|---|---|
| `curl https://id.empregoaqui.com.br:8443/readyz` não conecta | Porta 8443 fechada no firewall (da VPS ou do provedor), ou o container não subiu. Veja `docker compose ps` e os logs. |
| Erro de certificado no navegador | O certificado é de outro nome, ou o `sync-cert.sh` ainda não copiou. Rode-o à mão e veja `openssl s_client` (seção E4). |
| Container reinicia sem parar | Quase sempre a configuração. Rode a validação do passo E2 e leia o erro. Também: senha do banco errada, ou o MySQL ainda não subiu. |
| `Cannot connect to MySQL` | `FP_MYSQL_PASSWORD` no `.env` não é a do usuário `fp`, ou o `host` não é `mysql`, ou o container não está na `proxy-network`. |
| `The MySQL password is not set` | Faltou a variável `FP_MYSQL_PASSWORD` no `.env`. |
| `last-events` mostra `ja4=-` | A visita veio por um proxy, ou o certificado/TLS não está sendo terminado pelo servidor. Confirme que você chamou a porta 8443 direto. |
| `ip=` mostra `172.x` ou `10.x` | O servidor não vê o IP real (algum NAT do Docker). Pare e me mostre a saída: não siga para o PWA. |
| A página mostra `Failed: ... Failed to fetch` | `allowedOrigins` do tenant não inclui o endereço da página (o teste local usa `http://127.0.0.1:8081`). Corrija e recarregue com `kill -s HUP`. |
| `403`/`origin` nos logs | Mesma causa: a origem do PWA não está em `allowedOrigins`. |
| O PWA mostra erro de CSP | Falta liberar `https://id.empregoaqui.com.br:8443` em `script-src` e `connect-src` (seção G4). |
| Muitas visitas viram "aparelho novo" | Esperado no começo. Também: navegadores de privacidade e visitas marcadas com adulteração alta **não ensinam** o motor por padrão. Veja o guia do teste local. |
| `curl .../fp-report` dá 502 | O container `fp-report` está parado ou não está na `proxy-network`. `docker compose ps` e `docker compose logs fp-report`. O PWA não é afetado. |
| `fp-report` responde 403 | O cabeçalho `Origin` não é `https://app.empregoaqui.com.br` (o `--allowed-origin` do receptor). |
| `fp-report` responde 429 | Limite por IP (30 por minuto) ou total (600 por minuto). Ajuste `--rate-per-ip` e `--rate-total` se o PWA tiver muito tráfego. |
| O resumo só tem `request_blocked` logo depois de instalar | Quase sempre a chave pública errada no PWA, ou o endereço do PWA fora de `allowedOrigins` (o servidor responde sem CORS e o navegador só vê "falhou"). Veja o status no log do `fingerprint`. |
| O resumo mostra o IP | Não deveria: o IP nunca é gravado. Se achar que viu, pare o `fp-report` e me mostre. |
| Disco enchendo | Reduza `retention.eventsDays` e recarregue. Veja a seção I1 e o documento do MySQL. |

## Parte L: checklist final

**Antes de ligar:**
- [ ] O branch `v5.3.0-fork` foi commitado e enviado, e eu clonei na VPS.
- [ ] A imagem `fingerprint-server:latest` foi construída e o `fp.min.js` foi gerado.
- [ ] O registro `A` de `id.empregoaqui.com.br` aponta para o IP da VPS (`dig` confirma).
- [ ] A porta 8443 está livre e aberta nos dois firewalls.
- [ ] Banco `fingerprint` e usuário `fp` criados, e a senha está só no `.env`.
- [ ] Certificado emitido, `sync-cert.sh` copiou, o cron está agendado.
- [ ] `config.json` validado, com segredos novos e `storedId` **desligado**.
- [ ] O serviço `fingerprint` está `healthy`, `readyz` responde e o certificado é de `id.empregoaqui.com.br`.
- [ ] O teste da Parte F mostrou `ja4` preenchido, `viaProxy=false` e o IP real.
- [ ] O tenant `teste` foi removido ou desligado.
- [ ] (Parte H, opcional) O serviço `fp-report` está `healthy`, o `location = /fp-report` foi aplicado, o `curl` da seção H4 devolveu 204 e os avisos de teste foram apagados.
- [ ] A política de privacidade do PWA foi atualizada e eu mostrei os modelos a quem revisa.

**Durante a observação:**
- [ ] O coletor registra **depois** do cadastro e nunca bloqueia (`try/catch`).
- [ ] O `linkedId` é o id da conta, nunca o e-mail.
- [ ] Rodo a rotina semanal (I5) e acompanho o disco.
- [ ] Nenhuma regra decide nada ainda.

**Depois, com os números:**
- [ ] Escolhi o limite olhando a tabela da consulta I2.
- [ ] Comecei com `review`, sem bloqueio automático.
- [ ] Decidi o que fazer com os casos revisados, e sei que o sistema reduz o abuso, mas não o elimina.

## Referências no projeto

- Opções de implantação (A, B): `server/README.md`, seção "How to deploy".
- MySQL e vários servidores: `server/README.md`, "Several instances on one MySQL database".
- Banco e cuidados: `mysql-ou-sqlite-decisao-e-cuidados-em-producao-vps-compartilhada-retencao-conexoes-disco-backup.md`.
- Todos os parâmetros: `docs/configuracao.md`. Fatos e operadores das regras: `docs/regras.md`.
- Privacidade e LGPD: `docs/plano/privacidade/`.
- Evoluir a busca: `busca-de-candidatos-v2-como-evoluir-com-dados-reais.md`.
