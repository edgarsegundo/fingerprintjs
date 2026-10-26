import { createHmac } from 'node:crypto'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'

import { HttpError, readBody, reply } from '../http_util'
import { RateLimiter } from '../ingest/ratelimit'
import type { AsnTable } from '../net/asn'
import { Cidr, ipPrefix } from '../net/cidr'
import { resolveClientIp } from '../net/client_ip'

import { browserHint, parseReport } from './report'
import type { ReportStore } from './store'

export interface ReceiverOptions {
  store: ReportStore
  /** Key of the hash that tells networks apart without keeping their address */
  secret: Buffer
  /** Where reports are posted. Default `/report`. */
  path?: string
  /**
   * The `Origin` that a report must carry, such as `https://app.empregoaqui.com.br`. Empty means any. It stops casual
   * abuse from other web pages, nothing more: anyone can write a header.
   */
  allowedOrigins?: readonly string[]
  /** Proxies whose `X-Forwarded-For` is believed (the nginx in front). Without them the connection address is used. */
  trustedProxies?: readonly Cidr[]
  asn?: AsnTable
  /** Reports a minute from one address (one /64 for IPv6) */
  ratePerIp?: number
  /** Reports a minute in all */
  rateTotal?: number
  maxBodyBytes?: number
  now?: () => number
}

export const receiverDefaults = {
  path: '/report',
  ratePerIp: 30,
  rateTotal: 600,
  maxBodyBytes: 4096,
} as const

/** The key of the per-address limit: an IPv6 device rotates the last 64 bits, so the /64 is its identity */
function rateKey(ip: string): string {
  return ip.includes(':') ? ipPrefix(ip) ?? ip : ip
}

export function prefixHash(secret: Buffer, ip: string): string | undefined {
  const prefix = ipPrefix(ip)
  return prefix === undefined ? undefined : createHmac('sha256', secret).update(prefix).digest('hex').slice(0, 16)
}

/**
 * The endpoint that the loader of the page posts to when the collector could not do its job. It is public, called
 * by browsers, and has no key, so it is built to cost little and to keep little: a small body, a closed shape, two
 * rate limits, and no address in anything it stores or says.
 */
export function createReceiver(options: ReceiverOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const path = options.path ?? receiverDefaults.path
  const maxBodyBytes = options.maxBodyBytes ?? receiverDefaults.maxBodyBytes
  const now = options.now ?? Date.now
  const origins = new Set(options.allowedOrigins ?? [])
  const trusted = options.trustedProxies ?? []
  const perIp = new RateLimiter(options.ratePerIp ?? receiverDefaults.ratePerIp, 60_000, now)
  const total = new RateLimiter(options.rateTotal ?? receiverDefaults.rateTotal, 60_000, now)

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '').split('?')[0]
    if (url === '/healthz' && req.method === 'GET') {
      return reply(res, 200, { ok: true })
    }
    if (url !== path) {
      throw new HttpError(404, { error: 'not_found' })
    }
    if (req.method !== 'POST') {
      throw new HttpError(405, { error: 'method_not_allowed' }, { Allow: 'POST' })
    }
    if (origins.size > 0 && !origins.has(String(req.headers.origin ?? ''))) {
      throw new HttpError(403, { error: 'origin_not_allowed' })
    }
    const client = resolveClientIp(
      req.socket.remoteAddress,
      typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined,
      trusted,
    )
    if (!client) {
      throw new HttpError(400, { error: 'bad_request' })
    }
    // The limit of one address goes first: a request it refuses must not use up the tokens of everybody else
    const wait = perIp.take(rateKey(client.ip)) || total.take('all')
    if (wait > 0) {
      throw new HttpError(429, { error: 'rate_limited' }, { 'Retry-After': String(wait) })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse((await readBody(req, maxBodyBytes)).toString('utf8'))
    } catch (error) {
      if (error instanceof HttpError) {
        throw error
      }
      throw new HttpError(400, { error: 'bad_request' })
    }
    const report = parseReport(parsed)
    if (!report) {
      throw new HttpError(400, { error: 'bad_request' })
    }

    const hint = browserHint(req.headers['user-agent'])
    const network = options.asn?.lookup(client.ip)
    options.store.insert({
      receivedAt: now(),
      ...report,
      browser: hint.family,
      mobile: hint.mobile,
      ...(network?.asn === undefined ? {} : { asn: network.asn }),
      ...(network?.name === undefined ? {} : { network: network.name }),
      prefixHash: prefixHash(options.secret, client.ip),
    })
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end()
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) {
        reply(res, error.status, error.body, error.headers)
        return
      }
      // Nothing about the request goes into the message: it could carry an address
      reply(res, 500, { error: 'internal_error' })
    })
  }
}

/** A server around the handler, with timeouts short enough that a slow client cannot hold many connections */
export function createReceiverServer(options: ReceiverOptions): Server {
  const server = createServer(createReceiver(options))
  server.headersTimeout = 10_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 50
  server.on('clientError', (_error, socket) => {
    socket.destroy()
  })
  return server
}
