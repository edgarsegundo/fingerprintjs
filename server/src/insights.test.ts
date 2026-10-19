import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { MemoryIdentityStore } from './identity/memory_store'
import { SqliteIdentityStore } from './identity/sqlite_store'
import type { IdentityStore } from './identity/store'
import { RunningServer, startServer } from './server'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from './testing/mysql'

const PK = 'pk_insight_0123456789abcdef'
const SK = 'sk_insight_secret'

const config = (settings: Record<string, unknown> = {}, other: Record<string, unknown> = {}) =>
  parseConfig({
    nonceSecret: 'n'.repeat(32),
    tenants: [
      { id: 't', publicKey: PK, secretKeySha256: [sha256Hex(SK)], settings },
      { id: 'o', publicKey: 'pk_other_0123456789abcdef', secretKeySha256: [sha256Hex('sk_other')], settings: other },
    ],
    rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
  })

const signal = (value: unknown) => ({ value, duration: 1 })

async function visit(server: RunningServer, gpu: string, pk = PK) {
  const base = `http://127.0.0.1:${server.port}`
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
      components: {
        webGlBasics: signal({ rendererUnmasked: gpu, vendorUnmasked: 'v', renderer: 'r', vendor: 'v' }),
        platform: signal('MacIntel'),
      },
      extended: {},
    }),
  })
  assert.equal(response.status, 200)
}

const get = (server: RunningServer, path: string, key = SK) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${key}` } })

describe('the profile of collection that comes with the challenge', () => {
  const nonce = async (server: RunningServer, pk = PK) =>
    (await (await fetch(`http://127.0.0.1:${server.port}/v1/nonce?k=${pk}`)).json()) as {
      nonce: string
      profile?: { exclude: string[]; include: string[]; elevated: boolean }
    }

  it('carries nothing when the tenant asked for nothing', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      const answer = await nonce(server)
      assert.deepEqual(Object.keys(answer), ['nonce'])
    } finally {
      await server.close()
    }
  })

  it('asks for the signals the tenant named, and for more only from clients behind a listed label', async () => {
    const settings = {
      collection: {
        exclude: ['speechVoices'],
        include: ['behavior'],
        elevatedTags: ['datacenter'],
        elevatedInclude: ['webGpu'],
      },
    }
    const plain = await startServer(config(settings), { port: 0, intel: { lookup: () => ({ tags: [] }) } })
    const elevated = await startServer(config(settings), {
      port: 0,
      intel: { lookup: () => ({ tags: ['datacenter'] }) },
    })
    try {
      assert.deepEqual((await nonce(plain)).profile, {
        exclude: ['speechVoices'],
        include: ['behavior'],
        elevated: false,
      })
      assert.deepEqual((await nonce(elevated)).profile, {
        exclude: ['speechVoices'],
        include: ['behavior', 'webGpu'],
        elevated: true,
      })
      assert.equal(
        (await nonce(elevated, 'pk_other_0123456789abcdef')).profile,
        undefined,
        'another tenant is not asked',
      )
    } finally {
      await plain.close()
      await elevated.close()
    }
  })

  it('does not widen the collection when no label is listed, even for a listed address', async () => {
    const server = await startServer(config({ collection: { elevatedInclude: ['webGpu'] } }), {
      port: 0,
      intel: { lookup: () => ({ tags: ['datacenter'] }) },
    })
    try {
      assert.equal((await nonce(server)).profile, undefined)
    } finally {
      await server.close()
    }
  })

  it('refuses bad names when the configuration is read', () => {
    assert.throws(() => config({ collection: { exclude: ['bad name'] } }), /signal names/)
    assert.throws(
      () => config({ collection: { include: Array.from({ length: 21 }, (_, i) => `s${i}`) } }),
      /at most 20/,
    )
  })
})

describe('GET /v1/drift', () => {
  it('shows the features whose values moved between two periods, and says what it could not judge', async () => {
    let clock = Date.parse('2026-10-15T12:00:00Z')
    const server = await startServer(config({ drift: { minSamples: 5 } }), { port: 0, now: () => clock })
    try {
      for (let i = 0; i < 6; i++) {
        await visit(server, 'gpu-old')
      }
      clock += 8 * 24 * 3600 * 1000
      for (let i = 0; i < 6; i++) {
        await visit(server, 'gpu-new')
      }
      clock += 60_000 // the period ends at the moment of the question, and the end is not included
      const report = (await (await get(server, '/v1/drift?windowDays=7')).json()) as {
        current: { visits: number; sampled: boolean }
        previous: { visits: number }
        features: Array<{ feature: string; drifted: boolean; novelty: number | null; divergence: number | null }>
      }
      assert.deepEqual([report.previous.visits, report.current.visits, report.current.sampled], [6, 6, false])
      const gpu = report.features.find((item) => item.feature === 'webglRenderer')
      assert.deepEqual([gpu?.drifted, gpu?.novelty, gpu?.divergence], [true, 1, 1])
      const platform = report.features.find((item) => item.feature === 'platform')
      assert.deepEqual([platform?.drifted, platform?.divergence], [false, 0])
      assert.equal(report.features[0].feature, 'webglRenderer', 'the biggest shift first')

      assert.equal((await get(server, '/v1/drift?windowDays=0')).status, 400)
      assert.equal((await get(server, '/v1/drift?windowDays=91')).status, 400)
      assert.equal((await get(server, '/v1/drift?windowDays=x')).status, 400)
      assert.equal((await get(server, '/v1/drift', 'sk_wrong')).status, 401)
      const other = (await (await get(server, '/v1/drift?windowDays=7', 'sk_other')).json()) as {
        current: { visits: number }
      }
      assert.equal(other.current.visits, 0, 'another tenant sees none of it')
    } finally {
      await server.close()
    }
  })

  it('does not judge with too few visits, and tells when it only read a sample', async () => {
    const server = await startServer(config({ drift: { minSamples: 50, maxEvents: 10 } }), { port: 0 })
    try {
      for (let i = 0; i < 12; i++) {
        await visit(server, 'gpu')
      }
      const report = (await (await get(server, '/v1/drift?windowDays=7')).json()) as {
        current: { visits: number; sampled: boolean }
        features: Array<{ divergence: number | null; drifted: boolean }>
      }
      assert.deepEqual([report.current.visits, report.current.sampled], [10, true])
      assert.ok(report.features.every((item) => item.divergence === null && !item.drifted))
    } finally {
      await server.close()
    }
  })
})

const stores: Array<[string, () => IdentityStore | Promise<IdentityStore>]> = [
  ['MemoryIdentityStore', () => new MemoryIdentityStore()],
  ['SqliteIdentityStore', () => new SqliteIdentityStore(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlIdentityStore', async () => (await newMysqlStorage()).identity] as [string, () => Promise<IdentityStore>]]
    : []),
]

for (const [name, create] of stores) {
  describe(`anonymity (${name})`, () => {
    after(dropMysqlStorages)

    it('counts the devices whose value is shared by fewer than k devices, the device itself included', async () => {
      const store = await create()
      for (let i = 0; i < 6; i++) {
        await store.createDevice('t', `d${i}`, { gpu: i < 3 ? 'common' : `rare-${i}`, platform: 'mac' }, i)
      }
      await store.createDevice('other', 'x', { gpu: 'solo' }, 1)
      const byFeature = async (k: number) =>
        Object.fromEntries((await store.anonymity('t', k)).map((item) => [item.feature, item]))
      assert.deepEqual(
        (await byFeature(2)).gpu,
        { feature: 'gpu', devices: 6, devicesBelowK: 3 },
        'three rare values of one device each',
      )
      assert.deepEqual(
        (await byFeature(3)).gpu,
        { feature: 'gpu', devices: 6, devicesBelowK: 3 },
        'common is shared by exactly three: not below 3',
      )
      assert.deepEqual((await byFeature(4)).gpu, { feature: 'gpu', devices: 6, devicesBelowK: 6 }, 'below 4 now')
      assert.deepEqual((await byFeature(7)).platform, { feature: 'platform', devices: 6, devicesBelowK: 6 }, 'below 7')
      assert.deepEqual(
        (await byFeature(6)).platform,
        { feature: 'platform', devices: 6, devicesBelowK: 0 },
        'six share it: not below 6',
      )
      assert.deepEqual(await store.anonymity('nobody', 5), [])
    })
  })
}

describe('GET /v1/anonymity', () => {
  it('shows, by feature, the share of devices that are easy to single out', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      for (const gpu of ['a', 'a', 'a', 'a', 'a', 'b', 'c']) {
        await visit(server, gpu)
      }
      const report = (await (await get(server, '/v1/anonymity?k=3')).json()) as {
        k: number
        features: Array<{ feature: string; devices: number; devicesBelowK: number; shareBelowK: number | null }>
      }
      assert.equal(report.k, 3)
      assert.ok(report.features.length > 0)
      for (const item of report.features) {
        assert.ok(item.devices > 0 && item.devicesBelowK <= item.devices)
        assert.equal(item.shareBelowK, item.devicesBelowK / item.devices)
      }
      const sorted = report.features.map((item) => item.shareBelowK ?? -1)
      assert.deepEqual(
        sorted,
        [...sorted].sort((a, b) => b - a),
        'the most identifying first',
      )
      assert.equal(
        ((await (await get(server, '/v1/anonymity')).json()) as { k: number }).k,
        5,
        'the default is the setting',
      )
      assert.equal((await get(server, '/v1/anonymity?k=1')).status, 400)
      assert.equal((await get(server, '/v1/anonymity?k=abc')).status, 400)
      assert.equal((await get(server, '/v1/anonymity?k=1001')).status, 400)
      const other = (await (await get(server, '/v1/anonymity', 'sk_other')).json()) as { features: unknown[] }
      assert.deepEqual(other.features, [])
    } finally {
      await server.close()
    }
  })
})
