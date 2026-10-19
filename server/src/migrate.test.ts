import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { IdentityEngine } from './identity/engine'
import { defaultModel } from './identity/model'
import { migrateSqliteToMysql } from './migrate'
import { sqliteStorage } from './storage'
import type { StoredEvent } from './store/types'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorageWithDatabase } from './testing/mysql'

const event = (n: number, tenantId = 't1'): StoredEvent => ({
  requestId: `r${n}`,
  tenantId,
  receivedAt: 1_000_000 + n,
  network: {
    ip: `203.0.113.${n}`,
    ipVersion: 4,
    ipPrefix: '203.0.113.0/24',
    ipSource: 'socket',
    ipIntel: { tags: [] },
    viaProxy: false,
    httpVersion: '1.1',
    headers: { order: ['host'], casing: 'T', fp: 'abc', values: {} },
  },
  payload: {
    schema: 1,
    libVersion: '5.3.0',
    collectedAt: 1,
    durationMs: 2,
    linkedId: `acct${n % 3}`,
    components: {},
    extended: { note: { duration: 1, value: { texto: 'ação, acentuação e "aspas" \u{1F600}' } } },
  },
  derived: { clockSkewMs: 12 },
})

describe('migrating SQLite to MySQL', { skip: mysqlAvailable ? false : 'FP_TEST_MYSQL_URL is not set' }, () => {
  after(dropMysqlStorages)

  async function filled() {
    const file = join(mkdtempSync(join(tmpdir(), 'fp-migrate-')), 'events.db')
    const from = sqliteStorage(file)
    let counter = 0
    const engine = new IdentityEngine(
      from.identity,
      { ...defaultModel(), matchProbability: 0.95 },
      {
        newId: () => `v${++counter}`,
        now: () => 1,
      },
    )
    for (let n = 1; n <= 12; n++) {
      await from.events.insertEvent(event(n))
      await from.events.insertEvent(event(n + 100, 't2'))
      const device = n % 4
      await engine.resolve(
        'default',
        `r${n}`,
        { canvas: `c${device}`, fonts: `f${device}`, tlsCiphers: `t${device}`, timezone: 'tz' },
        n,
      )
    }
    await engine.resolve('default', 'r1', { canvas: 'c1', fonts: 'f1', tlsCiphers: 't1', timezone: 'tz' }, 99)
    await from.webhooks.enqueue({ id: 'd1', tenantId: 't1', endpointId: 'main', body: '{"a":"ã"}', createdAt: 5 }, 100)
    await from.audit.record({
      at: 7,
      tenantId: 't1',
      action: 'event.read',
      subject: 'r1',
      keyId: 'abcd1234',
      requester: 'h_x',
      status: 200,
    })
    await from.usage.add('t1', 'collects', Date.UTC(2026, 9, 19), 5)
    await from.graph.record('graphkey', 't1', 9, true)
    await from.tenants.create({
      id: 'shop',
      publicKey: 'pk_shop_0123456789',
      secretKeySha256: ['ab'.repeat(32)],
      allowedOrigins: [],
      status: 'active',
      settings: {},
      createdAt: 3,
      updatedAt: 3,
    })
    await from.close()
    return file
  }

  it('copies every table and counts the counters again, and the check agrees', async () => {
    const file = await filled()
    const { storage, database } = await newMysqlStorageWithDatabase()
    const { DatabaseSync } = await import('node:sqlite')
    const sqlite = new DatabaseSync(file, { readOnly: true })
    try {
      const report = await migrateSqliteToMysql({ sqlite, mysql: database })
      assert.deepEqual(report.problems, [])
      assert.equal(report.copied.events, 24)
      assert.ok(report.copied.identity_devices >= 1)
      // The events come out as they went in, with their text intact
      const back = await storage.events.getEvent('t1', 'r1')
      assert.deepEqual(back, event(1))
      // The identity is the same: the counters that were counted again say what the old ones said
      const old = sqliteStorage(file)
      for (const device of [0, 1, 2, 3]) {
        const features = { canvas: `c${device}`, fonts: `f${device}`, tlsCiphers: `t${device}`, timezone: 'tz' }
        const was = await old.identity.population('default', features)
        const is = await storage.identity.population('default', features)
        assert.equal(is.devices, was.devices)
        for (const [feature, value] of Object.entries(features)) {
          assert.equal(is.devicesWithValue(feature, value), was.devicesWithValue(feature, value), `${feature}=${value}`)
          assert.equal(is.agreementProbability(feature), was.agreementProbability(feature), feature)
        }
        assert.deepEqual(
          await storage.identity.findCandidates('default', features, 20),
          await old.identity.findCandidates('default', features, 20),
        )
      }
      assert.deepEqual(
        await storage.identity.getResolution('default', 'r1'),
        await old.identity.getResolution('default', 'r1'),
      )
      assert.ok((await storage.identity.population('default', {})).devices >= 4)
      await old.close()
      assert.equal((await storage.usage.month('t1', '2026-10')).collects, 5)
      assert.equal((await storage.webhooks.get('t1', 'd1'))?.body, '{"a":"ã"}')
      assert.equal((await storage.tenants.list()).length, 1)
    } finally {
      sqlite.close()
    }
  })

  it('refuses a MySQL database that already has data, unless asked to add to it', async () => {
    const file = await filled()
    const { database } = await newMysqlStorageWithDatabase()
    const { DatabaseSync } = await import('node:sqlite')
    const sqlite = new DatabaseSync(file, { readOnly: true })
    try {
      await migrateSqliteToMysql({ sqlite, mysql: database })
      await assert.rejects(migrateSqliteToMysql({ sqlite, mysql: database }), /already has data/)
      // Adding the same rows again is an error of the database (same keys), not a silent doubling
      await assert.rejects(migrateSqliteToMysql({ sqlite, mysql: database, append: true }))
    } finally {
      sqlite.close()
    }
  })
})
