import type { MaybePromise } from '../async'

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
  /**
   * False if the visit was not allowed to teach the engine (see `learn` in the settings). It still has a visitor id,
   * but nothing was added to the profile of any device.
   */
  learned: boolean
  /** The sum of evidence, including the prior. `null` when nothing could be compared. */
  logOdds: number | null
  /** The probability of the decision. `null` unless the model was fitted on labelled data. */
  probability: number | null
  /** The probability the model would give, shown even when it is not calibrated. Do not rely on it. */
  provisionalProbability: number | null
  calibrated: boolean
  /** The bars that were used: the certainty to attach the visit, and the one to mark a possible link (or `null`) */
  thresholds: { match: number; possibleLink: number | null }
  /** How many known devices were compared */
  candidates: number
  /** How many devices were known before this visit */
  devices: number
  /** For a match: why. For a new device: why the closest candidate was refused. */
  explanation: Explanation[]
  /**
   * Present (and true) when the visit brought the stored code of a known device but disagrees with that device on
   * what does not change (the graphics card, the screen), as if the code had been copied to another machine. Evidence,
   * not proof: the tenant decides what it is worth (`risk.storedIdConflictWeight`).
   */
  storedIdConflict?: true
  resolvedAt: number
  /**
   * Present when the visit was not attached but the closest known device was certain enough to be worth a look.
   * The identifiers stay separate: this is a lead for a rule or a person, not a merge.
   */
  possibleLink?: {
    visitorId: string
    logOdds: number
    /** `null` unless the model is calibrated */
    probability: number | null
    provisionalProbability: number
  }
}

/** What is asked about recent visits: those of one device, or those from one address. Times are in ms and inclusive. */
export interface ActivityQuery {
  deviceId?: string
  ip?: string
  since: number
  until: number
}

/** How much happened in the window. Counts only: nothing about the visits themselves leaves the store. */
export interface Activity {
  visits: number
  /** Different devices seen */
  devices: number
  /** Different `linkedId` values (accounts, usually) */
  linkedIds: number
  /** Different addresses */
  ips: number
}

/** The part of a stored event that the memory store needs, so that it answers `activity` like the SQL one does */
export interface EventRef {
  ip: string
  linkedId?: string
  receivedAt: number
}

export interface FeatureAnonymity {
  feature: string
  /** Devices that have the feature (counting a device once per value it has had) */
  devices: number
  /** Of those, how many share their value with fewer than `k` devices, the device itself included */
  devicesBelowK: number
}

/**
 * Which values are too common to be worth reading all the devices that have them. A value is skipped when more than
 * `max(minDevices, maxShare × known devices)` devices share it: it says little, and reading them costs a lot. Of the
 * devices that share a value that is not skipped, only the `rowsPerValue` seen most recently are read, so that the
 * cost of a visit does not grow with the population. A device that has not been seen for long, and shares only values
 * that many others have, can be missed; one with a rare value is always found.
 */
export interface CandidateRule {
  maxShare: number
  minDevices: number
  rowsPerValue: number
}

export const defaultCandidateRule: CandidateRule = { maxShare: 0.05, minDevices: 50, rowsPerValue: 200 }

/**
 * A correction of who is who, applied all at once: either every part of it happens or none does, and the counters of
 * the population are right afterwards. A person asks for it (merge two devices, split one), it is never automatic.
 */
export interface DeviceEdit {
  /** Devices to remove with all their values */
  remove?: readonly string[]
  /** Devices to write in full. One that already exists is replaced, values and all. */
  write?: readonly DeviceProfile[]
  /** Visits to point at another device: all those of `from`, or the listed `requestIds` */
  moveVisits?: { to: string; from?: string; requestIds?: readonly string[] }
  /** From now on `from` means `to`. Older aliases that pointed at `from` are pointed at `to` too. */
  alias?: { from: string; to: string; at: number }
}

export interface IdentityStore {
  /** How many devices are known for the tenant */
  population(tenantId: string, features: Features): MaybePromise<PopulationStats>
  /** Devices that share at least one feature value with the visit, the most likely first */
  findCandidates(tenantId: string, features: Features, limit: number, rule?: CandidateRule): MaybePromise<string[]>
  getProfile(tenantId: string, deviceId: string): MaybePromise<DeviceProfile | undefined>
  /** Several profiles at once; an unknown id is left out. A store on the network answers in one trip. */
  getProfiles(tenantId: string, deviceIds: readonly string[]): MaybePromise<DeviceProfile[]>
  createDevice(tenantId: string, deviceId: string, features: Features, at: number): MaybePromise<void>
  addObservation(tenantId: string, deviceId: string, features: Features, at: number): MaybePromise<void>
  saveResolution(tenantId: string, requestId: string, deviceId: string, resolution: Resolution): MaybePromise<void>
  getResolution(tenantId: string, requestId: string): MaybePromise<Resolution | undefined>
  /**
   * Runs the work while no other instance of the server is deciding about the same tenant. A store that can be shared
   * by several processes gives it; one that lives in a single process does not, and the engine's own queue is enough.
   */
  withTenantLock?<T>(tenantId: string, work: () => Promise<T>): Promise<T>
  /** Applies a correction of who is who. See `DeviceEdit`. */
  applyEdit(tenantId: string, edit: DeviceEdit): MaybePromise<void>
  /** The device that an id means now: the id itself, unless it was merged into another one */
  resolveAlias(tenantId: string, deviceId: string): MaybePromise<string>
  /** Devices that were seen in this visit and no other can be forgotten with it */
  removeOrphans(): MaybePromise<number>
  /** The request ids of the latest visits of a device, newest first. Only visits whose event still exists. */
  recentRequests(tenantId: string, deviceId: string, limit: number): MaybePromise<string[]>
  /**
   * For each feature, how many devices have a value that fewer than `k` devices share. A device with such a value is
   * easy to single out by that feature alone, so a high share means the feature identifies more than it hides.
   */
  anonymity(tenantId: string, k: number): MaybePromise<FeatureAnonymity[]>
  /** Counts the visits of a device, or from an address, in a window of time. One of the two must be given. */
  activity(tenantId: string, query: ActivityQuery): MaybePromise<Activity>
}
