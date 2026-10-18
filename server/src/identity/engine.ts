import { randomBytes } from 'node:crypto'

import type { Features } from './features'
import { Contribution, Model, probabilityOf, scoreCandidate, ValuesSeen } from './model'
import type { Explanation, IdentityStore, Resolution } from './store'

export interface EngineOptions {
  now?: () => number
  /** Makes the id of a new device. Random by default; fixed in tests. */
  newId?: () => string
  /** How many known devices are compared with a visit */
  maxCandidates?: number
}

const explanationSize = 8
/** If the second-best device is this close (in log-odds) to the best one, the choice is called ambiguous */
const ambiguityMargin = 2

function valuesSeen(profile: { features: Map<string, Map<string, unknown>> }): ValuesSeen {
  const seen = new Map<string, Set<string>>()
  for (const [feature, values] of profile.features) {
    seen.set(feature, new Set(values.keys()))
  }
  return seen
}

/**
 * Decides which known device a visit belongs to, or that it is a new one, and remembers the result.
 * The decision is a pure function of the visit, the devices already known and the model, so it can be explained.
 * Everything is per tenant: the devices of one tenant are never candidates for another.
 */
export class IdentityEngine {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly maxCandidates: number

  constructor(private readonly store: IdentityStore, readonly model: Model, options: EngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `v_${randomBytes(12).toString('base64url')}`)
    this.maxCandidates = options.maxCandidates ?? 20
  }

  getResolution(tenantId: string, requestId: string): Resolution | undefined {
    return this.store.getResolution(tenantId, requestId)
  }

  private explain(contributions: readonly Contribution[], logOdds: number): Explanation[] {
    return [...contributions]
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (a.feature < b.feature ? -1 : 1))
      .slice(0, explanationSize)
      .map((contribution) => ({
        ...contribution,
        probabilityWithoutIt: probabilityOf(this.model, logOdds - contribution.weight),
      }))
  }

  resolve(tenantId: string, requestId: string, features: Features, at: number): Resolution {
    const population = this.store.population(tenantId)
    const devices = population.devices

    const scored = this.store
      .findCandidates(tenantId, features, this.maxCandidates)
      .map((deviceId) => {
        const profile = this.store.getProfile(tenantId, deviceId)
        return profile
          ? { deviceId, ...scoreCandidate(features, valuesSeen(profile), population, this.model) }
          : undefined
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      .sort((a, b) => b.logOdds - a.logOdds || (a.deviceId < b.deviceId ? -1 : 1))

    const best = scored[0]
    const second = scored[1]
    const bestProbability = best ? probabilityOf(this.model, best.logOdds) : undefined
    const matched =
      best !== undefined && bestProbability !== undefined && bestProbability >= this.model.matchProbability

    const visitorId = matched ? best.deviceId : this.newId()
    if (matched) {
      this.store.addObservation(tenantId, visitorId, features, at)
    } else {
      this.store.createDevice(tenantId, visitorId, features, at)
    }

    const resolution: Resolution = {
      visitorId,
      matched,
      ambiguous: matched && second !== undefined && best.logOdds - second.logOdds < ambiguityMargin,
      logOdds: best ? best.logOdds : null,
      probability: best && this.model.calibrated ? bestProbability ?? null : null,
      provisionalProbability: bestProbability ?? null,
      calibrated: this.model.calibrated,
      candidates: scored.length,
      devices,
      explanation: best ? this.explain(best.contributions, best.logOdds) : [],
      resolvedAt: this.now(),
    }
    this.store.saveResolution(tenantId, requestId, visitorId, resolution)
    return resolution
  }
}
