import assert from 'node:assert/strict'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import { describe, it } from 'node:test'

import { createApp } from './app'
import { Config, parseConfig, sha256Hex } from './config'
import { IdentityEngine } from './identity/engine'
import { MemoryIdentityStore } from './identity/memory_store'
import { defaultModel } from './identity/model'
import { CollectPayload } from './ingest/validate'
import { CidrListProvider, noIpIntel, parseCidrList } from './net/ip_intel'
import { MemoryEventStore } from './store/memory'
import { ConnectionRegistry } from './tls/tls_front'

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
    const identityStore = new MemoryIdentityStore()
    const identity = new IdentityEngine(identityStore, defaultModel())
    return start(configOverrides, { store, registry, identity })
  }

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
