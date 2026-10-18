import type { Features } from './features'
import type { PopulationStats } from './model'

export interface ValueUse {
  count: number
  lastSeen: number
}

/** Everything known about one device: each feature with every value it has had, and how often */
export interface DeviceProfile {
  deviceId: string
  visits: number
  firstSeen: number
  lastSeen: number
  features: Map<string, Map<string, ValueUse>>
}

export interface Explanation {
  feature: string
  outcome: 'agree' | 'disagree'
  weight: number
  /** The probability if this feature had not been there. It shows how much the decision leaned on it. */
  probabilityWithoutIt: number
}

export interface Resolution {
  visitorId: string
  /** True if the visit was attached to a device that was already known */
  matched: boolean
  /** True if another known device came almost as close, so the choice could have gone the other way */
  ambiguous: boolean
  /** The sum of evidence, including the prior. `null` when nothing could be compared. */
  logOdds: number | null
  /** The probability of the decision. `null` unless the model was fitted on labelled data. */
  probability: number | null
  /** The probability the model would give, shown even when it is not calibrated. Do not rely on it. */
  provisionalProbability: number | null
  calibrated: boolean
  /** How many known devices were compared */
  candidates: number
  /** How many devices were known before this visit */
  devices: number
  /** For a match: why. For a new device: why the closest candidate was refused. */
  explanation: Explanation[]
  resolvedAt: number
}

export interface IdentityStore {
  /** How many devices are known for the tenant */
  population(tenantId: string): PopulationStats
  /** Devices that share at least one feature value with the visit, the most likely first */
  findCandidates(tenantId: string, features: Features, limit: number): string[]
  getProfile(tenantId: string, deviceId: string): DeviceProfile | undefined
  createDevice(tenantId: string, deviceId: string, features: Features, at: number): void
  addObservation(tenantId: string, deviceId: string, features: Features, at: number): void
  saveResolution(tenantId: string, requestId: string, deviceId: string, resolution: Resolution): void
  getResolution(tenantId: string, requestId: string): Resolution | undefined
  /** Devices that were seen in this visit and no other can be forgotten with it */
  removeOrphans(): number
}
