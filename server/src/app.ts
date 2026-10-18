import { randomUUID } from 'node:crypto'

import { authenticateSecret, Config, findTenantByPublicKey, TenantConfig } from './config'
import type { IdentityEngine } from './identity/engine'
import { featureInputOf, extractFeatures } from './identity/features'
import { requestContext } from './ingest/context'
import { issueNonce, nonceFingerprint, verifyNonce } from './ingest/nonce'
import { RateLimiter } from './ingest/ratelimit'
import { validatePayload } from './ingest/validate'
import { Cidr, parseCidr } from './net/cidr'
import { IpIntelProvider } from './net/ip_intel'
import { extractNetworkSignals, NetworkSignals, Req, SignalContext } from './net/signals'
import { StaticFile, calibrationCsp } from './static_files'
import { EventStore, StoredEvent } from './store/types'
import { checkTamper } from './tamper/checks'
import { ConnectionRegistry } from './tls/tls_front'

/**
 * The parts of a response that are used.
 * Both `http.ServerResponse` and the HTTP/2 compatibility response have them.
 */
export interface Res {
  readonly headersSent: boolean
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string | Buffer): unknown
  once(event: 'finish', listener: () => void): unknown
}

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
  /** Decides which known device a visit belongs to. If absent, visits are stored without a visitor id. */
  identity?: IdentityEngine
  /** Files served as they are, by exact path (the collection page). Nothing else is ever served from disk. */
  staticFiles?: Record<string, StaticFile>
  /** One structured line per request. It never receives the payload, the IP address or any key. */
  log?: (entry: Record<string, unknown>) => void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(String(body.error))
  }
}

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function reply(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    ...baseHeaders,
    ...(text === '' ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  })
  res.end(text)
}

/** Reads the body up to the limit. A body over the limit is dropped and not stored. */
function readBody(req: Req, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, { error: 'payload_too_large' }))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      if (exceeded) {
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        exceeded = true
        chunks.length = 0
        reject(new HttpError(413, { error: 'payload_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', reject)
  })
}

export function createApp(deps: AppDeps): (req: Req, res: Res) => void {
  const { config, store, intel, registry } = deps
  const now = deps.now ?? Date.now
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
  const collectPerIp = new RateLimiter(config.rateLimit.collectPerMinutePerIp, minute, now)
  const collectPerTenant = new RateLimiter(config.rateLimit.collectPerMinutePerTenant, minute, now)
  const noncePerIp = new RateLimiter(config.rateLimit.noncePerMinutePerIp, minute, now)
  // Wrong secret keys are limited hard: it is the only thing that stops guessing a key
  const authFailuresPerIp = new RateLimiter(10, minute, now)

  function limit(limiter: RateLimiter, key: string): void {
    const wait = limiter.take(key)
    if (wait > 0) {
      throw new HttpError(429, { error: 'rate_limited' }, { 'Retry-After': String(wait) })
    }
  }

  /** The tenant of a browser request, with the CORS headers of an allowed origin */
  function browserTenant(req: Req, url: URL): { tenant: TenantConfig; cors: Record<string, string> } {
    const tenant = findTenantByPublicKey(config, url.searchParams.get('k'))
    if (!tenant) {
      throw new HttpError(401, { error: 'unknown_key' })
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
    context: { cors: Record<string, string> },
  ): Promise<{ route: string; tenantId?: string; status: number }> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    if (url.pathname === '/healthz') {
      reply(res, 200, { ok: true })
      return { route: 'healthz', status: 200 }
    }

    const staticFile =
      deps.staticFiles && Object.prototype.hasOwnProperty.call(deps.staticFiles, url.pathname)
        ? deps.staticFiles[url.pathname]
        : undefined
    if (staticFile && (method === 'GET' || method === 'HEAD')) {
      res.writeHead(200, {
        ...baseHeaders,
        ...pageHeaders,
        'Content-Type': staticFile.type,
        'Content-Security-Policy': calibrationCsp,
      })
      res.end(method === 'HEAD' ? undefined : staticFile.body)
      return { route: 'static', status: 200 }
    }

    const network = extractNetworkSignals(req, signalContext)
    if (!network) {
      throw new HttpError(400, { error: 'no_client_address' })
    }
    const key = network.ip

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
        limit(noncePerIp, key)
        reply(
          res,
          200,
          { nonce: issueNonce(config.nonceSecret, tenant.id, now(), config.nonceTtlSeconds, requestContext(network)) },
          cors,
        )
        return { route: 'nonce', tenantId: tenant.id, status: 200 }
      }

      if (method !== 'POST') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' })
      }
      return collect(req, res, tenant, cors, network)
    }

    const eventMatch = /^\/v1\/events\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname)
    if (eventMatch) {
      if (method !== 'GET') {
        throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      }
      return readEvent(req, res, eventMatch[1], key)
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
    limit(collectPerIp, network.ip)
    limit(collectPerTenant, tenant.id)

    const body = await readBody(req, config.maxBodyBytes)
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
    const { payload } = validation

    let nonceContext: 'match' | 'mismatch' | 'none' = 'none'
    if (payload.nonce === undefined) {
      if (config.requireNonce) {
        throw new HttpError(400, { error: 'nonce_required' })
      }
    } else {
      const check = verifyNonce(config.nonceSecret, tenant.id, payload.nonce, now(), requestContext(network))
      if (!check.ok) {
        throw new HttpError(400, { error: 'invalid_nonce', reason: check.reason })
      }
      if (!store.consumeNonce(nonceFingerprint(payload.nonce), check.expiresAt)) {
        throw new HttpError(400, { error: 'invalid_nonce', reason: 'used' })
      }
      nonceContext = check.context
    }

    const receivedAt = now()
    const event: StoredEvent = {
      requestId: newRequestId(),
      tenantId: tenant.id,
      receivedAt,
      network,
      payload,
      derived: { clockSkewMs: receivedAt - payload.collectedAt, nonceContext },
    }
    store.insertEvent(event)

    // A failure of the matcher must not lose the visit: the event is already stored and can be matched again later
    if (deps.identity) {
      try {
        deps.identity.resolve(tenant.id, event.requestId, extractFeatures(featureInputOf(event)), receivedAt)
      } catch (error) {
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

  function readEvent(req: Req, res: Res, requestId: string, key: string) {
    const header = String(req.headers.authorization ?? '')
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const tenant = secret === '' ? undefined : authenticateSecret(config, secret)
    if (!tenant) {
      limit(authFailuresPerIp, key)
      throw new HttpError(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    }
    const event = store.getEvent(tenant.id, requestId)
    if (!event) {
      throw new HttpError(404, { error: 'not_found' })
    }
    reply(res, 200, {
      ...event,
      identity: deps.identity?.getResolution(tenant.id, requestId) ?? null,
      // Worked out when read, from the stored visit, so that a better rule also applies to old visits
      tamper: checkTamper(event),
    })
    return { route: 'event', tenantId: tenant.id, status: 200 }
  }

  return (req, res) => {
    const startedAt = now()
    const context = { cors: {} as Record<string, string> }
    handle(req, res, context)
      .then((outcome) => log({ ...outcome, ms: now() - startedAt }))
      .catch((error: unknown) => {
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
