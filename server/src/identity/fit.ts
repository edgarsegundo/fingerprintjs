import { createHash } from 'node:crypto'

import type { Dataset, EvalEvent } from '../eval/dataset'
import { seededRandom } from '../eval/stats'

import { extractFeatures, Features, featureNames } from './features'
import { MemoryIdentityStore } from './memory_store'
import { defaultModel, Model, probabilityOf } from './model'
import { SyncIdentityEngine } from './sync_engine'

/** Identifies a dataset by its visits, so that a model can tell later whether it is judged on its own training data */
export function datasetId(dataset: Dataset): string {
  const ids = dataset.events.map((event) => event.requestId).sort()
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
}

const byTime = (a: EvalEvent, b: EvalEvent) => a.receivedAt - b.receivedAt || (a.requestId < b.requestId ? -1 : 1)

const featuresOf = (event: EvalEvent): Features =>
  extractFeatures({
    components: event.components,
    extended: event.extended,
    network: { ...event.network, userAgent: event.userAgent },
  })

export interface FeatureEstimate {
  /** Comparisons where the visit and the device history both had the feature */
  n: number
  /** Of those, how many times the value was one the device had had before */
  kept: number
}

/** The lowest and highest chance that a device keeps a value that the estimate can report */
const mBounds: [number, number] = [0.02, 0.995]

/**
 * For each feature: how often does a device show again a value it already had?
 * Visits of one device are taken in time order and each is compared with the earlier ones, which is exactly the
 * question the matcher asks. The result is smoothed (one made-up success and one made-up failure) and kept inside
 * bounds, so that a feature seen to stay put 40 times in 40 is not called perfect.
 */
export function estimateM(
  events: readonly EvalEvent[],
  minComparisons = 20,
): { m: Record<string, number>; estimates: Record<string, FeatureEstimate> } {
  const estimates: Record<string, FeatureEstimate> = {}
  const perLabel = new Map<string, EvalEvent[]>()
  for (const event of events) {
    perLabel.set(event.label, [...(perLabel.get(event.label) ?? []), event])
  }
  for (const visits of perLabel.values()) {
    const seen = new Map<string, Set<string>>()
    for (const event of [...visits].sort(byTime)) {
      const features = featuresOf(event)
      for (const [feature, value] of Object.entries(features)) {
        const before = seen.get(feature)
        if (before && before.size > 0) {
          const estimate = (estimates[feature] ??= { n: 0, kept: 0 })
          estimate.n++
          if (before.has(value)) {
            estimate.kept++
          }
        }
        if (!before) {
          seen.set(feature, new Set([value]))
        } else {
          before.add(value)
        }
      }
    }
  }
  const m: Record<string, number> = {}
  for (const feature of featureNames) {
    const estimate = estimates[feature]
    if (estimate && estimate.n >= minComparisons) {
      m[feature] = Math.min(mBounds[1], Math.max(mBounds[0], (estimate.kept + 1) / (estimate.n + 2)))
    }
  }
  return { m, estimates }
}

export interface PlattFit {
  a: number
  b: number
  examples: number
  correct: number
  /** True if Newton's method converged */
  converged: boolean
}

/** log(1 + exp(t)) without overflow */
const softplus = (t: number) => (t > 30 ? t : t < -30 ? Math.exp(t) : Math.log1p(Math.exp(t)))

/**
 * One-dimensional logistic regression: p = 1 / (1 + exp(-(a x + b))).
 *
 * The evidence ranges over tens of units, which makes a plain Newton step overshoot and diverge. So the axis is
 * standardized first, each step is shortened until the loss goes down, and a small ridge keeps the scale finite when
 * the two classes are perfectly separated.
 */
export function fitPlatt(examples: ReadonlyArray<{ x: number; positive: boolean }>, ridge = 0.01): PlattFit {
  const n = examples.length
  const correct = examples.filter((example) => example.positive).length
  if (n === 0) {
    return { a: 1, b: 0, examples: 0, correct: 0, converged: false }
  }
  const mean = examples.reduce((sum, example) => sum + example.x, 0) / n
  const sd = Math.sqrt(examples.reduce((sum, example) => sum + (example.x - mean) ** 2, 0) / n) || 1
  const z = examples.map((example) => ({ z: (example.x - mean) / sd, y: example.positive ? 1 : 0 }))

  const loss = (a: number, b: number) =>
    z.reduce((sum, { z: value, y }) => sum + softplus(a * value + b) - y * (a * value + b), 0) + (ridge * a * a) / 2

  const rate = Math.min(0.999, Math.max(0.001, correct / n))
  let a = 0
  let b = Math.log(rate / (1 - rate))
  let converged = false
  for (let iteration = 0; iteration < 200; iteration++) {
    let gradA = ridge * a
    let gradB = 0
    let hAA = ridge
    let hAB = 0
    let hBB = 1e-9
    for (const { z: value, y } of z) {
      const p = 1 / (1 + Math.exp(-(a * value + b)))
      gradA += (p - y) * value
      gradB += p - y
      const weight = p * (1 - p)
      hAA += weight * value * value
      hAB += weight * value
      hBB += weight
    }
    const determinant = hAA * hBB - hAB * hAB
    if (!(Math.abs(determinant) > 1e-15)) {
      break
    }
    let stepA = (hBB * gradA - hAB * gradB) / determinant
    let stepB = (hAA * gradB - hAB * gradA) / determinant
    const before = loss(a, b)
    let shortened = 0
    while (loss(a - stepA, b - stepB) > before && shortened < 40) {
      stepA /= 2
      stepB /= 2
      shortened++
    }
    a -= stepA
    b -= stepB
    if (Math.abs(stepA) < 1e-9 && Math.abs(stepB) < 1e-9) {
      converged = true
      break
    }
  }
  // Back to the original axis: a z + b = (a / sd) x + (b - a mean / sd)
  return { a: a / sd, b: b - (a * mean) / sd, examples: n, correct, converged }
}

/** The average gap between what was predicted and what happened, over bins of the predicted probability */
export function expectedCalibrationError(
  examples: ReadonlyArray<{ probability: number; positive: boolean }>,
  bins = 10,
): number {
  if (examples.length === 0) {
    return NaN
  }
  let error = 0
  for (let bin = 0; bin < bins; bin++) {
    const inBin = examples.filter((example) => Math.min(bins - 1, Math.floor(example.probability * bins)) === bin)
    if (inBin.length > 0) {
      const predicted = inBin.reduce((sum, example) => sum + example.probability, 0) / inBin.length
      const actual = inBin.filter((example) => example.positive).length / inBin.length
      error += (inBin.length / examples.length) * Math.abs(predicted - actual)
    }
  }
  return error
}

/**
 * Runs the engine over a set of devices in time order and records, for each visit that had a candidate,
 * the evidence for the best candidate and whether that candidate really was the same device.
 */
export function collectCalibrationExamples(
  events: readonly EvalEvent[],
  model: Model,
): Array<{ x: number; positive: boolean }> {
  let counter = 0
  const engine = new SyncIdentityEngine(new MemoryIdentityStore(), model, { newId: () => `v${++counter}` })
  const labelOfDevice = new Map<string, string>()
  const examples: Array<{ x: number; positive: boolean }> = []

  for (const event of [...events].sort(byTime)) {
    const resolution = engine.resolve('fit', event.requestId, featuresOf(event), event.receivedAt)
    if (resolution.logOdds !== null) {
      // The best candidate is the device that the visit was matched to, or the closest one that was refused. For a
      // refused one there is no id to look up, so the truth is "no device of this label was among the candidates".
      const candidateLabel = resolution.matched ? labelOfDevice.get(resolution.visitorId) : undefined
      examples.push({ x: resolution.logOdds, positive: resolution.matched && candidateLabel === event.label })
    }
    if (!labelOfDevice.has(resolution.visitorId)) {
      labelOfDevice.set(resolution.visitorId, event.label)
    }
  }
  return examples
}

export interface FitResult {
  model: Model
  /** What was learned and from how much, for the person who reads it */
  summary: {
    devices: number
    visits: number
    devicesForM: number
    devicesForCalibration: number
    featuresFitted: number
    featuresTotal: number
    calibration: { examples: number; correct: number; eceBefore: number; eceAfter: number } | null
  }
  warnings: string[]
}

/**
 * Fits the parameters of the model on a labelled dataset.
 * The devices are split in two groups: the chances of keeping a value are estimated on one, and the probability
 * scale is calibrated on the other, so that the calibration is not judged on the data that produced the estimates.
 */
export function fitModel(
  dataset: Dataset,
  options: { seed?: number; calibrationShare?: number; base?: Model; now?: number } = {},
): FitResult {
  const { seed = 1, calibrationShare = 0.4, now = Date.now() } = options
  const base = options.base ?? defaultModel()
  const random = seededRandom(seed)
  const labels = [...new Set(dataset.events.map((event) => event.label))].sort()
  const pool = [...labels]
  const calibrationLabels = new Set<string>()
  const wanted = Math.round(labels.length * calibrationShare)
  while (calibrationLabels.size < wanted) {
    calibrationLabels.add(pool.splice(Math.floor(random() * pool.length), 1)[0])
  }
  const forM = dataset.events.filter((event) => !calibrationLabels.has(event.label))
  const forCalibration = dataset.events.filter((event) => calibrationLabels.has(event.label))

  const { m } = estimateM(forM)
  const warnings: string[] = []
  const withM: Model = { ...base, m: { ...base.m, ...m }, platt: { a: 1, b: 0 }, calibrated: false }

  const examples = collectCalibrationExamples(forCalibration, withM)
  const positives = examples.filter((example) => example.positive).length
  let calibration: FitResult['summary']['calibration'] = null
  let platt = base.platt
  let plattFitted = false

  if (examples.length >= 100 && positives >= 20 && examples.length - positives >= 20) {
    const fit = fitPlatt(examples)
    if (fit.converged && fit.a > 0) {
      platt = { a: fit.a, b: fit.b }
      plattFitted = true
      const eceBefore = expectedCalibrationError(
        examples.map((example) => ({
          probability: probabilityOf({ ...withM, platt: base.platt }, example.x),
          positive: example.positive,
        })),
      )
      const eceAfter = expectedCalibrationError(
        examples.map((example) => ({
          probability: probabilityOf({ ...withM, platt }, example.x),
          positive: example.positive,
        })),
      )
      calibration = { examples: examples.length, correct: positives, eceBefore, eceAfter }
      warnings.push(
        'A calibração foi medida nos mesmos dados em que foi ajustada: o erro "depois" é otimista. ' +
          'Confirme em dados novos.',
      )
    } else {
      warnings.push('A calibração não convergiu. A escala provisória foi mantida.')
    }
  } else {
    warnings.push(
      `Dados insuficientes para calibrar a escala (${examples.length} decisões, ${positives} corretas; ` +
        'são precisos pelo menos 100 e 20 de cada tipo). A escala provisória foi mantida.',
    )
  }

  const featuresFitted = Object.keys(m).length
  if (featuresFitted === 0) {
    warnings.push(
      'Nenhum sinal teve comparações suficientes para estimar a chance de manter o valor. ' +
        'Os valores provisórios foram mantidos.',
    )
  }
  const calibrated = plattFitted && featuresFitted > 0
  if (!calibrated) {
    warnings.push('O modelo continua marcado como NÃO calibrado.')
  }

  return {
    model: {
      ...base,
      m: withM.m,
      platt,
      calibrated,
      fittedFrom: calibrated
        ? { devices: labels.length, visits: dataset.events.length, datasetId: datasetId(dataset), fittedAt: now }
        : undefined,
    },
    summary: {
      devices: labels.length,
      visits: dataset.events.length,
      devicesForM: labels.length - calibrationLabels.size,
      devicesForCalibration: calibrationLabels.size,
      featuresFitted,
      featuresTotal: featureNames.length,
      calibration,
    },
    warnings,
  }
}
