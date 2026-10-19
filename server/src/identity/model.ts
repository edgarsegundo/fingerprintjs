import { isIdentifier, Volatility, volatilityOf } from './features'

/**
 * The scoring model is a Fellegi-Sunter model from record linkage: each feature that both the visit and a known device
 * have adds evidence for or against "same device".
 *
 * - Agreeing on a value adds ln(m / u): `m` is the chance that the same device keeps a value it had before, `u` the
 *   chance that a random other device has that value. A rare value is strong evidence and a common one is weak.
 *   `u` is measured on the devices already known, so it needs no labels.
 * - Disagreeing adds ln((1 - m) / (1 - u)), which is negative, but floored so that one changed signal cannot veto a
 *   match: browsers update, and the matcher has to survive that.
 * - A feature that is missing on either side adds nothing.
 * - The prior is 1 in the number of known devices, so the same evidence is worth less in a bigger population.
 *
 * `m` is learned from labelled data (`fit-model`). Until then the defaults below are guesses and the model says so.
 */
export interface Model {
  version: 1
  /** Per feature: the chance that a device keeps a value. Missing features use `defaultM`. */
  m: Record<string, number>
  defaultM: Record<Volatility, number>
  /** Per feature: overrides how volatile the feature is, which decides how much a disagreement weighs */
  volatility?: Record<string, Volatility>
  /** The most that one feature can add in favour of a device, in log-odds */
  maxWeight: number
  /** The most that a disagreement can weigh against a device, by volatility. Keeps one change from vetoing a match. */
  disagreementFloor: Record<Volatility, number>
  /** A visit is attached to a known device when its probability reaches this */
  matchProbability: number
  /** Turns the sum of evidence (log-odds) into a probability. Fitted on labelled data; a cautious guess before that. */
  platt: { a: number; b: number }
  /** True only if `m` and `platt` were fitted on labelled data */
  calibrated: boolean
  fittedFrom?: { devices: number; visits: number; datasetId: string; fittedAt: number }
}

export function defaultModel(): Model {
  return {
    version: 1,
    m: {},
    defaultM: { stable: 0.98, semi: 0.9, volatile: 0.5 },
    maxWeight: 12,
    disagreementFloor: { stable: -6, semi: -3, volatile: -1.5 },
    matchProbability: 0.99,
    // Scaling by less than one because the features are not independent (the GPU, the canvas and the WebGL extensions
    // all follow from the hardware), so the sum of evidence overstates how sure we are. The number is a placeholder:
    // it was picked so that an identical visit is recognized even when very few devices are known. Only `fit-model`
    // on labelled data can say what it really should be.
    platt: { a: 0.75, b: 0 },
    calibrated: false,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a model file. It fails loudly: a model with a wrong number silently changes who is who. */
export function parseModel(input: unknown): Model {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error('Model: the file must be a model of version 1')
  }
  const base = defaultModel()
  const probability = (value: unknown, name: string) => {
    if (typeof value !== 'number' || !(value > 0 && value < 1)) {
      throw new Error(`Model: ${name} must be a number between 0 and 1 (exclusive)`)
    }
    return value
  }
  const m: Record<string, number> = {}
  if (input.m !== undefined) {
    if (!isRecord(input.m)) {
      throw new Error('Model: m must be an object')
    }
    for (const [feature, value] of Object.entries(input.m)) {
      m[feature] = probability(value, `m.${feature}`)
    }
  }
  const defaultM = { ...base.defaultM }
  if (input.defaultM !== undefined) {
    if (!isRecord(input.defaultM)) {
      throw new Error('Model: defaultM must be an object')
    }
    for (const key of ['stable', 'semi', 'volatile'] as const) {
      if (input.defaultM[key] !== undefined) {
        defaultM[key] = probability(input.defaultM[key], `defaultM.${key}`)
      }
    }
  }
  const volatility: Record<string, Volatility> = {}
  if (input.volatility !== undefined) {
    if (!isRecord(input.volatility)) {
      throw new Error('Model: volatility must be an object')
    }
    for (const [feature, level] of Object.entries(input.volatility)) {
      if (level !== 'stable' && level !== 'semi' && level !== 'volatile') {
        throw new Error(`Model: volatility.${feature} must be stable, semi or volatile`)
      }
      volatility[feature] = level
    }
  }
  const maxWeight = input.maxWeight === undefined ? base.maxWeight : input.maxWeight
  if (typeof maxWeight !== 'number' || !(maxWeight >= 1 && maxWeight <= 100)) {
    throw new Error('Model: maxWeight must be a number from 1 to 100')
  }
  const disagreementFloor = { ...base.disagreementFloor }
  if (input.disagreementFloor !== undefined) {
    if (!isRecord(input.disagreementFloor)) {
      throw new Error('Model: disagreementFloor must be an object')
    }
    for (const key of ['stable', 'semi', 'volatile'] as const) {
      const value = input.disagreementFloor[key]
      if (value !== undefined) {
        if (typeof value !== 'number' || !(value >= -50 && value <= 0)) {
          throw new Error(`Model: disagreementFloor.${key} must be a number from -50 to 0`)
        }
        disagreementFloor[key] = value
      }
    }
  }
  let platt = base.platt
  if (input.platt !== undefined) {
    if (
      !isRecord(input.platt) ||
      typeof input.platt.a !== 'number' ||
      typeof input.platt.b !== 'number' ||
      !(input.platt.a > 0)
    ) {
      throw new Error('Model: platt must be { a, b } with a > 0')
    }
    platt = { a: input.platt.a, b: input.platt.b }
  }
  return {
    version: 1,
    m,
    defaultM,
    ...(Object.keys(volatility).length > 0 ? { volatility } : {}),
    maxWeight,
    disagreementFloor,
    matchProbability:
      input.matchProbability === undefined
        ? base.matchProbability
        : probability(input.matchProbability, 'matchProbability'),
    platt,
    calibrated: input.calibrated === true,
    ...(isRecord(input.fittedFrom) ? { fittedFrom: input.fittedFrom as Model['fittedFrom'] } : {}),
  }
}

/** How volatile a feature is: the model's override if it has one, otherwise the built-in classification */
export function volatilityFor(model: Model, feature: string): Volatility {
  return model.volatility?.[feature] ?? volatilityOf(feature)
}

export function mFor(model: Model, feature: string): number {
  return model.m[feature] ?? model.defaultM[volatilityFor(model, feature)]
}

/** What the matcher needs to know about the devices it already knows, for one tenant */
export interface PopulationStats {
  /** How many devices are known */
  devices: number
  /** How many devices have had this value of this feature */
  devicesWithValue(feature: string, value: string): number
  /**
   * The chance that two random known devices have the same value of this feature. It is smoothed so that a small
   * population cannot claim certainty: with nothing known it is one half, never one or zero.
   */
  agreementProbability(feature: string): number
}

export function agreementWeight(m: number, devices: number, devicesWithValue: number, maxWeight = 12): number {
  // The candidate itself has the value, so it is left out of the count of "other" devices. One is added to both
  // counts so that a value nobody else has still has a finite weight.
  const others = Math.max(0, devicesWithValue - 1)
  const total = Math.max(0, devices - 1)
  const u = (others + 1) / (total + 2)
  // Agreeing is never evidence against
  return Math.min(maxWeight, Math.max(0, Math.log(m / u)))
}

/**
 * @param floor the lowest a disagreement may weigh. A volatile feature may change a lot without that meaning anything,
 * so its floor is closer to zero.
 */
export function disagreementWeight(m: number, agreementProbability: number, floor = -6): number {
  const u = Math.min(agreementProbability, 0.999)
  // A disagreement is never evidence for the same device, whatever the estimates say
  return Math.min(0, Math.max(floor, Math.log((1 - m) / (1 - u))))
}

/**
 * Smoothed chance that two random devices agree, from how many devices have each value.
 * (Pairs that agree + 1) / (pairs + 2): one made-up agreeing pair and one made-up disagreeing pair.
 */
/**
 * The same estimate from two running totals: how many (device, value) pairs there are, and how many pairs of devices
 * share a value. It is what a store that keeps counters uses, so that it does not have to count again at every visit.
 */
export function smoothedAgreementFromTotals(total: number, agreeingPairs: number): number {
  const pairs = (total * (total - 1)) / 2
  return (agreeingPairs + 1) / (pairs + 2)
}

export function smoothedAgreement(devicesPerValue: Iterable<number>): number {
  let total = 0
  let agreeingPairs = 0
  for (const count of devicesPerValue) {
    total += count
    agreeingPairs += (count * (count - 1)) / 2
  }
  const pairs = (total * (total - 1)) / 2
  return (agreeingPairs + 1) / (pairs + 2)
}

export function priorLogOdds(devices: number): number {
  return -Math.log(Math.max(1, devices))
}

export function probabilityOf(model: Model, logOdds: number): number {
  return 1 / (1 + Math.exp(-(model.platt.a * logOdds + model.platt.b)))
}

export interface Contribution {
  feature: string
  outcome: 'agree' | 'disagree'
  weight: number
}

/** One side of the comparison: the values the candidate device has had, per feature */
export type ValuesSeen = ReadonlyMap<string, ReadonlySet<string>>

export function scoreCandidate(
  observation: Readonly<Record<string, string>>,
  seen: ValuesSeen,
  population: PopulationStats,
  model: Model,
): { logOdds: number; contributions: Contribution[] } {
  const contributions: Contribution[] = []
  for (const [feature, value] of Object.entries(observation)) {
    const values = seen.get(feature)
    if (!values || values.size === 0) {
      continue // the device has no history for this feature: nothing to compare
    }
    const m = mFor(model, feature)
    if (values.has(value)) {
      contributions.push({
        feature,
        outcome: 'agree',
        // A code made up for one device cannot be shared with another by chance, so it is worth the most there is
        weight: isIdentifier(feature)
          ? model.maxWeight
          : agreementWeight(m, population.devices, population.devicesWithValue(feature, value), model.maxWeight),
      })
    } else {
      contributions.push({
        feature,
        outcome: 'disagree',
        weight: disagreementWeight(
          m,
          population.agreementProbability(feature),
          model.disagreementFloor[volatilityFor(model, feature)],
        ),
      })
    }
  }
  const sum = contributions.reduce((total, contribution) => total + contribution.weight, 0)
  return { logOdds: priorLogOdds(population.devices) + sum, contributions }
}
