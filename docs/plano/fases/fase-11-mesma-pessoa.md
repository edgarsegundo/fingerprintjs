# Fase 11: da mesma máquina à mesma pessoa

Data: 2026-10-26. Objetivo do dono: **identificar a mesma pessoa em aparelhos diferentes.** Até aqui o motor só reconhecia *navegador*. Três passos, nesta ordem, cada um sobre o anterior (D102, D103, D104). **Nenhum número de precisão nasceu aqui:** todo limiar é provisório e dado sintético só provou a mecânica.

## O que motivou

Duas visitas do mesmo Firefox tiveram `headerOrder` diferente (peso -2,08) e uma virou aparelho novo. A investigação mostrou que a característica hasheava todos os cabeçalhos e o casing (muda com cabeçalhos de cache e com HTTP/1.1 contra HTTP/2), e que Chrome e Firefox no mesmo notebook eram dois aparelhos sem relação nenhuma, e que nada ligava aparelhos diferentes de uma pessoa.

## O que foi feito

| Passo | O quê | Onde | Decisão |
|---|---|---|---|
| A | `headerCore`: ordem relativa dos 12 cabeçalhos que sempre chegam, sem casing; `headerOrder` aposentado (`retired`, nome ainda válido) | `net/headers.ts`, `identity/features.ts` | D102 |
| A | Relatório de estabilidade por característica (aparelhos com 2 visitas ou mais que mudaram o valor): store, `feature-stability`, opção 17 do `help.sh` | `identity/*_store.ts`, `mysql/identity_store.ts`, `cli.ts` | D102 |
| B | `scope` em toda característica (`machine`, `browser`, `network`); `gpuFamily` e `browserFamily` novas | `identity/features.ts`, `net/browser.ts` | D103 |
| B | Passada de mesma máquina depois da decisão: mesmo IP em 30 min, aparelho só visto em outro navegador, até 5 aparelhos no IP, só características de máquina; resultado em `Resolution.sameMachine`, sem fundir | `identity/same_machine.ts`, `engine.ts`, `devicesSeenFrom` | D103 |
| B | Painel: seção "Related devices" (mostra também o `possibleLink`, antes invisível); fato `identity.sameMachineCount`; `risk.sameMachineWeight` (padrão 0) | `dashboard/assets.ts`, `risk/` | D103 |
| C | `identity_links` e a pessoa calculada na leitura (largura, teto de aparelhos); gravador por visita; confirmar, rejeitar e desfazer; seção "Person" no painel | `server/src/person/`, `mysql/person_store.ts`, `app.ts` | D104 |
| C | Fatos `person.*` e fator `multi_account` (só com mais de um aparelho); retenção, apagamento do titular, saída do tenant e merge levam as ligações | `risk/`, `app.ts`, `admin.ts`, `server.ts` | D104 |
| C | Rotas: `GET /v1/visitors/:id/person` e `POST /v1/visitors/:id/links` (`confirm`, `reject`, `clear`) | `app.ts` | D104 |

Parâmetros novos (todos com ajuda em `help.ts`): `identity.sameMachine.{enabled,windowMinutes,maxDevicesPerIp,minLogOdds,minFeatures,maxLinks}`, `identity.person.{enabled,groupingKinds,maxDevices,networkWindowMinutes,networkMaxDevicesPerIp}`, `risk.sameMachineWeight`, `risk.multiAccountWeight`, `risk.multiAccountThreshold`.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `yarn lint` | zero avisos |
| `yarn server:test` | 918 testes passam (SQLite e memória) |
| Com MySQL 9.5 descartável (com senha) | **1033 testes passam**, inclusive o contrato dos armazenamentos novos. Achou um erro meu: `reads` é palavra reservada no MySQL |
| Mutação (defesas) | A: 3 de 3 mortos. B: 8 de 8. C: 9 de 9. Vários mutantes sobreviveram na primeira rodada por teste fraco (aparelhos de outros cenários mudavam o peso) e os testes foram corrigidos |
| Teste HTTP com User-Agent real de Chrome e Firefox | `sameMachine` nasce, os `visitorId` ficam diferentes; várias contas em dois navegadores somam `multi_account`; rejeição não volta com nova visita; apagar o titular, merge, tenant desligado e outro tenant |
| Painel no Chrome real (headless, protocolo de depuração) | seção "Related devices" e "Person" aparecem, confirmação em dois cliques, rejeitar reduz a pessoa para 1 aparelho |

## Limites e o que não foi verificado

- **O vínculo de mesma máquina vai ser raro em população grande.** As características de máquina de hardware comum (cor, fuso, `platform`) pesam pouco, e o prior é o da população inteira (D78). Num teste com um aparelho "isca" que dividia valores comuns, o vínculo deixou de nascer. Não foi afrouxado para parecer melhor (D29, D30). Para medir: pares do mesmo participante em dois navegadores, na Fase 0.
- **`speechVoices` e `screenResolution` como características de máquina são hipóteses** ainda não conferidas entre Chrome, Firefox e Safari; `feature-stability` e a coleta dizem. **Safari, celular e rede com IP compartilhado de verdade não foram verificados.**
- Chrome e Firefox reais no notebook do dono, contra a VPS, **não foram testados** (só User-Agent simulado e Chrome para o painel).
- `headerCore` precisa ser medido na VPS (`help.sh`, opção 17) comparando com `headerOrder` antigo; `http2` pode ter defeito parecido.
- **Revisão jurídica pendente:** a camada de pessoa liga aparelhos de pessoas e está ligada por padrão (decisão do dono). Entrou o risco R18; a LIA e o RIPD (`privacidade/`) precisam dela antes de produção.
- Ficaram de fora: `personId` estável (de propósito, seria um identificador novo), ligações na exportação do titular, ligações na lista do painel e nos webhooks, e as métricas de avaliação por par em dois navegadores no harness da Fase 0.
- `delete-linked` (CLI) ainda não apaga entregas de webhook nem contribuições ao grafo, ao contrário da API (achado nesta investigação, não corrigido aqui).
