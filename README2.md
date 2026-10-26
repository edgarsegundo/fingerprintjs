# Guia de leitura do repositório
Quem é este visitante?

https://claude.ai/artifact/G3rZdgagmDezxPvbfthMmA

# Rodar e testar localmente

## Jeito fácil: o guia interativo (um terminal só)

```bash
node tools/local-test/guide.js
```

O guia faz tudo por você, passo a passo, e **pergunta antes de cada passo**: explica o que é e por que importa, liga o servidor e a página de teste em segundo plano, abre o Chrome e o Firefox (no Mac) com o endereço certo, diz o que clicar, lê o resultado sozinho (a chave secreta é lida de um arquivo local, você não copia nada) e diz com `OK` ou `ATENÇÃO` se o resultado é o esperado. Ao sair, ele desliga o que ligou.

- Responda **Enter** para sim, **n** para pular o passo, **q** para sair.
- Antes de rodar, pare qualquer servidor ou página de teste que você tenha deixado aberto em outro terminal (`Ctrl+C` neles). O guia avisa se as portas 8080 ou 8081 estiverem ocupadas.
- Se já houver dados de uma rodada anterior, o guia pergunta se quer apagar e recomeçar do zero. Se apagar, apague também os dados do site `127.0.0.1` no Chrome e no Firefox.
- A parte do navegador (clicar em "Send a visit") é sua. O resto o guia faz.
- Para ver a lista de visitas a qualquer hora, com o servidor ligado: `node tools/local-test/check.js`.

## Jeito manual (os mesmos passos, sem o guia)


Siga os passos **na ordem, do 1 ao 21**. Cada passo diz **onde** fazer (Terminal 1, 2 ou 3, Chrome, Firefox), **o que fazer** e **o que você deve ver**. Não pule passos e não precisa copiar chaves nem códigos.

Precisa de Node 22 e Python 3. Tudo roda na sua máquina, com SQLite. Nada sai dela.

**Os três terminais.** Você vai usar três janelas de terminal, todas abertas na pasta do projeto (`/Users/edgar/Repos/fingerprintjs`):
- **Terminal 1:** vai ficar rodando o servidor.
- **Terminal 2:** vai ficar rodando a página de teste.
- **Terminal 3:** é onde você consulta os resultados.

---

## Parte 1: preparar (só na primeira vez)

### Passo 1 (Terminal 1): instalar e compilar

```bash
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --ignore-engines
npx --yes yarn@1.22.22 build
npx --yes yarn@1.22.22 server:build
```

Pode levar alguns minutos. **Você deve ver:** `Done in ...` no fim de cada um.

### Passo 2 (Terminal 1): criar o tenant de teste

```bash
node tools/local-test/setup.js
```

**Você deve ver** algo assim (as chaves do seu terminal serão diferentes):

```
Public key: pk_3uingDYtAMht4b3cdMhXQDVZ
Secret key: sk__dyJwuK0gYAUQPmQvg2c4c4i--U-jprRjlEb6jCYu9s

Test page:  http://127.0.0.1:8081/tools/local-test/index.html?k=pk_3uingDYtAMht4b3cdMhXQDVZ
See the visits:  node tools/local-test/check.js
```

A linha importante é **`Test page:`**. O endereço que vem depois dela é o que você vai abrir no navegador nos passos 6, 10, 12 e 21. Se a tela for limpa, rode o passo 2 de novo: ele só imprime isso outra vez e não muda nada.

---

## Parte 2: ligar (toda vez que for testar)

### Passo 3 (Terminal 1): subir o servidor

```bash
node server/dist/main.js server/data/config.json
```

**Você deve ver:** a última linha com `"route":"started","port":8080`. O aviso `ExperimentalWarning` do SQLite é normal. **Deixe este terminal aberto e rodando.**

### Passo 4 (Terminal 2): servir a página de teste

Abra uma segunda janela de terminal na pasta do projeto e rode:

```bash
python3 -m http.server 8081 --bind 127.0.0.1
```

**Você deve ver:** `Serving HTTP on 127.0.0.1 port 8081`, e depois nada. É assim mesmo. **Deixe este terminal aberto e rodando.**

### Passo 5 (Terminal 3): abrir o terceiro terminal

Abra uma terceira janela de terminal na pasta do projeto. Nada a rodar ainda. Ela será usada a partir do passo 7.

---

## Parte 3: testes

### Passo 6 (Chrome): primeira visita

1. Abra o **Chrome**, em janela normal.
2. Cole na barra de endereço o endereço da linha `Test page:` do passo 2 e tecle Enter.
3. Marque a caixa **"Use the code stored in the browser"**.
4. Clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 1 sent.` e uma linha `requestId: ...`.

### Passo 7 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver** (os códigos serão outros):

```
Visitas guardadas (a mais nova primeiro):
  #1  aparelho A  NOVO         adulteração: nenhuma  (6b46259b)
Aparelhos diferentes: 1 (A)

Detalhe da visita #1:
  aparelho: A (v_...)
  reconhecido: não, é um aparelho novo para o servidor
  motivos: nenhum aparelho conhecido para comparar
  código guardado: CRIADO agora (nenhum lugar tinha)
```

Isso quer dizer: o servidor nunca tinha visto esse navegador, então o chamou de **aparelho A**, e o navegador criou o código guardado.

### Passo 8 (Chrome, a mesma aba): segunda visita

Na mesma aba do passo 6, com a caixa ainda marcada, clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 2 sent.`

### Passo 9 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver:**

```
Visitas guardadas (a mais nova primeiro):
  #1  aparelho A  RECONHECIDO  adulteração: nenhuma  (...)
  #2  aparelho A  NOVO         adulteração: nenhuma  (...)
Aparelhos diferentes: 1 (A)

Detalhe da visita #1:
  aparelho: A (v_...)
  reconhecido: sim
  motivos ...:
    agree    storedId           12.0
    ...
  código guardado: já existia (achado em cookie, localStorage, ...)
```

A visita nova foi reconhecida como o **mesmo aparelho A**, e o motivo principal é o código guardado (`storedId`).

### Passo 10 (Chrome, uma aba nova): terceira visita

1. No mesmo Chrome, abra uma **aba nova**.
2. Cole o mesmo endereço da linha `Test page:` e tecle Enter.
3. Marque a caixa e clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 1 sent.` (a contagem recomeça em cada aba; é normal).

### Passo 11 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver:** 3 visitas na lista. A `#1` é `aparelho A  RECONHECIDO`. O código guardado é do navegador, não da aba, por isso outra aba é o mesmo aparelho.

### Passo 12 (Firefox): outro navegador, o mesmo computador

1. Abra o **Firefox**, em janela normal.
2. Cole o mesmo endereço da linha `Test page:` (começa com `http://127.0.0.1:8081`; **não** troque por `localhost`) e tecle Enter.
3. Marque a caixa e clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 1 sent.`

### Passo 13 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver:** 4 visitas. A `#1` é **`aparelho B  NOVO`**, e a linha `Aparelhos diferentes: 2 (A, B)`. O Firefox tem outro código guardado e outros sinais (placa de vídeo, fontes), então o servidor **não** o confunde com o Chrome.

### Passo 14 (Firefox): segunda visita

No Firefox, clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 2 sent.`

### Passo 15 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver:** 5 visitas. A `#1` é `aparelho B  RECONHECIDO`.

### Passo 16 (Chrome): apagar os dados do site

1. No Chrome, abra qualquer aba.
2. Vá em **Configurações > Privacidade e segurança > Cookies e outros dados do site > Ver todos os dados e permissões do site**.
3. Procure **`127.0.0.1`** e apague.

(Alternativa: na aba da página de teste, abra as ferramentas do desenvolvedor com F12, aba **Application**, item **Storage**, botão **Clear site data**.)

Isso apaga o código guardado do Chrome.

### Passo 17 (Chrome): visita sem o código guardado

1. Na aba da página de teste, **recarregue a página** (F5).
2. Marque a caixa e clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 1 sent.`

### Passo 18 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver:** `código guardado: CRIADO agora`, porque o navegador fez um código novo. Dois resultados são válidos:
- **Provável:** `#1  aparelho A  RECONHECIDO`, com `storedId` aparecendo como `disagree` (peso pequeno) e **não** como motivo principal. O servidor reconheceu o Chrome pelos outros sinais.
- **Também válido:** `#1  aparelho C  NOVO`. Sem o código e com poucos aparelhos conhecidos, os outros sinais podem não bastar para a certeza exigida (0,99).

### Passo 19 (Chrome): visita sem marcar a caixa

Na mesma aba, **desmarque** a caixa e clique **uma vez** em **Send a visit**.

**Você deve ver:** `Visit 2 sent.`

### Passo 20 (Terminal 3): consultar

```bash
node tools/local-test/check.js
```

**Você deve ver:** `código guardado: não enviado nesta visita`. A página não declarou base legal, então o navegador nem leu nem enviou o código.

### Passo 21 (Chrome, janela anônima): opcional

1. Abra uma **janela anônima** do Chrome.
2. Cole o endereço da linha `Test page:`, marque a caixa e clique **uma vez** em **Send a visit**.
3. No Terminal 3, rode `node tools/local-test/check.js`.

**Você deve ver:** `código guardado: CRIADO agora` (o armazenamento é novo). Pode vir `RECONHECIDO` ou `NOVO`, porque o hardware é o mesmo. Não é um bom teste de "outro aparelho".

---

## Resumo do que deve ter acontecido

| Passo | Navegador | O que mudou | Resultado |
|---|---|---|---|
| 7 | Chrome | primeira visita | `aparelho A  NOVO`, código `CRIADO agora` |
| 9 | Chrome, mesma aba | nada | `aparelho A  RECONHECIDO`, motivo `storedId` |
| 11 | Chrome, outra aba | a aba | `aparelho A  RECONHECIDO` |
| 13 | Firefox | o navegador | `aparelho B  NOVO` |
| 15 | Firefox | segunda visita | `aparelho B  RECONHECIDO` |
| 18 | Chrome | dados do site apagados | `aparelho A  RECONHECIDO` (provável), sem `storedId` como motivo |
| 20 | Chrome | caixa desmarcada | `código guardado: não enviado` |

## Parar e limpar

- Para parar: `Ctrl+C` no Terminal 1 e no Terminal 2.
- Para recomeçar do zero: pare o servidor, rode `rm -rf server/data`, rode o passo 2 e o passo 3 de novo, e apague também os dados do site `127.0.0.1` no Chrome e no Firefox (senão o código guardado de antes volta).
- Da próxima vez que for testar, faça só a Parte 2 (passos 3, 4 e 5) e os testes que quiser.

## Se algo não sair como esperado

| Sintoma | O que fazer |
|---|---|
| `check.js` diz "Não consegui falar com o servidor" | O servidor do passo 3 não está rodando. Suba de novo. |
| `check.js` diz "Não achei as chaves" | Rode o passo 2. |
| A visita nova aparece como `NOVO` e o detalhe tem `ATENÇÃO: o navegador foi marcado como adulterado` | Uma extensão ou uma janela headless marcou o navegador. Uma evidência alta faz a visita **não ensinar** o motor. Use uma janela normal e, se preciso, desligue extensões. |
| `Failed: TypeError: Failed to fetch` na página | Abra pelo endereço exato `http://127.0.0.1:8081/...` (nunca `localhost`). |
| A página diz `Open this page with ?k=...` | O endereço ficou sem o `?k=pk_...` do final. Copie de novo a linha `Test page:`. |
| `EADDRINUSE` ao subir o servidor ou a página | Porta ocupada. Rode `kill $(lsof -tiTCP:8080 -sTCP:LISTEN)` (ou `8081`) e suba de novo. |
| O navegador não conecta em `127.0.0.1:8081` | O Terminal 2 (passo 4) não está rodando. |

## O que este teste não mostra

Não há JA4, IP real nem ordem de cabeçalhos do visitante (isso exige um servidor com hostname e porta próprios), e os parâmetros do motor são provisórios, então `calibrated` é `false` e não existe probabilidade. O resultado serve para ver o sistema funcionando, não para medir acerto.

Para repetir com MySQL, troque `databasePath` por `database` no `server/data/config.json` (veja `server/README.md`) e passe a senha em `FP_MYSQL_PASSWORD`.
