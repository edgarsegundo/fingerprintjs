import type { Features } from './features'
import { isIdentifier } from './features'
import { Contribution, Model, PopulationStats, probabilityOf, scoreCandidate, ValuesSeen, volatilityFor } from './model'
import { CandidateRule, defaultCandidateRule, DeviceProfile, Explanation, Resolution } from './store'

export interface EngineOptions {
  now?: () => number
  /** Makes the id of a new device. Random by default; fixed in tests. */
  newId?: () => string
  /** The defaults of `ResolveParams`, used when a call does not give its own */
  maxCandidates?: number
  ambiguityMargin?: number
  explanationSize?: number
}

/** What can be decided per call, so that every tenant can have its own. All are optional. */
export interface ResolveParams {
  /** The model for this call. Its `matchProbability` is the bar to attach a visit to a known device. */
  model?: Model
  /** How many known devices are compared with the visit */
  maxCandidates?: number
  /** Which values are too common to be used to look for candidates, and how many devices of a value are read */
  candidateRule?: CandidateRule
  /**
   * What to do when two known devices fit almost equally. `separate` (the default) does not attach the visit to either:
   * it becomes a new device and the closest one is marked as a possible link. Attaching the visit to the wrong person
   * is the costlier mistake, and a duplicate is easy to merge later. `attach` takes the best one anyway.
   */
  onAmbiguous?: 'attach' | 'separate'
  /** If the second-best device is closer than this (in log-odds), the choice is called ambiguous */
  ambiguityMargin?: number
  /** How many features the explanation lists */
  explanationSize?: number
  /**
   * The certainty from which the closest device that was NOT chosen is reported as a possible link. It is only a
   * mark: the identifiers stay separate. `null` or absent turns the mark off.
   */
  possibleLinkProbability?: number | null
  /**
   * How much the stable features of the closest device must disagree (the sum of their weights, as a positive number
   * of log-odds) for a visit that brings its stored code to be marked `storedIdConflict`. Default 10.
   */
  storedIdConflictThreshold?: number
  /**
   * If `false`, nothing about the visit is added to what is known: it still gets a visitor id, but it does not create a
   * device nor teach the engine a new value. For visits that should not be trusted to teach.
   */
  learn?: boolean
}

function valuesSeen(profile: { features: Map<string, Map<string, unknown>> }): ValuesSeen {
  const seen = new Map<string, Set<string>>()
  for (const [feature, values] of profile.features) {
    seen.set(feature, new Set(values.keys()))
  }
  return seen
}

function explain(model: Model, contributions: readonly Contribution[], logOdds: number, size: number): Explanation[] {
  return [...contributions]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (a.feature < b.feature ? -1 : 1))
    .slice(0, size)
    .map((contribution) => ({
      ...contribution,
      probabilityWithoutIt: probabilityOf(model, logOdds - contribution.weight),
    }))
}

/** What an engine needs from the options and the parameters of one call, with the defaults filled */
export function settle(
  fallbackModel: Model,
  defaults: Required<Pick<ResolveParams, 'maxCandidates' | 'ambiguityMargin' | 'explanationSize'>>,
  params: ResolveParams,
) {
  return {
    model: params.model ?? fallbackModel,
    maxCandidates: params.maxCandidates ?? defaults.maxCandidates,
    candidateRule: params.candidateRule ?? defaultCandidateRule,
    ambiguityMargin: params.ambiguityMargin ?? defaults.ambiguityMargin,
    explanationSize: params.explanationSize ?? defaults.explanationSize,
    possibleLinkProbability: params.possibleLinkProbability ?? null,
    onAmbiguous: params.onAmbiguous ?? 'separate',
    storedIdConflictThreshold: params.storedIdConflictThreshold ?? 10,
    learn: params.learn ?? true,
  }
}

export type Settled = ReturnType<typeof settle>

/**
 * The visit brought the stored code of this device and still disagrees with it on what does not change. A code that
 * was copied to another machine looks like this. The features that change by themselves (volatile, semi) do not count.
 */
function storedIdConflicts(model: Model, contributions: readonly Contribution[], threshold: number): boolean {
  const sameCode = contributions.some((c) => c.outcome === 'agree' && isIdentifier(c.feature))
  if (!sameCode) {
    return false
  }
  const stable = contributions
    .filter((c) => c.outcome === 'disagree' && volatilityFor(model, c.feature) === 'stable')
    .reduce((sum, c) => sum + c.weight, 0)
  return -stable >= threshold
}

export interface Decision {
  /** The device the visit belongs to: a known one, or `newDeviceId` */
  visitorId: string
  /** `true` if the visit was attached to a known device, `false` if it is (and makes) a new one */
  matched: boolean
  resolution: Resolution
}

/**
 * Decides which of the candidate devices the visit belongs to, or that it is a new one. It is a pure function of what
 * it is given: it reads no store and writes none, so the same decision can be made over any storage, and be explained.
 */
export function decide(input: {
  features: Features
  population: PopulationStats
  candidates: readonly DeviceProfile[]
  settings: Settled
  /** Makes the id of a new device. Called only if the visit does not belong to a known one. */
  newDeviceId: () => string
  resolvedAt: number
}): Decision {
  const { features, population, settings } = input
  const { model } = settings
  const scored = input.candidates
    .map((profile) => ({
      deviceId: profile.deviceId,
      ...scoreCandidate(features, valuesSeen(profile), population, model),
    }))
    .sort((a, b) => b.logOdds - a.logOdds || (a.deviceId < b.deviceId ? -1 : 1))

  const best = scored[0]
  const second = scored[1]
  const bestProbability = best ? probabilityOf(model, best.logOdds) : undefined
  const aboveBar = best !== undefined && bestProbability !== undefined && bestProbability >= model.matchProbability
  const tie = aboveBar && second !== undefined && best.logOdds - second.logOdds < settings.ambiguityMargin
  const separated = tie && settings.onAmbiguous === 'separate'
  const matched = aboveBar && !separated
  const { possibleLinkProbability } = settings

  const isPossibleLink =
    !matched &&
    best !== undefined &&
    bestProbability !== undefined &&
    (separated || (possibleLinkProbability !== null && bestProbability >= possibleLinkProbability))

  const visitorId = matched ? best.deviceId : input.newDeviceId()
  const resolution: Resolution = {
    visitorId,
    matched,
    ambiguous: tie,
    learned: settings.learn,
    logOdds: best ? best.logOdds : null,
    probability: best && model.calibrated ? bestProbability ?? null : null,
    provisionalProbability: bestProbability ?? null,
    calibrated: model.calibrated,
    thresholds: { match: model.matchProbability, possibleLink: possibleLinkProbability },
    candidates: scored.length,
    devices: population.devices,
    explanation: best ? explain(model, best.contributions, best.logOdds, settings.explanationSize) : [],
    ...(best && storedIdConflicts(model, best.contributions, settings.storedIdConflictThreshold)
      ? { storedIdConflict: true as const }
      : {}),
    resolvedAt: input.resolvedAt,
    ...(isPossibleLink
      ? {
          possibleLink: {
            visitorId: best.deviceId,
            logOdds: best.logOdds,
            probability: model.calibrated ? bestProbability ?? null : null,
            provisionalProbability: bestProbability,
          },
        }
      : {}),
  }
  return { visitorId, matched, resolution }
}
