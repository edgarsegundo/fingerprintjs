import type { Features } from './features'
import type { DeviceProfile, ValueUse } from './store'

/** One visit as the engine learned it: the features it taught and when */
export interface Observation {
  features: Features
  at: number
}

const copyFeatures = (features: DeviceProfile['features']): DeviceProfile['features'] =>
  new Map([...features].map(([feature, values]) => [feature, new Map([...values].map(([v, use]) => [v, { ...use }]))]))

/**
 * What the device `into` knows after `from` was merged into it: every value of both, with the visits added up. Neither
 * argument is changed.
 */
export function mergeProfiles(into: DeviceProfile, from: DeviceProfile): DeviceProfile {
  const features = copyFeatures(into.features)
  for (const [feature, values] of from.features) {
    let target = features.get(feature)
    if (!target) {
      target = new Map()
      features.set(feature, target)
    }
    for (const [value, use] of values) {
      const existing = target.get(value)
      target.set(value, {
        count: (existing?.count ?? 0) + use.count,
        lastSeen: Math.max(existing?.lastSeen ?? 0, use.lastSeen),
      })
    }
  }
  return {
    deviceId: into.deviceId,
    visits: into.visits + from.visits,
    firstSeen: Math.min(into.firstSeen, from.firstSeen),
    lastSeen: Math.max(into.lastSeen, from.lastSeen),
    features,
  }
}

/** A new device made only of the given visits */
export function profileOf(deviceId: string, observations: readonly Observation[]): DeviceProfile {
  const features = new Map<string, Map<string, ValueUse>>()
  let firstSeen = Number.POSITIVE_INFINITY
  let lastSeen = 0
  for (const { features: seen, at } of observations) {
    firstSeen = Math.min(firstSeen, at)
    lastSeen = Math.max(lastSeen, at)
    for (const [feature, value] of Object.entries(seen)) {
      let values = features.get(feature)
      if (!values) {
        values = new Map()
        features.set(feature, values)
      }
      const use = values.get(value)
      values.set(value, { count: (use?.count ?? 0) + 1, lastSeen: Math.max(use?.lastSeen ?? 0, at) })
    }
  }
  return {
    deviceId,
    visits: observations.length,
    firstSeen: observations.length > 0 ? firstSeen : 0,
    lastSeen,
    features,
  }
}

/**
 * What a device knows after the given visits are taken away: each value loses one count per visit, and a value that
 * is left with none is forgotten. What the device learned from visits that are not listed (old ones, whose events
 * were deleted) stays. The times of the device are kept as they were.
 */
export function withoutObservations(profile: DeviceProfile, observations: readonly Observation[]): DeviceProfile {
  const features = copyFeatures(profile.features)
  for (const { features: seen } of observations) {
    for (const [feature, value] of Object.entries(seen)) {
      const values = features.get(feature)
      const use = values?.get(value)
      if (!values || !use) {
        continue
      }
      if (use.count <= 1) {
        values.delete(value)
      } else {
        use.count -= 1
      }
      if (values.size === 0) {
        features.delete(feature)
      }
    }
  }
  return { ...profile, visits: Math.max(0, profile.visits - observations.length), features }
}
