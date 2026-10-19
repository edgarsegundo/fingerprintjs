# Fase 10: o que dava para fazer sem os dados da Fase 0

Data: 2026-10-19. Esta fase reúne tudo que era engenharia ou decisão do dono e não dependia de dado real. **Nenhum número de precisão nasceu aqui.** Todo peso novo é palpite marcado como tal, e dado inventado só mediu velocidade (item 7).

## O que foi feito

| # | O quê | Onde | Decisão |
|---|---|---|---|
| 0 | Passos numerados de esquema no MySQL, sob trava; as constantes da busca de candidatos viraram parâmetros | `server/src/mysql/schema.ts`, `identity.candidate*` | D90, D91 |
| 1 | Juntar e separar aparelhos, por pessoa, pela API e pelo painel | `identity/edit.ts`, `engine.ts`, `app.ts`, `dashboard/` | D85 |
| 2 | Robô de busca verificado por DNS | `net/bots.ts` | D86 |
| 3 | Código guardado no navegador (cookie, local storage, IndexedDB), desligado por padrão e preso à base legal | `src/collector/sources/stored_id.ts`, `identity/features.ts`, `decision.ts` | D87 |
| 4 | Fatos do ambiente: janela privada provável, placa virtual, imagem por software, com peso 0 | `server/src/environment/` | D88 |
| 5 | Vários servidores sobre um MySQL: vez do tenant, reserva de webhooks, limites compartilhados, tenants relidos, esquema sob trava | `mysql/database.ts`, `webhooks/queue.ts`, `mysql/rate_limits.ts`, `server.ts` | D89 |
| 6 | Visão do `navigator` de um iframe oculto e a verificação `iframe_page_mismatch` | `worker_context.ts`, `tamper/checks.ts` | D93 |
| 7 | Busca de candidatos com teto por valor e índice; latência medida até 1 milhão de aparelhos inventados | `identity/*_store.ts`, `mysql/identity_store.ts` | D90 |
| 8 | Listas de IP em tabela com colunas (para bases comerciais gratuitas) | `net/ip_lists.ts`, `ip_intel.ts`, `config.ts` | D92 |
| 9 | `migrate-sqlite`: copia um SQLite para o MySQL, conta os contadores de novo e confere | `server/src/migrate.ts` | D94 |

Ficou de fora de propósito (D95): provedor de IP por API externa, service worker, impressão TCP/IP e SDKs de celular.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `yarn lint` | limpo, zero avisos |
| `yarn build`, `check:dts`, `check:ssr` | passam |
| Testes do servidor | 776 de 776 sem MySQL; 869 de 869 com MySQL 8 |
| Testes do navegador (Chrome 155 e Firefox 152 locais) | 262 de 262 |
| Imagem do Docker | construída; `healthy` com SQLite e com MySQL (com `sharedLimits`) |
| Chrome de verdade, ponta a ponta | A página pediu o código guardado pelo perfil do desafio, o navegador criou o código na primeira visita, achou na segunda e o servidor ligou as duas ao mesmo aparelho (a razão principal da decisão foi `storedId`). Uma visita sem base declarada não leu nem gravou |
| Dois servidores sobre um MySQL | Um limite de 4 desafios por minuto valeu para os dois juntos (4 passaram e 2 foram recusadas); um tenant criado em um apareceu no outro; seis visitas simultâneas do mesmo aparelho, espalhadas pelos dois, viraram um aparelho só |
| Teste de mutação | Feito em cada defesa nova: juntar e separar (contadores, alias, vez do tenant, limite do dispositivo vazio), robô (sufixo sem o ponto, ida e volta, "não sei" nunca vira falso, teto de consultas), código guardado (as duas travas, peso, conflito, digest), ambiente, vez entre instâncias, reserva de webhooks, janela dos limites, esquema sob trava, faixas de IP, migração. Variantes que não compilavam foram refeitas. Um teste que travava foi trocado por um que falha |
| `/revisar` | Quatro achados Maiores, corrigidos (abaixo) |
| Não rodou | CI no GitHub (serviço MySQL novo), Safari, Android, iOS, navegadores anti-detecção, mais de duas instâncias, MariaDB, MySQL gerenciado |

### O que a revisão achou e foi corrigido

1. A resposta de uma visita era gravada depois de soltar a vez do tenant. Um `merge` logo em seguida deixava a visita presa a um aparelho que já não existia. Voltou para dentro da vez, com teste que falhava sem isso.
2. O limite compartilhado cobrava uma escrita no banco por pedido, inclusive os que seriam recusados: o próprio limite era uma forma de carregar o banco. Há agora um limite local dez vezes maior na frente, que barra a enxurrada em memória.
3. A reserva de webhooks de 100 entregas de uma vez podia vencer antes de a última ser enviada com um destinatário lento, e outra instância mandaria de novo. Agora reserva-se um lote por vez.
4. Faltava um jeito público de apagar o código guardado quando o titular retira o consentimento: `forgetStoredId` agora é exportado.

## Medida de velocidade da busca de candidatos (D90)

MySQL 8 em Docker no macOS, um notebook, aparelhos **inventados** (8 características cada, três delas únicas por aparelho), 300 decisões sem aprender, um processo. Mede latência, não acerto.

| Aparelhos | Conhecido (mediana / p95) | Conhecido com um valor trocado | Nunca visto |
|---|---|---|---|
| 100 mil (800 mil linhas) | 18,2 / 25,7 ms | 16,6 / 23,4 ms | 15,8 / 20,3 ms |
| 1 milhão (8 milhões de linhas) | 41,5 / 71,6 ms | 30,5 / 41,5 ms | 26,5 / 36,0 ms |

Povoar 1 milhão de aparelhos levou 53 minutos nessa máquina. Não se sabe se o aparelho certo seria achado com o teto de 200 por valor; isso só os dados reais dizem.

## Limites que ficam

- O código guardado precisa de parecer jurídico. É um identificador persistente no aparelho do titular, e `legitimate_interest` pode não bastar no Brasil. Não foi medido quanto ele melhora a reidentificação.
- Safari limita o que um script grava; janela privada apaga tudo. No teste do Chrome em tempo virtual o IndexedDB nem sempre aparecia na segunda leitura (o tempo virtual acelera os limites de tempo): não foi repetido em tempo real.
- Verificação de robô por DNS manda o endereço do visitante ao DNS da máquina, e a lista de domínios deve ser relida na documentação dos buscadores.
- O sinal de janela privada é fraco e envelhece. Placa virtual não é fraude.
- `iframe_page_mismatch` pega quem altera só a janela de cima por script. Quem altera no navegador muda as duas.
- O formato de listas de IP com colunas não foi conferido contra o arquivo de uma base específica.
- Limites compartilhados usam janelas fixas de um minuto (até o dobro do limite na virada).
- A migração não retoma de onde parou.
