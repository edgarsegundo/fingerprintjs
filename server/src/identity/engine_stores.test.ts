import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { memoryStorage, sqliteStorage, Storage } from '../storage'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage, newMysqlStorageWithDatabase } from '../testing/mysql'

import { IdentityEngine } from './engine'
import type { Features } from './features'
import { MemoryIdentityStore } from './memory_store'
import { defaultModel } from './model'
import { SyncIdentityEngine } from './sync_engine'

/** A small deterministic generator, so that a failing run can be repeated */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const model = { ...defaultModel(), matchProbability: 0.95 }

/** A device made of values that are rare enough to be recognized */
const device = (n: number, extra: Features = {}): Features => ({
  canvas: `canvas${n}`,
  webglRenderer: `gpu${n % 7}`,
  fonts: `fonts${n}`,
  screenResolution: `screen${n % 5}`,
  tlsCiphers: `ciphers${n}`,
  timezone: 'tz-common',
  platform: 'platform-common',
  userAgentVersion: `ua${n}-v1`,
  ...extra,
})

const storages: Array<[string, () => Storage | Promise<Storage>]> = [
  ['memory', () => memoryStorage()],
  ['SQLite', () => sqliteStorage(':memory:')],
  ...(mysqlAvailable ? [['MySQL', newMysqlStorage] as [string, () => Promise<Storage>]] : []),
]

for (const [name, open] of storages) {
  describe(`the engine over the ${name} store`, () => {
    after(dropMysqlStorages)

    it('merges two devices by a decision of a person, and the visits of both are one device from then on', async () => {
      const storage = await open()
      let counter = 0
      const engine = new IdentityEngine(storage.identity, model, { newId: () => `v${++counter}`, now: () => 1 })
      const a = await engine.resolve('t1', 'r1', device(1), 1)
      await engine.resolve('t1', 'r2', device(1), 2)
      const b = await engine.resolve('t1', 'r3', device(2), 3)
      assert.notEqual(a.visitorId, b.visitorId)

      assert.deepEqual(await engine.merge('t1', 'nope', a.visitorId), { ok: false, reason: 'unknown_device' })
      assert.deepEqual(await engine.merge('t1', a.visitorId, a.visitorId), { ok: false, reason: 'same_device' })
      assert.deepEqual(
        await engine.merge('t2', b.visitorId, a.visitorId),
        { ok: false, reason: 'unknown_device' },
        'tenant',
      )

      assert.deepEqual(await engine.merge('t1', b.visitorId, a.visitorId), {
        ok: true,
        visitorId: a.visitorId,
        visits: 3,
      })
      assert.equal((await engine.getResolution('t1', 'r3'))?.visitorId, a.visitorId, 'the visit moved with the device')
      assert.equal(await engine.resolveAlias('t1', b.visitorId), a.visitorId)
      assert.equal(await engine.getProfile('t1', b.visitorId), undefined, 'the old device is gone')
      assert.equal((await engine.getProfile('t1', a.visitorId))?.visits, 3)
      // The values of the device that was merged in now recognize the merged one
      const later = await engine.resolve('t1', 'r4', device(2), 4)
      assert.equal(later.visitorId, a.visitorId)
      // Merging again by the old id is merging the same device
      assert.deepEqual(await engine.merge('t1', b.visitorId, a.visitorId), { ok: false, reason: 'same_device' })
    })

    it('attaches the answer of a visit before a merge that follows it, leaving no visit on a gone device', async () => {
      const storage = await open()
      let counter = 0
      // A store that takes its time to write the answer, which is when an answer written late would be lost to a merge
      const slow = new Proxy(storage.identity, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property === 'saveResolution') {
            return async (...args: Parameters<typeof target.saveResolution>) => {
              await new Promise((resolve) => setTimeout(resolve, 30))
              return target.saveResolution(...args)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const engine = new IdentityEngine(slow, model, { newId: () => `v${++counter}`, now: () => 1 })
      for (let n = 10; n < 40; n++) {
        await engine.resolve('t1', `other${n}`, device(n), n)
      }
      const a = await engine.resolve('t1', 'ra', device(1), 100)
      const b = await engine.resolve('t1', 'rb', device(2), 101)
      // A visit of b arrives, and a person merges b into a right after it
      const visit = engine.resolve('t1', 'rc', device(2), 102)
      const merged = engine.merge('t1', b.visitorId, a.visitorId)
      await Promise.all([visit, merged])
      assert.equal((await engine.getResolution('t1', 'rc'))?.visitorId, a.visitorId)
      assert.equal((await engine.getResolution('t1', 'rb'))?.visitorId, a.visitorId)
      assert.equal(await engine.getProfile('t1', b.visitorId), undefined)
    })

    it('splits visits off a device into a new one, and keeps what the rest of the visits taught', async () => {
      const storage = await open()
      let counter = 0
      const engine = new IdentityEngine(storage.identity, model, { newId: () => `v${++counter}`, now: () => 1 })
      const one = device(1)
      const two = device(1, { userAgentVersion: 'ua1-v2' })
      // Enough other devices that a rare value is worth something
      for (let n = 10; n < 40; n++) {
        await engine.resolve('t1', `other${n}`, device(n), n)
      }
      const a = await engine.resolve('t1', 'r1', one, 1)
      await engine.resolve('t1', 'r2', one, 2)
      const attached = await engine.resolve('t1', 'r3', two, 3)
      assert.equal(attached.visitorId, a.visitorId)
      assert.equal((await engine.getProfile('t1', a.visitorId))?.visits, 3)

      assert.deepEqual(await engine.split('t1', a.visitorId, []), { ok: false, reason: 'nothing_to_move' })
      assert.deepEqual(await engine.split('t1', a.visitorId, [{ requestId: 'nope', features: two, at: 3 }]), {
        ok: false,
        reason: 'not_of_this_device',
      })
      assert.deepEqual(await engine.split('t1', 'ghost', [{ requestId: 'r3', features: two, at: 3 }]), {
        ok: false,
        reason: 'unknown_device',
      })
      const all = [1, 2, 3].map((n) => ({ requestId: `r${n}`, features: n === 3 ? two : one, at: n }))
      assert.deepEqual(await engine.split('t1', a.visitorId, all), { ok: false, reason: 'would_empty_the_device' })

      const result = await engine.split('t1', a.visitorId, [{ requestId: 'r3', features: two, at: 3 }])
      assert.equal(result.ok, true)
      const moved = result.ok ? result.visitorId : ''
      assert.notEqual(moved, a.visitorId)
      assert.equal((await engine.getResolution('t1', 'r3'))?.visitorId, moved)
      assert.equal((await engine.getResolution('t1', 'r1'))?.visitorId, a.visitorId)
      const kept = await engine.getProfile('t1', a.visitorId)
      assert.equal(kept?.visits, 2)
      assert.equal(
        kept?.features.get('userAgentVersion')?.has('ua1-v2'),
        false,
        'the split visit took its value with it',
      )
      assert.equal(kept?.features.get('userAgentVersion')?.get('ua1-v1')?.count, 2)
      const created = await engine.getProfile('t1', moved)
      assert.equal(created?.visits, 1)
      assert.equal(created?.features.get('userAgentVersion')?.has('ua1-v2'), true)
    })

    describe('with a code stored in the browser', () => {
      async function known() {
        const storage = await open()
        let counter = 0
        const engine = new IdentityEngine(storage.identity, model, { newId: () => `v${++counter}`, now: () => 1 })
        for (let n = 10; n < 50; n++) {
          await engine.resolve('t1', `other${n}`, device(n, { storedId: `code${n}` }), n)
        }
        const first = await engine.resolve('t1', 'r1', device(1, { storedId: 'codeA' }), 100)
        await engine.resolve('t1', 'r2', device(1, { storedId: 'codeA' }), 101)
        return { engine, id: first.visitorId }
      }

      it('recognizes the browser after many signals changed, which it does not without the code', async () => {
        const { engine, id } = await known()
        const changed = { canvas: 'canvas-new', fonts: 'fonts-new', tlsCiphers: 'ciphers-new' }
        const withCode = await engine.resolve('t1', 'r3', device(1, { ...changed, storedId: 'codeA' }), 102)
        assert.equal(withCode.matched, true)
        assert.equal(withCode.visitorId, id)
        assert.equal(withCode.explanation[0].feature, 'storedId', 'the code is the main reason')
        assert.equal(withCode.storedIdConflict, undefined)
        // The same changes on a fresh start (a visit that already learned them would find them again)
        const other = await known()
        const without = await other.engine.resolve('t1', 'r4', device(1, changed), 103)
        assert.equal(without.matched, false, 'the same changes without the code are not enough')
      })

      it('is not enough alone to match a device that otherwise looks nothing like it', async () => {
        const { engine, id } = await known()
        const stranger = await engine.resolve('t1', 'r5', device(99, { storedId: 'codeA' }), 102)
        assert.notEqual(stranger.visitorId, id, 'a copied code does not hand over the identity')
        assert.equal(stranger.storedIdConflict, true)
        assert.equal(stranger.matched, false)
      })

      it('marks a code that was copied to another machine, not one whose browser merely updated', async () => {
        const { engine } = await known()
        const updated = await engine.resolve(
          't1',
          'r6',
          device(1, { userAgentVersion: 'ua-new', canvas: 'canvas-new', storedId: 'codeA' }),
          102,
        )
        assert.equal(updated.storedIdConflict, undefined, 'features that change by themselves do not count')
        const moved = device(1, {
          storedId: 'codeA',
          webglRenderer: 'gpu-other',
          fonts: 'fonts-other',
          screenResolution: 'screen-other',
          platform: 'platform-other',
        })
        const copied = await engine.resolve('t1', 'r7', moved, 103)
        assert.equal(copied.storedIdConflict, true)
        // The tenant can ask for a stricter or a looser bar
        const strict = await engine.resolve('t1', 'r8', moved, 104, { storedIdConflictThreshold: 100 })
        assert.equal(strict.storedIdConflict, undefined)
      })

      it('does not conflict when the visit brings no code, or a code the device never had', async () => {
        const { engine } = await known()
        const changed = {
          webglRenderer: 'gpu-other',
          fonts: 'fonts-other',
          screenResolution: 'screen-other',
          platform: 'platform-other',
        }
        const none = await engine.resolve('t1', 'r9', device(1, changed), 102)
        assert.equal(none.storedIdConflict, undefined, 'the same disagreement, but no code')
        const fresh = await engine.resolve('t1', 'r10', device(1, { ...changed, storedId: 'codeNew' }), 103)
        assert.equal(fresh.storedIdConflict, undefined, 'a different code is not the code of a known device')
      })
    })

    it('decides exactly as the synchronous engine does over the same history', async () => {
      const storage = await open()
      let counterA = 0
      let counterB = 0
      const reference = new SyncIdentityEngine(new MemoryIdentityStore(), model, {
        newId: () => `v${++counterA}`,
        now: () => 1,
      })
      const engine = new IdentityEngine(storage.identity, model, { newId: () => `v${++counterB}`, now: () => 1 })
      const next = random(5)
      for (let step = 0; step < 90; step++) {
        const n = Math.floor(next() * 25)
        // Some visits change a value of the browser, some drop a feature, as real ones do
        const features = device(n, next() < 0.3 ? { userAgentVersion: `ua${n}-v${step}` } : {})
        if (next() < 0.1) {
          delete features.fonts
        }
        const expected = reference.resolve('t1', `r${step}`, features, step)
        const got = await engine.resolve('t1', `r${step}`, features, step)
        assert.deepEqual(got, expected, `step ${step}`)
      }
      assert.deepEqual(await engine.getResolution('t1', 'r3'), reference.getResolution('t1', 'r3'))
    })

    it('takes simultaneous visits of one new device one at a time: one device, not many', async () => {
      const storage = await open()
      let counter = 0
      const engine = new IdentityEngine(storage.identity, model, { newId: () => `v${++counter}` })
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => engine.resolve('t1', `r${index}`, device(1), 1000 + index)),
      )
      assert.equal(results.filter((result) => !result.matched).length, 1, 'only the first one made a device')
      assert.equal(new Set(results.map((result) => result.visitorId)).size, 1)
      assert.equal(await engine.deviceCount('t1'), 1)
    })

    it('does not make one tenant wait for another, and keeps their devices apart', async () => {
      const storage = await open()
      const engine = new IdentityEngine(storage.identity, model)
      const [a, b] = await Promise.all([
        engine.resolve('t1', 'r1', device(1), 1),
        engine.resolve('t2', 'r1', device(1), 1),
      ])
      assert.equal(a.matched, false)
      assert.equal(b.matched, false)
      assert.notEqual(a.visitorId, b.visitorId, 'the same device has another id in another tenant')
      assert.equal((await engine.resolve('t1', 'r2', device(1), 2)).visitorId, a.visitorId)
    })

    it('goes on after a visit that failed', async () => {
      const storage = await open()
      const engine = new IdentityEngine(storage.identity, model)
      const original = storage.identity.saveResolution.bind(storage.identity)
      let fail = true
      storage.identity.saveResolution = async (...args) => {
        if (fail) {
          fail = false
          throw new Error('disk full')
        }
        return original(...args)
      }
      await assert.rejects(engine.resolve('t1', 'r1', device(1), 1), /disk full/)
      const next = await engine.resolve('t1', 'r2', device(2), 2)
      assert.equal(next.matched, false, 'the next visit of the tenant is handled')
    })
  })
}

describe(
  'several instances of the server on one MySQL database',
  { skip: mysqlAvailable ? false : 'FP_TEST_MYSQL_URL is not set' },
  () => {
    after(dropMysqlStorages)

    it('take turns on a tenant, so that one device seen by both at once is one device', async () => {
      const { storage, another } = await newMysqlStorageWithDatabase()
      const twin = await another()
      let counter = 0
      const newId = () => `v${++counter}`
      const engines = [
        new IdentityEngine(storage.identity, model, { newId, now: () => 1 }),
        new IdentityEngine(twin.identity, model, { newId, now: () => 1 }),
      ]
      // Eight visits of the same new device arrive together, spread over the two instances
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, n) => engines[n % 2].resolve('t1', `r${n}`, device(1), n)),
      )
      assert.equal(new Set(results.map((r) => r.visitorId)).size, 1, 'one visitor id for all eight')
      assert.equal(await engines[0].deviceCount('t1'), 1)
      assert.equal(results.filter((r) => !r.matched).length, 1, 'only the first one created the device')
    })

    it('do not wait for each other when the tenants differ', async () => {
      const { storage, another } = await newMysqlStorageWithDatabase()
      const twin = await another()
      const slow = new IdentityEngine(storage.identity, model, { newId: () => 'a1' })
      const quick = new IdentityEngine(twin.identity, model, { newId: () => 'b1' })
      let release = (): void => undefined
      const held = storage.identity.withTenantLock?.(
        'tenant-a',
        () => new Promise<void>((resolve) => (release = resolve)),
      )
      // A different tenant gets its turn at once while tenant-a is held by the first instance
      const started = Date.now()
      await quick.resolve('tenant-b', 'r1', device(2), 1)
      assert.ok(Date.now() - started < 2000)
      release()
      await held
      await slow.resolve('tenant-a', 'r2', device(3), 2)
    })

    it('give the turn back when the work fails, so that the next visit is not locked out', async () => {
      const { storage } = await newMysqlStorageWithDatabase()
      await assert.rejects(
        storage.identity.withTenantLock?.('t1', async () => {
          throw new Error('boom')
        }) ?? Promise.reject(new Error('no lock')),
        /boom/,
      )
      let ran = false
      await storage.identity.withTenantLock?.('t1', async () => {
        ran = true
      })
      assert.equal(ran, true)
    })
  },
)
