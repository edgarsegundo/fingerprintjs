import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'

import { parseConfig, sha256Hex } from '../config'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'
import { dayOf, MemoryUsageMeter, monthOf, nextMonthStart, SqliteUsageMeter, UsageMeter } from '../usage/meter'

import { TenantDirectory } from './directory'
import { MemoryTenantStore, SqliteTenantStore, TenantRecord, TenantStore } from './store'

const record = (id: string, extra: Partial<TenantRecord> = {}): TenantRecord => ({
  id,
  publicKey: `pk_${id}_0123456789abcdef`,
  secretKeySha256: [sha256Hex(`sk_${id}`)],
  allowedOrigins: [],
  settings: {},
  status: 'active',
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
})

const stores: Array<[string, () => TenantStore | Promise<TenantStore>]> = [
  ['MemoryTenantStore', () => new MemoryTenantStore()],
  ['SqliteTenantStore', () => new SqliteTenantStore(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlTenantStore', async () => (await newMysqlStorage()).tenants] as [string, () => Promise<TenantStore>]]
    : []),
]

for (const [name, create] of stores) {
  describe(name, () => {
    after(dropMysqlStorages)

    it('keeps what was written, whole, and lists by creation time', async () => {
      const store = await create()
      await store.create(
        record('b', { createdAt: 2000, name: 'Shop', plan: 'free', allowedOrigins: ['https://a.example'] }),
      )
      await store.create(record('a', { createdAt: 1000, settings: { limits: { maxBodyBytes: 1000 } } }))
      assert.deepEqual(
        (await store.list()).map((item) => item.id),
        ['a', 'b'],
      )
      assert.deepEqual(
        await store.get('b'),
        record('b', { createdAt: 2000, name: 'Shop', plan: 'free', allowedOrigins: ['https://a.example'] }),
      )
      assert.deepEqual((await store.get('a'))?.settings, { limits: { maxBodyBytes: 1000 } })
      assert.equal(await store.get('nope'), undefined)
    })

    it('refuses a repeated id or public key', async () => {
      const store = await create()
      await store.create(record('a'))
      await assert.rejects(
        async () => store.create(record('a', { publicKey: 'pk_other_0123456789abcdef' })),
        /already in use/,
      )
      await assert.rejects(
        async () => store.create(record('b', { publicKey: record('a').publicKey })),
        /already in use/,
      )
      assert.equal((await store.list()).length, 1)
    })

    it('replaces and deletes, and says when there was nothing', async () => {
      const store = await create()
      await store.create(record('a'))
      await store.update(
        record('a', { status: 'suspended', secretKeySha256: ['1'.repeat(64), '2'.repeat(64)], updatedAt: 5 }),
      )
      assert.deepEqual(
        [
          (await store.get('a'))?.status,
          (await store.get('a'))?.secretKeySha256.length,
          (await store.get('a'))?.updatedAt,
        ],
        ['suspended', 2, 5],
      )
      await assert.rejects(async () => store.update(record('missing')), /No such tenant/)
      assert.equal(await store.delete('a'), true)
      assert.equal(await store.delete('a'), false)
      assert.deepEqual(await store.list(), [])
    })

    it('does not change what it holds when the caller changes what it passed or got', async () => {
      const store = await create()
      const original = record('a', { allowedOrigins: ['https://a.example'] })
      await store.create(original)
      original.allowedOrigins.push('https://evil.example')
      const read = await store.get('a')
      read?.allowedOrigins.push('https://evil2.example')
      assert.deepEqual((await store.get('a'))?.allowedOrigins, ['https://a.example'])
    })
  })
}

describe('TenantDirectory', () => {
  const config = (tenants: unknown[]) =>
    parseConfig({ nonceSecret: 'n'.repeat(32), tenants, adminKeySha256: [sha256Hex('admin')] })
  const fileTenant = { id: 'file', publicKey: 'pk_file_0123456789abcdef', secretKeySha256: [sha256Hex('sk_file')] }

  it('lists the tenants of the file and of the store, and finds them by id, public key and secret key', async () => {
    const store = new MemoryTenantStore()
    store.create(record('db'))
    const directory = new TenantDirectory(() => config([fileTenant]), store)
    await directory.load()
    assert.deepEqual(
      directory.all().map((tenant) => [tenant.id, tenant.source]),
      [
        ['file', 'file'],
        ['db', 'database'],
      ],
    )
    assert.equal(directory.find('db')?.source, 'database')
    assert.equal(directory.byPublicKey(record('db').publicKey)?.id, 'db')
    assert.equal(directory.byPublicKey('pk_nope'), undefined)
    assert.equal(directory.byPublicKey(null), undefined)
    assert.equal(directory.authenticate('sk_db')?.id, 'db')
    assert.equal(directory.authenticate('sk_file')?.id, 'file')
    assert.equal(directory.authenticate('sk_wrong'), undefined)
    assert.equal(directory.authenticate(''), undefined)
  })

  it('lets the file win when an id or a public key is in both', async () => {
    const store = new MemoryTenantStore()
    store.create(record('file', { publicKey: 'pk_shadow_0123456789abcdef' }))
    store.create(record('other', { publicKey: fileTenant.publicKey }))
    const directory = new TenantDirectory(() => config([fileTenant]), store)
    await directory.load()
    assert.deepEqual(
      directory.all().map((tenant) => tenant.id),
      ['file'],
    )
    assert.equal(directory.authenticate('sk_other'), undefined, 'the shadowed tenant cannot be used')
  })

  it('keeps its list until it is told to read again', async () => {
    const store = new MemoryTenantStore()
    const directory = new TenantDirectory(() => config([fileTenant]), store)
    await directory.load()
    assert.equal(directory.all().length, 1)
    store.create(record('late'))
    assert.equal(directory.find('late'), undefined)
    await directory.load()
    assert.equal(directory.find('late')?.id, 'late')
  })

  it('works without a store', async () => {
    assert.deepEqual(
      new TenantDirectory(() => config([fileTenant])).all().map((tenant) => tenant.id),
      ['file'],
    )
  })
})

const meters: Array<[string, () => UsageMeter | Promise<UsageMeter>]> = [
  ['MemoryUsageMeter', () => new MemoryUsageMeter()],
  ['SqliteUsageMeter', () => new SqliteUsageMeter(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlUsageMeter', async () => (await newMysqlStorage()).usage] as [string, () => Promise<UsageMeter>]]
    : []),
]

for (const [name, create] of meters) {
  describe(name, () => {
    after(dropMysqlStorages)

    const at = (text: string) => Date.parse(text)

    it('adds up by metric, day and tenant, and separates the months', async () => {
      const meter = await create()
      await meter.add('t1', 'collects', at('2026-10-01T10:00:00Z'))
      await meter.add('t1', 'collects', at('2026-10-01T23:59:59.999Z'))
      await meter.add('t1', 'collects', at('2026-10-02T00:00:00Z'), 5)
      await meter.add('t1', 'nonces', at('2026-10-02T00:00:01Z'))
      await meter.add('t1', 'collects', at('2026-11-01T00:00:00Z'))
      await meter.add('t2', 'collects', at('2026-10-01T10:00:00Z'), 100)
      const october = await meter.month('t1', '2026-10')
      assert.deepEqual([october.collects, october.nonces, october.apiReads], [7, 1, 0])
      assert.equal((await meter.month('t1', '2026-11')).collects, 1)
      assert.equal((await meter.month('t2', '2026-10')).collects, 100)
      assert.equal((await meter.month('t3', '2026-10')).collects, 0)
      assert.equal((await meter.month('t1', '2025-10')).collects, 0)
    })

    it('lists the days that have use, in order, with every metric', async () => {
      const meter = await create()
      await meter.add('t1', 'apiReads', at('2026-10-03T10:00:00Z'), 2)
      await meter.add('t1', 'collects', at('2026-10-01T10:00:00Z'))
      const days = await meter.days('t1', '2026-10')
      assert.deepEqual(
        days.map((day) => day.day),
        ['2026-10-01', '2026-10-03'],
      )
      assert.deepEqual([days[0].collects, days[0].apiReads, days[1].apiReads], [1, 0, 2])
      assert.deepEqual(Object.keys(days[0]).sort(), [
        'apiReads',
        'collects',
        'day',
        'nonces',
        'quotaRejected',
        'webhooksDelivered',
        'webhooksFailed',
      ])
    })

    it('forgets a tenant and no other', async () => {
      const meter = await create()
      await meter.add('t1', 'collects', at('2026-10-01T10:00:00Z'))
      await meter.add('t1', 'collects', at('2026-10-02T10:00:00Z'))
      await meter.add('t2', 'collects', at('2026-10-01T10:00:00Z'))
      assert.ok((await meter.deleteTenant('t1')) > 0)
      assert.equal((await meter.month('t1', '2026-10')).collects, 0)
      assert.equal((await meter.month('t2', '2026-10')).collects, 1)
    })
  })
}

describe('usage time helpers', () => {
  it('count in UTC', () => {
    const edge = Date.parse('2026-10-31T23:59:59.999Z')
    assert.deepEqual([dayOf(edge), monthOf(edge)], ['2026-10-31', '2026-10'])
    assert.deepEqual([dayOf(edge + 1), monthOf(edge + 1)], ['2026-11-01', '2026-11'])
    assert.equal(nextMonthStart(edge), Date.parse('2026-11-01T00:00:00Z'))
    assert.equal(nextMonthStart(Date.parse('2026-12-15T00:00:00Z')), Date.parse('2027-01-01T00:00:00Z'))
  })
})

describe('plans and admin keys in the configuration', () => {
  const base = { nonceSecret: 'n'.repeat(32) }
  const tenant = { id: 't1', publicKey: 'pk_t1_0123456789abcdef', secretKeySha256: [sha256Hex('sk')] }

  it('accepts a tenant on a plan, and shows the plan to the settings', () => {
    const config = parseConfig({
      ...base,
      plans: { free: { limits: { collectPerMinutePerIp: 7 } } },
      tenants: [{ ...tenant, plan: 'free' }],
    })
    assert.equal(config.tenants[0].plan, 'free')
  })

  it('refuses a plan that does not exist, naming the closest, and a plan with a mistake', () => {
    assert.throws(
      () => parseConfig({ ...base, plans: { free: {} }, tenants: [{ ...tenant, plan: 'fre' }] }),
      /did you mean "free"/,
    )
    assert.throws(() => parseConfig({ ...base, tenants: [{ ...tenant, plan: 'free' }] }), /one of the plans/)
    assert.throws(
      () => parseConfig({ ...base, plans: { free: { limits: { maxBodyBytes: 'big' } } }, tenants: [tenant] }),
      /plan free: limits.maxBodyBytes/,
    )
    assert.throws(() => parseConfig({ ...base, plans: { 'Bad Name': {} }, tenants: [tenant] }), /plans\.Bad Name/)
    assert.throws(() => parseConfig({ ...base, plans: [], tenants: [tenant] }), /plans must be an object/)
  })

  it('needs tenants, unless the admin API can make them', () => {
    assert.throws(() => parseConfig({ ...base, tenants: [] }), /non-empty list/)
    assert.equal(parseConfig({ ...base, tenants: [], adminKeySha256: [sha256Hex('admin')] }).tenants.length, 0)
    assert.throws(() => parseConfig({ ...base, tenants: [tenant], adminKeySha256: ['not-a-hash'] }), /adminKeySha256/)
    assert.deepEqual(parseConfig({ ...base, tenants: [tenant] }).adminKeySha256, [])
  })

  it('reads the status of a tenant', () => {
    assert.equal(parseConfig({ ...base, tenants: [{ ...tenant, status: 'suspended' }] }).tenants[0].status, 'suspended')
    assert.equal(parseConfig({ ...base, tenants: [tenant] }).tenants[0].status, 'active')
    assert.throws(
      () => parseConfig({ ...base, tenants: [{ ...tenant, status: 'gone' }] }),
      /status must be active or suspended/,
    )
  })
})
