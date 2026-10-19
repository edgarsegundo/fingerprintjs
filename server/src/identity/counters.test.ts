import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { MemoryIdentityStore } from './memory_store'
import { smoothedAgreement, smoothedAgreementFromTotals } from './model'
import { SqliteIdentityStore } from './sqlite_store'

/** A small deterministic generator, so that a failing run can be repeated */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/** What the counters must say, counted the slow way from the facts */
function recount(db: DatabaseSync, tenantId: string) {
  const devices = Number(
    (db.prepare('SELECT COUNT(*) AS c FROM identity_devices WHERE tenant_id = ?').get(tenantId) as { c: number }).c,
  )
  const rows = db
    .prepare('SELECT feature, value, COUNT(*) AS c FROM identity_features WHERE tenant_id = ? GROUP BY feature, value')
    .all(tenantId) as Array<{ feature: string; value: string; c: number }>
  return { devices, rows }
}

function assertCountersRight(db: DatabaseSync, store: SqliteIdentityStore, tenantId: string, features: string[]) {
  const truth = recount(db, tenantId)
  const population = store.population(tenantId)
  assert.equal(population.devices, truth.devices, 'devices')
  for (const row of truth.rows) {
    assert.equal(population.devicesWithValue(row.feature, row.value), Number(row.c), `${row.feature}=${row.value}`)
  }
  for (const feature of features) {
    const counts = truth.rows.filter((row) => row.feature === feature).map((row) => Number(row.c))
    assert.equal(population.agreementProbability(feature), smoothedAgreement(counts), `agreement of ${feature}`)
  }
  // No counter row without a fact behind it
  const stray = db
    .prepare(
      `SELECT COUNT(*) AS c FROM identity_value_counts v WHERE tenant_id = ? AND NOT EXISTS (
         SELECT 1 FROM identity_features f
          WHERE f.tenant_id = v.tenant_id AND f.feature = v.feature AND f.value = v.value)`,
    )
    .get(tenantId) as { c: number }
  assert.equal(Number(stray.c), 0, 'no stray counter')
}

describe('running counters of the SQLite identity store', () => {
  const features = ['canvas', 'fonts', 'timezone', 'platform']

  it('equal the slow count after any mix of new devices, repeat visits and new values', () => {
    const db = new DatabaseSync(':memory:')
    const store = new SqliteIdentityStore(db)
    const next = random(42)
    const devices: string[] = []
    for (let step = 0; step < 400; step++) {
      const values = Object.fromEntries(features.map((feature) => [feature, `${feature}-${Math.floor(next() * 12)}`]))
      if (devices.length === 0 || next() < 0.3) {
        const id = `d${devices.length}`
        store.createDevice('t1', id, values, step)
        devices.push(id)
      } else {
        store.addObservation('t1', devices[Math.floor(next() * devices.length)], values, step)
      }
      if (step % 50 === 0) {
        assertCountersRight(db, store, 't1', features)
      }
    }
    assertCountersRight(db, store, 't1', features)
  })

  it('keep tenants apart', () => {
    const db = new DatabaseSync(':memory:')
    const store = new SqliteIdentityStore(db)
    store.createDevice('t1', 'a', { canvas: 'x' }, 1)
    store.createDevice('t1', 'b', { canvas: 'x' }, 2)
    store.createDevice('t2', 'a', { canvas: 'x' }, 3)
    assert.equal(store.population('t1').devicesWithValue('canvas', 'x'), 2)
    assert.equal(store.population('t2').devicesWithValue('canvas', 'x'), 1)
    assert.equal(store.population('t1').devices, 2)
    assert.equal(store.population('t3').devices, 0)
    assert.equal(store.population('t3').devicesWithValue('canvas', 'x'), 0)
    assert.equal(store.population('t3').agreementProbability('canvas'), 0.5, 'nothing known: one half')
  })

  it('follow the clean-up of devices whose events were deleted', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE events (request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)`)
    const store = new SqliteIdentityStore(db)
    const next = random(7)
    for (let i = 0; i < 60; i++) {
      const values = Object.fromEntries(features.map((feature) => [feature, `${feature}-${Math.floor(next() * 6)}`]))
      store.createDevice('t1', `d${i}`, values, i)
      store.saveResolution('t1', `r${i}`, `d${i}`, {} as never)
      if (i % 3 !== 0) {
        db.prepare('INSERT INTO events VALUES (?, ?)').run(`r${i}`, 't1')
      }
    }
    assert.equal(store.removeOrphans(), 20)
    assertCountersRight(db, store, 't1', features)
    assert.equal(store.population('t1').devices, 40)
    db.exec('DELETE FROM events')
    assert.equal(store.removeOrphans(), 40)
    assertCountersRight(db, store, 't1', features)
    assert.equal(store.population('t1').devices, 0)
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM identity_value_counts').get() as { c: number }).c), 0)
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM identity_feature_stats').get() as { c: number }).c), 0)
  })

  it('count again a database that was made before the counters existed, once', () => {
    const db = new DatabaseSync(':memory:')
    const first = new SqliteIdentityStore(db)
    first.createDevice('t1', 'a', { canvas: 'x', fonts: 'f' }, 1)
    first.createDevice('t1', 'b', { canvas: 'x' }, 2)
    // Make it look like an old database: no counters, no triggers
    db.exec(`
      DROP TRIGGER identity_features_added; DROP TRIGGER identity_features_removed;
      DROP TRIGGER identity_devices_added; DROP TRIGGER identity_devices_removed;
      DELETE FROM identity_value_counts; DELETE FROM identity_feature_stats; DELETE FROM identity_tenant_stats;
      DELETE FROM identity_meta;
    `)
    const second = new SqliteIdentityStore(db)
    assertCountersRight(db, second, 't1', ['canvas', 'fonts'])
    assert.equal(second.population('t1').devices, 2)
    // And from then on it follows the writes
    second.createDevice('t1', 'c', { canvas: 'x' }, 3)
    assert.equal(second.population('t1').devicesWithValue('canvas', 'x'), 3)
    assertCountersRight(db, second, 't1', ['canvas', 'fonts'])
    // Opening it again does not count twice
    const third = new SqliteIdentityStore(db)
    assert.equal(third.population('t1').devicesWithValue('canvas', 'x'), 3)
    assertCountersRight(db, third, 't1', ['canvas', 'fonts'])
  })

  it('say the same as the memory store for the same history', () => {
    const memory = new MemoryIdentityStore()
    const sqlite = new SqliteIdentityStore(new DatabaseSync(':memory:'))
    const next = random(99)
    const ids: string[] = []
    for (let step = 0; step < 200; step++) {
      const values = Object.fromEntries(features.map((feature) => [feature, `${feature}-${Math.floor(next() * 9)}`]))
      if (ids.length === 0 || next() < 0.4) {
        const id = `d${ids.length}`
        memory.createDevice('t1', id, values, step)
        sqlite.createDevice('t1', id, values, step)
        ids.push(id)
      } else {
        const id = ids[Math.floor(next() * ids.length)]
        memory.addObservation('t1', id, values, step)
        sqlite.addObservation('t1', id, values, step)
      }
    }
    const a = memory.population('t1')
    const b = sqlite.population('t1')
    assert.equal(a.devices, b.devices)
    for (const feature of features) {
      assert.ok(Math.abs(a.agreementProbability(feature) - b.agreementProbability(feature)) < 1e-12, feature)
      for (let v = 0; v < 9; v++) {
        assert.equal(a.devicesWithValue(feature, `${feature}-${v}`), b.devicesWithValue(feature, `${feature}-${v}`))
      }
    }
  })
})

describe('smoothedAgreementFromTotals', () => {
  it('is the same estimate as counting the values', () => {
    for (const counts of [[], [1], [3], [1, 1, 1], [5, 2, 1], [10, 10]]) {
      const total = counts.reduce((a, b) => a + b, 0)
      const pairs = counts.reduce((a, c) => a + (c * (c - 1)) / 2, 0)
      assert.equal(smoothedAgreementFromTotals(total, pairs), smoothedAgreement(counts), JSON.stringify(counts))
    }
  })
})
