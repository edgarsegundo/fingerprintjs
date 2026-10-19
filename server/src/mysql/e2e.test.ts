import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'

import { parseConfig, sha256Hex } from '../config'
import { verifyWebhook } from '../sdk/signature'
import { startServer } from '../server'
import { mysqlAvailable, mysqlTestUrl, newMysqlDatabaseConfig } from '../testing/mysql'

const PK = 'pk_mysql_0123456789abcdef'
const SK = 'sk_mysql_secret'
const ADMIN = 'adm_mysql_secret'
const secret = 'a-webhook-secret-long-enough'

const signal = (value: unknown) => ({ value, duration: 1 })

/** The same device, with enough signals to be recognized */
const components = (variant = 0) => ({
  canvas: signal({ winding: true, geometry: `g${variant}`, text: 't' }),
  webGlBasics: signal({ rendererUnmasked: `gpu${variant}`, vendorUnmasked: 'vendor', renderer: 'r', vendor: 'v' }),
  fonts: signal([`f1-${variant}`, 'f2']),
  screenResolution: signal([1440 + variant, 900]),
  platform: signal(variant === 0 ? 'MacIntel' : 'Win32'),
  timezone: signal('America/Sao_Paulo'),
  hardwareConcurrency: signal(8 + variant),
  deviceMemory: signal(8),
})

describe('the whole server over MySQL', { skip: mysqlAvailable ? false : 'FP_TEST_MYSQL_URL is not set' }, () => {
  const drops: Array<() => Promise<void>> = []
  after(async () => {
    for (const drop of drops.splice(0)) {
      await drop()
    }
  })

  async function receiver() {
    const hits: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return {
      hits,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    }
  }

  async function configFor(database: Record<string, unknown>, hookUrl?: string) {
    return parseConfig({
      nonceSecret: 'n'.repeat(32),
      database,
      adminKeySha256: [sha256Hex(ADMIN)],
      defaults: { identity: { matchProbability: 0.95 } },
      tenants: [
        {
          id: 'm',
          publicKey: PK,
          secretKeySha256: [sha256Hex(SK)],
          settings: hookUrl
            ? {
                webhooks: {
                  endpoints: [{ id: 'main', url: hookUrl, secrets: [secret] }],
                  allowHttp: true,
                  allowPrivateNetworks: true,
                  baseDelaySeconds: 1,
                },
              }
            : {},
        },
      ],
      rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    })
  }

  const call = (port: number, path: string, key = SK, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers } })

  async function visit(port: number, pk = PK, linkedId = 'acct1', variant = 0) {
    const base = `http://127.0.0.1:${port}`
    const { nonce } = (await (await fetch(`${base}/v1/nonce?k=${pk}`)).json()) as { nonce: string }
    const response = await fetch(`${base}/v1/collect?k=${pk}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 1,
        libVersion: '5.3.0',
        collectedAt: Date.now(),
        durationMs: 1,
        nonce,
        linkedId,
        components: components(variant),
        extended: {},
      }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    return ((await response.json()) as { requestId: string }).requestId
  }

  async function until(condition: () => boolean, ms = 6000) {
    const deadline = Date.now() + ms
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(condition(), 'the condition was not reached in time')
  }

  it('collects, recognizes a device, lists, shows a visitor, and keeps all that across a restart', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const first = await startServer(await configFor(database), { port: 0 })
    let ids: string[]
    let visitorId: string
    try {
      ids = [await visit(first.port), await visit(first.port, PK, 'acct2'), await visit(first.port, PK, 'acct3')]
      const event = (await (await call(first.port, `/v1/events/${ids[2]}`)).json()) as {
        identity: { visitorId: string; matched: boolean; calibrated: boolean }
        risk: { score: number } | null
        tamper: unknown
      }
      assert.equal(event.identity.matched, true, 'the same device is recognized')
      assert.equal(event.identity.calibrated, false)
      visitorId = event.identity.visitorId
      const list = (await (await call(first.port, '/v1/events?order=asc')).json()) as {
        events: Array<{ requestId: string }>
      }
      assert.deepEqual(
        list.events.map((item) => item.requestId),
        ids,
      )
      const visitor = (await (await call(first.port, `/v1/visitors/${visitorId}`)).json()) as {
        visits: number
        events: unknown[]
      }
      assert.deepEqual([visitor.visits, visitor.events.length], [3, 3])
      const usage = (await (await call(first.port, '/v1/usage')).json()) as {
        totals: { collects: number; nonces: number }
      }
      assert.deepEqual([usage.totals.collects, usage.totals.nonces], [3, 3])
      const audit = (await (await call(first.port, '/v1/audit')).json()) as { entries: Array<{ action: string }> }
      assert.ok(audit.entries.some((entry) => entry.action === 'event.read'))
      assert.equal((await fetch(`http://127.0.0.1:${first.port}/readyz`)).status, 200)
      const metrics = await (await call(first.port, '/metrics')).status
      assert.ok([404, 401].includes(metrics), 'metrics are off without a key')
    } finally {
      await first.close()
    }

    // Another process, the same database
    const second = await startServer(await configFor(database), { port: 0 })
    try {
      const event = (await (await call(second.port, `/v1/events/${ids[0]}`)).json()) as { requestId: string }
      assert.equal(event.requestId, ids[0], 'the events are still there')
      const again = (await (await call(second.port, `/v1/events/${await visit(second.port, PK, 'acct4')}`)).json()) as {
        identity: { visitorId: string; matched: boolean }
      }
      assert.deepEqual([again.identity.matched, again.identity.visitorId], [true, visitorId], 'and so is the device')
    } finally {
      await second.close()
    }
  })

  it('answers the rights of a person: export, then delete, which forgets the device too', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const server = await startServer(await configFor(database), { port: 0 })
    try {
      const mine = [await visit(server.port, PK, 'acct1'), await visit(server.port, PK, 'acct1')]
      const keep = await visit(server.port, PK, 'acct2', 99)
      const exported = (await (await call(server.port, '/v1/subjects/export?linkedId=acct1')).json()) as {
        events: Array<{ requestId: string }>
        visitors: string[]
      }
      assert.deepEqual(
        exported.events.map((event) => event.requestId),
        mine,
      )
      const erased = (await (
        await call(server.port, '/v1/subjects?linkedId=acct1', SK, { method: 'DELETE' })
      ).json()) as {
        deleted: number
        devices: number
      }
      assert.equal(erased.deleted, 2)
      assert.equal(erased.devices, 1, 'the device that only they supported is forgotten')
      assert.equal((await call(server.port, `/v1/events/${mine[0]}`)).status, 404)
      assert.equal((await call(server.port, `/v1/events/${keep}`)).status, 200)
      const audit = (await (await call(server.port, '/v1/audit')).json()) as { entries: Array<{ action: string }> }
      assert.ok(audit.entries.some((entry) => entry.action === 'subject.delete'))
    } finally {
      await server.close()
    }
  })

  it('delivers a webhook that waited in MySQL across a restart', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const target = await receiver()
    try {
      const config = await configFor(database, target.url)
      const first = await startServer(config, { port: 0, webhookIntervalMs: 3_600_000 })
      const requestId = await visit(first.port)
      await first.close()
      assert.equal(target.hits.length, 0, 'it had not been sent yet')
      const second = await startServer(config, { port: 0, webhookIntervalMs: 20 })
      try {
        await until(() => target.hits.length === 1)
        const [hit] = target.hits
        assert.equal((JSON.parse(hit.body) as { visit: { requestId: string } }).visit.requestId, requestId)
        assert.equal(
          verifyWebhook({ secret, body: hit.body, signature: hit.headers['x-fingerprint-signature'] as string }),
          true,
        )
      } finally {
        await second.close()
      }
    } finally {
      await target.close()
    }
  })

  it('keeps the tenants made by the administrator, and their data apart', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const config = await configFor(database)
    const first = await startServer(config, { port: 0 })
    let created: { tenant: { publicKey: string }; secretKey: string }
    try {
      const response = await call(first.port, '/admin/v1/tenants', ADMIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'shop', settings: { quota: { collectsPerMonth: 100 } } }),
      })
      assert.equal(response.status, 201)
      created = (await response.json()) as typeof created
      await visit(first.port, created.tenant.publicKey, 'a1')
    } finally {
      await first.close()
    }
    const second = await startServer(config, { port: 0 })
    try {
      const events = (await (await call(second.port, '/v1/events', created.secretKey)).json()) as { events: unknown[] }
      assert.equal(events.events.length, 1, 'the tenant and its visit are still there')
      const mine = (await (await call(second.port, '/v1/events')).json()) as { events: unknown[] }
      assert.equal(mine.events.length, 0, 'and the other tenant sees none of it')
      const removed = await call(second.port, '/admin/v1/tenants/shop?confirm=shop', ADMIN, { method: 'DELETE' })
      assert.equal(removed.status, 200)
      assert.equal(((await removed.json()) as { events: number }).events, 1)
      assert.equal((await call(second.port, '/v1/events', created.secretKey)).status, 401)
    } finally {
      await second.close()
    }
  })

  it('refuses to start without a password, and with a database that cannot be reached', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const { password: _password, ...withoutPassword } = database
    delete process.env.FP_MYSQL_PASSWORD
    await assert.rejects(
      startServer(await configFor({ ...withoutPassword }), { port: 0 }),
      /password is not set.*FP_MYSQL_PASSWORD/,
    )
    // The password can come from the environment
    process.env.FP_MYSQL_PASSWORD = String(database.password)
    try {
      const server = await startServer(await configFor({ ...withoutPassword }), { port: 0 })
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/readyz`)).status, 200)
      await server.close()
    } finally {
      delete process.env.FP_MYSQL_PASSWORD
    }
    await assert.rejects(
      startServer(await configFor({ ...database, password: 'wrong-password' }), { port: 0 }),
      /Cannot connect to MySQL/,
    )
    await assert.rejects(
      startServer(await configFor({ ...database, port: 1, connectTimeoutMs: 1000 }), { port: 0 }),
      /Cannot connect to MySQL/,
    )
    assert.ok(mysqlTestUrl)
  })

  it('says not ready when the database goes away', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const server = await startServer(await configFor(database), { port: 0 })
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/readyz`)).status, 200)
      server.store.ping = () => Promise.reject(new Error('connection lost'))
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/readyz`)).status, 503)
    } finally {
      await server.close()
    }
  })

  it('works as one service when two servers share a database: the limit, the tenants and the devices', async () => {
    const { config: database, drop } = await newMysqlDatabaseConfig()
    drops.push(drop)
    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      database,
      sharedLimits: true,
      adminKeySha256: [sha256Hex(ADMIN)],
      defaults: { identity: { matchProbability: 0.95 }, tenants: { refreshSeconds: 1 } },
      tenants: [
        {
          id: 'm',
          publicKey: PK,
          secretKeySha256: [sha256Hex(SK)],
          settings: { limits: { noncePerMinutePerIp: 4 } },
        },
      ],
    })
    // The same minute for both, so that the count of a window cannot be split by a clock that moves on
    const fixed = Date.parse('2026-10-19T12:00:10Z')
    const a = await startServer(config, { port: 0, now: () => fixed })
    const b = await startServer(config, { port: 0, now: () => fixed })
    try {
      // One limit of four challenges a minute, however the requests are spread over the two servers
      const statuses: number[] = []
      for (let n = 0; n < 6; n++) {
        const port = n % 2 === 0 ? a.port : b.port
        statuses.push((await fetch(`http://127.0.0.1:${port}/v1/nonce?k=${PK}`)).status)
      }
      assert.deepEqual(statuses.sort(), [200, 200, 200, 200, 429, 429])

      // A tenant made on one server shows up on the other
      const made = await call(a.port, '/admin/v1/tenants', ADMIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'shop' }),
      })
      assert.equal(made.status, 201)
      const shop = (await made.json()) as { tenant: { publicKey: string }; secretKey: string }
      assert.equal((await fetch(`http://127.0.0.1:${a.port}/v1/nonce?k=${shop.tenant.publicKey}`)).status, 200)
      let seen = 0
      for (let waited = 0; waited < 6000 && seen !== 200; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        seen = (await fetch(`http://127.0.0.1:${b.port}/v1/nonce?k=${shop.tenant.publicKey}`)).status
      }
      assert.equal(seen, 200, 'the other server learned of the tenant')

      // The same device, seen by both servers at once, is one device
      const ids = await Promise.all(
        Array.from({ length: 6 }, (_, n) => visit(n % 2 === 0 ? a.port : b.port, shop.tenant.publicKey, `acct${n}`)),
      )
      const visitors = new Set<string>()
      for (const id of ids) {
        const event = (await (await call(b.port, `/v1/events/${id}`, shop.secretKey)).json()) as {
          identity: { visitorId: string }
        }
        visitors.add(event.identity.visitorId)
      }
      assert.equal(visitors.size, 1, 'one device, not one per server')
    } finally {
      await a.close()
      await b.close()
    }
  })
})
