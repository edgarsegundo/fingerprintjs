import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'
import { memoryStorage, sqliteStorage, Storage } from '../storage'
import type { StoredEvent } from '../store/types'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import { mergeProfiles, profileOf, withoutObservations } from './edit'
import { MemoryIdentityStore } from './memory_store'
import { smoothedAgreement } from './model'
import { SqliteIdentityStore } from './sqlite_store'
import type { DeviceProfile, IdentityStore, Resolution } from './store'

const resolution = (visitorId: string): Resolution => ({
  visitorId,
  matched: true,
  ambiguous: false,
  learned: true,
  logOdds: 4.2,
  probability: null,
  provisionalProbability: 0.97,
  calibrated: false,
  thresholds: { match: 0.95, possibleLink: null },
  candidates: 2,
  devices: 10,
  explanation: [{ feature: 'canvas', outcome: 'agree', weight: 3.1, probabilityWithoutIt: 0.5 }],
  resolvedAt: 99,
})

const implementations: Array<[string, () => IdentityStore | Promise<IdentityStore>]> = [
  ['MemoryIdentityStore', () => new MemoryIdentityStore()],
  ['SqliteIdentityStore', () => new SqliteIdentityStore(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlIdentityStore', async () => (await newMysqlStorage()).identity] as [string, () => Promise<IdentityStore>]]
    : []),
]

for (const [name, create] of implementations) {
  describe(name, () => {
    after(dropMysqlStorages)

    it('keeps what it is told about a device, with counts, and adds values over time', async () => {
      const store = await create()
      await store.createDevice('t1', 'd1', { canvas: 'a', fonts: 'f' }, 100)
      await store.addObservation('t1', 'd1', { canvas: 'a', fonts: 'f2' }, 200)
      const profile = await store.getProfile('t1', 'd1')
      assert.equal(profile?.visits, 2)
      assert.equal(profile?.firstSeen, 100)
      assert.equal(profile?.lastSeen, 200)
      assert.deepEqual(profile?.features.get('canvas'), new Map([['a', { count: 2, lastSeen: 200 }]]))
      assert.deepEqual(
        [...(profile?.features.get('fonts') ?? new Map()).keys()].sort(),
        ['f', 'f2'],
        'a device keeps every value it has had',
      )
      assert.equal(await store.getProfile('t1', 'nope'), undefined)
    })

    it('refuses a duplicate device and an observation of an unknown one', async () => {
      const store = await create()
      await store.createDevice('t1', 'd1', { canvas: 'a' }, 1)
      await assert.rejects(async () => store.createDevice('t1', 'd1', { canvas: 'a' }, 2))
      await assert.rejects(async () => store.addObservation('t1', 'ghost', { canvas: 'a' }, 2))
    })

    it('counts devices and devices per value', async () => {
      const store = await create()
      await store.createDevice('t1', 'd1', { canvas: 'a', tz: 'x' }, 1)
      await store.createDevice('t1', 'd2', { canvas: 'b', tz: 'x' }, 2)
      await store.addObservation('t1', 'd1', { canvas: 'a', tz: 'x' }, 3)
      const population = await store.population('t1', { tz: 'x', canvas: 'a' })
      assert.equal(population.devices, 2)
      assert.equal(population.devicesWithValue('tz', 'x'), 2, 'a device counts once however often it came back')
      assert.equal(population.devicesWithValue('canvas', 'a'), 1)
      assert.equal(population.devicesWithValue('canvas', 'zzz'), 0)
      assert.equal((await store.population('other', {})).devices, 0)
    })

    it('estimates how often two devices agree, smoothed', async () => {
      const store = await create()
      assert.equal(
        (await store.population('t1', { tz: 'x' })).agreementProbability('tz'),
        0.5,
        'nothing known: one half',
      )
      for (let n = 1; n <= 4; n++) {
        await store.createDevice('t1', `d${n}`, { tz: n <= 3 ? 'common' : 'rare', canvas: `c${n}` }, n)
      }
      const population = await store.population('t1', { tz: 'x', canvas: 'x' })
      assert.equal(population.agreementProbability('tz'), smoothedAgreement([3, 1]))
      assert.equal(population.agreementProbability('canvas'), smoothedAgreement([1, 1, 1, 1]))
      assert.ok(population.agreementProbability('tz') > population.agreementProbability('canvas'))
      // And it follows the data when more arrives
      await store.createDevice('t1', 'd5', { tz: 'common' }, 5)
      assert.equal((await store.population('t1', { tz: 'x' })).agreementProbability('tz'), smoothedAgreement([4, 1]))
    })

    it('finds the devices that share a value, the rarest match first, and only for the tenant', async () => {
      const store = await create()
      await store.createDevice('t1', 'd1', { canvas: 'rare', tz: 'common' }, 1)
      await store.createDevice('t1', 'd2', { canvas: 'other', tz: 'common' }, 2)
      await store.createDevice('t1', 'd3', { canvas: 'other2', tz: 'common' }, 3)
      await store.createDevice('t2', 'x1', { canvas: 'rare' }, 4)
      assert.deepEqual(await store.findCandidates('t1', { canvas: 'rare', tz: 'common' }, 10), ['d1', 'd2', 'd3'])
      assert.deepEqual(await store.findCandidates('t1', { canvas: 'rare' }, 10), ['d1'])
      assert.deepEqual(await store.findCandidates('t1', { canvas: 'unknown' }, 10), [])
      assert.deepEqual((await store.findCandidates('t1', { tz: 'common' }, 2)).length, 2, 'the limit is respected')
      assert.deepEqual(await store.findCandidates('t2', { canvas: 'rare' }, 10), ['x1'])
    })

    it('puts the device that shares a rare value before the one that shares a common value', async () => {
      const store = await create()
      // d1 shares only the common value; d2 shares only the rare one. Their ids are in the opposite order on purpose.
      await store.createDevice('t1', 'd1', { tz: 'common', canvas: 'x1' }, 1)
      await store.createDevice('t1', 'd2', { tz: 'other', canvas: 'rare' }, 2)
      for (let n = 3; n <= 8; n++) {
        await store.createDevice('t1', `d${n}`, { tz: 'common', canvas: `x${n}` }, n)
      }
      assert.deepEqual((await store.findCandidates('t1', { tz: 'common', canvas: 'rare' }, 3))[0], 'd2')
    })

    it('ignores a value that too many devices share when looking for candidates', async () => {
      const store = await create()
      for (let n = 1; n <= 80; n++) {
        await store.createDevice('t1', `d${n}`, { tz: 'everyone', canvas: `c${n}` }, n)
      }
      assert.deepEqual(await store.findCandidates('t1', { tz: 'everyone' }, 10), [])
      assert.deepEqual(await store.findCandidates('t1', { tz: 'everyone', canvas: 'c7' }, 10), ['d7'])
    })

    it('uses the rule of the call to decide which values are too common', async () => {
      const store = await create()
      for (let n = 1; n <= 80; n++) {
        await store.createDevice('t1', `d${n}`, { tz: 'everyone', canvas: `c${n}` }, n)
      }
      // A rule that lets every device through: the shared value is read, and the limit cuts the answer
      const all = await store.findCandidates('t1', { tz: 'everyone' }, 100, {
        maxShare: 1,
        minDevices: 100,
        rowsPerValue: 1000,
      })
      assert.equal(all.length, 80)
      // A rule that is stricter than the default skips a value that the default would read
      for (let n = 81; n <= 100; n++) {
        await store.createDevice('t1', `d${n}`, { tz: 'some', canvas: `c${n}` }, n)
      }
      assert.equal((await store.findCandidates('t1', { tz: 'some' }, 100)).length, 20, 'the default reads 20 devices')
      assert.deepEqual(
        await store.findCandidates('t1', { tz: 'some' }, 100, { maxShare: 0.05, minDevices: 5, rowsPerValue: 1000 }),
        [],
      )
    })

    it('reads only the most recently seen devices of a value, up to the rule, and always the rarest', async () => {
      const store = await create()
      // 30 devices share a value; the higher the number, the more recently it was seen. Rare values are unique.
      for (let n = 1; n <= 30; n++) {
        await store.createDevice('t1', `d${String(n).padStart(2, '0')}`, { tz: 'shared', canvas: `c${n}` }, n)
      }
      const rule = { maxShare: 1, minDevices: 1000, rowsPerValue: 5 }
      const recent = await store.findCandidates('t1', { tz: 'shared' }, 100, rule)
      assert.deepEqual([...recent].sort(), ['d26', 'd27', 'd28', 'd29', 'd30'], 'the five seen last')
      // An old device is still found by its own rare value, whatever the cap
      const found = await store.findCandidates('t1', { tz: 'shared', canvas: 'c1' }, 100, rule)
      assert.equal(found[0], 'd01', 'the rare value puts the old device first')
      assert.equal(found.length, 6)
    })

    it('keeps the counters of the population right after any mix of merges, splits and ordinary visits', async () => {
      const store = await create()
      const reference = new MemoryIdentityStore()
      const apply = async (action: (target: IdentityStore) => unknown) => {
        await action(store)
        await action(reference)
      }
      let seed = 7
      const next = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296
        return seed / 4294967296
      }
      const names = ['canvas', 'fonts', 'tz']
      const ids: string[] = []
      for (let step = 0; step < 60; step++) {
        const features = Object.fromEntries(names.map((feature) => [feature, `${feature}${Math.floor(next() * 6)}`]))
        const roll = next()
        if (ids.length < 3 || roll < 0.35) {
          const id = `d${ids.length + step * 100}`
          ids.push(id)
          await apply((target) => target.createDevice('t1', id, features, step))
        } else if (roll < 0.65) {
          const chosen = ids[Math.floor(next() * ids.length)]
          await apply((target) => target.addObservation('t1', chosen, features, step))
        } else if (roll < 0.85 && ids.length > 2) {
          // Merge one device into another, the way the engine does it
          const into = ids[Math.floor(next() * ids.length)]
          const from = ids.filter((id) => id !== into)[Math.floor(next() * (ids.length - 1))]
          const [a1, b1] = (await store.getProfiles('t1', [into, from])) as [DeviceProfile, DeviceProfile]
          const merged = mergeProfiles(a1, b1)
          await apply((target) => target.applyEdit('t1', { remove: [from], write: [merged] }))
          ids.splice(ids.indexOf(from), 1)
        } else {
          // Rewrite a device with one value less, as a split does to the device that keeps its visits
          const id = ids[Math.floor(next() * ids.length)]
          const profile = (await store.getProfile('t1', id)) as DeviceProfile
          const trimmed = withoutObservations(profile, [
            { features: { canvas: [...(profile.features.get('canvas')?.keys() ?? [''])][0] }, at: step },
          ])
          await apply((target) => target.applyEdit('t1', { write: [trimmed] }))
        }
        // A store on the network reads the counters of the values of the visit it is asked about
        const right = reference.population('t1')
        for (const feature of names) {
          for (let n = 0; n < 6; n++) {
            const value = `${feature}${n}`
            const left = await store.population('t1', { [feature]: value })
            assert.equal(left.devices, right.devices, `devices at step ${step}`)
            assert.equal(left.agreementProbability(feature), right.agreementProbability(feature), `${feature} ${step}`)
            assert.equal(
              left.devicesWithValue(feature, value),
              right.devicesWithValue(feature, value),
              `${value} ${step}`,
            )
          }
        }
      }
    })

    it('moves visits with a merge and remembers the old id as a name for the new one', async () => {
      const store = await create()
      await store.createDevice('t1', 'a', { canvas: 'x' }, 1)
      await store.createDevice('t1', 'b', { canvas: 'y' }, 2)
      await store.createDevice('t1', 'c', { canvas: 'z' }, 3)
      await store.saveResolution('t1', 'r1', 'a', resolution('a'))
      await store.saveResolution('t1', 'r2', 'b', resolution('b'))
      const [a, b] = (await store.getProfiles('t1', ['a', 'b'])) as [DeviceProfile, DeviceProfile]
      await store.applyEdit('t1', {
        remove: ['a'],
        write: [mergeProfiles(b, a)],
        moveVisits: { to: 'b', from: 'a' },
        alias: { from: 'a', to: 'b', at: 10 },
      })
      assert.equal(await store.getProfile('t1', 'a'), undefined)
      assert.equal((await store.getResolution('t1', 'r1'))?.visitorId, 'b', 'the visit now belongs to the new device')
      assert.equal(await store.resolveAlias('t1', 'a'), 'b')
      assert.equal(await store.resolveAlias('t1', 'b'), 'b')
      assert.equal(await store.resolveAlias('t2', 'a'), 'a', 'an alias is per tenant')
      // Merging b into c points the older alias at c too, in one step
      const [b2, c] = (await store.getProfiles('t1', ['b', 'c'])) as [DeviceProfile, DeviceProfile]
      await store.applyEdit('t1', {
        remove: ['b'],
        write: [mergeProfiles(c, b2)],
        moveVisits: { to: 'c', from: 'b' },
        alias: { from: 'b', to: 'c', at: 11 },
      })
      assert.equal(await store.resolveAlias('t1', 'a'), 'c')
      assert.equal((await store.getResolution('t1', 'r2'))?.visitorId, 'c')
    })

    it('moves only the listed visits when a device is split, and keeps the other visits where they were', async () => {
      const store = await create()
      await store.createDevice('t1', 'a', { canvas: 'x' }, 1)
      await store.saveResolution('t1', 'r1', 'a', resolution('a'))
      await store.saveResolution('t1', 'r2', 'a', resolution('a'))
      await store.applyEdit('t1', {
        write: [profileOf('n', [{ features: { canvas: 'q' }, at: 5 }])],
        moveVisits: { to: 'n', requestIds: ['r2'] },
      })
      assert.equal((await store.getResolution('t1', 'r1'))?.visitorId, 'a')
      assert.equal((await store.getResolution('t1', 'r2'))?.visitorId, 'n')
      assert.equal((await store.getProfile('t1', 'n'))?.visits, 1)
    })

    it('stores and returns a resolution exactly, for its tenant only', async () => {
      const store = await create()
      await store.createDevice('t1', 'd1', { canvas: 'a' }, 1)
      await store.saveResolution('t1', 'req1', 'd1', resolution('d1'))
      assert.deepEqual(await store.getResolution('t1', 'req1'), resolution('d1'))
      assert.equal(await store.getResolution('t2', 'req1'), undefined)
      assert.equal(await store.getResolution('t1', 'nope'), undefined)
    })
  })
}

describe('forgetting devices with their events', () => {
  const storages: Array<[string, () => Storage | Promise<Storage>]> = [
    ['memory', () => memoryStorage()],
    ['SQLite', () => sqliteStorage(':memory:')],
    ...(mysqlAvailable ? [['MySQL', newMysqlStorage] as [string, () => Promise<Storage>]] : []),
  ]
  after(dropMysqlStorages)

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

  for (const [name, open] of storages) {
    it(`${name}: a device disappears when none of its events is left, and stays when one is`, async () => {
      const { events, identity } = await open()
      await events.insertEvent(eventFor('r1', 'person_1'))
      await events.insertEvent(eventFor('r2', 'person_1'))
      await events.insertEvent(eventFor('r3', 'person_2'))
      await identity.createDevice('t1', 'devA', { canvas: 'a' }, 1)
      await identity.saveResolution('t1', 'r1', 'devA', resolution('devA'))
      await identity.saveResolution('t1', 'r2', 'devA', resolution('devA'))
      await identity.createDevice('t1', 'devB', { canvas: 'b' }, 2)
      await identity.saveResolution('t1', 'r3', 'devB', resolution('devB'))

      assert.equal(await identity.removeOrphans(), 0, 'nothing is orphaned while every event exists')
      await events.deleteByLinkedId('t1', 'person_1')
      assert.equal(await identity.removeOrphans(), 1)
      assert.equal(await identity.getProfile('t1', 'devA'), undefined)
      assert.equal(await identity.getResolution('t1', 'r1'), undefined)
      assert.ok(await identity.getProfile('t1', 'devB'), 'the other person is untouched')
      const population = await identity.population('t1', { canvas: 'a' })
      assert.equal(population.devices, 1)
      assert.equal(population.devicesWithValue('canvas', 'a'), 0, 'the values go with the device')
    })

    it(`${name}: a device that other events still point to is kept`, async () => {
      const { events, identity } = await open()
      await events.insertEvent(eventFor('r1', 'person_1'))
      await events.insertEvent(eventFor('r2', 'person_2'))
      await identity.createDevice('t1', 'devShared', { canvas: 'a' }, 1)
      await identity.saveResolution('t1', 'r1', 'devShared', resolution('devShared'))
      await identity.saveResolution('t1', 'r2', 'devShared', resolution('devShared'))
      await events.deleteByLinkedId('t1', 'person_1')
      assert.equal(await identity.removeOrphans(), 0)
      assert.ok(await identity.getProfile('t1', 'devShared'))
    })
  }
})
