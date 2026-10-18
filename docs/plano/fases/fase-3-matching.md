# Fase 3: motor de matching e confiança

Status: **código concluído com ressalvas; parâmetros provisórios.** Branch `fase-2-ingestao` (sem commit; as quatro fases estão no mesmo diretório de trabalho).

O motor funciona, é explicável e está testado. Mas **nenhum número dele foi medido com dados reais**, e por isso ele se declara "não calibrado" em cada resposta. Os valores dos parâmetros são palpites até alguém rodar `fit-model` com dados da Fase 0.

## O que foi feito

Cada visita recebe um `visitorId` aleatório por tenant (nunca derivado do fingerprint). O servidor guarda, para cada aparelho, **todos os valores que cada sinal já teve**, e compara a visita nova com os candidatos.

| Parte | O que faz | Onde |
|---|---|---|
| Características | 36 sinais viram "fichas" (resumos): GPU, fontes, tela, fuso, extensões TLS normalizadas, ordem dos cabeçalhos, HTTP/2, rede... Sinal que não foi lido some, em vez de virar um valor inventado | `server/src/identity/features.ts` |
| Modelo | Ligação de registros (Fellegi-Sunter): concordar num valor raro pesa muito, num comum pesa pouco; discordar nunca favorece um match; o prior é 1 em N aparelhos | `model.ts` |
| Motor | Busca candidatos, pontua, decide entre anexar a um aparelho conhecido ou criar um novo, e explica | `engine.ts` |
| Armazenamento | Em memória e em SQLite (mesmo arquivo dos eventos), com o mesmo contrato de testes | `memory_store.ts`, `sqlite_store.ts` |
| Ajuste | Aprende a chance de cada sinal manter o valor e calibra a escala da probabilidade, em grupos de aparelhos separados | `fit.ts` |
| Avaliação online | Processa o dataset em ordem de tempo e compara com o hash da biblioteca original | `eval/identity_eval.ts` |
| Servidor e comandos | `GET /v1/events/:id` devolve `identity`; `fit-model`, `eval-identity`, `last-events` | `app.ts`, `cli.ts` |

**O navegador continua recebendo só o `requestId`.** O `visitorId` e a explicação ficam no servidor, para o backend do cliente.

## Como a decisão é explicada

Cada resposta traz os sinais que mais pesaram, se concordaram ou discordaram, o peso de cada um e **a probabilidade que haveria sem aquele sinal**. É a explicabilidade que produtos fechados raramente oferecem. Exemplo real (Chrome 155): a visita voltou como o mesmo aparelho mesmo com o JA4 diferente, porque a normalização tirou a extensão de retomada de sessão.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 308 de 308 |
| Teste de mutação | 22 defesas e invariantes quebradas de propósito (pesos, prior, suavização, limiar, probabilidade sem calibração, isolamento entre tenants, ordenação por raridade, normalização do JA4, proxy, vazamento do `visitorId` ao navegador, falha do motor derrubar a visita, esquecimento de valores). Todas fazem a suíte falhar. Três sobreviveram na primeira rodada (e outras duas mutações não compilaram ou não casaram com o código e foram refeitas), o que levou a testes diretos das funções de peso e da ordenação de candidatos |
| Chrome real pelo servidor completo | 6 visitas da mesma máquina (duas configurações) receberam o mesmo `visitorId`, inclusive a visita com JA4 diferente |
| Avaliação sintética | O motor mantém ~97% dos pares do mesmo aparelho juntos sob atualizações de navegador, contra ~60% do hash exato. **Isso valida o código; não mede o mundo real** |

## O que a revisão achou (e foi corrigido)

- **Erro de modelagem:** com poucos aparelhos conhecidos, a chance de dois aparelhos aleatórios concordarem num sinal saía como 100%, e então um desacordo virava evidência **a favor** do match. Corrigido com suavização, e um desacordo nunca pesa a favor. Testes diretos garantem as duas propriedades para qualquer combinação de parâmetros.
- **Ajuste que divergia:** a calibração por Newton explodia (escala de 1,2 milhão). Trocada por versão robusta (eixo padronizado, busca de passo).
- **Três premissas erradas minhas nos testes**, descobertas pelo comportamento real do modelo: um valor raro pesa *mais* numa população maior (compensa o prior); a plataforma é igual em quase todos, então discordar nela é evidência fraca; dois aparelhos "gêmeos" precisam diferir em vários sinais estáveis para serem distintos.

## Achados que importam

- **O limiar é uma decisão de política, não uma constante.** A varredura sintética mostra uma curva suave: limiar mais alto cria mais ids (divide um aparelho) e menos colisões; mais baixo faz o contrário. Num mundo sintético "lotado", em que os sinais mal distinguem os aparelhos, a curva é íngreme: com limiar 0,95, 435 ids para 150 aparelhos (fragmenta mais que o hash); com 0,5, 187 ids e 2,7% de colisão. O limiar certo depende do **custo relativo** de misturar dois clientes contra deixar de ligar duas contas do mesmo, e dos dados reais.
- **Partida a frio:** com um único aparelho conhecido, qualquer valor parece raro e a evidência é fraca. A escala provisória foi escolhida para reconhecer um aparelho idêntico mesmo assim.
- **Aparelhos idênticos não se separam por sinais do cliente.** Um teste documenta isso: dois aparelhos físicos com os mesmos sinais recebem o mesmo id. Só rede e comportamento ajudam.

## O que NÃO foi verificado (ressalvas)

- Nenhum dado real além de 6 visitas de uma única máquina. Todos os parâmetros (chance de manter o valor por sinal, escala, limiar de 0,95) são provisórios.
- A calibração, quando ajustada, é medida nos mesmos dados em que é ajustada. O relatório avisa; é preciso confirmar em dados novos.
- Desempenho: cada resolução faz várias consultas SQL. Serve para milhares de aparelhos, não para milhões (Fase 8 deve manter contadores).
- Vários processos ao mesmo tempo: duas primeiras visitas simultâneas do mesmo aparelho podem criar dois ids. Com um processo só isso não ocorre.

## Limites de projeto

- **A independência dos sinais é uma simplificação.** O modelo soma evidências como se os sinais fossem independentes, mas GPU, canvas e extensões WebGL decorrem do mesmo hardware. A escala da probabilidade corrige isso em média, não por sinal.
- **Ids não são corrigidos depois.** Se duas pessoas foram misturadas, o sistema não separa; se o mesmo aparelho recebeu dois ids, não os une. Reprocessar eventos antigos com um modelo novo não foi implementado, e trocar o modelo muda atribuições futuras. Falta uma política de versão de ids.
- **Esquecimento parcial.** Apagar os eventos de uma pessoa apaga o aparelho dela se nenhum outro evento o usa. Se o aparelho é compartilhado com outro evento, ele fica com os resumos (hashes) dos valores que aquela visita contribuiu.
- **Privacidade.** O perfil do aparelho guarda só resumos (hashes) dos sinais, nunca valores crus nem o IP em claro, mas o `visitorId` é uma pseudonimização, não anonimização.

## A limitação mais séria: o motor confia no que o cliente envia

O código do navegador é público. Quem conhece os valores dos sinais de **outro** aparelho pode montar um payload com esses
valores e receber o mesmo `visitorId` dele (falsificação de identidade). E quem envia muitos aparelhos inventados distorce
as estatísticas de raridade de que o motor depende e a população que define o prior (envenenamento). O nonce só impede
reenviar um payload capturado, não impede um payload novo e forjado. Os limites de taxa por IP restringem o volume, mas
não resolvem. **Isso é o trabalho da Fase 4** (evidência de adulteração por contradição entre visões independentes) e da
Fase 5. Até lá, o `visitorId` não deve ser usado sozinho para bloquear alguém.

## O que o dono precisa decidir

1. **O custo de errar para cada lado**, para escolher o limiar: ligar por engano duas pessoas diferentes (acusar um cliente honesto) versus deixar de ligar duas contas do mesmo aparelho (fraude passando). Isso é decisão de negócio, não técnica.
2. Quando houver dados reais: `fit-model`, `eval-identity`, e ler os avisos antes dos números (ver o guia do organizador).
