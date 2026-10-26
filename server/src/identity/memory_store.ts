import type { Features } from './features'
import { smoothedAgreement, type PopulationStats } from './model'
import {
  Activity,
  ActivityQuery,
  CandidateRule,
  defaultCandidateRule,
  DeviceEdit,
  DeviceProfile,
  EventRef,
  FeatureAnonymity,
  FeatureStability,
  SeenDevice,
  DeviceAccount,
  IdentityStore,
  Resolution,
} from './store'

interface Tenant {
  devices: Map<string, DeviceProfile>
  /** `feature` → `value` → ids of the devices that have had it */
  index: Map<string, Map<string, Set<string>>>
  resolutions: Map<string, { deviceId: string; resolution: Resolution }>
  /** `from` → `to`, for devices that were merged into another */
  aliases: Map<string, string>
}

/** A set is "big" when so many devices share the value that it says little. Big sets are not used for candidates. */
function isTooCommon(sharing: number, devices: number, rule: CandidateRule): boolean {
  return sharing > Math.max(rule.minDevices, devices * rule.maxShare)
}

export class MemoryIdentityStore implements IdentityStore {
  private readonly tenants = new Map<string, Tenant>()

  /**
   * @param eventOf finds the event of a resolution, or `undefined` if it was deleted. It lets `removeOrphans` and
   * `activity` work. Without it every resolution is taken to have an event with no address and time zero.
   */
  constructor(
    private readonly eventOf: (tenantId: string, requestId: string) => EventRef | undefined = () => ({
      ip: '',
      receivedAt: 0,
    }),
  ) {}

  private tenant(tenantId: string): Tenant {
    let tenant = this.tenants.get(tenantId)
    if (!tenant) {
      tenant = { devices: new Map(), index: new Map(), resolutions: new Map(), aliases: new Map() }
      this.tenants.set(tenantId, tenant)
    }
    return tenant
  }

  // The features are for stores on the network, which read the population once, for this visit
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  population(tenantId: string, _features?: Features): PopulationStats {
    const tenant = this.tenant(tenantId)
    return {
      devices: tenant.devices.size,
      devicesWithValue: (feature, value) => tenant.index.get(feature)?.get(value)?.size ?? 0,
      agreementProbability: (feature) =>
        smoothedAgreement([...(tenant.index.get(feature)?.values() ?? [])].map((devices) => devices.size)),
    }
  }

  findCandidates(
    tenantId: string,
    features: Features,
    limit: number,
    rule: CandidateRule = defaultCandidateRule,
  ): string[] {
    const tenant = this.tenant(tenantId)
    const rarity = new Map<string, number>()
    const total = tenant.devices.size
    for (const [feature, value] of Object.entries(features)) {
      const sharing = tenant.index.get(feature)?.get(value)
      if (!sharing || isTooCommon(sharing.size, total, rule)) {
        continue
      }
      const weight = -Math.log(sharing.size / Math.max(1, total)) + 1e-9
      // The devices seen most recently, as many as the rule allows
      const read =
        sharing.size <= rule.rowsPerValue
          ? [...sharing]
          : [...sharing]
              .sort(
                (a, b) =>
                  (tenant.devices.get(b)?.lastSeen ?? 0) - (tenant.devices.get(a)?.lastSeen ?? 0) || (a < b ? -1 : 1),
              )
              .slice(0, rule.rowsPerValue)
      for (const deviceId of read) {
        rarity.set(deviceId, (rarity.get(deviceId) ?? 0) + weight)
      }
    }
    return [...rarity.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([deviceId]) => deviceId)
  }

  getProfiles(tenantId: string, deviceIds: readonly string[]): DeviceProfile[] {
    return deviceIds.flatMap((id) => {
      const profile = this.getProfile(tenantId, id)
      return profile ? [profile] : []
    })
  }

  getProfile(tenantId: string, deviceId: string): DeviceProfile | undefined {
    return this.tenant(tenantId).devices.get(deviceId)
  }

  createDevice(tenantId: string, deviceId: string, features: Features, at: number): void {
    const tenant = this.tenant(tenantId)
    if (tenant.devices.has(deviceId)) {
      throw new Error('duplicate device')
    }
    tenant.devices.set(deviceId, { deviceId, visits: 0, firstSeen: at, lastSeen: at, features: new Map() })
    this.addObservation(tenantId, deviceId, features, at)
  }

  addObservation(tenantId: string, deviceId: string, features: Features, at: number): void {
    const tenant = this.tenant(tenantId)
    const profile = tenant.devices.get(deviceId)
    if (!profile) {
      throw new Error('unknown device')
    }
    profile.visits++
    profile.lastSeen = Math.max(profile.lastSeen, at)
    for (const [feature, value] of Object.entries(features)) {
      let values = profile.features.get(feature)
      if (!values) {
        values = new Map()
        profile.features.set(feature, values)
      }
      const use = values.get(value)
      if (use) {
        use.count++
        use.lastSeen = Math.max(use.lastSeen, at)
      } else {
        values.set(value, { count: 1, lastSeen: at })
        let byValue = tenant.index.get(feature)
        if (!byValue) {
          byValue = new Map()
          tenant.index.set(feature, byValue)
        }
        let devices = byValue.get(value)
        if (!devices) {
          devices = new Set()
          byValue.set(value, devices)
        }
        devices.add(deviceId)
      }
    }
  }

  saveResolution(tenantId: string, requestId: string, deviceId: string, resolution: Resolution): void {
    this.tenant(tenantId).resolutions.set(requestId, { deviceId, resolution })
  }

  getResolution(tenantId: string, requestId: string): Resolution | undefined {
    const entry = this.tenant(tenantId).resolutions.get(requestId)
    // The device the visit belongs to now: a merge or a split may have moved it since the visit was decided
    return entry && { ...entry.resolution, visitorId: entry.deviceId }
  }

  resolveAlias(tenantId: string, deviceId: string): string {
    return this.tenant(tenantId).aliases.get(deviceId) ?? deviceId
  }

  /** Takes a device out of the table and of the index of values */
  private dropDevice(tenant: Tenant, deviceId: string): boolean {
    const profile = tenant.devices.get(deviceId)
    if (!profile) {
      return false
    }
    for (const [feature, values] of profile.features) {
      for (const value of values.keys()) {
        const devices = tenant.index.get(feature)?.get(value)
        devices?.delete(deviceId)
        if (devices?.size === 0) {
          tenant.index.get(feature)?.delete(value)
        }
      }
    }
    tenant.devices.delete(deviceId)
    return true
  }

  applyEdit(tenantId: string, edit: DeviceEdit): void {
    const tenant = this.tenant(tenantId)
    for (const id of [...(edit.remove ?? []), ...(edit.write ?? []).map((profile) => profile.deviceId)]) {
      this.dropDevice(tenant, id)
    }
    for (const profile of edit.write ?? []) {
      // A copy, so that nothing outside can change what the store holds
      const features = new Map(
        [...profile.features].map(([feature, values]) => [
          feature,
          new Map([...values].map(([v, use]) => [v, { ...use }])),
        ]),
      )
      tenant.devices.set(profile.deviceId, { ...profile, features })
      for (const [feature, values] of features) {
        for (const value of values.keys()) {
          let byValue = tenant.index.get(feature)
          if (!byValue) {
            byValue = new Map()
            tenant.index.set(feature, byValue)
          }
          let devices = byValue.get(value)
          if (!devices) {
            devices = new Set()
            byValue.set(value, devices)
          }
          devices.add(profile.deviceId)
        }
      }
    }
    const move = edit.moveVisits
    if (move) {
      const only = move.requestIds && new Set(move.requestIds)
      for (const [requestId, entry] of tenant.resolutions) {
        if ((only && only.has(requestId)) || (move.from !== undefined && entry.deviceId === move.from)) {
          entry.deviceId = move.to
        }
      }
    }
    if (edit.alias) {
      for (const [from, to] of tenant.aliases) {
        if (to === edit.alias.from) {
          tenant.aliases.set(from, edit.alias.to)
        }
      }
      tenant.aliases.set(edit.alias.from, edit.alias.to)
    }
  }

  anonymity(tenantId: string, k: number): FeatureAnonymity[] {
    const result: FeatureAnonymity[] = []
    for (const [feature, values] of this.tenant(tenantId).index) {
      let devices = 0
      let below = 0
      for (const sharing of values.values()) {
        devices += sharing.size
        if (sharing.size < k) {
          below += sharing.size
        }
      }
      result.push({ feature, devices, devicesBelowK: below })
    }
    return result.sort((a, b) => (a.feature < b.feature ? -1 : 1))
  }

  devicesSeenFrom(tenantId: string, query: { ip: string; since: number; until: number; limit: number }): SeenDevice[] {
    const latest = new Map<string, number>()
    for (const [requestId, { deviceId }] of this.tenant(tenantId).resolutions) {
      const event = this.eventOf(tenantId, requestId)
      if (!event || event.ip !== query.ip || event.receivedAt < query.since || event.receivedAt > query.until) {
        continue
      }
      latest.set(deviceId, Math.max(latest.get(deviceId) ?? 0, event.receivedAt))
    }
    return [...latest]
      .map(([deviceId, lastSeen]) => ({ deviceId, lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen || (a.deviceId < b.deviceId ? -1 : 1))
      .slice(0, query.limit)
  }

  devicesWithLinkedId(tenantId: string, linkedId: string, limit: number): string[] {
    const found = new Set<string>()
    for (const [requestId, { deviceId }] of this.tenant(tenantId).resolutions) {
      if (this.eventOf(tenantId, requestId)?.linkedId === linkedId) {
        found.add(deviceId)
      }
    }
    return [...found].sort().slice(0, limit)
  }

  accountsOf(tenantId: string, deviceIds: readonly string[], limit: number): DeviceAccount[] {
    const wanted = new Set(deviceIds)
    const pairs = new Map<string, DeviceAccount>()
    for (const [requestId, { deviceId }] of this.tenant(tenantId).resolutions) {
      const linkedId = wanted.has(deviceId) ? this.eventOf(tenantId, requestId)?.linkedId : undefined
      if (linkedId !== undefined) {
        pairs.set(`${deviceId}\u0000${linkedId}`, { deviceId, linkedId })
      }
    }
    return [...pairs.values()]
      .sort((x, y) => (x.deviceId < y.deviceId ? -1 : x.deviceId > y.deviceId ? 1 : x.linkedId < y.linkedId ? -1 : 1))
      .slice(0, limit)
  }

  featureStability(tenantId: string): FeatureStability[] {
    const byFeature = new Map<string, FeatureStability>()
    for (const profile of this.tenant(tenantId).devices.values()) {
      for (const [feature, values] of profile.features) {
        let reads = 0
        for (const use of values.values()) {
          reads += use.count
        }
        if (reads < 2) {
          continue
        }
        const entry = byFeature.get(feature) ?? { feature, devices: 0, changed: 0 }
        entry.devices++
        entry.changed += values.size > 1 ? 1 : 0
        byFeature.set(feature, entry)
      }
    }
    return [...byFeature.values()].sort((a, b) => (a.feature < b.feature ? -1 : 1))
  }

  recentRequests(tenantId: string, deviceId: string, limit: number): string[] {
    const found: Array<{ requestId: string; receivedAt: number }> = []
    for (const [requestId, entry] of this.tenant(tenantId).resolutions) {
      const event = entry.deviceId === deviceId ? this.eventOf(tenantId, requestId) : undefined
      if (event) {
        found.push({ requestId, receivedAt: event.receivedAt })
      }
    }
    return found
      .sort((a, b) => b.receivedAt - a.receivedAt || (a.requestId < b.requestId ? 1 : -1))
      .slice(0, limit)
      .map((item) => item.requestId)
  }

  activity(tenantId: string, query: ActivityQuery): Activity {
    if (query.deviceId === undefined && query.ip === undefined) {
      throw new Error('activity needs a device or an address')
    }
    const devices = new Set<string>()
    const linkedIds = new Set<string>()
    const ips = new Set<string>()
    let visits = 0
    for (const [requestId, { deviceId }] of this.tenant(tenantId).resolutions) {
      const event = this.eventOf(tenantId, requestId)
      if (
        !event ||
        event.receivedAt < query.since ||
        event.receivedAt > query.until ||
        (query.deviceId !== undefined && deviceId !== query.deviceId) ||
        (query.ip !== undefined && event.ip !== query.ip)
      ) {
        continue
      }
      visits++
      devices.add(deviceId)
      ips.add(event.ip)
      if (event.linkedId !== undefined) {
        linkedIds.add(event.linkedId)
      }
    }
    return { visits, devices: devices.size, linkedIds: linkedIds.size, ips: ips.size }
  }

  removeOrphans(): number {
    let removed = 0
    for (const [tenantId, tenant] of this.tenants) {
      for (const [requestId] of tenant.resolutions) {
        if (!this.eventOf(tenantId, requestId)) {
          tenant.resolutions.delete(requestId)
        }
      }
      const alive = new Set([...tenant.resolutions.values()].map((entry) => entry.deviceId))
      for (const deviceId of [...tenant.devices.keys()]) {
        if (alive.has(deviceId)) {
          continue
        }
        this.dropDevice(tenant, deviceId)
        removed++
      }
      // A merged-away id means nothing once the device it points to is gone
      for (const [from, to] of tenant.aliases) {
        if (!tenant.devices.has(to)) {
          tenant.aliases.delete(from)
        }
      }
    }
    return removed
  }
}
