import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'
import { memoryStorage, sqliteStorage, Storage } from '../storage'
import type { StoredEvent } from '../store/types'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import type { Resolution } from './store'

const network = (ip: string): NetworkSignals => ({
  ip,
  ipVersion: 4,
  ipPrefix: `${ip}/24`,
  ipSource: 'socket',
  ipIntel: { tags: [] },
  viaProxy: false,
  httpVersion: '2.0',
  headers: { order: [], casing: '', fp: 'x', values: {} },
})

const resolutionOf = (visitorId: string): Resolution => ({
  visitorId,
  matched: true,
  ambiguous: false,
  learned: true,
  logOdds: 1,
  probability: null,
  provisionalProbability: 0.9,
  calibrated: false,
  thresholds: { match: 0.95, possibleLink: null },
  candidates: 1,
  devices: 1,
  explanation: [],
  resolvedAt: 1,
})

interface Visit {
  tenant: string
  request: string
  device: string
  ip: string
  at: number
  linkedId?: string
}

const visits: Visit[] = [
  { tenant: 't1', request: 'r1', device: 'devA', ip: '203.0.113.1', at: 1000, linkedId: 'acct1' },
  { tenant: 't1', request: 'r2', device: 'devA', ip: '203.0.113.1', at: 2000, linkedId: 'acct2' },
  { tenant: 't1', request: 'r3', device: 'devA', ip: '203.0.113.9', at: 3000, linkedId: 'acct2' },
  { tenant: 't1', request: 'r4', device: 'devA', ip: '203.0.113.9', at: 9000 },
  { tenant: 't1', request: 'r5', device: 'devB', ip: '203.0.113.1', at: 2500, linkedId: 'acct3' },
  { tenant: 't2', request: 'r6', device: 'devA', ip: '203.0.113.1', at: 2000, linkedId: 'other' },
]

async function fill(storage: Storage): Promise<void> {
  for (const visit of visits) {
    await storage.events.insertEvent({
      requestId: visit.request,
      tenantId: visit.tenant,
      receivedAt: visit.at,
      network: network(visit.ip),
      payload: {
        schema: 1,
        libVersion: '5.3.0',
        collectedAt: 1,
        durationMs: 1,
        components: {},
        extended: {},
        ...(visit.linkedId ? { linkedId: visit.linkedId } : {}),
      },
      derived: { clockSkewMs: 0 },
    } satisfies StoredEvent)
    await storage.identity.saveResolution(visit.tenant, visit.request, visit.device, resolutionOf(visit.device))
  }
}

const implementations: Array<[string, () => Storage | Promise<Storage>]> = [
  ['SQLite', () => sqliteStorage(':memory:')],
  ['Memory', () => memoryStorage()],
  ...(mysqlAvailable ? [['MySQL', newMysqlStorage] as [string, () => Promise<Storage>]] : []),
]

for (const [name, create] of implementations) {
  describe(`activity (${name})`, () => {
    after(dropMysqlStorages)

    const setup = async () => {
      const made = await create()
      await fill(made)
      return made.identity
    }

    it('counts what one device did in a window, ends included', async () => {
      const identity = await setup()
      assert.deepEqual(await identity.activity('t1', { deviceId: 'devA', since: 0, until: 100_000 }), {
        visits: 4,
        devices: 1,
        linkedIds: 2,
        ips: 2,
      })
      assert.deepEqual(await identity.activity('t1', { deviceId: 'devA', since: 2000, until: 3000 }), {
        visits: 2,
        devices: 1,
        linkedIds: 1,
        ips: 2,
      })
      assert.equal((await identity.activity('t1', { deviceId: 'devA', since: 1001, until: 1999 })).visits, 0)
    })

    it('counts the devices seen from one address', async () => {
      const identity = await setup()
      assert.deepEqual(await identity.activity('t1', { ip: '203.0.113.1', since: 0, until: 100_000 }), {
        visits: 3,
        devices: 2,
        linkedIds: 3,
        ips: 1,
      })
    })

    it('never mixes tenants, even with the same device id and address', async () => {
      const identity = await setup()
      assert.equal((await identity.activity('t2', { deviceId: 'devA', since: 0, until: 100_000 })).visits, 1)
      assert.equal((await identity.activity('t2', { ip: '203.0.113.1', since: 0, until: 100_000 })).devices, 1)
      assert.equal((await identity.activity('t3', { ip: '203.0.113.1', since: 0, until: 100_000 })).visits, 0)
    })

    it('refuses a question about nothing', async () => {
      const identity = await setup()
      await assert.rejects(async () => identity.activity('t1', { since: 0, until: 1 }), /device or an address/)
    })
  })
}
