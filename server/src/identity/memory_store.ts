import type { Features } from './features'
import { smoothedAgreement, type PopulationStats } from './model'
import type { DeviceProfile, IdentityStore, Resolution } from './store'

interface Tenant {
  devices: Map<string, DeviceProfile>
  /** `feature` → `value` → ids of the devices that have had it */
  index: Map<string, Map<string, Set<string>>>
  resolutions: Map<string, { deviceId: string; resolution: Resolution }>
}

/** A set is "big" when so many devices share the value that it says little. Big sets are not used for candidates. */
function isTooCommon(sharing: number, devices: number): boolean {
  return sharing > Math.max(50, devices * 0.05)
}

export class MemoryIdentityStore implements IdentityStore {
  private readonly tenants = new Map<string, Tenant>()

  /** @param eventExists tells whether the event of a resolution still exists, so that `removeOrphans` can work */
  constructor(private readonly eventExists: (tenantId: string, requestId: string) => boolean = () => true) {}

  private tenant(tenantId: string): Tenant {
    let tenant = this.tenants.get(tenantId)
    if (!tenant) {
      tenant = { devices: new Map(), index: new Map(), resolutions: new Map() }
      this.tenants.set(tenantId, tenant)
    }
    return tenant
  }

  population(tenantId: string): PopulationStats {
    const tenant = this.tenant(tenantId)
    return {
      devices: tenant.devices.size,
      devicesWithValue: (feature, value) => tenant.index.get(feature)?.get(value)?.size ?? 0,
      agreementProbability: (feature) =>
        smoothedAgreement([...(tenant.index.get(feature)?.values() ?? [])].map((devices) => devices.size)),
    }
  }

  findCandidates(tenantId: string, features: Features, limit: number): string[] {
    const tenant = this.tenant(tenantId)
    const rarity = new Map<string, number>()
    const total = tenant.devices.size
    for (const [feature, value] of Object.entries(features)) {
      const sharing = tenant.index.get(feature)?.get(value)
      if (!sharing || isTooCommon(sharing.size, total)) {
        continue
      }
      const weight = -Math.log(sharing.size / Math.max(1, total)) + 1e-9
      for (const deviceId of sharing) {
        rarity.set(deviceId, (rarity.get(deviceId) ?? 0) + weight)
      }
    }
    return [...rarity.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([deviceId]) => deviceId)
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
    return this.tenant(tenantId).resolutions.get(requestId)?.resolution
  }

  removeOrphans(): number {
    let removed = 0
    for (const [tenantId, tenant] of this.tenants) {
      for (const [requestId] of tenant.resolutions) {
        if (!this.eventExists(tenantId, requestId)) {
          tenant.resolutions.delete(requestId)
        }
      }
      const alive = new Set([...tenant.resolutions.values()].map((entry) => entry.deviceId))
      for (const [deviceId, profile] of tenant.devices) {
        if (alive.has(deviceId)) {
          continue
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
        removed++
      }
    }
    return removed
  }
}
