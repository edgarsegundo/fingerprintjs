import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'
import { memoryStorage, sqliteStorage, Storage } from '../storage'
import type { StoredEvent } from '../store/types'
import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import { IdentityEngine } from './engine'
import { featureNames, Features, scopeOf } from './features'
import { defaultModel } from './model'
import {
  defaultSameMachineParams as defaultParams0,
  findSameMachine,
  mergeTarget,
  SameMachineParams,
} from './same_machine'
import type { DeviceProfile } from './store'

const machine: Features = {
  screenResolution: 'scr1',
  colorDepth: 'depth30',
  colorGamut: 'srgb',
  hdr: 'nohdr',
  platform: 'mac',
  timezone: 'sp',
  gpuFamily: 'intel',
  speechVoices: 'voices1',
}

const chrome = (extra: Features = {}): Features => ({
  ...machine,
  browserFamily: 'chrome',
  webglRenderer: 'angle-intel',
  tlsCiphers: 'c-chrome',
  headerCore: 'h-chrome',
  ...extra,
})

const firefox = (extra: Features = {}): Features => ({
  ...machine,
  browserFamily: 'firefox',
  webglRenderer: 'moz-intel',
  tlsCiphers: 'c-firefox',
  headerCore: 'h-firefox',
  ...extra,
})

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

const minute = 60_000
let counter = 0

async function visit(
  storage: Storage,
  engine: IdentityEngine,
  options: {
    tenant?: string
    ip?: string
    at: number
    features: Features
    learn?: boolean
    sameMachine?: Partial<SameMachineParams>
  },
) {
  const tenant = options.tenant ?? 't'
  const ip = options.ip ?? '203.0.113.7'
  const requestId = `r${++counter}`
  await storage.events.insertEvent({
    requestId,
    tenantId: tenant,
    receivedAt: options.at,
    network: network(ip),
    payload: { schema: 1, libVersion: '5.3.0', collectedAt: 1, durationMs: 1, components: {}, extended: {} },
    derived: { clockSkewMs: 0 },
  } satisfies StoredEvent)
  return engine.resolve(tenant, requestId, { ...options.features, ip }, options.at, {
    learn: options.learn,
    sameMachine: { enabled: true, ...options.sameMachine },
  })
}

const implementations: Array<[string, () => Storage | Promise<Storage>]> = [
  ['SQLite', () => sqliteStorage(':memory:')],
  ['Memory', () => memoryStorage()],
  ...(mysqlAvailable ? [['MySQL', newMysqlStorage] as [string, () => Promise<Storage>]] : []),
]

for (const [name, create] of implementations) {
  describe(`same machine in another browser (${name})`, () => {
    after(dropMysqlStorages)

    const setup = async () => {
      const storage = await create()
      let n = 0
      const engine = new IdentityEngine(storage.identity, defaultModel(), { newId: () => `v${++n}` })
      return { storage, engine }
    }

    it('links Firefox to the Chrome of the same machine without joining their ids', async () => {
      const { storage, engine } = await setup()
      const first = await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const second = await visit(storage, engine, { at: 1_000_000 + 2 * minute, features: firefox() })
      assert.notEqual(second.visitorId, first.visitorId, 'one id per browser')
      assert.equal(second.matched, false)
      assert.equal(second.sameMachine?.links.length, 1)
      const link = second.sameMachine?.links[0]
      assert.equal(link?.visitorId, first.visitorId)
      assert.deepEqual(link?.browsers, ['chrome'])
      assert.ok(link?.agree.includes('screenResolution') && link.agree.includes('gpuFamily'))
      assert.equal(await storage.identity.resolveAlias('t', first.visitorId), first.visitorId, 'nothing was merged')
      assert.equal(first.sameMachine, undefined)
      await storage.close()
    })

    it('keeps the link when the resolution is read back', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const second = await visit(storage, engine, { at: 1_000_000 + minute, features: firefox() })
      const requestId = `r${counter}`
      const stored = await storage.identity.getResolution('t', requestId)
      assert.deepEqual(stored?.sameMachine, second.sameMachine)
      await storage.close()
    })

    it('does not link two devices of the same browser family', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const other = await visit(storage, engine, {
        at: 1_000_000 + minute,
        features: chrome({ webglRenderer: 'other-gpu', tlsCiphers: 'c-other', headerCore: 'h-other' }),
      })
      assert.equal(other.matched, false)
      assert.equal(other.sameMachine, undefined, 'the same family is a near miss for possibleLink, not another browser')
      await storage.close()
    })

    it('does not link a device whose browser is not known', async () => {
      const { storage, engine } = await setup()
      const { browserFamily: _unused, ...withoutFamily } = chrome()
      void _unused
      await visit(storage, engine, { at: 1_000_000, features: withoutFamily })
      const second = await visit(storage, engine, { at: 1_000_000 + minute, features: firefox() })
      assert.equal(second.sameMachine, undefined, 'another browser has to be shown, not assumed')
      await storage.close()
    })

    it('links within the window and not after it', async () => {
      const inside = await setup()
      await visit(inside.storage, inside.engine, { at: 1_000_000, features: chrome() })
      const near = await visit(inside.storage, inside.engine, { at: 1_000_000 + 29 * minute, features: firefox() })
      assert.equal(near.sameMachine?.links.length, 1, 'the control: 29 minutes is inside the window')
      await inside.storage.close()

      const outside = await setup()
      await visit(outside.storage, outside.engine, { at: 1_000_000, features: chrome() })
      const late = await visit(outside.storage, outside.engine, { at: 1_000_000 + 31 * minute, features: firefox() })
      assert.equal(late.sameMachine, undefined, 'after 30 minutes')
      await outside.storage.close()
    })

    it('does not link from a different address', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const elsewhere = await visit(storage, engine, {
        ip: '198.51.100.9',
        at: 1_000_000 + minute,
        features: firefox(),
      })
      assert.equal(elsewhere.sameMachine, undefined)
      await storage.close()
    })

    it('never links the devices of another tenant', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const other = await visit(storage, engine, { tenant: 'other', at: 1_000_000 + minute, features: firefox() })
      assert.equal(other.sameMachine, undefined)
      const own = await visit(storage, engine, {
        at: 1_000_000 + 2 * minute,
        features: firefox({ tlsCiphers: 'again' }),
      })
      assert.equal(own.sameMachine?.links.length, 1, 'the control: the same tenant does link')
      await storage.close()
    })

    it('does not link a machine that looks different', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const other = await visit(storage, engine, {
        at: 1_000_000 + minute,
        features: firefox({
          screenResolution: 'scr9',
          colorDepth: 'depth24',
          platform: 'win',
          gpuFamily: 'nvidia',
          speechVoices: 'voices9',
          timezone: 'tokyo',
        }),
      })
      assert.equal(other.sameMachine, undefined)
      await storage.close()
    })

    it('links nothing from a crowded address and says why', async () => {
      const { storage, engine } = await setup()
      for (let i = 0; i < 6; i++) {
        await visit(storage, engine, {
          at: 1_000_000 + i * 1000,
          features: chrome({
            webglRenderer: `gpu${i}`,
            tlsCiphers: `c${i}`,
            headerCore: `h${i}`,
            screenResolution: `s${i}`,
          }),
        })
      }
      const second = await visit(storage, engine, { at: 1_000_000 + minute, features: firefox() })
      assert.deepEqual(second.sameMachine, { links: [], skipped: 'shared_ip' })
      await storage.close()
    })

    it('needs enough machine features to AGREE, not only to be present', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const second = await visit(storage, engine, {
        at: 1_000_000 + minute,
        features: firefox({
          screenResolution: 'x',
          colorDepth: 'x',
          colorGamut: 'x',
          hdr: 'x',
          gpuFamily: 'x',
          speechVoices: 'x',
        }),
      })
      assert.equal(second.sameMachine, undefined, 'only the platform and the time zone agree: two are fewer than three')
      await storage.close()
    })

    it('needs the features of the machine, and enough of them', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const second = await visit(storage, engine, {
        at: 1_000_000 + minute,
        sameMachine: { minLogOdds: 0 },
        features: {
          browserFamily: 'firefox',
          webglRenderer: 'moz-intel',
          tlsCiphers: 'c-firefox',
          platform: 'mac',
          timezone: 'sp',
        },
      })
      assert.equal(
        second.sameMachine,
        undefined,
        'two machine features are fewer than the minimum of three, even when the evidence would pass',
      )
      await storage.close()
    })

    describe('taking the id of the other browser, when the tenant asked for it', () => {
      const merge = { merge: true, mergeMinLogOdds: 4 }

      it('gives the machine one id in both browsers, and learns both', async () => {
        const { storage, engine } = await setup()
        const first = await visit(storage, engine, { at: 1_000_000, features: chrome() })
        const second = await visit(storage, engine, { at: 1_000_000 + minute, features: firefox(), sameMachine: merge })
        assert.equal(second.visitorId, first.visitorId)
        assert.equal(second.matched, true)
        assert.equal(second.mergedAcrossBrowsers, true)
        assert.equal(second.possibleLink, undefined, 'the device it took is not "a possible link" any more')
        const profile = await storage.identity.getProfile('t', first.visitorId)
        assert.deepEqual([...(profile?.features.get('browserFamily')?.keys() ?? [])].sort(), ['chrome', 'firefox'])
        assert.equal((await storage.identity.getResolution('t', `r${counter}`))?.visitorId, first.visitorId)
        const third = await visit(storage, engine, {
          at: 1_000_000 + 2 * minute,
          features: firefox(),
          sameMachine: merge,
        })
        assert.equal(third.visitorId, first.visitorId, 'now the Firefox visit matches the device by itself')
        assert.equal(third.mergedAcrossBrowsers, undefined)
        await storage.close()
      })

      it('is off by default: the same visit keeps its own id', async () => {
        const { storage, engine } = await setup()
        const first = await visit(storage, engine, { at: 1_000_000, features: chrome() })
        const second = await visit(storage, engine, { at: 1_000_000 + minute, features: firefox() })
        assert.notEqual(second.visitorId, first.visitorId)
        assert.equal(second.mergedAcrossBrowsers, undefined)
        await storage.close()
      })

      it('needs the stronger bar, and a visit that may teach the engine', async () => {
        const high = await setup()
        await visit(high.storage, high.engine, { at: 1_000_000, features: chrome() })
        const kept = await visit(high.storage, high.engine, {
          at: 1_000_000 + minute,
          features: firefox(),
          sameMachine: { merge: true, mergeMinLogOdds: 50 },
        })
        assert.equal(kept.sameMachine?.links.length, 1, 'still linked')
        assert.equal(kept.mergedAcrossBrowsers, undefined, 'but not joined')
        await high.storage.close()

        const untrusted = await setup()
        await visit(untrusted.storage, untrusted.engine, { at: 1_000_000, features: chrome() })
        const refused = await visit(untrusted.storage, untrusted.engine, {
          at: 1_000_000 + minute,
          features: firefox(),
          learn: false,
          sameMachine: merge,
        })
        assert.equal(refused.mergedAcrossBrowsers, undefined)
        await untrusted.storage.close()
      })

      it('does not choose between two devices that fit about the same', async () => {
        const { storage, engine } = await setup()
        await visit(storage, engine, { at: 1_000_000, features: chrome() })
        await visit(storage, engine, {
          at: 1_000_000 + 10_000,
          features: chrome({ webglRenderer: 'other-gpu', tlsCiphers: 'c-other', headerCore: 'h-other' }),
        })
        const third = await visit(storage, engine, {
          at: 1_000_000 + minute,
          features: firefox(),
          sameMachine: { merge: true, mergeMinLogOdds: 0, minLogOdds: 0 },
        })
        assert.equal(third.sameMachine?.links.length, 2)
        assert.equal(third.mergedAcrossBrowsers, undefined, 'a tie is not a winner')
        await storage.close()
      })
    })

    it('does nothing when it is off', async () => {
      const { storage, engine } = await setup()
      await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const off = await visit(storage, engine, {
        at: 1_000_000 + minute,
        features: firefox(),
        sameMachine: { enabled: false },
      })
      assert.equal(off.sameMachine, undefined)
      await storage.close()
    })

    it('does not let a visit that may not teach the engine link machines', async () => {
      const trusted = await setup()
      await visit(trusted.storage, trusted.engine, { at: 1_000_000, features: chrome() })
      const linked = await visit(trusted.storage, trusted.engine, { at: 1_000_000 + minute, features: firefox() })
      assert.equal(linked.sameMachine?.links.length, 1, 'the control: the same visit does link when it may teach')
      await trusted.storage.close()

      const untrusted = await setup()
      await visit(untrusted.storage, untrusted.engine, { at: 1_000_000, features: chrome() })
      const refused = await visit(untrusted.storage, untrusted.engine, {
        at: 1_000_000 + minute,
        features: firefox(),
        learn: false,
      })
      assert.equal(
        refused.sameMachine,
        undefined,
        'a link feeds the person layer, so it needs a visit that can be trusted',
      )
      await untrusted.storage.close()
    })

    it('does not link visits that match their own device again', async () => {
      const { storage, engine } = await setup()
      const first = await visit(storage, engine, { at: 1_000_000, features: chrome() })
      const again = await visit(storage, engine, { at: 1_000_000 + minute, features: chrome() })
      assert.equal(again.visitorId, first.visitorId)
      assert.equal(again.sameMachine, undefined, 'a device is not the same machine as itself')
      await storage.close()
    })
  })
}

describe('a store that cannot answer the same-machine question', () => {
  it('still gives the visit its identity, and learns it, without the link', async () => {
    const storage = memoryStorage()
    const broken = Object.assign(storage.identity, {
      devicesSeenFrom: () => Promise.reject(new Error('the database went away')),
    })
    let ids = 0
    const engine = new IdentityEngine(broken, defaultModel(), { newId: () => `v${++ids}` })
    await visit(storage, engine, { at: 1_000_000, features: chrome() })
    const second = await visit(storage, engine, { at: 1_000_000 + minute, features: firefox() })
    assert.equal(second.sameMachine, undefined)
    assert.equal(second.learned, true)
    assert.ok(await storage.identity.getProfile('t', second.visitorId), 'the device was still created')
    assert.equal((await storage.identity.getResolution('t', `r${counter}`))?.visitorId, second.visitorId)
    await storage.close()
  })
})

describe('mergeTarget', () => {
  const link = (visitorId: string, logOdds: number) => ({
    visitorId,
    logOdds,
    browsers: ['chrome'],
    agree: [],
    disagree: [],
  })
  const on = { ...defaultParams0, merge: true, mergeMinLogOdds: 6 }

  it('takes the best link when it reaches the bar and wins by the margin', () => {
    assert.equal(mergeTarget({ links: [link('a', 8)] }, on, 2), 'a')
    assert.equal(mergeTarget({ links: [link('a', 8), link('b', 5)] }, on, 2), 'a')
  })

  it('takes nothing when it is off, below the bar, a tie, or a crowded address', () => {
    assert.equal(mergeTarget({ links: [link('a', 8)] }, { ...on, merge: false }, 2), undefined)
    assert.equal(mergeTarget({ links: [link('a', 5.9)] }, on, 2), undefined)
    assert.equal(mergeTarget({ links: [link('a', 8), link('b', 7)] }, on, 2), undefined)
    assert.equal(mergeTarget({ links: [], skipped: 'shared_ip' }, on, 2), undefined)
    assert.equal(mergeTarget(undefined, on, 2), undefined)
  })
})

describe('findSameMachine', () => {
  const profile = (deviceId: string, features: Record<string, string>): DeviceProfile => ({
    deviceId,
    visits: 1,
    firstSeen: 1,
    lastSeen: 1,
    features: new Map(
      Object.entries(features).map(([name, value]) => [name, new Map([[value, { count: 1, lastSeen: 1 }]])]),
    ),
  })
  const population = {
    devices: 2,
    devicesWithValue: () => 1,
    agreementProbability: () => 0.5,
  }
  const params: SameMachineParams = {
    enabled: true,
    windowMinutes: 30,
    maxDevicesPerIp: 5,
    minLogOdds: 4,
    minFeatures: 3,
    maxLinks: 3,
    merge: false,
    mergeMinLogOdds: 6,
  }
  const base = () => ({
    features: firefox(),
    visitorId: 'new',
    seen: [{ deviceId: 'old' }],
    profiles: [profile('old', chrome())],
    population,
    model: defaultModel(),
    params,
  })

  it('links the same machine seen in another browser', () => {
    assert.equal(findSameMachine(base())?.links[0].visitorId, 'old')
  })

  it('weighs only the features of the machine: the browser features that disagree do not count against', () => {
    const result = findSameMachine(base())
    assert.ok(result?.links[0].disagree.length === 0)
  })

  it('never links without the family of this visit, nor with a bar nobody reaches', () => {
    const { browserFamily: _unused, ...noFamily } = firefox()
    void _unused
    assert.equal(findSameMachine({ ...base(), features: noFamily }), undefined)
    assert.equal(findSameMachine({ ...base(), params: { ...params, minLogOdds: 50 } }), undefined)
  })

  it('limits the number of links, strongest first', () => {
    const many = {
      ...base(),
      seen: [{ deviceId: 'a' }, { deviceId: 'b' }, { deviceId: 'c' }],
      profiles: [
        profile('a', chrome({ screenResolution: 'other' })),
        profile('b', chrome()),
        profile('c', chrome({ timezone: 'other' })),
      ],
      params: { ...params, maxLinks: 2, minLogOdds: 0 },
    }
    const links = findSameMachine(many)?.links
    assert.equal(links?.length, 2)
    assert.equal(links?.[0].visitorId, 'b')
  })
})

describe('feature scopes', () => {
  it('gives every feature a scope, and keeps the browser stack out of the machine', () => {
    for (const name of featureNames) {
      assert.ok(['machine', 'browser', 'network'].includes(scopeOf(name)), name)
    }
    for (const name of [
      'webglRenderer',
      'tlsCiphers',
      'headerCore',
      'http2',
      'fonts',
      'vendor',
      'storedId',
      'browserFamily',
    ]) {
      assert.equal(scopeOf(name), 'browser', name)
    }
    for (const name of ['screenResolution', 'colorDepth', 'platform', 'timezone', 'gpuFamily', 'speechVoices']) {
      assert.equal(scopeOf(name), 'machine', name)
    }
    assert.equal(scopeOf('ip'), 'network')
    assert.equal(scopeOf('hardwareConcurrency'), 'browser', 'it differs between browsers of one machine')
  })
})
