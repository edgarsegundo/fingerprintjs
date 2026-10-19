# Fase 6: API de consulta, webhooks, painel, SDK e integração de primeira parte

Status: **código concluído.** Branch `v5.3.0-fork` (sem commit).

A fase deixa o dono (e, depois, os clientes) usar o que as fases anteriores produzem: consultar visitas e visitantes, ser avisado de cada visita, ver tudo num painel e integrar a partir do backend, tudo parametrizado por tenant (D41).

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Listagem | `GET /v1/events`: filtros por tempo (início incluído, fim excluído), `linkedId` e IP; ordem; cursor opaco; página limitada por `api.*`. Devolve um resumo por visita | `server/src/app.ts`, `store/*` |
| Visitante | `GET /v1/visitors/:id`: primeira e última visita, total e as visitas mais recentes | `server/src/app.ts`, `identity/*` |
| Webhooks | Fila persistente, assinatura HMAC, tentativas com espera crescente, filtros por risco e decisão, lista de entregas e reenvio | `server/src/webhooks/*` |
| Proteção do webhook | Resolve o nome, confere todos os endereços e conecta no conferido; não segue redirecionamento; recusa rede privada | `server/src/webhooks/safe_http.ts` |
| SDK de Node | `FingerprintClient` (`getEvent`, `listEvents`, `iterateEvents`, `getVisitor`) e `verifyWebhook`, sem dependência | `server/src/sdk/*` |
| Painel | Página única em `/dashboard/`, com a chave só em memória | `server/src/dashboard/assets.ts` |
| Primeira parte | `basePath`, `collectorFile` e `collectorPath` | `server/src/app.ts`, `static_files.ts` |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 534 de 534 |
| Teste de mutação | Cerca de 55 comportamentos quebrados de propósito (cursor, ordem, limites de página, assinatura, tolerância de horário, faixas bloqueadas nas duas pontas, redirecionamento, tentativas, espera, fila, filtros). Os que sobreviveram na primeira rodada mostraram um bug real (abaixo) e testes que faltavam |
| Painel num Chrome de verdade | Roteiro pelo protocolo do DevTools com texto hostil (`<img onerror>`) em cinco campos: chave errada recusada, três visitas listadas, filtro por `linkedId`, detalhe, aba de webhooks, nenhum elemento injetado, nada em armazenamento, nenhum erro de política de conteúdo |
| Webhook de ponta a ponta | Destinatário real em porta local: corpo, assinatura conferida pelo SDK, nova tentativa após 500, desistência em 400, reenvio manual, filtro por risco, e uma entrega que sobrevive ao reinício do servidor |

### Bug encontrado pelos testes

A paginação do mais novo para o mais velho repetia eventos quando dois tinham o mesmo horário: a comparação de desempate usava o sinal errado. O teste de contrato dos dois armazenamentos (memória e SQLite) com horários iguais pegou. Corrigido.

## O que NÃO foi verificado (ressalvas)

- **Entrega exatamente uma vez não existe.** É pelo menos uma vez: um destinatário que responde devagar pode receber o mesmo aviso duas vezes. O `id` serve para deduplicar.
- **Webhook em HTTPS com certificado real** só foi exercitado em HTTP local. A parte de TLS é a do `node:https`.
- **Painel em Safari e Firefox** não foi aberto. Só Chrome.
- **Listagem em volume.** Cada item custa algumas consultas. Serve para milhares de visitas por dia.
- **Pacote npm do SDK** não foi publicado nem montado: o código está dentro do servidor.
- **Várias instâncias do servidor** disputariam a mesma fila de webhooks. Hoje é um processo só.

## O que o dono precisa decidir

1. Publicar o SDK como pacote (nome, escopo no npm).
2. Se o painel precisa de login com usuários antes do SaaS.
