import type { Config } from '../config'
import type { Volatility } from '../identity/features'
import type { LinkKind } from '../person/store'
import type { IpStorage } from '../privacy/ip_policy'
import type { Rule } from '../risk/rules'
import type { Severity } from '../tamper/checks'
import { TenantDirectory } from '../tenants/directory'
import type { TenantStore } from '../tenants/store'
import { endpointProblems, normalizeEndpoints, WebhookEndpoint } from '../webhooks/endpoints'
import { isBlockedAddress } from '../webhooks/safe_http'

import { checkValue, suggestion } from './kinds'
import { parameterPrefixes, parameters, parametersByPath } from './parameters'

/** The settings that one tenant works with, after the layers are put together */
export interface Settings {
  nonce: { ttlSeconds: number; required: boolean; bindToClient: boolean }
  limits: {
    maxBodyBytes: number
    collectPerMinutePerIp: number
    collectPerMinutePerTenant: number
    noncePerMinutePerIp: number
    authFailuresPerMinutePerIp: number
    apiPerMinutePerTenant: number
  }
  api: {
    defaultPageSize: number
    maxPageSize: number
    allowDeletion: boolean
    allowIdentityEdits: boolean
    maxExportEvents: number
  }
  tenants: { refreshSeconds: number }
  environment: { enabled: boolean; disabledChecks: string[]; privateQuotaBytes: number }
  bots: { verify: boolean; dnsTimeoutMs: number; cacheSeconds: number; cacheEntries: number; maxConcurrent: number }
  quota: { collectsPerMonth: number; apiReadsPerMonth: number }
  sharedGraph: {
    participate: boolean
    windowDays: number
    flagDecisions: string[]
    excludeCountries: string[]
    minFeatures: number
  }
  retention: { eventsDays: number }
  privacy: { ipStorage: IpStorage; dropSignals: string[]; requireConsent: boolean; anonymityK: number }
  collection: { exclude: string[]; include: string[]; elevatedTags: string[]; elevatedInclude: string[] }
  drift: { jsThreshold: number; minSamples: number; maxEvents: number }
  audit: { enabled: boolean; retentionDays: number }
  identity: {
    enabled: boolean
    modelFile: string | null
    matchProbability: number | null
    possibleLinkProbability: number | null
    storedId: { enabled: boolean; bases: string[]; maxAgeDays: number }
    storedIdConflictThreshold: number
    sameMachine: {
      enabled: boolean
      windowMinutes: number
      maxDevicesPerIp: number
      minLogOdds: number
      minFeatures: number
      maxLinks: number
      merge: boolean
      mergeMinLogOdds: number
      mergeExisting: boolean
    }
    person: {
      enabled: boolean
      groupingKinds: LinkKind[]
      maxDevices: number
      networkWindowMinutes: number
      networkMaxDevicesPerIp: number
    }
    maxCandidates: number
    candidateMaxShare: number
    candidateMinDevices: number
    candidateRowsPerValue: number
    onAmbiguous: 'attach' | 'separate'
    ambiguityMargin: number
    explanationSize: number
    learnFromTampered: 'always' | 'not_high' | 'never_flagged'
    disabledFeatures: string[]
    featureM: Record<string, number>
    featureVolatility: Record<string, Volatility>
    defaultM: { stable: number | null; semi: number | null; volatile: number | null }
    maxWeight: number | null
    disagreementFloor: { stable: number | null; semi: number | null; volatile: number | null }
    scale: number | null
    offset: number | null
  }
  tamper: { enabled: boolean; disabledChecks: string[]; severity: Record<string, Severity>; clockSkewSeconds: number }
  risk: {
    enabled: boolean
    ipTagWeights: Record<string, number>
    tamperWeights: Record<Severity, number>
    timezoneMismatchWeight: number
    possibleLinkWeight: number
    sameMachineWeight: number
    multiAccountWeight: number
    multiAccountThreshold: number
    fakeCrawlerWeight: number
    environmentWeights: Record<string, number>
    storedIdConflictWeight: number
    graphFlaggedWeight: number
    newVisitorWeight: number
    levels: { medium: number; high: number }
    behavior: {
      syntheticEventsThreshold: number
      syntheticEventsWeight: number
      noInteractionMinObservedMs: number
      noInteractionWeight: number
    }
    velocity: {
      windowMinutes: number
      linkedIdsPerDevice: { threshold: number; weight: number }
      devicesPerIp: { threshold: number; weight: number }
      ipsPerDevice: { threshold: number; weight: number }
    }
  }
  rules: { list: Rule[]; defaultDecision: string }
  webhooks: {
    endpoints: WebhookEndpoint[]
    maxAttempts: number
    baseDelaySeconds: number
    maxDelaySeconds: number
    timeoutSeconds: number
    maxPendingPerTenant: number
    allowHttp: boolean
    allowPrivateNetworks: boolean
    keepDoneHours: number
    keepFailedDays: number
  }
}

type Flat = Array<[path: string, value: unknown]>

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clone = <T>(value: T): T => structuredClone(value)

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) {
    node[part] = isPlainObject(node[part]) ? node[part] : {}
    node = node[part] as Record<string, unknown>
  }
  node[parts[parts.length - 1]] = value
}

export function defaultSettings(): Settings {
  const settings: Record<string, unknown> = {}
  for (const parameter of parameters) {
    setPath(settings, parameter.path, clone(parameter.default))
  }
  return settings as unknown as Settings
}

const allNames = [...parametersByPath.keys(), ...parameterPrefixes]

/**
 * Checks a layer of settings (the `defaults` of the file or the `settings` of a tenant) and flattens it to
 * `[path, value]` pairs. Every problem is reported, not only the first, and an unknown name is refused with the
 * closest known one: a setting with a typo that is silently ignored is a setting that does not work.
 */
export function validateLayer(layer: unknown, where: string): { flat: Flat; problems: string[] } {
  const flat: Flat = []
  const problems: string[] = []
  if (layer === undefined) {
    return { flat, problems }
  }
  if (!isPlainObject(layer)) {
    return { flat, problems: [`${where} must be an object`] }
  }

  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      const parameter = parametersByPath.get(path)
      if (parameter) {
        const problem = value === null && parameter.nullable ? undefined : checkValue(parameter.kind, value)
        if (problem) {
          problems.push(`${where}: ${path} ${problem}`)
        } else {
          flat.push([path, value])
        }
      } else if (parameterPrefixes.has(path)) {
        if (isPlainObject(value)) {
          walk(value, path)
        } else {
          problems.push(`${where}: ${path} must be an object`)
        }
      } else {
        problems.push(`${where}: unknown setting "${path}"${suggestion(path, allNames)}`)
      }
    }
  }
  walk(layer, '')
  return { flat, problems }
}

/** Rules that involve more than one setting. They are checked on the final result of each tenant. */
export function crossCheck(settings: Settings, where: string): string[] {
  const problems: string[] = []
  const { matchProbability, possibleLinkProbability } = settings.identity
  if (matchProbability !== null && possibleLinkProbability !== null && possibleLinkProbability >= matchProbability) {
    problems.push(
      `${where}: identity.possibleLinkProbability (${possibleLinkProbability}) ` +
        `must be lower than identity.matchProbability (${matchProbability})`,
    )
  }
  const { webhooks } = settings
  if (webhooks.baseDelaySeconds > webhooks.maxDelaySeconds) {
    problems.push(
      `${where}: webhooks.baseDelaySeconds (${webhooks.baseDelaySeconds}) must not be larger than ` +
        `webhooks.maxDelaySeconds (${webhooks.maxDelaySeconds})`,
    )
  }
  problems.push(
    ...endpointProblems(
      webhooks.endpoints,
      { http: webhooks.allowHttp, privateNetworks: webhooks.allowPrivateNetworks },
      isBlockedAddress,
    ).map((problem) => `${where}: ${problem}`),
  )
  if (settings.api.defaultPageSize > settings.api.maxPageSize) {
    problems.push(
      `${where}: api.defaultPageSize (${settings.api.defaultPageSize}) must not be larger than ` +
        `api.maxPageSize (${settings.api.maxPageSize})`,
    )
  }
  if (settings.risk.levels.medium >= settings.risk.levels.high) {
    problems.push(
      `${where}: risk.levels.medium (${settings.risk.levels.medium}) must be lower than risk.levels.high ` +
        `(${settings.risk.levels.high})`,
    )
  }
  return problems
}

/** The layers, lowest first. Each one is validated; a layer that is `undefined` is skipped. */
export function resolveSettings(layers: Array<{ layer: unknown; where: string }>): {
  settings: Settings
  problems: string[]
} {
  const settings = defaultSettings() as unknown as Record<string, unknown>
  const problems: string[] = []
  for (const { layer, where } of layers) {
    const result = validateLayer(layer, where)
    problems.push(...result.problems)
    for (const [path, value] of result.flat) {
      setPath(settings, path, clone(value))
    }
  }
  const resolved = settings as unknown as Settings
  // The endpoints are checked as raw data above (by their parameter); from here on they have every field filled
  resolved.webhooks.endpoints = normalizeEndpoints(resolved.webhooks.endpoints)
  problems.push(...crossCheck(resolved, layers[layers.length - 1]?.where ?? 'settings'))
  return { settings: resolved, problems }
}

/**
 * The settings of each tenant, kept up to date with the configuration.
 * Layers, lowest first: the defaults of the code, the old top-level fields of the configuration file, the `defaults` of
 * the file, the `settings` of the tenant.
 */
export class SettingsRegistry {
  private readonly cache = new Map<string, Settings>()
  private current: Config
  /** Every tenant: the ones in the file and the ones made through the admin API */
  readonly tenants: TenantDirectory

  constructor(config: Config, private readonly store?: TenantStore) {
    this.current = config
    this.tenants = new TenantDirectory(() => this.current, store)
  }

  get config(): Config {
    return this.current
  }

  /** Reads the tenants of the store. Call it once before using the registry, if there is a store. */
  async load(): Promise<void> {
    await this.tenants.load()
    this.cache.clear()
  }

  /** Replaces the configuration. Throws, and keeps the old one, if the new one has a problem in its settings. */
  async reload(next: Config): Promise<void> {
    const probe = new SettingsRegistry(next, this.store)
    await probe.load()
    probe.global()
    for (const plan of Object.keys(next.plans)) {
      probe.forPlan(plan)
    }
    for (const tenant of probe.tenants.all()) {
      probe.for(tenant.id)
    }
    this.current = next
    this.tenants.refresh()
    this.cache.clear()
    await this.load()
  }

  /** Reads the tenants of the store again and forgets what was worked out for them. Call it after a tenant changed. */
  async reloadTenants(): Promise<void> {
    await this.load()
  }

  private build(tenantId: string | undefined, planName?: string): Settings {
    const config = this.current
    const tenant = tenantId === undefined ? undefined : this.tenants.find(tenantId)
    const plan = planName ?? tenant?.plan
    const { settings, problems } = resolveSettings([
      { layer: config.legacySettings, where: 'configuration' },
      { layer: config.defaults, where: 'defaults' },
      ...(plan !== undefined && Object.prototype.hasOwnProperty.call(config.plans, plan)
        ? [{ layer: config.plans[plan], where: `plan ${plan}` }]
        : []),
      ...(tenant ? [{ layer: tenant.settings, where: `tenant ${tenant.id}` }] : []),
    ])
    if (settings.sharedGraph.participate && !config.sharedGraph.enabled) {
      problems.push(
        `${
          tenant ? `tenant ${tenant.id}` : 'settings'
        }: sharedGraph.participate needs sharedGraph.enabled in the configuration`,
      )
    }
    if (problems.length > 0) {
      throw new Error(`Config: ${problems.join('; ')}`)
    }
    return settings
  }

  /** The settings of a tenant */
  for(tenantId: string): Settings {
    let settings = this.cache.get(tenantId)
    if (!settings) {
      settings = this.build(tenantId)
      this.cache.set(tenantId, settings)
    }
    return settings
  }

  /**
   * What is wrong with the settings of a tenant that does not exist yet (or is about to change), as the problems.
   * The layers are the same that a real tenant gets, so what passes here is accepted when the tenant is used.
   */
  problemsOfTenantSettings(tenantSettings: unknown, plan?: string): string[] {
    const config = this.current
    const result = resolveSettings([
      { layer: config.legacySettings, where: 'configuration' },
      { layer: config.defaults, where: 'defaults' },
      ...(plan !== undefined && Object.prototype.hasOwnProperty.call(config.plans, plan)
        ? [{ layer: config.plans[plan], where: `plan ${plan}` }]
        : []),
      { layer: tenantSettings, where: 'settings' },
    ])
    if (result.settings.sharedGraph.participate && !config.sharedGraph.enabled) {
      result.problems.push('settings: sharedGraph.participate needs sharedGraph.enabled in the configuration')
    }
    return result.problems
  }

  /** The settings of a plan, with no tenant of its own. Throws if the plan has a mistake. */
  forPlan(plan: string): Settings {
    return this.build(undefined, plan)
  }

  /** The settings that apply to the server as a whole, with no tenant */
  global(): Settings {
    let settings = this.cache.get('')
    if (!settings) {
      settings = this.build(undefined)
      this.cache.set('', settings)
    }
    return settings
  }
}
