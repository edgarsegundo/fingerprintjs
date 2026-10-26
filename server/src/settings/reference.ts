import { FactName, factTypes, operators } from '../risk/rules'

import type { Kind } from './kinds'
import { Parameter, parameters } from './parameters'

/** The allowed values of a parameter, in words */
export function describeKind(kind: Kind): string {
  switch (kind.type) {
    case 'boolean':
      return 'true ou false'
    case 'integer':
      return `inteiro de ${kind.min} a ${kind.max}`
    case 'number':
      return kind.exclusive
        ? `número entre ${kind.min} e ${kind.max}, sem os extremos`
        : `número de ${kind.min} a ${kind.max}`
    case 'string':
      return 'texto'
    case 'enum':
      return kind.values.map((value) => `\`${value}\``).join(', ')
    case 'list':
      return `lista de: ${describeKind(kind.item)}`
    case 'map':
      return `objeto (${kind.keys ? 'chaves conhecidas' : 'chaves livres'}) com valores: ${describeKind(kind.value)}`
    case 'json':
      return 'estrutura própria, veja a descrição'
  }
}

const show = (value: unknown): string => (value === null ? '`null`' : `\`${JSON.stringify(value)}\``)

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export const sectionTitles: Record<string, string> = {
  nonce: 'Desafio (nonce)',
  limits: 'Limites',
  api: 'API de consulta',
  collection: 'Coleta guiada pelo servidor',
  drift: 'Deriva',
  privacy: 'Privacidade',
  audit: 'Auditoria de acessos',
  sharedGraph: 'Grafo compartilhado (desligado)',
  quota: 'Cotas',
  retention: 'Retenção',
  identity: 'Identificação de visitante',
  tamper: 'Evidência de adulteração',
  risk: 'Risco composto',
  rules: 'Regras de decisão',
  webhooks: 'Webhooks',
}

/**
 * The reference of every setting, written from the table of parameters. The document `docs/configuracao.md` is this
 * text, and a test fails if the file is out of date, so the reference cannot drift from the code.
 */
export function renderReference(): string {
  const sections = new Map<string, Parameter[]>()
  for (const parameter of parameters) {
    const section = parameter.path.split('.')[0]
    sections.set(section, [...(sections.get(section) ?? []), parameter])
  }

  const lines = [
    '# Referência de configuração',
    '',
    '> Este arquivo é **gerado** pelo comando `node server/dist/cli.js config-reference --out docs/configuracao.md`.',
    '> Não edite à mão: um teste falha se ele ficar diferente da tabela de parâmetros do código.',
    '',
    'Todo parâmetro abaixo pode ser definido para todos os tenants em `defaults`',
    'e sobreposto para um tenant em `settings`:',
    '',
    '```json',
    '{',
    '  "defaults": { "identity": { "matchProbability": 0.97 }, "retention": { "eventsDays": 60 } },',
    '  "tenants": [',
    '    { "id": "loja", "publicKey": "pk_...", "secretKeySha256": ["..."],',
    '      "settings": { "limits": { "collectPerMinutePerIp": 120 },',
    '                    "tamper": { "disabledChecks": ["clock_skew"] } } }',
    '  ]',
    '}',
    '```',
    '',
    'Camadas, da mais baixa para a mais alta: os valores do código, os campos antigos de nível superior do arquivo',
    '(`nonceTtlSeconds`, `rateLimit` e outros, mantidos por compatibilidade), `defaults` e `settings` do tenant.',
    'Um nome desconhecido faz o servidor **recusar a partida** e sugere o nome mais próximo. Um parâmetro com `null`',
    'como padrão usa o valor do modelo (ou desliga o recurso), conforme a descrição.',
    '',
    'Um parâmetro que é um objeto de chaves livres (como `risk.ipTagWeights` ou `identity.featureM`) é **substituído',
    'por inteiro**, não mesclado: se você pôr só `{ "datacenter": 80 }`, os outros rótulos deixam de contar.',
    'Já os grupos (como `risk.velocity`) se mesclam parâmetro a parâmetro.',
    '',
    'Para mudar sem reiniciar: edite o arquivo e envie `SIGHUP` ao processo.',
    'Endereço, TLS, proxies confiáveis e banco só são lidos na partida.',
    '',
  ]

  for (const [section, items] of sections) {
    lines.push(
      `## ${sectionTitles[section] ?? section}`,
      '',
      '| Parâmetro | Valores | Padrão | O que faz |',
      '|---|---|---|---|',
    )
    for (const parameter of items) {
      const values = escapeCell(describeKind(parameter.kind)) + (parameter.nullable ? ' ou `null`' : '')
      lines.push(
        `| \`${parameter.path}\` | ${values} | ${show(parameter.default)} | ${escapeCell(parameter.description)} |`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/* eslint-disable max-len -- prose that is copied as it is into the reference document */
const factDescriptions = {
  'risk.score': 'Pontuação do risco composto, de 0 a 100. Ausente se `risk.enabled` for falso.',
  'risk.level': 'Nível do risco: `low`, `medium` ou `high`.',
  'risk.factors': 'Ids dos fatores que somaram pontos, como `ip_tag:datacenter` ou `tamper:clock_skew`.',
  'identity.visitorId': 'Identificador do visitante. Ausente com `identity.enabled` falso.',
  'identity.matched': 'O aparelho já era conhecido.',
  'identity.new': 'O aparelho é novo (o oposto de `identity.matched`).',
  'identity.ambiguous': 'Outro aparelho conhecido era quase tão provável quanto o escolhido.',
  'identity.possibleLink': 'A visita lembra um aparelho conhecido sem ter chegado ao limiar de ligação.',
  'identity.learned': 'A visita pôde ensinar o motor (veja `identity.learnFromTampered`).',
  'identity.probability':
    'Probabilidade da ligação. **Só existe com modelo calibrado**; antes disso o campo está ausente, de propósito.',
  'tamper.high': 'Quantos sinais de adulteração de severidade alta.',
  'tamper.medium': 'Quantos de severidade média.',
  'tamper.low': 'Quantos de severidade baixa.',
  'tamper.signals': 'Ids dos sinais de adulteração encontrados. Ausente com `tamper.enabled` falso.',
  'identity.storedIdConflict':
    'Verdadeiro se a visita trouxe o código guardado de um aparelho conhecido mas discorda dele no que não muda (placa de vídeo, tela): sinal de que o código foi copiado para outra máquina.',
  'environment.signals':
    'Lista das verificações de ambiente que acharam algo (`private_mode_likely`, `virtual_machine_gpu`, `software_renderer`). Ausente se `environment.enabled` for falso.',
  'ip.tags': 'Rótulos das listas de IP em que o endereço está (`ipLists`). Lista vazia se em nenhuma.',
  'crawler.claimed':
    'O robô de busca que o User-Agent diz ser (`googlebot`, `bingbot`, `applebot`, `yandexbot`, `baiduspider`). Ausente se não diz ser nenhum ou se `bots.verify` está desligado.',
  'crawler.verified':
    'Verdadeiro se o endereço é mesmo desse robô (conferido por DNS), falso se não é. Ausente se não deu para conferir: use junto com `crawler.claimed` e lembre que ausente torna qualquer comparação falsa.',
  'ip.country': 'País do endereço, se houver `ipGeoFile` e o endereço estiver nele.',
  'ip.version': '4 ou 6.',
  'velocity.linkedIdsPerDevice': '`linkedId` diferentes do mesmo aparelho na janela (`risk.velocity.windowMinutes`).',
  'velocity.devicesPerIp': 'Aparelhos diferentes vindos do mesmo IP na janela.',
  'velocity.ipsPerDevice': 'IPs diferentes usados pelo mesmo aparelho na janela.',
  'behavior.observedMs':
    'Por quanto tempo o coletor observou a página, em ms. Só existe se a página liga o sinal `behavior`.',
  'behavior.interactions': 'Movimentos, cliques, teclas, rolagens e toques reais contados. Só com o sinal `behavior`.',
  'behavior.syntheticEvents': 'Eventos de interação criados por script. Só com o sinal `behavior`.',
  'graph.tenants':
    'Em quantos outros tenants o aparelho foi visto na janela. Só existe se o tenant participa do grafo e há tenants o bastante (k-anonimato).',
  'graph.flaggedTenants': 'Quantos outros tenants o marcaram como abusivo na janela. Mesmas condições.',
  'event.linkedId': 'O `linkedId` que a página do cliente enviou, se enviou.',
  'event.viaProxy': 'A conexão chegou por um proxy confiável.',
} as const satisfies Record<FactName, string>

const operatorDescriptions: Record<typeof operators[number], string> = {
  eq: 'igual a (número, texto ou booleano)',
  ne: 'diferente de',
  gt: 'maior que (número)',
  gte: 'maior ou igual a (número)',
  lt: 'menor que (número)',
  lte: 'menor ou igual a (número)',
  in: '`value` é uma lista e o fato é um dos itens (número ou texto)',
  contains: 'texto: o fato contém `value`. Lista: o fato tem `value` como item',
  containsAny: 'lista: o fato tem pelo menos um dos itens de `value`',
  exists: '`value` é `true` ou `false`: o fato é (ou não é) conhecido',
}

/** The reference of the rules, written from the facts and operators in the code, like the one of the settings */
export function renderRulesReference(): string {
  const lines = [
    '# Regras de decisão',
    '',
    '> Este arquivo é **gerado** pelo comando `node server/dist/cli.js rules-reference --out docs/regras.md`.',
    '> Não edite à mão: um teste falha se ele ficar diferente do código.',
    '',
    'As regras ficam em `rules.list` (para todos os tenants em `defaults`, ou em `settings` de um tenant) e transformam o',
    'que o servidor sabe sobre uma visita em uma **decisão**, devolvida em `decision` na leitura do evento.',
    'Uma regra é dado, não código: não há `eval`, expressão regular nem laço. Um erro numa regra impede a partida.',
    '',
    '```json',
    '{ "rules": {',
    '    "defaultDecision": "allow",',
    '    "list": [',
    '      { "id": "tor", "decision": "block", "reason": "Saída da rede Tor",',
    '        "when": { "field": "ip.tags", "op": "contains", "value": "tor_exit" } },',
    '      { "id": "varias-contas", "decision": "review",',
    '        "when": { "all": [',
    '          { "field": "velocity.linkedIdsPerDevice", "op": "gte", "value": 3 },',
    '          { "field": "tamper.high", "op": "eq", "value": 0 } ] } }',
    '    ] } }',
    '```',
    '',
    '- A **primeira** regra que valer decide. `decision` na resposta traz também `matchedRules`, com todas que valeram.',
    '- Sem nenhuma regra que valha, vale `rules.defaultDecision`. Sem regras na lista, `decision` é `null`.',
    '- `decision` é uma palavra em minúsculas à sua escolha (`allow`, `review`, `challenge`, `block`...). O servidor não',
    '  age sobre ela: quem lê o evento decide o que fazer.',
    '- Um fato **desconhecido** (por exemplo `identity.*` com o motor desligado) torna falsa qualquer comparação com ele.',
    '  Use `exists` para testar se ele é conhecido.',
    '- Combinadores: `{ "all": [...] }`, `{ "any": [...] }` e `{ "not": ... }`. No máximo 100 regras, 40 condições por',
    '  regra e 6 níveis de aninhamento.',
    '',
    '## Fatos',
    '',
    '| Fato | Tipo | O que é |',
    '|---|---|---|',
    ...(Object.keys(factTypes) as FactName[]).map(
      (name) => `| \`${name}\` | ${factTypes[name]} | ${escapeCell(factDescriptions[name])} |`,
    ),
    '',
    '## Operadores',
    '',
    '| Operador | Significado |',
    '|---|---|',
    ...operators.map((op) => `| \`${op}\` | ${escapeCell(operatorDescriptions[op])} |`),
    '',
  ]
  return `${lines.join('\n')}\n`
}
/* eslint-enable max-len */
