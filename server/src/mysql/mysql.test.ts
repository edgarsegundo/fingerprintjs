import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { smoothedAgreement } from '../identity/model'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorageWithDatabase } from '../testing/mysql'

import type { MysqlDatabase } from './database'
import { createSchema, Migration, migrations } from './schema'

/** A small deterministic generator, so that a failing run can be repeated */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/** What the counters must say, counted the slow way from the facts */
async function assertCountersRight(db: MysqlDatabase, tenantId: string, features: string[]) {
  const devices = Number(
    (await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM identity_devices WHERE tenant_id = ?', [tenantId]))[0].c,
  )
  const stat = await db.query<{ devices: number }>('SELECT devices FROM identity_tenant_stats WHERE tenant_id = ?', [
    tenantId,
  ])
  assert.equal(Number(stat[0]?.devices ?? 0), devices, 'devices of the tenant')
  const truth = await db.query<{ feature: string; value: string; c: number }>(
    'SELECT feature, value, COUNT(*) AS c FROM identity_features WHERE tenant_id = ? GROUP BY feature, value',
    [tenantId],
  )
  const counted = await db.query<{ feature: string; value: string; devices: number }>(
    'SELECT feature, value, devices FROM identity_value_counts WHERE tenant_id = ?',
    [tenantId],
  )
  assert.equal(counted.length, truth.length, 'no stray and no missing counter')
  const byKey = new Map(counted.map((row) => [`${row.feature}\u0000${row.value}`, Number(row.devices)]))
  for (const row of truth) {
    assert.equal(byKey.get(`${row.feature}\u0000${row.value}`), Number(row.c), `${row.feature}=${row.value}`)
  }
  for (const feature of features) {
    const counts = truth.filter((row) => row.feature === feature).map((row) => Number(row.c))
    const [stats] = await db.query<{ total: number; pairs: number }>(
      'SELECT total, pairs FROM identity_feature_stats WHERE tenant_id = ? AND feature = ?',
      [tenantId, feature],
    )
    const total = counts.reduce((a, b) => a + b, 0)
    const pairs = counts.reduce((a, c) => a + (c * (c - 1)) / 2, 0)
    assert.deepEqual([Number(stats?.total ?? 0), Number(stats?.pairs ?? 0)], [total, pairs], `totals of ${feature}`)
    assert.equal(
      (1 + pairs) / (1 + (total * (total - 1)) / 2 + 1),
      smoothedAgreement(counts),
      `the estimate of ${feature} from the totals is the one from the counts`,
    )
  }
}

describe('the MySQL identity counters', { skip: mysqlAvailable ? false : 'FP_TEST_MYSQL_URL is not set' }, () => {
  after(dropMysqlStorages)
  const features = ['canvas', 'fonts', 'timezone', 'platform']

  it('equal the slow count after any mix of new devices, repeat visits and new values', async () => {
    const { storage, database } = await newMysqlStorageWithDatabase()
    const next = random(42)
    const devices: string[] = []
    for (let step = 0; step < 120; step++) {
      const values = Object.fromEntries(features.map((feature) => [feature, `${feature}-${Math.floor(next() * 12)}`]))
      if (devices.length === 0 || next() < 0.3) {
        const id = `d${devices.length}`
        await storage.identity.createDevice('t1', id, values, step)
        devices.push(id)
      } else {
        await storage.identity.addObservation('t1', devices[Math.floor(next() * devices.length)], values, step)
      }
      if (step % 40 === 0) {
        await assertCountersRight(database, 't1', features)
      }
    }
    await assertCountersRight(database, 't1', features)
  })

  it('stay right when many writes touch the same values at once (and a deadlock is retried)', async () => {
    const { storage, database } = await newMysqlStorageWithDatabase()
    // Twenty devices, all with the same four values, created together: every transaction updates the same counters
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        storage.identity.createDevice(
          't1',
          `d${n}`,
          { canvas: 'same', fonts: 'same', timezone: 'same', platform: `p${n % 3}` },
          n,
        ),
      ),
    )
    // And twenty more visits of those devices, also together
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        storage.identity.addObservation(
          't1',
          `d${n}`,
          { canvas: 'same', fonts: `f${n % 4}`, timezone: 'same', platform: `p${n % 3}` },
          100 + n,
        ),
      ),
    )
    await assertCountersRight(database, 't1', features)
    assert.equal((await storage.identity.population('t1', { canvas: 'same' })).devicesWithValue('canvas', 'same'), 20)
  })

  it('stay right after devices are forgotten, in several batches', async () => {
    const { storage, database } = await newMysqlStorageWithDatabase()
    const next = random(7)
    // 450 devices: more than the batch of 200 in which the clean-up works. Odd ones keep an event.
    for (let i = 0; i < 450; i++) {
      const values = Object.fromEntries(features.map((feature) => [feature, `${feature}-${Math.floor(next() * 6)}`]))
      await storage.identity.createDevice('t1', `d${i}`, values, i)
      await storage.identity.saveResolution('t1', `r${i}`, `d${i}`, {} as never)
      if (i % 2 === 1) {
        await storage.events.insertEvent({
          requestId: `r${i}`,
          tenantId: 't1',
          receivedAt: i,
          network: {
            ip: '1.1.1.1',
            ipVersion: 4,
            ipPrefix: '1.1.1.0/24',
            ipSource: 'socket',
            ipIntel: { tags: [] },
            viaProxy: false,
            httpVersion: '2',
            headers: { order: [], casing: '', fp: 'x', values: {} },
          },
          payload: { schema: 1, libVersion: 'x', collectedAt: 1, durationMs: 1, components: {}, extended: {} },
          derived: { clockSkewMs: 0 },
        })
      }
    }
    assert.equal(await storage.identity.removeOrphans(), 225)
    await assertCountersRight(database, 't1', features)
    assert.equal((await storage.identity.population('t1', {})).devices, 225)
    await database.run('DELETE FROM events')
    assert.equal(await storage.identity.removeOrphans(), 225)
    await assertCountersRight(database, 't1', features)
    assert.equal((await storage.identity.population('t1', {})).devices, 0)
    const [stats] = await database.query<{ c: number }>('SELECT COUNT(*) AS c FROM identity_feature_stats')
    assert.equal(Number(stats.c), 0, 'nothing left over')
  })

  it('keep tenants apart', async () => {
    const { storage, database } = await newMysqlStorageWithDatabase()
    await storage.identity.createDevice('t1', 'a', { canvas: 'x' }, 1)
    await storage.identity.createDevice('t1', 'b', { canvas: 'x' }, 2)
    await storage.identity.createDevice('t2', 'a', { canvas: 'x' }, 3)
    assert.equal((await storage.identity.population('t1', { canvas: 'x' })).devicesWithValue('canvas', 'x'), 2)
    assert.equal((await storage.identity.population('t2', { canvas: 'x' })).devicesWithValue('canvas', 'x'), 1)
    assert.equal((await storage.identity.population('t3', { canvas: 'x' })).devices, 0)
    await assertCountersRight(database, 't1', ['canvas'])
    await assertCountersRight(database, 't2', ['canvas'])
  })

  it('treat what looks like SQL as plain text', async () => {
    const { storage } = await newMysqlStorageWithDatabase()
    const trick = "x'); DROP TABLE identity_features;--"
    await storage.identity.createDevice(trick, trick, { [trick]: trick }, 1)
    const profile = await storage.identity.getProfile(trick, trick)
    assert.deepEqual([...(profile?.features.get(trick)?.keys() ?? [])], [trick])
    assert.equal((await storage.identity.population(trick, { [trick]: trick })).devicesWithValue(trick, trick), 1)
  })
})

describe('the MySQL migrations', { skip: mysqlAvailable ? false : 'FP_TEST_MYSQL_URL is not set' }, () => {
  after(dropMysqlStorages)

  it('run once each, in order of id, and are remembered', async () => {
    const { database } = await newMysqlStorageWithDatabase()
    const steps: Migration[] = [
      { id: 102, name: 'second', statements: ['ALTER TABLE used_nonces ADD COLUMN second_col INT NOT NULL DEFAULT 0'] },
      { id: 101, name: 'first', statements: ['ALTER TABLE used_nonces ADD COLUMN first_col INT NOT NULL DEFAULT 0'] },
    ]
    await createSchema(database, steps)
    await createSchema(database, steps) // again: nothing runs twice, or the ALTER would fail
    const columns = await database.query<{ name: string }>(
      `SELECT COLUMN_NAME AS name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'used_nonces'`,
    )
    assert.ok(columns.some((c) => c.name === 'first_col') && columns.some((c) => c.name === 'second_col'))
    const done = await database.query<{ id: number; name: string }>(
      'SELECT id, name FROM schema_migrations WHERE id > 100 ORDER BY id',
    )
    assert.deepEqual(
      done.map((row) => [Number(row.id), row.name]),
      [
        [101, 'first'],
        [102, 'second'],
      ],
    )
  })

  it('does not record a step that failed, so that the next start tries it again', async () => {
    const { database } = await newMysqlStorageWithDatabase()
    const broken: Migration[] = [{ id: 9, name: 'broken', statements: ['ALTER TABLE no_such_table ADD COLUMN x INT'] }]
    await assert.rejects(createSchema(database, broken))
    assert.equal((await database.query('SELECT id FROM schema_migrations WHERE id = 9')).length, 0)
  })

  it('survive instances that start together: the tables and the steps are made once', { timeout: 60_000 }, async () => {
    const { another, database } = await newMysqlStorageWithDatabase()
    // The first storage already made the schema; wipe the record of the step and race two more starts to redo it
    await database.run('DELETE FROM schema_migrations')
    await database.run('ALTER TABLE webhook_deliveries DROP COLUMN claimed_by, DROP COLUMN claimed_until')
    await database.run('DROP INDEX identity_features_by_seen ON identity_features')
    await Promise.all([another(), another(), another()])
    const migrationIds = migrations.map((step) => step.id)
    const done = await database.query<{ id: number }>('SELECT id FROM schema_migrations ORDER BY id')
    assert.deepEqual(
      done.map((row) => Number(row.id)),
      migrationIds,
    )
    const columns = await database.query<{ name: string }>(
      `SELECT COLUMN_NAME AS name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'webhook_deliveries' AND column_name = 'claimed_by'`,
    )
    assert.equal(columns.length, 1)
  })
})
