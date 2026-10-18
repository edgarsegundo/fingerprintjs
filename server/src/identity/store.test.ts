import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'
import { SqliteEventStore } from '../store/sqlite'
import type { StoredEvent } from '../store/types'

import { MemoryIdentityStore } from './memory_store'
import { smoothedAgreement } from './model'
import { SqliteIdentityStore } from './sqlite_store'
import type { IdentityStore, Resolution } from './store'

const resolution = (visitorId: string): Resolution => ({
  visitorId,
  matched: true,
  ambiguous: false,
  logOdds: 4.2,
  probability: null,
  provisionalProbability: 0.97,
  calibrated: false,
  candidates: 2,
  devices: 10,
  explanation: [{ feature: 'canvas', outcome: 'agree', weight: 3.1, probabilityWithoutIt: 0.5 }],
  resolvedAt: 99,
})

const implementations: Array<[string, () => IdentityStore]> = [
  ['MemoryIdentityStore', () => new MemoryIdentityStore()],
  ['SqliteIdentityStore', () => new SqliteIdentityStore(new DatabaseSync(':memory:'))],
]

for (const [name, create] of implementations) {
  describe(name, () => {
    it('keeps what it is told about a device, with counts, and adds values over time', () => {
      const store = create()
      store.createDevice('t1', 'd1', { canvas: 'a', fonts: 'f' }, 100)
      store.addObservation('t1', 'd1', { canvas: 'a', fonts: 'f2' }, 200)
      const profile = store.getProfile('t1', 'd1')
      assert.equal(profile?.visits, 2)
      assert.equal(profile?.firstSeen, 100)
      assert.equal(profile?.lastSeen, 200)
      assert.deepEqual(profile?.features.get('canvas'), new Map([['a', { count: 2, lastSeen: 200 }]]))
      assert.deepEqual(
        [...(profile?.features.get('fonts') ?? new Map()).keys()].sort(),
        ['f', 'f2'],
        'a device keeps every value it has had',
      )
      assert.equal(store.getProfile('t1', 'nope'), undefined)
    })

    it('refuses a duplicate device and an observation of an unknown one', () => {
      const store = create()
      store.createDevice('t1', 'd1', { canvas: 'a' }, 1)
      assert.throws(() => store.createDevice('t1', 'd1', { canvas: 'a' }, 2))
      assert.throws(() => store.addObservation('t1', 'ghost', { canvas: 'a' }, 2))
    })

    it('counts devices and devices per value', () => {
      const store = create()
      store.createDevice('t1', 'd1', { canvas: 'a', tz: 'x' }, 1)
      store.createDevice('t1', 'd2', { canvas: 'b', tz: 'x' }, 2)
      store.addObservation('t1', 'd1', { canvas: 'a', tz: 'x' }, 3)
      const population = store.population('t1')
      assert.equal(population.devices, 2)
      assert.equal(population.devicesWithValue('tz', 'x'), 2, 'a device counts once however often it came back')
      assert.equal(population.devicesWithValue('canvas', 'a'), 1)
      assert.equal(population.devicesWithValue('canvas', 'zzz'), 0)
      assert.equal(store.population('other').devices, 0)
    })

    it('estimates how often two devices agree, smoothed', () => {
      const store = create()
      assert.equal(store.population('t1').agreementProbability('tz'), 0.5, 'nothing known: one half')
      for (let n = 1; n <= 4; n++) {
        store.createDevice('t1', `d${n}`, { tz: n <= 3 ? 'common' : 'rare', canvas: `c${n}` }, n)
      }
      const population = store.population('t1')
      assert.equal(population.agreementProbability('tz'), smoothedAgreement([3, 1]))
      assert.equal(population.agreementProbability('canvas'), smoothedAgreement([1, 1, 1, 1]))
      assert.ok(population.agreementProbability('tz') > population.agreementProbability('canvas'))
      // And it follows the data when more arrives
      store.createDevice('t1', 'd5', { tz: 'common' }, 5)
      assert.equal(store.population('t1').agreementProbability('tz'), smoothedAgreement([4, 1]))
    })

    it('finds the devices that share a value, the rarest match first, and only for the tenant', () => {
      const store = create()
      store.createDevice('t1', 'd1', { canvas: 'rare', tz: 'common' }, 1)
      store.createDevice('t1', 'd2', { canvas: 'other', tz: 'common' }, 2)
      store.createDevice('t1', 'd3', { canvas: 'other2', tz: 'common' }, 3)
      store.createDevice('t2', 'x1', { canvas: 'rare' }, 4)
      assert.deepEqual(store.findCandidates('t1', { canvas: 'rare', tz: 'common' }, 10), ['d1', 'd2', 'd3'])
      assert.deepEqual(store.findCandidates('t1', { canvas: 'rare' }, 10), ['d1'])
      assert.deepEqual(store.findCandidates('t1', { canvas: 'unknown' }, 10), [])
      assert.deepEqual(store.findCandidates('t1', { tz: 'common' }, 2).length, 2, 'the limit is respected')
      assert.deepEqual(store.findCandidates('t2', { canvas: 'rare' }, 10), ['x1'])
    })

    it('puts the device that shares a rare value before the one that shares a common value', () => {
      const store = create()
      // d1 shares only the common value; d2 shares only the rare one. Their ids are in the opposite order on purpose.
      store.createDevice('t1', 'd1', { tz: 'common', canvas: 'x1' }, 1)
      store.createDevice('t1', 'd2', { tz: 'other', canvas: 'rare' }, 2)
      for (let n = 3; n <= 8; n++) {
        store.createDevice('t1', `d${n}`, { tz: 'common', canvas: `x${n}` }, n)
      }
      assert.deepEqual(store.findCandidates('t1', { tz: 'common', canvas: 'rare' }, 3)[0], 'd2')
    })

    it('ignores a value that too many devices share when looking for candidates', () => {
      const store = create()
      for (let n = 1; n <= 80; n++) {
        store.createDevice('t1', `d${n}`, { tz: 'everyone', canvas: `c${n}` }, n)
      }
      assert.deepEqual(store.findCandidates('t1', { tz: 'everyone' }, 10), [])
      assert.deepEqual(store.findCandidates('t1', { tz: 'everyone', canvas: 'c7' }, 10), ['d7'])
    })

    it('stores and returns a resolution exactly, for its tenant only', () => {
      const store = create()
      store.createDevice('t1', 'd1', { canvas: 'a' }, 1)
      store.saveResolution('t1', 'req1', 'd1', resolution('d1'))
      assert.deepEqual(store.getResolution('t1', 'req1'), resolution('d1'))
      assert.equal(store.getResolution('t2', 'req1'), undefined)
      assert.equal(store.getResolution('t1', 'nope'), undefined)
    })
  })
}

describe('forgetting devices with their events', () => {
  function networkOf(): NetworkSignals {
    return {
      ip: '203.0.113.5',
      ipVersion: 4,
      ipPrefix: '203.0.113.0/24',
      ipSource: 'socket',
      ipIntel: { tags: [] },
      viaProxy: false,
      httpVersion: '2.0',
      headers: { order: [], casing: '', fp: 'x', values: {} },
    }
  }

  const eventFor = (requestId: string, linkedId: string): StoredEvent => ({
    requestId,
    tenantId: 't1',
    receivedAt: 1000,
    network: networkOf(),
    payload: { schema: 1, libVersion: '5.3.0', collectedAt: 1, durationMs: 1, linkedId, components: {}, extended: {} },
    derived: { clockSkewMs: 0 },
  })

  it('SQLite: a device disappears when none of its events is left, and stays when one is', () => {
    const events = new SqliteEventStore(':memory:')
    const identity = new SqliteIdentityStore(events.connection)
    events.insertEvent(eventFor('r1', 'person_1'))
    events.insertEvent(eventFor('r2', 'person_1'))
    events.insertEvent(eventFor('r3', 'person_2'))
    identity.createDevice('t1', 'devA', { canvas: 'a' }, 1)
    identity.saveResolution('t1', 'r1', 'devA', resolution('devA'))
    identity.saveResolution('t1', 'r2', 'devA', resolution('devA'))
    identity.createDevice('t1', 'devB', { canvas: 'b' }, 2)
    identity.saveResolution('t1', 'r3', 'devB', resolution('devB'))

    assert.equal(identity.removeOrphans(), 0, 'nothing is orphaned while every event exists')
    events.deleteByLinkedId('t1', 'person_1')
    assert.equal(identity.removeOrphans(), 1)
    assert.equal(identity.getProfile('t1', 'devA'), undefined)
    assert.equal(identity.getResolution('t1', 'r1'), undefined)
    assert.ok(identity.getProfile('t1', 'devB'), 'the other person is untouched')
    assert.equal(identity.population('t1').devices, 1)
    assert.equal(identity.population('t1').devicesWithValue('canvas', 'a'), 0, 'the values go with the device')
    events.close()
  })

  it('SQLite: a device that other events still point to is kept', () => {
    const events = new SqliteEventStore(':memory:')
    const identity = new SqliteIdentityStore(events.connection)
    events.insertEvent(eventFor('r1', 'person_1'))
    events.insertEvent(eventFor('r2', 'person_2'))
    identity.createDevice('t1', 'devShared', { canvas: 'a' }, 1)
    identity.saveResolution('t1', 'r1', 'devShared', resolution('devShared'))
    identity.saveResolution('t1', 'r2', 'devShared', resolution('devShared'))
    events.deleteByLinkedId('t1', 'person_1')
    assert.equal(identity.removeOrphans(), 0)
    assert.ok(identity.getProfile('t1', 'devShared'))
    events.close()
  })

  it('Memory: the same, using the function that tells whether an event exists', () => {
    const alive = new Set(['r3'])
    const identity = new MemoryIdentityStore((_tenant, requestId) => alive.has(requestId))
    identity.createDevice('t1', 'devA', { canvas: 'a' }, 1)
    identity.saveResolution('t1', 'r1', 'devA', resolution('devA'))
    identity.createDevice('t1', 'devB', { canvas: 'b' }, 2)
    identity.saveResolution('t1', 'r3', 'devB', resolution('devB'))
    assert.equal(identity.removeOrphans(), 1)
    assert.equal(identity.getProfile('t1', 'devA'), undefined)
    assert.ok(identity.getProfile('t1', 'devB'))
    assert.equal(identity.population('t1').devicesWithValue('canvas', 'a'), 0)
  })
})
