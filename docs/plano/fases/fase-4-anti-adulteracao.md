# Fase 4: evidência de adulteração e proteção contra reenvio

Status: **código concluído com ressalvas.** Branch `fase-2-ingestao` (sem commit; as cinco fases estão no mesmo diretório de trabalho).

A fase dá ao servidor **evidência** de que um cliente foi adulterado, e nunca um veredito. Ela foi testada contra um navegador próprio adulterado de quatro formas. **Não foi testada contra navegadores anti-detecção profissionais**, que são feitos para passar justamente por estas verificações.

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Verificações | 15 funções puras do evento armazenado, cada uma devolvendo evidência com severidade (alta, média, baixa) e detalhe legível | `server/src/tamper/checks.ts` |
| Plataforma | Leitura do sistema operacional em cinco lugares (cabeçalho, `navigator.platform`, Client Hints, worker, `userAgentData`), com compatibilidade deliberadamente generosa | `server/src/tamper/user_agent.ts` |
| Desafio amarrado ao cliente | O nonce (`n2`) leva um rótulo assinado de quem o pediu: rede, cifras TLS e User-Agent. Na hora do envio o servidor compara e registra `match`, `mismatch` ou `none` | `server/src/ingest/nonce.ts`, `context.ts` |
| API | `GET /v1/events/:id` devolve `tamper` com os sinais e as contagens | `server/src/app.ts` |

As verificações: User-Agent diferente entre cabeçalho, página e worker; plataforma contraditória; página contra worker (núcleos, memória, idioma, fuso, dicas); GPU do worker contra a da página; **GPU contra plataforma** (Metal só em sistemas Apple, Direct3D só no Windows); marcas dos Client Hints; idioma do cabeçalho contra o da página; funções nativas trocadas; valores gravados direto em `navigator`; marcadores de automação; `HeadlessChrome`; permissão de notificação; valores impossíveis; relógio muito errado; contexto do desafio.

O resultado é calculado **na leitura**, a partir do evento guardado: uma regra melhorada vale também para visitas antigas, sem migração.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 359 de 359 |
| Teste de mutação | 19 comportamentos quebrados de propósito (verificações, compatibilidades e contexto do desafio), todos pegos. Quatro sobreviveram na primeira rodada (a rede de segurança que impede uma verificação de esconder as outras, e duas partes do contexto) e levaram a testes novos |
| Laboratório de adversário | Ver abaixo |

### Laboratório de adversário (meu navegador, meus dados)

O Chrome 155 desta máquina, com perfil limpo em cada caso, adulterado por recursos padrão do DevTools:

| Caso | O que o detector viu |
|---|---|
| Sem alteração | Só `headless_user_agent`, que é verdade (rodou headless). **Nenhuma falsa acusação** nas demais verificações |
| `navigator.platform` trocado só na página | `platform_inconsistent` (alta), `worker_page_mismatch` (alta), `native_functions_modified` (média) |
| User-Agent trocado "do jeito certo" via DevTools (cabeçalho, página e dicas juntos) | `platform_inconsistent` e `worker_page_mismatch` (idioma e plataforma): o worker continuava dizendo `macOS`. Com a GPU real, também `gpu_platform_inconsistent` (GPU Metal sob User-Agent do Windows) |
| Sinalizador de automação do navegador | `automation_markers` (alta) |

Isso mostra que a comparação página contra worker pega o tipo de ferramenta que troca o User-Agent pelo DevTools ou por bibliotecas de automação. Os scripts de adulteração ficaram **fora do repositório** de propósito: o laboratório existe para testar o detector, não para distribuir ferramenta de evasão.

## O que a verificação achou

- **A renderização por software esconde a verificação de GPU.** Com `--disable-gpu`, a GPU vira "SwiftShader" e a contradição Metal contra Windows não aparece. Com a GPU real, aparece.
- **Teste de caso legítimo é metade do trabalho.** Cada verificação tem um caso que a dispara e um caso honesto que não pode disparar: Android que se diz Linux, iPad em modo desktop (diz Mac), idioma com variante regional (`pt-PT` contra `pt-BR`), marca "falsa" de Client Hints com grafias diferentes, `null` vindo de `NaN`, `deviceMemory` de 16 (o Chrome 155 reporta isso).
- **Bug meu:** a verificação de valores impossíveis olhava só o instantâneo da página e ignorava o componente do payload, então um valor falso em só um deles passaria. Corrigido.

## O que NÃO foi verificado (ressalvas)

- **Navegadores anti-detecção profissionais.** São construídos para manter todas as visões coerentes (cabeçalho, página, worker, GPU, fontes). As verificações desta fase **não os pegam** se forem bem feitas. Testá-los exige o produto deles, em contas do dono, e é a próxima etapa do laboratório.
- **Falsas acusações em escala.** O teste de caso legítimo cobre os casos que conheço, num único computador. Extensões de privacidade e acessibilidade, o modo estrito do Firefox e navegadores de celular reais não foram testados. As verificações de severidade média e baixa devem ser lidas como pista, não como prova.
- **Safari, Firefox e Android reais.**
- **Contexto do desafio:** só testado em HTTP simples (todos os clientes de teste têm o mesmo IP) e em unidade. A troca de rede entre o pedido do desafio e o envio (Wi-Fi para 4G) gera `mismatch` legítimo; por isso é evidência e não rejeição.

## Limites de projeto

- **O motor de identidade ainda não usa a evidência.** Um payload forjado continua podendo criar aparelhos e distorcer as estatísticas de raridade (limitação da Fase 3). Falta decidir uma política, por exemplo não deixar uma visita de severidade alta ensinar o motor. Isso é decisão sua e entra na Fase 5.
- **Resultado selado (sealed results) não foi implementado.** O servidor já devolve só um `requestId` e o backend do cliente consulta a API, então a falsificação do resultado no navegador não é um risco aqui. Só valeria a pena para evitar a latência dessa consulta.
- **Comparações de sinais de rede (JA4 contra User-Agent) e de fuso contra IP** dependem de dados (tabela de JA4 por navegador, geolocalização de IP) que o projeto ainda não tem. Ficam para a Fase 5.
- **O reenvio exato já era barrado** pelo nonce de uso único; esta fase só acrescentou a amarra ao cliente.

## O que o dono precisa decidir

1. Se uma visita com evidência de severidade alta **deve** deixar de alimentar o motor de identidade.
2. Se quer testar navegadores anti-detecção em contas próprias (eu não distribuo nem escrevo ferramenta de evasão; o dono consegue produtos comerciais e roda a coleta com eles).
