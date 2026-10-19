# Fase 0: harness de avaliação e coleta de dados rotulados

Status: **código concluído com ressalvas; os dados reais ainda não existem.** Branch `v5.3.0-fork` (sem commit; as três fases estão no mesmo diretório de trabalho).

A fase tem duas metades. A de código está pronta e testada. A de dados depende de pessoas reais e de um servidor
alcançável, e só o dono do projeto pode fazê-la. **Nenhum número de precisão foi medido nesta fase.**

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Rótulo de verdade | `linkedId`: identificador opaco que o integrador escolhe. Aceita só letras, números e `_ - . :`, o que rejeita e-mail por construção. Indexado no SQLite, com migração de bancos antigos | `src/collector/`, `server/src/ingest/validate.ts`, `server/src/store/` |
| Exportação | `export-events` gera um dataset JSONL só com eventos rotulados. IP vira hash com chave descartável, e o arquivo não contém o endereço | `server/src/eval/dataset.ts`, `cli.ts` |
| Estatística | Intervalos por bootstrap sobre aparelhos, ROC, AUC, EER, entropia, regra dos três | `server/src/eval/stats.ts` |
| Pares | Todos os pares do mesmo aparelho e pares distintos de aparelhos diferentes, sem repetição, com semente fixa | `server/src/eval/pairs.ts` |
| Pontuadores | O hash da biblioteca original (calculado com o bundle real, não com uma cópia) e um piso difuso simples | `server/src/eval/scorers.ts`, `legacy.ts` |
| Relatório | FNMR e FMR com intervalo, estabilidade por tempo entre visitas, resultado por navegador, unicidade, avisos de amostra | `server/src/eval/report.ts` |
| Dado sintético | Gerador com verdade conhecida, **só** para testar o harness | `server/src/eval/synthetic.ts` |
| Coleta | Página de consentimento para voluntários e o protocolo | `tools/calibration/`, [protocolo](../protocolo-coleta-etica.md) |
| Retirada | `delete-linked` apaga os dados de quem desistir | `server/src/cli.ts`, `store/` |

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 195 de 195 |
| Valores de referência da estatística | Wilson, AUC, EER, entropia e regra dos três batem com valores conhecidos |
| Teste de mutação nas 7 partes que decidem o que o relatório afirma | todas fazem a suíte falhar. Três sobreviveram na primeira rodada (comparador do limiar, fronteira dos intervalos de tempo, contagem de eventos sem rótulo) e levaram a testes de fronteira |
| Pipeline com Chrome real | 9 visitas rotuladas de 3 configurações, passando por coletor, servidor TLS, banco, exportação e avaliação com o hash real |
| Página de coleta | Em Chrome real, 3 cenários: sem consentimento, entrada parecida com e-mail e envio válido. Só o válido foi gravado |
| Lint, build, testes do navegador | verdes |

## O que a verificação com dados reais achou

- **Defeito do harness (corrigido):** a primeira versão amostrava pares com reposição. Com 9 visitas só existem 27 pares distintos de aparelhos diferentes, e ela reportava 100.000, com um intervalo de confiança de 0,6 ponto. Era uma precisão inventada. Agora os pares são distintos e o intervalo reamostra aparelhos: com 3 aparelhos o resultado é 0% a 100%, que é a resposta honesta.
- **Defeito do servidor (corrigido):** as respostas de erro não levavam os cabeçalhos CORS. Para uma página de outra origem, um 422 ou um 429 aparecia como "Failed to fetch", e ela nunca leria `invalid_nonce` nem `Retry-After`.
- **Defeito do cliente (corrigido):** `linkedId: null` passava pela validação. Agora só aceita texto.
- **Fato real, uma observação:** duas das três configurações do mesmo Chrome (tamanhos de janela e idioma diferentes) geraram o **mesmo** hash da biblioteca original. É o caso clássico de "aparelhos idênticos". Com 3 aparelhos não prova nada sobre a taxa, mas mostra que a colisão acontece com facilidade.

## O que NÃO foi verificado

- Nenhum dado de pessoas reais, em nenhum navegador que não seja o Chrome desta máquina.
- A página de coleta em Safari e em celulares.
- O texto de consentimento com um jurídico. É um modelo.
- O desempenho do relatório com dezenas de milhares de eventos (o bootstrap faz centenas de passadas sobre os pares).

## Melhorias feitas depois, para facilitar a implantação

- O servidor serve a própria página de coleta (`calibrationDir`): um endereço só para o voluntário.
- O servidor recarrega o certificado renovado sem reiniciar (teste com dois certificados reais).
- Achado verificado: o JA4 do mesmo Chrome varia entre conexões da mesma sessão. A extensão `0029` (retomada de sessão TLS) aparece nas conexões seguintes e muda a parte c. A parte b (cifras) é estável. Decisão D25: a Fase 3 não deve comparar o JA4 inteiro por igualdade.
- Guia passo a passo para o organizador: [guia-do-organizador.md](../guia-do-organizador.md).

## O que fica para o dono

1. **Decidir o servidor alcançável** (resposta à pergunta que ficou aberta): um nome como `fp.seudominio.com` apontando para o VPS e uma porta livre como 8443, para os voluntários conseguirem enviar de fora da sua máquina. Sem isso, só dá para coletar localmente.
2. **Revisar o texto de consentimento** e preencher prazo e contato em `config.js`.
3. **Recrutar voluntários** conforme o [protocolo](../protocolo-coleta-etica.md) (algumas centenas de aparelhos para medir estabilidade com folga).
4. **Rodar `export-events` e `eval`** quando houver dados, e ler os avisos antes dos números.

## Limite que o harness torna explícito

Provar uma taxa de falso match de 0,1% ou menor exige milhares de aparelhos. Com algumas centenas de voluntários, o melhor que se mede é estabilidade e colisões concretas. Qualquer afirmação de "precisão de X%" precisa dizer com quantos aparelhos foi medida.
