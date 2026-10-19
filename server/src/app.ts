import { randomUUID } from 'node:crypto'

import { createAdminHandler } from './admin'
import type { MaybePromise } from './async'
import type { AuditAction, AuditLog } from './audit/log'
import { Config, sha256Hex, TenantConfig } from './config'
import { computeDrift } from './drift/drift'
import type { GraphStore } from './graph/store'
import { baseHeaders, bearerMatches, HttpError, readBody, reply, Res } from './http_util'
import type { IdentityEngine } from './identity/engine'
import { extractFeatures, featureInputOf, type Features } from './identity/features'
import type { Resolution } from './identity/store'
import { ModelCatalog } from './identity/tuning'
import { requestContext } from './ingest/context'
import { issueNonce, nonceFingerprint, verifyNonce } from './ingest/nonce'
import { Limiter, RateLimiter, SharedLimits } from './ingest/ratelimit'
import { CollectPayload, validatePayload } from './ingest/validate'
import type { Metrics } from './metrics'
import type { CrawlerVerifier } from './net/bots'
import { Cidr, normalizeIp, parseCidr } from './net/cidr'
import { IpIntelProvider } from './net/ip_intel'
import { extractNetworkSignals, NetworkSignals, Req, SignalContext } from './net/signals'
import type { TimezoneCountries } from './net/timezones'
import { ipHashKey, protectIp, protectNetwork } from './privacy/ip_policy'
import { assess, AssessDeps, graphKeyFor, summarizeVisit, tamperFor, VisitSummary } from './risk/assess'
import { Settings, SettingsRegistry } from './settings/settings'
import { StaticFile, calibrationCsp } from './static_files'
import { EventStore, StoredEvent } from './store/types'
import type { TenantStore } from './tenants/store'
import { ConnectionRegistry } from './tls/tls_front'
import { monthOf, nextMonthStart, UsageMeter, UsageMetric } from './usage/meter'
import { endpointWants } from './webhooks/endpoints'
import type { WebhookQueue } from './webhooks/queue'

/** The headers of a page that anybody may open: it must not be framed, leak the address, or ask for sensors */
const pageHeaders = {
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
}

export interface AppDeps {
  config: Config
  store: EventStore
  intel: IpIntelProvider
  registry: ConnectionRegistry
  now?: () => number
  newRequestId?: () => string
  /** The settings of each tenant. If absent, they are read from `config` once. */
  settings?: SettingsRegistry
  /** Decides which known device a visit belongs to. If absent, visits are stored without a visitor id. */
  identity?: IdentityEngine
  /** The counters of `/metrics`. Without it, nothing is counted and `/metrics` is off. */
  metrics?: Metrics
  /** Reports what the process knows about itself, for `/readyz`. Throw to say "not ready". */
  ready?: () => MaybePromise<void>
  /** Where the tenants of the admin API are kept. Without it, the admin API is off. */
  tenantStore?: TenantStore
  /** Where the use of each tenant is counted, for quotas and billing. Without it, nothing is counted or limited. */
  usage?: UsageMeter
  /** The shared graph between tenants. Used only if the configuration turns it on, and only by tenants who join. */
  graph?: GraphStore
  /** Where the record of accesses goes. Without it, nothing is recorded. */
  audit?: AuditLog
  /** Where the deliveries of webhooks wait to be sent. Without it, no webhook is sent. */
  webhooks?: WebhookQueue
  /** Rate limits counted in the database, for several instances. Used only if the configuration asks for it. */
  sharedLimits?: SharedLimits
  /** Tells a real search crawler from a copy of its name. Without it, nothing is looked up. */
  crawlers?: CrawlerVerifier
  /** Which countries use each time zone, for the risk factor that compares it with the country of the address */
  timezones?: TimezoneCountries
  /** The model of each tenant. If absent, every tenant uses the model of the engine, with its own settings over it. */
  models?: ModelCatalog
  /** Files served as they are, by exact path (the collection page). Nothing else is ever served from disk. */
  staticFiles?: Record<string, StaticFile>
  /** One structured line per request. It never receives the payload, the IP address or any key. */
  log?: (entry: Record<string, unknown>) => void
}

const encodeCursor = (event: { receivedAt: number; requestId: string }): string =>
  Buffer.from(JSON.stringify([event.receivedAt, event.requestId])).toString('base64url')

/** The position that a list stopped at. A cursor that was not made by `encodeCursor` is refused. */
function decodeCursor(text: string | null): { receivedAt: number; requestId: string } | undefined {
  if (text === null) {
    return undefined
  }
  try {
    const [receivedAt, requestId] = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown[]
    if (typeof receivedAt === 'number' && Number.isFinite(receivedAt) && typeof requestId === 'string') {
      return { receivedAt, requestId }
    }
  } catch {
    // falls through to the error
  }
  throw new HttpError(400, { error: 'invalid_parameter', parameter: 'after' })
}

/** What an authenticated request did, filled when the key is accepted and written to the audit log when it ends */
interface AuditContext {
  tenantId: string
  action: AuditAction
  subject: string
  keyId: string
  requester: string
}

interface RequestContext {
  cors: Record<string, string>
  audit?: AuditContext
}

/** The payload without the signals with these names */
function withoutSignals(payload: CollectPayload, names: readonly string[]): CollectPayload {
  if (names.length === 0) {
    return payload
  }
  const keep = (group: CollectPayload['components']) =>
    Object.fromEntries(Object.entries(group).filter(([name]) => !names.includes(name)))
  return { ...payload, components: keep(payload.components), extended: keep(payload.extended) }
}

export type { Res }

export function createApp(deps: AppDeps): (req: Req, res: Res) => void {
  const { config, store, intel, registry } = deps
  const settings = deps.settings ?? new SettingsRegistry(config)
  const models = deps.models ?? new ModelCatalog(deps.identity?.model)

  /**
   * Whether this visit may teach the engine. A visit that looks tampered with can plant a false identity (a spoofed
   * profile that later "matches" a real one), so the tenant chooses how much to trust it. With the tamper evidence
   * turned off there is nothing to judge by, and the visit learns.
   */
  const mayLearn = (event: StoredEvent, s: Settings): boolean => {
    const report = s.identity.learnFromTampered === 'always' ? null : tamperFor(event, s)
    if (report === null) {
      return true
    }
    return s.identity.learnFromTampered === 'not_high' ? report.counts.high === 0 : report.signals.length === 0
  }
  const now = deps.now ?? Date.now
  /** What the assessment needs. The graph is there only if the configuration turned it on. */
  const assessDeps = (): AssessDeps => {
    const graph = settings.config.sharedGraph
    return {
      identity: deps.identity,
      timezones: deps.timezones,
      graph:
        graph.enabled && deps.graph
          ? {
              store: deps.graph,
              secret: graph.secret,
              minTenants: graph.minTenants,
              retentionDays: graph.retentionDays,
            }
          : undefined,
    }
  }
  const admin = deps.tenantStore
    ? createAdminHandler({
        settings,
        tenantStore: deps.tenantStore,
        store: deps.store,
        identity: deps.identity,
        webhooks: deps.webhooks,
        usage: deps.usage,
        audit: deps.audit,
        graph: deps.graph,
        now,
        log: deps.log ?? (() => undefined),
        failedAttempt: (address) =>
          limit(limiterFor('authFailures', settings.global().limits.authFailuresPerMinutePerIp), address),
      })
    : undefined
  const newRequestId = deps.newRequestId ?? randomUUID
  const log = deps.log ?? (() => undefined)

  const trustedProxies = config.trustedProxies.map((text) => {
    const cidr = parseCidr(text)
    if (!cidr) {
      throw new Error(`Config: trustedProxies has an invalid range: ${text}`)
    }
    return cidr
  }) as Cidr[]
  const signalContext: SignalContext = { config, trustedProxies, intel, registry }

  const minute = 60_000
  // One limiter per tenant and kind, because each tenant has its own limits. A limiter is replaced, and its counts
  // start again, only when the limit changes (a reload of the configuration).
  const limiters = new Map<string, { perMinute: number; limiter: Limiter }>()

  function limiterFor(name: string, perMinute: number): Limiter {
    const current = limiters.get(name)
    if (current && current.perMinute === perMinute) {
      return current.limiter
    }
    // Counted in the database when the instances share it: the limit then holds however many there are
    const limiter =
      deps.sharedLimits && config.sharedLimits
        ? inFrontOfDatabase(name, perMinute)
        : new RateLimiter(perMinute, minute, now)
    limiters.set(name, { perMinute, limiter })
    return limiter
  }

  /**
   * The shared limit, with a generous limit of this process in front. A flood is turned away in memory, and the
   * database only counts what gets past: otherwise every request that is going to be refused would still cost a write
   * to the database, and the limit itself would be a way to load it. The local limit is ten times the real one, so it
   * never decides on its own what the shared one would not.
   */
  function inFrontOfDatabase(name: string, perMinute: number): Limiter {
    const shared = (deps.sharedLimits as SharedLimits).limiter(name, perMinute, minute, now)
    const local = new RateLimiter(perMinute * 10, minute, now)
    return {
      take: async (key) => {
        const wait = local.take(key)
        return wait > 0 ? wait : shared.take(key)
      },
    }
  }

  async function limit(limiter: Limiter, key: string): Promise<void> {
    const wait = await limiter.take(key)
    if (wait > 0) {
      throw new HttpError(429, { error: 'rate_limited' }, { 'Retry-After': String(wait) })
    }
  }

  /** The tenant of a browser request, with the CORS headers of an allowed origin */
  function browserTenant(req: Req, url: URL): { tenant: TenantConfig; cors: Record<string, string> } {
    const tenant = settings.tenants.byPublicKey(url.searchParams.get('k'))
    if (!tenant) {
      throw new HttpError(401, { error: 'unknown_key' })
    }
    if (tenant.status === 'suspended') {
      throw new HttpError(403, { error: 'tenant_suspended' })
    }
    const origin = req.headers.origin
    if (origin === undefined || tenant.allowedOrigins.length === 0) {
      return { tenant, cors: {} }
    }
    if (!tenant.allowedOrigins.includes(origin)) {
      throw new HttpError(403, { error: 'origin_not_allowed' })
    }
    return {
      tenant,
      cors: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' },
    }
  }

  async function handle(
    req: Req,
    res: Res,
    /** Filled as soon as the origin is known to be allowed, so that errors are readable by the page too */
    context: RequestContext,
  ): Promise<{ route: string; tenantId?: string; status: number }> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    // When the server is mounted under a path (a first-party proxy that keeps the prefix), the prefix is taken off here
    // and everything below sees the usual paths. Anything outside the prefix is not ours.
    const { basePath } = settings.config
    if (basePath) {
      if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) {
        url.pathname = url.pathname.slice(basePath.length) || '/'
      } else if (url.pathname !== '/healthz') {
        throw new HttpError(404, { error: 'not_found' })
      }
    }

    if (url.pathname === '/healthz') {
      reply(res, 200, { ok: true })
      return { route: 'healthz', status: 200 }
    }
    // Ready is more than alive: the storage answers and nothing else the server needs is stuck
    if (url.pathname === '/readyz') {
      try {
        await store.ping()
        await deps.ready?.()
      } catch (error) {
        log({ route: 'not_ready', error: error instanceof Error ? error.message : 'unknown' })
        reply(res, 503, { ready: false })
        return { route: 'readyz', status: 503 }
      }
      reply(res, 200, { ready: true })
      return { route: 'readyz', status: 200 }
    }

    const staticFile =
      deps.staticFiles && Object.prototype.hasOwnProperty.call(deps.staticFiles, url.pathname)
        ? deps.staticFiles[url.pathname]
        : undefined
    if (staticFile && (method === 'GET' || method === 'HEAD')) {
      if (staticFile.etag !== undefined && req.headers['if-none-match'] === staticFile.etag) {
        res.writeHead(304, { ETag: staticFile.etag, 'Cache-Control': staticFile.cache ?? 'no-store' })
        res.end()
        return { route: 'static', status: 304 }
      }
      res.writeHead(200, {
        ...baseHeaders,
        ...pageHeaders,
        ...(staticFile.cache ? { 'Cache-Control': staticFile.cache } : {}),
        ...(staticFile.etag ? { ETag: staticFile.etag } : {}),
        ...(staticFile.anyOrigin
          ? { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' }
          : {}),
        'Content-Type': staticFile.type,
        'Content-Security-Policy': staticFile.csp ?? calibrationCsp,
      })
      res.end(method === 'HEAD' ? undefined : staticFile.body)
      return { route: 'static', status: 200 }
    }

    const network = extractNetworkSignals(req, signalContext)
    if (!network) {
      throw new HttpError(400, { error: 'no_client_address' })
    }
    const key = network.ip

    if (url.pathname === '/metrics') {
      if (!deps.metrics || settings.config.metricsKeySha256.length === 0) {
        throw new HttpError(404, { error: 'not_found' })
      }
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      if (!bearerMatches(settings.config.metricsKeySha256, req)) {
        await limit(limiterFor('authFailures', settings.global().limits.authFailuresPerMinutePerIp), key)
        throw new HttpError(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
      }
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(await deps.metrics.render())
      return { route: 'metrics', status: 200 }
    }

    if (url.pathname.startsWith('/admin/v1/') || url.pathname === '/admin/v1') {
      if (settings.config.adminKeySha256.length === 0 || !admin) {
        throw new HttpError(404, { error: 'not_found' })
      }
      return admin(req, res, url, method, key)
    }

    if (url.pathname === '/v1/nonce' || url.pathname === '/v1/collect') {
      const { tenant, cors } = browserTenant(req, url)
      context.cors = cors
      const isNonce = url.pathname === '/v1/nonce'

      if (method === 'OPTIONS') {
        reply(res, 204, undefined, {
          ...cors,
          'Access-Control-Allow-Methods': isNonce ? 'GET' : 'POST',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '600',
        })
        return { route: 'preflight', tenantId: tenant.id, status: 204 }
      }

      if (isNonce) {
        if (method !== 'GET') {
          throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' })
        }
        const s = settings.for(tenant.id)
        await limit(limiterFor(`nonce|${tenant.id}`, s.limits.noncePerMinutePerIp), key)
        await count(tenant.id, 'nonces')
        const context = s.nonce.bindToClient ? requestContext(network) : undefined
        reply(
          res,
          200,
          {
            nonce: issueNonce(settings.config.nonceSecret, tenant.id, now(), s.nonce.ttlSeconds, context),
            ...collectionProfile(s, network),
          },
          cors,
        )
        return { route: 'nonce', tenantId: tenant.id, status: 200 }
      }

      if (method !== 'POST') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' })
      }
      return collect(req, res, tenant, cors, network)
    }

    if (url.pathname === '/v1/events') {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return listEvents(req, res, url, key, context)
    }

    if (url.pathname === '/v1/webhooks/deliveries') {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return webhookDeliveries(req, res, url, key, context)
    }
    const retryMatch = /^\/v1\/webhooks\/deliveries\/([A-Za-z0-9-]{1,64})\/retry$/.exec(url.pathname)
    if (retryMatch) {
      if (method !== 'POST') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'POST' })
      }
      return retryDelivery(req, res, retryMatch[1], key, context)
    }

    if (url.pathname === '/v1/drift' || url.pathname === '/v1/anonymity') {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return url.pathname === '/v1/drift'
        ? readDrift(req, res, url, key, context)
        : readAnonymity(req, res, url, key, context)
    }
    if (url.pathname === '/v1/usage') {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return readUsage(req, res, url, key, context)
    }
    if (url.pathname === '/v1/audit') {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return auditEntries(req, res, url, key, context)
    }
    if (url.pathname === '/v1/subjects/export') {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return exportSubject(req, res, url, key, context)
    }
    if (url.pathname === '/v1/subjects') {
      if (method !== 'DELETE') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'DELETE' })
      }
      return deleteSubject(req, res, url, key, context)
    }

    const editMatch = /^\/v1\/visitors\/([A-Za-z0-9_-]{1,64})\/(merge|split)$/.exec(url.pathname)
    if (editMatch) {
      if (method !== 'POST') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'POST' })
      }
      return editMatch[2] === 'merge'
        ? mergeVisitor(req, res, editMatch[1], key, context)
        : splitVisitor(req, res, editMatch[1], key, context)
    }

    const visitorMatch = /^\/v1\/visitors\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (visitorMatch) {
      if (method === 'DELETE') {
        return deleteVisitor(req, res, visitorMatch[1], key, context)
      }
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET, DELETE' })
      }
      return readVisitor(req, res, url, visitorMatch[1], key, context)
    }

    const eventMatch = /^\/v1\/events\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname)
    if (eventMatch) {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return readEvent(req, res, eventMatch[1], key, context)
    }

    throw new HttpError(404, { error: 'not_found' })
  }

  async function collect(
    req: Req,
    res: Res,
    tenant: TenantConfig,
    cors: Record<string, string>,
    network: NetworkSignals,
  ) {
    if (
      !String(req.headers['content-type'] ?? '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      throw new HttpError(415, { error: 'unsupported_media_type' })
    }
    const s = settings.for(tenant.id)
    await limit(limiterFor(`collectIp|${tenant.id}`, s.limits.collectPerMinutePerIp), network.ip)
    await limit(limiterFor(`collectTenant|${tenant.id}`, s.limits.collectPerMinutePerTenant), tenant.id)
    await enforceQuota(tenant.id, 'collects', s.quota.collectsPerMonth)

    const body = await readBody(req, s.limits.maxBodyBytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, { error: 'invalid_json' })
    }
    const validation = validatePayload(parsed)
    if (!validation.ok) {
      throw new HttpError(422, { error: 'invalid_payload', problems: validation.problems })
    }
    const { payload: received } = validation
    if (s.privacy.requireConsent && received.consent?.basis !== 'consent') {
      throw new HttpError(422, { error: 'consent_required' })
    }
    // What the tenant does not want is dropped before anything looks at it: the matcher, the checks and the storage
    // The stored code is a persistent identifier on the visitor's device: only a tenant that turned it on, and only
    // with a basis that the tenant accepts for it. A page that sends it anyway is ignored, not obeyed.
    const storedIdAllowed =
      s.identity.storedId.enabled && s.identity.storedId.bases.includes(received.consent?.basis ?? '')
    const payload = withoutSignals(
      received,
      storedIdAllowed ? s.privacy.dropSignals : [...s.privacy.dropSignals, 'storedId'],
    )

    let nonceContext: 'match' | 'mismatch' | 'none' = 'none'
    if (payload.nonce === undefined) {
      if (s.nonce.required) {
        throw new HttpError(400, { error: 'nonce_required' })
      }
    } else {
      const context = s.nonce.bindToClient ? requestContext(network) : undefined
      const check = verifyNonce(settings.config.nonceSecret, tenant.id, payload.nonce, now(), context)
      if (!check.ok) {
        throw new HttpError(400, { error: 'invalid_nonce', reason: check.reason })
      }
      if (!(await store.consumeNonce(nonceFingerprint(payload.nonce), check.expiresAt))) {
        throw new HttpError(400, { error: 'invalid_nonce', reason: 'used' })
      }
      nonceContext = check.context
    }

    // A visitor that says it is a search crawler is checked while the address is still whole: it may be stored hashed
    const crawler =
      deps.crawlers && s.bots.verify
        ? await deps.crawlers.check(network.headers.values['user-agent'], network.ip, {
            timeoutMs: s.bots.dnsTimeoutMs,
            cacheSeconds: s.bots.cacheSeconds,
          })
        : undefined

    const receivedAt = now()
    const event: StoredEvent = {
      requestId: newRequestId(),
      tenantId: tenant.id,
      receivedAt,
      // The address is worked on (limits, nonce) as it is, and kept in the form that the tenant chose
      network: protectNetwork(crawler ? { ...network, crawler } : network, s.privacy.ipStorage, ipKey(), tenant.id),
      payload,
      derived: { clockSkewMs: receivedAt - payload.collectedAt, nonceContext },
    }
    await store.insertEvent(event)
    await count(tenant.id, 'collects')
    deps.metrics?.inc('fp_collects_total')

    // A failure of the matcher must not lose the visit: the event is already stored and can be matched again later
    if (deps.identity && s.identity.enabled) {
      try {
        const features = extractFeatures(featureInputOf(event))
        for (const name of s.identity.disabledFeatures) {
          delete features[name]
        }
        const resolution = await deps.identity.resolve(tenant.id, event.requestId, features, receivedAt, {
          model: models.modelFor(s.identity),
          maxCandidates: s.identity.maxCandidates,
          candidateRule: {
            maxShare: s.identity.candidateMaxShare,
            minDevices: s.identity.candidateMinDevices,
            rowsPerValue: s.identity.candidateRowsPerValue,
          },
          onAmbiguous: s.identity.onAmbiguous,
          ambiguityMargin: s.identity.ambiguityMargin,
          storedIdConflictThreshold: s.identity.storedIdConflictThreshold,
          explanationSize: s.identity.explanationSize,
          possibleLinkProbability: s.identity.possibleLinkProbability,
          learn: mayLearn(event, s),
        })
        deps.metrics?.inc('fp_identity_resolutions_total', {
          result: !resolution.matched ? 'new' : resolution.ambiguous ? 'ambiguous' : 'matched',
        })
        await contributeToGraph(event, resolution, s)
        await enqueueWebhooks(event, resolution, s)
      } catch (error) {
        deps.metrics?.inc('fp_identity_failures_total')
        log({
          route: 'identity_failed',
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : 'unknown',
        })
      }
    }

    // The browser learns nothing but the id: the result stays on the server
    reply(res, 200, { requestId: event.requestId }, cors)
    return { route: 'collect', tenantId: tenant.id, status: 200 }
  }

  /** Counts a finished request. The route is one of a fixed set, so the labels cannot grow with what clients send. */
  function observe(route: string, status: number, ms: number): void {
    const m = deps.metrics
    if (!m) {
      return
    }
    m.inc('fp_http_requests_total', { route, status: `${Math.floor(status / 100)}xx` })
    m.observe('fp_http_request_duration_seconds', ms / 1000, { route })
    if (status >= 500) {
      m.inc('fp_errors_total')
    }
  }

  /** Counts one use. A failure to count never fails the request. */
  async function count(tenantId: string, metric: UsageMetric): Promise<void> {
    try {
      await deps.usage?.add(tenantId, metric, now())
    } catch (error) {
      log({ route: 'usage_failed', error: error instanceof Error ? error.message : 'unknown' })
    }
  }

  /** Refuses the request when the tenant has used its quota of the month for this metric */
  async function enforceQuota(tenantId: string, metric: 'collects' | 'apiReads', quota: number): Promise<void> {
    if (quota <= 0 || !deps.usage) {
      return
    }
    const at = now()
    if ((await deps.usage.month(tenantId, monthOf(at)))[metric] >= quota) {
      await count(tenantId, 'quotaRejected')
      deps.metrics?.inc('fp_quota_rejected_total', { metric })
      throw new HttpError(
        429,
        { error: 'quota_exceeded', metric },
        { 'Retry-After': String(Math.max(1, Math.ceil((nextMonthStart(at) - at) / 1000))) },
      )
    }
  }

  /**
   * What the server asks the page to collect, in the answer to the challenge. Only present if the tenant set something.
   * It is a request that the page applies with `profileToOptions`: a page that ignores it still works, and what the
   * server does not want stored is dropped by `privacy.dropSignals`, which this does not replace.
   */
  function collectionProfile(s: Settings, network: NetworkSignals): { profile?: Record<string, unknown> } {
    const { exclude, include, elevatedTags, elevatedInclude } = s.collection
    const elevated = elevatedTags.some((tag) => network.ipIntel.tags.includes(tag))
    const storedId = s.identity.storedId.enabled && s.identity.storedId.bases.length > 0
    const extra = [...(elevated ? elevatedInclude : []), ...(storedId ? ['storedId'] : [])]
    if (exclude.length === 0 && include.length === 0 && extra.length === 0) {
      return {}
    }
    return {
      profile: {
        exclude,
        include: [...new Set([...include, ...extra])],
        elevated,
        ...(storedId ? { storedIdMaxAgeDays: s.identity.storedId.maxAgeDays } : {}),
      },
    }
  }

  /** The key of the address hashes: the secret made for it, or one made from the secret of the nonces */
  const ipKey = (): Buffer => ipHashKey(settings.config.ipHashSecret ?? settings.config.nonceSecret)

  /** The tenant that owns the secret key in the request. Failed attempts are limited by address. */
  async function authenticate(
    req: Req,
    key: string,
    context: RequestContext,
    action: AuditAction,
    subject = '',
  ): Promise<TenantConfig> {
    const header = String(req.headers.authorization ?? '')
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const tenant = secret === '' ? undefined : settings.tenants.authenticate(secret)
    if (!tenant) {
      await limit(limiterFor('authFailures', settings.global().limits.authFailuresPerMinutePerIp), key)
      throw new HttpError(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    }
    if (action !== 'usage.read') {
      await enforceQuota(tenant.id, 'apiReads', settings.for(tenant.id).quota.apiReadsPerMonth)
      await count(tenant.id, 'apiReads')
    }
    context.audit = {
      tenantId: tenant.id,
      action,
      subject: subject.slice(0, 128),
      // Which key, by the start of its hash, and from where, by a keyed hash of the address: enough to tell accesses
      // apart without keeping either the key or the address
      keyId: sha256Hex(secret).slice(0, 8),
      requester: protectIp(key, 'hash', ipKey(), tenant.id) ?? '',
    }
    return tenant
  }

  /** Writes the entry of the request to the audit log, if the tenant keeps one. A failure never fails the request. */
  async function recordAudit(context: RequestContext, status: number): Promise<void> {
    const audit = context.audit
    if (!audit || !deps.audit || !settings.for(audit.tenantId).audit.enabled) {
      return
    }
    try {
      await deps.audit.record({ ...audit, at: now(), status })
    } catch (error) {
      log({ route: 'audit_failed', error: error instanceof Error ? error.message : 'unknown' })
    }
  }

  /** A visit as the list shows it */
  async function summaryOf(event: StoredEvent): Promise<VisitSummary> {
    const resolution = (await deps.identity?.getResolution(event.tenantId, event.requestId)) ?? null
    return summarizeVisit(
      event,
      resolution,
      await assess(assessDeps(), settings.for(event.tenantId), event, resolution),
    )
  }

  /** A time given as milliseconds since 1970 or as an ISO date */
  function parseTime(text: string | null, name: string): number | undefined {
    if (text === null) {
      return undefined
    }
    // The pattern comes first because `Date.parse` accepts many things that are not dates, such as "-1"
    const isDate = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)
    const value = /^\d{1,15}$/.test(text) ? Number(text) : isDate ? Date.parse(text) : NaN
    if (!Number.isFinite(value) || value < 0) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: name })
    }
    return value
  }

  function pageSize(text: string | null, s: Settings): number {
    if (text === null) {
      return s.api.defaultPageSize
    }
    if (!/^\d{1,6}$/.test(text) || Number(text) < 1) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'limit' })
    }
    return Math.min(Number(text), s.api.maxPageSize)
  }

  async function listEvents(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'events.list')
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    const query = url.searchParams

    const linkedId = query.get('linkedId') ?? undefined
    if (linkedId !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(linkedId)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'linkedId' })
    }
    const ipText = query.get('ip')
    const given = ipText === null ? undefined : normalizeIp(ipText)
    // The address is looked up in the form that is stored. With `none` nothing was stored, so there is nothing to find.
    const ip = given === undefined ? undefined : protectIp(given, s.privacy.ipStorage, ipKey(), tenant.id)
    if (ipText !== null && ip === undefined) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'ip' })
    }
    const order = query.get('order') ?? 'desc'
    if (order !== 'asc' && order !== 'desc') {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'order' })
    }
    const after = decodeCursor(query.get('after'))
    const limitSize = pageSize(query.get('limit'), s)

    const events = await store.listEvents(tenant.id, {
      since: parseTime(query.get('since'), 'since'),
      until: parseTime(query.get('until'), 'until'),
      after,
      limit: limitSize,
      linkedId,
      ip,
      newestFirst: order === 'desc',
    })
    const last = events[events.length - 1]
    reply(res, 200, {
      events: await Promise.all(events.map(summaryOf)),
      // A cursor only when the page is full: a shorter page was the end
      next: last && events.length === limitSize ? encodeCursor(last) : null,
    })
    return { route: 'events', tenantId: tenant.id, status: 200 }
  }

  async function readVisitor(req: Req, res: Res, url: URL, asked: string, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'visitor.read', asked)
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    // An id that was merged into another one means that other one
    const visitorId = (await deps.identity?.resolveAlias(tenant.id, asked)) ?? asked
    const profile = await deps.identity?.getProfile(tenant.id, visitorId)
    if (!deps.identity || !profile) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const size = pageSize(url.searchParams.get('limit'), s)
    const events: StoredEvent[] = []
    for (const requestId of await deps.identity.recentRequests(tenant.id, visitorId, size)) {
      const event = await store.getEvent(tenant.id, requestId)
      if (event) {
        events.push(event)
      }
    }
    reply(res, 200, {
      visitorId,
      ...(visitorId !== asked ? { mergedFrom: asked } : {}),
      firstSeen: profile.firstSeen,
      lastSeen: profile.lastSeen,
      visits: profile.visits,
      events: await Promise.all(events.map(summaryOf)),
    })
    return { route: 'visitor', tenantId: tenant.id, status: 200 }
  }

  /**
   * Tells the shared graph that the tenant saw this device, and whether it flagged the visit. Only a tenant that joined
   * does it, only with a key made from enough features, and what is written is the key, the tenant and two times.
   */
  async function contributeToGraph(event: StoredEvent, resolution: Resolution | null, s: Settings): Promise<void> {
    const key = graphKeyFor(assessDeps(), s, event)
    if (!deps.graph || key === undefined) {
      return
    }
    const decision = (await assess(assessDeps(), s, event, resolution)).decision
    const flagged = decision !== null && s.sharedGraph.flagDecisions.includes(decision.action)
    await deps.graph.record(key, event.tenantId, event.receivedAt, flagged)
  }

  /** Tells the endpoints of the tenant about a visit. A failure here is logged and never loses the visit. */
  async function enqueueWebhooks(event: StoredEvent, resolution: Resolution | null, s: Settings): Promise<void> {
    if (!deps.webhooks || s.webhooks.endpoints.length === 0) {
      return
    }
    const visit = summarizeVisit(event, resolution, await assess(assessDeps(), s, event, resolution))
    for (const endpoint of s.webhooks.endpoints) {
      if (!endpointWants(endpoint, visit)) {
        continue
      }
      const id = randomUUID()
      const body = JSON.stringify({ id, type: 'visit.completed', createdAt: now(), tenantId: event.tenantId, visit })
      const queued = await deps.webhooks.enqueue(
        { id, tenantId: event.tenantId, endpointId: endpoint.id, body, createdAt: now() },
        s.webhooks.maxPendingPerTenant,
      )
      if (!queued) {
        log({ route: 'webhook_queue_full', tenantId: event.tenantId, endpointId: endpoint.id })
      }
    }
  }

  async function webhookDeliveries(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'deliveries.list')
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    const status = url.searchParams.get('status') ?? undefined
    if (status !== undefined && status !== 'pending' && status !== 'done' && status !== 'failed') {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'status' })
    }
    const deliveries =
      (await deps.webhooks?.list(tenant.id, { status, limit: pageSize(url.searchParams.get('limit'), s) })) ?? []
    reply(res, 200, {
      // The body is left out: it can be read from the visit, and a list of bodies would be heavy
      deliveries: deliveries.map(({ body: _body, ...rest }) => rest),
    })
    return { route: 'webhook_deliveries', tenantId: tenant.id, status: 200 }
  }

  async function retryDelivery(req: Req, res: Res, id: string, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'delivery.retry', id)
    await limit(limiterFor(`api|${tenant.id}`, settings.for(tenant.id).limits.apiPerMinutePerTenant), tenant.id)
    if (!(await deps.webhooks?.retry(tenant.id, id, now()))) {
      throw new HttpError(404, { error: 'not_found' })
    }
    reply(res, 200, { retried: true })
    return { route: 'webhook_retry', tenantId: tenant.id, status: 200 }
  }

  async function auditEntries(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'audit.read')
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    if (!deps.audit) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const after = url.searchParams.get('after')
    if (after !== null && !/^\d{1,15}$/.test(after)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'after' })
    }
    const size = pageSize(url.searchParams.get('limit'), s)
    const entries = await deps.audit.list(tenant.id, {
      since: parseTime(url.searchParams.get('since'), 'since'),
      until: parseTime(url.searchParams.get('until'), 'until'),
      before: after === null ? undefined : Number(after),
      limit: size,
    })
    reply(res, 200, {
      entries: entries.map(({ seq: _seq, tenantId: _tenant, ...rest }) => rest),
      next: entries.length === size ? String(entries[entries.length - 1].seq) : null,
    })
    return { route: 'audit', tenantId: tenant.id, status: 200 }
  }

  /** Every request id of the events of a tenant that carry a linked id, however many they are */
  async function requestIdsOfLinkedId(tenantId: string, linkedId: string): Promise<string[]> {
    const ids: string[] = []
    let after: { receivedAt: number; requestId: string } | undefined
    for (;;) {
      const page = await store.listEvents(tenantId, { linkedId, limit: 1000, after })
      ids.push(...page.map((event) => event.requestId))
      if (page.length < 1000) {
        return ids
      }
      after = { receivedAt: page[page.length - 1].receivedAt, requestId: page[page.length - 1].requestId }
    }
  }

  function linkedIdParameter(url: URL): string {
    const linkedId = url.searchParams.get('linkedId')
    if (linkedId === null || !/^[A-Za-z0-9_.:-]{1,128}$/.test(linkedId)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'linkedId' })
    }
    return linkedId
  }

  /** Everything that is kept about the visits with a linked id, for the person it belongs to */
  async function exportSubject(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const linkedId = linkedIdParameter(url)
    const tenant = await authenticate(req, key, context, 'subject.export', linkedId)
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    const events = await store.listEvents(tenant.id, { linkedId, limit: s.api.maxExportEvents + 1 })
    const truncated = events.length > s.api.maxExportEvents
    const records = await Promise.all(
      events.slice(0, s.api.maxExportEvents).map(async (event) => ({
        ...event,
        identity: (await deps.identity?.getResolution(tenant.id, event.requestId)) ?? null,
      })),
    )
    reply(res, 200, {
      linkedId,
      truncated,
      visitors: [...new Set(records.flatMap((record) => (record.identity ? [record.identity.visitorId] : [])))],
      events: records,
    })
    return { route: 'subject_export', tenantId: tenant.id, status: 200 }
  }

  /** Deletes visits, the deliveries that tell about them, and the devices that no visit supports any more */
  async function erase(
    tenantId: string,
    requestIds: string[],
  ): Promise<{ deleted: number; deliveries: number; devices: number }> {
    // What the tenant gave to the shared graph for these visits goes too (the key is worked out again from the visit)
    if (deps.graph) {
      const s = settings.for(tenantId)
      const keys: string[] = []
      for (const id of requestIds) {
        const event = await store.getEvent(tenantId, id)
        const key =
          event && graphKeyFor(assessDeps(), { ...s, sharedGraph: { ...s.sharedGraph, participate: true } }, event)
        if (key) {
          keys.push(key)
        }
      }
      await deps.graph.deleteKeys(tenantId, [...new Set(keys)])
    }
    const deleted = await store.deleteEvents(tenantId, requestIds)
    const deliveries = (await deps.webhooks?.deleteForRequests(tenantId, requestIds)) ?? 0
    const devices = (await deps.identity?.removeOrphans()) ?? 0
    return { deleted, deliveries, devices }
  }

  async function deleteSubject(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const linkedId = linkedIdParameter(url)
    const tenant = await authenticate(req, key, context, 'subject.delete', linkedId)
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    if (!s.api.allowDeletion) {
      throw new HttpError(403, { error: 'deletion_disabled' })
    }
    reply(res, 200, await erase(tenant.id, await requestIdsOfLinkedId(tenant.id, linkedId)))
    return { route: 'subject_delete', tenantId: tenant.id, status: 200 }
  }

  /** Reads a small JSON object from the body of a request that changes who is who */
  async function readEditBody(req: Req, s: Settings): Promise<Record<string, unknown>> {
    if (
      !String(req.headers['content-type'] ?? '')
        .toLowerCase()
        .startsWith('application/json')
    ) {
      throw new HttpError(415, { error: 'unsupported_media_type' })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse((await readBody(req, Math.min(s.limits.maxBodyBytes, 65_536))).toString('utf8'))
    } catch (error) {
      if (error instanceof HttpError) {
        throw error
      }
      throw new HttpError(400, { error: 'invalid_json' })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, { error: 'invalid_json' })
    }
    return parsed as Record<string, unknown>
  }

  async function mergeVisitor(req: Req, res: Res, fromId: string, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'visitor.merge', fromId)
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    if (!s.api.allowIdentityEdits) {
      throw new HttpError(403, { error: 'identity_edits_disabled' })
    }
    const identity = deps.identity
    if (!identity) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const body = await readEditBody(req, s)
    const into = body.into
    if (typeof into !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(into)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'into' })
    }
    const result = await identity.merge(tenant.id, fromId, into)
    if (!result.ok) {
      throw new HttpError(result.reason === 'same_device' ? 409 : 404, { error: result.reason })
    }
    reply(res, 200, { visitorId: result.visitorId, mergedFrom: fromId, visits: result.visits })
    return { route: 'visitor_merge', tenantId: tenant.id, status: 200 }
  }

  async function splitVisitor(req: Req, res: Res, visitorId: string, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'visitor.split', visitorId)
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    if (!s.api.allowIdentityEdits) {
      throw new HttpError(403, { error: 'identity_edits_disabled' })
    }
    const identity = deps.identity
    if (!identity) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const body = await readEditBody(req, s)
    const ids = body.requestIds
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > s.api.maxPageSize ||
      !ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id))
    ) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'requestIds' })
    }
    // What each visit taught is worked out again from its event, as it was when it was decided
    const visits: Array<{ requestId: string; features: Features; at: number }> = []
    for (const requestId of new Set(ids as string[])) {
      const event = await store.getEvent(tenant.id, requestId)
      if (!event) {
        throw new HttpError(404, { error: 'event_not_found', requestId })
      }
      const features = extractFeatures(featureInputOf(event))
      for (const name of s.identity.disabledFeatures) {
        delete features[name]
      }
      visits.push({ requestId, features, at: event.receivedAt })
    }
    const result = await identity.split(tenant.id, visitorId, visits)
    if (!result.ok) {
      throw new HttpError(result.reason === 'unknown_device' ? 404 : 409, { error: result.reason })
    }
    reply(res, 200, { visitorId: result.visitorId, splitFrom: visitorId, moved: result.moved })
    return { route: 'visitor_split', tenantId: tenant.id, status: 200 }
  }

  async function deleteVisitor(req: Req, res: Res, asked: string, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'visitor.delete', asked)
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    if (!s.api.allowDeletion) {
      throw new HttpError(403, { error: 'deletion_disabled' })
    }
    const identity = deps.identity
    // An id that was merged into another one means that other one
    const visitorId = identity ? await identity.resolveAlias(tenant.id, asked) : asked
    if (!identity || !(await identity.getProfile(tenant.id, visitorId))) {
      throw new HttpError(404, { error: 'not_found' })
    }
    reply(res, 200, await erase(tenant.id, await identity.recentRequests(tenant.id, visitorId, 1_000_000)))
    return { route: 'visitor_delete', tenantId: tenant.id, status: 200 }
  }

  async function readDrift(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'drift.read')
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    const days = url.searchParams.get('windowDays') ?? '7'
    if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 90) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'windowDays' })
    }
    const span = Number(days) * 24 * 60 * 60 * 1000
    const end = now()
    const read = async (since: number, until: number) => {
      const events = await store.listEvents(tenant.id, {
        since,
        until,
        limit: s.drift.maxEvents + 1,
        newestFirst: true,
      })
      return { sampled: events.length > s.drift.maxEvents, events: events.slice(0, s.drift.maxEvents) }
    }
    const current = await read(end - span, end)
    const previous = await read(end - 2 * span, end - span)
    const featuresOf = (events: StoredEvent[]) => events.map((event) => extractFeatures(featureInputOf(event)))
    reply(res, 200, {
      windowDays: Number(days),
      current: { from: end - span, to: end, visits: current.events.length, sampled: current.sampled },
      previous: { from: end - 2 * span, to: end - span, visits: previous.events.length, sampled: previous.sampled },
      threshold: s.drift.jsThreshold,
      minSamples: s.drift.minSamples,
      features: computeDrift(featuresOf(previous.events), featuresOf(current.events), {
        threshold: s.drift.jsThreshold,
        minSamples: s.drift.minSamples,
      }),
    })
    return { route: 'drift', tenantId: tenant.id, status: 200 }
  }

  async function readAnonymity(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'anonymity.read')
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    const given = url.searchParams.get('k')
    if (given !== null && (!/^\d{1,4}$/.test(given) || Number(given) < 2 || Number(given) > 1000)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'k' })
    }
    const k = given === null ? s.privacy.anonymityK : Number(given)
    const features = ((await deps.identity?.anonymity(tenant.id, k)) ?? []).map((item) => ({
      ...item,
      shareBelowK: item.devices === 0 ? null : item.devicesBelowK / item.devices,
    }))
    reply(res, 200, {
      k,
      devices: deps.identity ? await deps.identity.deviceCount(tenant.id) : null,
      features: features.sort(
        (a, b) => (b.shareBelowK ?? -1) - (a.shareBelowK ?? -1) || (a.feature < b.feature ? -1 : 1),
      ),
    })
    return { route: 'anonymity', tenantId: tenant.id, status: 200 }
  }

  async function readUsage(req: Req, res: Res, url: URL, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'usage.read')
    const s = settings.for(tenant.id)
    await limit(limiterFor(`api|${tenant.id}`, s.limits.apiPerMinutePerTenant), tenant.id)
    const month = url.searchParams.get('month') ?? monthOf(now())
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'month' })
    }
    reply(res, 200, {
      month,
      totals: (await deps.usage?.month(tenant.id, month)) ?? null,
      days: (await deps.usage?.days(tenant.id, month)) ?? [],
      quotas: { collectsPerMonth: s.quota.collectsPerMonth, apiReadsPerMonth: s.quota.apiReadsPerMonth },
    })
    return { route: 'usage', tenantId: tenant.id, status: 200 }
  }

  async function readEvent(req: Req, res: Res, requestId: string, key: string, context: RequestContext) {
    const tenant = await authenticate(req, key, context, 'event.read', requestId)
    const event = await store.getEvent(tenant.id, requestId)
    if (!event) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const resolution = (await deps.identity?.getResolution(tenant.id, requestId)) ?? null
    reply(res, 200, {
      ...event,
      identity: resolution,
      // Worked out when read, from the stored visit, so that a better rule or setting also applies to old visits
      ...(await assess(assessDeps(), settings.for(tenant.id), event, resolution)),
    })
    return { route: 'event', tenantId: tenant.id, status: 200 }
  }

  return (req, res) => {
    const startedAt = now()
    const context: RequestContext = { cors: {} }
    handle(req, res, context)
      .then(async (outcome) => {
        await recordAudit(context, outcome.status)
        observe(outcome.route, outcome.status, now() - startedAt)
        log({ ...outcome, ms: now() - startedAt })
      })
      .catch(async (error: unknown) => {
        await recordAudit(context, error instanceof HttpError ? error.status : 500)
        observe('error', error instanceof HttpError ? error.status : 500, now() - startedAt)
        if (error instanceof HttpError) {
          if (!res.headersSent) {
            // Without the CORS headers, the browser hides the answer and the page only sees "Failed to fetch"
            reply(res, error.status, error.body, { ...context.cors, ...error.headers })
          }
          log({ route: 'error', status: error.status, error: error.body.error, ms: now() - startedAt })
          // After a refused oversized upload, stop reading what the client keeps sending
          if (error.status === 413) {
            res.once('finish', () => req.destroy())
          }
          return
        }
        log({
          route: 'error',
          status: 500,
          error: error instanceof Error ? error.message : 'unknown',
          ms: now() - startedAt,
        })
        if (!res.headersSent) {
          reply(res, 500, { error: 'internal' }, context.cors)
        } else {
          res.end()
        }
      })
  }
}
