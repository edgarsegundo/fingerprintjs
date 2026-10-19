# Fase 9 e grafo compartilhado: diferenciais

Status: **código concluído; nada disto foi medido com dados reais, e o grafo está travado.** Branch `v5.3.0-fork` (sem commit).

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Relatório de deriva | `GET /v1/drift?windowDays=`: por característica, divergência de Jensen-Shannon e fração de valores novos entre dois períodos; avisa quando amostrou e não julga com poucas visitas | `server/src/drift/drift.ts`, `app.ts` |
| Coleta guiada pelo servidor | A resposta do desafio traz `profile` (excluir, incluir, ampliada para rótulos de IP listados). A página aplica com `profileToOptions` | `app.ts`, `src/collector/index.ts` |
| Relatório de k-anonimato | `GET /v1/anonymity?k=`: por característica, a fração de aparelhos de valor raro, lida dos contadores | `identity/*_store.ts`, `app.ts` |
| Grafo compartilhado | Mecanismo desligado e travado (parecer, segredo, adesão por tenant, k-anonimato, retenção curta) | `server/src/graph/`, [grafo-compartilhado.md](../privacidade/grafo-compartilhado.md) |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 678 de 678 no fechamento |
| Testes do navegador | 248 de 248 em Chrome 155 e Firefox 152 |
| Teste de mutação | Cerca de 45 comportamentos quebrados de propósito (limiar e mínimo da deriva, fórmula e limites da divergência, janelas, amostragem, perfil ampliado, k, trava de configuração, janela contra retenção, limpeza, remoção). Os que sobreviveram na primeira rodada eram falhas de compilação, ou mostraram testes que faltavam: o aparelho de um tenant que não adere (cuja chave só não existia por acaso do piso de características), a janela contra a retenção, a limpeza na partida, a remoção de tenant pelo admin e um teste de resposta conhecida para a derivação da chave |
| Garantias do grafo | Um teste mostra que a contagem some abaixo de `minTenants`, que o próprio tenant nunca se conta, que um tenant que não adere não dá nem recebe, que país excluído fica fora, e que apagar visita ou remover tenant apaga a contribuição |

## O que NÃO foi verificado (ressalvas)

- **Ganho.** Não há dado real. Não se sabe se a deriva aponta o que importa, se a coleta ampliada pega mais fraude ou se o grafo ajuda. O peso do grafo no risco é 0.
- **Grafo: jurídico.** Base legal do compartilhamento, controladoria conjunta, consentimento na UE e no Reino Unido e contrato com cada cliente **não foram resolvidos**. A trava existe justamente por isso.
- **Grafo: colisão.** Aparelhos iguais com configuração igual produzem a mesma chave. O piso de características e o k-anonimato mitigam, mas não eliminam.
- **Deriva: causa.** O relatório diz que algo mudou, não por quê. Também não separa por família de navegador.
- **Coleta ampliada** depende de rótulos de IP, que são imperfeitos (VPN residencial não é listada).
- **k-anonimato** olha uma característica por vez; a combinação é mais identificadora que qualquer uma isolada.

## O que o dono precisa decidir

1. Se e quando buscar o parecer para o grafo.
2. Que deslocamentos de característica merecem alerta (depois de ver dados reais).
