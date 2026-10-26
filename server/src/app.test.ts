import assert from 'node:assert/strict'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import { describe, it } from 'node:test'

import { createApp } from './app'
import { MemoryAuditLog } from './audit/log'
import { Config, parseConfig, sha256Hex } from './config'
import { IdentityEngine } from './identity/engine'
import { MemoryIdentityStore } from './identity/memory_store'
import { defaultModel } from './identity/model'
import { CollectPayload } from './ingest/validate'
import { CrawlerVerifier, type DnsResolver } from './net/bots'
import { CidrListProvider, noIpIntel, parseCidrList } from './net/ip_intel'
import { SettingsRegistry } from './settings/settings'
import { MemoryEventStore } from './store/memory'
import { ConnectionRegistry } from './tls/tls_front'
import { MemoryWebhookQueue } from './webhooks/queue'

/** The part of the identity answer that the tests look at */
interface IdentityView {
  visitorId: string
  matched: boolean
  calibrated: boolean
  probability: number | null
  provisionalProbability: number | null
  candidates: number
  devices: number
  explanation: Array<{ feature: string; outcome: string; weight: number }>
}

const PK1 = 'pk_tenantone_0123456789'
const PK2 = 'pk_tenanttwo_0123456789'
const SK1 = 'sk_tenant_one_secret'
const SK2 = 'sk_tenant_two_secret'

function baseConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    nonceSecret: 'n'.repeat(32),
    tenants: [
      { id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)] },
      { id: 't2', publicKey: PK2, secretKeySha256: [sha256Hex(SK2)], allowedOrigins: ['https://shop.example'] },
    ],
    rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    ...overrides,
  })
}

async function start(
  configOverrides: Record<string, unknown> = {},
  deps: Partial<Parameters<typeof createApp>[0]> = {},
  kind: 'http' | 'http2' = 'http',
) {
  const config = baseConfig(configOverrides)
  const store = new MemoryEventStore()
  const app = createApp({ config, store, intel: noIpIntel, registry: new ConnectionRegistry(), ...deps })
  // The HTTP/2 compatibility classes match `Res` at run time; TypeScript can't see it through their overloads
  const server = kind === 'http' ? http.createServer(app) : http2.createServer(app as never)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        ;(server as http.Server).closeAllConnections?.()
      }),
  }
}

function payload(nonce?: string, extra: Partial<CollectPayload> = {}): CollectPayload {
  return {
    schema: 1,
    libVersion: '5.3.0',
    collectedAt: Date.now(),
    durationMs: 100,
    ...(nonce === undefined ? {} : { nonce }),
    components: { canvas: { value: { winding: true }, duration: 3 }, platform: { value: 'MacIntel', duration: 0 } },
    extended: { mediaSupport: { value: { canPlayType: {} }, duration: 1 } },
    ...extra,
  }
}

/** The tests of the app are about the requests, not about the bar of the matcher, so they use a lower bar */
const lenientModel = () => ({ ...defaultModel(), matchProbability: 0.95 })

const json = { 'Content-Type': 'application/json' }

interface NetworkView {
  ip: string
  ipPrefix: string
  ipSource: string
  httpVersion: string
  viaProxy: boolean
  headers: { fp: string; order: string[] }
}

async function nonceFor(url: string, pk = PK1, userAgent?: string): Promise<string> {
  const response = await fetch(
    `${url}/v1/nonce?k=${pk}`,
    userAgent ? { headers: { 'User-Agent': userAgent } } : undefined,
  )
  assert.equal(response.status, 200)
  return ((await response.json()) as { nonce: string }).nonce
}

async function post(url: string, body: unknown, pk = PK1, headers: Record<string, string> = json) {
  return fetch(`${url}/v1/collect?k=${pk}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('collect flow', () => {
  it('issues a nonce, takes the payload and returns nothing but a request id', async () => {
    const app = await start()
    try {
      const response = await post(app.url, payload(await nonceFor(app.url)))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const body = (await response.json()) as Record<string, unknown>
      assert.deepEqual(Object.keys(body), ['requestId'], 'the browser must learn nothing but the id')
    } finally {
      await app.close()
    }
  })

  it('lets the backend of the tenant read the event with the secret key', async () => {
    const app = await start()
    try {
      const { requestId } = (await (await post(app.url, payload(await nonceFor(app.url)))).json()) as {
        requestId: string
      }
      const response = await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
      assert.equal(response.status, 200)
      const event = (await response.json()) as {
        tenantId: string
        network: NetworkView
        payload: CollectPayload
        derived: { clockSkewMs: number }
      }
      assert.equal(event.tenantId, 't1')
      assert.equal(event.network.ip, '127.0.0.1')
      assert.equal(event.network.ipPrefix, '127.0.0.0/24')
      assert.equal(event.network.httpVersion, '1.1')
      assert.equal(event.network.ipSource, 'socket')
      assert.equal(event.network.viaProxy, false)
      assert.match(event.network.headers.fp, /^[0-9a-f]{16}$/)
      assert.ok(event.network.headers.order.includes('content-type'))
      assert.equal(event.payload.components.platform.value, 'MacIntel')
      assert.ok(Math.abs(event.derived.clockSkewMs) < 5000)
    } finally {
      await app.close()
    }
  })

  it('refuses to replay a payload: the nonce works once', async () => {
    const app = await start()
    try {
      const body = payload(await nonceFor(app.url))
      assert.equal((await post(app.url, body)).status, 200)
      const replay = await post(app.url, body)
      assert.equal(replay.status, 400)
      assert.deepEqual(await replay.json(), { error: 'invalid_nonce', reason: 'used' })
    } finally {
      await app.close()
    }
  })

  it('refuses a nonce of another tenant, a forged nonce and an expired nonce', async () => {
    let clock = 1_700_000_000_000
    const app = await start({ nonceTtlSeconds: 60 }, { now: () => clock })
    try {
      const other = await nonceFor(app.url, PK2)
      const crossTenant = await post(app.url, payload(other), PK1)
      assert.deepEqual(await crossTenant.json(), { error: 'invalid_nonce', reason: 'signature' })

      const forged = await post(app.url, payload('n2.9999999999.AAAAAAAAAAAAAAAA.________.AAAAAAAAAAAAAAAAAAAAAA'))
      assert.deepEqual(await forged.json(), { error: 'invalid_nonce', reason: 'signature' })

      const stale = await nonceFor(app.url)
      clock += 61_000
      const expired = await post(app.url, payload(stale))
      assert.deepEqual(await expired.json(), { error: 'invalid_nonce', reason: 'expired' })
    } finally {
      await app.close()
    }
  })

  it('requires a nonce unless the configuration says otherwise', async () => {
    const strict = await start()
    const relaxed = await start({ requireNonce: false })
    try {
      const refused = await post(strict.url, payload())
      assert.equal(refused.status, 400)
      assert.deepEqual(await refused.json(), { error: 'nonce_required' })
      assert.equal((await post(relaxed.url, payload())).status, 200)
    } finally {
      await strict.close()
      await relaxed.close()
    }
  })

  it('does not store a payload that was refused', async () => {
    const app = await start()
    try {
      await post(app.url, payload('n2.1.AAAAAAAAAAAAAAAA.________.xxxxxxxxxxxxxxxxxxxxxx'))
      await post(app.url, { schema: 9 })
      assert.equal(app.store.purge(Date.now() + 1e12, 0).events, 0)
    } finally {
      await app.close()
    }
  })
})

describe('input checks', () => {
  it('answers 401 to an unknown or missing public key', async () => {
    const app = await start()
    try {
      assert.equal((await post(app.url, payload(), 'pk_nobody_000000000000')).status, 401)
      assert.equal((await fetch(`${app.url}/v1/nonce`)).status, 401)
    } finally {
      await app.close()
    }
  })

  it('answers 415 to a wrong content type, 400 to bad JSON and 422 to a bad payload', async () => {
    const app = await start({ requireNonce: false })
    try {
      assert.equal((await post(app.url, 'x', PK1, { 'Content-Type': 'text/plain' })).status, 415)
      assert.deepEqual(await (await post(app.url, '{not json')).json(), { error: 'invalid_json' })
      const bad = await post(app.url, { ...payload(), schema: 2 })
      assert.equal(bad.status, 422)
      assert.match(((await bad.json()) as { problems: string[] }).problems[0], /unsupported schema/)
    } finally {
      await app.close()
    }
  })

  it('refuses a body over the limit, declared or streamed', async () => {
    const app = await start({ maxBodyBytes: 2000, requireNonce: false })
    try {
      const declared = await post(app.url, payload(undefined, { libVersion: 'x'.repeat(3000) as never }))
      assert.equal(declared.status, 413)

      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          `${app.url}/v1/collect?k=${PK1}`,
          { method: 'POST', headers: { ...json, 'Transfer-Encoding': 'chunked' } },
          (response) => {
            resolve(response.statusCode ?? 0)
            response.resume()
          },
        )
        request.on('error', reject)
        request.write(`{"a":"${'x'.repeat(1500)}`)
        request.write('x'.repeat(1500))
        request.write('x'.repeat(1500))
        request.end('"}')
      })
      assert.equal(status, 413)
    } finally {
      await app.close()
    }
  })

  it('answers 404 and 405 correctly and never leaks a stack', async () => {
    const app = await start()
    try {
      assert.equal((await fetch(`${app.url}/nope`)).status, 404)
      const wrongMethod = await fetch(`${app.url}/v1/collect?k=${PK1}`)
      assert.equal(wrongMethod.status, 405)
      assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS')
      assert.equal((await fetch(`${app.url}/healthz`)).status, 200)
    } finally {
      await app.close()
    }
  })
})

describe('abuse limits', () => {
  it('limits the collect requests of one address', async () => {
    const app = await start({
      rateLimit: { collectPerMinutePerIp: 3, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
      requireNonce: false,
    })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        statuses.push((await post(app.url, payload())).status)
      }
      assert.deepEqual(statuses, [200, 200, 200, 429, 429])
      const limited = await post(app.url, payload())
      assert.ok(Number(limited.headers.get('retry-after')) > 0)
    } finally {
      await app.close()
    }
  })

  it('limits nonces and the guessing of secret keys', async () => {
    const app = await start({
      rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 2 },
    })
    try {
      assert.equal((await fetch(`${app.url}/v1/nonce?k=${PK1}`)).status, 200)
      assert.equal((await fetch(`${app.url}/v1/nonce?k=${PK1}`)).status, 200)
      assert.equal((await fetch(`${app.url}/v1/nonce?k=${PK1}`)).status, 429)

      const statuses: number[] = []
      for (let i = 0; i < 12; i++) {
        statuses.push(
          (await fetch(`${app.url}/v1/events/abc`, { headers: { Authorization: `Bearer guess${i}` } })).status,
        )
      }
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401))
      assert.deepEqual(statuses.slice(10), [429, 429])
    } finally {
      await app.close()
    }
  })
})

describe('events API', () => {
  it('needs a valid secret key', async () => {
    const app = await start()
    try {
      assert.equal((await fetch(`${app.url}/v1/events/abc`)).status, 401)
      assert.equal(
        (await fetch(`${app.url}/v1/events/abc`, { headers: { Authorization: 'Bearer wrong' } })).status,
        401,
      )
      assert.equal(
        (await fetch(`${app.url}/v1/events/abc`, { headers: { Authorization: SK1 } })).status,
        401,
        'the Bearer scheme is required',
      )
      assert.equal(
        (await fetch(`${app.url}/v1/events/abc`, { headers: { Authorization: `Bearer ${PK1}` } })).status,
        401,
        'the public key is not a secret key',
      )
    } finally {
      await app.close()
    }
  })

  it('keeps tenants apart: a valid key of another tenant sees "not found"', async () => {
    const app = await start()
    try {
      const { requestId } = (await (await post(app.url, payload(await nonceFor(app.url)))).json()) as {
        requestId: string
      }
      assert.equal(
        (await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK2}` } })).status,
        404,
      )
      assert.equal(
        (await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })).status,
        200,
      )
    } finally {
      await app.close()
    }
  })

  it('rejects a request id that is not in the expected format', async () => {
    const app = await start()
    try {
      assert.equal(
        (await fetch(`${app.url}/v1/events/..%2F..%2Fetc`, { headers: { Authorization: `Bearer ${SK1}` } })).status,
        404,
      )
    } finally {
      await app.close()
    }
  })
})

describe('client address', () => {
  async function ipSeenFor(app: Awaited<ReturnType<typeof start>>, headers: Record<string, string>): Promise<string> {
    const body = payload(await nonceFor(app.url))
    const { requestId } = (await (await post(app.url, body, PK1, { ...json, ...headers })).json()) as {
      requestId: string
    }
    const event = (await (
      await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
    ).json()) as { network: { ip: string } }
    return event.network.ip
  }

  it('does not believe X-Forwarded-For from a connection that is not a trusted proxy', async () => {
    const app = await start()
    try {
      assert.equal(await ipSeenFor(app, { 'X-Forwarded-For': '6.6.6.6' }), '127.0.0.1')
    } finally {
      await app.close()
    }
  })

  it('believes it from a trusted proxy, reading from the right, and marks the proxy', async () => {
    const app = await start({ trustedProxies: ['127.0.0.0/8'] })
    try {
      assert.equal(await ipSeenFor(app, { 'X-Forwarded-For': '6.6.6.6, 198.51.100.9' }), '198.51.100.9')
      const stored = app.store.getEvent(
        't1',
        [...(app.store as unknown as { events: Map<string, unknown> }).events.keys()][0],
      )
      assert.equal(stored?.network.viaProxy, true)
    } finally {
      await app.close()
    }
  })

  it('uses the address that the TLS front saw, not the loopback address of the front itself', async () => {
    const registry = new ConnectionRegistry()
    const app = await start({}, { registry })
    try {
      // The request is sent from a known local port, which plays the part of the front's connection to the inner server
      const localPort = await new Promise<number>((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const { port } = probe.address() as net.AddressInfo
          probe.close(() => resolve(port))
        })
      })
      registry.set(localPort, { clientIp: '203.0.113.9', sniffStatus: 'ok' })
      const nonce = await nonceFor(app.url)
      const body = JSON.stringify(payload(nonce))
      const requestId = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          `${app.url}/v1/collect?k=${PK1}`,
          { method: 'POST', headers: json, localPort, localAddress: '127.0.0.1' },
          (response) => {
            let text = ''
            response.on('data', (chunk) => (text += chunk))
            response.on('end', () => resolve(JSON.parse(text).requestId))
          },
        )
        request.on('error', reject)
        request.end(body)
      })
      const event = app.store.getEvent('t1', requestId)
      assert.equal(event?.network.ip, '203.0.113.9')
      assert.equal(event?.network.ipPrefix, '203.0.113.0/24')
    } finally {
      await app.close()
    }
  })

  it('turns a flood away in memory and counts in the shared database only what gets past', async () => {
    const counted: string[] = []
    const sharedLimits = {
      limiter: (_name: string, limit: number) => {
        const seen = new Map<string, number>()
        return {
          take: (key: string) => {
            counted.push(key)
            seen.set(key, (seen.get(key) ?? 0) + 1)
            return (seen.get(key) ?? 0) > limit ? 30 : 0
          },
        }
      },
      purge: async () => 0,
    }
    const app = await start(
      {
        database: { type: 'mysql', user: 'fp', database: 'fp' },
        sharedLimits: true,
        tenants: [
          {
            id: 't1',
            publicKey: PK1,
            secretKeySha256: [sha256Hex(SK1)],
            settings: { limits: { noncePerMinutePerIp: 3 } },
          },
        ],
      },
      { sharedLimits },
    )
    try {
      const statuses: number[] = []
      for (let n = 0; n < 60; n++) {
        statuses.push((await fetch(`${app.url}/v1/nonce?k=${PK1}`)).status)
      }
      assert.equal(statuses.filter((status) => status === 200).length, 3, 'the shared limit decides the first three')
      assert.ok(statuses.slice(3).every((status) => status === 429))
      // The local limit is ten times the real one: the database was asked about the first thirty, and not the rest
      assert.equal(counted.length, 30)
    } finally {
      await app.close()
    }
  })

  it('gives each visitor behind the front a rate limit of their own', async () => {
    const registry = new ConnectionRegistry()
    const app = await start(
      {
        rateLimit: { collectPerMinutePerIp: 1, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
        requireNonce: false,
      },
      { registry },
    )
    try {
      const send = (visitor: string, localPort: number) =>
        new Promise<number>((resolve, reject) => {
          registry.set(localPort, { clientIp: visitor, sniffStatus: 'ok' })
          const request = http.request(
            `${app.url}/v1/collect?k=${PK1}`,
            { method: 'POST', headers: json, localPort, localAddress: '127.0.0.1', agent: false },
            (response) => {
              response.resume()
              resolve(response.statusCode ?? 0)
            },
          )
          request.on('error', reject)
          request.end(JSON.stringify(payload()))
        })
      const freePort = () =>
        new Promise<number>((resolve) => {
          const probe = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo
            probe.close(() => resolve(port))
          })
        })
      const results = [
        await send('203.0.113.1', await freePort()),
        await send('203.0.113.2', await freePort()),
        await send('203.0.113.1', await freePort()),
      ]
      assert.deepEqual(results, [200, 200, 429], 'two different visitors must not share one bucket')
    } finally {
      await app.close()
    }
  })

  it('labels the address with the IP lists', async () => {
    const intel = new CidrListProvider([{ tag: 'loopback_test', cidrs: parseCidrList('127.0.0.0/8').cidrs }])
    const app = await start({}, { intel })
    try {
      const { requestId } = (await (await post(app.url, payload(await nonceFor(app.url)))).json()) as {
        requestId: string
      }
      const event = (await (
        await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
      ).json()) as { network: { ipIntel: { tags: string[] } } }
      assert.deepEqual(event.network.ipIntel.tags, ['loopback_test'])
    } finally {
      await app.close()
    }
  })
})

describe('TLS fingerprint from a proxy', () => {
  const ja4 = 't13d1516h2_8daaf6152771_e5627efa2ab1'

  async function tlsSeenFor(app: Awaited<ReturnType<typeof start>>, headers: Record<string, string>) {
    const body = payload(await nonceFor(app.url))
    const { requestId } = (await (await post(app.url, body, PK1, { ...json, ...headers })).json()) as {
      requestId: string
    }
    const event = (await (
      await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
    ).json()) as { network: { tls?: { ja4: string; source: string }; tlsStatus?: string } }
    return event.network
  }

  it('takes the JA4 from the configured header when the proxy is trusted', async () => {
    const app = await start({ trustedProxies: ['127.0.0.0/8'], ja4Header: 'X-JA4' })
    try {
      assert.deepEqual((await tlsSeenFor(app, { 'X-JA4': ja4 })).tls, { ja4, source: 'header' })
    } finally {
      await app.close()
    }
  })

  it('ignores the header from anyone else, since anyone could write it', async () => {
    const app = await start({ ja4Header: 'x-ja4' })
    try {
      const network = await tlsSeenFor(app, { 'X-JA4': ja4 })
      assert.equal(network.tls, undefined)
    } finally {
      await app.close()
    }
  })

  it('refuses a header that is not a JA4', async () => {
    const app = await start({ trustedProxies: ['127.0.0.0/8'], ja4Header: 'x-ja4' })
    try {
      const network = await tlsSeenFor(app, { 'X-JA4': "t13d1516h2_zzzz'; DROP" })
      assert.equal(network.tls, undefined)
      assert.equal(network.tlsStatus, 'invalid_header')
    } finally {
      await app.close()
    }
  })
})

describe('browser access (CORS)', () => {
  it('lets an allowed origin call with credentials and answers its preflight', async () => {
    const app = await start()
    try {
      const preflight = await fetch(`${app.url}/v1/collect?k=${PK2}`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://shop.example' },
      })
      assert.equal(preflight.status, 204)
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://shop.example')
      assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
      assert.equal(preflight.headers.get('vary'), 'Origin')

      const nonce = await fetch(`${app.url}/v1/nonce?k=${PK2}`, { headers: { Origin: 'https://shop.example' } })
      assert.equal(nonce.headers.get('access-control-allow-origin'), 'https://shop.example')
    } finally {
      await app.close()
    }
  })

  it('lets the page read the errors too, since the browser hides an answer without CORS headers', async () => {
    const app = await start({
      rateLimit: { collectPerMinutePerIp: 1, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    })
    try {
      const headers = { ...json, Origin: 'https://shop.example' }
      const origin = 'https://shop.example'
      const bad = await post(app.url, { schema: 9 }, PK2, headers)
      assert.equal(bad.status, 422)
      assert.equal(bad.headers.get('access-control-allow-origin'), origin, 'invalid payload')
      assert.equal(bad.headers.get('access-control-allow-credentials'), 'true')

      const nonce = await post(app.url, payload('n2.1.AAAAAAAAAAAAAAAA.________.xxxxxxxxxxxxxxxxxxxxxx'), PK2, headers)
      assert.equal(nonce.headers.get('access-control-allow-origin'), origin, 'invalid nonce')

      const limited = await post(app.url, payload(), PK2, headers)
      assert.equal(limited.status, 429)
      assert.equal(limited.headers.get('access-control-allow-origin'), origin, 'rate limited')
      assert.ok(limited.headers.get('retry-after'))

      const wrongMethod = await fetch(`${app.url}/v1/collect?k=${PK2}`, { headers: { Origin: origin } })
      assert.equal(wrongMethod.headers.get('access-control-allow-origin'), origin, 'wrong method')
    } finally {
      await app.close()
    }
  })

  it('does not give CORS headers to an origin that is not allowed, even on the error', async () => {
    const app = await start()
    try {
      const response = await post(app.url, { schema: 9 }, PK2, { ...json, Origin: 'https://evil.example' })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('access-control-allow-origin'), null)
    } finally {
      await app.close()
    }
  })

  it('refuses another origin when the tenant lists its origins', async () => {
    const app = await start()
    try {
      const response = await fetch(`${app.url}/v1/nonce?k=${PK2}`, { headers: { Origin: 'https://evil.example' } })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('access-control-allow-origin'), null)
    } finally {
      await app.close()
    }
  })

  it('adds no CORS headers for a tenant without a list of origins', async () => {
    const app = await start()
    try {
      const response = await fetch(`${app.url}/v1/nonce?k=${PK1}`, { headers: { Origin: 'https://anything.example' } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('access-control-allow-origin'), null)
    } finally {
      await app.close()
    }
  })
})

describe('collection page', () => {
  const staticFiles = {
    '/': { type: 'text/html; charset=utf-8', body: Buffer.from('<h1>page</h1>') },
    '/calibration.js': { type: 'text/javascript; charset=utf-8', body: Buffer.from('console.log(1)') },
  }

  it('serves the page and its script, with a policy that allows nothing external', async () => {
    const app = await start({}, { staticFiles })
    try {
      const page = await fetch(`${app.url}/`)
      assert.equal(page.status, 200)
      assert.equal(await page.text(), '<h1>page</h1>')
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
      const csp = page.headers.get('content-security-policy') ?? ''
      assert.ok(
        csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && csp.includes('worker-src blob:'),
      )
      assert.ok(!csp.includes('http'), 'no external address is allowed')
      assert.equal(page.headers.get('x-frame-options'), 'DENY')
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
      assert.equal(page.headers.get('cache-control'), 'no-store')

      const script = await fetch(`${app.url}/calibration.js`)
      assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    } finally {
      await app.close()
    }
  })

  it('answers HEAD without a body', async () => {
    const app = await start({}, { staticFiles })
    try {
      const response = await fetch(`${app.url}/`, { method: 'HEAD' })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '')
    } finally {
      await app.close()
    }
  })

  it('serves only the listed paths: nothing can be read from disk by guessing a path', async () => {
    const app = await start({}, { staticFiles })
    try {
      const paths = [
        '/index.html',
        '/../config.json',
        '/..%2Fconfig.json',
        '/%2e%2e/etc/passwd',
        '/calibration.js/',
        '/config.js',
        '/__proto__',
        '/constructor',
        '/toString',
      ]
      for (const path of paths) {
        const response = await fetch(`${app.url}${path}`)
        assert.equal(response.status, 404, path)
        assert.ok(!(response.headers.get('content-type') ?? '').includes('html'), path)
      }
      assert.equal((await fetch(`${app.url}/`, { method: 'POST', headers: json, body: '{}' })).status, 404)
    } finally {
      await app.close()
    }
  })

  it('serves nothing when no page is configured', async () => {
    const app = await start()
    try {
      assert.equal((await fetch(`${app.url}/`)).status, 404)
    } finally {
      await app.close()
    }
  })

  it('lets the page call the API on the same address, with no CORS headers needed', async () => {
    const app = await start({ requireNonce: true }, { staticFiles })
    try {
      const nonce = await nonceFor(app.url)
      const response = await post(app.url, payload(nonce), PK1, { ...json, Origin: app.url })
      assert.equal(response.status, 200)
    } finally {
      await app.close()
    }
  })
})

describe('visitor identification', () => {
  /** A visit with enough signals to be recognizable. `n` makes a different device. */
  function richPayload(nonce: string, n: number, extra: Partial<Record<string, unknown>> = {}): CollectPayload {
    const signal = (value: unknown) => ({ value, duration: 1 })
    return {
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now(),
      durationMs: 5,
      nonce,
      components: {
        canvas: signal({ winding: true, geometry: `geometry-${n}`, text: `text-${n}` }),
        webGlBasics: signal({
          rendererUnmasked: `gpu-${n}`,
          vendorUnmasked: `vendor-${n}`,
          renderer: 'r',
          vendor: 'v',
        }),
        fonts: signal([`font-${n}`]),
        screenResolution: signal([1000 + n, 800]),
        platform: signal('MacIntel'),
        timezone: signal('America/Sao_Paulo'),
        ...extra,
      },
      extended: {},
    }
  }

  async function visit(url: string, n: number, extra: Partial<Record<string, unknown>> = {}, pk = PK1) {
    const response = await post(url, richPayload(await nonceFor(url, pk), n, extra), pk)
    assert.equal(response.status, 200)
    return ((await response.json()) as { requestId: string }).requestId
  }

  async function identityOf(url: string, requestId: string, secret = SK1) {
    const response = await fetch(`${url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${secret}` } })
    return ((await response.json()) as { identity: IdentityView | null }).identity
  }

  function startWithIdentity(configOverrides: Record<string, unknown> = {}) {
    const registry = new ConnectionRegistry()
    const store = new MemoryEventStore()
    const identityStore = new MemoryIdentityStore((tenant, request) => {
      const event = store.getEvent(tenant, request)
      return event && { ip: event.network.ip, linkedId: event.payload.linkedId, receivedAt: event.receivedAt }
    })
    const identity = new IdentityEngine(identityStore, lenientModel())
    return start(configOverrides, { store, registry, identity })
  }

  describe('query API', () => {
    const t0 = Date.parse('2026-10-01T00:00:00Z')
    const minute = 60_000

    interface Page {
      events: Array<{
        requestId: string
        receivedAt: number
        linkedId: string | null
        visitorId: string | null
        ip: string
      }>
      next: string | null
    }

    /** Visits `plan` (device number and linked id), one minute apart, and returns the app and the request ids */
    async function populate(
      plan: Array<{ device: number; linkedId: string }>,
      overrides: Record<string, unknown> = {},
    ) {
      let clock = t0
      const store = new MemoryEventStore()
      const identity = new IdentityEngine(
        new MemoryIdentityStore((tenant, request) => {
          const event = store.getEvent(tenant, request)
          return event && { ip: event.network.ip, linkedId: event.payload.linkedId, receivedAt: event.receivedAt }
        }),
        lenientModel(),
      )
      const app = await start(overrides, { store, identity, now: () => clock })
      const ids: string[] = []
      for (const [index, visitPlan] of plan.entries()) {
        clock = t0 + index * minute
        const body = {
          ...richPayload(await nonceFor(app.url, PK1), visitPlan.device),
          linkedId: visitPlan.linkedId,
          collectedAt: clock,
        }
        const response = await post(app.url, body, PK1)
        assert.equal(response.status, 200)
        ids.push(((await response.json()) as { requestId: string }).requestId)
      }
      return { app, ids }
    }

    const get = (url: string, path: string, secret = SK1) =>
      fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${secret}` } })
    const page = async (url: string, path: string) => (await (await get(url, path)).json()) as Page

    const five = [1, 2, 3, 4, 5].map((n) => ({ device: n, linkedId: `acct${n}` }))

    it('lists the newest first and follows the cursor to the end without repeating or skipping', async () => {
      const { app, ids } = await populate(five)
      try {
        const seen: string[] = []
        let path = '/v1/events?limit=2'
        for (let guard = 0; guard < 10; guard++) {
          const result = await page(app.url, path)
          seen.push(...result.events.map((event) => event.requestId))
          if (!result.next) {
            break
          }
          path = `/v1/events?limit=2&after=${result.next}`
        }
        assert.deepEqual(seen, [...ids].reverse())
        const oldestFirst = await page(app.url, '/v1/events?order=asc')
        assert.deepEqual(
          oldestFirst.events.map((event) => event.requestId),
          ids,
        )
        assert.equal(oldestFirst.next, null, 'a page that is not full is the end')
      } finally {
        await app.close()
      }
    })

    it('cuts by time with the start included and the end excluded, and filters', async () => {
      const { app, ids } = await populate(five)
      try {
        const between = await page(app.url, `/v1/events?order=asc&since=${t0 + minute}&until=${t0 + 3 * minute}`)
        assert.deepEqual(
          between.events.map((event) => event.requestId),
          [ids[1], ids[2]],
        )
        const iso = await page(
          app.url,
          `/v1/events?order=asc&since=${encodeURIComponent(new Date(t0 + 4 * minute).toISOString())}`,
        )
        assert.deepEqual(
          iso.events.map((event) => event.requestId),
          [ids[4]],
        )
        const linked = await page(app.url, '/v1/events?linkedId=acct3')
        assert.deepEqual(
          linked.events.map((event) => event.requestId),
          [ids[2]],
        )
        assert.equal((await page(app.url, '/v1/events?ip=203.0.113.77')).events.length, 0)
        const byIp = await page(app.url, `/v1/events?ip=${linked.events[0].ip}`)
        assert.equal(byIp.events.length, 5)
      } finally {
        await app.close()
      }
    })

    it('shows a summary, not the whole payload', async () => {
      const { app, ids } = await populate(five.slice(0, 1))
      try {
        const [item] = (await page(app.url, '/v1/events')).events as unknown as Array<Record<string, unknown>>
        assert.deepEqual(Object.keys(item).sort(), [
          'country',
          'decision',
          'ip',
          'linkedId',
          'matched',
          'receivedAt',
          'requestId',
          'risk',
          'samePerson',
          'tamper',
          'visitorId',
        ])
        assert.equal(item.requestId, ids[0])
        assert.equal(item.linkedId, 'acct1')
        assert.equal(item.matched, false)
        assert.equal(typeof item.visitorId, 'string')
        assert.ok(!('payload' in item) && !('network' in item))
      } finally {
        await app.close()
      }
    })

    it('uses the page sizes of the tenant, and never more than its maximum', async () => {
      const { app } = await populate(five, { defaults: { api: { defaultPageSize: 2, maxPageSize: 3 } } })
      try {
        assert.equal((await page(app.url, '/v1/events')).events.length, 2)
        assert.equal((await page(app.url, '/v1/events?limit=100')).events.length, 3)
        assert.equal((await page(app.url, '/v1/events?limit=1')).events.length, 1)
      } finally {
        await app.close()
      }
    })

    it('refuses what it does not understand, naming the parameter', async () => {
      const { app } = await populate(five.slice(0, 1))
      try {
        for (const [query, parameter] of [
          ['limit=0', 'limit'],
          ['limit=abc', 'limit'],
          ['limit=-5', 'limit'],
          ['order=sideways', 'order'],
          ['after=garbage', 'after'],
          [`after=${Buffer.from('["x","y"]').toString('base64url')}`, 'after'],
          ['ip=not-an-ip', 'ip'],
          ['linkedId=a%20b', 'linkedId'],
          ['since=yesterday', 'since'],
          ['until=-1', 'until'],
        ]) {
          const response = await get(app.url, `/v1/events?${query}`)
          assert.equal(response.status, 400, query)
          assert.deepEqual(await response.json(), { error: 'invalid_parameter', parameter }, query)
        }
      } finally {
        await app.close()
      }
    })

    it('needs the secret key, answers only to GET, and never shows another tenant', async () => {
      const { app } = await populate(five.slice(0, 2))
      try {
        assert.equal((await fetch(`${app.url}/v1/events`)).status, 401)
        assert.equal((await get(app.url, '/v1/events', 'sk_wrong')).status, 401)
        assert.equal(
          (await fetch(`${app.url}/v1/events`, { method: 'POST', headers: { Authorization: `Bearer ${SK1}` } })).status,
          405,
        )
        assert.equal((await page(app.url, '/v1/events')).events.length, 2)
        assert.equal((await page(app.url, `/v1/events`)).events.length, 2)
        const other = await (await get(app.url, '/v1/events', SK2)).json()
        assert.deepEqual(other, { events: [], next: null })
      } finally {
        await app.close()
      }
    })

    it('limits how often the API is read, per tenant', async () => {
      const { app } = await populate(five.slice(0, 1), { defaults: { limits: { apiPerMinutePerTenant: 2 } } })
      try {
        const statuses = []
        for (let i = 0; i < 4; i++) {
          statuses.push((await get(app.url, '/v1/events')).status)
        }
        assert.deepEqual(statuses, [200, 200, 429, 429])
      } finally {
        await app.close()
      }
    })

    it('shows a visitor with the latest visits, and nothing for an unknown or foreign one', async () => {
      const { app, ids } = await populate([1, 1, 1, 2].map((device, index) => ({ device, linkedId: `acct${index}` })))
      try {
        const last = (await page(app.url, '/v1/events?limit=1&order=asc')).events[0]
        const visitorId = last.visitorId ?? ''
        const visitor = (await (await get(app.url, `/v1/visitors/${visitorId}?limit=2`)).json()) as {
          visits: number
          firstSeen: number
          lastSeen: number
          events: Page['events']
        }
        assert.equal(visitor.visits, 3)
        assert.equal(visitor.firstSeen, t0)
        assert.equal(visitor.lastSeen, t0 + 2 * minute)
        assert.deepEqual(
          visitor.events.map((event) => event.requestId),
          [ids[2], ids[1]],
          'newest first, cut at the limit',
        )
        assert.equal((await get(app.url, '/v1/visitors/v_unknown')).status, 404)
        assert.equal((await get(app.url, `/v1/visitors/${visitorId}`, SK2)).status, 404)
        assert.equal((await get(app.url, `/v1/visitors/${visitorId}`, 'sk_wrong')).status, 401)
      } finally {
        await app.close()
      }
    })
  })

  describe('privacy and the rights of the visitor', () => {
    const t0 = Date.parse('2026-10-01T00:00:00Z')
    const intel = { lookup: () => ({ tags: ['datacenter'], country: 'BR' }) }

    async function setup(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
      const store = new MemoryEventStore()
      const identity = new IdentityEngine(
        new MemoryIdentityStore((tenant, request) => {
          const event = store.getEvent(tenant, request)
          return event && { ip: event.network.ip, linkedId: event.payload.linkedId, receivedAt: event.receivedAt }
        }),
        lenientModel(),
      )
      const audit = new MemoryAuditLog()
      const webhooks = new MemoryWebhookQueue()
      let clock = t0
      const app = await start(
        {
          trustedProxies: ['127.0.0.0/8'],
          tenants: [
            { id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)], settings },
            { id: 't2', publicKey: PK2, secretKeySha256: [sha256Hex(SK2)], settings },
          ],
          ...extra,
        },
        { store, identity, audit, webhooks, intel, now: () => clock },
      )
      const send = async (
        n: number,
        options: {
          ip?: string
          linkedId?: string
          pk?: string
          consent?: unknown
          components?: Record<string, unknown>
        } = {},
      ) => {
        clock += 1000
        const pk = options.pk ?? PK1
        const headers = { ...json, 'x-forwarded-for': options.ip ?? '203.0.113.9' }
        const nonce = await (
          await fetch(`${app.url}/v1/nonce?k=${pk}`, { headers: { 'x-forwarded-for': headers['x-forwarded-for'] } })
        ).json()
        const body = {
          ...richPayload((nonce as { nonce: string }).nonce, n, options.components),
          collectedAt: clock,
          ...(options.linkedId ? { linkedId: options.linkedId } : {}),
          ...(options.consent ? { consent: options.consent } : {}),
        }
        return post(app.url, body, pk, headers)
      }
      const visit = async (n: number, options: Parameters<typeof send>[1] = {}) => {
        const response = await send(n, options)
        assert.equal(response.status, 200, await response.clone().text())
        return ((await response.json()) as { requestId: string }).requestId
      }
      const get = (path: string, secret = SK1, method = 'GET') =>
        fetch(`${app.url}${path}`, { method, headers: { Authorization: `Bearer ${secret}` } })
      return { app, store, audit, webhooks, send, visit, get, identity }
    }

    interface View {
      network: { ip: string; ipPrefix: string; ipIntel: { tags: string[]; country?: string } }
      identity: { matched: boolean; explanation: Array<{ feature: string }> } | null
      payload: { components: Record<string, unknown>; consent?: unknown }
    }
    const eventOf = async (t: Awaited<ReturnType<typeof setup>>, id: string) =>
      (await (await t.get(`/v1/events/${id}`)).json()) as View

    it('keeps the address in the form the tenant chose, and keeps the labels in every form', async () => {
      const expected: Record<string, [string, string]> = {
        full: ['203.0.113.9', '203.0.113.0/24'],
        truncated: ['203.0.113.0', '203.0.113.0/24'],
        none: ['', ''],
      }
      for (const [mode, [ip, prefix]] of Object.entries(expected)) {
        const t = await setup({ privacy: { ipStorage: mode } })
        try {
          const event = await eventOf(t, await t.visit(1))
          assert.deepEqual([event.network.ip, event.network.ipPrefix], [ip, prefix], mode)
          assert.deepEqual(event.network.ipIntel, { tags: ['datacenter'], country: 'BR' }, `${mode}: labels stay`)
        } finally {
          await t.app.close()
        }
      }
    })

    it('truncates an IPv6 address to /48', async () => {
      const t = await setup({ privacy: { ipStorage: 'truncated' } })
      try {
        const event = await eventOf(t, await t.visit(1, { ip: '2001:db8:1:2:3:4:5:6' }))
        assert.deepEqual(
          [event.network.ip, event.network.ipPrefix],
          ['2001:db8:1:0:0:0:0:0', '2001:db8:1:0:0:0:0:0/48'],
        )
      } finally {
        await t.app.close()
      }
    })

    it('hashes the address with a key per tenant, so the same address gives the same hash only inside it', async () => {
      const t = await setup({ privacy: { ipStorage: 'hash' } })
      let defaultKeyHash = ''
      try {
        const a1 = await eventOf(t, await t.visit(1, { ip: '203.0.113.9' }))
        const a2 = await eventOf(t, await t.visit(1, { ip: '203.0.113.9' }))
        const b = await eventOf(t, await t.visit(1, { ip: '203.0.113.10' }))
        const other = (await (
          await t.get(`/v1/events/${await t.visit(1, { ip: '203.0.113.9', pk: PK2 })}`, SK2)
        ).json()) as View
        assert.match(a1.network.ip, /^h_[A-Za-z0-9_-]{22}$/)
        assert.match(a1.network.ipPrefix, /^hp_[A-Za-z0-9_-]{22}$/)
        defaultKeyHash = a1.network.ip
        assert.equal(a1.network.ip, a2.network.ip)
        assert.notEqual(a1.network.ip, b.network.ip)
        assert.notEqual(a1.network.ip, other.network.ip, 'a tenant cannot match its hashes with those of another')
        assert.ok(!JSON.stringify(a1).includes('203.0.113'), 'the address is nowhere in the record')
        // The same device is still recognized, since the hash of its address is the same
        assert.equal(a2.identity?.matched, true)
        // Another secret gives other hashes
      } finally {
        await t.app.close()
      }
      const keyed = await setup({ privacy: { ipStorage: 'hash' } }, { ipHashSecret: 'k'.repeat(32) })
      try {
        const event = await eventOf(keyed, await keyed.visit(1, { ip: '203.0.113.9' }))
        assert.notEqual(event.network.ip, defaultKeyHash)
      } finally {
        await keyed.app.close()
      }
    })

    it('finds a visit by address in the stored form, and cannot when nothing is stored', async () => {
      for (const mode of ['full', 'truncated', 'hash']) {
        const t = await setup({ privacy: { ipStorage: mode } })
        try {
          const id = await t.visit(1, { ip: '203.0.113.9' })
          await t.visit(2, { ip: '198.51.100.1' })
          const found = (await (await t.get('/v1/events?ip=203.0.113.9')).json()) as {
            events: Array<{ requestId: string }>
          }
          assert.deepEqual(
            found.events.map((event) => event.requestId),
            [id],
            mode,
          )
        } finally {
          await t.app.close()
        }
      }
      const none = await setup({ privacy: { ipStorage: 'none' } })
      try {
        await none.visit(1)
        assert.equal((await none.get('/v1/events?ip=203.0.113.9')).status, 400)
      } finally {
        await none.app.close()
      }
    })

    it('drops the signals the tenant does not want before anything uses them', async () => {
      const t = await setup({ privacy: { dropSignals: ['canvas', 'nativeIntegrity'] } })
      try {
        await t.visit(1)
        const id = await t.visit(1, { components: {} })
        const event = await eventOf(t, id)
        assert.ok(!('canvas' in event.payload.components), 'not stored')
        assert.ok('fonts' in event.payload.components, 'the others stay')
        assert.ok(
          !event.identity?.explanation.some((item) => item.feature.toLowerCase().includes('canvas')),
          'not matched on',
        )
      } finally {
        await t.app.close()
      }
    })

    it('asks for the statement of consent when the tenant says so, without spending the challenge', async () => {
      const t = await setup({ privacy: { requireConsent: true } })
      try {
        for (const consent of [undefined, { basis: 'legitimate_interest', version: '2026-10' }]) {
          const response = await t.send(1, { consent })
          assert.equal(response.status, 422)
          assert.deepEqual(await response.json(), { error: 'consent_required' })
        }
        const id = await t.visit(1, { consent: { basis: 'consent', version: '2026-10' } })
        const event = await eventOf(t, id)
        assert.deepEqual(event.payload.consent, { basis: 'consent', version: '2026-10' })
        // A tenant that does not ask for it accepts any statement, or none
        const open = await setup()
        try {
          await open.visit(1)
          await open.visit(2, { consent: { basis: 'contract', version: 'v1' } })
        } finally {
          await open.app.close()
        }
      } finally {
        await t.app.close()
      }
    })

    it('refuses a statement of consent of the wrong shape', async () => {
      const t = await setup()
      try {
        for (const consent of [
          { basis: 'whatever', version: 'v1' },
          { basis: 'consent' },
          { basis: 'consent', version: '' },
          { basis: 'consent', version: 'x'.repeat(65) },
          { basis: 'consent', version: 'v1', extra: true },
          'consent',
        ]) {
          assert.equal((await t.send(1, { consent })).status, 422, JSON.stringify(consent))
        }
      } finally {
        await t.app.close()
      }
    })

    it('records who read what, never the content, newest first, per tenant', async () => {
      const t = await setup()
      try {
        const id = await t.visit(1, { linkedId: 'acct1' })
        await t.get(`/v1/events/${id}`)
        await t.get('/v1/events')
        await t.get('/v1/events/00000000-0000-0000-0000-000000000000')
        await t.get('/v1/events', 'sk_wrong')
        const response = await t.get('/v1/audit')
        const { entries, next } = (await response.json()) as {
          entries: Array<Record<string, unknown>>
          next: string | null
        }
        assert.equal(next, null)
        assert.deepEqual(
          entries.map((entry) => [entry.action, entry.subject, entry.status]),
          [
            ['event.read', '00000000-0000-0000-0000-000000000000', 404],
            ['events.list', '', 200],
            ['event.read', id, 200],
          ],
          'the wrong key left no entry (it is limited and logged elsewhere), and the read of the audit comes next time',
        )
        const [first] = entries
        assert.match(String(first.keyId), /^[0-9a-f]{8}$/)
        assert.equal(first.keyId, sha256Hex(SK1).slice(0, 8))
        assert.match(String(first.requester), /^h_[A-Za-z0-9_-]{22}$/)
        assert.ok(!JSON.stringify(entries).includes(SK1) && !JSON.stringify(entries).includes('127.0.0.1'))
        assert.deepEqual(Object.keys(first).sort(), ['action', 'at', 'keyId', 'requester', 'status', 'subject'])
        const second = (await (await t.get('/v1/audit')).json()) as { entries: Array<{ action: string }> }
        assert.equal(second.entries[0].action, 'audit.read', 'reading the audit is itself recorded')
        const other = (await (await t.get('/v1/audit', SK2)).json()) as { entries: unknown[] }
        assert.deepEqual(other.entries, [])
      } finally {
        await t.app.close()
      }
    })

    it('pages through the audit log, and can be turned off', async () => {
      const t = await setup()
      try {
        for (let i = 0; i < 5; i++) {
          await t.get('/v1/events')
        }
        const seen: string[] = []
        let path = '/v1/audit?limit=2'
        for (let guard = 0; guard < 10; guard++) {
          const page = (await (await t.get(path)).json()) as {
            entries: Array<{ action: string; at: number }>
            next: string | null
          }
          seen.push(...page.entries.map((entry) => entry.action))
          if (!page.next) {
            break
          }
          path = `/v1/audit?limit=2&after=${page.next}`
        }
        assert.ok(seen.filter((action) => action === 'events.list').length === 5)
        assert.equal((await t.get('/v1/audit?after=abc')).status, 400)
      } finally {
        await t.app.close()
      }
      const off = await setup({ audit: { enabled: false } })
      try {
        await off.get('/v1/events')
        assert.equal(off.audit.list('t1', { limit: 10 }).length, 0)
      } finally {
        await off.app.close()
      }
    })

    it('does not fail a request because the audit log failed', async () => {
      const t = await setup()
      try {
        t.audit.record = () => {
          throw new Error('disk full')
        }
        assert.equal((await t.get('/v1/events')).status, 200)
      } finally {
        await t.app.close()
      }
    })

    it('exports everything kept about a linked id, and says when it cut', async () => {
      const t = await setup({ api: { maxExportEvents: 2 } })
      try {
        const ids = [
          await t.visit(1, { linkedId: 'acct1' }),
          await t.visit(1, { linkedId: 'acct1' }),
          await t.visit(1, { linkedId: 'acct1' }),
        ]
        await t.visit(2, { linkedId: 'acct2' })
        const exported = (await (await t.get('/v1/subjects/export?linkedId=acct1')).json()) as {
          truncated: boolean
          visitors: string[]
          events: Array<{ requestId: string; identity: { visitorId: string }; network: { ip: string } }>
        }
        assert.equal(exported.truncated, true)
        assert.deepEqual(
          exported.events.map((event) => event.requestId),
          ids.slice(0, 2),
        )
        assert.equal(exported.visitors.length, 1)
        assert.equal(exported.events[0].network.ip, '203.0.113.9', 'the record is whole')
        const full = await setup()
        try {
          await full.visit(1, { linkedId: 'acct1' })
          const all = (await (await full.get('/v1/subjects/export?linkedId=acct1')).json()) as {
            truncated: boolean
            events: unknown[]
          }
          assert.deepEqual([all.truncated, all.events.length], [false, 1])
          assert.equal(
            ((await (await full.get('/v1/subjects/export?linkedId=nobody')).json()) as { events: unknown[] }).events
              .length,
            0,
          )
        } finally {
          await full.app.close()
        }
        assert.equal((await t.get('/v1/subjects/export')).status, 400)
        assert.equal((await t.get('/v1/subjects/export?linkedId=a%20b')).status, 400)
        assert.equal((await t.get('/v1/subjects/export?linkedId=acct1', 'sk_wrong')).status, 401)
        assert.equal(
          ((await t.get('/v1/subjects/export?linkedId=acct1', SK2).then((r) => r.json())) as { events: unknown[] })
            .events.length,
          0,
        )
      } finally {
        await t.app.close()
      }
    })

    it('deletes the visits of a linked id, their deliveries and the device nothing supports, and no more', async () => {
      const t = await setup()
      try {
        const mine = [await t.visit(1, { linkedId: 'acct1' }), await t.visit(1, { linkedId: 'acct1' })]
        const keep = await t.visit(2, { linkedId: 'acct2' })
        const otherTenant = await t.visit(1, { linkedId: 'acct1', pk: PK2 })
        for (const [index, id] of [...mine, keep].entries()) {
          t.webhooks.enqueue(
            { id: `d${index}`, tenantId: 't1', endpointId: 'e', body: `{"visit":{"requestId":"${id}"}}`, createdAt: 1 },
            100,
          )
        }
        const result = await t.get('/v1/subjects?linkedId=acct1', SK1, 'DELETE')
        assert.equal(result.status, 200)
        assert.deepEqual(await result.json(), { deleted: 2, deliveries: 2, devices: 1 })
        for (const id of mine) {
          assert.equal((await t.get(`/v1/events/${id}`)).status, 404)
        }
        assert.equal((await t.get(`/v1/events/${keep}`)).status, 200, 'the other person is untouched')
        assert.equal(t.webhooks.list('t1', { limit: 10 }).length, 1)
        assert.equal((await t.get(`/v1/events/${otherTenant}`, SK2)).status, 200, 'another tenant is untouched')
        const audit = t.audit.list('t1', { limit: 50 }).find((entry) => entry.action === 'subject.delete')
        assert.deepEqual([audit?.subject, audit?.status], ['acct1', 200])
      } finally {
        await t.app.close()
      }
    })

    it('deletes all the visits of a linked id even when there are more than a page of them', async () => {
      const t = await setup()
      try {
        const first = await t.visit(1, { linkedId: 'busy' })
        const template = t.store.getEvent('t1', first)
        assert.ok(template)
        for (let i = 0; i < 1204; i++) {
          t.store.insertEvent({ ...template, requestId: `bulk-${i}`, receivedAt: template.receivedAt + 1 + (i % 7) })
        }
        const keep = await t.visit(2, { linkedId: 'quiet' })
        const result = (await (await t.get('/v1/subjects?linkedId=busy', SK1, 'DELETE')).json()) as { deleted: number }
        assert.equal(result.deleted, 1205)
        assert.equal((await t.get(`/v1/events/${keep}`)).status, 200)
        assert.equal(t.store.listEvents('t1', { linkedId: 'busy', limit: 10 }).length, 0)
      } finally {
        await t.app.close()
      }
    })

    it('forgets a device when its last visit is deleted, and a visitor can be deleted whole', async () => {
      const t = await setup()
      try {
        await t.visit(1, { linkedId: 'acct1' })
        const id = await t.visit(1, { linkedId: 'acct1' })
        const visitorId = ((await eventOf(t, id)) as unknown as { identity: { visitorId: string } }).identity.visitorId
        assert.equal((await t.get(`/v1/visitors/${visitorId}`)).status, 200)
        const result = await t.get(`/v1/visitors/${visitorId}`, SK1, 'DELETE')
        assert.deepEqual(await result.json(), { deleted: 2, deliveries: 0, devices: 1 })
        assert.equal((await t.get(`/v1/visitors/${visitorId}`)).status, 404, 'the device is gone')
        assert.equal((await t.get(`/v1/visitors/${visitorId}`, SK1, 'DELETE')).status, 404)
        assert.equal((await t.get('/v1/visitors/v_unknown', SK1, 'DELETE')).status, 404)
        // Deleted for real: a new visit is a new device
        const again = await eventOf(t, await t.visit(1))
        assert.equal(again.identity?.matched, false)
      } finally {
        await t.app.close()
      }
    })

    it('can be told not to delete', async () => {
      const t = await setup({ api: { allowDeletion: false } })
      try {
        const id = await t.visit(1, { linkedId: 'acct1' })
        const visitorId = ((await eventOf(t, id)) as unknown as { identity: { visitorId: string } }).identity.visitorId
        for (const path of ['/v1/subjects?linkedId=acct1', `/v1/visitors/${visitorId}`]) {
          const response = await t.get(path, SK1, 'DELETE')
          assert.equal(response.status, 403, path)
          assert.deepEqual(await response.json(), { error: 'deletion_disabled' })
        }
        assert.equal((await t.get(`/v1/events/${id}`)).status, 200)
        assert.equal((await t.get('/v1/subjects?linkedId=acct1', SK1, 'GET')).status, 405)
        assert.equal((await t.get('/v1/subjects/export?linkedId=acct1', SK1, 'DELETE')).status, 405)
      } finally {
        await t.app.close()
      }
    })

    describe('correcting who is who', () => {
      const visitorOf = async (t: Awaited<ReturnType<typeof setup>>, requestId: string) =>
        ((await eventOf(t, requestId)) as unknown as { identity: { visitorId: string } }).identity.visitorId
      const postJson = (t: Awaited<ReturnType<typeof setup>>, path: string, body: unknown, secret = SK1) =>
        fetch(`${t.app.url}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      it('merges two devices: the visits, the old id and the record of who did it', async () => {
        const t = await setup()
        try {
          const first = await t.visit(1, { linkedId: 'acct1' })
          const second = await t.visit(2, { linkedId: 'acct2' })
          const a = await visitorOf(t, first)
          const b = await visitorOf(t, second)
          assert.notEqual(a, b)

          const response = await postJson(t, `/v1/visitors/${b}/merge`, { into: a })
          assert.equal(response.status, 200)
          assert.deepEqual(await response.json(), { visitorId: a, mergedFrom: b, visits: 2 })
          assert.equal(await visitorOf(t, second), a, 'the visit shows the device it belongs to now')
          const visitor = (await (await t.get(`/v1/visitors/${b}`)).json()) as { visitorId: string; mergedFrom: string }
          assert.equal(visitor.visitorId, a, 'the old id is a name for the merged device')
          assert.equal(visitor.mergedFrom, b)
          const actions = (await t.audit.list('t1', { limit: 10 })).map((entry) => entry.action)
          assert.ok(actions.includes('visitor.merge'))
        } finally {
          await t.app.close()
        }
      })

      it('refuses what does not make sense, and what belongs to another tenant', async () => {
        const t = await setup()
        try {
          const a = await visitorOf(t, await t.visit(1))
          const b = await visitorOf(t, await t.visit(2))
          assert.equal((await postJson(t, `/v1/visitors/${a}/merge`, { into: a })).status, 409)
          assert.equal((await postJson(t, `/v1/visitors/${a}/merge`, { into: 'v_ghost' })).status, 404)
          assert.equal((await postJson(t, `/v1/visitors/${a}/merge`, {})).status, 400)
          assert.equal((await postJson(t, `/v1/visitors/${a}/merge`, { into: 'a b' })).status, 400)
          assert.equal((await postJson(t, `/v1/visitors/${b}/merge`, { into: a }, SK2)).status, 404, 'another tenant')
          assert.equal((await postJson(t, `/v1/visitors/${b}/merge`, { into: a }, 'sk_wrong')).status, 401)
          assert.equal((await t.get(`/v1/visitors/${b}/merge`)).status, 405)
          const notJson = await fetch(`${t.app.url}/v1/visitors/${b}/merge`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${SK1}`, 'content-type': 'text/plain' },
            body: 'into=x',
          })
          assert.equal(notJson.status, 415)
          assert.equal(await visitorOf(t, await t.visit(2)), b, 'nothing was merged by the refusals')
        } finally {
          await t.app.close()
        }
      })

      it('splits visits off a device, but never all of them and never the visits of another device', async () => {
        const t = await setup()
        try {
          const first = await t.visit(1)
          const second = await t.visit(1)
          const third = await t.visit(1)
          const other = await t.visit(2)
          const a = await visitorOf(t, first)
          assert.equal(await visitorOf(t, third), a)

          assert.equal((await postJson(t, `/v1/visitors/${a}/split`, { requestIds: [] })).status, 400)
          assert.equal((await postJson(t, `/v1/visitors/${a}/split`, { requestIds: [other] })).status, 409)
          assert.equal((await postJson(t, `/v1/visitors/${a}/split`, { requestIds: ['nope'] })).status, 404)
          assert.equal(
            (await postJson(t, `/v1/visitors/${a}/split`, { requestIds: [first, second, third] })).status,
            409,
          )

          const response = await postJson(t, `/v1/visitors/${a}/split`, { requestIds: [third, third] })
          assert.equal(response.status, 200)
          const result = (await response.json()) as { visitorId: string; splitFrom: string; moved: number }
          assert.equal(result.splitFrom, a)
          assert.equal(result.moved, 1)
          assert.equal(await visitorOf(t, third), result.visitorId)
          assert.equal(await visitorOf(t, second), a)
          assert.equal(((await (await t.get(`/v1/visitors/${a}`)).json()) as { visits: number }).visits, 2)
          assert.ok((await t.audit.list('t1', { limit: 20 })).some((entry) => entry.action === 'visitor.split'))
        } finally {
          await t.app.close()
        }
      })

      it('can be told not to', async () => {
        const t = await setup({ api: { allowIdentityEdits: false } })
        try {
          const a = await visitorOf(t, await t.visit(1))
          const b = await visitorOf(t, await t.visit(2))
          for (const [path, body] of [
            [`/v1/visitors/${b}/merge`, { into: a }],
            [`/v1/visitors/${a}/split`, { requestIds: ['x'] }],
          ] as const) {
            const response = await postJson(t, path, body)
            assert.equal(response.status, 403, path)
            assert.deepEqual(await response.json(), { error: 'identity_edits_disabled' })
          }
        } finally {
          await t.app.close()
        }
      })
    })
  })

  describe('the code stored in the browser', () => {
    const CODE = 'AbCdEfGhIjKlMnOpQrStUv'

    async function setup(settings: Record<string, unknown> = {}) {
      const store = new MemoryEventStore()
      const app = await start(
        { tenants: [{ id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)], settings }] },
        {
          store,
          identity: new IdentityEngine(
            new MemoryIdentityStore((tenant, request) => {
              const event = store.getEvent(tenant, request)
              return event && { ip: event.network.ip, linkedId: event.payload.linkedId, receivedAt: event.receivedAt }
            }),
            lenientModel(),
          ),
        },
      )
      const visit = async (consent?: { basis: string; version: string }) => {
        const nonce = await nonceFor(app.url, PK1)
        const body = {
          ...richPayload(nonce, 1),
          extended: { storedId: { value: { token: CODE, foundIn: ['cookie'], created: false }, duration: 1 } },
          ...(consent ? { consent } : {}),
        }
        const response = await post(app.url, body, PK1)
        assert.equal(response.status, 200)
        const { requestId } = (await response.json()) as { requestId: string }
        const event = (await (
          await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
        ).json()) as { payload: { extended: Record<string, unknown> } }
        return 'storedId' in event.payload.extended
      }
      const profile = async () =>
        ((await (await fetch(`${app.url}/v1/nonce?k=${PK1}`)).json()) as { profile?: Record<string, unknown> }).profile
      return { app, visit, profile }
    }

    const consent = { basis: 'consent', version: '1' }
    const interest = { basis: 'legitimate_interest', version: '1' }

    it('is thrown away unless the tenant turned it on', async () => {
      const t = await setup()
      try {
        assert.equal(await t.visit(consent), false)
        assert.equal(await t.profile(), undefined, 'and the page is not asked for it')
      } finally {
        await t.app.close()
      }
    })

    it('is kept for a basis that the tenant accepts, and thrown away for any other or for none', async () => {
      const t = await setup({ identity: { storedId: { enabled: true } } })
      try {
        assert.equal(await t.visit(consent), true)
        assert.equal(await t.visit(interest), true)
        assert.equal(await t.visit({ basis: 'contract', version: '1' }), false)
        assert.equal(await t.visit({ basis: 'other', version: '1' }), false)
        assert.equal(await t.visit(), false, 'a page that says nothing about the basis')
      } finally {
        await t.app.close()
      }
    })

    it('can be limited to consent alone, and an empty list turns it off', async () => {
      const strict = await setup({ identity: { storedId: { enabled: true, bases: ['consent'] } } })
      try {
        assert.equal(await strict.visit(consent), true)
        assert.equal(await strict.visit(interest), false)
      } finally {
        await strict.app.close()
      }
      const none = await setup({ identity: { storedId: { enabled: true, bases: [] } } })
      try {
        assert.equal(await none.visit(consent), false)
        assert.equal(await none.profile(), undefined)
      } finally {
        await none.app.close()
      }
    })

    it('is asked of the page, with the life of the cookie, only by a tenant that turned it on', async () => {
      const t = await setup({ identity: { storedId: { enabled: true, maxAgeDays: 90 } } })
      try {
        const profile = await t.profile()
        assert.deepEqual(profile?.include, ['storedId'])
        assert.equal(profile?.storedIdMaxAgeDays, 90)
      } finally {
        await t.app.close()
      }
    })
  })

  describe('search crawlers', () => {
    const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    const REAL_IP = '66.249.66.1'
    const COPY_IP = '203.0.113.50'

    function dnsOf(names: Record<string, string[]>, failing = false) {
      const asked: string[] = []
      const resolver: DnsResolver = {
        async reverse(ip) {
          asked.push(ip)
          if (failing) {
            throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' })
          }
          const found = names[ip]
          if (!found) {
            throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
          }
          return found
        },
        async addresses(host) {
          return host === 'crawl-66-249-66-1.googlebot.com' ? [REAL_IP] : []
        },
      }
      return { resolver, asked }
    }

    async function setup(settings: Record<string, unknown> = {}, failing = false) {
      const { resolver, asked } = dnsOf({ [REAL_IP]: ['crawl-66-249-66-1.googlebot.com'] }, failing)
      const store = new MemoryEventStore()
      const app = await start(
        {
          trustedProxies: ['127.0.0.0/8'],
          tenants: [{ id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)], settings }],
        },
        { store, crawlers: new CrawlerVerifier({ resolver }) },
      )
      const visit = async (ip: string, userAgent: string) => {
        const headers = { ...json, 'x-forwarded-for': ip, 'user-agent': userAgent }
        const nonce = await (await fetch(`${app.url}/v1/nonce?k=${PK1}`, { headers })).json()
        const response = await post(app.url, payload((nonce as { nonce: string }).nonce), PK1, headers)
        assert.equal(response.status, 200)
        const { requestId } = (await response.json()) as { requestId: string }
        return (await (
          await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
        ).json()) as {
          network: { crawler?: { claimed: string; verified: boolean | null }; ip: string }
          risk: { factors: Array<{ id: string; weight: number }> }
        }
      }
      return { app, visit, asked }
    }

    it('marks a real crawler as verified and a copy of its name as false, which weighs in the risk', async () => {
      const t = await setup()
      try {
        const real = await t.visit(REAL_IP, GOOGLEBOT)
        assert.deepEqual(real.network.crawler, { claimed: 'googlebot', verified: true })
        assert.equal(
          real.risk.factors.some((factor) => factor.id === 'fake_crawler'),
          false,
          'the real one is not penalized',
        )
        const copy = await t.visit(COPY_IP, GOOGLEBOT)
        assert.deepEqual(copy.network.crawler, { claimed: 'googlebot', verified: false })
        assert.equal(copy.risk.factors.find((factor) => factor.id === 'fake_crawler')?.weight, 30)
      } finally {
        await t.app.close()
      }
    })

    it('does not call a crawler fake when DNS cannot answer, and ignores ordinary browsers', async () => {
      const down = await setup({}, true)
      try {
        const seen = await down.visit(REAL_IP, GOOGLEBOT)
        assert.deepEqual(seen.network.crawler, { claimed: 'googlebot', verified: null })
        assert.equal(
          seen.risk.factors.some((factor) => factor.id === 'fake_crawler'),
          false,
        )
      } finally {
        await down.app.close()
      }
      const t = await setup()
      try {
        const browser = await t.visit(COPY_IP, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605 Safari/605')
        assert.equal(browser.network.crawler, undefined)
        assert.deepEqual(t.asked, [])
      } finally {
        await t.app.close()
      }
    })

    it('can be turned off, and the weight can be changed or zeroed', async () => {
      const off = await setup({ bots: { verify: false } })
      try {
        assert.equal((await off.visit(COPY_IP, GOOGLEBOT)).network.crawler, undefined)
        assert.deepEqual(off.asked, [])
      } finally {
        await off.app.close()
      }
      const free = await setup({ risk: { fakeCrawlerWeight: 0 } })
      try {
        const copy = await free.visit(COPY_IP, GOOGLEBOT)
        assert.equal(copy.network.crawler?.verified, false, 'still reported')
        assert.equal(
          copy.risk.factors.some((factor) => factor.id === 'fake_crawler'),
          false,
        )
      } finally {
        await free.app.close()
      }
    })

    it('checks the whole address even when the tenant keeps it hashed', async () => {
      const t = await setup({ privacy: { ipStorage: 'hash' } })
      try {
        const real = await t.visit(REAL_IP, GOOGLEBOT)
        assert.equal(real.network.crawler?.verified, true)
        assert.notEqual(real.network.ip, REAL_IP, 'what is kept is the hash')
        assert.deepEqual(t.asked, [REAL_IP])
      } finally {
        await t.app.close()
      }
    })
  })

  describe('velocity', () => {
    const t0 = Date.parse('2026-10-01T00:00:00Z')
    const minute = 60_000

    async function accountsAt(settings: Record<string, unknown>, minutes: number[]) {
      let clock = t0
      const store = new MemoryEventStore()
      const identity = new IdentityEngine(
        new MemoryIdentityStore((tenant, request) => {
          const event = store.getEvent(tenant, request)
          return event && { ip: event.network.ip, linkedId: event.payload.linkedId, receivedAt: event.receivedAt }
        }),
        lenientModel(),
      )
      const app = await start(
        { tenants: [{ id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)], settings }] },
        { store, identity, now: () => clock },
      )
      try {
        let last = ''
        for (const [index, at] of minutes.entries()) {
          clock = t0 + at * minute
          const body = { ...richPayload(await nonceFor(app.url, PK1), 1), linkedId: `acct${index}`, collectedAt: clock }
          const response = await post(app.url, body, PK1)
          assert.equal(response.status, 200)
          last = ((await response.json()) as { requestId: string }).requestId
        }
        const response = await fetch(`${app.url}/v1/events/${last}`, { headers: { Authorization: `Bearer ${SK1}` } })
        return (await response.json()) as {
          risk: { factors: Array<{ id: string }> } | null
          decision: { action: string } | null
        }
      } finally {
        await app.close()
      }
    }

    const threeAccounts = (windowMinutes: number) => ({
      risk: { velocity: { windowMinutes, linkedIdsPerDevice: { threshold: 3, weight: 30 } } },
    })

    it('counts only the visits inside the window, the edge included', async () => {
      const ids = async (windowMinutes: number) =>
        (await accountsAt(threeAccounts(windowMinutes), [0, 30, 60])).risk?.factors.map((f) => f.id)
      assert.deepEqual(await ids(60), ['velocity:linked_ids_per_device'], 'the first visit is exactly at the edge')
      assert.deepEqual(await ids(59), [], 'one minute less leaves it out')
      assert.deepEqual(await ids(1440), ['velocity:linked_ids_per_device'])
    })

    it('lets a rule use the numbers even when the composite risk is off', async () => {
      const event = await accountsAt(
        {
          risk: { enabled: false, velocity: { windowMinutes: 120 } },
          rules: {
            list: [
              { id: 'many', when: { field: 'velocity.linkedIdsPerDevice', op: 'gte', value: 3 }, decision: 'review' },
            ],
          },
        },
        [0, 30, 60],
      )
      assert.equal(event.risk, null)
      assert.equal(event.decision?.action, 'review')
    })
  })

  it('gives the same visitor id to the same device and a different one to another device', async () => {
    const app = await startWithIdentity()
    try {
      // Other devices first, so that the signals of the device below are rare enough to convince
      for (let n = 1; n <= 6; n++) {
        await visit(app.url, n)
      }
      const first = await identityOf(app.url, await visit(app.url, 7))
      const again = await identityOf(app.url, await visit(app.url, 7))
      const other = await identityOf(app.url, await visit(app.url, 8))
      assert.equal(first?.matched, false)
      assert.equal(again?.matched, true)
      assert.equal(again?.visitorId, first?.visitorId)
      assert.notEqual(other?.visitorId, first?.visitorId)
      assert.equal(other?.matched, false)
    } finally {
      await app.close()
    }
  })

  it('tells the backend why, and says that the probability is provisional', async () => {
    const app = await startWithIdentity()
    try {
      for (let n = 1; n <= 6; n++) {
        await visit(app.url, n)
      }
      await visit(app.url, 7)
      const again = await identityOf(app.url, await visit(app.url, 7))
      assert.equal(again?.calibrated, false)
      assert.equal(again?.probability, null, 'no probability is offered before the model is fitted')
      assert.ok((again?.provisionalProbability ?? 0) > 0.9)
      assert.ok(again?.explanation.length > 0)
      assert.ok(again?.explanation.some((item: { feature: string }) => item.feature === 'canvas'))
      assert.ok(again?.candidates >= 1)
    } finally {
      await app.close()
    }
  })

  it('gives the browser nothing but the request id, even though the server knows the visitor', async () => {
    const app = await startWithIdentity()
    try {
      await visit(app.url, 1)
      const response = await post(app.url, richPayload(await nonceFor(app.url), 1))
      const body = await response.json()
      assert.deepEqual(Object.keys(body as object), ['requestId'])
      assert.ok(!JSON.stringify(body).includes('v_'))
    } finally {
      await app.close()
    }
  })

  it('keeps the visitors of each tenant apart', async () => {
    const app = await startWithIdentity()
    try {
      for (let n = 1; n <= 5; n++) {
        await visit(app.url, n)
      }
      await visit(app.url, 7)
      const sameDeviceOtherTenant = await identityOf(app.url, await visit(app.url, 7, {}, PK2), SK2)
      assert.equal(sameDeviceOtherTenant?.matched, false)
      assert.equal(sameDeviceOtherTenant?.devices, 0, 'the other tenant knows no device yet')
    } finally {
      await app.close()
    }
  })

  it('shows no identity when the engine is off', async () => {
    const app = await start()
    try {
      const requestId = await visit(app.url, 1)
      assert.equal(await identityOf(app.url, requestId), null)
    } finally {
      await app.close()
    }
  })

  it('does not lose the visit when the engine fails', async () => {
    const logs: Array<Record<string, unknown>> = []
    const broken = {
      resolve: () => {
        throw new Error('boom')
      },
      getResolution: () => undefined,
    } as unknown as IdentityEngine
    const app = await start({}, { identity: broken, log: (entry) => logs.push(entry) })
    try {
      const requestId = await visit(app.url, 1)
      assert.ok(app.store.getEvent('t1', requestId), 'the event is stored')
      assert.ok(logs.some((entry) => entry.route === 'identity_failed' && entry.error === 'boom'))
      assert.equal(await identityOf(app.url, requestId), null)
    } finally {
      await app.close()
    }
  })

  it('does not treat a visit seen through a proxy as having the order of headers of the visitor', async () => {
    const app = await startWithIdentity({ trustedProxies: ['127.0.0.0/8'] })
    try {
      for (let n = 1; n <= 4; n++) {
        await visit(app.url, n)
      }
      const requestId = await visit(app.url, 9)
      const identity = await identityOf(app.url, requestId)
      assert.ok(identity)
      assert.ok(!identity.explanation.some((item: { feature: string }) => item.feature === 'headerOrder'))
    } finally {
      await app.close()
    }
  })
})

describe('settings per tenant', () => {
  const tenants = (first: Record<string, unknown>, second: Record<string, unknown> = {}) => [
    { id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)], settings: first },
    { id: 't2', publicKey: PK2, secretKeySha256: [sha256Hex(SK2)], settings: second },
  ]

  it('gives the matcher the numbers of the tenant that is visiting', async () => {
    const calls: Array<{ tenant: string; params: Record<string, unknown>; features: string[] }> = []
    const base = new IdentityEngine(new MemoryIdentityStore(), lenientModel())
    const spy = Object.assign(Object.create(base) as IdentityEngine, {
      resolve: (tenant: string, _id: string, features: Record<string, string>, _at: number, params: object) => {
        calls.push({ tenant, params: { ...params }, features: Object.keys(features) })
        return {} as never
      },
    })
    const app = await start(
      {
        tenants: tenants(
          {
            identity: {
              maxCandidates: 7,
              ambiguityMargin: 3.5,
              explanationSize: 4,
              possibleLinkProbability: 0.3,
              matchProbability: 0.9,
              disabledFeatures: ['canvas'],
            },
          },
          { identity: { maxCandidates: 11 } },
        ),
        requireNonce: false,
      },
      { identity: spy },
    )
    try {
      await post(app.url, payload(), PK1)
      await post(app.url, payload(), PK2)
      assert.equal(calls.length, 2)
      const [first, second] = calls
      assert.equal(first.tenant, 't1')
      assert.equal(first.params.maxCandidates, 7)
      assert.equal(first.params.ambiguityMargin, 3.5)
      assert.equal(first.params.explanationSize, 4)
      assert.equal(first.params.possibleLinkProbability, 0.3)
      assert.equal(first.params.onAmbiguous, 'separate', 'the default does not link a doubtful visit')
      assert.equal((first.params.model as { matchProbability: number }).matchProbability, 0.9)
      assert.equal(first.params.learn, true)
      assert.ok(!first.features.includes('canvas'))
      assert.equal(second.tenant, 't2')
      assert.equal(second.params.maxCandidates, 11)
      assert.equal(second.params.ambiguityMargin, 2, 'the other tenant keeps the default')
      assert.equal(second.params.possibleLinkProbability, null)
    } finally {
      await app.close()
    }
  })

  it('limits each tenant by its own number', async () => {
    const app = await start({ tenants: tenants({ limits: { collectPerMinutePerIp: 1 } }), requireNonce: false })
    try {
      assert.deepEqual(
        [(await post(app.url, payload(), PK1)).status, (await post(app.url, payload(), PK1)).status],
        [200, 429],
      )
      for (let i = 0; i < 4; i++) {
        assert.equal((await post(app.url, payload(), PK2)).status, 200, 'the other tenant is not touched')
      }
    } finally {
      await app.close()
    }
  })

  it('asks for a nonce from one tenant and not from the other', async () => {
    const app = await start({ tenants: tenants({}, { nonce: { required: false } }) })
    try {
      assert.equal((await post(app.url, payload(), PK1)).status, 400)
      assert.equal((await post(app.url, payload(), PK2)).status, 200)
    } finally {
      await app.close()
    }
  })

  it('takes a different body size for each tenant', async () => {
    const app = await start({ tenants: tenants({ limits: { maxBodyBytes: 1500 } }), requireNonce: false })
    try {
      const big = payload(undefined, { libVersion: 'x'.repeat(2000) as never })
      assert.equal((await post(app.url, big, PK1)).status, 413)
      assert.equal((await post(app.url, big, PK2)).status, 422, 'the other tenant reads it and finds it invalid')
    } finally {
      await app.close()
    }
  })

  it('lets a tenant turn the client binding of the challenge off', async () => {
    const app = await start({ tenants: tenants({ nonce: { bindToClient: false } }) })
    try {
      const mismatched = async (pk: string) => {
        const nonce = await nonceFor(app.url, pk, 'client one')
        const { requestId } = (await (
          await post(app.url, payload(nonce), pk, { ...json, 'User-Agent': 'client two' })
        ).json()) as {
          requestId: string
        }
        return app.store.getEvent(pk === PK1 ? 't1' : 't2', requestId)?.derived.nonceContext
      }
      assert.equal(await mismatched(PK1), 'none', 'no binding, so nothing to compare')
      assert.equal(await mismatched(PK2), 'mismatch')
    } finally {
      await app.close()
    }
  })

  it('gives a challenge a life of the length that the tenant chose', async () => {
    let clock = 1_700_000_000_000
    const app = await start({ tenants: tenants({ nonce: { ttlSeconds: 30 } }) }, { now: () => clock })
    try {
      const short = await nonceFor(app.url, PK1)
      const long = await nonceFor(app.url, PK2)
      clock += 60_000
      assert.deepEqual(await (await post(app.url, payload(short), PK1)).json(), {
        error: 'invalid_nonce',
        reason: 'expired',
      })
      assert.equal((await post(app.url, payload(long), PK2)).status, 200)
    } finally {
      await app.close()
    }
  })

  it('uses a new limit as soon as the settings are reloaded, without losing the other counts', async () => {
    const app = await start({ tenants: tenants({ limits: { collectPerMinutePerIp: 100 } }), requireNonce: false })
    const settings = new SettingsRegistry(app.config)
    const live = await start(
      { tenants: tenants({ limits: { collectPerMinutePerIp: 100 } }), requireNonce: false },
      { settings },
    )
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await post(live.url, payload(), PK1)).status, 200)
      }
      settings.reload(baseConfig({ tenants: tenants({ limits: { collectPerMinutePerIp: 1 } }), requireNonce: false }))
      // The counter was replaced with the new limit, so the next requests are judged by it
      const statuses = [(await post(live.url, payload(), PK1)).status, (await post(live.url, payload(), PK1)).status]
      assert.deepEqual(statuses, [200, 429])
    } finally {
      await app.close()
      await live.close()
    }
  })
})

describe('the environment of the visit', () => {
  async function eventAfter(settings: Record<string, unknown>, components: Record<string, unknown>, quota?: number) {
    const app = await start({
      tenants: [{ id: 't1', publicKey: PK1, secretKeySha256: [sha256Hex(SK1)], settings }],
    })
    try {
      const body = payload(await nonceFor(app.url, PK1), {
        components: components as never,
        extended: quota === undefined ? {} : { storageQuota: { value: quota, duration: 1 } },
      })
      const { requestId } = (await (await post(app.url, body, PK1)).json()) as { requestId: string }
      return (await (
        await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK1}` } })
      ).json()) as {
        environment: { signals: Array<{ id: string }> } | null
        risk: { score: number; factors: Array<{ id: string; weight: number }> }
      }
    } finally {
      await app.close()
    }
  }

  const vm = { webGlBasics: { value: { rendererUnmasked: 'VMware SVGA 3D', renderer: 'x' }, duration: 1 } }
  const real = {
    webGlBasics: { value: { rendererUnmasked: 'ANGLE (Apple, Apple M1)', renderer: 'x' }, duration: 1 },
  }

  it('shows what it finds, and weighs nothing until the tenant gives it a weight', async () => {
    const event = await eventAfter({}, vm, 50_000_000)
    assert.deepEqual(event.environment?.signals.map((signal) => signal.id).sort(), [
      'private_mode_likely',
      'virtual_machine_gpu',
    ])
    assert.equal(event.risk.score, 0)
    assert.deepEqual(event.risk.factors, [])
  })

  it('weighs what the tenant says is worth something, and nothing for an ordinary machine', async () => {
    const weights = { risk: { environmentWeights: { virtual_machine_gpu: 20 } } }
    const event = await eventAfter(weights, vm)
    assert.deepEqual(
      event.risk.factors.map((factor) => [factor.id, factor.weight]),
      [['environment:virtual_machine_gpu', 20]],
    )
    const ordinary = await eventAfter(weights, real, 300_000_000_000)
    assert.deepEqual(ordinary.environment, { signals: [] })
    assert.equal(ordinary.risk.score, 0)
  })

  it('can be turned off', async () => {
    const event = await eventAfter({ environment: { enabled: false } }, vm)
    assert.equal(event.environment, null)
  })
})

describe('evidence of tampering', () => {
  const macUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/155.0.0.0 Safari/537.36'
  const asMac = { ...json, 'User-Agent': macUserAgent }

  interface TamperView {
    signals: Array<{ id: string; severity: string; detail: string }>
    counts: { high: number; medium: number; low: number }
  }

  async function tamperOf(url: string, requestId: string, secret = SK1): Promise<TamperView> {
    const response = await fetch(`${url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${secret}` } })
    return ((await response.json()) as { tamper: TamperView }).tamper
  }

  it('finds nothing in a visit whose views agree', async () => {
    const app = await start()
    try {
      const body = payload(await nonceFor(app.url, PK1, macUserAgent), {
        components: { platform: { value: 'MacIntel', duration: 1 } },
      })
      const response = await post(app.url, body, PK1, asMac)
      const { requestId } = (await response.json()) as { requestId: string }
      assert.deepEqual(await tamperOf(app.url, requestId), { signals: [], counts: { high: 0, medium: 0, low: 0 } })
    } finally {
      await app.close()
    }
  })

  it('shows the contradiction between the header and the script, with what disagrees', async () => {
    const app = await start()
    try {
      const body = payload(await nonceFor(app.url, PK1, macUserAgent), {
        components: { platform: { value: 'Win32', duration: 1 } },
      })
      const { requestId } = (await (await post(app.url, body, PK1, asMac)).json()) as { requestId: string }
      const tamper = await tamperOf(app.url, requestId)
      assert.equal(tamper.counts.high, 1)
      assert.equal(tamper.signals[0].id, 'platform_inconsistent')
      assert.match(tamper.signals[0].detail, /user-agent header says macos.*navigator\.platform says windows/)
    } finally {
      await app.close()
    }
  })

  it('notices a challenge fetched by one client and used by another', async () => {
    const app = await start()
    try {
      const nonce = await nonceFor(app.url, PK1, macUserAgent)
      const { requestId } = (await (
        await post(app.url, payload(nonce), PK1, { ...json, 'User-Agent': 'python-requests/2.31' })
      ).json()) as {
        requestId: string
      }
      assert.deepEqual(
        (await tamperOf(app.url, requestId)).signals.map((signal) => signal.id),
        ['nonce_context_mismatch'],
      )
      assert.equal(app.store.getEvent('t1', requestId)?.derived.nonceContext, 'mismatch')
    } finally {
      await app.close()
    }
  })

  it('does not notice anything when the same client fetched and sent', async () => {
    const app = await start()
    try {
      const nonce = await nonceFor(app.url, PK1, macUserAgent)
      const { requestId } = (await (await post(app.url, payload(nonce), PK1, asMac)).json()) as { requestId: string }
      assert.equal(app.store.getEvent('t1', requestId)?.derived.nonceContext, 'match')
      assert.deepEqual((await tamperOf(app.url, requestId)).signals, [])
    } finally {
      await app.close()
    }
  })

  it('still accepts the visit when the context differs: it is evidence, not a rejection', async () => {
    const app = await start()
    try {
      const nonce = await nonceFor(app.url, PK1, macUserAgent)
      const response = await post(app.url, payload(nonce), PK1, { ...json, 'User-Agent': 'something else' })
      assert.equal(response.status, 200)
    } finally {
      await app.close()
    }
  })

  it('keeps the evidence private to the tenant, like the rest of the event', async () => {
    const app = await start()
    try {
      const { requestId } = (await (await post(app.url, payload(await nonceFor(app.url)))).json()) as {
        requestId: string
      }
      const response = await fetch(`${app.url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${SK2}` } })
      assert.equal(response.status, 404)
    } finally {
      await app.close()
    }
  })
})

describe('HTTP/2', () => {
  it('records the HTTP/2 settings and the order of the pseudo-headers', async () => {
    const app = await start({}, {}, 'http2')
    const session = http2.connect(app.url, { settings: { initialWindowSize: 6291456, enablePush: false } })
    try {
      const request = (path: string, method: string, body?: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const stream = session.request({
            ':method': method,
            ':path': path,
            'content-type': 'application/json',
            'user-agent': 'h2-test',
          })
          let text = ''
          let status = 0
          stream.on('response', (headers) => (status = Number(headers[':status'])))
          stream.on('data', (chunk) => (text += chunk))
          stream.on('end', () => resolve({ status, body: text }))
          stream.on('error', reject)
          stream.end(body)
        })

      const nonce = JSON.parse((await request(`/v1/nonce?k=${PK1}`, 'GET')).body).nonce
      const collected = await request(`/v1/collect?k=${PK1}`, 'POST', JSON.stringify(payload(nonce)))
      assert.equal(collected.status, 200)
      const { requestId } = JSON.parse(collected.body)

      const event = app.store.getEvent('t1', requestId)
      assert.equal(event?.network.httpVersion, '2.0')
      assert.equal(event?.network.http2?.pseudoHeaderOrder.length, 4)
      assert.deepEqual([...(event?.network.http2?.pseudoHeaderOrder ?? '')].sort(), ['a', 'm', 'p', 's'])
      assert.equal(event?.network.http2?.settings['4'], 6291456)
      assert.equal(event?.network.http2?.settings['2'], 0)
      assert.match(event?.network.http2?.fp ?? '', /^[0-9a-f]{16}$/)
      assert.equal(
        event?.network.headers.casing,
        'l'.repeat(event?.network.headers.order.length ?? 0),
        'HTTP/2 names are always lower case',
      )
      assert.ok(!event?.network.headers.order.some((name) => name.startsWith(':')))
    } finally {
      session.close()
      await app.close()
    }
  })
})
