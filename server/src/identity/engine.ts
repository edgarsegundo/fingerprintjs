import { randomBytes } from 'node:crypto'

import { decide, EngineOptions, ResolveParams, settle } from './decision'
import { mergeProfiles, Observation, profileOf, withoutObservations } from './edit'
import type { Features } from './features'
import type { Model } from './model'
import type { Activity, ActivityQuery, FeatureAnonymity, IdentityStore, Resolution } from './store'

export type { EngineOptions, ResolveParams } from './decision'

/**
 * Decides which known device a visit belongs to, or that it is a new one, and remembers the result, over any store.
 * The decision itself is `decide`, a pure function of the visit, the devices already known and the model, so it can be
 * explained. Everything is per tenant: the devices of one tenant are never candidates for another.
 *
 * Reading what is known, deciding and writing are separate steps over a store that may be on the network, so two
 * visits of one tenant that arrive together could both read the same state. The engine therefore takes the visits of a
 * tenant one at a time. (That holds inside one process; with several processes the database is the only referee.)
 */
export class IdentityEngine {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly defaults: Required<Pick<ResolveParams, 'maxCandidates' | 'ambiguityMargin' | 'explanationSize'>>
  private readonly turns = new Map<string, Promise<unknown>>()

  constructor(private readonly store: IdentityStore, readonly model: Model, options: EngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `v_${randomBytes(12).toString('base64url')}`)
    this.defaults = {
      maxCandidates: options.maxCandidates ?? 20,
      ambiguityMargin: options.ambiguityMargin ?? 2,
      explanationSize: options.explanationSize ?? 8,
    }
  }

  async recentRequests(tenantId: string, deviceId: string, limit: number): Promise<string[]> {
    return this.store.recentRequests(tenantId, deviceId, limit)
  }

  /** Forgets the devices and resolutions whose events were deleted. Returns how many devices were forgotten. */
  async removeOrphans(): Promise<number> {
    return this.store.removeOrphans()
  }

  async anonymity(tenantId: string, k: number): Promise<FeatureAnonymity[]> {
    return this.store.anonymity(tenantId, k)
  }

  async deviceCount(tenantId: string): Promise<number> {
    return (await this.store.population(tenantId, {})).devices
  }

  async getProfile(tenantId: string, deviceId: string) {
    return this.store.getProfile(tenantId, deviceId)
  }

  /** Counts the visits of a device, or from an address, in a window of time */
  async activity(tenantId: string, query: ActivityQuery): Promise<Activity> {
    return this.store.activity(tenantId, query)
  }

  async getResolution(tenantId: string, requestId: string): Promise<Resolution | undefined> {
    const resolution = await this.store.getResolution(tenantId, requestId)
    if (resolution?.possibleLink) {
      // The device that the visit looked like may have been merged into another since
      const visitorId = await this.store.resolveAlias(tenantId, resolution.possibleLink.visitorId)
      return { ...resolution, possibleLink: { ...resolution.possibleLink, visitorId } }
    }
    return resolution
  }

  /** The device that an id means now: the id itself, unless that device was merged into another one */
  async resolveAlias(tenantId: string, deviceId: string): Promise<string> {
    return this.store.resolveAlias(tenantId, deviceId)
  }

  /**
   * Merges `fromId` into `intoId`: one device with the values and the visits of both. The visits of `fromId` now belong
   * to `intoId`, and the old id keeps working as a name for it. It is a person's decision; the engine never merges
   * alone.
   */
  merge(
    tenantId: string,
    fromId: string,
    intoId: string,
  ): Promise<
    { ok: true; visitorId: string; visits: number } | { ok: false; reason: 'same_device' | 'unknown_device' }
  > {
    return this.inTurn(tenantId, async () => {
      const from = await this.store.resolveAlias(tenantId, fromId)
      const into = await this.store.resolveAlias(tenantId, intoId)
      if (from === into) {
        return { ok: false, reason: 'same_device' } as const
      }
      const [source, target] = await this.store.getProfiles(tenantId, [from, into])
      if (!source || !target || source.deviceId !== from || target.deviceId !== into) {
        return { ok: false, reason: 'unknown_device' } as const
      }
      const merged = mergeProfiles(target, source)
      await this.store.applyEdit(tenantId, {
        remove: [from],
        write: [merged],
        moveVisits: { to: into, from },
        alias: { from, to: into, at: this.now() },
      })
      return { ok: true, visitorId: into, visits: merged.visits } as const
    })
  }

  /**
   * Splits some visits off a device into a new one. `visits` are those to move, each with the features it taught. The
   * device loses what those visits taught (what it learned from older visits, whose events are gone, stays), and the
   * new device is made of them alone. Visits that were not allowed to teach the engine move without teaching.
   */
  split(
    tenantId: string,
    deviceId: string,
    visits: ReadonlyArray<{ requestId: string; features: Features; at: number }>,
  ): Promise<
    | { ok: true; visitorId: string; moved: number }
    | { ok: false; reason: 'unknown_device' | 'nothing_to_move' | 'not_of_this_device' | 'would_empty_the_device' }
  > {
    return this.inTurn(tenantId, async () => {
      const id = await this.store.resolveAlias(tenantId, deviceId)
      const profile = await this.store.getProfile(tenantId, id)
      if (!profile) {
        return { ok: false, reason: 'unknown_device' } as const
      }
      if (visits.length === 0) {
        return { ok: false, reason: 'nothing_to_move' } as const
      }
      const taught: Observation[] = []
      for (const visit of visits) {
        const resolution = await this.store.getResolution(tenantId, visit.requestId)
        if (!resolution || resolution.visitorId !== id) {
          return { ok: false, reason: 'not_of_this_device' } as const
        }
        if (resolution.learned) {
          taught.push({ features: visit.features, at: visit.at })
        }
      }
      if (profile.visits - taught.length <= 0) {
        return { ok: false, reason: 'would_empty_the_device' } as const
      }
      const created = profileOf(this.newId(), taught)
      // A new device made only of visits that taught nothing still needs a row, or it would have no profile to read
      const newDevice = taught.length === 0 ? { ...created, firstSeen: this.now(), lastSeen: this.now() } : created
      await this.store.applyEdit(tenantId, {
        write: [withoutObservations(profile, taught), newDevice],
        moveVisits: { to: newDevice.deviceId, requestIds: visits.map((visit) => visit.requestId) },
      })
      return { ok: true, visitorId: newDevice.deviceId, moved: visits.length } as const
    })
  }

  /** Runs the work after the earlier work of the same tenant, and returns when it is done */
  private async inTurn<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const before = this.turns.get(tenantId) ?? Promise.resolve()
    // First this process's own queue, then the lock that the other processes respect (if the store has one)
    const run = this.store.withTenantLock ? () => this.store.withTenantLock?.(tenantId, work) as Promise<T> : work
    const mine = before.then(run, run)
    const marker = mine.catch(() => undefined)
    this.turns.set(tenantId, marker)
    try {
      return await mine
    } finally {
      if (this.turns.get(tenantId) === marker) {
        this.turns.delete(tenantId)
      }
    }
  }

  async resolve(
    tenantId: string,
    requestId: string,
    features: Features,
    at: number,
    params: ResolveParams = {},
  ): Promise<Resolution> {
    // The answer is written inside the turn too: a merge or a split that came right after the decision must find the
    // visit already attached to its device, or it would be left pointing at a device that is gone.
    return this.inTurn(tenantId, async () => {
      const settings = settle(this.model, this.defaults, params)
      const population = await this.store.population(tenantId, features)
      const ids = await this.store.findCandidates(tenantId, features, settings.maxCandidates, settings.candidateRule)
      const candidates = await this.store.getProfiles(tenantId, ids)
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
          await this.store.addObservation(tenantId, visitorId, features, at)
        } else {
          await this.store.createDevice(tenantId, visitorId, features, at)
        }
      }
      await this.store.saveResolution(tenantId, requestId, visitorId, resolution)
      return resolution
    })
  }
}
