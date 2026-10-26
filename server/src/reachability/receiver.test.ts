import assert from 'node:assert/strict'
import { request, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, it } from 'node:test'

import { parseAsnCsv } from '../net/asn'
import { parseCidr } from '../net/cidr'

import { createReceiverServer, prefixHash, ReceiverOptions } from './receiver'
import { ReportStore } from './store'

const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
const visitor = '203.0.113.9'
const browser = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537 Chrome/120 Mobile Safari/537'
const report = { v: 1, reason: 'script_unreachable', phase: 'script', probe: 'unreachable', elapsedMs: 8000 }

const running: Server[] = []
afterEach(() => {
  for (const server of running.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

async function start(overrides: Partial<ReceiverOptions> = {}, store = new ReportStore(':memory:')) {
  const server = createReceiverServer({
    store,
    secret,
    trustedProxies: [parseCidr('127.0.0.1') as NonNullable<ReturnType<typeof parseCidr>>],
    ...overrides,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  running.push(server)
  return { store, port: (server.address() as AddressInfo).port }
}

interface Answer {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

function send(
  port: number,
  options: { method?: string; path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/report',
        headers: { 'User-Agent': browser, 'X-Forwarded-For': visitor, ...options.headers },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const post = (port: number, body: unknown, headers: Record<string, string> = {}) =>
  send(port, { body: typeof body === 'string' ? body : JSON.stringify(body), headers })

describe('reachability receiver', () => {
  it('keeps a report and no address, no user agent and nothing the visitor was not asked for', async () => {
    const { port, store } = await start({ now: () => 1_000_000 })
    const answer = await post(port, {
      ...report,
      site: 'pk_abc123',
      url: 'https://app.example.com/?email=a@b.c',
      linkedId: 'user-42',
    })
    assert.equal(answer.status, 204)
    assert.equal(answer.body, '')
    const rows = store.dump()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].reason, 'script_unreachable')
    assert.equal(rows[0].received_at, 1_000_000)
    assert.equal(rows[0].browser, 'chrome')
    assert.equal(rows[0].mobile, 1)
    const everything = JSON.stringify(rows)
    for (const secretThing of [visitor, '203.0.113', 'Mozilla', 'AppleWebKit', 'user-42', 'email', 'app.example.com']) {
      assert.ok(!everything.includes(secretThing), `the store must not hold "${secretThing}": ${everything}`)
    }
  })

  it('tells a network apart by a keyed hash of its /24: same network same hash, other key other hash', () => {
    assert.equal(prefixHash(secret, '203.0.113.9'), prefixHash(secret, '203.0.113.200'))
    assert.notEqual(prefixHash(secret, '203.0.113.9'), prefixHash(secret, '203.0.114.9'))
    assert.notEqual(prefixHash(secret, '203.0.113.9'), prefixHash(Buffer.from('ff'.repeat(32), 'hex'), '203.0.113.9'))
    assert.equal(prefixHash(secret, '2804:14c:1:2:aaaa::1'), prefixHash(secret, '2804:14c:1:2:bbbb::9'), 'an IPv6 /64')
    assert.equal(prefixHash(secret, 'garbage'), undefined)
  })

  it('stores the number and the name of the network, never the address', async () => {
    const asn = parseAsnCsv('203.0.113.0/24,64500,Example Telecom', { from: 0, asn: 1, name: 2 })
    const { port, store } = await start({ asn })
    await post(port, report)
    await post(port, report, { 'X-Forwarded-For': '198.51.100.7' })
    const rows = store.dump()
    assert.equal(rows[0].asn, 64500)
    assert.equal(rows[0].network, 'Example Telecom')
    assert.equal(rows[1].asn, null, 'an address the file does not know has no network')
    assert.ok(typeof rows[1].prefix_hash === 'string' && rows[1].prefix_hash !== rows[0].prefix_hash)
    assert.ok(!JSON.stringify(rows).includes('203.0.113'))
  })

  it('checks the origin when some are set, and accepts any when none are', async () => {
    const { port: strict, store } = await start({ allowedOrigins: ['https://app.example.com'] })
    assert.equal((await post(strict, report, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await post(strict, report)).status, 403, 'a missing Origin is not enough')
    assert.equal((await post(strict, report, { Origin: 'https://app.example.com' })).status, 204)
    assert.equal(store.dump().length, 1)
    const { port: open } = await start()
    assert.equal((await post(open, report, { Origin: 'https://anything.example' })).status, 204)
  })

  it('limits one address, and a refused address does not use up the tokens of the others', async () => {
    const { port, store } = await start({ ratePerIp: 2, rateTotal: 3, now: () => 0 })
    assert.equal((await post(port, report)).status, 204)
    assert.equal((await post(port, report)).status, 204)
    const refused = await post(port, report)
    assert.equal(refused.status, 429)
    assert.ok(Number(refused.headers['retry-after']) > 0)
    for (let i = 0; i < 20; i++) {
      assert.equal((await post(port, report)).status, 429)
    }
    // The other address still has the third token of the total, so the flood above did not spend it
    assert.equal((await post(port, report, { 'X-Forwarded-For': '198.51.100.1' })).status, 204)
    assert.equal(store.dump().length, 3)
  })

  it('limits everybody together', async () => {
    const { port, store } = await start({ ratePerIp: 100, rateTotal: 3, now: () => 0 })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await post(port, report, { 'X-Forwarded-For': `198.51.100.${i + 1}` })).status)
    }
    assert.deepEqual(statuses, [204, 204, 204, 429, 429])
    assert.equal(store.dump().length, 3)
  })

  it('does not believe X-Forwarded-For from a connection that is not a trusted proxy', async () => {
    const { port } = await start({ trustedProxies: [], ratePerIp: 1, now: () => 0 })
    assert.equal((await post(port, report, { 'X-Forwarded-For': '198.51.100.1' })).status, 204)
    // Pretending to be somebody else does not give a new allowance
    assert.equal((await post(port, report, { 'X-Forwarded-For': '198.51.100.2' })).status, 429)
  })

  it('counts an IPv6 device by its /64, as it changes the rest of the address at will', async () => {
    const { port } = await start({ ratePerIp: 1, now: () => 0 })
    assert.equal((await post(port, report, { 'X-Forwarded-For': '2804:14c:1:2:aaaa::1' })).status, 204)
    assert.equal((await post(port, report, { 'X-Forwarded-For': '2804:14c:1:2:bbbb::2' })).status, 429)
    assert.equal((await post(port, report, { 'X-Forwarded-For': '2804:14c:1:3:aaaa::1' })).status, 204)
  })

  it('refuses a body over the limit without storing it, and a body that is not a report', async () => {
    const { port, store } = await start()
    assert.equal((await post(port, JSON.stringify({ ...report, pad: 'x'.repeat(10_000) }))).status, 413)
    assert.equal((await post(port, '{"v":1,')).status, 400)
    assert.equal((await post(port, '')).status, 400)
    assert.equal((await post(port, { ...report, reason: 'hacked' })).status, 400)
    assert.equal((await post(port, [1, 2])).status, 400)
    assert.equal(store.dump().length, 0)
  })

  it('answers only the path, the method and the health check it has', async () => {
    const { port } = await start()
    assert.equal((await send(port, { path: '/other', body: '{}' })).status, 404)
    const get = await send(port, { method: 'GET', path: '/report' })
    assert.equal(get.status, 405)
    assert.equal(get.headers.allow, 'POST')
    assert.equal((await send(port, { method: 'GET', path: '/healthz' })).status, 200)
    assert.equal((await post(port, report)).status, 204, 'the query string is ignored')
    assert.equal((await send(port, { path: '/report?x=1', body: JSON.stringify(report) })).status, 204)
  })

  it('does not say the address in its answers', async () => {
    const { port } = await start({ allowedOrigins: ['https://app.example.com'], ratePerIp: 1, now: () => 0 })
    const answers = [
      await post(port, report, { Origin: 'https://app.example.com' }),
      await post(port, report, { Origin: 'https://app.example.com' }),
      await post(port, report, { Origin: 'https://bad.example' }),
      await post(port, 'nope', { Origin: 'https://app.example.com' }),
    ]
    for (const answer of answers) {
      assert.ok(!(answer.body + JSON.stringify(answer.headers)).includes(visitor))
    }
  })
})
