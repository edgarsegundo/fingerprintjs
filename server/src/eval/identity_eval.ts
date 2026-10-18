import { IdentityEngine } from '../identity/engine'
import { extractFeatures } from '../identity/features'
import { MemoryIdentityStore } from '../identity/memory_store'
import { defaultModel, Model } from '../identity/model'

import type { Dataset, EvalEvent } from './dataset'
import { legacyVisitorId } from './legacy'
import { seededRandom } from './stats'

/** Which visitor id a method gave to each visit, next to the truth */
export interface Assignment {
  requestId: string
  label: string
  visitorId: string
}

const byTime = (a: EvalEvent, b: EvalEvent) => a.receivedAt - b.receivedAt || (a.requestId < b.requestId ? -1 : 1)

/** What the original library does: the visitor id is the hash */
export function assignLegacy(dataset: Dataset): Assignment[] {
  return [...dataset.events].sort(byTime).map((event) => ({
    requestId: event.requestId,
    label: event.label,
    visitorId: legacyVisitorId(event),
  }))
}

/**
 * Runs the identity engine over the visits in the order they happened, as a server would: each visit is compared
 * only with what was known before it. Nothing from the future leaks into a decision.
 */
export function assignWithEngine(dataset: Dataset, model: Model = defaultModel()): Assignment[] {
  let counter = 0
  const engine = new IdentityEngine(new MemoryIdentityStore(), model, { newId: () => `v${++counter}` })
  return [...dataset.events].sort(byTime).map((event) => {
    const features = extractFeatures({ components: event.components, extended: event.extended, network: event.network })
    const resolution = engine.resolve('eval', event.requestId, features, event.receivedAt)
    return { requestId: event.requestId, label: event.label, visitorId: resolution.visitorId }
  })
}

export interface ClusterMetrics {
  events: number
  devices: number
  visitorIds: number
  /** Of the pairs of visits of one device, the share that got the same visitor id. Higher is more stable. */
  pairRecall: number
  /** Of the pairs given the same visitor id, the share that really are one device */
  pairPrecision: number
  /** Of the pairs of visits of different devices, the share that got the same visitor id: collisions */
  mergeRate: number
}

const pairs = (n: number) => (n * (n - 1)) / 2

/**
 * Pair counting over the clusters, exact and fast: no sampling and no pair list.
 * `recall` is 1 minus the rate at which the same device became another.
 * `mergeRate` is the rate at which two devices became one.
 */
export function clusterMetrics(assignments: readonly Assignment[]): ClusterMetrics {
  const perLabel = new Map<string, number>()
  const perCluster = new Map<string, number>()
  const perBoth = new Map<string, number>()
  for (const { label, visitorId } of assignments) {
    perLabel.set(label, (perLabel.get(label) ?? 0) + 1)
    perCluster.set(visitorId, (perCluster.get(visitorId) ?? 0) + 1)
    const key = `${label}\u0000${visitorId}`
    perBoth.set(key, (perBoth.get(key) ?? 0) + 1)
  }
  const sum = (counts: Iterable<number>) => [...counts].reduce((total, n) => total + pairs(n), 0)
  const truePairs = sum(perLabel.values())
  const predictedPairs = sum(perCluster.values())
  const correctPairs = sum(perBoth.values())
  const differentDevicePairs = pairs(assignments.length) - truePairs
  return {
    events: assignments.length,
    devices: perLabel.size,
    visitorIds: perCluster.size,
    pairRecall: truePairs === 0 ? NaN : correctPairs / truePairs,
    pairPrecision: predictedPairs === 0 ? NaN : correctPairs / predictedPairs,
    mergeRate: differentDevicePairs === 0 ? NaN : (predictedPairs - correctPairs) / differentDevicePairs,
  }
}

export interface Spread {
  low: number
  high: number
}

/**
 * How much a metric moves when a fifth of the devices is left out, over many random choices of which fifth.
 * It is a measure of how much the result depends on which devices happened to be in the data. It is not a confidence
 * interval, and it says nothing about devices that are not in the data at all.
 */
export function spreadOverDevices(
  assignments: readonly Assignment[],
  metric: (metrics: ClusterMetrics) => number,
  options: { seed?: number; runs?: number; keep?: number } = {},
): Spread {
  const { seed = 1, runs = 200, keep = 0.8 } = options
  const random = seededRandom(seed)
  const labels = [...new Set(assignments.map((assignment) => assignment.label))].sort()
  if (labels.length < 5) {
    return { low: NaN, high: NaN }
  }
  const values: number[] = []
  for (let run = 0; run < runs; run++) {
    const chosen = new Set<string>()
    const pool = [...labels]
    const wanted = Math.max(2, Math.round(labels.length * keep))
    while (chosen.size < wanted) {
      chosen.add(pool.splice(Math.floor(random() * pool.length), 1)[0])
    }
    const value = metric(clusterMetrics(assignments.filter((assignment) => chosen.has(assignment.label))))
    if (!Number.isNaN(value)) {
      values.push(value)
    }
  }
  values.sort((a, b) => a - b)
  if (values.length === 0) {
    return { low: NaN, high: NaN }
  }
  const at = (quantile: number) => values[Math.min(values.length - 1, Math.floor(quantile * values.length))]
  return { low: at(0.025), high: at(0.975) }
}

export interface MethodResult {
  name: string
  description: string
  metrics: ClusterMetrics
  recallSpread: Spread
  mergeSpread: Spread
}

export interface IdentityReport {
  source: Dataset['meta']['source']
  methods: MethodResult[]
  warnings: string[]
  /** True if the model was fitted on this very dataset, which makes its results optimistic */
  inSample: boolean
}

export function evaluateIdentity(
  dataset: Dataset,
  options: { model?: Model; datasetId?: string; seed?: number; legacy?: boolean } = {},
): IdentityReport {
  const model = options.model ?? defaultModel()
  const methods: MethodResult[] = []
  const add = (name: string, description: string, assignments: Assignment[]) =>
    methods.push({
      name,
      description,
      metrics: clusterMetrics(assignments),
      recallSpread: spreadOverDevices(assignments, (m) => m.pairRecall, { seed: options.seed }),
      mergeSpread: spreadOverDevices(assignments, (m) => m.mergeRate, { seed: options.seed }),
    })

  if (options.legacy !== false) {
    add('legacy-hash', 'The visitor id of the original library: the hash of the signals.', assignLegacy(dataset))
  }
  add(
    'identity-engine',
    model.calibrated
      ? 'The matching engine, with parameters fitted on labelled data.'
      : 'The matching engine with its PROVISIONAL parameters (not fitted on data).',
    assignWithEngine(dataset, model),
  )

  const devices = methods[0].metrics.devices
  const warnings: string[] = []
  if (dataset.meta.source === 'synthetic') {
    warnings.push('DADOS SINTÉTICOS: validam o funcionamento do código, e nada dizem sobre a precisão no mundo real.')
  }
  if (devices < 30) {
    warnings.push(`Só ${devices} aparelhos: a variação entre subamostras não é confiável com tão poucos.`)
  }
  if (!model.calibrated) {
    warnings.push(
      'O modelo usa parâmetros provisórios. Rode `fit-model` com dados rotulados antes de tirar conclusões.',
    )
  }
  const inSample = Boolean(options.datasetId && model.fittedFrom?.datasetId === options.datasetId)
  if (inSample) {
    warnings.push(
      'O modelo foi ajustado nestes mesmos dados: o resultado é otimista. ' +
        'Avalie em dados que não foram usados no ajuste.',
    )
  }
  return { source: dataset.meta.source, methods, warnings, inSample }
}

const pct = (value: number) => (Number.isNaN(value) ? 'n/d' : `${(value * 100).toFixed(2).replace('.', ',')}%`)
const spread = (value: number, s: Spread) =>
  Number.isNaN(s.low) ? pct(value) : `${pct(value)} (variação ${pct(s.low)} a ${pct(s.high)})`

export function renderIdentityReport(report: IdentityReport): string {
  const lines = ['# Relatório de identificação (avaliação online)', '']
  if (report.source === 'synthetic') {
    lines.push('> **DADOS SINTÉTICOS.** Valida o código, não diz nada sobre precisão real.', '')
  }
  lines.push(
    'As visitas são processadas na ordem em que aconteceram e cada uma só vê o que veio antes, como num servidor.',
    '',
    '## Avisos',
    '',
    ...report.warnings.map((warning) => `- ${warning}`),
    '',
    '## Resultado',
    '',
    '| Método | Aparelhos reais | Ids de visitante criados | Aparelho mantido junto (estabilidade) | ' +
      'Aparelhos misturados (colisão) |',
    '|---|---|---|---|---|',
    ...report.methods.map(
      (method) =>
        `| ${method.name} | ${method.metrics.devices} | ${method.metrics.visitorIds} | ` +
        `${spread(method.metrics.pairRecall, method.recallSpread)} | ${spread(
          method.metrics.mergeRate,
          method.mergeSpread,
        )} |`,
    ),
    '',
    '**Como ler:** "estabilidade" é, entre os pares de visitas do mesmo aparelho, a parte que recebeu o mesmo id ' +
      '(quanto maior, melhor). "Colisão" é, entre os pares de visitas de aparelhos diferentes, a parte que recebeu o ' +
      'mesmo id (quanto menor, melhor). A "variação" mostra o quanto o número muda ao deixar de fora um quinto dos ' +
      'aparelhos; **não é um intervalo de confiança**.',
    '',
    ...report.methods.map((method) => `- **${method.name}**: ${method.description}`),
    '',
  )
  return `${lines.join('\n')}\n`
}
