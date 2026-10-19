# Fase 8: escala, observabilidade e operação

Status: **código concluído; medidas de carga são de um notebook.** Branch `v5.3.0-fork` (sem commit).

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Contadores da identidade | Aparelhos por valor, totais por característica e por tenant, mantidos por gatilhos do SQLite; busca por valor cobre o id do aparelho; respostas lembradas por decisão | `server/src/identity/sqlite_store.ts` |
| Métricas | `/metrics` (Prometheus), com chave própria. Requisições por rota e classe, duração, visitas, resultados do motor, cotas, webhooks, erros, memória, fila de webhooks | `server/src/metrics.ts` |
| Prontidão | `/readyz` confere o armazenamento e a fila de webhooks. `HEALTHCHECK` do contêiner usa o comando `healthcheck` | `server/src/healthcheck.ts`, `Dockerfile` |
| Proteções | Limite de conexões; encerramento forçado após 15 s; limites já existentes | `server/src/server.ts`, `main.ts` |
| Teste de carga | Gerador sem dependência: desafio, visita e leitura, com população de aparelhos | `tools/loadtest/run.js` |
| CI | Trabalhos novos: navegadores locais e imagem do Docker (**não executados no GitHub**, só os comandos foram conferidos aqui) | `.github/workflows/test.yml` |

## Medidas de carga

Máquina: Intel Core i7-9750H, Node 22.22.0, um processo, SQLite em arquivo (WAL), 16 conexões simultâneas, gerador de carga na mesma máquina, laço de retorno. Cada visita é um pedido de desafio e um envio (dois pedidos). Colunas: coletas por segundo e latência da coleta (mediana, p95).

| Momento | Aparelhos distintos no gerador | Coletas por segundo | p50 | p95 |
|---|---|---|---|---|
| Antes dos contadores | 1.000 | 90 | 81 ms | 182 ms |
| Antes dos contadores | 10.000 | 45 | 160 ms | 336 ms |
| Antes dos contadores | 50.000 | 37 | 198 ms | 386 ms |
| Depois dos contadores e do índice | 1.000 | 240 | 28 ms | 67 ms |
| Depois | 10.000 | 142 | 41 ms | 134 ms |
| Depois | 50.000 | 123 | 42 ms | 171 ms |

Em cada linha, um em cada dez envios também lê o evento de volta. Sem as leituras, o mesmo servidor fez cerca de 339 coletas por segundo com 1.000 aparelhos e 260 com 50.000.

**O que as medidas dizem:** o gargalo estava em contar a população a cada visita (65% do tempo no perfil), e cerca de 2,7 a 3,3 vezes mais vazão saiu de contadores e de um índice melhor. **O que não dizem:** nada sobre produção. A vazão ainda cai quando a população cresce, porque a busca de candidatos lê mais linhas. A leitura de um evento custa mais que o envio (calcula risco e consultas de velocidade), e no teste todos os clientes têm o mesmo IP, o pior caso para a contagem de aparelhos por IP.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 635 de 635 na época; 678 no fechamento |
| Contadores | Comparados com a contagem lenta depois de 400 operações aleatórias, depois da limpeza de órfãos, depois de migrar um banco antigo (uma vez só), entre tenants, e contra o armazenamento em memória para o mesmo histórico |
| Teste de mutação | Cerca de 20 comportamentos quebrados de propósito (chave de métricas, prontidão, classe de status, limite de séries, limite de conexões, limiar de atraso do webhook). Os sobreviventes eram falhas de compilação ou o caso dos erros 5xx, que ganhou teste |
| Registro | Um teste faz tráfego com valores sentinela (IP, User-Agent, `linkedId`, chaves, trecho do payload) e procura qualquer um no registro: nenhum aparece |
| Docker | Imagem construída, `healthy` no `HEALTHCHECK`, `/readyz` respondendo, encerramento limpo ao parar |

## O que NÃO foi verificado (ressalvas)

- **Escala real.** Nenhum teste passou de cerca de 3.000 aparelhos no banco nem de um processo. A busca de candidatos lê linhas proporcionais à população: com centenas de milhares de aparelhos precisa de outra estrutura (índice aproximado) ou de limitar quantas características consulta.
- **Várias instâncias** não são suportadas (fila de webhooks, limites e cache de tenants são do processo).
- **Latência de cauda sob carga longa**: o teste foi de 20 segundos por rodada.
- **CI no GitHub**: os dois trabalhos novos não rodaram lá.
- **Teste de intrusão externo** não foi feito.
- **Alertas**: não há regras de alerta nem painel de Grafana; só as métricas.

## O que o dono precisa decidir

1. ~~A escala que importa, para decidir se o SQLite basta.~~ Respondida pelo dono (2026-10-19): o banco é o MySQL, qualquer que seja o volume (D79).
2. Quem lê `/metrics` e com que chave.
3. Onde rodar um teste de carga com hardware parecido com o de produção.

## MySQL (2026-10-19)

O dono decidiu que o banco de produção é o MySQL (D79 a D82). O que mudou:

| O quê | Como | Onde |
|---|---|---|
| Armazenamento assíncrono | As interfaces devolvem `MaybePromise`; memória e SQLite continuam síncronos por baixo | `server/src/async.ts`, `server/src/storage.ts` |
| Implementação MySQL | Eventos, aparelhos, entregas, auditoria, uso, grafo e tenants; tabelas em `utf8mb4_bin`; contadores mantidos no código dentro da transação; nova tentativa em deadlock | `server/src/mysql/` |
| Motor de identidade | Decisão pura (`decide`) compartilhada pelo motor assíncrono (fila por tenant) e pelo síncrono (ajuste e avaliação) | `server/src/identity/` |
| Dependência | `mysql2` fixado em 3.24.5, carregado só com `database.type: "mysql"`; está na imagem Docker | `server/Dockerfile` |
| Testes | Contrato sobre memória, SQLite e MySQL; MySQL só com `FP_TEST_MYSQL_URL`; o CI tem serviço `mysql:8.0` | `server/src/testing/mysql.ts`, `.github/workflows/test.yml` |

Requisitos: MySQL 8.0.19 ou mais novo (a sintaxe `VALUES ... AS new ON DUPLICATE KEY UPDATE`). A senha vem de `FP_MYSQL_PASSWORD`.

**Vazão medida (D82).** Notebook, MySQL 8 em Docker no macOS, gerador na mesma máquina, um tenant: uma visita leva cerca de 45 ms com 1 trabalhador, e a vazão com 16 trabalhadores fica perto de 30 visitas por segundo (mediana de cerca de 500 ms). Os números do SQLite acima são de outra máquina e não se comparam. A causa do teto não foi isolada; o dono disse que volume não importa. Se importar, o primeiro lugar a olhar é a contagem de uso, que escreve duas vezes na mesma linha a cada visita.

**Escala da busca de candidatos (D90):** com aparelhos inventados no mesmo MySQL, a decisão levou de 16 a 18 ms (100 mil aparelhos) e de 26 a 41 ms (1 milhão). Veja a fase 10. **Vários servidores sobre o mesmo MySQL** também foram feitos e testados com dois (D89).

**Não verificado:** MariaDB; MySQL gerenciado (RDS, Cloud SQL); réplica de leitura; migração de um banco SQLite grande (há `migrate-sqlite`, testado só com poucos dados); desempenho em disco de servidor.
