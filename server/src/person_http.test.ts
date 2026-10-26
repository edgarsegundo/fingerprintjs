import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { RunningServer, startServer } from './server'

const PK = 'pk_person_0123456789abcdef'
const SK = 'sk_person_secret'

const config = (settings: Record<string, unknown> = {}) =>
  parseConfig({
    nonceSecret: 'n'.repeat(32),
    // Mechanics of the server, not the bar of the matcher: a lower bar than the default, with few devices known
    defaults: { identity: { matchProbability: 0.9 } },
    tenants: [
      { id: 't', publicKey: PK, secretKeySha256: [sha256Hex(SK)], settings },
      { id: 'o', publicKey: 'pk_other_0123456789abcdef', secretKeySha256: [sha256Hex('sk_other')] },
    ],
    rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
  })

const signal = (value: unknown) => ({ value, duration: 1 })

const chromeUa =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/155.0.0.0 Safari/537.36'
const firefoxUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
const chromeGpu = 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)'
const firefoxGpu = 'Intel(R) HD Graphics 400, or similar'

const machine = (screen: number[] = [1792, 1120], zone = 'America/Sao_Paulo') => ({
  screenResolution: signal(screen),
  colorDepth: signal(30),
  colorGamut: signal('srgb'),
  hdr: signal(false),
  platform: signal('MacIntel'),
  timezone: signal(zone),
})

interface Visit {
  userAgent: string
  renderer: string
  linkedId?: string
  screen?: number[]
  pk?: string
}

async function visit(server: RunningServer, options: Visit): Promise<string> {
  const base = `http://127.0.0.1:${server.port}`
  const pk = options.pk ?? PK
  const { nonce } = (await (await fetch(`${base}/v1/nonce?k=${pk}`)).json()) as { nonce: string }
  const response = await fetch(`${base}/v1/collect?k=${pk}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': options.userAgent },
    body: JSON.stringify({
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now(),
      durationMs: 1,
      nonce,
      ...(options.linkedId ? { linkedId: options.linkedId } : {}),
      components: { ...machine(options.screen), webGlBasics: signal({ renderer: options.renderer, vendor: 'v' }) },
      extended: {},
    }),
  })
  assert.equal(response.status, 200)
  return ((await response.json()) as { requestId: string }).requestId
}

interface PersonBlock {
  devices: string[]
  linkedIds: string[]
  edges: Array<{ kind: string }>
  evidence: Array<{ kind: string }>
  evidenceDevices: string[]
  truncated: boolean
}

interface EventView {
  identity: { visitorId: string; matched: boolean }
  person: PersonBlock | null
  risk: { factors: Array<{ id: string; weight: number }> } | null
}

const get = (server: RunningServer, path: string, key = SK) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${key}` } })

const send = (server: RunningServer, method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const eventOf = async (server: RunningServer, requestId: string) =>
  (await (await get(server, `/v1/events/${requestId}`)).json()) as EventView

const personOf = async (server: RunningServer, visitorId: string) =>
  (await (await get(server, `/v1/visitors/${visitorId}/person`)).json()) as PersonBlock

const chrome = (linkedId?: string, extra: Partial<Visit> = {}): Visit => ({
  userAgent: chromeUa,
  renderer: chromeGpu,
  linkedId,
  ...extra,
})
const firefox = (linkedId?: string, extra: Partial<Visit> = {}): Visit => ({
  userAgent: firefoxUa,
  renderer: firefoxGpu,
  linkedId,
  ...extra,
})

describe('the person layer, through the server', () => {
  it('ties the same machine in two browsers, counts the accounts, and weighs several accounts', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      const first = await eventOf(server, await visit(server, chrome('acct-A')))
      const second = await eventOf(server, await visit(server, firefox('acct-B')))
      assert.notEqual(second.identity.visitorId, first.identity.visitorId, 'one id per browser')
      assert.deepEqual(
        [...(second.person?.devices ?? [])].sort(),
        [first.identity.visitorId, second.identity.visitorId].sort(),
      )
      assert.deepEqual(second.person?.linkedIds, ['acct-A', 'acct-B'])
      assert.deepEqual(
        second.person?.edges.map((edge) => edge.kind),
        ['same_machine'],
      )
      assert.ok(
        second.risk?.factors.some((factor) => factor.id === 'multi_account'),
        'two accounts over two devices',
      )
      const fromRoute = await personOf(server, first.identity.visitorId)
      assert.deepEqual(fromRoute.linkedIds, ['acct-A', 'acct-B'], 'from either device')
    } finally {
      await server.close()
    }
  })

  it('does not count the same account twice, and ties the browsers of one account', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      await visit(server, chrome('acct-A', { screen: [1000, 700] }))
      const second = await eventOf(server, await visit(server, firefox('acct-A', { screen: [800, 600] })))
      assert.equal(second.person?.devices.length, 2, 'the account id ties them even if the machines look different')
      assert.deepEqual(
        second.person?.edges.map((edge) => edge.kind),
        ['linked_id'],
      )
      assert.deepEqual(second.person?.linkedIds, ['acct-A'])
      assert.ok(!second.risk?.factors.some((factor) => factor.id === 'multi_account'))
    } finally {
      await server.close()
    }
  })

  it('keeps the address as evidence and groups nothing by it', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      await visit(server, chrome('acct-A', { screen: [1000, 700] }))
      const second = await eventOf(server, await visit(server, firefox('acct-B', { screen: [800, 600] })))
      assert.equal(second.person?.devices.length, 1, 'two different machines on one address are two people')
      assert.deepEqual(
        second.person?.evidence.map((edge) => edge.kind),
        ['network'],
      )
      assert.equal(second.person?.evidenceDevices.length, 1)
      assert.ok(!second.risk?.factors.some((factor) => factor.id === 'multi_account'))
    } finally {
      await server.close()
    }
  })

  it('lets a person reject a tie for good, confirm one, and take a decision back', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      const a = await eventOf(server, await visit(server, chrome('acct-A')))
      const b = await eventOf(server, await visit(server, firefox('acct-B')))
      const [x, y] = [a.identity.visitorId, b.identity.visitorId]
      assert.equal((await personOf(server, x)).devices.length, 2)

      assert.equal((await send(server, 'POST', `/v1/visitors/${x}/links`, { with: y, decision: 'reject' })).status, 200)
      assert.equal((await personOf(server, x)).devices.length, 1, 'rejected: not one person')
      const again = await eventOf(server, await visit(server, firefox('acct-B')))
      assert.equal(again.person?.devices.length, 1, 'a new visit does not bring the tie back')

      await send(server, 'POST', `/v1/visitors/${x}/links`, { with: y, decision: 'confirm' })
      assert.equal((await personOf(server, x)).devices.length, 2, 'confirmed: one person again')
      await send(server, 'POST', `/v1/visitors/${x}/links`, { with: y, decision: 'clear' })
      assert.equal(
        (await send(server, 'POST', `/v1/visitors/${x}/links`, { with: x, decision: 'confirm' })).status,
        409,
      )
      assert.equal((await send(server, 'POST', `/v1/visitors/${x}/links`, { with: y, decision: 'maybe' })).status, 400)
      assert.equal(
        (await send(server, 'POST', `/v1/visitors/${x}/links`, { with: 'nobody', decision: 'confirm' })).status,
        404,
      )
    } finally {
      await server.close()
    }
  })

  it('takes the ties out with the visits of a subject that is erased', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      const a = await eventOf(server, await visit(server, chrome('acct-A')))
      const b = await eventOf(server, await visit(server, firefox('acct-B')))
      assert.equal((await personOf(server, a.identity.visitorId)).devices.length, 2)
      assert.equal((await send(server, 'DELETE', '/v1/subjects?linkedId=acct-B')).status, 200)
      const left = await personOf(server, a.identity.visitorId)
      assert.deepEqual(left.devices, [a.identity.visitorId], 'the tie that came from the erased account is gone')
      assert.equal(b.identity.visitorId === a.identity.visitorId, false)
    } finally {
      await server.close()
    }
  })

  it('moves the ties along when two devices are merged', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      const a = await eventOf(server, await visit(server, chrome('acct-A')))
      const b = await eventOf(server, await visit(server, firefox('acct-B')))
      await visit(server, chrome('acct-C', { screen: [640, 480], renderer: 'ANGLE (NVIDIA, GeForce RTX 3060)' }))
      const c = await eventOf(
        server,
        await visit(server, chrome('acct-C', { screen: [640, 480], renderer: 'ANGLE (NVIDIA, GeForce RTX 3060)' })),
      )
      assert.ok(c.identity.visitorId)
      const merged = await send(server, 'POST', `/v1/visitors/${b.identity.visitorId}/merge`, {
        into: a.identity.visitorId,
      })
      assert.equal(merged.status, 200)
      const person = await personOf(server, a.identity.visitorId)
      assert.deepEqual(person.devices, [a.identity.visitorId], 'the tie between the two is gone, they are one device')
      assert.equal(
        (await send(server, 'GET', `/v1/visitors/${b.identity.visitorId}/person`)).status,
        200,
        'the old id still works',
      )
    } finally {
      await server.close()
    }
  })

  it('is off for a tenant that turned it off, and never crosses tenants', async () => {
    const server = await startServer(config({ identity: { person: { enabled: false } } }), { port: 0 })
    try {
      const a = await eventOf(server, await visit(server, chrome('acct-A')))
      const b = await eventOf(server, await visit(server, firefox('acct-B')))
      assert.equal(b.person, null)
      assert.equal((await get(server, `/v1/visitors/${a.identity.visitorId}/person`)).status, 404)
    } finally {
      await server.close()
    }
    const open = await startServer(config(), { port: 0 })
    try {
      const mine = await eventOf(open, await visit(open, chrome('acct-A')))
      await visit(open, firefox('acct-A', { pk: 'pk_other_0123456789abcdef' }))
      const person = await personOf(open, mine.identity.visitorId)
      assert.deepEqual(person.devices, [mine.identity.visitorId], 'the same account id in another tenant ties nothing')
      assert.equal((await get(open, `/v1/visitors/${mine.identity.visitorId}/person`, 'sk_other')).status, 404)
    } finally {
      await open.close()
    }
  })

  it('does not tie an account that is spread over more devices than the limit', async () => {
    const server = await startServer(config({ identity: { person: { maxDevices: 2 } } }), { port: 0 })
    try {
      await visit(server, chrome('shared', { screen: [100, 100], renderer: 'g1' }))
      await visit(server, chrome('shared', { screen: [200, 200], renderer: 'g2' }))
      const third = await eventOf(server, await visit(server, chrome('shared', { screen: [300, 300], renderer: 'g3' })))
      assert.equal(third.person?.devices.length, 1, 'a shared account is not one person')
      assert.deepEqual(third.person?.edges, [])
    } finally {
      await server.close()
    }
  })
})
