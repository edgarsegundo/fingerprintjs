# Fase 2: servidor de ingestão e sinais de rede

Status: concluída com ressalvas. Branch `fase-2-ingestao`, nada commitado. Código em [server/](../../../server/README.md).

## O que foi feito

Um servidor Node 22 em TypeScript, sem dependência de execução, que recebe o payload do coletor, soma o que só um servidor enxerga e guarda o evento. Ele ainda **não decide quem é o visitante** (Fase 3). O navegador só recebe um `requestId`.

| Parte | O que faz | Onde |
|---|---|---|
| Ingestão | `GET /v1/nonce`, `POST /v1/collect`, `GET /v1/events/:id`, `GET /healthz`. Validação estrita do payload, limite de corpo, limite de taxa, CORS por tenant | `server/src/app.ts`, `ingest/` |
| Anti-replay básico | Nonce assinado (HMAC), amarrado ao tenant, de uso único, com validade | `ingest/nonce.ts` |
| Multi-tenant desde já | Chave pública no navegador, chaves secretas guardadas só como hash, leitura sempre escopada ao tenant | `config.ts`, `store/` |
| IP | IP do visitante com `X-Forwarded-For` aceito só de proxy confiável e lido da direita. Prefixo /24 ou /64. Rótulos por listas de CIDR do operador | `net/` |
| TLS | JA4 do visitante: um front TCP lê o ClientHello de cada conexão e repassa os bytes intactos ao servidor HTTPS interno | `tls/` |
| Cabeçalhos e HTTP/2 | Ordem e escrita dos nomes, impressão própria; configurações HTTP/2 e ordem dos pseudo-cabeçalhos | `net/headers.ts`, `net/http2.ts` |
| Armazenamento | Interface `EventStore` com memória e SQLite (`node:sqlite`), retenção que apaga eventos antigos | `store/` |
| Operação | Dockerfile (usuário sem privilégios, volume em `/data`), CLI para criar tenant, job de CI | `server/Dockerfile`, `server/src/cli.ts`, `.github/workflows/test.yml` |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor (`yarn server:test`) | 134 de 134 |
| JA4 contra a especificação do FoxIO | o exemplo oficial (`t13d1516h2_8daaf6152771_e5627efa2ab1`), a variante sem algoritmos de assinatura (`6d807ffa2a79`) e os 8 exemplos de ALPN batem |
| JA4 contra um Chrome real (155) | o hash de cifras `8daaf6152771` é o mesmo que o FoxIO publica para o Chrome. O resto difere porque o Chrome 155 tem 18 extensões, mais que a versão do exemplo |
| Teste de mutação | 12 defesas quebradas de propósito (spoofing de IP, isolamento entre tenants, reuso de nonce, nonce sem tenant, nomes de protótipo, GREASE, limite de corpo, chave secreta, vazamento do registro, limite de taxa, CORS). Todas fazem a suíte falhar. Quatro mutações iniciais nem compilavam e foram refeitas |
| Ponta a ponta com Chrome real | Página em uma origem, servidor TLS em outra, CORS com credenciais: 42 + 7 sinais, JA4, HTTP/2, `requestId` devolvido, evento lido com a chave secreta |
| Contêiner | Imagem constrói, roda como `node`, responde por TLS, grava no volume e mantém os dados após reiniciar |
| Lint, build, `check:dts`, `check:ssr`, testes do navegador | verdes |

## O que a revisão achou (e foi corrigido)

- **Crítico, no modo TLS:** o servidor interno só enxerga a conexão do front, então o IP de todo visitante seria `127.0.0.1`. Todos dividiriam o mesmo limite de taxa. Nenhum teste pegava porque todos os clientes eram locais. Corrigido para usar o endereço que o front viu. Três testes novos falham se o defeito voltar, incluindo um com um visitante real em IPv6.
- **Maior, configuração:** `requireNonce` aceitava qualquer valor e tratava `"false"` entre aspas como desligado. Agora só aceita booleano de verdade e o servidor não sobe com valor torto.
- **Vazamento no registro de conexões:** `localPort` vira `undefined` depois que o socket fecha, então as entradas nunca eram apagadas. Achado por um teste, corrigido.

## Dados reais de referência (uma observação, não uma estatística)

Chrome 155 headless em macOS, HTTP/2 sobre TLS 1.3:

- JA4 `t13d1518h2_8daaf6152771_e2d80978ab2e`. O curl da mesma máquina dá `t13i4906h2_0d8feac7bc37_7395dae3b2f3`.
- Configurações HTTP/2: tabela de cabeçalhos 65536, janela 6291456, lista de cabeçalhos 262144, pseudo-cabeçalhos `masp`.
- Ordem dos cabeçalhos: começa com `content-length`, `sec-ch-ua-platform`, `user-agent`, `sec-ch-ua`.

## Decisão sobre o seu nginx (importante)

Li `reverse-proxy-config/docker-compose.yml`, `nginx.conf` e `stream.d/`. O nginx é o `macbre/nginx-http3`, termina o TLS dos sites na 443 e já usa `stream` para MQTT. Atrás dele, o meu servidor não enxerga o ClientHello do visitante, e a ordem de cabeçalhos e o HTTP/2 passam a ser os do nginx. Por isso o servidor marca `viaProxy` e as fases seguintes não devem comparar essas impressões nesse caso.

**Recomendação:** rodar o servidor em modo direto, num hostname próprio e numa porta livre (por exemplo `fp.seudominio.com:8443`), sem mexer no nginx nem nos sites. O detalhe e um trecho de `docker-compose.yml` estão em [server/README.md](../../../server/README.md). **Nada foi alterado no repositório `reverse-proxy-config`.** Usei a sua permissão só para ler.

## O que NÃO foi verificado (ressalvas)

- Implantação num VPS Linux de verdade. Em especial: se o Docker preserva o IP do visitante (aqui o IP era local), permissões da chave do Let's Encrypt e firewall.
- Firefox e Safari falando TLS com o servidor. Só Chrome e curl foram testados.
- Carga: nenhum teste de desempenho nem de muitas conexões lentas. O front guarda até 64 KB por conexão esperando o ClientHello.
- O job de CI novo não foi executado (só existe no GitHub).
- `node:sqlite` é experimental no Node e imprime um aviso na inicialização.

## Limites de projeto que ficam para as próximas fases

- Cada evento guarda o payload inteiro (cerca de 45 KB); um milhão de eventos no prazo de retenção são dezenas de GB. A Fase 3 precisa tirar as imagens do canvas de cada linha.
- Um certificado só por servidor; escolher por nome (SNI) fica para o proxy de primeira parte (Fase 6).
- PROXY protocol não é lido; chave de nonce sem rotação; limites de taxa por processo (Fase 8).
- O nonce prova o fluxo, não a honestidade. Resultado selado é a Fase 4.

## Antes de começar a Fase 3

1. A Fase 0 (harness e linha de base) ainda não existe. O matching não se calibra sem dados rotulados.
2. Decidir o banco: SQLite não serve para busca por similaridade em escala. O VPS já tem MySQL 8; se ele atende a busca de vizinhos mais próximos é algo a verificar antes de decidir, não um fato aqui.
