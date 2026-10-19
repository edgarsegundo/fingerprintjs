import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'

import { parseConfig, sha256Hex } from '../config'
import type { VisitSummary } from '../risk/assess'
import { verifyWebhook } from '../sdk/signature'
import { SettingsRegistry } from '../settings/settings'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage, newMysqlStorageWithDatabase } from '../testing/mysql'
import { MemoryUsageMeter } from '../usage/meter'

import { backoffMs, WebhookDispatcher } from './dispatcher'
import { endpointProblems, endpointWants, normalizeEndpoints, validateEndpoints, WebhookEndpoint } from './endpoints'
import { MemoryWebhookQueue, SqliteWebhookQueue, WebhookQueue } from './queue'
import { BlockedAddressError, isBlockedAddress, PostOptions, PostResult } from './safe_http'

const goodEndpoint = {
  id: 'main',
  url: 'https://hooks.example.com/fp',
  secrets: ['a-secret-of-enough-length'],
}

describe('webhook endpoints', () => {
  it('accepts a good endpoint and fills the optional fields', () => {
    assert.equal(validateEndpoints([goodEndpoint]), undefined)
    assert.equal(validateEndpoints([]), undefined)
    assert.deepEqual(normalizeEndpoints([goodEndpoint]), [{ ...goodEndpoint, minRiskScore: 0, decisions: [] }])
    assert.equal(
      validateEndpoints([
        {
          ...goodEndpoint,
          minRiskScore: 40,
          decisions: ['block', 'review'],
          secrets: ['x'.repeat(16), 'y'.repeat(16)],
        },
      ]),
      undefined,
    )
  })

  it('refuses what cannot work, naming the endpoint', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['x', /list/],
      [[5], /endpoint 0 must be an object/],
      [[{ ...goodEndpoint, id: 'Bad Id' }], /needs an id/],
      [[goodEndpoint, goodEndpoint], /appears twice/],
      [[{ ...goodEndpoint, extra: 1 }], /unknown key "extra"/],
      [[{ ...goodEndpoint, url: 5 }], /url must be text/],
      [[{ ...goodEndpoint, url: 'not a url' }], /not a valid address/],
      [[{ ...goodEndpoint, url: 'ftp://hooks.example.com' }], /must start with https/],
      [[{ ...goodEndpoint, url: 'https://user:pass@hooks.example.com' }], /user name or password/],
      [[{ ...goodEndpoint, secrets: [] }], /1 to 3 texts/],
      [[{ ...goodEndpoint, secrets: ['short'] }], /16 to 200/],
      [[{ ...goodEndpoint, secrets: ['x'.repeat(16), 'y'.repeat(16), 'z'.repeat(16), 'w'.repeat(16)] }], /1 to 3/],
      [[{ ...goodEndpoint, secrets: [5] }], /16 to 200/],
      [[{ ...goodEndpoint, minRiskScore: 101 }], /minRiskScore/],
      [[{ ...goodEndpoint, minRiskScore: '5' }], /minRiskScore/],
      [[{ ...goodEndpoint, decisions: ['Block'] }], /decisions/],
      [Array.from({ length: 21 }, (_, i) => ({ ...goodEndpoint, id: `e${i}` })), /at most 20/],
    ]
    for (const [value, expected] of cases) {
      const problem = validateEndpoints(value)
      assert.ok(problem && expected.test(problem), `${JSON.stringify(value).slice(0, 80)} gave ${problem}`)
    }
  })

  it('chooses the visits an endpoint asked for', () => {
    const visit = (risk: number | null, decision: string | null): VisitSummary => ({
      requestId: 'r',
      receivedAt: 1,
      linkedId: null,
      ip: '1.1.1.1',
      country: null,
      visitorId: null,
      matched: null,
      risk: risk === null ? null : { score: risk, level: 'low' },
      decision,
      tamper: null,
    })
    const endpoint = (extra: Partial<WebhookEndpoint>): WebhookEndpoint => ({
      ...normalizeEndpoints([goodEndpoint])[0],
      ...extra,
    })
    assert.equal(endpointWants(endpoint({}), visit(null, null)), true, 'everything by default')
    assert.equal(endpointWants(endpoint({ minRiskScore: 40 }), visit(40, null)), true, 'the limit is included')
    assert.equal(endpointWants(endpoint({ minRiskScore: 40 }), visit(39.9, null)), false)
    assert.equal(endpointWants(endpoint({ minRiskScore: 40 }), visit(null, null)), false, 'no risk is not enough')
    assert.equal(endpointWants(endpoint({ decisions: ['block'] }), visit(0, 'block')), true)
    assert.equal(endpointWants(endpoint({ decisions: ['block'] }), visit(0, 'review')), false)
    assert.equal(endpointWants(endpoint({ decisions: ['block'] }), visit(0, null)), false)
    assert.equal(
      endpointWants(endpoint({ minRiskScore: 40, decisions: ['block'] }), visit(90, 'review')),
      false,
      'both',
    )
  })

  it('finds the problems that depend on two settings', () => {
    const list = (url: string) => normalizeEndpoints([{ ...goodEndpoint, url }])
    const strict = { http: false, privateNetworks: false }
    assert.deepEqual(endpointProblems(list('https://hooks.example.com/x'), strict, isBlockedAddress), [])
    assert.match(endpointProblems(list('http://hooks.example.com/x'), strict, isBlockedAddress)[0], /allowHttp/)
    assert.match(endpointProblems(list('https://10.0.0.5/x'), strict, isBlockedAddress)[0], /private/)
    assert.match(endpointProblems(list('https://[::1]/x'), strict, isBlockedAddress)[0], /private/)
    assert.deepEqual(
      endpointProblems(list('http://10.0.0.5/x'), { http: true, privateNetworks: true }, isBlockedAddress),
      [],
    )
    assert.equal(
      endpointProblems(list('http://10.0.0.5/x'), { http: true, privateNetworks: false }, isBlockedAddress).length,
      1,
    )
  })
})

const queues: Array<[string, () => WebhookQueue | Promise<WebhookQueue>]> = [
  ['MemoryWebhookQueue', () => new MemoryWebhookQueue()],
  ['SqliteWebhookQueue', () => new SqliteWebhookQueue(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlWebhookQueue', async () => (await newMysqlStorage()).webhooks] as [string, () => Promise<WebhookQueue>]]
    : []),
]

for (const [name, create] of queues) {
  describe(name, () => {
    after(dropMysqlStorages)

    const delivery = (id: string, tenantId = 't1', createdAt = 1000) => ({
      id,
      tenantId,
      endpointId: 'main',
      body: `{"id":"${id}"}`,
      createdAt,
    })

    it('hands out what is due, the oldest first, and nothing before its time', async () => {
      const queue = await create()
      await queue.enqueue(delivery('b', 't1', 2000), 10)
      await queue.enqueue(delivery('a', 't1', 1000), 10)
      await queue.enqueue(delivery('c', 't1', 3000), 10)
      assert.deepEqual(
        (await queue.due(2000, 10)).map((item) => item.id),
        ['a', 'b'],
      )
      assert.deepEqual(await queue.due(999, 10), [])
      assert.deepEqual(
        (await queue.due(5000, 2)).map((item) => item.id),
        ['a', 'b'],
        'cut at the limit',
      )
      assert.equal((await queue.due(5000, 10))[0].body, '{"id":"a"}')
    })

    it('refuses to hold more than the limit for a tenant, and counts per tenant', async () => {
      const queue = await create()
      assert.equal(await queue.enqueue(delivery('a'), 2), true)
      assert.equal(await queue.enqueue(delivery('b'), 2), true)
      assert.equal(await queue.enqueue(delivery('c'), 2), false)
      assert.equal(await queue.enqueue(delivery('d', 't2'), 2), true, 'another tenant has its own room')
      assert.equal(await queue.pendingCount('t1'), 2)
      assert.equal(await queue.pendingCount('t2'), 1)
      await queue.markDone('a', 5000)
      assert.equal(await queue.enqueue(delivery('e'), 2), true, 'a finished one frees its place')
    })

    it('counts attempts and keeps the last error through retries, success and failure', async () => {
      const queue = await create()
      await queue.enqueue(delivery('a'), 10)
      await queue.enqueue(delivery('b'), 10)
      await queue.markRetry('a', 9000, 'boom')
      assert.deepEqual(
        (await queue.due(8999, 10)).map((item) => item.id),
        ['b'],
        'a waits for its time',
      )
      const retried = await queue.get('t1', 'a')
      assert.equal(retried?.attempts, 1)
      assert.equal(retried?.lastError, 'boom')
      assert.equal(retried?.nextAttemptAt, 9000)
      await queue.markDone('a', 9500)
      const done = await queue.get('t1', 'a')
      assert.deepEqual([done?.status, done?.attempts, done?.lastError, done?.finishedAt], ['done', 2, null, 9500])
      await queue.markFailed('b', 9600, 'gave up')
      const failed = await queue.get('t1', 'b')
      assert.deepEqual(
        [failed?.status, failed?.attempts, failed?.lastError, failed?.finishedAt],
        ['failed', 1, 'gave up', 9600],
      )
      assert.deepEqual(await queue.due(99999, 10), [], 'finished ones are never handed out')
    })

    it('lists a tenant newest first by status, and never shows another tenant', async () => {
      const queue = await create()
      await queue.enqueue(delivery('a', 't1', 1000), 10)
      await queue.enqueue(delivery('b', 't1', 2000), 10)
      await queue.enqueue(delivery('c', 't2', 3000), 10)
      await queue.markFailed('a', 5000, 'x')
      assert.deepEqual(
        (await queue.list('t1', { limit: 10 })).map((item) => item.id),
        ['b', 'a'],
      )
      assert.deepEqual(
        (await queue.list('t1', { status: 'failed', limit: 10 })).map((item) => item.id),
        ['a'],
      )
      assert.deepEqual(
        (await queue.list('t1', { limit: 1 })).map((item) => item.id),
        ['b'],
      )
      assert.equal(await queue.get('t2', 'a'), undefined)
    })

    it('puts only a failed delivery of the tenant back, to be sent now', async () => {
      const queue = await create()
      await queue.enqueue(delivery('a'), 10)
      assert.equal(await queue.retry('t1', 'a', 7000), false, 'pending is not failed')
      await queue.markFailed('a', 5000, 'x')
      assert.equal(await queue.retry('t2', 'a', 7000), false, 'not another tenant')
      assert.equal(await queue.retry('t1', 'nope', 7000), false)
      assert.equal(await queue.retry('t1', 'a', 7000), true)
      const back = await queue.get('t1', 'a')
      assert.deepEqual([back?.status, back?.nextAttemptAt, back?.finishedAt], ['pending', 7000, null])
    })

    it('deletes the deliveries that tell about a visit, whatever their status, for one tenant', async () => {
      const queue = await create()
      const about = (id: string, requestId: string, tenantId = 't1') => ({
        id,
        tenantId,
        endpointId: 'main',
        body: JSON.stringify({ id, visit: { requestId } }),
        createdAt: 1,
      })
      await queue.enqueue(about('p', 'req-1'), 10)
      await queue.enqueue(about('d', 'req-1'), 10)
      await queue.enqueue(about('f', 'req-2'), 10)
      await queue.enqueue(about('keep', 'req-3'), 10)
      await queue.enqueue(about('other', 'req-1', 't2'), 10)
      await queue.markDone('d', 5)
      await queue.markFailed('f', 5, 'x')
      assert.equal(await queue.deleteForRequests('t1', ['req-1', 'req-2', 'req-nothing']), 3)
      assert.deepEqual(
        (await queue.list('t1', { limit: 10 })).map((item) => item.id),
        ['keep'],
      )
      assert.ok(await queue.get('t2', 'other'), 'another tenant keeps its own')
      assert.equal(await queue.deleteForRequests('t1', []), 0)
      // "req-3" must not match a longer id that starts with it
      await queue.enqueue(about('longer', 'req-33'), 10)
      assert.equal(await queue.deleteForRequests('t1', ['req-3']), 1)
      assert.ok(await queue.get('t1', 'longer'))
    })

    it('purges finished deliveries of one tenant by their own ages, and nothing else', async () => {
      const queue = await create()
      for (const id of ['done_old', 'done_new', 'failed_old', 'failed_new', 'pending', 'other_old']) {
        await queue.enqueue(delivery(id, id === 'other_old' ? 't2' : 't1'), 10)
      }
      await queue.markDone('done_old', 100)
      await queue.markDone('done_new', 900)
      await queue.markFailed('failed_old', 100, 'x')
      await queue.markFailed('failed_new', 900, 'x')
      await queue.markDone('other_old', 100)
      assert.equal(
        await queue.purgeTenant('t1', 500, 50),
        1,
        'the old done one; the failed one is not old enough for its limit',
      )
      assert.equal(await queue.purgeTenant('t1', 500, 500), 1, 'now the old failed one')
      const left = (await queue.list('t1', { limit: 10 })).map((item) => item.id).sort()
      assert.deepEqual(left, ['done_new', 'failed_new', 'pending'])
      assert.ok(await queue.get('t2', 'other_old'), 'the other tenant keeps its own')
    })
  })
}

describe('WebhookDispatcher', () => {
  const secret = 'a-secret-of-enough-length'
  const config = (settings: Record<string, unknown> = {}) =>
    parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [
        {
          id: 't1',
          publicKey: 'pk_dispatcher_0123456789',
          secretKeySha256: [sha256Hex('sk_x')],
          settings: {
            webhooks: {
              endpoints: [{ id: 'main', url: 'https://hooks.example.com/fp', secrets: [secret] }],
              ...settings,
            },
          },
        },
      ],
    })

  interface Call {
    url: string
    body: string
    headers: Record<string, string>
    options: PostOptions
  }

  async function setup(
    settings: Record<string, unknown> = {},
    answer: (call: Call, n: number) => Promise<PostResult> | PostResult = () => ({ status: 200, body: '' }),
  ) {
    let clock = 1_800_000_000_000
    const calls: Call[] = []
    const queue = new MemoryWebhookQueue()
    const logs: Array<Record<string, unknown>> = []
    const usage = new MemoryUsageMeter()
    const dispatcher = new WebhookDispatcher({
      queue,
      usage,
      settings: new SettingsRegistry(config(settings)),
      now: () => clock,
      log: (entry) => logs.push(entry),
      post: async (url, body, headers, options) => {
        const call = { url, body, headers, options }
        calls.push(call)
        return answer(call, calls.length)
      },
    })
    await queue.enqueue({ id: 'd1', tenantId: 't1', endpointId: 'main', body: '{"hello":1}', createdAt: clock }, 100)
    return { queue, dispatcher, calls, logs, usage, advance: (ms: number) => (clock += ms), clock: () => clock }
  }

  it('sends the body signed, with the delivery id and attempt, and marks it done', async () => {
    const { queue, dispatcher, calls } = await setup()
    assert.equal(await dispatcher.tick(), 1)
    const [call] = calls
    assert.equal(call.url, 'https://hooks.example.com/fp')
    assert.equal(call.body, '{"hello":1}')
    assert.equal(call.headers['X-Fingerprint-Delivery'], 'd1')
    assert.equal(call.headers['X-Fingerprint-Attempt'], '1')
    assert.equal(call.options.timeoutMs, 10_000)
    assert.equal(call.options.allowPrivateNetworks, false)
    assert.equal(
      verifyWebhook({
        secret,
        body: call.body,
        signature: call.headers['x-fingerprint-signature'],
        now: () => 1_800_000_000_000,
      }),
      true,
    )
    assert.equal((await queue.get('t1', 'd1'))?.status, 'done')
    assert.equal(await dispatcher.tick(), 0, 'nothing is sent twice')
  })

  it('counts the deliveries that went through and the ones that gave up, not those to be retried', async () => {
    const month = new Date(1_800_000_000_000).toISOString().slice(0, 7)
    const ok = await setup()
    await ok.dispatcher.tick()
    assert.deepEqual(
      [(await ok.usage.month('t1', month)).webhooksDelivered, (await ok.usage.month('t1', month)).webhooksFailed],
      [1, 0],
    )
    const retrying = await setup({}, () => ({ status: 503, body: '' }))
    await retrying.dispatcher.tick()
    assert.deepEqual(
      [
        (await retrying.usage.month('t1', month)).webhooksDelivered,
        (await retrying.usage.month('t1', month)).webhooksFailed,
      ],
      [0, 0],
    )
    const refused = await setup({}, () => ({ status: 400, body: '' }))
    await refused.dispatcher.tick()
    assert.deepEqual(
      [
        (await refused.usage.month('t1', month)).webhooksDelivered,
        (await refused.usage.month('t1', month)).webhooksFailed,
      ],
      [0, 1],
    )
    const gone = await setup()
    await gone.queue.enqueue({ id: 'd2', tenantId: 't1', endpointId: 'gone', body: '{}', createdAt: 1 }, 100)
    await gone.dispatcher.tick()
    assert.equal(
      (await gone.usage.month('t1', month)).webhooksFailed,
      0,
      'a delivery with no endpoint is not billed as a failure of the receiver',
    )
  })

  it('uses the settings of the tenant for the timeout and the network', async () => {
    const { dispatcher, calls } = await setup({ timeoutSeconds: 3, allowPrivateNetworks: true })
    await dispatcher.tick()
    assert.equal(calls[0].options.timeoutMs, 3000)
    assert.equal(calls[0].options.allowPrivateNetworks, true)
  })

  it('retries with a wait that doubles up to the maximum, then gives up after the last attempt', async () => {
    const { queue, dispatcher, calls, advance, clock } = await setup(
      { maxAttempts: 4, baseDelaySeconds: 10, maxDelaySeconds: 25 },
      () => ({ status: 503, body: '' }),
    )
    const waits: number[] = []
    for (let attempt = 1; attempt <= 4; attempt++) {
      const before = clock()
      await dispatcher.tick()
      const item = await queue.get('t1', 'd1')
      if (item?.status === 'pending') {
        waits.push(item.nextAttemptAt - before)
        assert.equal(await dispatcher.tick(), 0, 'not before its time')
        advance(item.nextAttemptAt - clock())
      }
    }
    assert.deepEqual(waits, [10_000, 20_000, 25_000])
    assert.equal(calls.length, 4)
    assert.deepEqual(
      calls.map((call) => call.headers['X-Fingerprint-Attempt']),
      ['1', '2', '3', '4'],
    )
    const item = await queue.get('t1', 'd1')
    assert.deepEqual([item?.status, item?.attempts, item?.lastError], ['failed', 4, 'The receiver answered 503'])
  })

  it('retries what may recover and gives up at once on what will not', async () => {
    for (const [status, final] of [
      [500, 'pending'],
      [502, 'pending'],
      [408, 'pending'],
      [429, 'pending'],
      [400, 'failed'],
      [401, 'failed'],
      [404, 'failed'],
      [410, 'failed'],
      [301, 'failed'],
      [199, 'failed'],
    ] as const) {
      const { queue, dispatcher } = await setup({}, () => ({ status, body: '' }))
      await dispatcher.tick()
      assert.equal((await queue.get('t1', 'd1'))?.status, final, String(status))
    }
  })

  it('retries a network error and a timeout, but not an address that is blocked', async () => {
    const network = await setup({}, () => {
      throw new Error('connect ECONNREFUSED')
    })
    await network.dispatcher.tick()
    assert.deepEqual(
      [(await network.queue.get('t1', 'd1'))?.status, (await network.queue.get('t1', 'd1'))?.lastError],
      ['pending', 'connect ECONNREFUSED'],
    )
    const blocked = await setup({}, () => {
      throw new BlockedAddressError('hooks.example.com')
    })
    await blocked.dispatcher.tick()
    assert.equal((await blocked.queue.get('t1', 'd1'))?.status, 'failed')
    assert.match((await blocked.queue.get('t1', 'd1'))?.lastError ?? '', /private or reserved/)
  })

  it('fails a delivery whose endpoint was taken out of the configuration', async () => {
    const { queue, dispatcher, calls } = await setup()
    await queue.enqueue({ id: 'd2', tenantId: 't1', endpointId: 'gone', body: '{}', createdAt: 1 }, 100)
    await dispatcher.tick()
    assert.equal((await queue.get('t1', 'd2'))?.status, 'failed')
    assert.match((await queue.get('t1', 'd2'))?.lastError ?? '', /no longer in the configuration/)
    assert.equal(calls.length, 1, 'only the good one was sent')
  })

  it('keeps going when one delivery breaks, and sends several at once up to the concurrency', async () => {
    let running = 0
    let peak = 0
    const { queue, dispatcher } = await setup({}, async (_call, n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      if (n === 2) {
        throw new Error('second one fails')
      }
      return { status: 200, body: '' }
    })
    for (let i = 2; i <= 12; i++) {
      await queue.enqueue({ id: `d${i}`, tenantId: 't1', endpointId: 'main', body: '{}', createdAt: 1 }, 100)
    }
    assert.equal(await dispatcher.tick(), 12)
    assert.equal(peak, 5, 'five at a time')
    const statuses = (await queue.list('t1', { limit: 50 })).map((item) => item.status)
    assert.equal(statuses.filter((status) => status === 'done').length, 11)
    assert.equal(statuses.filter((status) => status === 'pending').length, 1)
  })

  it('does not start a second pass while one is running', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { dispatcher, calls } = await setup({}, async () => {
      await gate
      return { status: 200, body: '' }
    })
    const first = dispatcher.tick()
    assert.equal(await dispatcher.tick(), 0)
    release()
    assert.equal(await first, 1)
    assert.equal(calls.length, 1)
  })

  it('computes the wait from the settings', () => {
    const webhooks = { baseDelaySeconds: 30, maxDelaySeconds: 3600 } as never
    assert.deepEqual(
      [1, 2, 3, 8, 9, 20].map((attempt) => backoffMs(attempt, webhooks)),
      [30_000, 60_000, 120_000, 3_600_000, 3_600_000, 3_600_000],
    )
  })
})

describe('webhooks with several instances on one MySQL database', { skip: mysqlAvailable ? false : 'no MySQL' }, () => {
  after(dropMysqlStorages)

  const delivery = (n: number) => ({
    id: `d${String(n).padStart(2, '0')}`,
    tenantId: 't1',
    endpointId: 'main',
    body: `{"n":${n}}`,
    createdAt: 1000 + n,
  })

  it('reserve a delivery for one instance at a time, and give it back when the reservation ends', async () => {
    const { storage, another } = await newMysqlStorageWithDatabase()
    const twin = await another()
    for (let n = 1; n <= 10; n++) {
      await storage.webhooks.enqueue(delivery(n), 100)
    }
    const first = (await storage.webhooks.claimDue?.(5000, 6, 'a', 60_000)) ?? []
    const second = (await twin.webhooks.claimDue?.(5000, 10, 'b', 60_000)) ?? []
    assert.equal(first.length, 6)
    assert.equal(second.length, 4, 'only what the first did not take')
    assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 10, 'no delivery twice')
    // Nothing is left to take while the reservations last
    assert.deepEqual((await twin.webhooks.claimDue?.(5001, 10, 'b', 60_000)) ?? [], [])
    // The instance that died never finished: after the lease the deliveries can be taken again
    const again = (await twin.webhooks.claimDue?.(5000 + 60_001, 10, 'b', 60_000)) ?? []
    assert.equal(again.length, 10)
  })

  it('free a delivery when its attempt ends, whichever way it ends', async () => {
    const { storage } = await newMysqlStorageWithDatabase()
    for (let n = 1; n <= 3; n++) {
      await storage.webhooks.enqueue(delivery(n), 100)
    }
    const claimed = (await storage.webhooks.claimDue?.(5000, 10, 'a', 60_000)) ?? []
    assert.equal(claimed.length, 3)
    await storage.webhooks.markDone('d01', 5100)
    await storage.webhooks.markRetry('d02', 5200, 'timeout')
    await storage.webhooks.markFailed('d03', 5300, '400')
    // d02 is due again at 5200 and must not still be held by the old reservation
    const next = (await storage.webhooks.claimDue?.(5200, 10, 'b', 60_000)) ?? []
    assert.deepEqual(
      next.map((item) => item.id),
      ['d02'],
    )
  })

  it('reserve a few deliveries at a time, so that no reservation outlasts the attempts before it', async () => {
    const { storage } = await newMysqlStorageWithDatabase()
    for (let n = 1; n <= 12; n++) {
      await storage.webhooks.enqueue(delivery(n), 100)
    }
    const asked: number[] = []
    const queue: WebhookQueue = new Proxy(storage.webhooks, {
      get(target, property) {
        if (property === 'claimDue') {
          return (now: number, limit: number, owner: string, lease: number) => {
            asked.push(limit)
            return target.claimDue?.(now, limit, owner, lease)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const clock = 1_800_000_000_000
    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [
        {
          id: 't1',
          publicKey: 'pk_dispatcher_0123456789',
          secretKeySha256: [sha256Hex('sk_x')],
          settings: {
            webhooks: {
              endpoints: [{ id: 'main', url: 'https://hooks.example.com/fp', secrets: ['a-secret-of-enough-length'] }],
            },
          },
        },
      ],
    })
    const dispatcher = new WebhookDispatcher({
      queue,
      usage: new MemoryUsageMeter(),
      settings: new SettingsRegistry(config),
      now: () => clock,
      concurrency: 5,
      post: async () => ({ status: 200, body: '' }),
    })
    // The deliveries were created at a fixed time; make them due
    assert.equal(await dispatcher.tick(), 12)
    assert.ok(asked.length >= 3 && asked.every((limit) => limit === 5), `asked ${JSON.stringify(asked)}`)
  })

  it('send each delivery once when two dispatchers read the same queue', async () => {
    const { storage, another } = await newMysqlStorageWithDatabase()
    const twin = await another()
    const clock = 1_800_000_000_000
    const sent: string[] = []
    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [
        {
          id: 't1',
          publicKey: 'pk_dispatcher_0123456789',
          secretKeySha256: [sha256Hex('sk_x')],
          settings: {
            webhooks: {
              endpoints: [{ id: 'main', url: 'https://hooks.example.com/fp', secrets: ['a-secret-of-enough-length'] }],
            },
          },
        },
      ],
    })
    const make = (queue: WebhookQueue) =>
      new WebhookDispatcher({
        queue,
        usage: new MemoryUsageMeter(),
        settings: new SettingsRegistry(config),
        now: () => clock,
        post: async (_url, body) => {
          sent.push(body)
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { status: 200, body: '' }
        },
      })
    for (let n = 1; n <= 12; n++) {
      await storage.webhooks.enqueue({ ...delivery(n), createdAt: clock }, 100)
    }
    await Promise.all([make(storage.webhooks).tick(), make(twin.webhooks).tick()])
    assert.equal(sent.length, 12)
    assert.equal(new Set(sent).size, 12, 'not one of them was sent twice')
  })
})
