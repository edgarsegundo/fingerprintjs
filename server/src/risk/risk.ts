import type { EnvironmentReport } from '../environment/checks'
import type { Activity, Resolution } from '../identity/store'
import { TimezoneCountries, zoneFitsCountry } from '../net/timezones'
import type { Settings } from '../settings/settings'
import type { StoredEvent } from '../store/types'
import type { TamperReport } from '../tamper/checks'

import type { Facts } from './rules'

export interface RiskFactor {
  /** What was found, as a stable word: `ip_tag:datacenter`, `tamper:automation_markers`, `velocity:linked_ids`... */
  id: string
  /** Points added to the score */
  weight: number
  detail: string
}

export interface RiskReport {
  /** 0 to 100: the sum of the weights, cut at 100 */
  score: number
  level: 'low' | 'medium' | 'high'
  factors: RiskFactor[]
  /** Always `true`. The weights are chosen by a person, not learned, and say nothing about the chance of fraud. */
  heuristic: true
  /** Always `false`. No weight has been checked against labelled cases, so the score is not a probability. */
  calibrated: false
}

/** Everything that the score and the rules are made from */
export interface RiskInputs {
  event: StoredEvent
  tamper: TamperReport | null
  /** What the visit says about the place it comes from. `undefined` when the tenant turned the checks off. */
  environment?: EnvironmentReport | null
  resolution: Resolution | null
  /** Visits of the same device in the window that ends at this visit. `undefined` when it could not be asked. */
  deviceActivity?: Activity
  /** Visits from the same address in the same window */
  ipActivity?: Activity
  timezones?: TimezoneCountries
  /** What other tenants saw, if this tenant takes part in the shared graph and enough tenants are behind the counts */
  graph?: { tenants: number | null; flaggedTenants: number | null }
}

function timezoneOf(event: StoredEvent): string | undefined {
  const signal = event.payload.components.timezone
  return signal && !signal.error && typeof signal.value === 'string' ? signal.value : undefined
}

export interface Behavior {
  observedMs: number
  /** Real interactions: moves, clicks, key presses, scrolls and touches */
  interactions: number
  syntheticEvents: number
}

const behaviorFields = ['pointerMoves', 'clicks', 'keyPresses', 'scrolls', 'touches'] as const

/** What the page counted about interaction, if it turned that signal on. Anything odd is taken as not reported. */
export function behaviorOf(event: StoredEvent): Behavior | undefined {
  const signal = event.payload.extended.behavior
  const value = signal && !signal.error ? (signal.value as Record<string, unknown> | null) : undefined
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const count = (field: string): number | undefined => {
    const n = value[field]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const observedMs = count('observedMs')
  const syntheticEvents = count('syntheticEvents')
  const parts = behaviorFields.map(count)
  if (observedMs === undefined || syntheticEvents === undefined || parts.some((part) => part === undefined)) {
    return undefined
  }
  return { observedMs, syntheticEvents, interactions: parts.reduce<number>((sum, part) => sum + (part ?? 0), 0) }
}

/** True or false when it can be said whether the browser time zone fits the country of the address, else `undefined` */
function zoneFits(inputs: RiskInputs): boolean | undefined {
  return inputs.timezones
    ? zoneFitsCountry(inputs.timezones, timezoneOf(inputs.event), inputs.event.network.ipIntel.country)
    : undefined
}

/**
 * Adds up the reasons to be careful with a visit. The reasons are all visible in `factors`, each with its weight, so
 * nobody has to trust a number they cannot take apart. The weights are the tenant's (`risk.*` settings).
 */
export function computeRisk(inputs: RiskInputs, settings: Settings['risk']): RiskReport {
  const factors: RiskFactor[] = []
  const add = (id: string, weight: number, detail: string) => {
    if (weight > 0) {
      factors.push({ id, weight, detail })
    }
  }

  for (const tag of inputs.event.network.ipIntel.tags) {
    add(
      `ip_tag:${tag}`,
      Object.prototype.hasOwnProperty.call(settings.ipTagWeights, tag) ? settings.ipTagWeights[tag] : 0,
      `The address is in the list "${tag}".`,
    )
  }
  for (const signal of inputs.tamper?.signals ?? []) {
    add(`tamper:${signal.id}`, settings.tamperWeights[signal.severity], signal.detail)
  }
  for (const signal of inputs.environment?.signals ?? []) {
    add(
      `environment:${signal.id}`,
      Object.prototype.hasOwnProperty.call(settings.environmentWeights, signal.id)
        ? settings.environmentWeights[signal.id]
        : 0,
      signal.detail,
    )
  }
  if (zoneFits(inputs) === false) {
    add(
      'timezone_country_mismatch',
      settings.timezoneMismatchWeight,
      `The time zone of the browser (${timezoneOf(inputs.event)}) is not one of ${
        inputs.event.network.ipIntel.country
      }.`,
    )
  }
  if (inputs.event.network.crawler?.verified === false) {
    add(
      'fake_crawler',
      settings.fakeCrawlerWeight,
      `The user agent says ${inputs.event.network.crawler.claimed}, and the address is not one of its own.`,
    )
  }
  if (inputs.resolution?.storedIdConflict) {
    add(
      'stored_id_conflict',
      settings.storedIdConflictWeight,
      'The visit brought the stored code of a known device, but the device does not look like it.',
    )
  }
  if (inputs.resolution?.possibleLink) {
    add(
      'possible_link',
      settings.possibleLinkWeight,
      'The visit looks like a known device but not enough to be attached to it.',
    )
  }
  if (inputs.graph?.flaggedTenants) {
    add(
      'graph:flagged_elsewhere',
      settings.graphFlaggedWeight,
      `${inputs.graph.flaggedTenants} other tenants flagged this device as abusive in the window.`,
    )
  }
  if (inputs.resolution && !inputs.resolution.matched) {
    add('new_visitor', settings.newVisitorWeight, 'The device had not been seen before.')
  }

  const behavior = behaviorOf(inputs.event)
  if (behavior) {
    if (behavior.syntheticEvents >= settings.behavior.syntheticEventsThreshold) {
      add(
        'behavior:synthetic_events',
        settings.behavior.syntheticEventsWeight,
        `The page received ${behavior.syntheticEvents} interaction events made by a script.`,
      )
    }
    if (behavior.interactions === 0 && behavior.observedMs >= settings.behavior.noInteractionMinObservedMs) {
      add(
        'behavior:no_interaction',
        settings.behavior.noInteractionWeight,
        `No real interaction in ${Math.round(behavior.observedMs / 1000)} seconds of observation.`,
      )
    }
  }

  const { velocity } = settings
  const velocityFactor = (
    id: string,
    count: number | undefined,
    rule: { threshold: number; weight: number },
    detail: string,
  ) => {
    if (count !== undefined && count >= rule.threshold) {
      add(id, rule.weight, `${detail} (${count}, from ${rule.threshold}).`)
    }
  }
  velocityFactor(
    'velocity:linked_ids_per_device',
    inputs.deviceActivity?.linkedIds,
    velocity.linkedIdsPerDevice,
    `This device was used with many different linked ids in ${velocity.windowMinutes} minutes`,
  )
  velocityFactor(
    'velocity:devices_per_ip',
    inputs.ipActivity?.devices,
    velocity.devicesPerIp,
    `Many different devices came from this address in ${velocity.windowMinutes} minutes`,
  )
  velocityFactor(
    'velocity:ips_per_device',
    inputs.deviceActivity?.ips,
    velocity.ipsPerDevice,
    `This device used many different addresses in ${velocity.windowMinutes} minutes`,
  )

  const score = Math.min(100, Math.round(factors.reduce((sum, factor) => sum + factor.weight, 0) * 100) / 100)
  return {
    score,
    level: score >= settings.levels.high ? 'high' : score >= settings.levels.medium ? 'medium' : 'low',
    factors,
    heuristic: true,
    calibrated: false,
  }
}

/** The facts that rules can read. What cannot be known is left out, not guessed. */
export function buildFacts(inputs: RiskInputs, risk: RiskReport | null): Facts {
  const { event, resolution, tamper } = inputs
  const facts: Facts = {
    'ip.tags': event.network.ipIntel.tags,
    'ip.version': event.network.ipVersion,
    'event.viaProxy': event.network.viaProxy,
  }
  if (event.network.ipIntel.country) {
    facts['ip.country'] = event.network.ipIntel.country
  }
  if (event.network.crawler) {
    facts['crawler.claimed'] = event.network.crawler.claimed
    // Left out when it could not be checked: an unknown fact makes every comparison false
    if (event.network.crawler.verified !== null) {
      facts['crawler.verified'] = event.network.crawler.verified
    }
  }
  if (event.payload.linkedId !== undefined) {
    facts['event.linkedId'] = event.payload.linkedId
  }
  const behavior = behaviorOf(event)
  if (behavior) {
    facts['behavior.observedMs'] = behavior.observedMs
    facts['behavior.interactions'] = behavior.interactions
    facts['behavior.syntheticEvents'] = behavior.syntheticEvents
  }
  if (risk) {
    facts['risk.score'] = risk.score
    facts['risk.level'] = risk.level
    facts['risk.factors'] = risk.factors.map((factor) => factor.id)
  }
  if (inputs.environment) {
    facts['environment.signals'] = inputs.environment.signals.map((signal) => signal.id)
  }
  if (tamper) {
    facts['tamper.high'] = tamper.counts.high
    facts['tamper.medium'] = tamper.counts.medium
    facts['tamper.low'] = tamper.counts.low
    facts['tamper.signals'] = tamper.signals.map((signal) => signal.id)
  }
  if (resolution) {
    facts['identity.visitorId'] = resolution.visitorId
    facts['identity.matched'] = resolution.matched
    facts['identity.new'] = !resolution.matched
    facts['identity.ambiguous'] = resolution.ambiguous
    facts['identity.possibleLink'] = resolution.possibleLink !== undefined
    facts['identity.storedIdConflict'] = resolution.storedIdConflict === true
    facts['identity.learned'] = resolution.learned
    if (resolution.probability !== null) {
      facts['identity.probability'] = resolution.probability
    }
  }
  if (inputs.graph?.tenants !== undefined && inputs.graph.tenants !== null) {
    facts['graph.tenants'] = inputs.graph.tenants
  }
  if (inputs.graph?.flaggedTenants !== undefined && inputs.graph.flaggedTenants !== null) {
    facts['graph.flaggedTenants'] = inputs.graph.flaggedTenants
  }
  if (inputs.deviceActivity) {
    facts['velocity.linkedIdsPerDevice'] = inputs.deviceActivity.linkedIds
    facts['velocity.ipsPerDevice'] = inputs.deviceActivity.ips
  }
  if (inputs.ipActivity) {
    facts['velocity.devicesPerIp'] = inputs.ipActivity.devices
  }
  return facts
}
