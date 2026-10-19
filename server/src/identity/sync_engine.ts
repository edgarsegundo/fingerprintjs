import { randomBytes } from 'node:crypto'

import { decide, EngineOptions, ResolveParams, settle } from './decision'
import type { Features } from './features'
import type { MemoryIdentityStore } from './memory_store'
import type { Model } from './model'
import type { Resolution } from './store'

/**
 * The engine over the memory store, answering at once. It makes the same decisions as `IdentityEngine` (both use
 * `decide`) and exists for the tools that replay thousands of visits in a loop, such as the fitting of a model and the
 * evaluation, where waiting for a promise per visit would add nothing but noise. The server uses `IdentityEngine`.
 */
export class SyncIdentityEngine {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly defaults: Required<Pick<ResolveParams, 'maxCandidates' | 'ambiguityMargin' | 'explanationSize'>>

  constructor(private readonly store: MemoryIdentityStore, readonly model: Model, options: EngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `v_${randomBytes(12).toString('base64url')}`)
    this.defaults = {
      maxCandidates: options.maxCandidates ?? 20,
      ambiguityMargin: options.ambiguityMargin ?? 2,
      explanationSize: options.explanationSize ?? 8,
    }
  }

  getResolution(tenantId: string, requestId: string): Resolution | undefined {
    return this.store.getResolution(tenantId, requestId)
  }

  resolve(tenantId: string, requestId: string, features: Features, at: number, params: ResolveParams = {}): Resolution {
    const settings = settle(this.model, this.defaults, params)
    const population = this.store.population(tenantId, features)
    const ids = this.store.findCandidates(tenantId, features, settings.maxCandidates, settings.candidateRule)
    const candidates = this.store.getProfiles(tenantId, ids)
    const { visitorId, matched, resolution } = decide({
      features,
      population,
      candidates,
      settings,
      newDeviceId: this.newId,
      resolvedAt: this.now(),
    })
    if (settings.learn) {
      if (matched) {
        this.store.addObservation(tenantId, visitorId, features, at)
      } else {
        this.store.createDevice(tenantId, visitorId, features, at)
      }
    }
    this.store.saveResolution(tenantId, requestId, visitorId, resolution)
    return resolution
  }
}
