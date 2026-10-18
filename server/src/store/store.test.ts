import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'

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

const implementations: Array<[string, () => EventStore]> = [
  ['MemoryEventStore', () => new MemoryEventStore()],
  ['SqliteEventStore', () => new SqliteEventStore(':memory:')],
]

for (const [name, create] of implementations) {
  describe(name, () => {
    it('returns what was stored', () => {
      const store = create()
      const event = makeEvent('r1')
      store.insertEvent(event)
      assert.deepEqual(store.getEvent('t1', 'r1'), event)
      store.close()
    })

    it('never shows an event to another tenant', () => {
      const store = create()
      store.insertEvent(makeEvent('r1', 't1'))
      assert.equal(store.getEvent('t2', 'r1'), undefined)
      assert.equal(store.getEvent('t1', 'missing'), undefined)
      store.close()
    })

    it('refuses a duplicated request id', () => {
      const store = create()
      store.insertEvent(makeEvent('r1'))
      assert.throws(() => store.insertEvent(makeEvent('r1')))
      store.close()
    })

    it('lets a nonce be used once', () => {
      const store = create()
      assert.equal(store.consumeNonce('n1', 5000), true)
      assert.equal(store.consumeNonce('n1', 5000), false)
      assert.equal(store.consumeNonce('n2', 5000), true)
      store.close()
    })

    it('purges old events and expired nonces only', () => {
      const store = create()
      store.insertEvent(makeEvent('old', 't1', 1000))
      store.insertEvent(makeEvent('new', 't1', 9000))
      store.consumeNonce('expired', 4000)
      store.consumeNonce('valid', 20_000)
      const deleted = store.purge(10_000, 5000) // events older than 5000 go
      assert.deepEqual(deleted, { events: 1, nonces: 1 })
      assert.equal(store.getEvent('t1', 'old'), undefined)
      assert.ok(store.getEvent('t1', 'new'))
      assert.equal(store.consumeNonce('valid', 20_000), false, 'a nonce that has not expired must still be remembered')
      assert.equal(
        store.consumeNonce('expired', 4000),
        true,
        'an expired nonce is forgotten (the nonce itself is expired by then)',
      )
      store.close()
    })

    it('lists the events of a tenant in a stable order, page by page, within a time range', () => {
      const store = create()
      store.insertEvent(makeEvent('c', 't1', 3000))
      store.insertEvent(makeEvent('a', 't1', 1000))
      store.insertEvent(makeEvent('b2', 't1', 2000))
      store.insertEvent(makeEvent('b1', 't1', 2000))
      store.insertEvent(makeEvent('other', 't2', 2000))

      const ids = (events: StoredEvent[]) => events.map((event) => event.requestId)
      assert.deepEqual(ids(store.listEvents('t1', { limit: 10 })), ['a', 'b1', 'b2', 'c'])
      assert.deepEqual(ids(store.listEvents('t1', { limit: 10, since: 2000 })), ['b1', 'b2', 'c'])
      assert.deepEqual(ids(store.listEvents('t1', { limit: 10, since: 1500, until: 3000 })), ['b1', 'b2'])

      // Walk through the pages, including the two events that share a time
      const seen: string[] = []
      let after: { receivedAt: number; requestId: string } | undefined
      for (;;) {
        const page = store.listEvents('t1', { limit: 1, after })
        if (page.length === 0) {
          break
        }
        seen.push(page[0].requestId)
        after = { receivedAt: page[0].receivedAt, requestId: page[0].requestId }
      }
      assert.deepEqual(seen, ['a', 'b1', 'b2', 'c'])
      assert.deepEqual(ids(store.listEvents('t2', { limit: 10 })), ['other'])
      store.close()
    })

    it('deletes the events of one linkedId of one tenant and nothing else', () => {
      const store = create()
      const withId = (requestId: string, tenantId: string, linkedId?: string) => {
        const event = makeEvent(requestId, tenantId)
        if (linkedId) {
          event.payload.linkedId = linkedId
        }
        return event
      }
      store.insertEvent(withId('a1', 't1', 'person_1'))
      store.insertEvent(withId('a2', 't1', 'person_1'))
      store.insertEvent(withId('b1', 't1', 'person_2'))
      store.insertEvent(withId('c1', 't1'))
      store.insertEvent(withId('d1', 't2', 'person_1'))

      assert.equal(store.deleteByLinkedId('t1', 'person_1'), 2)
      assert.equal(store.getEvent('t1', 'a1'), undefined)
      assert.equal(store.getEvent('t1', 'a2'), undefined)
      for (const kept of [
        ['t1', 'b1'],
        ['t1', 'c1'],
        ['t2', 'd1'],
      ]) {
        assert.ok(store.getEvent(kept[0], kept[1]), kept.join('/'))
      }
      assert.equal(store.deleteByLinkedId('t1', 'person_1'), 0)
      assert.equal(store.deleteByLinkedId('t1', 'nobody'), 0)
      store.close()
    })

    it('keeps data that looks like SQL as plain data', () => {
      const store = create()
      const event = makeEvent("r'); DROP TABLE events;--")
      event.network.headers.values = { 'user-agent': "x'; DROP TABLE events;--" }
      store.insertEvent(event)
      assert.deepEqual(store.getEvent('t1', "r'); DROP TABLE events;--"), event)
      store.close()
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
      store.insertEvent(event)
      assert.equal(store.getEvent('t1', 'r1')?.payload.linkedId, 'device_1')
      store.close()
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
