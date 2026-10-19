import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'

import { parseConfig, sha256Hex } from '../config'
import { RunningServer, startServer } from '../server'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import { graphKeyFeatures, graphKeyOf } from './key'
import { GraphStore, MemoryGraphStore, SqliteGraphStore } from './store'

describe('graphKeyOf', () => {
  const features = {
    canvas: 'c1',
    webglRenderer: 'r1',
    webglVendor: 'v1',
    fonts: 'f1',
    screenResolution: '1440x900',
    platform: 'MacIntel',
  }
  const secret = 's'.repeat(32)

  it('has a key of a known shape for a known device, so that a change of the derivation is seen', () => {
    // If this fails on purpose (the derivation changed), every key already stored stops matching: say so in the release
    assert.equal(graphKeyOf(features, secret, 6), 'g_YpH6uXRGvc1meprR49LIZoMaA8C')
  })

  it('is the same for the same device and shape, and made only of what the device is', () => {
    const key = graphKeyOf(features, secret, 6)
    assert.match(key ?? '', /^g_[A-Za-z0-9_-]{27}$/)
    assert.equal(graphKeyOf({ ...features }, secret, 6), key)
    const reordered = Object.fromEntries(Object.entries(features).reverse())
    assert.equal(graphKeyOf(reordered, secret, 6), key, 'the order does not matter')
    // The address, the connection and the like are not part of it
    assert.equal(
      graphKeyOf({ ...features, ip: '1.2.3.4', ipPrefix: 'x', tlsCiphers: 'y', headerOrder: 'z' }, secret, 6),
      key,
    )
  })

  it('changes with any value of the key, with the set of features present, and with the secret', () => {
    const key = graphKeyOf(features, secret, 6)
    for (const name of Object.keys(features) as Array<keyof typeof features>) {
      assert.notEqual(graphKeyOf({ ...features, [name]: `${features[name]}!` }, secret, 6), key, name)
    }
    assert.notEqual(graphKeyOf({ ...features, audio: 'a' }, secret, 6), key, 'one more feature is another key')
    assert.notEqual(graphKeyOf(features, 'o'.repeat(32), 6), key)
    assert.ok(
      !(key ?? '').includes('MacIntel') && !(key ?? '').includes('1440x900'),
      'no value of the device in the key',
    )
  })

  it('refuses a key made of too little, counting only the features of the key', () => {
    assert.equal(graphKeyOf(features, secret, 7), undefined)
    assert.ok(graphKeyOf(features, secret, 6))
    assert.equal(
      graphKeyOf(
        { ip: '1.2.3.4', timezone: 'x', http2: 'y', headerOrder: 'z', tlsCiphers: 'w', languages: 'l' },
        secret,
        3,
      ),
      undefined,
    )
    assert.equal(graphKeyOf({ ...features, fonts: '' }, secret, 6), undefined, 'an empty value is not a feature')
  })

  it('lists no feature about the connection', () => {
    for (const name of graphKeyFeatures) {
      assert.ok(!/^(ip|tls|http|header)/i.test(name), name)
    }
  })
})

const stores: Array<[string, () => GraphStore | Promise<GraphStore>]> = [
  ['MemoryGraphStore', () => new MemoryGraphStore()],
  ['SqliteGraphStore', () => new SqliteGraphStore(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlGraphStore', async () => (await newMysqlStorage()).graph] as [string, () => Promise<GraphStore>]]
    : []),
]

for (const [name, create] of stores) {
  describe(name, () => {
    after(dropMysqlStorages)

    const day = 24 * 60 * 60 * 1000

    it('counts the other tenants that saw the key in the window, never the asker', async () => {
      const store = await create()
      await store.record('g_1', 'a', 10 * day, false)
      await store.record('g_1', 'b', 9 * day, false)
      await store.record('g_1', 'c', 2 * day, false)
      await store.record('g_2', 'd', 10 * day, false)
      assert.deepEqual(await store.summary('g_1', 'a', 0), { tenants: 2, flaggedTenants: 0 })
      assert.deepEqual(
        await store.summary('g_1', 'a', 5 * day),
        { tenants: 1, flaggedTenants: 0 },
        'c is out of the window',
      )
      assert.deepEqual(
        await store.summary('g_1', 'a', 9 * day),
        { tenants: 1, flaggedTenants: 0 },
        'the start is included',
      )
      assert.deepEqual(await store.summary('g_1', 'z', 0), { tenants: 3, flaggedTenants: 0 })
      assert.deepEqual(await store.summary('g_unknown', 'a', 0), { tenants: 0, flaggedTenants: 0 })
    })

    it('counts the tenants that flagged, by the time of the flag and not of the visit', async () => {
      const store = await create()
      await store.record('g_1', 'b', 1 * day, true)
      await store.record('g_1', 'b', 9 * day, false)
      await store.record('g_1', 'c', 9 * day, false)
      await store.record('g_1', 'd', 9 * day, true)
      assert.deepEqual(
        await store.summary('g_1', 'a', 5 * day),
        { tenants: 3, flaggedTenants: 1 },
        'b flagged long ago',
      )
      assert.deepEqual(await store.summary('g_1', 'a', 0), { tenants: 3, flaggedTenants: 2 })
      await store.record('g_1', 'c', 9.5 * day, true)
      assert.equal((await store.summary('g_1', 'a', 5 * day)).flaggedTenants, 2)
    })

    it('forgets by key and tenant, by tenant, and by age, and nothing else', async () => {
      const store = await create()
      for (const [key, tenant, at] of [
        ['g_1', 'a', 5],
        ['g_2', 'a', 5],
        ['g_1', 'b', 5],
        ['g_3', 'b', 1],
      ] as const) {
        await store.record(key, tenant, at * day, false)
      }
      assert.equal(await store.deleteKeys('a', ['g_1', 'g_nope']), 1)
      assert.equal((await store.summary('g_1', 'z', 0)).tenants, 1, 'only b is left on g_1')
      assert.equal((await store.summary('g_2', 'z', 0)).tenants, 1, 'a keeps its other key')
      assert.equal(await store.purge(3 * day), 1, 'g_3 of b is older than the limit')
      assert.equal(await store.deleteTenant('b'), 1)
      assert.equal((await store.summary('g_1', 'z', 0)).tenants, 0)
      assert.equal(await store.deleteTenant('b'), 0)
    })

    it('stores what looks like SQL as plain text', async () => {
      const store = await create()
      await store.record("g'); DROP TABLE graph_edges;--", "t'1", day, true)
      assert.equal((await store.summary("g'); DROP TABLE graph_edges;--", 'other', 0)).flaggedTenants, 1)
    })
  })
}

describe('the shared graph in the configuration', () => {
  const base = {
    nonceSecret: 'n'.repeat(32),
    tenants: [{ id: 't', publicKey: 'pk_graph_0123456789abcdef', secretKeySha256: [sha256Hex('sk')] }],
  }
  const on = { enabled: true, legalOpinionRef: 'Parecer 12/2026', secret: 'g'.repeat(32) }

  it('is off unless asked, and then asks for the reference of a legal opinion and its own secret', () => {
    assert.equal(parseConfig(base).sharedGraph.enabled, false)
    assert.equal(parseConfig({ ...base, sharedGraph: on }).sharedGraph.enabled, true)
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, legalOpinionRef: '' } }), /legalOpinionRef/)
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, legalOpinionRef: '   ' } }), /legalOpinionRef/)
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, secret: 'short' } }), /at least 32/)
    assert.throws(
      () => parseConfig({ ...base, sharedGraph: { ...on, secret: base.nonceSecret } }),
      /different from nonceSecret/,
    )
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, enabled: 'yes' } }), /sharedGraph.enabled/)
  })

  it('limits how long it keeps things and how few tenants a count may come from', () => {
    assert.equal(parseConfig({ ...base, sharedGraph: on }).sharedGraph.retentionDays, 14)
    assert.equal(parseConfig({ ...base, sharedGraph: on }).sharedGraph.minTenants, 3)
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, retentionDays: 91 } }), /at most 90/)
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, minTenants: 1 } }), /from 2 to 50/)
    assert.throws(() => parseConfig({ ...base, sharedGraph: { ...on, minTenants: 51 } }), /from 2 to 50/)
    assert.equal(parseConfig({ ...base, sharedGraph: { ...on, minTenants: 2 } }).sharedGraph.minTenants, 2)
  })

  it('refuses a tenant, a default or a plan that joins while the graph is off', () => {
    const joins = { sharedGraph: { participate: true } }
    assert.throws(
      () => parseConfig({ ...base, tenants: [{ ...base.tenants[0], settings: joins }] }),
      /sharedGraph.participate needs sharedGraph.enabled/,
    )
    assert.throws(() => parseConfig({ ...base, defaults: joins }), /sharedGraph.participate needs sharedGraph.enabled/)
    assert.throws(
      () => parseConfig({ ...base, plans: { p: joins } }),
      /sharedGraph.participate needs sharedGraph.enabled/,
    )
    assert.ok(parseConfig({ ...base, sharedGraph: on, defaults: joins }))
  })
})

describe('the shared graph at work', () => {
  const KEYS = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, pk: `pk_graph_${id}_0123456789ab`, sk: `sk_graph_${id}` }))
  const block = {
    rules: { list: [{ id: 'dc', when: { field: 'ip.tags', op: 'contains', value: 'datacenter' }, decision: 'block' }] },
  }

  function configFor(joining: string[], settings: Record<string, unknown> = {}, graph: Record<string, unknown> = {}) {
    return parseConfig({
      nonceSecret: 'n'.repeat(32),
      sharedGraph: { enabled: true, legalOpinionRef: 'Parecer 12/2026', secret: 'g'.repeat(32), ...graph },
      tenants: KEYS.map(({ id, pk, sk }) => ({
        id,
        publicKey: pk,
        secretKeySha256: [sha256Hex(sk)],
        settings: {
          ...(joining.includes(id)
            ? { sharedGraph: { participate: true, minFeatures: 6 }, ...block }
            : { sharedGraph: { participate: false, minFeatures: 6 }, ...block }),
          risk: { graphFlaggedWeight: 40 },
          ...settings,
        },
      })),
      rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    })
  }

  const signal = (value: unknown) => ({ value, duration: 1 })
  /** The same device, whichever tenant sees it */
  const device = (variant = 0) => ({
    canvas: signal({ winding: true, geometry: `g${variant}`, text: 't' }),
    webGlBasics: signal({ rendererUnmasked: 'gpu', vendorUnmasked: 'vendor', renderer: 'r', vendor: 'v' }),
    fonts: signal(['f1', 'f2']),
    screenResolution: signal([1440, 900]),
    platform: signal('MacIntel'),
  })

  async function visit(server: RunningServer, tenant: typeof KEYS[number], variant = 0) {
    const base = `http://127.0.0.1:${server.port}`
    const { nonce } = (await (await fetch(`${base}/v1/nonce?k=${tenant.pk}`)).json()) as { nonce: string }
    const response = await fetch(`${base}/v1/collect?k=${tenant.pk}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 1,
        libVersion: '5.3.0',
        collectedAt: Date.now(),
        durationMs: 1,
        nonce,
        components: device(variant),
        extended: {},
      }),
    })
    assert.equal(response.status, 200)
    return ((await response.json()) as { requestId: string }).requestId
  }

  async function view(server: RunningServer, tenant: typeof KEYS[number], requestId: string) {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/events/${requestId}`, {
      headers: { Authorization: `Bearer ${tenant.sk}` },
    })
    return (await response.json()) as {
      graph: { tenants: number | null; flaggedTenants: number | null } | null
      risk: { score: number; factors: Array<{ id: string }> } | null
    }
  }

  const flagging = { lookup: () => ({ tags: ['datacenter'] }) }
  const clean = { lookup: () => ({ tags: [] }) }

  it('tells a tenant how many others saw and flagged a device, only when enough are behind the count', async () => {
    // Three other tenants flagged the device (they run the rule), and the fourth asks
    const server = await startServer(configFor(['a', 'b', 'c', 'd']), { port: 0, intel: flagging })
    try {
      await visit(server, KEYS[1])
      let ask = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.deepEqual(ask.graph, { tenants: null, flaggedTenants: null }, 'one other tenant is not enough to say')
      await visit(server, KEYS[2])
      ask = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.deepEqual(ask.graph, { tenants: null, flaggedTenants: null }, 'two are not enough either (k is 3)')
      await visit(server, KEYS[3])
      ask = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.deepEqual(ask.graph, { tenants: 3, flaggedTenants: 3 })
      assert.ok(ask.risk?.factors.some((factor) => factor.id === 'graph:flagged_elsewhere'))
      assert.ok((ask.risk?.score ?? 0) >= 40)
      // Another device is not seen elsewhere
      const other = await view(server, KEYS[0], await visit(server, KEYS[0], 99))
      assert.deepEqual(other.graph, { tenants: null, flaggedTenants: null })
    } finally {
      await server.close()
    }
  })

  it('counts a device seen but not flagged apart from one flagged', async () => {
    // b, c and d see the device and flag nothing (no datacenter tag); e joins and asks
    const server = await startServer(configFor(['a', 'b', 'c', 'd']), { port: 0, intel: clean })
    try {
      for (const tenant of KEYS.slice(1, 4)) {
        await visit(server, tenant)
      }
      const ask = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.deepEqual(
        ask.graph,
        { tenants: 3, flaggedTenants: null },
        'seen by three, flagged by none (not enough to say)',
      )
      assert.ok(!ask.risk?.factors.some((factor) => factor.id === 'graph:flagged_elsewhere'))
    } finally {
      await server.close()
    }
  })

  it('leaves out a tenant that does not join, in both directions', async () => {
    const server = await startServer(configFor(['a', 'b', 'c', 'd']), { port: 0, intel: flagging })
    try {
      // e does not join: its visit is not counted and it sees nothing
      for (const tenant of [KEYS[1], KEYS[2], KEYS[4]]) {
        await visit(server, tenant)
      }
      const ask = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.deepEqual(ask.graph, { tenants: null, flaggedTenants: null }, 'only b and c count: two')
      const outsider = await view(server, KEYS[4], await visit(server, KEYS[4]))
      assert.equal(outsider.graph, null)
    } finally {
      await server.close()
    }
  })

  it('does nothing when the configuration did not turn it on', async () => {
    const server = await startServer(configFor([], {}, { enabled: false }), { port: 0, intel: flagging })
    try {
      const result = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.equal(result.graph, null)
    } finally {
      await server.close()
    }
  })

  it('keeps out the countries a tenant names, and the visits with too little to make a key', async () => {
    const withCountry = { lookup: () => ({ tags: ['datacenter'], country: 'DE' }) }
    const server = await startServer(
      configFor(['a', 'b', 'c', 'd'], { sharedGraph: { participate: true, minFeatures: 6, excludeCountries: ['DE'] } }),
      { port: 0, intel: withCountry },
    )
    try {
      for (const tenant of KEYS.slice(1, 4)) {
        await visit(server, tenant)
      }
      const ask = await view(server, KEYS[0], await visit(server, KEYS[0]))
      assert.equal(ask.graph, null, 'a visitor from an excluded country neither gives nor gets')
    } finally {
      await server.close()
    }
    const strict = await startServer(
      configFor(['a', 'b', 'c', 'd'], { sharedGraph: { participate: true, minFeatures: 12 } }),
      { port: 0, intel: flagging },
    )
    try {
      for (const tenant of KEYS.slice(1, 4)) {
        await visit(strict, tenant)
      }
      const ask = await view(strict, KEYS[0], await visit(strict, KEYS[0]))
      assert.deepEqual(ask.graph, null, 'five features are fewer than twelve: no key, so no graph for this visit')
    } finally {
      await strict.close()
    }
  })

  it('forgets what a tenant gave when its visits are erased or it is removed', async () => {
    const server = await startServer(
      parseConfig({
        ...(configFor(['a', 'b', 'c', 'd']) as unknown as object),
      } as never),
      { port: 0, intel: flagging },
    )
    try {
      // The three others give; then b asks for the erasure of its visit
      const first = await visit(server, KEYS[1])
      await visit(server, KEYS[2])
      await visit(server, KEYS[3])
      assert.equal((await view(server, KEYS[0], await visit(server, KEYS[0]))).graph?.tenants, 3)
      const erase = await fetch(
        `http://127.0.0.1:${server.port}/v1/visitors/${await visitorOf(server, KEYS[1], first)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${KEYS[1].sk}` },
        },
      )
      assert.equal(erase.status, 200)
      assert.deepEqual(
        (await view(server, KEYS[0], await visit(server, KEYS[0]))).graph,
        {
          tenants: null,
          flaggedTenants: null,
        },
        'b is gone from the count: two tenants are left',
      )
    } finally {
      await server.close()
    }
  })

  it('looks back no further than the graph keeps things, whatever the tenant asks for', async () => {
    let clock = Date.parse('2026-10-01T12:00:00Z')
    const config = configFor(
      ['a', 'b', 'c', 'd'],
      { sharedGraph: { participate: true, minFeatures: 6, windowDays: 90 } },
      {
        retentionDays: 3,
        minTenants: 2,
      },
    )
    const server = await startServer(config, { port: 0, intel: clean, now: () => clock })
    try {
      await visit(server, KEYS[1])
      await visit(server, KEYS[2])
      clock += 2 * 24 * 3600 * 1000
      assert.equal(
        (await view(server, KEYS[0], await visit(server, KEYS[0]))).graph?.tenants,
        2,
        'two days ago: inside',
      )
      clock += 2 * 24 * 3600 * 1000
      // b and c were seen four days ago: out of the three days that the graph keeps, though the tenant asked for 90
      assert.deepEqual((await view(server, KEYS[0], await visit(server, KEYS[0]))).graph, {
        tenants: null,
        flaggedTenants: null,
      })
    } finally {
      await server.close()
    }
  })

  it('deletes the old edges when the server starts, and every hour', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-graph-'))
    try {
      const databasePath = path.join(dir, 'events.db')
      let clock = Date.parse('2026-10-01T12:00:00Z')
      const config = () => configFor(['a', 'b'], {}, { retentionDays: 3, minTenants: 2 })
      const first = await startServer(
        { ...config(), database: { type: 'sqlite' as const, path: databasePath } },
        { port: 0, intel: clean, now: () => clock },
      )
      await visit(first, KEYS[0])
      await first.close()
      const edges = () => {
        const db = new DatabaseSync(databasePath)
        try {
          return Number((db.prepare('SELECT COUNT(*) AS c FROM graph_edges').get() as { c: number }).c)
        } finally {
          db.close()
        }
      }
      assert.equal(edges(), 1)
      clock += 2 * 24 * 3600 * 1000
      const second = await startServer(
        { ...config(), database: { type: 'sqlite' as const, path: databasePath } },
        { port: 0, intel: clean, now: () => clock },
      )
      await second.close()
      assert.equal(edges(), 1, 'two days: kept')
      clock += 2 * 24 * 3600 * 1000
      const third = await startServer(
        { ...config(), database: { type: 'sqlite' as const, path: databasePath } },
        { port: 0, intel: clean, now: () => clock },
      )
      await third.close()
      assert.equal(edges(), 0, 'four days: gone')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forgets a tenant that the administrator removes', async () => {
    const adminKey = 'adm_graph_secret'
    const base = configFor(['a', 'c', 'd'], {}, { minTenants: 2 })
    const config = { ...base, adminKeySha256: [sha256Hex(adminKey)] }
    const server = await startServer(config, { port: 0, intel: clean })
    try {
      const call = (path: string, method = 'GET', body?: unknown) =>
        fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
          headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      const created = (await (
        await call('/admin/v1/tenants', 'POST', {
          id: 'late',
          settings: { sharedGraph: { participate: true, minFeatures: 6 } },
        })
      ).json()) as { tenant: { publicKey: string }; secretKey: string }
      const late = { id: 'late', pk: created.tenant.publicKey, sk: created.secretKey }
      await visit(server, late)
      await visit(server, KEYS[2])
      await visit(server, KEYS[3])
      assert.equal((await view(server, KEYS[0], await visit(server, KEYS[0]))).graph?.tenants, 3)
      assert.equal((await call('/admin/v1/tenants/late?confirm=late', 'DELETE')).status, 200)
      assert.equal(
        (await view(server, KEYS[0], await visit(server, KEYS[0]))).graph?.tenants,
        2,
        'its edges went with it',
      )
    } finally {
      await server.close()
    }
  })

  async function visitorOf(server: RunningServer, tenant: typeof KEYS[number], requestId: string) {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/events/${requestId}`, {
      headers: { Authorization: `Bearer ${tenant.sk}` },
    })
    return ((await response.json()) as { identity: { visitorId: string } }).identity.visitorId
  }
})
