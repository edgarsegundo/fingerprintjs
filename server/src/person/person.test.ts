import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { memoryStorage, sqliteStorage, Storage } from '../storage'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import { clusterOf, PersonParams } from './cluster'
import { Link, LinkKind, LinkStatus, PersonStore } from './store'

const day = 86_400_000

const implementations: Array<[string, () => Storage | Promise<Storage>]> = [
  ['SQLite', () => sqliteStorage(':memory:')],
  ['Memory', () => memoryStorage()],
  ...(mysqlAvailable ? [['MySQL', newMysqlStorage] as [string, () => Promise<Storage>]] : []),
]

for (const [name, create] of implementations) {
  describe(`ties between devices (${name})`, () => {
    after(dropMysqlStorages)

    const setup = async () => {
      const storage = await create()
      return { storage, person: storage.person }
    }
    const tie = (a: string, b: string, kind: LinkKind, at: number, strength = 1) => ({ a, b, kind, strength, at })
    const all = (person: PersonStore, tenant = 't') => person.linksOf(tenant, ['a', 'b', 'c', 'd'], 100)

    it('keeps one tie per pair and kind, in a canonical order, and counts the days', async () => {
      const { storage, person } = await setup()
      assert.equal(await person.record('t', tie('b', 'a', 'network', 1000)), true)
      await person.record('t', tie('a', 'b', 'network', 2000, 3))
      await person.record('t', tie('a', 'b', 'network', 2500))
      await person.record('t', tie('a', 'b', 'network', 2000 + 2 * day))
      const [link] = await all(person)
      assert.deepEqual(
        [link.a, link.b, link.kind, link.strength, link.firstSeen, link.lastSeen, link.days, link.status],
        ['a', 'b', 'network', 3, 1000, 2000 + 2 * day, 2, 'auto'],
      )
      await person.record('t', tie('a', 'b', 'linked_id', 1))
      assert.equal((await all(person)).length, 2, 'another kind is another tie')
      await storage.close()
    })

    it('ties nothing to itself and nothing across tenants', async () => {
      const { storage, person } = await setup()
      assert.equal(await person.record('t', tie('a', 'a', 'network', 1)), false)
      await person.record('t', tie('a', 'b', 'linked_id', 1))
      assert.deepEqual(await all(person, 'other'), [])
      assert.equal(await person.deleteDevices('other', ['a']), 0)
      assert.equal((await all(person)).length, 1)
      await storage.close()
    })

    it('keeps a rejection final: nothing new is written for the pair, and every tie of it is marked', async () => {
      const { storage, person } = await setup()
      await person.record('t', tie('a', 'b', 'linked_id', 1))
      await person.record('t', tie('a', 'b', 'same_machine', 1, 5))
      await person.decide('t', 'b', 'a', 'rejected', 10)
      const links = await all(person)
      assert.ok(
        links.every((link: Link) => link.status === 'rejected'),
        'all of them, the manual one too',
      )
      assert.equal(await person.record('t', tie('a', 'b', 'network', 20)), false, 'nothing recreates it')
      assert.equal((await all(person)).length, links.length)
      await person.record('t', tie('a', 'c', 'linked_id', 20))
      assert.equal((await all(person)).filter((link: Link) => link.b === 'c').length, 1, 'other pairs are free')
      await storage.close()
    })

    it('can confirm a pair the engine never tied, and take a decision back', async () => {
      const { storage, person } = await setup()
      await person.decide('t', 'a', 'b', 'confirmed', 10)
      const [manual] = await all(person)
      assert.deepEqual([manual.kind, manual.status], ['manual', 'confirmed'])
      await person.record('t', tie('a', 'b', 'network', 20))
      await person.decide('t', 'a', 'b', 'auto', 30)
      const after = await all(person)
      assert.deepEqual(
        after.map((link: Link) => [link.kind, link.status]),
        [['network', 'auto']],
        'the manual tie is gone',
      )
      await person.decide('t', 'a', 'b', 'rejected', 40)
      await person.decide('t', 'a', 'b', 'auto', 50)
      assert.equal(await person.record('t', tie('a', 'b', 'linked_id', 60)), true, 'taken back: the pair is free again')
      await storage.close()
    })

    it('moves the ties of a merged device into the one that stays, and drops the tie between the two', async () => {
      const { storage, person } = await setup()
      await person.record('t', tie('a', 'b', 'linked_id', 1))
      await person.record('t', tie('b', 'c', 'linked_id', 5, 2))
      await person.record('t', tie('a', 'c', 'linked_id', 3))
      await person.record('t', tie('b', 'd', 'network', 4))
      assert.equal(await person.repoint('t', 'b', 'a'), 2, 'two moved; the tie between the two is dropped, not moved')
      const links = await all(person)
      assert.deepEqual(links.map((link: Link) => [link.a, link.b, link.kind]).sort(), [
        ['a', 'c', 'linked_id'],
        ['a', 'd', 'network'],
      ])
      const ac = links.find((link: Link) => link.b === 'c')
      assert.deepEqual([ac?.strength, ac?.lastSeen], [2, 5], 'joined with the tie that was already there')
      await storage.close()
    })

    it('forgets by device, by retention and by tenant', async () => {
      const { storage, person } = await setup()
      await person.record('t', tie('a', 'b', 'linked_id', 100))
      await person.record('t', tie('c', 'd', 'linked_id', 900))
      await person.record('other', tie('a', 'b', 'linked_id', 100))
      assert.equal(await person.purgeTenant('t', 500), 1)
      assert.equal((await all(person)).length, 1)
      assert.equal(await person.deleteDevices('t', ['d']), 1)
      assert.equal((await all(person)).length, 0)
      assert.equal(await person.deleteTenant('other'), 1)
      await storage.close()
    })

    it('reads the strongest ties first and no more than asked', async () => {
      const { storage, person } = await setup()
      await person.record('t', tie('a', 'b', 'same_machine', 1, 9))
      await person.record('t', tie('a', 'c', 'same_machine', 1, 3))
      await person.record('t', tie('a', 'd', 'same_machine', 1, 6))
      const two = await person.linksOf('t', ['a'], 2)
      assert.deepEqual(
        two.map((link: Link) => link.b),
        ['b', 'd'],
      )
      assert.deepEqual(await person.linksOf('t', [], 5), [])
      await storage.close()
    })
  })
}

describe('the person that a device belongs to', () => {
  const link = (a: string, b: string, kind: LinkKind, status: LinkStatus = 'auto'): Link => ({
    a: a < b ? a : b,
    b: a < b ? b : a,
    kind,
    strength: 1,
    firstSeen: 1,
    lastSeen: 1,
    days: 1,
    status,
  })
  const loader = (links: Link[]) => async (ids: string[]) => links.filter((l) => ids.includes(l.a) || ids.includes(l.b))
  const params: PersonParams = { groupingKinds: ['linked_id', 'same_machine', 'manual'], maxDevices: 20 }

  it('follows the grouping ties from device to device, in both directions', async () => {
    const person = await clusterOf(
      'b',
      loader([
        link('a', 'b', 'linked_id'),
        link('b', 'c', 'same_machine'),
        link('c', 'd', 'linked_id'),
        link('x', 'y', 'linked_id'),
      ]),
      params,
    )
    assert.deepEqual([...person.devices].sort(), ['a', 'b', 'c', 'd'])
    assert.equal(person.devices[0], 'b', 'the device asked about is first')
    assert.equal(person.edges.length, 3)
    assert.equal(person.truncated, false)
  })

  it('does not group by network or by a device that was only close: they are evidence', async () => {
    const person = await clusterOf('a', loader([link('a', 'b', 'network'), link('a', 'c', 'possible_link')]), params)
    assert.deepEqual(person.devices, ['a'])
    assert.deepEqual(person.evidence.map((l) => l.kind).sort(), ['network', 'possible_link'])
  })

  it('never groups across a rejected tie, and always groups across a confirmed one', async () => {
    const rejected = await clusterOf('a', loader([link('a', 'b', 'linked_id', 'rejected')]), params)
    assert.deepEqual(rejected.devices, ['a'])
    assert.deepEqual(rejected.evidence, [], 'a rejected tie is not even evidence')
    const confirmed = await clusterOf('a', loader([link('a', 'b', 'network', 'confirmed')]), params)
    assert.deepEqual([...confirmed.devices].sort(), ['a', 'b'])
  })

  it('stops at the largest person allowed and says so', async () => {
    const ties = Array.from({ length: 30 }, (_, i) => link('a', `d${String(i).padStart(2, '0')}`, 'linked_id'))
    const person = await clusterOf('a', loader(ties), { ...params, maxDevices: 5 })
    assert.equal(person.devices.length, 5)
    assert.equal(person.truncated, true)
  })

  it('copes with a cycle', async () => {
    const person = await clusterOf(
      'a',
      loader([link('a', 'b', 'linked_id'), link('b', 'c', 'linked_id'), link('a', 'c', 'linked_id')]),
      params,
    )
    assert.equal(person.devices.length, 3)
    assert.equal(person.edges.length, 3)
  })
})
