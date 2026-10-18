# Guia do organizador

Para quem vai colocar o servidor no ar e juntar voluntários. Escrito para ser seguido na ordem, sem conhecer o código.
Os comandos e arquivos do seu `reverse-proxy-config` são baseados no que está lá hoje (`create_ssl.sh`, `renew_all.sh`,
`sites/*.conf`). **Nada abaixo foi executado no seu VPS.** Onde há suposição, ela está marcada.

---

# Parte A: colocar o servidor no ar (ponto 1)

## O que você está fazendo, em uma frase

Dar ao servidor de ingestão um endereço na internet (`https://fp.fastvistos.com.br:8443`) para que o celular de um
voluntário consiga enviar a visita para ele.

## Por que um endereço e uma porta novos

- O seu nginx já usa a porta **443** para todos os sites. O servidor de ingestão precisa receber a conexão do navegador
  **diretamente**, sem o nginx no meio, senão ele não enxerga como o navegador negocia o TLS (o JA4) nem a ordem dos
  cabeçalhos. Por isso ele escuta numa porta própria, a **8443**, sem mexer em nada do que já funciona.
- Navegador precisa de um **nome** (não um número de IP) para o certificado HTTPS funcionar. Daí o `fp.fastvistos.com.br`,
  no mesmo padrão dos seus `bugsink.` e `grafana.`. Pode ser outro nome; troque nos comandos.
- Este servidor entrega também a **página de coleta** no mesmo endereço, então voluntários só precisam de **um link**.

## Passo a passo

**1. DNS (no painel onde você gerencia `fastvistos.com.br`).** Crie um registro `A` com nome `fp` apontando para o IP do VPS,
o mesmo dos seus outros subdomínios. Confira: `dig +short fp.fastvistos.com.br` deve mostrar o IP do VPS.
(Pelo arquivo `registros_dns_conceptvistos.txt` o IP parece ser `89.116.225.162`. Confirme, é uma suposição.)

**2. Um bloco na porta 80, só para emitir o certificado.** O seu nginx não tem um bloco "pega-tudo" na porta 80, então cada
nome novo precisa do seu. Crie `sites/fp.fastvistos.com.br.conf` com:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name fp.fastvistos.com.br;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        try_files $uri =404;
    }

    location / {
        return 301 https://fp.fastvistos.com.br:8443$request_uri;
    }
}
```

Depois: `docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload`.
Isso só afeta o nome `fp.fastvistos.com.br`; os outros sites não mudam.

**3. Emitir o certificado.** Na pasta do `reverse-proxy-config`: `./create_ssl.sh --only-certificate` e digite
`fp.fastvistos.com.br`. O `--only-certificate` é importante: sem ele o script criaria um site HTTPS na 443 que você não quer.
O certificado fica em `./letsencrypt/live/fp.fastvistos.com.br/`.

**4. Deixar o certificado legível pelo servidor.** O servidor roda como usuário comum (uid 1000), e a chave do Let's Encrypt
só é legível por root. Crie `fingerprint/sync-certs.sh` e rode uma vez:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=./letsencrypt/live/fp.fastvistos.com.br
DST=./fingerprint/certs
mkdir -p "$DST"
cp -L "$SRC/fullchain.pem" "$DST/cert.pem"
cp -L "$SRC/privkey.pem"   "$DST/key.pem"
chown 1000:1000 "$DST/cert.pem" "$DST/key.pem"
chmod 640 "$DST/key.pem"
```

Para as **renovações**: o seu `renew_all.sh` já tem um trecho "Certificates changed → reloading Nginx". Acrescente ali uma
linha chamando `./fingerprint/sync-certs.sh`. O servidor confere os arquivos a cada 10 minutos e **troca o certificado sozinho**,
sem reiniciar. Se a cópia falhar no meio de uma renovação, ele mantém o certificado antigo e registra o erro no log.

**5. Criar o tenant e a configuração.** No repositório do projeto (pode ser no seu Mac):

```bash
yarn build && yarn server:build
node server/dist/cli.js nonce-secret          # copie o valor: é o "nonceSecret"
node server/dist/cli.js new-tenant fastvistos # copie o bloco do tenant e GUARDE a chave secreta (aparece uma vez)
```

Em `fingerprint/config/config.json` no VPS:

```json
{
  "listen": { "host": "0.0.0.0", "port": 8443 },
  "nonceSecret": "<o valor do nonce-secret>",
  "tenants": [ <o bloco do tenant> ],
  "tls": { "keyFile": "/certs/key.pem", "certFile": "/certs/cert.pem" },
  "databasePath": "/data/events.db",
  "calibrationDir": "/page",
  "retentionDays": 90
}
```

**6. A página de coleta.** Em `fingerprint/page/` coloque quatro arquivos: `index.html` e `calibration.js` (de
`tools/calibration/`), `fp.min.js` (de `dist/`) e um `config.js`:

```js
window.CALIBRATION = {
  endpoint: '',                       // vazio = o próprio endereço
  publicKey: 'pk_...',                // a chave PÚBLICA do tenant do passo 5
  retention: '90 dias depois do fim do teste',
  contact: 'seu nome e e-mail',
}
```

**7. Subir o contêiner.** Copie o repositório para o VPS (ou envie só a imagem) e:
`docker build -f server/Dockerfile -t fingerprint-server:latest .`. Acrescente ao `docker-compose.yml` (no serviço novo, sem
tocar nos existentes):

```yaml
  fingerprint:
    image: fingerprint-server:latest
    container_name: fingerprint
    restart: unless-stopped
    ports:
      - "8443:8443"
    volumes:
      - ./fingerprint/config:/config:ro
      - ./fingerprint/certs:/certs:ro
      - ./fingerprint/page:/page:ro
      - fingerprint_data:/data
    networks:
      - proxy-network
```

e `fingerprint_data:` na seção `volumes:` do arquivo. Depois `docker compose up -d fingerprint`.

**8. Abrir a porta 8443** no firewall do VPS (e no firewall do provedor, se houver painel).

**9. Conferir.**
- `curl https://fp.fastvistos.com.br:8443/healthz` deve responder `{"ok":true}`.
- Abra `https://fp.fastvistos.com.br:8443/` no celular: deve aparecer a página de consentimento.
- Faça **uma** visita de teste com o código `p00`.
- **Confirme que o IP gravado é o seu, e não o do Docker.** Rode, de um celular em 4G (fora do wifi do VPS):
  `docker compose exec fingerprint node dist/cli.js last-events --config /config/config.json --tenant fastvistos`.
  Cada linha mostra o endereço que o servidor viu. Se aparecer `WARNING=looks-like-a-container-or-local-address` ou um
  endereço começando com `172.`, o Docker está escondendo o endereço dos visitantes e é preciso ajustar a rede antes de
  recrutar alguém. (Eu não pude testar isto: só em Linux com Docker de verdade.)

## O que pode dar errado

| Sintoma | Causa provável |
|---|---|
| O navegador diz "não seguro" | Certificado do nome errado, ou o servidor não leu os arquivos (veja `docker logs fingerprint`) |
| A página não abre de fora | Porta 8443 fechada no firewall, ou DNS ainda não propagou |
| Falha ao emitir o certificado | O bloco da porta 80 não foi carregado (rode o `nginx -t`), ou o DNS ainda não aponta para o VPS |
| O servidor não sobe e fala em arquivo | Falta um dos quatro arquivos de `fingerprint/page/`, ou `config.js` |
| IP gravado começando com `172.` | O Docker escondeu o endereço do visitante (veja o passo 9) |

---

# Parte B: reunir voluntários e medir (ponto 3)

## O que você está fazendo, em uma frase

Pedir a algumas pessoas que abram um link, em cada aparelho delas, em alguns dias diferentes, para que o sistema saiba
quais visitas são do mesmo aparelho. Com isso se mede o quanto o identificador atual **erra**, antes de tentar melhorá-lo.

## Antes de convidar qualquer pessoa

1. Parte A concluída e testada por você (código `p00`).
2. O texto de consentimento revisado por quem entende de LGPD (ponto 2, que você deixou para o fim). **Você pode fazer o
   piloto só com os seus próprios aparelhos antes disso**, sem convidar ninguém.

## Piloto: você sozinho (1 a 2 dias)

Use todos os aparelhos e navegadores que tiver: notebook com Chrome, Firefox e Safari, celular, tablet, e o modo anônimo.
Cada um é um aparelho, com seu nome: `p00.notebook-chrome`, `p00.notebook-firefox`, `p00.iphone-safari`,
`p00.notebook-chrome-anonimo`... Faça 2 visitas de cada, com algumas horas de intervalo. Isso já mostra o fluxo inteiro
funcionando e dá o primeiro relatório, ainda sem valor estatístico.

## Quantos voluntários, e quem

- Para **estabilidade**: algumas centenas de aparelhos dão números confiáveis. 30 aparelhos já mostram os problemas mais
  óbvios, mas com muita incerteza. Comece com 15 a 30 pessoas, veja que o fluxo funciona, e depois amplie.
- Quem: sua equipe, amigos, familiares, conhecidos. Pessoas diferentes, com aparelhos diferentes (inclua quem usa Safari
  no iPhone e Firefox).
- **Aparelhos idênticos** valem ouro: duas pessoas com o mesmo modelo de iPhone, na mesma versão.

## Como organizar

**1. Códigos.** Dê a cada pessoa um código sem significado: `p01`, `p02`, `p03`... Guarde a tabela "código → pessoa" numa
planilha **sua**, separada, ou nem guarde. Ninguém que analise os dados precisa saber quem é quem.

**2. Planilha de acompanhamento** (só sua):

| Código | Pessoa (opcional) | Aparelho | Dia 0 | Dia 1 | Dia 7 | Dia 30 |
|---|---|---|---|---|---|---|
| p01 | | iphone-safari | feito | feito | | |
| p01 | | notebook-chrome | feito | | | |

**3. Mensagem para os voluntários** (adapte):

> Oi! Estou testando um sistema que reconhece navegadores para combater fraude. Preciso de voluntários: leva 1 minuto por
> aparelho. Abra o link abaixo no aparelho e navegador que você usa, leia o aviso, informe seu código **p07** e o nome do
> aparelho (ex.: iphone-safari), marque que concorda e envie. Repita em outros aparelhos e navegadores seus, e **de novo
> daqui a 1, 7 e 30 dias** (eu aviso). Não use nome nem e-mail. Pode desistir quando quiser: me diga seu código que eu apago
> tudo. Link: https://fp.fastvistos.com.br:8443/

**4. Lembretes.** Nos dias 1, 7 e 30 de cada pessoa, mande o link de novo. É o que dá a curva de estabilidade. Se um
voluntário atualizar o navegador no meio do período, ótimo: é o caso que quebra o identificador.

## Quando rodar a análise

- No piloto: logo.
- Com voluntários: uma vez depois do dia 7 (resultado parcial) e outra depois do dia 30 (completo). Antes do dia 7 o
  relatório avisa que não dá para falar de estabilidade.

## Como rodar (dois comandos)

No VPS (ou onde estiver o banco), com o projeto:

```bash
node server/dist/cli.js export-events --config fingerprint/config/config.json --tenant fastvistos --out dataset.jsonl
node server/dist/cli.js eval dataset.jsonl --out relatorio.md --json relatorio.json
```

(`yarn build` antes, uma vez.) O `dataset.jsonl` não contém endereços IP em claro nem dados pessoais. O `relatorio.md` é o que
você lê.

## Depois: ajustar e avaliar o motor de identificação

Com o dataset em mãos (idealmente algumas centenas de aparelhos), além do relatório do hash original:

```bash
node server/dist/cli.js fit-model dataset.jsonl --out model.json      # aprende os parâmetros
node server/dist/cli.js eval-identity dataset.jsonl --model model.json --out identidade.md
```

O `eval-identity` compara o motor com o hash original **na ordem em que as visitas aconteceram**. Duas medidas importam:
"estabilidade" (o mesmo aparelho manteve o mesmo id) e "colisão" (aparelhos diferentes receberam o mesmo id). **Avalie em
dados que não foram usados no ajuste**: o relatório avisa quando o modelo está sendo julgado nos próprios dados de
treino. O limiar de decisão (`matchProbability` no arquivo do modelo) é uma escolha sua: mais alto cria mais ids novos
(deixa passar fraude), mais baixo mistura mais pessoas (acusa quem não devia). Depois de decidir, aponte o servidor para o
arquivo com `"identity": { "modelFile": "/config/model.json" }`.

## Como ler o relatório

**Leia os "Avisos" no topo primeiro.** Eles dizem o quanto confiar nos números. Depois:

| Termo | Em português | Quer dizer |
|---|---|---|
| **FNMR** | "o mesmo aparelho virou outro" | Quantas vezes o sistema falhou em reconhecer um aparelho que já tinha visto. Quanto menor, mais **estável**. |
| **FMR** | "dois aparelhos viraram um" | Quantas vezes confundiu aparelhos diferentes. É a **colisão**. Quanto menor, melhor. |
| **IC 95%** | "a faixa honesta" | O número verdadeiro está provavelmente dentro dessa faixa. Faixa larga = poucos dados. "0% a 100%" = nada se pode afirmar. |
| **AUC** | nota de 0 a 1 | 1 separa perfeitamente os aparelhos; 0,5 é chute. |
| **Tabela por tempo** | | Mostra se erra mais depois de dias. É a curva de estabilidade. |
| **Unicidade** | | Quantos aparelhos têm um identificador que só eles têm. |

O que o relatório **não** diz: ele não prova que o sistema acerta "99%". Para afirmar uma taxa de falso match muito baixa
são precisos milhares de aparelhos; com voluntários mede-se a estabilidade e se veem colisões concretas. O protocolo explica.

## Quando alguém desistir

`node server/dist/cli.js delete-linked --config fingerprint/config/config.json --tenant fastvistos --linked-id p07.iphone-safari`
para cada aparelho dessa pessoa. Depois, confira com `export-events` que não sobrou nada.

## E depois

Mande-me (ou cole aqui) o `relatorio.md`. Ele não tem IPs nem dados pessoais. Com os números reais eu começo a Fase 3, o
matching que reconhece o aparelho mesmo quando um sinal muda. Sem dados reais eu não calibro nada.
