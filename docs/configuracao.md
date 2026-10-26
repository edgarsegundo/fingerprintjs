# Referência de configuração

> Este arquivo é **gerado** pelo comando `node server/dist/cli.js config-reference --out docs/configuracao.md`.
> Não edite à mão: um teste falha se ele ficar diferente da tabela de parâmetros do código.

Todo parâmetro abaixo pode ser definido para todos os tenants em `defaults`
e sobreposto para um tenant em `settings`:

```json
{
  "defaults": { "identity": { "matchProbability": 0.97 }, "retention": { "eventsDays": 60 } },
  "tenants": [
    { "id": "loja", "publicKey": "pk_...", "secretKeySha256": ["..."],
      "settings": { "limits": { "collectPerMinutePerIp": 120 },
                    "tamper": { "disabledChecks": ["clock_skew"] } } }
  ]
}
```

Camadas, da mais baixa para a mais alta: os valores do código, os campos antigos de nível superior do arquivo
(`nonceTtlSeconds`, `rateLimit` e outros, mantidos por compatibilidade), `defaults` e `settings` do tenant.
Um nome desconhecido faz o servidor **recusar a partida** e sugere o nome mais próximo. Um parâmetro com `null`
como padrão usa o valor do modelo (ou desliga o recurso), conforme a descrição.

Um parâmetro que é um objeto de chaves livres (como `risk.ipTagWeights` ou `identity.featureM`) é **substituído
por inteiro**, não mesclado: se você pôr só `{ "datacenter": 80 }`, os outros rótulos deixam de contar.
Já os grupos (como `risk.velocity`) se mesclam parâmetro a parâmetro.

Para mudar sem reiniciar: edite o arquivo e envie `SIGHUP` ao processo.
Endereço, TLS, proxies confiáveis e banco só são lidos na partida.

## Desafio (nonce)

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `nonce.ttlSeconds` | inteiro de 30 a 3600 | `300` | Quanto tempo, em segundos, um desafio vale depois de emitido. Mais longo tolera páginas abertas por muito tempo; mais curto reduz a janela para reaproveitar um desafio. |
| `nonce.required` | true ou false | `true` | Se true, um envio sem desafio é recusado. Desligar tira a proteção contra reenvio e só deve ser feito em teste. |
| `nonce.bindToClient` | true ou false | `true` | Se true, o desafio carrega um rótulo de quem o pediu (rede, cifras TLS e User-Agent) e uma divergência no envio vira a evidência `nonce_context_mismatch`. Nunca recusa o envio. |

## Limites

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `limits.maxBodyBytes` | inteiro de 1024 a 10485760 | `524288` | Tamanho máximo do corpo de um envio, em bytes. Um payload normal tem cerca de 45 KB. |
| `limits.collectPerMinutePerIp` | inteiro de 1 a 1000000 | `30` | Envios por minuto aceitos de um mesmo endereço IP, para este tenant. |
| `limits.collectPerMinutePerTenant` | inteiro de 1 a 100000000 | `6000` | Envios por minuto aceitos no total, para este tenant. É o teto de uso do tenant. |
| `limits.noncePerMinutePerIp` | inteiro de 1 a 1000000 | `60` | Desafios por minuto emitidos para um mesmo endereço IP. |
| `limits.authFailuresPerMinutePerIp` | inteiro de 1 a 10000 | `10` | Tentativas de chave secreta erradas por minuto, por endereço IP, antes de bloquear. É o que impede adivinhar uma chave. Vale para todo o servidor, não por tenant. |
| `limits.apiPerMinutePerTenant` | inteiro de 1 a 1000000 | `600` | Quantas leituras da API de consulta (`/v1/events`, `/v1/visitors`) um tenant pode fazer por minuto, somadas. Protege o banco de um laço descontrolado do cliente. |

## API de consulta

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `api.defaultPageSize` | inteiro de 1 a 1000 | `50` | Quantos eventos uma listagem devolve quando o pedido não diz `limit`. |
| `api.maxPageSize` | inteiro de 1 a 1000 | `200` | O maior `limit` aceito numa listagem. Pedidos maiores recebem este valor. Cada item da listagem custa algumas consultas, então um valor alto pesa no banco. |
| `api.allowIdentityEdits` | true ou false | `true` | Permite corrigir quem é quem pela API: juntar dois aparelhos (`POST /v1/visitors/:id/merge`) e separar visitas de um aparelho (`POST /v1/visitors/:id/split`). Cada correção vai para o registro de auditoria. Desligue se só quiser que o motor decida. |
| `api.allowDeletion` | true ou false | `true` | Permite apagar dados pela API (`DELETE /v1/subjects`, `DELETE /v1/visitors/:id`), para atender o pedido de um titular. Desligue se quiser que a exclusão só aconteça por um caminho com mais controle. |
| `api.maxExportEvents` | inteiro de 1 a 100000 | `1000` | O maior número de visitas que uma exportação (`GET /v1/subjects/export`) devolve. Uma exportação maior é cortada e avisa. |

## Privacidade

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `privacy.ipStorage` | `full`, `truncated`, `hash`, `none` | `"full"` | O que guardar do endereço IP do visitante. `full`: inteiro. `truncated`: IPv4 até /24 e IPv6 até /48. `hash`: hash com chave diferente por tenant (visitas do mesmo IP ainda se reconhecem, mas o IP não volta; é pseudonimização, não anonimização). `none`: nada. Os rótulos das listas, o país e o limite por IP não são afetados. Vale para as visitas novas; as já guardadas ficam como estão. |
| `privacy.dropSignals` | estrutura própria, veja a descrição | `[]` | Nomes de sinais que o servidor descarta assim que a visita chega, antes de usá-los ou guardá-los (por exemplo `speechVoices`). É o mesmo que `exclude` no coletor, mas imposto pelo servidor: nenhuma verificação nem o motor de identidade verá esses sinais. |
| `privacy.anonymityK` | inteiro de 2 a 1000 | `5` | No relatório `GET /v1/anonymity`, um aparelho é "fácil de isolar" por uma característica quando menos de k aparelhos têm o mesmo valor. |
| `privacy.requireConsent` | true ou false | `false` | Recusa (422 `consent_required`) visitas cuja página não declare `consent: { basis: "consent", ... }`. A declaração é da página e o navegador não consegue prová-la: serve para auditoria, não como prova. |

## Auditoria de acessos

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `audit.enabled` | true ou false | `true` | Registra quem leu ou apagou dados pessoais pela API (leituras de evento, listagens, visitante, exportação e exclusão), sem registrar o conteúdo lido. |
| `audit.retentionDays` | inteiro de 1 a 3650 | `365` | Por quantos dias guardar o registro de acessos. |

## Grafo compartilhado (desligado)

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `sharedGraph.participate` | true ou false | `false` | Participa do grafo compartilhado entre tenants: contribui com contagens e recebe contagens dos outros. Só pode ser ligado se `sharedGraph.enabled` estiver ligado no arquivo, o que exige a referência de um parecer jurídico. Nunca atravessa evento, conta, endereço ou nome de tenant, só contagens agregadas. |
| `sharedGraph.windowDays` | inteiro de 1 a 90 | `7` | Quantos dias para trás contam o que outros tenants viram. Não passa da retenção do grafo (`sharedGraph.retentionDays` do arquivo). |
| `sharedGraph.flagDecisions` | estrutura própria, veja a descrição | `["block"]` | Decisões das suas regras que contam como "marcado como abusivo" para os outros tenants. Sem regras (`rules.list` vazia) nada é marcado. |
| `sharedGraph.excludeCountries` | estrutura própria, veja a descrição | `[]` | Países (código de duas letras) cujos visitantes nem contribuem nem consultam o grafo. Use para excluir quem exige consentimento prévio (a UE, por exemplo) até haver parecer. Depende de `ipGeoFile`: uma visita sem país conhecido participa. |
| `sharedGraph.minFeatures` | inteiro de 3 a 12 | `8` | Quantas características do aparelho precisam existir para formar a chave do grafo. Menos que isso junta aparelhos sem relação (modelos iguais). Uma visita com menos fica fora do grafo. |

## Coleta guiada pelo servidor

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `collection.exclude` | estrutura própria, veja a descrição | `[]` | Sinais que o servidor pede à página para NÃO coletar, na resposta do desafio (`profile.exclude`). A página aplica com `profileToOptions`. É um pedido: quem quer impor usa `privacy.dropSignals`. |
| `collection.include` | estrutura própria, veja a descrição | `[]` | Sinais opcionais (como `webGpu` ou `behavior`) que o servidor pede à página para coletar (`profile.include`). |
| `collection.elevatedTags` | lista de: texto | `[]` | Rótulos de IP (`ipLists`, como `datacenter` ou `tor_exit`) que fazem o servidor pedir uma coleta ampliada (`collection.elevatedInclude`) a quem pede o desafio. Vazio desliga. Coletar mais só de quem parece suspeito reduz a coleta de todos os outros. |
| `collection.elevatedInclude` | estrutura própria, veja a descrição | `[]` | Sinais opcionais a mais pedidos na coleta ampliada. |

## Deriva

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `drift.jsThreshold` | número de 0 a 1 | `0.3` | Divergência de Jensen-Shannon (0 a 1) a partir da qual uma característica conta como deslocada entre dois períodos em `GET /v1/drift`. |
| `drift.minSamples` | inteiro de 1 a 100000 | `30` | Quantas visitas com a característica são precisas em cada período para calcular a deriva. Menos que isso a diferença pode ser acaso. |
| `drift.maxEvents` | inteiro de 10 a 100000 | `5000` | O máximo de visitas lidas por período no relatório de deriva. Cada visita custa uma extração de características, então um valor alto pesa. Passando disso o relatório avisa que amostrou. |

## tenants

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `tenants.refreshSeconds` | inteiro de 0 a 86400 | `60` | De quantos em quantos segundos o servidor lê de novo os tenants guardados no banco. Serve para vários servidores sobre o mesmo banco: um tenant criado pela API de administração de um deles aparece nos outros em até este tempo. 0 desliga (só uma partida ou `SIGHUP` relê). Vale para o processo todo e é lido na partida (`defaults`). |

## environment

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `environment.enabled` | true ou false | `true` | Liga as verificações do ambiente da visita (janela privada provável, placa de vídeo virtual, imagem desenhada por software). Não é adulteração e não é erro: são fatos sobre o lugar de onde a visita vem, com peso 0 no risco até você decidir o contrário (`risk.environmentWeights`). |
| `environment.disabledChecks` | lista de: `private_mode_likely`, `virtual_machine_gpu`, `software_renderer` | `[]` | Verificações de ambiente que não rodam: o sinal delas nunca aparece. |
| `environment.privateQuotaBytes` | inteiro de 1048576 a 1099511627776 | `134217728` | Uma cota de armazenamento do navegador abaixo disto, em bytes, é tomada como sinal de janela privada (`private_mode_likely`). O padrão é 128 MiB. Navegadores recentes escondem de propósito a diferença, então é um sinal fraco e que envelhece: confira com navegadores seus antes de dar peso. |

## bots

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `bots.verify` | true ou false | `true` | Confere por DNS se uma visita que diz ser um robô de busca conhecido (Googlebot, Bingbot, Applebot, YandexBot, Baiduspider) vem mesmo dele: o nome do endereço tem de estar no domínio que o buscador publica e esse nome tem de apontar de volta ao mesmo endereço. Só consulta quando o User-Agent faz essa afirmação. Cada consulta envia o endereço do visitante ao servidor de DNS que a máquina usa; desligue se isso for um problema. |
| `bots.dnsTimeoutMs` | inteiro de 100 a 10000 | `1500` | Quanto esperar o DNS na verificação de robôs, em milissegundos. Sem resposta a tempo o resultado é "não sei", nunca "falso": um DNS fora do ar não pode fazer um robô de verdade parecer falso. |
| `bots.cacheSeconds` | inteiro de 60 a 604800 | `3600` | Por quanto tempo lembrar a resposta da verificação de um endereço (sim ou não). "Não sei" não é lembrado. |
| `bots.cacheEntries` | inteiro de 100 a 1000000 | `10000` | Quantas respostas da verificação de robôs a memória guarda. Vale para o processo todo e é lido na partida (`defaults`). |
| `bots.maxConcurrent` | inteiro de 1 a 200 | `8` | Quantas verificações de DNS podem esperar ao mesmo tempo. Passando disto, a visita fica com "não sei". Evita que uma enxurrada de User-Agents falsos prenda o servidor. Vale para o processo todo e é lido na partida (`defaults`). |

## Cotas

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `quota.collectsPerMonth` | inteiro de 0 a 1000000000 | `0` | Quantas visitas o tenant pode enviar por mês (UTC). Passando disso, novas visitas recebem 429 `quota_exceeded` até o mês seguinte. 0 não limita. A contagem é a de `GET /v1/usage`. |
| `quota.apiReadsPerMonth` | inteiro de 0 a 1000000000 | `0` | Quantas chamadas autenticadas à API de consulta o tenant pode fazer por mês (UTC). 0 não limita. Ler o próprio uso (`/v1/usage`) nunca é bloqueado. |

## Retenção

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `retention.eventsDays` | inteiro de 1 a 3650 | `30` | Por quantos dias um evento fica guardado. Depois disso o evento é apagado, e o aparelho também, se nenhum outro evento o usa. |

## Identificação de visitante

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `identity.enabled` | true ou false | `true` | Liga o motor que dá um `visitorId` a cada visita. Desligado, as visitas são só guardadas. |
| `identity.modelFile` | texto ou `null` | `null` | Caminho do modelo ajustado com `fit-model`. Sem ele o motor usa parâmetros provisórios e as respostas dizem que não estão calibradas. |
| `identity.matchProbability` | número entre 0 e 1, sem os extremos ou `null` | `null` | Certeza exigida para anexar uma visita a um aparelho já conhecido. Mais alto divide mais aparelhos e mistura menos pessoas; mais baixo faz o contrário. `null` usa o valor do modelo (0,99 sem modelo: ligar duas pessoas diferentes é o erro mais caro). Veja `docs/plano/fases/fase-3-matching.md`. |
| `identity.possibleLinkProbability` | número entre 0 e 1, sem os extremos ou `null` | `null` | Certeza a partir da qual uma visita que NÃO foi anexada é marcada como "possível ligação" com o aparelho mais parecido, sem juntar os identificadores. Deve ser menor que `matchProbability`. `null` desliga a marcação. |
| `identity.onAmbiguous` | `attach`, `separate` | `"separate"` | O que fazer quando dois aparelhos conhecidos servem quase igualmente. `separate`: não liga a visita a nenhum, cria um aparelho novo e marca o mais próximo como `possibleLink`. `attach`: liga ao melhor mesmo assim. O padrão evita ligar duas pessoas diferentes, que é o erro mais caro; um duplicado se junta depois. |
| `identity.maxCandidates` | inteiro de 1 a 500 | `20` | Quantos aparelhos conhecidos são comparados com cada visita. Mais candidatos custam mais tempo. |
| `identity.candidateMaxShare` | número entre 0 e 1, sem os extremos | `0.05` | Um valor que mais que esta fração dos aparelhos conhecidos compartilham (e mais que `candidateMinDevices` aparelhos) é comum demais para servir de pista: não se leem os aparelhos que o têm. Mais alto acha mais candidatos e custa mais tempo; mais baixo é mais rápido e pode perder o aparelho certo. |
| `identity.candidateMinDevices` | inteiro de 1 a 100000 | `50` | Piso do teto de `candidateMaxShare`, em aparelhos. Com poucos aparelhos conhecidos quase todo valor seria comum demais, então este número garante que valores com até esta quantidade de aparelhos sempre sejam lidos. |
| `identity.candidateRowsPerValue` | inteiro de 1 a 100000 | `200` | De todos os aparelhos que têm um valor (que não seja comum demais), só se leem os visitados mais recentemente, até este número. Faz o custo de uma visita não crescer com a população. Mais alto acha aparelhos antigos que só dividem valores partilhados por muitos; mais baixo é mais rápido. Um valor raro (poucos aparelhos) é sempre lido inteiro. |
| `identity.ambiguityMargin` | número de 0 a 50 | `2` | Se o segundo melhor aparelho ficar a menos que isto (em log-odds) do melhor, a decisão é marcada como ambígua. |
| `identity.explanationSize` | inteiro de 1 a 60 | `8` | Quantos sinais aparecem na explicação de cada decisão. |
| `identity.sameMachine.enabled` | true ou false | `true` | Procura, para cada visita, aparelhos conhecidos que parecem ser a MESMA MÁQUINA em outro navegador (mesmo endereço pouco antes, nunca visto neste navegador, mesma tela, fuso, família de placa de vídeo e vozes do sistema). Não junta nada: o `visitorId` continua sendo por navegador e a ligação aparece em `identity.sameMachine` da resposta. |
| `identity.sameMachine.windowMinutes` | inteiro de 1 a 1440 | `30` | Por quantos minutos o mesmo endereço (IP) conta como "ao mesmo tempo" para procurar a mesma máquina em outro navegador. Mais alto acha mais casos e aumenta a chance de pegar outra pessoa na mesma rede. |
| `identity.sameMachine.maxDevicesPerIp` | inteiro de 1 a 100 | `5` | Se mais aparelhos conhecidos que isto usaram o mesmo endereço na janela (escritório, escola, operadora de celular com IP compartilhado), nada é ligado: o endereço não diz nada. A resposta marca `skipped: shared_ip`. |
| `identity.sameMachine.minLogOdds` | número de 0 a 50 | `4` | Evidência mínima, em log-odds, vinda só das características da máquina, para ligar. Valor PROVISÓRIO: sem dados reais rotulados (Fase 0) não existe número de precisão. Mais alto liga menos e erra menos. |
| `identity.sameMachine.minFeatures` | inteiro de 1 a 20 | `3` | Quantas características de máquina precisam ter concordado (e estar presentes na visita) para ligar. Impede ligar por uma ou duas características que quase todo mundo tem. |
| `identity.sameMachine.maxLinks` | inteiro de 1 a 20 | `3` | O máximo de ligações de mesma máquina que uma visita recebe (as mais fortes primeiro). |
| `identity.person.enabled` | true ou false | `true` | Liga a camada de pessoa: liga os aparelhos de um mesmo tenant por conta (`linkedId`), mesma máquina em outro navegador, mesma rede em horários próximos e correção manual, e responde "quem mais é esta pessoa" em `person` da resposta. Não muda nenhum `visitorId`. É um tratamento de dados que liga aparelhos; veja a análise de privacidade antes de ligar para outros tenants. |
| `identity.person.groupingKinds` | lista de: `linked_id`, `same_machine`, `network`, `possible_link`, `manual` | `["linked_id","same_machine","manual"]` | Que tipos de ligação fazem dois aparelhos virarem a mesma pessoa. `linked_id`: mesma conta. `same_machine`: mesma máquina em outro navegador. `manual`: ligação feita por uma pessoa. `network` (mesmo IP em horários próximos) e `possible_link` ficam de fora de propósito: uma família na mesma rede tem o mesmo IP e são pessoas diferentes, então são só evidência. |
| `identity.person.maxDevices` | inteiro de 2 a 500 | `20` | O máximo de aparelhos de uma pessoa. Uma conta compartilhada por mais aparelhos que isto não liga ninguém, e uma pessoa que passa disso é cortada e marcada `truncated`, sem alimentar regras. |
| `identity.person.networkWindowMinutes` | inteiro de 0 a 1440 | `60` | Por quantos minutos o mesmo IP gera uma ligação de rede (só evidência, não agrupa sozinha). 0 desliga a ligação por rede. |
| `identity.person.networkMaxDevicesPerIp` | inteiro de 1 a 100 | `5` | Se mais aparelhos que isto usaram o mesmo IP na janela (escritório, escola, operadora de celular), nenhuma ligação de rede é gravada. |
| `identity.learnFromTampered` | `always`, `not_high`, `never_flagged` | `"not_high"` | Que visitas com evidência de adulteração podem ensinar o motor (criar aparelhos e acrescentar valores). `always`: todas. `not_high`: as sem evidência de severidade alta. `never_flagged`: só as sem nenhuma evidência. Uma visita que não aprende ainda recebe um `visitorId`, mas ele não é guardado no perfil. |
| `identity.storedId.enabled` | true ou false | `false` | Liga o código aleatório que a página grava no navegador do visitante (cookie, local storage e IndexedDB) e que o motor usa como o sinal mais forte para reconhecer o mesmo navegador. É um identificador persistente gravado no aparelho do titular: só ligue com base legal definida e texto de privacidade que o mencione. O navegador só grava quando a página declara uma das bases de `identity.storedId.bases`; o servidor descarta o sinal de uma visita que não declarou. Veja `docs/collector.md`. |
| `identity.storedId.bases` | lista de: `consent`, `legitimate_interest` | `["consent","legitimate_interest"]` | Bases legais (declaradas pela página em `consent.basis`) com as quais o código guardado pode ser usado. Deixe só `consent` para exigir consentimento. Lista vazia equivale a não usar o código. |
| `identity.storedId.maxAgeDays` | inteiro de 1 a 400 | `365` | Por quantos dias o cookie com o código vive no navegador (vai no perfil de coleta da resposta do desafio). O Chrome não guarda cookie por mais de 400 dias, e o Safari limita o que um script grava a 7 dias sem visita. |
| `identity.storedIdConflictThreshold` | número de 1 a 100 | `10` | Quanto o que não muda (placa de vídeo, tela, memória) tem de discordar, em log-odds somados, para marcar `storedIdConflict` numa visita que trouxe o código guardado de um aparelho conhecido. Mais baixo marca mais; mais alto marca só discordância forte. |
| `identity.disabledFeatures` | lista de: `canvas`, `webglRenderer`, `webglVendor`, `webglParameters`, `webglExtensions`, `audio`, `fonts`, `fontPreferences`, `math`, `screenResolution`, `screenFrame`, `colorDepth`, `colorGamut`, `hdr`, `touch`, `hardwareConcurrency`, `deviceMemory`, `platform`, `timezone`, `languages`, `vendor`, `plugins`, `architecture`, `userAgentPlatform`, `userAgentVersion`, `preferences`, `speechVoices`, `mediaSupport`, `storageQuota`, `tlsCiphers`, `tlsExtensions`, `tlsVersionAlpn`, `headerOrder`, `headerCore`, `http2`, `browserFamily`, `gpuFamily`, `storedId`, `ipPrefix`, `ip` | `[]` | Sinais que o motor ignora. Use para tirar um sinal que se mostrou instável ou que você não quer usar por privacidade. |
| `identity.featureM` | objeto (chaves conhecidas) com valores: número entre 0 e 1, sem os extremos | `{}` | Chance de o mesmo aparelho manter o valor de um sinal, por sinal. Sobrepõe o que o modelo aprendeu. Perto de 1 significa que o sinal quase nunca muda. |
| `identity.featureVolatility` | objeto (chaves conhecidas) com valores: `stable`, `semi`, `volatile` | `{}` | Muda a volatilidade de um sinal (`stable`, `semi` ou `volatile`), o que muda quanto uma discordância pesa. |
| `identity.defaultM.stable` | número entre 0 e 1, sem os extremos ou `null` | `null` | Chance padrão de manter o valor para sinais stable sem valor próprio. `null` usa o do modelo (0.98 sem modelo). |
| `identity.defaultM.semi` | número entre 0 e 1, sem os extremos ou `null` | `null` | Chance padrão de manter o valor para sinais semi sem valor próprio. `null` usa o do modelo (0.9 sem modelo). |
| `identity.defaultM.volatile` | número entre 0 e 1, sem os extremos ou `null` | `null` | Chance padrão de manter o valor para sinais volatile sem valor próprio. `null` usa o do modelo (0.5 sem modelo). |
| `identity.maxWeight` | número de 1 a 100 ou `null` | `null` | O maior peso, em log-odds, que um único sinal pode somar a favor de um aparelho. `null` usa o do modelo (12 sem modelo). |
| `identity.disagreementFloor.stable` | número de -50 a 0 ou `null` | `null` | O pior peso que uma discordância pode ter (sinais stable). `null` usa o do modelo (-6 sem modelo). |
| `identity.disagreementFloor.semi` | número de -50 a 0 ou `null` | `null` | O pior peso que uma discordância pode ter (sinais semi). `null` usa o do modelo (-3 sem modelo). |
| `identity.disagreementFloor.volatile` | número de -50 a 0 ou `null` | `null` | O pior peso que uma discordância pode ter (sinais volatile). `null` usa o do modelo (-1.5 sem modelo). |
| `identity.scale` | número de 0.001 a 10 ou `null` | `null` | Escala provisória que transforma a soma de evidências em probabilidade. Só vale enquanto o modelo não está calibrado; um modelo ajustado usa a escala dele. `null` usa 0,75. |
| `identity.offset` | número de -50 a 50 ou `null` | `null` | Deslocamento provisório da mesma conversão. `null` usa 0. |

## Evidência de adulteração

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `tamper.enabled` | true ou false | `true` | Liga a evidência de adulteração na resposta e a política `identity.learnFromTampered`. |
| `tamper.disabledChecks` | lista de: `user_agent_inconsistent`, `platform_inconsistent`, `worker_page_mismatch`, `iframe_page_mismatch`, `webgl_worker_mismatch`, `gpu_platform_inconsistent`, `client_hints_brands_mismatch`, `language_header_mismatch`, `native_functions_modified`, `navigator_overridden_on_instance`, `automation_markers`, `headless_user_agent`, `notification_permission_inconsistent`, `impossible_values`, `clock_skew`, `nonce_context_mismatch` | `[]` | Verificações desligadas. Desligue uma que acuse injustamente o seu público (por exemplo, uma extensão que seus usuários usam). |
| `tamper.severity` | objeto (chaves conhecidas) com valores: `low`, `medium`, `high` | `{}` | Muda a severidade (`low`, `medium`, `high`) de uma verificação. Aqui você decide o que conta como grave. |
| `tamper.clockSkewSeconds` | inteiro de 5 a 86400 | `300` | Quanto o relógio do navegador pode diferir do servidor, em segundos, antes de virar a evidência `clock_skew`. |

## Risco composto

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `risk.enabled` | true ou false | `true` | Liga o risco composto na resposta do evento. É uma **heurística** (soma de pesos que você define), não uma probabilidade: nenhum peso foi calibrado com dados reais. |
| `risk.ipTagWeights` | objeto (chaves livres) com valores: número de 0 a 100 | `{"datacenter":25,"tor_exit":40,"vpn":20,"proxy":20}` | Peso de cada rótulo das listas de IP (`ipLists`). As chaves são os rótulos que você escolheu na configuração. Um rótulo que não está aqui não conta. Os pesos padrão são palpites. |
| `risk.tamperWeights` | objeto (chaves conhecidas) com valores: número de 0 a 100 | `{"high":40,"medium":15,"low":5}` | Peso de cada sinal de adulteração, pela severidade que ele tem para este tenant (veja `tamper.severity`). Cada sinal soma uma vez. |
| `risk.timezoneMismatchWeight` | número de 0 a 100 | `10` | Peso de o fuso horário do navegador não existir no país do IP. Precisa de `ipGeoFile` e `timezoneTable` na configuração. Viajantes e VPN disparam isto legitimamente, então o padrão é baixo. |
| `risk.possibleLinkWeight` | número de 0 a 100 | `15` | Peso de a visita parecer outro aparelho já conhecido sem ter chegado ao limiar de ligação (`identity.possibleLinkProbability`). Pode indicar quem troca de identificador de propósito. |
| `risk.sameMachineWeight` | número de 0 a 100 | `0` | Peso de a visita parecer a mesma máquina de outro aparelho em outro navegador (`identity.sameMachine`). O padrão é 0: usar dois navegadores é normal e não indica fraude. Aumente só se o seu caso trata isso como suspeito. |
| `risk.multiAccountWeight` | número de 0 a 100 | `20` | Peso de a pessoa (os aparelhos ligados a este) ter usado `risk.multiAccountThreshold` contas ou mais. É o sinal de várias contas da mesma pessoa. É um palpite até haver casos rotulados. |
| `risk.multiAccountThreshold` | inteiro de 2 a 100 | `2` | Quantas contas distintas (`linkedId`) a pessoa precisa ter usado para somar `risk.multiAccountWeight`. |
| `risk.fakeCrawlerWeight` | número de 0 a 100 | `30` | Peso de o navegador dizer ser um robô de busca conhecido (Googlebot, Bingbot...) e o endereço NÃO ser de verdade dele. Só conta quando a verificação por DNS respondeu "não"; se o DNS não respondeu, não pesa. Veja `bots.verify`. |
| `risk.environmentWeights` | objeto (chaves conhecidas) com valores: número de 0 a 100 | `{}` | Peso de cada verificação de ambiente (`private_mode_likely`, `virtual_machine_gpu`, `software_renderer`). Vazio: nenhuma pesa. Janela privada é escolha legítima de privacidade e máquina virtual é uso comum de desenvolvedor e de empresa; só dê peso se, no seu fluxo, isso for raro entre pessoas de verdade. |
| `risk.storedIdConflictWeight` | número de 0 a 100 | `25` | Peso de a visita trazer o código guardado de um aparelho conhecido mas discordar dele no que não muda. Pode indicar um código copiado para outra máquina, ou um aparelho trocado que herdou o perfil do navegador. |
| `risk.graphFlaggedWeight` | número de 0 a 100 | `0` | Peso de o aparelho ter sido marcado como abusivo por pelo menos `sharedGraph.minTenants` outros tenants na janela. Só conta se o tenant participa do grafo. O padrão é 0 porque é um sinal novo e sem dados. |
| `risk.newVisitorWeight` | número de 0 a 100 | `0` | Peso de o aparelho ser novo. O padrão é 0 porque todo cliente novo é novo: só faz sentido em fluxos onde um aparelho desconhecido é raro (login de conta antiga). |
| `risk.levels.medium` | número de 0 a 100 | `25` | Pontuação a partir da qual o nível é `medium`. Abaixo disso é `low`. |
| `risk.levels.high` | número de 0 a 100 | `60` | Pontuação a partir da qual o nível é `high`. Tem de ser maior que `risk.levels.medium`. |
| `risk.velocity.windowMinutes` | inteiro de 1 a 10080 | `1440` | Janela, em minutos antes da visita, em que se contam visitas do mesmo aparelho ou do mesmo IP. O padrão é um dia. |
| `risk.velocity.linkedIdsPerDevice.threshold` | inteiro de 1 a 1000 | `3` | Quantos `linkedId` (contas, normalmente) diferentes o mesmo aparelho pode ter na janela antes de contar como várias contas num aparelho só. |
| `risk.velocity.linkedIdsPerDevice.weight` | número de 0 a 100 | `25` | Peso de o aparelho ter `linkedId` demais na janela. 0 desliga. |
| `risk.velocity.devicesPerIp.threshold` | inteiro de 1 a 100000 | `10` | Quantos aparelhos diferentes podem sair do mesmo IP na janela. Escritórios, escolas e operadoras de celular (CGNAT) têm muitos aparelhos num IP, então o padrão é alto. |
| `risk.velocity.devicesPerIp.weight` | número de 0 a 100 | `10` | Peso de o IP ter aparelhos demais na janela. 0 desliga. |
| `risk.velocity.ipsPerDevice.threshold` | inteiro de 1 a 100000 | `6` | Quantos IPs diferentes o mesmo aparelho pode usar na janela. Quem anda entre redes (casa, trabalho, celular) usa alguns; muitos sugerem rotação de proxy. |
| `risk.velocity.ipsPerDevice.weight` | número de 0 a 100 | `10` | Peso de o aparelho usar IPs demais na janela. 0 desliga. |
| `risk.behavior.syntheticEventsThreshold` | inteiro de 1 a 10000 | `1` | Quantos eventos de clique, tecla, rolagem ou toque criados por script (e não pelo navegador) contam como comportamento sintético. Só existe se a página liga o sinal `behavior` no coletor. |
| `risk.behavior.syntheticEventsWeight` | número de 0 a 100 | `20` | Peso de a página ter recebido eventos de interação criados por script. Alguns gerenciadores de senha e ferramentas de acessibilidade também geram cliques sintéticos, por isso o padrão não é alto. |
| `risk.behavior.noInteractionMinObservedMs` | inteiro de 100 a 3600000 | `5000` | Só se fala em "nenhuma interação" se o coletor observou a página por pelo menos isto, em milissegundos. Se o observador começou junto com o envio, a visita é desconhecida, não suspeita. |
| `risk.behavior.noInteractionWeight` | número de 0 a 100 | `5` | Peso de nenhuma interação real (movimento, clique, tecla, rolagem ou toque) em uma página observada pelo tempo mínimo. Leitores de tela e automação legítima também não geram, então é um peso pequeno. |

## Webhooks

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `webhooks.endpoints` | estrutura própria, veja a descrição | `[]` | Para onde avisar de cada visita. Cada item é `{ "id", "url", "secrets": [...], "minRiskScore", "decisions": [...] }`. `secrets` assina a chamada (use dois enquanto troca um); `minRiskScore` e `decisions` filtram quais visitas são enviadas. O destinatário confere a assinatura com `verifyWebhook` do SDK. Vazio, nada é enviado. |
| `webhooks.maxAttempts` | inteiro de 1 a 30 | `8` | Quantas vezes tentar entregar antes de desistir. Falha de rede, tempo esgotado, 5xx, 408 e 429 tentam de novo; outro 4xx desiste na hora. |
| `webhooks.baseDelaySeconds` | inteiro de 1 a 3600 | `30` | Espera antes da segunda tentativa, em segundos. Dobra a cada tentativa até `maxDelaySeconds`. |
| `webhooks.maxDelaySeconds` | inteiro de 1 a 86400 | `3600` | A maior espera entre duas tentativas, em segundos. Não pode ser menor que `baseDelaySeconds`. |
| `webhooks.timeoutSeconds` | inteiro de 1 a 60 | `10` | Quanto esperar a resposta do destinatário, em segundos, conexão incluída. |
| `webhooks.maxPendingPerTenant` | inteiro de 1 a 1000000 | `10000` | Quantas entregas podem esperar por tenant. Passando disso, as novas são descartadas (e registradas no log), para um destinatário parado não encher o banco. |
| `webhooks.allowHttp` | true ou false | `false` | Aceita endereços `http://`. Só para testes: o corpo da chamada vai sem criptografia. |
| `webhooks.allowPrivateNetworks` | true ou false | `false` | Aceita destinatários em redes privadas, na própria máquina ou em faixas reservadas. Desligado por padrão: quem consegue definir uma URL não deve conseguir fazer o servidor chamar serviços internos. |
| `webhooks.keepDoneHours` | inteiro de 1 a 8760 | `24` | Por quantas horas guardar o registro de uma entrega bem-sucedida. |
| `webhooks.keepFailedDays` | inteiro de 1 a 365 | `14` | Por quantos dias guardar uma entrega que desistiu, para você ver e reenviar. |

## Regras de decisão

| Parâmetro | Valores | Padrão | O que faz |
|---|---|---|---|
| `rules.list` | estrutura própria, veja a descrição | `[]` | Regras que transformam o que o servidor sabe em uma decisão. Cada regra é `{ "id", "when", "decision", "reason" }`. A primeira que valer decide. `when` combina `all`, `any`, `not` e comparações `{ "field", "op", "value" }`. Os campos e operadores aceitos estão em `docs/regras.md`. Uma regra errada impede a partida. Vazia, o evento não traz `decision`. |
| `rules.defaultDecision` | estrutura própria, veja a descrição | `"allow"` | Decisão quando há regras e nenhuma vale. |

