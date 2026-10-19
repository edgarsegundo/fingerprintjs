# Fase 7: privacidade, direitos do titular e governança

Status: **código concluído; textos jurídicos são modelos sem revisão.** Branch `v5.3.0-fork` (sem commit).

A fase transforma os princípios da LGPD em controles que o dono liga por tenant (D41) e em ferramentas para atender um titular. O texto jurídico (LIA, RIPD, política de privacidade) existe como **modelo** em [privacidade/](../privacidade/README.md), e a revisão por advogado ou encarregado foi deixada para o fim do plano, como o dono pediu.

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Forma do IP | `privacy.ipStorage`: inteiro, truncado (/24 e /48), hash com chave por tenant, nenhum | `server/src/privacy/ip_policy.ts` |
| Sinais descartados | `privacy.dropSignals`: o servidor joga fora sinais antes de usar ou guardar | `server/src/app.ts` |
| Consentimento | `consent` no coletor e no payload; `privacy.requireConsent` recusa sem a base `consent` | `src/collector/*`, `server/src/ingest/validate.ts` |
| Registro de acessos | `GET /v1/audit`; guarda ação, alvo, chave, solicitante e status, nunca o conteúdo | `server/src/audit/log.ts` |
| Exportação | `GET /v1/subjects/export?linkedId=`, com corte e aviso | `server/src/app.ts` |
| Exclusão | `DELETE /v1/subjects?linkedId=` e `DELETE /v1/visitors/:id`; levam junto as entregas de webhook e os aparelhos órfãos | `server/src/app.ts`, `store/*`, `webhooks/queue.ts` |
| Retenção | `retention.eventsDays` (já existia) e `audit.retentionDays`, por tenant | `server/src/server.ts` |
| Modelos | LIA, RIPD, política de privacidade, procedimento de direitos | `docs/plano/privacidade/` |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 570 de 570 |
| Testes do navegador | 243 de 243 em Chrome 155 e Firefox 152 |
| Teste de mutação | Cerca de 55 comportamentos quebrados de propósito (truncamento, hash por tenant, modos do IP, consentimento, sinais descartados, auditoria, exclusão, exportação, paginação de exclusão, isolamento entre tenants). Os que sobreviveram na primeira rodada eram falhas de compilação (inconclusivas) e um caso sem teste: a exclusão de mais de uma página de visitas, que ganhou teste com 1.205 visitas |
| Garantia de que o IP não vaza | Com `hash`, o registro inteiro da visita não contém o IP (teste procura o texto em tudo) |

## O que NÃO foi verificado (ressalvas)

- **Nada aqui é parecer jurídico.** Os modelos precisam de revisão. Os artigos citados devem ser conferidos no texto da lei.
- **Cópias de segurança** não são tocadas por uma exclusão. O dono precisa definir quanto elas vivem.
- **Hash do IP não é anonimização.** Quem tem a chave testa um palpite. A chave (`ipHashSecret`) deve ficar fora do banco.
- **O padrão é `ipStorage: full`.** Foi escolhido para a detecção, e o dono pode trocar. Um cliente da UE provavelmente deve começar por `truncated` ou `hash`.
- **A declaração de consentimento é da página.** O servidor guarda e exige a declaração, mas não consegue provar que o visitante consentiu.
- **Tentativa com chave errada não vai ao registro de acessos** (vai ao log estruturado, com limite por IP).
- **Criptografia do banco em repouso** não é feita pelo servidor; é do disco ou do volume.

## O que o dono precisa decidir

1. O padrão de `privacy.ipStorage` do seu uso.
2. Por quanto tempo viver uma cópia de segurança.
3. A revisão jurídica dos modelos (adiada para o fim, como pedido).
