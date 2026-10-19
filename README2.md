# Guia de leitura do repositório
Quem é este visitante?

https://claude.ai/artifact/G3rZdgagmDezxPvbfthMmA

# Rodar e testar localmente

Precisa de Node 22 e Python 3. Tudo roda na sua máquina, com SQLite. Nada sai dela.

**1. Instalar e compilar (só na primeira vez)**

```bash
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --ignore-engines
npx --yes yarn@1.22.22 build          # o script do navegador, em dist/
npx --yes yarn@1.22.22 server:build   # o servidor, em server/dist/
```

**2. Preparar o teste** (cria `server/data/config.json` com um tenant de teste e mostra as chaves e o endereço da página)

```bash
node tools/local-test/setup.js
```

**3. Terminal 1: subir o servidor** (porta 8080)

```bash
node server/dist/main.js server/data/config.json
```

Deve aparecer `"route":"started"`. O aviso `ExperimentalWarning` do SQLite é normal.

**4. Terminal 2: servir a página de teste** (porta 8081, na raiz do repositório)

```bash
python3 -m http.server 8081 --bind 127.0.0.1
```

**5. Enviar visitas.** Abra no Chrome ou no Firefox, em janela normal, o endereço `Test page:` que o passo 2 imprimiu (termina em `?k=pk_...`). Marque a caixa do código guardado e clique **Send a visit** duas vezes. Cada clique mostra um `requestId`.

**6. Ver o resultado** (troque `sk_...` pela `Secret key:` do passo 2)

```bash
curl -s -H "Authorization: Bearer sk_..." "http://127.0.0.1:8080/v1/events?limit=5"
```

Esperado: duas visitas com o **mesmo** `visitorId`, a mais antiga com `"matched": false` (aparelho novo) e a mais nova com `"matched": true` (reconhecido). Para ver tudo de uma visita (identidade e sua explicação, risco, adulteração, ambiente):

```bash
curl -s -H "Authorization: Bearer sk_..." http://127.0.0.1:8080/v1/events/<requestId>
```

**7. Experimentos rápidos**
- Abra a mesma página em **outro navegador**: o `visitorId` é outro, porque os sinais são outros.
- No mesmo navegador, apague os dados do site e envie de novo com a caixa marcada: sem o código guardado, o servidor ainda reconhece pelos outros sinais.
- Desmarque a caixa: a visita não manda o código, e `payload.extended.storedId` some do evento.

**8. Parar e limpar.** `Ctrl+C` nos dois terminais. Para recomeçar do zero: `rm -rf server/data` e rode o passo 2 de novo.

## Se algo não sair como esperado

| Sintoma | Causa provável |
|---|---|
| As duas visitas aparecem como `matched: false` | O navegador foi marcado como adulterado (por exemplo, janela headless ou uma extensão). Olhe `tamper.signals` no evento: uma evidência alta faz a visita **não ensinar** o motor. Use uma janela normal. |
| `Failed: TypeError: Failed to fetch` na página | Abra pelo endereço exato `http://127.0.0.1:8081/...` (não `localhost`). O tenant só aceita essa origem. |
| `Open this page with ?k=...` | Faltou o `?k=<public key>` no endereço. |
| `EADDRINUSE` ao subir | Porta ocupada: `kill $(lsof -tiTCP:8080 -sTCP:LISTEN)` (ou 8081). |
| `last-events` mostra `ja4=-` e `WARNING=looks-like-a-container-or-local-address` | Esperado em `127.0.0.1`: não há JA4 nem IP real. Isso só aparece num servidor de teste fora da sua máquina. |

## O que este teste não mostra

Não há JA4, IP real nem ordem de cabeçalhos do visitante (isso exige um servidor com hostname e porta próprios), e os parâmetros do motor são provisórios, então `calibrated` é `false` e não existe probabilidade. O resultado serve para ver o sistema funcionando, não para medir acerto.

Para repetir com MySQL, troque `databasePath` por `database` no `server/data/config.json` (veja `server/README.md`) e passe a senha em `FP_MYSQL_PASSWORD`.
