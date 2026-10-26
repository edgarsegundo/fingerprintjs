import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Resolution } from '../identity/store'

import { DeviceReader, linkVisit, LinkerParams } from './linker'
import { Link, MemoryPersonStore } from './store'

const params: LinkerParams = { maxDevices: 3, networkWindowMinutes: 60, networkMaxDevicesPerIp: 2 }

const resolution = (visitorId: string, extra: Partial<Resolution> = {}): Resolution => ({
  visitorId,
  matched: true,
  ambiguous: false,
  learned: true,
  logOdds: 1,
  probability: null,
  provisionalProbability: 0.9,
  calibrated: false,
  thresholds: { match: 0.99, possibleLink: null },
  candidates: 1,
  devices: 1,
  explanation: [],
  resolvedAt: 1,
  ...extra,
})

const readerOf = (options: {
  byAccount?: Record<string, string[]>
  byIp?: Record<string, string[]>
}): DeviceReader => ({
  devicesWithLinkedId: async (_tenant, linkedId) => options.byAccount?.[linkedId] ?? [],
  devicesSeenFrom: async (_tenant, query) =>
    (options.byIp?.[query.ip] ?? []).map((deviceId) => ({ deviceId, lastSeen: query.until })),
})

const visit = { ip: '203.0.113.7', linkedId: 'acct', receivedAt: 1_000_000 }
const kinds = async (person: MemoryPersonStore) =>
  (await person.linksOf('t', ['me', 'a', 'b', 'c', 'd'], 100))
    .map((link: Link) => `${link.a}-${link.b}:${link.kind}`)
    .sort()

describe('linkVisit', () => {
  it('ties the device to the others of the same account, never to itself', async () => {
    const person = new MemoryPersonStore()
    const report = await linkVisit(
      { devices: readerOf({ byAccount: { acct: ['a', 'me', 'b'] } }), person },
      't',
      visit,
      resolution('me'),
      params,
    )
    assert.equal(report.linkedId, 2)
    assert.deepEqual(await kinds(person), ['a-me:linked_id', 'b-me:linked_id'])
  })

  it('ties nothing from an account that has too many devices to be one person', async () => {
    const person = new MemoryPersonStore()
    await linkVisit(
      { devices: readerOf({ byAccount: { acct: ['a', 'b', 'c', 'd', 'me'] } }), person },
      't',
      visit,
      resolution('me'),
      params,
    )
    assert.deepEqual(await kinds(person), [])
  })

  it('ties nothing for a visit that was not allowed to teach the engine', async () => {
    const person = new MemoryPersonStore()
    const report = await linkVisit(
      { devices: readerOf({ byAccount: { acct: ['a'] }, byIp: { '203.0.113.7': ['b'] } }), person },
      't',
      visit,
      resolution('me', {
        learned: false,
        sameMachine: { links: [{ visitorId: 'c', logOdds: 5, browsers: ['chrome'], agree: [], disagree: [] }] },
      }),
      params,
    )
    assert.deepEqual(report, { linkedId: 0, sameMachine: 0, network: 0, possibleLink: 0 })
    assert.deepEqual(await kinds(person), [])
  })

  it('notes the same machine and the closest device that was not joined, with their strength', async () => {
    const person = new MemoryPersonStore()
    await linkVisit(
      { devices: readerOf({}), person },
      't',
      { ...visit, linkedId: undefined },
      resolution('me', {
        possibleLink: { visitorId: 'b', logOdds: 2.5, probability: null, provisionalProbability: 0.9 },
        sameMachine: {
          links: [{ visitorId: 'a', logOdds: 6, browsers: ['chrome'], agree: ['platform'], disagree: [] }],
        },
      }),
      params,
    )
    const links = await person.linksOf('t', ['me'], 10)
    assert.deepEqual(links.map((link: Link) => [link.kind, link.strength]).sort(), [
      ['possible_link', 2.5],
      ['same_machine', 6],
    ])
  })

  it('ties by address only when the address is not crowded, and can be turned off', async () => {
    const quiet = new MemoryPersonStore()
    await linkVisit(
      { devices: readerOf({ byIp: { '203.0.113.7': ['a', 'me'] } }), person: quiet },
      't',
      { ...visit, linkedId: undefined },
      resolution('me'),
      params,
    )
    assert.deepEqual(await kinds(quiet), ['a-me:network'])

    const crowded = new MemoryPersonStore()
    await linkVisit(
      { devices: readerOf({ byIp: { '203.0.113.7': ['a', 'b', 'c', 'me'] } }), person: crowded },
      't',
      { ...visit, linkedId: undefined },
      resolution('me'),
      params,
    )
    assert.deepEqual(await kinds(crowded), [], 'three other devices on an address that allows two')

    const off = new MemoryPersonStore()
    await linkVisit(
      { devices: readerOf({ byIp: { '203.0.113.7': ['a'] } }), person: off },
      't',
      { ...visit, linkedId: undefined },
      resolution('me'),
      { ...params, networkWindowMinutes: 0 },
    )
    assert.deepEqual(await kinds(off), [])
  })
})
