import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import { MemoryEventStore } from './memory'
import { SqliteEventStore } from './sqlite'
import { EventStore, StoredEvent } from './types'

function makeEvent(requestId: string, tenantId = 't1', receivedAt = 1_000_000): StoredEvent {
  const network: NetworkSignals = {
    ip: '203.0.113.5',
    ipVersion: 4,
    ipPrefix: '203.0.113.0/24',
    ipSource: 'socket',
    ipIntel: { tags: ['datacenter'] },
    viaProxy: false,
    httpVersion: '1.1',
    headers: { order: ['host'], casing: 'T', fp: 'abc', values: {} },
    tls: { ja4: 't13d1516h2_8daaf6152771_e5627efa2ab1', source: 'front' },
  }
  return {
    requestId,
    tenantId,
    receivedAt,
    network,
    payload: {
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: 1,
      durationMs: 2,
      components: {},
      extended: { a: { duration: 1, value: { n: 1 } } },
    },
    derived: { clockSkewMs: 12 },
  }
}

const implementations: Array<[string, () => EventStore | Promise<EventStore>]> = [
  ['MemoryEventStore', () => new MemoryEventStore()],
  ['SqliteEventStore', () => new SqliteEventStore(':memory:')],
  ...(mysqlAvailable
    ? [['MysqlEventStore', async () => (await newMysqlStorage()).events] as [string, () => Promise<EventStore>]]
    : []),
]

for (const [name, create] of implementations) {
  describe(name, () => {
    after(dropMysqlStorages)

    it('returns what was stored', async () => {
      const store = await create()
      const event = makeEvent('r1')
      await store.insertEvent(event)
      assert.deepEqual(await store.getEvent('t1', 'r1'), event)
      await store.close()
    })

    it('never shows an event to another tenant', async () => {
      const store = await create()
      await store.insertEvent(makeEvent('r1', 't1'))
      assert.equal(await store.getEvent('t2', 'r1'), undefined)
      assert.equal(await store.getEvent('t1', 'missing'), undefined)
      await store.close()
    })

    it('refuses a duplicated request id', async () => {
      const store = await create()
      await store.insertEvent(makeEvent('r1'))
      await assert.rejects(async () => store.insertEvent(makeEvent('r1')))
      await store.close()
    })

    it('lets a nonce be used once', async () => {
      const store = await create()
      assert.equal(await store.consumeNonce('n1', 5000), true)
      assert.equal(await store.consumeNonce('n1', 5000), false)
      assert.equal(await store.consumeNonce('n2', 5000), true)
      await store.close()
    })

    it('purges old events and expired nonces only', async () => {
      const store = await create()
      await store.insertEvent(makeEvent('old', 't1', 1000))
      await store.insertEvent(makeEvent('new', 't1', 9000))
      await store.consumeNonce('expired', 4000)
      await store.consumeNonce('valid', 20_000)
      const deleted = await store.purge(10_000, 5000) // events older than 5000 go
      assert.deepEqual(deleted, { events: 1, nonces: 1 })
      assert.equal(await store.getEvent('t1', 'old'), undefined)
      assert.ok(await store.getEvent('t1', 'new'))
      assert.equal(
        await store.consumeNonce('valid', 20_000),
        false,
        'a nonce that has not expired must still be remembered',
      )
      assert.equal(
        await store.consumeNonce('expired', 4000),
        true,
        'an expired nonce is forgotten (the nonce itself is expired by then)',
      )
      await store.close()
    })

    it('lists the events of a tenant in a stable order, page by page, within a time range', async () => {
      const store = await create()
      await store.insertEvent(makeEvent('c', 't1', 3000))
      await store.insertEvent(makeEvent('a', 't1', 1000))
      await store.insertEvent(makeEvent('b2', 't1', 2000))
      await store.insertEvent(makeEvent('b1', 't1', 2000))
      await store.insertEvent(makeEvent('other', 't2', 2000))

      const ids = (events: StoredEvent[]) => events.map((event) => event.requestId)
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10 })), ['a', 'b1', 'b2', 'c'])
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, since: 2000 })), ['b1', 'b2', 'c'])
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, since: 1500, until: 3000 })), ['b1', 'b2'])

      // Walk through the pages, including the two events that share a time
      const seen: string[] = []
      let after: { receivedAt: number; requestId: string } | undefined
      for (;;) {
        const page = await store.listEvents('t1', { limit: 1, after })
        if (page.length === 0) {
          break
        }
        seen.push(page[0].requestId)
        after = { receivedAt: page[0].receivedAt, requestId: page[0].requestId }
      }
      assert.deepEqual(seen, ['a', 'b1', 'b2', 'c'])
      assert.deepEqual(ids(await store.listEvents('t2', { limit: 10 })), ['other'])
      await store.close()
    })

    it('deletes events by request id, for the tenant only, and says how many', async () => {
      const store = await create()
      await store.insertEvent(makeEvent('a', 't1', 1000))
      await store.insertEvent(makeEvent('b', 't1', 2000))
      await store.insertEvent(makeEvent('c', 't1', 3000))
      await store.insertEvent(makeEvent('a2', 't2', 1000))
      assert.equal(
        await store.deleteEvents('t1', ['a', 'c', 'nope', 'a2']),
        2,
        'a request id of another tenant is not deleted',
      )
      assert.deepEqual(
        (await store.listEvents('t1', { limit: 10 })).map((event) => event.requestId),
        ['b'],
      )
      assert.ok(await store.getEvent('t2', 'a2'))
      assert.equal(await store.deleteEvents('t1', []), 0)
      assert.equal(await store.deleteEvents('t1', ["x'); DROP TABLE events;--"]), 0)
      assert.ok(await store.getEvent('t1', 'b'))
      await store.close()
    })

    it('lists newest first, page by page, including events that share a time, and filters', async () => {
      const store = await create()
      const withLink = async (id: string, at: number, linkedId?: string, ip?: string) => {
        const event = makeEvent(id, 't1', at)
        event.payload.linkedId = linkedId
        if (ip) {
          event.network.ip = ip
        }
        await store.insertEvent(event)
      }
      await withLink('a', 1000, 'u1')
      await withLink('b1', 2000, 'u2', '198.51.100.7')
      await withLink('b2', 2000, 'u1')
      await withLink('b3', 2000)
      await withLink('c', 3000, 'u1')
      await store.insertEvent(makeEvent('other', 't2', 2000))

      const ids = (events: StoredEvent[]) => events.map((event) => event.requestId)
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, newestFirst: true })), [
        'c',
        'b3',
        'b2',
        'b1',
        'a',
      ])
      for (const newestFirst of [true, false]) {
        const seen: string[] = []
        let after: { receivedAt: number; requestId: string } | undefined
        for (;;) {
          const page = await store.listEvents('t1', { limit: 2, after, newestFirst })
          if (page.length === 0) {
            break
          }
          seen.push(...ids(page))
          after = { receivedAt: page[page.length - 1].receivedAt, requestId: page[page.length - 1].requestId }
        }
        assert.deepEqual(
          seen,
          newestFirst ? ['c', 'b3', 'b2', 'b1', 'a'] : ['a', 'b1', 'b2', 'b3', 'c'],
          `${newestFirst}`,
        )
      }
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, linkedId: 'u1', newestFirst: true })), [
        'c',
        'b2',
        'a',
      ])
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, ip: '198.51.100.7' })), ['b1'])
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, linkedId: 'u1', ip: '198.51.100.7' })), [])
      assert.deepEqual(ids(await store.listEvents('t1', { limit: 10, linkedId: "x' OR '1'='1" })), [])
      assert.deepEqual(ids(await store.listEvents('t2', { limit: 10, linkedId: 'u1' })), [])
      await store.close()
    })

    it('purges the events of one tenant by its own retention, and the expired nonces on their own', async () => {
      const store = await create()
      await store.insertEvent(makeEvent('a-old', 't1', 1000))
      await store.insertEvent(makeEvent('a-new', 't1', 9000))
      await store.insertEvent(makeEvent('b-old', 't2', 1000))
      await store.consumeNonce('expired', 4000)
      await store.consumeNonce('valid', 20_000)
      assert.equal(await store.purgeTenant('t1', 10_000, 5000), 1, 'only the old event of t1')
      assert.ok(await store.getEvent('t2', 'b-old'), 'the other tenant keeps its old event: it has its own retention')
      assert.ok(await store.getEvent('t1', 'a-new'))
      assert.equal(await store.purgeNonces(10_000), 1)
      assert.equal(await store.consumeNonce('valid', 20_000), false)
      assert.equal(await store.purgeTenant('nobody', 10_000, 5000), 0)
      await store.close()
    })

    it('deletes the events of one linkedId of one tenant and nothing else', async () => {
      const store = await create()
      const withId = (requestId: string, tenantId: string, linkedId?: string) => {
        const event = makeEvent(requestId, tenantId)
        if (linkedId) {
          event.payload.linkedId = linkedId
        }
        return event
      }
      await store.insertEvent(withId('a1', 't1', 'person_1'))
      await store.insertEvent(withId('a2', 't1', 'person_1'))
      await store.insertEvent(withId('b1', 't1', 'person_2'))
      await store.insertEvent(withId('c1', 't1'))
      await store.insertEvent(withId('d1', 't2', 'person_1'))

      assert.equal(await store.deleteByLinkedId('t1', 'person_1'), 2)
      assert.equal(await store.getEvent('t1', 'a1'), undefined)
      assert.equal(await store.getEvent('t1', 'a2'), undefined)
      for (const kept of [
        ['t1', 'b1'],
        ['t1', 'c1'],
        ['t2', 'd1'],
      ]) {
        assert.ok(await store.getEvent(kept[0], kept[1]), kept.join('/'))
      }
      assert.equal(await store.deleteByLinkedId('t1', 'person_1'), 0)
      assert.equal(await store.deleteByLinkedId('t1', 'nobody'), 0)
      await store.close()
    })

    it('keeps data that looks like SQL as plain data', async () => {
      const store = await create()
      const event = makeEvent("r'); DROP TABLE events;--")
      event.network.headers.values = { 'user-agent': "x'; DROP TABLE events;--" }
      await store.insertEvent(event)
      assert.deepEqual(await store.getEvent('t1', "r'); DROP TABLE events;--"), event)
      await store.close()
    })
  })
}

describe('SqliteEventStore migration', () => {
  it('adds the linked_id column to a database created without it', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dir = mkdtempSync(join(tmpdir(), 'fp-migrate-'))
    try {
      const file = join(dir, 'old.db')
      const old = new DatabaseSync(file)
      old.exec(`CREATE TABLE events (request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, received_at INTEGER NOT NULL,
        ip TEXT NOT NULL, ja4 TEXT, header_fp TEXT NOT NULL, payload_json TEXT NOT NULL, network_json TEXT NOT NULL,
        derived_json TEXT NOT NULL)`)
      old.close()
      const store = new SqliteEventStore(file)
      const event = makeEvent('r1')
      event.payload.linkedId = 'device_1'
      await store.insertEvent(event)
      assert.equal((await store.getEvent('t1', 'r1'))?.payload.linkedId, 'device_1')
      await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SqliteEventStore on disk', () => {
  it('keeps events after reopening the file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'fp-store-'))
    try {
      const file = join(dir, 'events.db')
      const first = new SqliteEventStore(file)
      first.insertEvent(makeEvent('r1'))
      first.consumeNonce('n1', 9e12)
      first.close()
      const second = new SqliteEventStore(file)
      assert.ok(second.getEvent('t1', 'r1'))
      assert.equal(second.consumeNonce('n1', 9e12), false)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
