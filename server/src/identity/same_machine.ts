import { Features, scopeOf } from './features'
import { Contribution, Model, PopulationStats, scoreCandidate, ValuesSeen } from './model'
import type { DeviceProfile, SameMachine } from './store'

/** What decides a same-machine link. All of it is a setting of the tenant (`identity.sameMachine.*`). */
export interface SameMachineParams {
  enabled: boolean
  /** How far back the same address counts as "at the same time", in minutes */
  windowMinutes: number
  /** More known devices than this on the address in the window (an office, a shared mobile IP): nothing is linked */
  maxDevicesPerIp: number
  /** The least evidence, in log-odds, for a link. Provisional until real data can fit it. */
  minLogOdds: number
  /** The least number of machine features that must agree */
  minFeatures: number
  /** The most links that one visit gets */
  maxLinks: number
  /**
   * Off by default. On, a visit that is not attached to a known device but is very probably the same machine as one
   * seen in another browser takes THAT device's visitor id: one id for the machine whatever the browser. It joins
   * identifiers, which is the costlier mistake (D78), so it needs the stronger bar below and a clear winner.
   */
  merge: boolean
  /** The least evidence, in log-odds, to take the other device's id. Above `minLogOdds`. Provisional. */
  mergeMinLogOdds: number
  /**
   * Off by default. On, a visit that is attached to a known device and is very probably the same machine as ANOTHER
   * known device (seen only in other browsers) joins the two devices into one, as a person would with "merge", with
   * the bar `mergeMinLogOdds` and a clear winner. It rewrites what the older visits belong to: its own switch.
   */
  mergeExisting: boolean
}

export const defaultSameMachineParams: SameMachineParams = {
  enabled: false,
  windowMinutes: 30,
  maxDevicesPerIp: 5,
  minLogOdds: 4,
  minFeatures: 3,
  maxLinks: 3,
  merge: false,
  mergeMinLogOdds: 6,
  mergeExisting: false,
}

const machineOnly = (features: Features): Features =>
  Object.fromEntries(Object.entries(features).filter(([name]) => scopeOf(name) === 'machine'))

const machineValues = (profile: DeviceProfile): ValuesSeen =>
  new Map(
    [...profile.features]
      .filter(([name]) => scopeOf(name) === 'machine')
      .map(([name, values]) => [name, new Set(values.keys())]),
  )

const rank = (a: Contribution, b: Contribution) =>
  Math.abs(b.weight) - Math.abs(a.weight) || (a.feature < b.feature ? -1 : 1)

/**
 * Finds the known devices that are probably the same machine as this visit, in ANOTHER browser. It never joins
 * anything: the visitor id stays per browser, and a link is only evidence (a person decides, D85).
 *
 * Three doors must all be open, and the first two are what keep two different people with the same model of computer
 * apart:
 * 1. The device was seen from the same address a short while ago, and not so many devices were that it says nothing.
 * 2. The device was seen only in other browsers. A device never seen in this browser family, or of unknown browser,
 *    is not a candidate: "another browser" has to be shown, not assumed.
 * 3. The features of the machine (screen, system time zone, graphics family, local voices...) alone add up to enough
 *    evidence, scored by the same model as the matcher, so a common value weighs little and a rare one a lot.
 *
 * @param seen the devices seen from the address in the window, with or without the visit's own device
 * @param profiles the profiles of those devices
 */
/**
 * The population without one device. A visit that was attached to a known device is that device: its values are the
 * values of this machine, and counting them again as "other devices that have them" would make every value of the
 * machine look common, and the same machine impossible to tell from the rest.
 */
export function withoutDevice(population: PopulationStats, own: DeviceProfile | undefined): PopulationStats {
  if (!own) {
    return population
  }
  return {
    devices: Math.max(0, population.devices - 1),
    devicesWithValue: (feature, value) =>
      Math.max(0, population.devicesWithValue(feature, value) - (own.features.get(feature)?.has(value) ? 1 : 0)),
    agreementProbability: (feature) => population.agreementProbability(feature),
  }
}

export function findSameMachine(input: {
  features: Features
  visitorId: string
  seen: ReadonlyArray<{ deviceId: string }>
  profiles: readonly DeviceProfile[]
  population: PopulationStats
  model: Model
  params: SameMachineParams
}): SameMachine | undefined {
  const { features, visitorId, params } = input
  const family = features.browserFamily
  if (!family) {
    return undefined
  }
  const others = new Set(input.seen.map((item) => item.deviceId).filter((id) => id !== visitorId))
  if (others.size === 0) {
    return undefined
  }
  if (others.size > params.maxDevicesPerIp) {
    return { links: [], skipped: 'shared_ip' }
  }
  const observation = machineOnly(features)
  const links = input.profiles
    .filter((profile) => others.has(profile.deviceId))
    .flatMap((profile) => {
      const browsers = [...(profile.features.get('browserFamily')?.keys() ?? [])].sort()
      if (browsers.length === 0 || browsers.includes(family)) {
        return []
      }
      const { logOdds, contributions } = scoreCandidate(
        observation,
        machineValues(profile),
        input.population,
        input.model,
      )
      const agree = contributions.filter((c) => c.outcome === 'agree').sort(rank)
      if (logOdds < params.minLogOdds || agree.length < params.minFeatures) {
        return []
      }
      return [
        {
          visitorId: profile.deviceId,
          logOdds,
          browsers,
          agree: agree.map((c) => c.feature),
          disagree: contributions
            .filter((c) => c.outcome === 'disagree')
            .sort(rank)
            .map((c) => c.feature),
        },
      ]
    })
    .sort((a, b) => b.logOdds - a.logOdds || (a.visitorId < b.visitorId ? -1 : 1))
    .slice(0, params.maxLinks)
  return links.length === 0 ? undefined : { links }
}

/** The best same-machine link, if it reaches the stronger bar and beats the second one by the ambiguity margin */
function strongestLink(sameMachine: SameMachine | undefined, params: SameMachineParams, ambiguityMargin: number) {
  if (!sameMachine || sameMachine.links.length === 0) {
    return undefined
  }
  const [best, second] = sameMachine.links
  if (best.logOdds < params.mergeMinLogOdds) {
    return undefined
  }
  return second !== undefined && best.logOdds - second.logOdds < ambiguityMargin ? undefined : best
}

/**
 * The device whose visitor id a NEW visit should take, when `merge` is on: the strongest link (see `strongestLink`).
 * `undefined` otherwise, and the visit keeps its own id.
 */
export function mergeTarget(
  sameMachine: SameMachine | undefined,
  params: SameMachineParams,
  ambiguityMargin: number,
): string | undefined {
  return params.merge ? strongestLink(sameMachine, params, ambiguityMargin)?.visitorId : undefined
}

/**
 * The other known device that a visit attached to a known device should be joined with, when `mergeExisting` is on. The
 * browsers of the two devices must not overlap: two devices that were both seen in the same browser family are two
 * people's browsers, and a machine has one of each.
 */
export function mergeExistingTarget(
  sameMachine: SameMachine | undefined,
  params: SameMachineParams,
  ambiguityMargin: number,
  ownBrowsers: ReadonlySet<string>,
): string | undefined {
  if (!params.mergeExisting) {
    return undefined
  }
  const link = strongestLink(sameMachine, params, ambiguityMargin)
  return link && !link.browsers.some((browser) => ownBrowsers.has(browser)) ? link.visitorId : undefined
}
