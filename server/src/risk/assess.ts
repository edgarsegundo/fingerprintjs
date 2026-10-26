import { checkEnvironment, EnvironmentReport } from '../environment/checks'
import { graphKeyOf } from '../graph/key'
import type { GraphStore } from '../graph/store'
import type { IdentityEngine } from '../identity/engine'
import { extractFeatures, featureInputOf } from '../identity/features'
import type { Activity, Resolution } from '../identity/store'
import type { TimezoneCountries } from '../net/timezones'
import type { PersonView } from '../person/cluster'
import type { PersonStore } from '../person/store'
import { personView } from '../person/view'
import type { Settings } from '../settings/settings'
import type { StoredEvent } from '../store/types'
import { checkTamper, TamperReport } from '../tamper/checks'

import { buildFacts, computeRisk, RiskReport } from './risk'
import { Decision, evaluateRules } from './rules'

export interface AssessDeps {
  identity?: IdentityEngine
  timezones?: TimezoneCountries
  /** The shared graph, when it is turned on in the configuration */
  graph?: { store: GraphStore; secret: string; minTenants: number; retentionDays: number }
  /** The ties between devices. Without them there is no person. */
  person?: PersonStore
}

/** What the server concludes about a stored visit. Each part is `null` when the tenant turned it off. */
export interface Assessment {
  tamper: TamperReport | null
  /** Facts about the place the visit comes from. Not tampering: see `environment/checks.ts`. */
  environment: EnvironmentReport | null
  risk: RiskReport | null
  decision: Decision | null
  /** What other tenants saw. `null` unless this tenant takes part. A count is `null` if too few are behind it. */
  graph: { tenants: number | null; flaggedTenants: number | null } | null
  /** The devices tied to this one. `null` when the tenant turned the person layer off. */
  person: PersonView | null
}

/** A visit in a list: enough to scan many of them, without the whole payload */
export interface VisitSummary {
  requestId: string
  receivedAt: number
  linkedId: string | null
  ip: string
  country: string | null
  visitorId: string | null
  matched: boolean | null
  risk: { score: number; level: string } | null
  decision: string | null
  tamper: { high: number; medium: number; low: number } | null
}

export function summarizeVisit(
  event: StoredEvent,
  resolution: Resolution | null,
  assessment: Assessment,
): VisitSummary {
  return {
    requestId: event.requestId,
    receivedAt: event.receivedAt,
    linkedId: event.payload.linkedId ?? null,
    ip: event.network.ip,
    country: event.network.ipIntel.country ?? null,
    visitorId: resolution?.visitorId ?? null,
    matched: resolution?.matched ?? null,
    risk: assessment.risk ? { score: assessment.risk.score, level: assessment.risk.level } : null,
    decision: assessment.decision?.action ?? null,
    tamper: assessment.tamper?.counts ?? null,
  }
}

const minute = 60 * 1000

/** The key of the visit in the shared graph, or `undefined` if the tenant stays out or the visit has too little */
export function graphKeyFor(deps: AssessDeps, settings: Settings, event: StoredEvent): string | undefined {
  if (!deps.graph || !settings.sharedGraph.participate) {
    return undefined
  }
  const country = event.network.ipIntel.country
  if (country !== undefined && settings.sharedGraph.excludeCountries.includes(country)) {
    return undefined
  }
  return graphKeyOf(extractFeatures(featureInputOf(event)), deps.graph.secret, settings.sharedGraph.minFeatures)
}

/**
 * What the other tenants saw of this device. A count is shown only if at least `minTenants` tenants are behind it, so
 * that no number ever points to one other tenant. Below that it is `null`, which means "not enough to say".
 */
async function graphView(
  deps: AssessDeps,
  settings: Settings,
  event: StoredEvent,
): Promise<{ tenants: number | null; flaggedTenants: number | null } | undefined> {
  const key = graphKeyFor(deps, settings, event)
  if (!deps.graph || key === undefined) {
    return undefined
  }
  try {
    const windowDays = Math.min(settings.sharedGraph.windowDays, deps.graph.retentionDays)
    const seen = await deps.graph.store.summary(key, event.tenantId, event.receivedAt - windowDays * 24 * 60 * minute)
    const minTenants = deps.graph.minTenants
    const enough = (count: number) => (count >= minTenants ? count : null)
    return { tenants: enough(seen.tenants), flaggedTenants: enough(seen.flaggedTenants) }
  } catch {
    return undefined // extra evidence: reading the visit must not fail because of it
  }
}

/** The person that the device of the visit belongs to, or `null` if the layer is off for the tenant or unreadable */
async function personFor(
  deps: AssessDeps,
  settings: Settings,
  tenantId: string,
  resolution: Resolution | null,
): Promise<PersonView | null> {
  if (!deps.person || !deps.identity || !resolution || !settings.identity.person.enabled) {
    return null
  }
  try {
    return await personView(
      { person: deps.person, identity: deps.identity },
      tenantId,
      resolution.visitorId,
      settings.identity.person,
    )
  } catch {
    return null // extra evidence: reading the visit must not fail because of it
  }
}

/** The evidence of tampering with the tenant's settings applied, or `null` if the tenant turned it off */
export function tamperFor(event: StoredEvent, settings: Settings): TamperReport | null {
  return settings.tamper.enabled
    ? checkTamper(event, {
        disabledChecks: settings.tamper.disabledChecks,
        severity: settings.tamper.severity,
        clockSkewSeconds: settings.tamper.clockSkewSeconds,
      })
    : null
}

/**
 * Works out the evidence, the risk and the decision for a stored visit. It is a function of the visit, what the store
 * knows now and the settings, so a changed setting also applies to old visits when they are read again.
 */
export async function assess(
  deps: AssessDeps,
  settings: Settings,
  event: StoredEvent,
  resolution: Resolution | null,
): Promise<Assessment> {
  const tamper = tamperFor(event, settings)
  const environment = settings.environment.enabled
    ? checkEnvironment(event, {
        disabledChecks: settings.environment.disabledChecks,
        privateQuotaBytes: settings.environment.privateQuotaBytes,
      })
    : null
  const wantsRules = settings.rules.list.length > 0
  let deviceActivity: Activity | undefined
  let ipActivity: Activity | undefined
  if (deps.identity && (settings.risk.enabled || wantsRules)) {
    const window = { since: event.receivedAt - settings.risk.velocity.windowMinutes * minute, until: event.receivedAt }
    try {
      ipActivity = await deps.identity.activity(event.tenantId, { ip: event.network.ip, ...window })
      if (resolution) {
        deviceActivity = await deps.identity.activity(event.tenantId, { deviceId: resolution.visitorId, ...window })
      }
    } catch {
      // The counts are extra evidence. Reading the visit must not fail because they could not be made, and a rule
      // that needs a count that is not known is false (see `rules.ts`).
      ipActivity = undefined
      deviceActivity = undefined
    }
  }
  const graph = await graphView(deps, settings, event)
  const person = await personFor(deps, settings, event.tenantId, resolution)
  const inputs = {
    event,
    tamper,
    environment,
    resolution,
    deviceActivity,
    ipActivity,
    timezones: deps.timezones,
    graph,
    person: person ?? undefined,
  }
  const risk = settings.risk.enabled ? computeRisk(inputs, settings.risk) : null
  const decision = evaluateRules(settings.rules.list, buildFacts(inputs, risk), settings.rules.defaultDecision)
  return { tamper, environment, risk, decision, graph: graph ?? null, person }
}
