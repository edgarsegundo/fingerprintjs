# Grafo compartilhado entre clientes (decisão D3)

> **Desligado por padrão e travado.** O mecanismo existe no código para que a decisão possa ser testada, mas **não deve ser ligado em produção sem parecer jurídico favorável, RIPD próprio e adesão contratual de cada cliente.** Este documento não é parecer jurídico.

## O que é

Cada tenant tem identificadores de visitante só seus: o mesmo aparelho recebe ids diferentes em tenants diferentes, e nenhum cliente consegue ligá-los. O grafo é um segundo mecanismo, separado, que deixa tenants **que aderiram** saberem, em contagens, o que os outros viram do mesmo aparelho.

| O que atravessa tenants | O que nunca atravessa |
|---|---|
| Em quantos **outros** tenants uma chave de aparelho foi vista na janela | Eventos, visitas, contas, `linkedId`, URLs |
| Quantos **outros** tenants a marcaram como abusiva | Endereço IP, país, User-Agent, características do aparelho |
| | Nome ou id de qualquer outro tenant |
| | Contagem abaixo de `minTenants` (k-anonimato) |

## Como funciona

1. **Chave.** Uma impressão HMAC (com um segredo só desta instalação) de 12 características do aparelho, **sem nada da conexão**: `canvas`, GPU, fontes, resolução, núcleos, memória, plataforma, áudio e mídia. A chave é uma **correspondência exata**: qualquer valor que mude gera outra chave. Visitas com menos de `sharedGraph.minFeatures` características (padrão 8) ficam fora do grafo.
2. **Contribuição.** Um tenant que aderiu grava, por chave: o tenant, a última vez que viu e a última vez que marcou como abusiva (decisões da lista `sharedGraph.flagDecisions`, dadas pelas **regras do próprio tenant**).
3. **Consulta.** O evento do tenant mostra `graph: { tenants, flaggedTenants }`. Cada contagem só aparece se pelo menos `minTenants` (padrão 3, mínimo 2) tenants estão por trás dela; abaixo disso é `null` ("não há o bastante para dizer"). Um tenant nunca se conta.
4. **Fatos e risco.** `graph.tenants` e `graph.flaggedTenants` são fatos para as regras. O fator de risco `graph:flagged_elsewhere` pesa `risk.graphFlaggedWeight` (padrão 0).

## Travas

| Trava | Onde |
|---|---|
| O servidor **recusa ligar** sem `sharedGraph.legalOpinionRef` (a referência do parecer) e sem um `sharedGraph.secret` de 32 caracteres ou mais e diferente do `nonceSecret` | `server/src/config.ts` |
| Um tenant só adere se o arquivo liga o grafo; configurar `sharedGraph.participate` com o grafo desligado impede a partida (e recusa a criação pelo admin) | `server/src/settings/settings.ts` |
| Adesão é por tenant, padrão `false`, e pode ser por plano | `sharedGraph.participate` |
| `sharedGraph.excludeCountries`: visitantes desses países não contribuem nem consultam (com o escopo só Brasil, D83, não é necessário; fica para o caso de o escopo mudar) | `server/src/risk/assess.ts` |
| Retenção do grafo, **mais curta** que a dos eventos (padrão 14 dias, máximo 90), apagada na partida e a cada hora | `sharedGraph.retentionDays` |
| A janela de consulta nunca passa da retenção | `assess.ts` |
| Pedido de um titular: apagar uma visita ou um visitante apaga a contribuição do tenant para a chave dessa visita. Remover o tenant apaga tudo que ele deu | `app.ts`, `admin.ts` |
| Ao ligar, o servidor registra `shared_graph_on` com a referência do parecer | `server.ts` |

## Limites honestos

- **A chave é pseudônima, não anônima.** Para quem tem o segredo ela identifica o aparelho entre tenants.
- **Correspondência exata.** Uma atualização do navegador muda a chave, e o grafo "esquece" o aparelho. Por outro lado, modelos iguais de aparelho com configuração igual **colidem**: a contagem pode juntar pessoas diferentes. Daí o piso de características e o k-anonimato.
- **Apagar a contribuição de uma chave** também apaga o que o mesmo tenant deu por outras visitas do mesmo aparelho, até a próxima visita.
- **O ganho não foi medido.** Nenhum dado real mostra se o sinal ajuda a achar fraude. O peso padrão é 0.
- **Questões jurídicas em aberto:** base legal para o compartilhamento (finalidade única de segurança, legítimo interesse), controladoria conjunta, consentimento prévio na UE e no Reino Unido, transferência internacional, contrato com cada cliente, informação ao titular. Veja `05-riscos-privacidade-e-compliance.md` (R15).

## Para ligar (só depois do parecer)

```json
{ "sharedGraph": { "enabled": true, "legalOpinionRef": "Parecer 12/2026, 2026-11-03", "secret": "<32+ caracteres>",
                   "retentionDays": 14, "minTenants": 3 },
  "defaults": { "sharedGraph": { "excludeCountries": ["DE", "FR", "PT"] } },
  "tenants": [ { "id": "loja", "...": "...", "settings": { "sharedGraph": { "participate": true } } } ] }
```
