# Detectar o bloqueio da porta 8443 e do coletor: aviso de falha, carregador, receptor, ASN e LGPD

Palavras-chave: porta 8443 bloqueada, rede que só libera a 443, firewall de empresa, bloqueador de rastreamento, uBlock, Brave Shields, coletor inalcançável, carregador (`fp-loader`), `FpLoader`, sonda `no-cors`, `sendBeacon`, aviso de falha, receptor de avisos, `reachability-receiver`, `reachability-summary`, ASN, operadora, prefixo com chave (HMAC), sem IP, LGPD, retenção, `script_unreachable`, `script_blocked`, first-party, `id.empregoaqui.com.br`, `app.empregoaqui.com.br`.

Escrito em 2026-10-19. Responde à pergunta: "dá para detectar os visitantes cuja rede não aceita a porta 8443 e registrar quantos são?". Dá, e isto está implementado e testado. Para **instalar**, siga a Parte H de `instalar-na-vps-passo-a-passo-id-empregoaqui-com-br-docker-tls-mysql-certificado-letsencrypt-coletor-no-pwa-fase-de-observacao.md`. Este documento explica **como funciona, o que é guardado, o que não se sabe**. Decisões: **D96 a D99** em `decisoes.md`. O contrato do carregador (em inglês) está em `docs/collector.md`, seção "Loader". Se a medição mostrar que o problema é grande, as rotas para usar a 443 estão em `usar-a-porta-443-para-o-fingerprint-sem-derrubar-o-nginx-sni-stream-ssl-preread-proxy-protocol-segundo-ip-opcoes-e-riscos.md`.

## 1. O problema, em uma frase

Quando a rede do visitante bloqueia a porta 8443, **a conexão não chega ao servidor**, então o servidor nunca vê a falha. Quem sabe é o JavaScript da página do visitante. E o script do coletor, que é entregue pelo próprio servidor na 8443, **também não carrega** nessa rede. Um script que não carregou não pode avisar de nada.

## 2. A ideia

```
Página do PWA (app.empregoaqui.com.br, porta 443)
   │
   ├─ carrega fp-loader.min.js            ← vem do PWA, então sempre existe (cerca de 6 KB)
   │
   └─ FpLoader.start(...)
        1. carrega o coletor em id.empregoaqui.com.br:8443
        2. pede o desafio, coleta, envia
        3. se algo falhar:
             sonda  GET https://id.empregoaqui.com.br:8443/healthz   (no-cors)
                 conexão funcionou  → o servidor está de pé: bloqueador, regra, origem
                 conexão falhou     → rede bloqueando, ou servidor fora do ar
             classifica e manda UM aviso, por aba, para  /fp-report  (no próprio PWA, porta 443)
                                                              │
                                  nginx do PWA ───────────────┘
                                                              ▼
                                  [fp-report]  reachability-receiver  →  SQLite (sem IP)
                                                              │
                                  reachability-summary  ←─────┘   o resumo, em português
```

Dois pontos de projeto:

- **O carregador é um arquivo separado**, servido pelo site do cliente. É a única forma de ele existir quando a porta está bloqueada.
- **O aviso vai para o próprio site**, na porta 443, que é a que a rede do visitante já deixa passar (ele acabou de carregar o PWA por ela).

## 3. Os motivos, e como ler cada um

| Motivo | Quando | Leitura provável | Trocar de porta ajuda? |
|---|---|---|---|
| `script_unreachable` | O script do coletor não carregou **e** a sonda falhou | Porta 8443 bloqueada pela rede, ou servidor fora do ar | **Sim**, se for a rede |
| `script_blocked` | O script não carregou **mas** a sonda funcionou | Bloqueador de rastreadores, política de conteúdo, regra de caminho | Não. Mudar o nome do script (`collectorPath`) pode ajudar |
| `script_broken` | O script carregou, mas não é o coletor | Arquivo ou versão errada | Não |
| `request_unreachable` | O script carregou, o pedido não passou, a sonda falhou | O mesmo que `script_unreachable`, mais tarde na sequência | Sim, se for a rede |
| `request_blocked` | O script carregou, o pedido falhou, a sonda funcionou | Bloqueador; **chave pública errada**; **origem fora de `allowedOrigins`** | Não |
| `timeout` | O pedido passou do tempo limite (8 s por padrão) | Rede lenta ou servidor sobrecarregado | Talvez |
| `server_refused` | O servidor respondeu 4xx (o `status` fica guardado) | 401 chave, 403 origem ou tenant suspenso, 422 consentimento, 429 limite | Não: é configuração |
| `server_error` | O servidor respondeu 5xx, ou algo que não é o que ele manda | O servidor com problema | Não |
| `collect_error` | A leitura dos sinais falhou no navegador | Navegador incomum | Não |
| `ok` | Uma visita que deu certo (só se `successSampleRate` for maior que 0) | Serve de denominador | |

**Por que `request_blocked` junta tanta coisa:** quando a chave é errada ou a origem não é permitida, o servidor responde **sem os cabeçalhos de CORS**, e o navegador, em vez de mostrar o 401 ou 403, só diz "falhou". É o mesmo sintoma de um bloqueador. Se aparecer logo depois de instalar, confira a chave e `allowedOrigins`.

## 4. O que o carregador manda, e o que não

Um aviso é um JSON de menos de 600 bytes:

```json
{ "v": 1, "reason": "script_unreachable", "phase": "script", "probe": "unreachable",
  "elapsedMs": 3120, "online": true, "connection": "4g", "site": "pk_..." }
```

- **Manda:** o motivo, a fase (`script`, `nonce`, `collect`, `send`), o resultado da sonda (`reachable`, `unreachable`, `skipped`), o tempo gasto, se o navegador diz estar online, o tipo de conexão que ele declara (`4g`, `3g`...), o status HTTP quando houve, e a chave **pública** do tenant (só para separar sites).
- **Não manda:** o `linkedId`, o e-mail, a URL da página, cookies, qualquer sinal do fingerprint, nem o IP (o IP o receptor vê pela conexão, e não grava).
- **Um aviso por aba** (guardado no `sessionStorage`). Um visitante que abre dez abas conta dez vezes, e isso está dito na seção de limites.
- **Aparelho sem internet** (`navigator.onLine === false`) **não manda**: não é uma rede que bloqueia o servidor.
- Envio por `navigator.sendBeacon` (sobrevive ao fechar a aba), com `fetch` com `keepalive` de reserva. O carregador nunca lança erro, nunca rejeita a promessa e nunca espera nada de que a página precise.

## 5. O receptor

Mesma imagem Docker do servidor, comando `reachability-receiver`. Um processo pequeno, sem dependência, que grava em SQLite.

```bash
node dist/cli.js reachability-receiver --db /data/reach.db --host 0.0.0.0 --port 8090 \
  --allowed-origin https://app.empregoaqui.com.br --trust-forwarded-from 172.18.0.0/16 --keep-days 90
```

| Opção | Para que serve |
|---|---|
| `--db` | O arquivo SQLite (obrigatório). Ao lado dele fica `reach.db.secret`, a chave do resumo do bloco de IP, criada na primeira partida com permissão só do dono. |
| `--port`, `--host`, `--path` | Onde escuta. Padrões: 8090, `127.0.0.1`, `/report`. Dentro do Docker, use `--host 0.0.0.0` e **não publique a porta**: só o nginx fala com ele. |
| `--allowed-origin a,b` | Os `Origin` aceitos. Sem a opção, qualquer um. |
| `--trust-forwarded-from faixas` | Os proxies cujo `X-Forwarded-For` vale (o nginx). Sem a opção, só vale o endereço da conexão. |
| `--asn-file ...` | A tabela opcional de redes (seção 7). |
| `--keep-days` | Retenção, de 1 a 3650. Padrão 90. Roda na partida e a cada hora. |
| `--rate-per-ip`, `--rate-total` | Avisos por minuto por endereço (padrão 30) e no total (600). |
| `--secret-file` | Onde fica a chave do resumo. Padrão `<db>.secret`. |

Como é um ponto **público e sem chave**, ele é construído para custar pouco e guardar pouco:

| Defesa | Prova |
|---|---|
| Corpo de no máximo 4 KB | Teste com corpo de 10 KB: 413, nada gravado |
| Formato fechado: motivo e fase de listas, números em faixas, campos a mais jogados fora | Testes com entradas hostis e teste de mutação |
| `Origin` conferido (sem ele, 403) | Mutação |
| Limite por endereço (IPv6 pelo /64), depois limite total; **a ordem importa**: um inundador recusado não gasta a cota dos outros | Mutação (inverter a ordem derruba o teste) |
| `X-Forwarded-For` só de proxy confiável, lido da direita | Teste com cliente que não é `127.0.0.1`; mutação (acreditar sempre derruba o teste) |
| Nada que veio do visitante volta na resposta, e o IP não aparece em nenhuma | Teste |
| Tempo limite de cabeçalho e de pedido de 10 s, até 50 cabeçalhos | |
| A chave do resumo é criada com permissão 0600 | Mutação |

## 6. O que fica guardado, e a LGPD

| Guardado | Não guardado |
|---|---|
| Motivo, fase, sonda, tempo, status, online, tipo de conexão, chave pública do tenant | **O endereço IP, inteiro ou truncado** |
| Família do navegador e se é celular | O `User-Agent` |
| Número e nome da rede (só com arquivo de redes) | URL, cookies, `linkedId`, e-mail |
| `prefix_hash`: `HMAC-SHA256(chave, /24 ou /64)`, 64 bits | O bloco de IP em claro |

Sobre o `prefix_hash`: serve para contar **quantas redes diferentes** aparecem, sem guardar o endereço. Quem tem só o banco não consegue voltar ao bloco de IP, **porque não tem a chave**. Mas a chave fica ao lado do banco por padrão, para funcionar sem configuração; quem quiser separar põe `--secret-file` em outro lugar. Um bloco /24 do IPv4 tem só 16 milhões de valores: com a chave e o banco juntos, dá para testar blocos. Por isso o documento não afirma "anonimização": **é pseudonimização**, e o IP em claro nunca é gravado.

**O que dizer na política de privacidade** (rascunho; a revisão jurídica continua adiada, a pedido do dono): quando o script de prevenção a fraude não consegue ser carregado, registramos o motivo da falha, o tipo de navegador, e um código que identifica a faixa de rede (sem o endereço IP), por até 90 dias, para medir e corrigir problemas de acesso. Base legal a avaliar: legítimo interesse (LGPD, art. 7º, IX), com o mesmo teste da LIA do projeto (`docs/plano/privacidade/`). Aqui o receptor **não** guarda dado que o visitante forneceu, e a finalidade é técnica.

## 7. O arquivo de redes (ASN), opcional

Sem arquivo, o resumo mostra as redes como `prefix 3fa9...`. Com um arquivo de faixas de IP, mostra `AS28573 CLARO S.A.`.

- **O projeto não traz o dado** e não presume o formato de nenhum provedor. Você baixa um arquivo, **confere a licença dele**, e diz ao receptor em que coluna está cada coisa (contando de 0): `--asn-from`, `--asn-to` (omita se a faixa vem em CIDR), `--asn-number`, `--asn-name`. Pode dar só o número, só o nome, ou os dois.
- Uma coluna errada, uma faixa invertida ou duas faixas que se sobrepõem **impedem a partida**, com o número da linha. É melhor que subir e não achar nada.
- Só o **número e o nome** da rede entram no banco. O nome é limpo de caracteres de controle e cortado em 80.
- Um arquivo de IP é tão bom quanto quem o fez. Redes móveis, VPN e redes de empresa saem erradas com frequência.

## 8. O resumo

```bash
node dist/cli.js reachability-summary --db /data/reach.db --days 30 [--utc-offset -3] [--json]
```

Imprime, em português: avisos recebidos, visitas que não chegaram ao coletor, tabela por motivo, resultado da sonda, navegador e celular (só entre as falhas), status HTTP das recusas, **hora do dia** (com barras), as redes que mais aparecem (com o número de prefixos distintos), e "como ler" com os limites. A hora do dia é para distinguir uma rede bloqueando de um servidor fora do ar: no segundo caso o pico aparece em **todas** as redes ao mesmo tempo.

## 9. Como verificar que funciona

Feito em 2026-10-19:

| O quê | Resultado |
|---|---|
| Testes do servidor (receptor, validação, ASN, resumo, partida) | 37 testes, passam |
| Testes do navegador (`yarn test:local`), incluindo o carregador | 283 em Chrome e Firefox, passam |
| **Teste de mutação** no receptor, na validação, na tabela de redes e no armazenamento | 23 mutantes, **todos mortos** |
| **Teste de mutação** no carregador (sonda, uma vez por aba, offline, nunca lançar, status, tempo limite, reserva do aviso, amostragem) | 15 mutantes, **todos mortos** |
| Ponta a ponta com **Chrome de verdade**, o servidor de fingerprint, o receptor e um "PWA" local fazendo o papel do nginx | `ok`, `script_unreachable` (porta fechada), `script_blocked` (caminho do script inexistente) e `request_blocked` (chave errada), cada um no resumo |
| Imagem Docker (`typescript 5.1.6`, a da imagem) | Compila, o receptor sobe `healthy`, 403 sem `Origin`, 204 com |
| Receptor com arquivo de redes pela CLI e requisições HTTP reais | Redes achadas por número e nome; layout errado recusado na partida |
| Banco do receptor nunca contém o IP, o `User-Agent` ou o `linkedId` | Teste automático |

**Não foi verificado:**

- **Safari (Mac e iPhone).** Nem os testes automáticos nem o ponta a ponta rodaram nele. O receptor exige o `Origin`; todos os navegadores principais o mandam em `POST`, mas isso não foi visto no Safari.
- **Uma rede que bloqueia a 8443 de verdade.** O "bloqueado" do ponta a ponta é uma porta local fechada (recusa imediata). Uma rede que **descarta** os pacotes, em vez de recusar, cai no tempo limite (8 s para o script, 4 s para a sonda). A reação a esse tempo limite foi testada só com um ambiente simulado, e a sonda com um pedido que nunca responde e é cortado pelo sinal de cancelamento. Num navegador real, com pacotes descartados, não foi visto.
- **O nginx e a VPS reais.** O "PWA" do teste faz o papel do nginx; o bloco `location = /fp-report` do guia **não foi executado** no seu nginx.
- **O ASN com um arquivo de um provedor real.** Testado com arquivos que escrevi.

## 10. Limites

- A causa é uma **estimativa**. A sonda separa "a conexão funciona" de "não funciona", não o motivo exato.
- Contam-se **avisos**, não visitantes. Um aviso por aba. O denominador é a sua contagem de cadastros, ou a amostra `ok` (`successSampleRate`).
- **Não aparecem:** quem bloqueia o próprio carregador, quem fecha a aba antes do aviso, quem está sem internet, e quem tem o aviso barrado (improvável, é o mesmo site do PWA).
- **O endereço é público.** O limite total (600 por minuto) e a retenção de 90 dias seguram o banco, mas um ataque contínuo ao limite daria perto de 100 a 200 MB por dia. Baixe `--rate-total` e `--keep-days` se o seu tráfego for pequeno. O `Origin` só barra abuso casual.
- O resultado diz **onde o servidor não é alcançado**. Não diz nada sobre a precisão do fingerprint.
- Se um dia houver mais de um site apontando para o mesmo receptor, o campo `site` os separa, mas o resumo ainda não filtra por ele.

## 11. Arquivos

| Arquivo | Papel |
|---|---|
| `src/loader/loader.ts`, `index.ts`, `loader.test.ts` | O carregador e seus testes (Karma) |
| `rollup.config.ts` | Gera `dist/fp-loader.js` e `dist/fp-loader.min.js` (global `FpLoader`) |
| `server/src/reachability/report.ts` | Validação estrita do aviso e a família do navegador |
| `server/src/reachability/receiver.ts` | O servidor HTTP: limites, origem, IP confiável, rede, resumo com chave |
| `server/src/reachability/store.ts` | SQLite e as consultas do resumo |
| `server/src/reachability/summary.ts` | O texto do resumo |
| `server/src/reachability/run.ts` | A partida: banco, chave, redes, limpeza, parada |
| `server/src/net/asn.ts` | A tabela de redes, no modelo de `geo.ts` |
| `server/src/cli.ts` | Os comandos `reachability-receiver` e `reachability-summary` |
