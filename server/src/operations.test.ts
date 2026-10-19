import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { startServer } from './server'
import { MemoryEventStore } from './store/memory'

const PK = 'pk_ops_0123456789abcdef'
const SK = 'sk_ops_secret_sentinel'
const ADMIN = 'adm_ops_secret_sentinel'
const METRICS = 'mtr_ops_secret_sentinel'

const config = (extra: Record<string, unknown> = {}) =>
  parseConfig({
    nonceSecret: 'n'.repeat(32),
    trustedProxies: ['127.0.0.0/8'],
    tenants: [{ id: 'ops', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
    adminKeySha256: [sha256Hex(ADMIN)],
    metricsKeySha256: [sha256Hex(METRICS)],
    rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    ...extra,
  })

const get = (port: number, path: string, key?: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
  })

async function visit(port: number, extra: Record<string, unknown> = {}) {
  const signal = (value: unknown) => ({ value, duration: 1 })
  const headers = { 'x-forwarded-for': '198.51.100.77', 'user-agent': 'SENTINEL-UA/1.0' }
  const { nonce } = (await (await get(port, `/v1/nonce?k=${PK}`, undefined, headers)).json()) as { nonce: string }
  return fetch(`http://127.0.0.1:${port}/v1/collect?k=${PK}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now(),
      durationMs: 1,
      nonce,
      linkedId: 'sentinel-linked-id',
      components: { canvas: signal({ winding: true, geometry: 'sentinel-canvas', text: 't' }), fonts: signal(['f']) },
      extended: {},
      ...extra,
    }),
  })
}

describe('/metrics', () => {
  it('is off without a key, and needs the key when there is one', async () => {
    const off = await startServer(config({ metricsKeySha256: undefined }), { port: 0 })
    try {
      assert.equal((await get(off.port, '/metrics', METRICS)).status, 404)
    } finally {
      await off.close()
    }
    const on = await startServer(config(), { port: 0 })
    try {
      assert.equal((await get(on.port, '/metrics')).status, 401)
      assert.equal((await get(on.port, '/metrics', 'mtr_wrong')).status, 401)
      assert.equal((await get(on.port, '/metrics', SK)).status, 401, 'a tenant key is not a metrics key')
      assert.equal((await get(on.port, '/metrics', ADMIN)).status, 401, 'an admin key is not a metrics key')
      assert.equal((await get(on.port, '/v1/events', METRICS)).status, 401, 'a metrics key reads no data')
      const response = await get(on.port, '/metrics', METRICS)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/)
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${on.port}/metrics`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${METRICS}` },
          })
        ).status,
        405,
      )
    } finally {
      await on.close()
    }
  })

  it('counts what happened, by route and by result, with nothing that a client chose', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      assert.equal((await visit(server.port)).status, 200)
      assert.equal((await visit(server.port)).status, 200)
      await get(server.port, '/v1/events', 'sk_wrong')
      await get(server.port, '/does/not/exist/SENTINEL-PATH')
      const text = await (await get(server.port, '/metrics', METRICS)).text()
      assert.match(text, /^fp_collects_total 2$/m)
      const resolutions = [...text.matchAll(/^fp_identity_resolutions_total\{result="(\w+)"\} (\d+)$/gm)]
      assert.equal(
        resolutions.reduce((sum, match) => sum + Number(match[2]), 0),
        2,
        'one result per visit',
      )
      assert.match(text, /fp_http_requests_total\{route="collect",status="2xx"\} 2/)
      assert.match(text, /fp_http_requests_total\{route="nonce",status="2xx"\} 2/)
      assert.match(text, /fp_http_requests_total\{route="error",status="4xx"\} 2/)
      assert.match(text, /fp_http_request_duration_seconds_count\{route="collect"\} 2/)
      assert.match(text, /^fp_tenants 1$/m)
      assert.match(text, /^fp_webhook_pending 0$/m)
      assert.match(text, /^fp_process_uptime_seconds \d+$/m)
      for (const sentinel of ['SENTINEL', '198.51.100', 'sentinel', SK, ADMIN, '/does/not']) {
        assert.ok(!text.includes(sentinel), `the page shows ${sentinel}`)
      }
    } finally {
      await server.close()
    }
  })

  it('counts the errors of the server apart from the refusals of clients', async () => {
    const store = new MemoryEventStore()
    const server = await startServer(config(), { port: 0, store })
    try {
      store.insertEvent = () => {
        throw new Error('disk full')
      }
      assert.equal((await visit(server.port)).status, 500)
      const text = await (await get(server.port, '/metrics', METRICS)).text()
      assert.match(text, /^fp_errors_total 1$/m)
      assert.match(text, /fp_http_requests_total\{route="error",status="5xx"\} 1/)
    } finally {
      await server.close()
    }
  })

  it('counts a refusal by quota and a refused request by its metric', async () => {
    const server = await startServer(
      config({
        tenants: [
          { id: 'ops', publicKey: PK, secretKeySha256: [sha256Hex(SK)], settings: { quota: { collectsPerMonth: 1 } } },
        ],
      }),
      { port: 0 },
    )
    try {
      await visit(server.port)
      assert.equal((await visit(server.port)).status, 429)
      const text = await (await get(server.port, '/metrics', METRICS)).text()
      assert.match(text, /fp_quota_rejected_total\{metric="collects"\} 1/)
    } finally {
      await server.close()
    }
  })
})

describe('/readyz', () => {
  it('says ready when the storage answers, and not ready when it does not', async () => {
    const store = new MemoryEventStore()
    const logs: Array<Record<string, unknown>> = []
    const server = await startServer(config(), { port: 0, store, log: (entry) => logs.push(entry) })
    try {
      const ok = await get(server.port, '/readyz')
      assert.equal(ok.status, 200)
      assert.deepEqual(await ok.json(), { ready: true })
      store.ping = () => {
        throw new Error('disk gone')
      }
      const bad = await get(server.port, '/readyz')
      assert.equal(bad.status, 503)
      assert.deepEqual(await bad.json(), { ready: false }, 'the reason is for the log, not for the caller')
      assert.ok(logs.some((entry) => entry.route === 'not_ready' && entry.error === 'disk gone'))
      assert.equal((await get(server.port, '/healthz')).status, 200, 'alive is not the same as ready')
    } finally {
      await server.close()
    }
  })

  it('says not ready when a webhook due has waited too long', async () => {
    let clock = Date.parse('2026-10-15T12:00:00Z')
    const server = await startServer(
      config({
        tenants: [
          {
            id: 'ops',
            publicKey: PK,
            secretKeySha256: [sha256Hex(SK)],
            settings: {
              webhooks: {
                endpoints: [{ id: 'main', url: 'https://hooks.example.com/x', secrets: ['a-secret-long-enough-1'] }],
              },
            },
          },
        ],
      }),
      { port: 0, now: () => clock, webhookIntervalMs: 3_600_000 },
    )
    try {
      assert.equal((await visit(server.port)).status, 200)
      assert.equal((await get(server.port, '/readyz')).status, 200)
      clock += 11 * 60 * 1000
      assert.equal((await get(server.port, '/readyz')).status, 503)
    } finally {
      await server.close()
    }
  })
})

describe('the log', () => {
  it('never holds an address, a key, a payload or what a visitor sent', async () => {
    const logs: Array<Record<string, unknown>> = []
    const server = await startServer(config(), { port: 0, log: (entry) => logs.push(entry) })
    try {
      const response = await visit(server.port)
      const { requestId } = (await response.json()) as { requestId: string }
      await get(server.port, `/v1/events/${requestId}`, SK)
      await get(server.port, '/v1/events?linkedId=sentinel-linked-id&ip=198.51.100.77', SK)
      await get(server.port, '/v1/events', 'sk_wrong_sentinel')
      await get(server.port, '/admin/v1/tenants', ADMIN)
      await get(server.port, '/admin/v1/tenants', 'adm_wrong_sentinel')
      await get(server.port, '/metrics', 'mtr_wrong_sentinel')
      await visit(server.port, { schema: 99 })
      await fetch(`http://127.0.0.1:${server.port}/v1/collect?k=${PK}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.77' },
        body: '{"sentinel-broken-json":',
      })
      const text = JSON.stringify(logs)
      assert.ok(logs.length > 5, 'there is a log to look at')
      for (const sentinel of [
        '198.51.100.77',
        '127.0.0.1',
        'SENTINEL-UA',
        'sentinel-canvas',
        'sentinel-linked-id',
        'sentinel',
        SK,
        ADMIN,
        METRICS,
      ]) {
        assert.ok(!text.includes(sentinel), `the log holds ${sentinel}`)
      }
      assert.ok(
        logs.every((entry) => typeof entry.route === 'string'),
        'every line says what it is',
      )
    } finally {
      await server.close()
    }
  })
})

describe('connection limit', () => {
  it('closes the connections past the limit, and serves again when some close', async () => {
    const server = await startServer(config({ maxConnections: 3 }), { port: 0 })
    const open = async () => {
      const socket = net.connect(server.port, '127.0.0.1')
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
      return socket
    }
    const held: net.Socket[] = []
    try {
      for (let i = 0; i < 3; i++) {
        held.push(await open())
      }
      const extra = await open()
      const closed = await new Promise<boolean>((resolve) => {
        extra.once('close', () => resolve(true))
        setTimeout(() => resolve(false), 1500)
      })
      assert.equal(closed, true, 'the fourth connection was closed by the server')
      held.pop()?.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal((await get(server.port, '/healthz')).status, 200)
    } finally {
      held.forEach((socket) => socket.destroy())
      await server.close()
    }
  })
})
