/* eslint-disable max-len -- the descriptions are prose for the person who operates the server, and they are copied
   as they are into the reference document, so they are kept on one line each instead of cut in pieces */
import { environmentCheckIds } from '../environment/ids'
import { featureNames } from '../identity/features'
import { ipStorageModes } from '../privacy/ip_policy'
import { decisionPattern, validateRules } from '../risk/rules'
import { tamperCheckIds } from '../tamper/ids'
import { validateEndpoints } from '../webhooks/endpoints'

import type { Kind } from './kinds'

/**
 * Every setting of the server, in one table.
 *
 * The table is the single source of truth: it gives the default, the allowed values and the explanation of each
 * parameter. The checks, the defaults, the layering by tenant and the reference document (`docs/configuracao.md`) are
 * all made from it, so a parameter that is not in the table does not exist, and a parameter in the table is documented.
 *
 * A parameter can be set for all tenants (`defaults` in the configuration file) and overridden for one tenant
 * (`settings` of the tenant). `null` in a parameter that allows it means "use the value that the model file gives".
 */
export interface Parameter {
  /** Dotted path, such as `identity.matchProbability` */
  path: string
  kind: Kind
  /** `null` is allowed only if `nullable` */
  default: unknown
  nullable?: boolean
  /** What it does and what changes when it is raised or lowered. Written for the person who operates the server. */
  description: string
}

const probability: Kind = { type: 'number', min: 0, max: 1, exclusive: true }
const volatility: Kind = { type: 'enum', values: ['stable', 'semi', 'volatile'] }
const severity: Kind = { type: 'enum', values: ['low', 'medium', 'high'] }

/** A list of at most `max` names of signals: letters, digits and "_" */
const signalNames = (max: number): Kind => ({
  type: 'json',
  validate: (value) =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every((name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
      ? undefined
      : `must be a list of at most ${max} signal names (letters, digits and _)`,
})

const volatilityNumbers = (
  name: string,
  description: string,
  min: number,
  max: number,
  builtin: [number, number, number],
) =>
  (['stable', 'semi', 'volatile'] as const).map(
    (level, index): Parameter => ({
      path: `${name}.${level}`,
      kind: { type: 'number', min, max },
      nullable: true,
      default: null,
      description: `${description} (sinais ${level}). \`null\` usa o do modelo (${builtin[index]} sem modelo).`,
    }),
  )

export const parameters: Parameter[] = [
  // --- Desafio (nonce)
  {
    path: 'nonce.ttlSeconds',
    kind: { type: 'integer', min: 30, max: 3600 },
    default: 300,
    description:
      'Quanto tempo, em segundos, um desafio vale depois de emitido. Mais longo tolera páginas abertas por muito tempo; mais curto reduz a janela para reaproveitar um desafio.',
  },
  {
    path: 'nonce.required',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Se true, um envio sem desafio é recusado. Desligar tira a proteção contra reenvio e só deve ser feito em teste.',
  },
  {
    path: 'nonce.bindToClient',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Se true, o desafio carrega um rótulo de quem o pediu (rede, cifras TLS e User-Agent) e uma divergência no envio vira a evidência `nonce_context_mismatch`. Nunca recusa o envio.',
  },
  // --- Limites
  {
    path: 'limits.maxBodyBytes',
    kind: { type: 'integer', min: 1024, max: 10 * 1024 * 1024 },
    default: 512 * 1024,
    description: 'Tamanho máximo do corpo de um envio, em bytes. Um payload normal tem cerca de 45 KB.',
  },
  {
    path: 'limits.collectPerMinutePerIp',
    kind: { type: 'integer', min: 1, max: 1_000_000 },
    default: 30,
    description: 'Envios por minuto aceitos de um mesmo endereço IP, para este tenant.',
  },
  {
    path: 'limits.collectPerMinutePerTenant',
    kind: { type: 'integer', min: 1, max: 100_000_000 },
    default: 6000,
    description: 'Envios por minuto aceitos no total, para este tenant. É o teto de uso do tenant.',
  },
  {
    path: 'limits.noncePerMinutePerIp',
    kind: { type: 'integer', min: 1, max: 1_000_000 },
    default: 60,
    description: 'Desafios por minuto emitidos para um mesmo endereço IP.',
  },
  {
    path: 'limits.authFailuresPerMinutePerIp',
    kind: { type: 'integer', min: 1, max: 10_000 },
    default: 10,
    description:
      'Tentativas de chave secreta erradas por minuto, por endereço IP, antes de bloquear. É o que impede adivinhar uma chave. Vale para todo o servidor, não por tenant.',
  },
  {
    path: 'limits.apiPerMinutePerTenant',
    kind: { type: 'integer', min: 1, max: 1_000_000 },
    default: 600,
    description:
      'Quantas leituras da API de consulta (`/v1/events`, `/v1/visitors`) um tenant pode fazer por minuto, somadas. Protege o banco de um laço descontrolado do cliente.',
  },
  // --- API de consulta
  {
    path: 'api.defaultPageSize',
    kind: { type: 'integer', min: 1, max: 1000 },
    default: 50,
    description: 'Quantos eventos uma listagem devolve quando o pedido não diz `limit`.',
  },
  {
    path: 'api.maxPageSize',
    kind: { type: 'integer', min: 1, max: 1000 },
    default: 200,
    description:
      'O maior `limit` aceito numa listagem. Pedidos maiores recebem este valor. Cada item da listagem custa algumas consultas, então um valor alto pesa no banco.',
  },
  // --- Privacidade
  {
    path: 'privacy.ipStorage',
    kind: { type: 'enum', values: ipStorageModes },
    default: 'full',
    description:
      'O que guardar do endereço IP do visitante. `full`: inteiro. `truncated`: IPv4 até /24 e IPv6 até /48. `hash`: hash com chave diferente por tenant (visitas do mesmo IP ainda se reconhecem, mas o IP não volta; é pseudonimização, não anonimização). `none`: nada. Os rótulos das listas, o país e o limite por IP não são afetados. Vale para as visitas novas; as já guardadas ficam como estão.',
  },
  {
    path: 'privacy.dropSignals',
    kind: signalNames(100),
    default: [],
    description:
      'Nomes de sinais que o servidor descarta assim que a visita chega, antes de usá-los ou guardá-los (por exemplo `speechVoices`). É o mesmo que `exclude` no coletor, mas imposto pelo servidor: nenhuma verificação nem o motor de identidade verá esses sinais.',
  },
  {
    path: 'privacy.anonymityK',
    kind: { type: 'integer', min: 2, max: 1000 },
    default: 5,
    description:
      'No relatório `GET /v1/anonymity`, um aparelho é "fácil de isolar" por uma característica quando menos de k aparelhos têm o mesmo valor.',
  },
  {
    path: 'privacy.requireConsent',
    kind: { type: 'boolean' },
    default: false,
    description:
      'Recusa (422 `consent_required`) visitas cuja página não declare `consent: { basis: "consent", ... }`. A declaração é da página e o navegador não consegue prová-la: serve para auditoria, não como prova.',
  },
  {
    path: 'api.allowIdentityEdits',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Permite corrigir quem é quem pela API: juntar dois aparelhos (`POST /v1/visitors/:id/merge`) e separar visitas de um aparelho (`POST /v1/visitors/:id/split`). Cada correção vai para o registro de auditoria. Desligue se só quiser que o motor decida.',
  },
  {
    path: 'api.allowDeletion',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Permite apagar dados pela API (`DELETE /v1/subjects`, `DELETE /v1/visitors/:id`), para atender o pedido de um titular. Desligue se quiser que a exclusão só aconteça por um caminho com mais controle.',
  },
  {
    path: 'api.maxExportEvents',
    kind: { type: 'integer', min: 1, max: 100_000 },
    default: 1000,
    description:
      'O maior número de visitas que uma exportação (`GET /v1/subjects/export`) devolve. Uma exportação maior é cortada e avisa.',
  },
  // --- Auditoria
  {
    path: 'audit.enabled',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Registra quem leu ou apagou dados pessoais pela API (leituras de evento, listagens, visitante, exportação e exclusão), sem registrar o conteúdo lido.',
  },
  {
    path: 'audit.retentionDays',
    kind: { type: 'integer', min: 1, max: 3650 },
    default: 365,
    description: 'Por quantos dias guardar o registro de acessos.',
  },
  // --- Grafo compartilhado
  {
    path: 'sharedGraph.participate',
    kind: { type: 'boolean' },
    default: false,
    description:
      'Participa do grafo compartilhado entre tenants: contribui com contagens e recebe contagens dos outros. Só pode ser ligado se `sharedGraph.enabled` estiver ligado no arquivo, o que exige a referência de um parecer jurídico. Nunca atravessa evento, conta, endereço ou nome de tenant, só contagens agregadas.',
  },
  {
    path: 'sharedGraph.windowDays',
    kind: { type: 'integer', min: 1, max: 90 },
    default: 7,
    description:
      'Quantos dias para trás contam o que outros tenants viram. Não passa da retenção do grafo (`sharedGraph.retentionDays` do arquivo).',
  },
  {
    path: 'sharedGraph.flagDecisions',
    kind: {
      type: 'json',
      validate: (value) =>
        Array.isArray(value) &&
        value.length <= 20 &&
        value.every((word) => typeof word === 'string' && decisionPattern.test(word))
          ? undefined
          : 'must be a list of at most 20 lower-case words such as block',
    },
    default: ['block'],
    description:
      'Decisões das suas regras que contam como "marcado como abusivo" para os outros tenants. Sem regras (`rules.list` vazia) nada é marcado.',
  },
  {
    path: 'sharedGraph.excludeCountries',
    kind: {
      type: 'json',
      validate: (value) =>
        Array.isArray(value) &&
        value.length <= 300 &&
        value.every((code) => typeof code === 'string' && /^[A-Z]{2}$/.test(code))
          ? undefined
          : 'must be a list of country codes with two capital letters, such as BR',
    },
    default: [],
    description:
      'Países (código de duas letras) cujos visitantes nem contribuem nem consultam o grafo. Use para excluir quem exige consentimento prévio (a UE, por exemplo) até haver parecer. Depende de `ipGeoFile`: uma visita sem país conhecido participa.',
  },
  {
    path: 'sharedGraph.minFeatures',
    kind: { type: 'integer', min: 3, max: 12 },
    default: 8,
    description:
      'Quantas características do aparelho precisam existir para formar a chave do grafo. Menos que isso junta aparelhos sem relação (modelos iguais). Uma visita com menos fica fora do grafo.',
  },
  // --- Coleta guiada pelo servidor
  {
    path: 'collection.exclude',
    kind: signalNames(100),
    default: [],
    description:
      'Sinais que o servidor pede à página para NÃO coletar, na resposta do desafio (`profile.exclude`). A página aplica com `profileToOptions`. É um pedido: quem quer impor usa `privacy.dropSignals`.',
  },
  {
    path: 'collection.include',
    kind: signalNames(20),
    default: [],
    description:
      'Sinais opcionais (como `webGpu` ou `behavior`) que o servidor pede à página para coletar (`profile.include`).',
  },
  {
    path: 'collection.elevatedTags',
    kind: { type: 'list', item: { type: 'string' }, max: 50 },
    default: [],
    description:
      'Rótulos de IP (`ipLists`, como `datacenter` ou `tor_exit`) que fazem o servidor pedir uma coleta ampliada (`collection.elevatedInclude`) a quem pede o desafio. Vazio desliga. Coletar mais só de quem parece suspeito reduz a coleta de todos os outros.',
  },
  {
    path: 'collection.elevatedInclude',
    kind: signalNames(20),
    default: [],
    description: 'Sinais opcionais a mais pedidos na coleta ampliada.',
  },
  // --- Deriva
  {
    path: 'drift.jsThreshold',
    kind: { type: 'number', min: 0, max: 1 },
    default: 0.3,
    description:
      'Divergência de Jensen-Shannon (0 a 1) a partir da qual uma característica conta como deslocada entre dois períodos em `GET /v1/drift`.',
  },
  {
    path: 'drift.minSamples',
    kind: { type: 'integer', min: 1, max: 100_000 },
    default: 30,
    description:
      'Quantas visitas com a característica são precisas em cada período para calcular a deriva. Menos que isso a diferença pode ser acaso.',
  },
  {
    path: 'drift.maxEvents',
    kind: { type: 'integer', min: 10, max: 100_000 },
    default: 5000,
    description:
      'O máximo de visitas lidas por período no relatório de deriva. Cada visita custa uma extração de características, então um valor alto pesa. Passando disso o relatório avisa que amostrou.',
  },
  // --- Cotas
  {
    path: 'tenants.refreshSeconds',
    kind: { type: 'integer', min: 0, max: 86400 },
    default: 60,
    description:
      'De quantos em quantos segundos o servidor lê de novo os tenants guardados no banco. Serve para vários servidores sobre o mesmo banco: um tenant criado pela API de administração de um deles aparece nos outros em até este tempo. 0 desliga (só uma partida ou `SIGHUP` relê). Vale para o processo todo e é lido na partida (`defaults`).',
  },
  {
    path: 'environment.enabled',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Liga as verificações do ambiente da visita (janela privada provável, placa de vídeo virtual, imagem desenhada por software). Não é adulteração e não é erro: são fatos sobre o lugar de onde a visita vem, com peso 0 no risco até você decidir o contrário (`risk.environmentWeights`).',
  },
  {
    path: 'environment.disabledChecks',
    kind: { type: 'list', item: { type: 'enum', values: [...environmentCheckIds] }, max: 10 },
    default: [],
    description: 'Verificações de ambiente que não rodam: o sinal delas nunca aparece.',
  },
  {
    path: 'environment.privateQuotaBytes',
    kind: { type: 'integer', min: 1048576, max: 1099511627776 },
    default: 134217728,
    description:
      'Uma cota de armazenamento do navegador abaixo disto, em bytes, é tomada como sinal de janela privada (`private_mode_likely`). O padrão é 128 MiB. Navegadores recentes escondem de propósito a diferença, então é um sinal fraco e que envelhece: confira com navegadores seus antes de dar peso.',
  },
  {
    path: 'bots.verify',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Confere por DNS se uma visita que diz ser um robô de busca conhecido (Googlebot, Bingbot, Applebot, YandexBot, Baiduspider) vem mesmo dele: o nome do endereço tem de estar no domínio que o buscador publica e esse nome tem de apontar de volta ao mesmo endereço. Só consulta quando o User-Agent faz essa afirmação. Cada consulta envia o endereço do visitante ao servidor de DNS que a máquina usa; desligue se isso for um problema.',
  },
  {
    path: 'bots.dnsTimeoutMs',
    kind: { type: 'integer', min: 100, max: 10000 },
    default: 1500,
    description:
      'Quanto esperar o DNS na verificação de robôs, em milissegundos. Sem resposta a tempo o resultado é "não sei", nunca "falso": um DNS fora do ar não pode fazer um robô de verdade parecer falso.',
  },
  {
    path: 'bots.cacheSeconds',
    kind: { type: 'integer', min: 60, max: 604800 },
    default: 3600,
    description:
      'Por quanto tempo lembrar a resposta da verificação de um endereço (sim ou não). "Não sei" não é lembrado.',
  },
  {
    path: 'bots.cacheEntries',
    kind: { type: 'integer', min: 100, max: 1000000 },
    default: 10000,
    description:
      'Quantas respostas da verificação de robôs a memória guarda. Vale para o processo todo e é lido na partida (`defaults`).',
  },
  {
    path: 'bots.maxConcurrent',
    kind: { type: 'integer', min: 1, max: 200 },
    default: 8,
    description:
      'Quantas verificações de DNS podem esperar ao mesmo tempo. Passando disto, a visita fica com "não sei". Evita que uma enxurrada de User-Agents falsos prenda o servidor. Vale para o processo todo e é lido na partida (`defaults`).',
  },
  {
    path: 'quota.collectsPerMonth',
    kind: { type: 'integer', min: 0, max: 1_000_000_000 },
    default: 0,
    description:
      'Quantas visitas o tenant pode enviar por mês (UTC). Passando disso, novas visitas recebem 429 `quota_exceeded` até o mês seguinte. 0 não limita. A contagem é a de `GET /v1/usage`.',
  },
  {
    path: 'quota.apiReadsPerMonth',
    kind: { type: 'integer', min: 0, max: 1_000_000_000 },
    default: 0,
    description:
      'Quantas chamadas autenticadas à API de consulta o tenant pode fazer por mês (UTC). 0 não limita. Ler o próprio uso (`/v1/usage`) nunca é bloqueado.',
  },
  // --- Retenção
  {
    path: 'retention.eventsDays',
    kind: { type: 'integer', min: 1, max: 3650 },
    default: 30,
    description:
      'Por quantos dias um evento fica guardado. Depois disso o evento é apagado, e o aparelho também, se nenhum outro evento o usa.',
  },
  // --- Identificação de visitante
  {
    path: 'identity.enabled',
    kind: { type: 'boolean' },
    default: true,
    description: 'Liga o motor que dá um `visitorId` a cada visita. Desligado, as visitas são só guardadas.',
  },
  {
    path: 'identity.modelFile',
    kind: { type: 'string' },
    nullable: true,
    default: null,
    description:
      'Caminho do modelo ajustado com `fit-model`. Sem ele o motor usa parâmetros provisórios e as respostas dizem que não estão calibradas.',
  },
  {
    path: 'identity.matchProbability',
    kind: probability,
    nullable: true,
    default: null,
    description:
      'Certeza exigida para anexar uma visita a um aparelho já conhecido. Mais alto divide mais aparelhos e mistura menos pessoas; mais baixo faz o contrário. `null` usa o valor do modelo (0,99 sem modelo: ligar duas pessoas diferentes é o erro mais caro). Veja `docs/plano/fases/fase-3-matching.md`.',
  },
  {
    path: 'identity.possibleLinkProbability',
    kind: probability,
    nullable: true,
    default: null,
    description:
      'Certeza a partir da qual uma visita que NÃO foi anexada é marcada como "possível ligação" com o aparelho mais parecido, sem juntar os identificadores. Deve ser menor que `matchProbability`. `null` desliga a marcação.',
  },
  {
    path: 'identity.onAmbiguous',
    kind: { type: 'enum', values: ['attach', 'separate'] },
    default: 'separate',
    description:
      'O que fazer quando dois aparelhos conhecidos servem quase igualmente. `separate`: não liga a visita a nenhum, cria um aparelho novo e marca o mais próximo como `possibleLink`. `attach`: liga ao melhor mesmo assim. O padrão evita ligar duas pessoas diferentes, que é o erro mais caro; um duplicado se junta depois.',
  },
  {
    path: 'identity.maxCandidates',
    kind: { type: 'integer', min: 1, max: 500 },
    default: 20,
    description: 'Quantos aparelhos conhecidos são comparados com cada visita. Mais candidatos custam mais tempo.',
  },
  {
    path: 'identity.candidateMaxShare',
    kind: probability,
    default: 0.05,
    description:
      'Um valor que mais que esta fração dos aparelhos conhecidos compartilham (e mais que `candidateMinDevices` aparelhos) é comum demais para servir de pista: não se leem os aparelhos que o têm. Mais alto acha mais candidatos e custa mais tempo; mais baixo é mais rápido e pode perder o aparelho certo.',
  },
  {
    path: 'identity.candidateMinDevices',
    kind: { type: 'integer', min: 1, max: 100000 },
    default: 50,
    description:
      'Piso do teto de `candidateMaxShare`, em aparelhos. Com poucos aparelhos conhecidos quase todo valor seria comum demais, então este número garante que valores com até esta quantidade de aparelhos sempre sejam lidos.',
  },
  {
    path: 'identity.candidateRowsPerValue',
    kind: { type: 'integer', min: 1, max: 100000 },
    default: 200,
    description:
      'De todos os aparelhos que têm um valor (que não seja comum demais), só se leem os visitados mais recentemente, até este número. Faz o custo de uma visita não crescer com a população. Mais alto acha aparelhos antigos que só dividem valores partilhados por muitos; mais baixo é mais rápido. Um valor raro (poucos aparelhos) é sempre lido inteiro.',
  },
  {
    path: 'identity.ambiguityMargin',
    kind: { type: 'number', min: 0, max: 50 },
    default: 2,
    description:
      'Se o segundo melhor aparelho ficar a menos que isto (em log-odds) do melhor, a decisão é marcada como ambígua.',
  },
  {
    path: 'identity.explanationSize',
    kind: { type: 'integer', min: 1, max: 60 },
    default: 8,
    description: 'Quantos sinais aparecem na explicação de cada decisão.',
  },
  {
    path: 'identity.sameMachine.enabled',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Procura, para cada visita, aparelhos conhecidos que parecem ser a MESMA MÁQUINA em outro navegador (mesmo endereço pouco antes, nunca visto neste navegador, mesma tela, fuso, família de placa de vídeo e vozes do sistema). Não junta nada: o `visitorId` continua sendo por navegador e a ligação aparece em `identity.sameMachine` da resposta.',
  },
  {
    path: 'identity.sameMachine.windowMinutes',
    kind: { type: 'integer', min: 1, max: 1440 },
    default: 30,
    description:
      'Por quantos minutos o mesmo endereço (IP) conta como "ao mesmo tempo" para procurar a mesma máquina em outro navegador. Mais alto acha mais casos e aumenta a chance de pegar outra pessoa na mesma rede.',
  },
  {
    path: 'identity.sameMachine.maxDevicesPerIp',
    kind: { type: 'integer', min: 1, max: 100 },
    default: 5,
    description:
      'Se mais aparelhos conhecidos que isto usaram o mesmo endereço na janela (escritório, escola, operadora de celular com IP compartilhado), nada é ligado: o endereço não diz nada. A resposta marca `skipped: shared_ip`.',
  },
  {
    path: 'identity.sameMachine.minLogOdds',
    kind: { type: 'number', min: 0, max: 50 },
    default: 4,
    description:
      'Evidência mínima, em log-odds, vinda só das características da máquina, para ligar. Valor PROVISÓRIO: sem dados reais rotulados (Fase 0) não existe número de precisão. Mais alto liga menos e erra menos.',
  },
  {
    path: 'identity.sameMachine.minFeatures',
    kind: { type: 'integer', min: 1, max: 20 },
    default: 3,
    description:
      'Quantas características de máquina precisam ter concordado (e estar presentes na visita) para ligar. Impede ligar por uma ou duas características que quase todo mundo tem.',
  },
  {
    path: 'identity.sameMachine.maxLinks',
    kind: { type: 'integer', min: 1, max: 20 },
    default: 3,
    description: 'O máximo de ligações de mesma máquina que uma visita recebe (as mais fortes primeiro).',
  },
  {
    path: 'identity.person.enabled',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Liga a camada de pessoa: liga os aparelhos de um mesmo tenant por conta (`linkedId`), mesma máquina em outro navegador, mesma rede em horários próximos e correção manual, e responde "quem mais é esta pessoa" em `person` da resposta. Não muda nenhum `visitorId`. É um tratamento de dados que liga aparelhos; veja a análise de privacidade antes de ligar para outros tenants.',
  },
  {
    path: 'identity.person.groupingKinds',
    kind: {
      type: 'list',
      item: { type: 'enum', values: ['linked_id', 'same_machine', 'network', 'possible_link', 'manual'] },
      max: 5,
    },
    default: ['linked_id', 'same_machine', 'manual'],
    description:
      'Que tipos de ligação fazem dois aparelhos virarem a mesma pessoa. `linked_id`: mesma conta. `same_machine`: mesma máquina em outro navegador. `manual`: ligação feita por uma pessoa. `network` (mesmo IP em horários próximos) e `possible_link` ficam de fora de propósito: uma família na mesma rede tem o mesmo IP e são pessoas diferentes, então são só evidência.',
  },
  {
    path: 'identity.person.maxDevices',
    kind: { type: 'integer', min: 2, max: 500 },
    default: 20,
    description:
      'O máximo de aparelhos de uma pessoa. Uma conta compartilhada por mais aparelhos que isto não liga ninguém, e uma pessoa que passa disso é cortada e marcada `truncated`, sem alimentar regras.',
  },
  {
    path: 'identity.person.networkWindowMinutes',
    kind: { type: 'integer', min: 0, max: 1440 },
    default: 60,
    description:
      'Por quantos minutos o mesmo IP gera uma ligação de rede (só evidência, não agrupa sozinha). 0 desliga a ligação por rede.',
  },
  {
    path: 'identity.person.networkMaxDevicesPerIp',
    kind: { type: 'integer', min: 1, max: 100 },
    default: 5,
    description:
      'Se mais aparelhos que isto usaram o mesmo IP na janela (escritório, escola, operadora de celular), nenhuma ligação de rede é gravada.',
  },
  {
    path: 'identity.learnFromTampered',
    kind: { type: 'enum', values: ['always', 'not_high', 'never_flagged'] },
    default: 'not_high',
    description:
      'Que visitas com evidência de adulteração podem ensinar o motor (criar aparelhos e acrescentar valores). `always`: todas. `not_high`: as sem evidência de severidade alta. `never_flagged`: só as sem nenhuma evidência. Uma visita que não aprende ainda recebe um `visitorId`, mas ele não é guardado no perfil.',
  },
  {
    path: 'identity.storedId.enabled',
    kind: { type: 'boolean' },
    default: false,
    description:
      'Liga o código aleatório que a página grava no navegador do visitante (cookie, local storage e IndexedDB) e que o motor usa como o sinal mais forte para reconhecer o mesmo navegador. É um identificador persistente gravado no aparelho do titular: só ligue com base legal definida e texto de privacidade que o mencione. O navegador só grava quando a página declara uma das bases de `identity.storedId.bases`; o servidor descarta o sinal de uma visita que não declarou. Veja `docs/collector.md`.',
  },
  {
    path: 'identity.storedId.bases',
    kind: { type: 'list', item: { type: 'enum', values: ['consent', 'legitimate_interest'] }, max: 2 },
    default: ['consent', 'legitimate_interest'],
    description:
      'Bases legais (declaradas pela página em `consent.basis`) com as quais o código guardado pode ser usado. Deixe só `consent` para exigir consentimento. Lista vazia equivale a não usar o código.',
  },
  {
    path: 'identity.storedId.maxAgeDays',
    kind: { type: 'integer', min: 1, max: 400 },
    default: 365,
    description:
      'Por quantos dias o cookie com o código vive no navegador (vai no perfil de coleta da resposta do desafio). O Chrome não guarda cookie por mais de 400 dias, e o Safari limita o que um script grava a 7 dias sem visita.',
  },
  {
    path: 'identity.storedIdConflictThreshold',
    kind: { type: 'number', min: 1, max: 100 },
    default: 10,
    description:
      'Quanto o que não muda (placa de vídeo, tela, memória) tem de discordar, em log-odds somados, para marcar `storedIdConflict` numa visita que trouxe o código guardado de um aparelho conhecido. Mais baixo marca mais; mais alto marca só discordância forte.',
  },
  {
    path: 'identity.disabledFeatures',
    kind: { type: 'list', item: { type: 'enum', values: featureNames }, max: 100 },
    default: [],
    description:
      'Sinais que o motor ignora. Use para tirar um sinal que se mostrou instável ou que você não quer usar por privacidade.',
  },
  {
    path: 'identity.featureM',
    kind: { type: 'map', keys: featureNames, value: probability },
    default: {},
    description:
      'Chance de o mesmo aparelho manter o valor de um sinal, por sinal. Sobrepõe o que o modelo aprendeu. Perto de 1 significa que o sinal quase nunca muda.',
  },
  {
    path: 'identity.featureVolatility',
    kind: { type: 'map', keys: featureNames, value: volatility },
    default: {},
    description:
      'Muda a volatilidade de um sinal (`stable`, `semi` ou `volatile`), o que muda quanto uma discordância pesa.',
  },
  ...(['stable', 'semi', 'volatile'] as const).map(
    (level, index): Parameter => ({
      path: `identity.defaultM.${level}`,
      kind: probability,
      nullable: true,
      default: null,
      description: `Chance padrão de manter o valor para sinais ${level} sem valor próprio. \`null\` usa o do modelo (${
        [0.98, 0.9, 0.5][index]
      } sem modelo).`,
    }),
  ),
  {
    path: 'identity.maxWeight',
    kind: { type: 'number', min: 1, max: 100 },
    nullable: true,
    default: null,
    description:
      'O maior peso, em log-odds, que um único sinal pode somar a favor de um aparelho. `null` usa o do modelo (12 sem modelo).',
  },
  ...volatilityNumbers(
    'identity.disagreementFloor',
    'O pior peso que uma discordância pode ter',
    -50,
    0,
    [-6, -3, -1.5],
  ),
  {
    path: 'identity.scale',
    kind: { type: 'number', min: 0.001, max: 10 },
    nullable: true,
    default: null,
    description:
      'Escala provisória que transforma a soma de evidências em probabilidade. Só vale enquanto o modelo não está calibrado; um modelo ajustado usa a escala dele. `null` usa 0,75.',
  },
  {
    path: 'identity.offset',
    kind: { type: 'number', min: -50, max: 50 },
    nullable: true,
    default: null,
    description: 'Deslocamento provisório da mesma conversão. `null` usa 0.',
  },
  // --- Evidência de adulteração
  {
    path: 'tamper.enabled',
    kind: { type: 'boolean' },
    default: true,
    description: 'Liga a evidência de adulteração na resposta e a política `identity.learnFromTampered`.',
  },
  {
    path: 'tamper.disabledChecks',
    kind: { type: 'list', item: { type: 'enum', values: tamperCheckIds }, max: 50 },
    default: [],
    description:
      'Verificações desligadas. Desligue uma que acuse injustamente o seu público (por exemplo, uma extensão que seus usuários usam).',
  },
  {
    path: 'tamper.severity',
    kind: { type: 'map', keys: tamperCheckIds, value: severity },
    default: {},
    description:
      'Muda a severidade (`low`, `medium`, `high`) de uma verificação. Aqui você decide o que conta como grave.',
  },
  {
    path: 'tamper.clockSkewSeconds',
    kind: { type: 'integer', min: 5, max: 86_400 },
    default: 300,
    description:
      'Quanto o relógio do navegador pode diferir do servidor, em segundos, antes de virar a evidência `clock_skew`.',
  },
  // --- Risco
  {
    path: 'risk.enabled',
    kind: { type: 'boolean' },
    default: true,
    description:
      'Liga o risco composto na resposta do evento. É uma **heurística** (soma de pesos que você define), não uma probabilidade: nenhum peso foi calibrado com dados reais.',
  },
  {
    path: 'risk.ipTagWeights',
    kind: { type: 'map', value: { type: 'number', min: 0, max: 100 } },
    default: { datacenter: 25, tor_exit: 40, vpn: 20, proxy: 20 },
    description:
      'Peso de cada rótulo das listas de IP (`ipLists`). As chaves são os rótulos que você escolheu na configuração. Um rótulo que não está aqui não conta. Os pesos padrão são palpites.',
  },
  {
    path: 'risk.tamperWeights',
    kind: { type: 'map', keys: ['low', 'medium', 'high'], value: { type: 'number', min: 0, max: 100 } },
    default: { high: 40, medium: 15, low: 5 },
    description:
      'Peso de cada sinal de adulteração, pela severidade que ele tem para este tenant (veja `tamper.severity`). Cada sinal soma uma vez.',
  },
  {
    path: 'risk.timezoneMismatchWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 10,
    description:
      'Peso de o fuso horário do navegador não existir no país do IP. Precisa de `ipGeoFile` e `timezoneTable` na configuração. Viajantes e VPN disparam isto legitimamente, então o padrão é baixo.',
  },
  {
    path: 'risk.possibleLinkWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 15,
    description:
      'Peso de a visita parecer outro aparelho já conhecido sem ter chegado ao limiar de ligação (`identity.possibleLinkProbability`). Pode indicar quem troca de identificador de propósito.',
  },
  {
    path: 'risk.sameMachineWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 0,
    description:
      'Peso de a visita parecer a mesma máquina de outro aparelho em outro navegador (`identity.sameMachine`). O padrão é 0: usar dois navegadores é normal e não indica fraude. Aumente só se o seu caso trata isso como suspeito.',
  },
  {
    path: 'risk.multiAccountWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 20,
    description:
      'Peso de a pessoa (os aparelhos ligados a este) ter usado `risk.multiAccountThreshold` contas ou mais. É o sinal de várias contas da mesma pessoa. É um palpite até haver casos rotulados.',
  },
  {
    path: 'risk.multiAccountThreshold',
    kind: { type: 'integer', min: 2, max: 100 },
    default: 2,
    description:
      'Quantas contas distintas (`linkedId`) a pessoa precisa ter usado para somar `risk.multiAccountWeight`.',
  },
  {
    path: 'risk.fakeCrawlerWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 30,
    description:
      'Peso de o navegador dizer ser um robô de busca conhecido (Googlebot, Bingbot...) e o endereço NÃO ser de verdade dele. Só conta quando a verificação por DNS respondeu "não"; se o DNS não respondeu, não pesa. Veja `bots.verify`.',
  },
  {
    path: 'risk.environmentWeights',
    kind: { type: 'map', keys: [...environmentCheckIds], value: { type: 'number', min: 0, max: 100 } },
    default: {},
    description:
      'Peso de cada verificação de ambiente (`private_mode_likely`, `virtual_machine_gpu`, `software_renderer`). Vazio: nenhuma pesa. Janela privada é escolha legítima de privacidade e máquina virtual é uso comum de desenvolvedor e de empresa; só dê peso se, no seu fluxo, isso for raro entre pessoas de verdade.',
  },
  {
    path: 'risk.storedIdConflictWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 25,
    description:
      'Peso de a visita trazer o código guardado de um aparelho conhecido mas discordar dele no que não muda. Pode indicar um código copiado para outra máquina, ou um aparelho trocado que herdou o perfil do navegador.',
  },
  {
    path: 'risk.graphFlaggedWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 0,
    description:
      'Peso de o aparelho ter sido marcado como abusivo por pelo menos `sharedGraph.minTenants` outros tenants na janela. Só conta se o tenant participa do grafo. O padrão é 0 porque é um sinal novo e sem dados.',
  },
  {
    path: 'risk.newVisitorWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 0,
    description:
      'Peso de o aparelho ser novo. O padrão é 0 porque todo cliente novo é novo: só faz sentido em fluxos onde um aparelho desconhecido é raro (login de conta antiga).',
  },
  {
    path: 'risk.levels.medium',
    kind: { type: 'number', min: 0, max: 100 },
    default: 25,
    description: 'Pontuação a partir da qual o nível é `medium`. Abaixo disso é `low`.',
  },
  {
    path: 'risk.levels.high',
    kind: { type: 'number', min: 0, max: 100 },
    default: 60,
    description: 'Pontuação a partir da qual o nível é `high`. Tem de ser maior que `risk.levels.medium`.',
  },
  {
    path: 'risk.velocity.windowMinutes',
    kind: { type: 'integer', min: 1, max: 10_080 },
    default: 1440,
    description:
      'Janela, em minutos antes da visita, em que se contam visitas do mesmo aparelho ou do mesmo IP. O padrão é um dia.',
  },
  {
    path: 'risk.velocity.linkedIdsPerDevice.threshold',
    kind: { type: 'integer', min: 1, max: 1000 },
    default: 3,
    description:
      'Quantos `linkedId` (contas, normalmente) diferentes o mesmo aparelho pode ter na janela antes de contar como várias contas num aparelho só.',
  },
  {
    path: 'risk.velocity.linkedIdsPerDevice.weight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 25,
    description: 'Peso de o aparelho ter `linkedId` demais na janela. 0 desliga.',
  },
  {
    path: 'risk.velocity.devicesPerIp.threshold',
    kind: { type: 'integer', min: 1, max: 100_000 },
    default: 10,
    description:
      'Quantos aparelhos diferentes podem sair do mesmo IP na janela. Escritórios, escolas e operadoras de celular (CGNAT) têm muitos aparelhos num IP, então o padrão é alto.',
  },
  {
    path: 'risk.velocity.devicesPerIp.weight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 10,
    description: 'Peso de o IP ter aparelhos demais na janela. 0 desliga.',
  },
  {
    path: 'risk.velocity.ipsPerDevice.threshold',
    kind: { type: 'integer', min: 1, max: 100_000 },
    default: 6,
    description:
      'Quantos IPs diferentes o mesmo aparelho pode usar na janela. Quem anda entre redes (casa, trabalho, celular) usa alguns; muitos sugerem rotação de proxy.',
  },
  {
    path: 'risk.velocity.ipsPerDevice.weight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 10,
    description: 'Peso de o aparelho usar IPs demais na janela. 0 desliga.',
  },
  {
    path: 'risk.behavior.syntheticEventsThreshold',
    kind: { type: 'integer', min: 1, max: 10_000 },
    default: 1,
    description:
      'Quantos eventos de clique, tecla, rolagem ou toque criados por script (e não pelo navegador) contam como comportamento sintético. Só existe se a página liga o sinal `behavior` no coletor.',
  },
  {
    path: 'risk.behavior.syntheticEventsWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 20,
    description:
      'Peso de a página ter recebido eventos de interação criados por script. Alguns gerenciadores de senha e ferramentas de acessibilidade também geram cliques sintéticos, por isso o padrão não é alto.',
  },
  {
    path: 'risk.behavior.noInteractionMinObservedMs',
    kind: { type: 'integer', min: 100, max: 3_600_000 },
    default: 5000,
    description:
      'Só se fala em "nenhuma interação" se o coletor observou a página por pelo menos isto, em milissegundos. Se o observador começou junto com o envio, a visita é desconhecida, não suspeita.',
  },
  {
    path: 'risk.behavior.noInteractionWeight',
    kind: { type: 'number', min: 0, max: 100 },
    default: 5,
    description:
      'Peso de nenhuma interação real (movimento, clique, tecla, rolagem ou toque) em uma página observada pelo tempo mínimo. Leitores de tela e automação legítima também não geram, então é um peso pequeno.',
  },
  // --- Webhooks
  {
    path: 'webhooks.endpoints',
    kind: { type: 'json', validate: validateEndpoints },
    default: [],
    description:
      'Para onde avisar de cada visita. Cada item é `{ "id", "url", "secrets": [...], "minRiskScore", "decisions": [...] }`. `secrets` assina a chamada (use dois enquanto troca um); `minRiskScore` e `decisions` filtram quais visitas são enviadas. O destinatário confere a assinatura com `verifyWebhook` do SDK. Vazio, nada é enviado.',
  },
  {
    path: 'webhooks.maxAttempts',
    kind: { type: 'integer', min: 1, max: 30 },
    default: 8,
    description:
      'Quantas vezes tentar entregar antes de desistir. Falha de rede, tempo esgotado, 5xx, 408 e 429 tentam de novo; outro 4xx desiste na hora.',
  },
  {
    path: 'webhooks.baseDelaySeconds',
    kind: { type: 'integer', min: 1, max: 3600 },
    default: 30,
    description: 'Espera antes da segunda tentativa, em segundos. Dobra a cada tentativa até `maxDelaySeconds`.',
  },
  {
    path: 'webhooks.maxDelaySeconds',
    kind: { type: 'integer', min: 1, max: 86_400 },
    default: 3600,
    description: 'A maior espera entre duas tentativas, em segundos. Não pode ser menor que `baseDelaySeconds`.',
  },
  {
    path: 'webhooks.timeoutSeconds',
    kind: { type: 'integer', min: 1, max: 60 },
    default: 10,
    description: 'Quanto esperar a resposta do destinatário, em segundos, conexão incluída.',
  },
  {
    path: 'webhooks.maxPendingPerTenant',
    kind: { type: 'integer', min: 1, max: 1_000_000 },
    default: 10_000,
    description:
      'Quantas entregas podem esperar por tenant. Passando disso, as novas são descartadas (e registradas no log), para um destinatário parado não encher o banco.',
  },
  {
    path: 'webhooks.allowHttp',
    kind: { type: 'boolean' },
    default: false,
    description: 'Aceita endereços `http://`. Só para testes: o corpo da chamada vai sem criptografia.',
  },
  {
    path: 'webhooks.allowPrivateNetworks',
    kind: { type: 'boolean' },
    default: false,
    description:
      'Aceita destinatários em redes privadas, na própria máquina ou em faixas reservadas. Desligado por padrão: quem consegue definir uma URL não deve conseguir fazer o servidor chamar serviços internos.',
  },
  {
    path: 'webhooks.keepDoneHours',
    kind: { type: 'integer', min: 1, max: 8760 },
    default: 24,
    description: 'Por quantas horas guardar o registro de uma entrega bem-sucedida.',
  },
  {
    path: 'webhooks.keepFailedDays',
    kind: { type: 'integer', min: 1, max: 365 },
    default: 14,
    description: 'Por quantos dias guardar uma entrega que desistiu, para você ver e reenviar.',
  },
  // --- Regras de decisão
  {
    path: 'rules.list',
    kind: { type: 'json', validate: validateRules },
    default: [],
    description:
      'Regras que transformam o que o servidor sabe em uma decisão. Cada regra é `{ "id", "when", "decision", "reason" }`. A primeira que valer decide. `when` combina `all`, `any`, `not` e comparações `{ "field", "op", "value" }`. Os campos e operadores aceitos estão em `docs/regras.md`. Uma regra errada impede a partida. Vazia, o evento não traz `decision`.',
  },
  {
    path: 'rules.defaultDecision',
    kind: {
      type: 'json',
      validate: (value) =>
        typeof value === 'string' && decisionPattern.test(value)
          ? undefined
          : 'must be a lower-case word such as allow (letters, digits, "_")',
    },
    default: 'allow',
    description: 'Decisão quando há regras e nenhuma vale.',
  },
]

export const parametersByPath = new Map(parameters.map((parameter) => [parameter.path, parameter]))

/** Every prefix of every path: `identity` and `identity.defaultM` for `identity.defaultM.stable` */
export const parameterPrefixes: ReadonlySet<string> = new Set(
  parameters.flatMap((parameter) => {
    const parts = parameter.path.split('.')
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('.'))
  }),
)
