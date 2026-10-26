# Busca de candidatos, v2: como evoluir quando houver dados reais

Escrito em 2026-10-19. Use este documento **depois** de coletar os dados reais da Fase 0 e antes de mexer na busca de candidatos. Ele diz o que a busca faz hoje, o que não se sabe sobre ela, como medir o que falta e o que fazer conforme o resultado.

## 1. O que é a busca de candidatos e por que ela importa

A cada visita, o motor precisa decidir se o navegador é um aparelho já conhecido. Comparar a visita com **todos** os aparelhos custaria uma comparação por aparelho, o que fica lento com muitos. Então ele faz em duas fases:

1. **Achar candidatos:** uma lista curta de aparelhos que *podem* ser este. É a "busca de candidatos".
2. **Comparar de verdade** só com esses (soma de evidências, barra de certeza 0,99).

Se o aparelho certo **não entra na lista de candidatos**, a segunda fase nunca o vê: a visita vira "aparelho novo" e um duplicado nasce. Para o seu objetivo (impedir vários cadastros do mesmo aparelho), esse erro é o que deixa um abusador escapar da contagem de contas por aparelho. A busca é, portanto, um ponto onde o sistema pode **perder** o aparelho sem avisar.

## 2. Como funciona hoje (v1)

Decisão **D90** em `docs/plano/decisoes.md`. Foi definida por mim, sem dado real. Os valores padrão são palpites.

Para cada característica da visita (canvas, fontes, tela, etc.):

1. O servidor lê, no contador, **quantos aparelhos têm esse valor**.
2. Se mais que `max(candidateMinDevices, candidateMaxShare × aparelhos conhecidos)` aparelhos têm o valor, ele é **comum demais**: ignorado na busca, porque diz pouco.
3. Dos valores que sobram, lê **no máximo `candidateRowsPerValue` aparelhos**, os vistos mais recentemente (índice `(tenant, característica, valor, última visita)`).
4. Cada aparelho lido ganha pontos pela raridade do valor (`-ln(parcela dos aparelhos que têm esse valor)`), somados entre as características.
5. Os `maxCandidates` com mais pontos vão para a comparação final.

### Os parâmetros (por tenant, recarregam com `SIGHUP`)

| Parâmetro | Padrão | Efeito |
|---|---|---|
| `identity.candidateRowsPerValue` | 200 | Quantos aparelhos de cada valor são lidos. Mais alto acha aparelhos antigos, mas custa mais tempo. |
| `identity.candidateMaxShare` | 0,05 | Acima desta fração dos aparelhos, o valor é comum demais e é ignorado. |
| `identity.candidateMinDevices` | 50 | Piso do item acima, em aparelhos. |
| `identity.maxCandidates` | 20 | Quantos candidatos chegam à comparação final. |

Referência completa em `docs/configuracao.md`.

### Onde está no código

| O quê | Arquivo |
|---|---|
| A regra (`CandidateRule`) | `server/src/identity/store.ts` |
| Busca no MySQL (uma leitura por valor, `UNION ALL`, índice) | `server/src/mysql/identity_store.ts` (`findCandidates`) |
| Busca no SQLite e na memória | `server/src/identity/sqlite_store.ts`, `memory_store.ts` |
| Passagem dos parâmetros | `server/src/identity/engine.ts`, `decision.ts`, `server/src/app.ts` |
| O índice | `server/src/mysql/schema.ts` (passo 2 das migrações) |

## 3. O que se sabe e o que não se sabe

**Medido:** só **latência**, com aparelhos **inventados**, no MySQL em Docker de um notebook, uma decisão por vez:

| Aparelhos | Mediana por decisão |
|---|---|
| 100 mil | 16 a 18 ms |
| 1 milhão | 26 a 41 ms |

**Não medido, e é o que importa:**
- **O aparelho certo entra na lista?** Com o teto de 200 por valor, um aparelho **antigo** que só divide valores comuns com muita gente pode ficar de fora. Um aparelho com valor raro sempre é achado.
- **Quanto os valores comuns demais atrapalham**, com dado real de navegador (muitos Safari/iPhone iguais, por exemplo).
- **Latência com carga real**, vários tenants e várias visitas ao mesmo tempo.

Os 200, os 5% e os 20 são palpites. Este documento serve para trocá-los por números.

## 4. Pré-requisito

- Os dados da Fase 0 coletados com consentimento (`docs/plano/guia-do-organizador.md`), com **centenas de aparelhos** e **várias visitas por aparelho, espalhadas no tempo**. Sem visitas repetidas do mesmo aparelho não há como saber se ele foi achado.
- O `linkedId` no formato `participante.aparelho`, que é o rótulo de verdade ("estas visitas são do mesmo aparelho").
- Regra 12 do `CLAUDE.md`: **nunca** ajustar nada com dado sintético. O gerador sintético só testa o programa.

## 5. A pergunta a responder: o recall do candidato

**Recall do candidato** = entre as visitas de aparelhos que o servidor **já conhecia**, em que fração o aparelho verdadeiro estava na lista de candidatos?

- Alto (perto de 100%): a busca não está perdendo ninguém.
- Baixo: a busca está perdendo aparelhos, e cada perda é um duplicado.

A meta inicial sugerida é **recall de pelo menos 99%**. É uma sugestão minha, sem dado por trás: revise com a sua tolerância a duplicados.

### Como medir

Repetir a mesma sequência de visitas, em ordem de tempo, duas vezes:

1. **Execução de produção:** com os parâmetros que você usa (`rowsPerValue` 200, `maxShare` 0,05, `minDevices` 50, `maxCandidates` 20).
2. **Execução de referência:** sem teto nenhum (`maxShare` 1, `minDevices` enorme, `rowsPerValue` enorme, `maxCandidates` enorme), isto é, uma busca exata.

A diferença entre as duas é a perda causada pela busca. Para cada visita em que as decisões diferem, registrar **qual teto** a causou:

| Causa | Como identificar |
|---|---|
| Valor comum demais, ignorado | o aparelho verdadeiro só dividia valores acima do `maxShare` |
| Teto por valor | o aparelho verdadeiro estava além dos `rowsPerValue` mais recentes de todos os seus valores |
| Teto de candidatos | o aparelho verdadeiro estava na leitura, mas ficou fora dos `maxCandidates` primeiros |

### O que falta no código para medir (honestidade)

Hoje **não dá** para medir isso sem uma extensão pequena:

- O comando `eval-identity` chama o motor com os padrões (`server/src/eval/identity_eval.ts` linha do `engine.resolve`), e **não aceita** parâmetros de busca. Falta passar `candidateRule` e `maxCandidates` por opções de linha de comando (`server/src/cli.ts`).
- Falta uma contagem de "o aparelho verdadeiro estava na lista". O dataset tem o rótulo (`linkedId`), mas o motor não devolve a lista de candidatos. Seria preciso o harness consultar a busca (`findCandidates`) e comparar com o rótulo.
- Falta um relatório que mostre o recall por causa e por navegador (regra 11: sempre com o número de **aparelhos** por trás, não só de visitas).

Isso é trabalho de algumas horas, com testes. Faça-o antes de mexer nos números.

## 6. O que fazer conforme o resultado

| O que você vê | O que fazer |
|---|---|
| Recall alto e latência aceitável | Não mexa. O v1 basta. |
| Perdas causadas pelo **teto por valor** | Suba `candidateRowsPerValue` (por exemplo 200 para 500, depois 1000) e meça de novo o recall **e a latência**. O custo cresce quase linearmente. |
| Perdas por **valor comum demais** | Suba `candidateMaxShare` (por exemplo 0,05 para 0,1). Valores comuns devolvem muitos aparelhos, então a latência sobe. |
| Perdas por **teto de candidatos** | Suba `maxCandidates`. A comparação final custa por candidato. |
| Subir os números resolve o recall mas a latência passa do que você aceita | Passe para o **v2 estrutural** (seção 7). |
| Perdas concentradas em um navegador (por exemplo Safari, onde os sinais são pulados) | Pode não ser um problema da busca, e sim de sinais com pouca informação. Veja a regra de empate e o `possibleLink`. |

Anote cada mudança como uma decisão nova em `docs/plano/decisoes.md` (a D90 fica como o ponto de partida) e regenere `docs/configuracao.md`.

## 7. O v2 estrutural, se os parâmetros não bastarem

Só faça se o item da tabela acima mandar. Da mais barata para a mais cara:

1. **Várias chaves de busca (blocking).** Além de buscar por valor isolado, criar chaves **compostas** de poucos sinais estáveis (por exemplo placa de vídeo + resolução + plataforma) e buscar por elas. É a técnica clássica de ligação de registros. Vive no MySQL, com um índice a mais, sem componente novo. **É o primeiro passo que eu tentaria.**
2. **Cache dos aparelhos ativos.** Guardar em memória os aparelhos vistos nos últimos dias e buscar primeiro neles. Só ajuda se a maioria das visitas vier de aparelhos recentes (o que os dados vão mostrar).
3. **LSH (por exemplo MinHash).** Representa o conjunto de valores de um aparelho por uma assinatura curta e acha vizinhos aproximados. Mais complexo, com parâmetros próprios que também precisam de calibração.
4. **Índice de vetores.** Transformar o aparelho em um vetor e buscar o vizinho mais próximo. O MySQL Community da sua VPS **não** tem busca vetorial nativa, então exigiria outro componente (outro banco, um serviço de busca vetorial) e mais operação. É o último recurso.

Em qualquer um, a regra de ouro continua: a busca só **propõe** candidatos. Quem decide é a comparação final, com a barra de certeza e a regra de empate. Isso não muda.

## 8. Passo a passo quando tiver dados

1. Confirme que o dataset da Fase 0 cumpre a seção 4 (centenas de aparelhos, visitas repetidas no tempo, `linkedId` com o aparelho).
2. Implemente a extensão da seção 5 (opções no `eval-identity` e a contagem de recall), com testes. Aplique teste de mutação na contagem (regra 10): uma busca que perde aparelho de propósito tem de derrubar o recall.
3. Rode a **referência** (sem tetos) e a **produção** (seus tetos) sobre o mesmo dataset.
4. Calcule o recall do candidato e a decomposição por causa, com intervalo de confiança **por aparelho** (regra 11).
5. Meça a **latência** em paralelo (`tools/loadtest/run.js`), com o banco com tamanho parecido com o real.
6. Escolha a linha da tabela da seção 6 e faça **uma** mudança por vez.
7. Repita a medida. Se bastar, registre a decisão e pare. Se não, vá para a seção 7 e comece pela chave composta.
8. Atualize `decisoes.md`, `docs/configuracao.md` e o relatório da fase.

## 9. Cuidados

- **Nunca ajustar com dado sintético** (regra 12). Os 100 mil e 1 milhão de aparelhos inventados só provam velocidade.
- **Tenants:** todo dado e toda leitura levam `tenantId` (regra 8). Uma chave composta nova também.
- **Privacidade:** uma chave composta nova guarda mais um valor derivado dos sinais. Revise com a LIA e o RIPD (`docs/plano/privacidade/`).
- **Não confundir recall com precisão.** Este documento mede se o aparelho certo **entra na lista**. Se a decisão final acerta é outra medida, que o `eval-identity` e a calibração (`fit-model`) cobrem.
- **Latência real é outra coisa.** Os 16 a 41 ms eram de uma decisão por vez, no notebook. Meça com a sua carga.
