# Fase 5: sinais inteligentes, risco e regras

Status: **código concluído; todos os pesos são palpites sem dados reais.** Branch `v5.3.0-fork` (sem commit).

A fase dá ao dono quatro coisas que se combinam: rótulos de rede (data center, Tor, país), velocidade (várias contas num aparelho), um risco composto desmontável e regras de decisão que ele mesmo escreve. **Tudo é parâmetro** (D41), por tenant, recarregável com `SIGHUP`.

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Listas de IP | `fetch-ip-list aws\|gcp\|tor` baixa a lista pública e grava no formato de `ipLists`. `--file` lê uma cópia salva. Recusa lista vazia | `server/src/net/ip_lists.ts`, `cli.ts` |
| País do IP | CSV do dono (`ipGeoFile`), em `primeiro,último,CC` (DB-IP Lite) ou `cidr,CC`. Recusa linhas ruins e faixas sobrepostas | `server/src/net/geo.ts` |
| Fuso contra país | `zone.tab` do IANA (`timezoneTable`). Apelido fora da tabela vale "não sei" | `server/src/net/timezones.ts` |
| Velocidade | `activity()` conta visitas, aparelhos, `linkedId` e IPs numa janela, em SQL e em memória, com o mesmo contrato | `server/src/identity/{store,sqlite_store,memory_store}.ts` |
| Risco composto | Soma de pesos com fatores visíveis, nível por limiares, `heuristic: true`, `calibrated: false` | `server/src/risk/risk.ts` |
| Regras | `rules.list` com `all`, `any`, `not` e comparações; a primeira que vale decide; validação rígida na partida | `server/src/risk/rules.ts` |
| Comportamento (opt-in) | Contagens de interação, só do que o navegador produziu, e de eventos criados por script | `src/collector/sources/behavior.ts` |
| API | `GET /v1/events/:id` devolve `risk` e `decision` além de `identity` e `tamper`. Cada parte é `null` se o tenant a desligou | `server/src/risk/assess.ts`, `app.ts` |

Referências geradas do código, com teste que falha se envelhecerem: [configuracao.md](../../configuracao.md) e [regras.md](../../regras.md).

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 473 de 473 |
| Testes do navegador | 242 de 242 em Chrome 155 e Firefox 152 |
| Listas reais | As três listas públicas baixadas em 2026-10-19: AWS 11.366 faixas, Google Cloud 1.128, Tor 1.202, nenhuma entrada ignorada. Lidas de volta pelo servidor |
| Geolocalização real | O arquivo gratuito DB-IP Lite de 2026-10 (710.834 linhas) carrega em cerca de 3 s e responde em cerca de 1 µs. 8.8.8.8 deu US, 200.160.2.3 deu BR |
| Tabela de fusos real | `zone.tab` do sistema: 418 fusos. `America/Sao_Paulo` combina com BR e não com US; `Asia/Calcutta` (apelido) dá "não sei" |
| Teste de mutação | Cerca de 45 comportamentos quebrados de propósito no risco, nas regras, na janela de velocidade, na geolocalização e no comportamento. Os que sobreviveram na primeira rodada (janela, regras com risco desligado, repasse dos números ao motor) viraram testes |

## O que NÃO foi verificado (ressalvas)

- **Nenhum peso foi calibrado.** Os pesos e limiares padrão são palpites. O risco não é uma probabilidade e o JSON diz isso.
- **Precisão da geolocalização.** A base é do fornecedor dela. Celular, VPN e rede de empresa erram com frequência.
- **Fuso contra país** dispara para viajante e para quem usa VPN. O peso padrão é baixo por isso.
- **Aparelhos por IP** sofre com CGNAT, escritório e escola. O limiar padrão é alto.
- **Comportamento só foi testado em unidade.** O navegador não deixa um teste produzir evento confiável, então a parte "evento real" foi testada com dados simples e não numa página com uma pessoa. Gerenciadores de senha e ferramentas de acessibilidade geram cliques sintéticos.
- **Velocidade conta por consulta ao banco**, a cada leitura. Serve para milhares de visitas por dia; a Fase 8 deve trocar por contadores.
- **Listas de IP envelhecem.** Precisam ser baixadas de novo com frequência (cron do dono) e o servidor relê só na partida.
- **Visita tampered não conta como aparelho.** Pela política padrão (D44) ela não ensina o motor e ganha um identificador novo a cada vez, então a velocidade não liga duas visitas dela ao mesmo aparelho. O efeito colateral é que cada uma conta como um aparelho a mais no IP.
- **Azure e VPNs comerciais** não têm importador.

## O que o dono precisa decidir

1. Quais fontes de lista e de geolocalização usar (licença de cada uma é dele).
2. Os pesos e limiares, quando houver casos rotulados.
3. Se a página liga o sinal de comportamento (e o aviso de privacidade que isso exige).
