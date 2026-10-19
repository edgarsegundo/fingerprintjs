import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Resolution } from '../identity/store'
import { parseZoneTab } from '../net/timezones'
import { defaultSettings } from '../settings/settings'
import type { StoredEvent } from '../store/types'
import type { TamperReport } from '../tamper/checks'

import { behaviorOf, buildFacts, computeRisk, RiskInputs } from './risk'

const settings = () => defaultSettings().risk

const event = (extra: Partial<StoredEvent['network']['ipIntel']> = {}, zone = 'America/Sao_Paulo'): StoredEvent => ({
  requestId: 'r1',
  tenantId: 't1',
  receivedAt: 1_000_000,
  network: {
    ip: '203.0.113.5',
    ipVersion: 4,
    ipPrefix: '203.0.113.0/24',
    ipSource: 'socket',
    ipIntel: { tags: [], ...extra },
    viaProxy: false,
    httpVersion: '2.0',
    headers: { order: [], casing: '', fp: 'x', values: {} },
  },
  payload: {
    schema: 1,
    libVersion: '5.3.0',
    collectedAt: 1,
    durationMs: 1,
    components: { timezone: { value: zone, duration: 1 } },
    extended: {},
  },
  derived: { clockSkewMs: 0 },
})

const resolution = (extra: Partial<Resolution> = {}): Resolution => ({
  visitorId: 'v_1',
  matched: true,
  ambiguous: false,
  learned: true,
  logOdds: 3,
  probability: null,
  provisionalProbability: 0.97,
  calibrated: false,
  thresholds: { match: 0.95, possibleLink: null },
  candidates: 1,
  devices: 10,
  explanation: [],
  resolvedAt: 1,
  ...extra,
})

const inputs = (extra: Partial<RiskInputs> = {}): RiskInputs => ({
  event: event(),
  tamper: { signals: [], counts: { high: 0, medium: 0, low: 0 } },
  resolution: resolution(),
  ...extra,
})

const tamperWith = (...signals: Array<[string, 'low' | 'medium' | 'high']>): TamperReport => ({
  signals: signals.map(([id, severity]) => ({ id, severity, detail: `detail of ${id}` })),
  counts: {
    high: signals.filter(([, s]) => s === 'high').length,
    medium: signals.filter(([, s]) => s === 'medium').length,
    low: signals.filter(([, s]) => s === 'low').length,
  },
})

const activity = (extra: Partial<{ visits: number; devices: number; linkedIds: number; ips: number }> = {}) => ({
  visits: 1,
  devices: 1,
  linkedIds: 1,
  ips: 1,
  ...extra,
})

describe('computeRisk', () => {
  it('is zero and low for an ordinary visit, and says it is a heuristic', () => {
    const risk = computeRisk(inputs(), settings())
    assert.deepEqual(risk, { score: 0, level: 'low', factors: [], heuristic: true, calibrated: false })
  })

  it('adds the weight of each list the address is in, and ignores a list with no weight', () => {
    const risk = computeRisk(inputs({ event: event({ tags: ['datacenter', 'tor_exit', 'my_own_list'] }) }), settings())
    assert.deepEqual(
      risk.factors.map((f) => [f.id, f.weight]),
      [
        ['ip_tag:datacenter', 25],
        ['ip_tag:tor_exit', 40],
      ],
    )
    assert.equal(risk.score, 65)
    assert.equal(risk.level, 'high')
  })

  it('does not take a tag called like an object property for a weight', () => {
    const risk = computeRisk(inputs({ event: event({ tags: ['constructor', 'toString', '__proto__'] }) }), settings())
    assert.equal(risk.score, 0)
  })

  it('weighs each tamper signal by its severity, once', () => {
    const risk = computeRisk(
      inputs({
        tamper: tamperWith(['automation_markers', 'high'], ['clock_skew', 'low'], ['impossible_values', 'medium']),
      }),
      settings(),
    )
    assert.deepEqual(
      risk.factors.map((f) => [f.id, f.weight]),
      [
        ['tamper:automation_markers', 40],
        ['tamper:clock_skew', 5],
        ['tamper:impossible_values', 15],
      ],
    )
    assert.equal(risk.score, 60)
  })

  it('cuts the score at 100 and still lists every factor', () => {
    const risk = computeRisk(
      inputs({
        event: event({ tags: ['tor_exit', 'datacenter'] }),
        tamper: tamperWith(['a', 'high'], ['b', 'high'], ['c', 'high']),
      }),
      settings(),
    )
    assert.equal(risk.score, 100)
    assert.equal(risk.factors.length, 5)
  })

  it('puts the level at the exact thresholds', () => {
    const at = (score: number) => {
      const s = settings()
      s.ipTagWeights = { x: score }
      return computeRisk(inputs({ event: event({ tags: ['x'] }) }), s).level
    }
    assert.deepEqual([at(24.99), at(25), at(59.99), at(60)], ['low', 'medium', 'medium', 'high'])
  })

  it('flags a time zone that does not belong to the country of the address, and only then', () => {
    const timezones = parseZoneTab('BR\t-2332-04637\tAmerica/Sao_Paulo\nPT\t+3843-00908\tEurope/Lisbon\n')
    const mismatch = computeRisk(inputs({ event: event({ country: 'PT' }), timezones }), settings())
    assert.deepEqual(
      mismatch.factors.map((f) => f.id),
      ['timezone_country_mismatch'],
    )
    assert.match(mismatch.factors[0].detail, /America\/Sao_Paulo.*PT/)
    for (const quiet of [
      inputs({ event: event({ country: 'BR' }), timezones }),
      inputs({ event: event({}), timezones }), // no country known
      inputs({ event: event({ country: 'PT' }) }), // no table
      inputs({ event: event({ country: 'PT' }, 'Asia/Calcutta'), timezones }), // a zone the table does not know
    ]) {
      assert.deepEqual(computeRisk(quiet, settings()).factors, [])
    }
  })

  it('weighs a possible link and a new device only when the weights say so', () => {
    const linked = resolution({
      matched: false,
      possibleLink: { visitorId: 'v_2', logOdds: 1, probability: null, provisionalProbability: 0.5 },
    })
    assert.deepEqual(
      computeRisk(inputs({ resolution: linked }), settings()).factors.map((f) => f.id),
      ['possible_link'],
    )
    const s = settings()
    s.newVisitorWeight = 5
    assert.deepEqual(
      computeRisk(inputs({ resolution: resolution({ matched: false }) }), s).factors.map((f) => [f.id, f.weight]),
      [['new_visitor', 5]],
    )
    assert.deepEqual(computeRisk(inputs({ resolution: resolution({ matched: false }) }), settings()).factors, [])
  })

  it('weighs a stored code that was copied to another machine, and says nothing otherwise', () => {
    const copied = resolution({ storedIdConflict: true })
    const report = computeRisk(inputs({ resolution: copied }), settings())
    assert.deepEqual(
      report.factors.map((f) => [f.id, f.weight]),
      [['stored_id_conflict', settings().storedIdConflictWeight]],
    )
    assert.deepEqual(
      computeRisk(inputs({ resolution: resolution() }), settings()).factors,
      [],
      'no conflict, no factor',
    )
    const free = settings()
    free.storedIdConflictWeight = 0
    assert.deepEqual(computeRisk(inputs({ resolution: copied }), free).factors, [], 'a weight of zero adds nothing')
    assert.equal(buildFacts(inputs({ resolution: copied }), null)['identity.storedIdConflict'], true)
    assert.equal(buildFacts(inputs(), null)['identity.storedIdConflict'], false)
  })

  it('lists the environment but weighs it only when the tenant gives it a weight', () => {
    const environment = {
      signals: [
        { id: 'virtual_machine_gpu' as const, detail: 'a virtual card' },
        { id: 'private_mode_likely' as const, detail: 'a small quota' },
      ],
    }
    assert.deepEqual(computeRisk(inputs({ environment }), settings()).factors, [], 'zero by default')
    const s = settings()
    s.environmentWeights = { virtual_machine_gpu: 12 }
    assert.deepEqual(
      computeRisk(inputs({ environment }), s).factors.map((f) => [f.id, f.weight]),
      [['environment:virtual_machine_gpu', 12]],
      'only the check that has a weight',
    )
    assert.deepEqual(buildFacts(inputs({ environment }), null)['environment.signals'], [
      'virtual_machine_gpu',
      'private_mode_likely',
    ])
    assert.equal('environment.signals' in buildFacts(inputs(), null), false, 'turned off: not a fact')
  })

  it('weighs a copy of a crawler name, and says nothing when the check could not be made', () => {
    const withCrawler = (verified: boolean | null) => {
      const base = event()
      return { ...base, network: { ...base.network, crawler: { claimed: 'googlebot', verified } } }
    }
    const ids = (verified: boolean | null) =>
      computeRisk(inputs({ event: withCrawler(verified) }), settings()).factors.map((f) => f.id)
    assert.deepEqual(ids(false), ['fake_crawler'])
    assert.deepEqual(ids(true), [])
    assert.deepEqual(ids(null), [])
    const facts = (verified: boolean | null) => buildFacts(inputs({ event: withCrawler(verified) }), null)
    assert.equal(facts(false)['crawler.verified'], false)
    assert.equal(facts(true)['crawler.verified'], true)
    assert.equal('crawler.verified' in facts(null), false, 'unknown is left out, not guessed')
    assert.equal(facts(null)['crawler.claimed'], 'googlebot')
    assert.equal('crawler.claimed' in buildFacts(inputs(), null), false)
  })

  it('counts visits in the window against the threshold, the threshold included', () => {
    const run = (linkedIds: number, devices: number, ips: number) =>
      computeRisk(
        inputs({ deviceActivity: activity({ linkedIds, ips }), ipActivity: activity({ devices }) }),
        settings(),
      ).factors.map((f) => f.id)
    assert.deepEqual(run(2, 9, 5), [])
    assert.deepEqual(run(3, 9, 5), ['velocity:linked_ids_per_device'])
    assert.deepEqual(run(2, 10, 5), ['velocity:devices_per_ip'])
    assert.deepEqual(run(2, 9, 6), ['velocity:ips_per_device'])
    // Without the numbers (the matcher is off) there is nothing to say
    assert.deepEqual(computeRisk(inputs({ resolution: null }), settings()).factors, [])
  })

  it('turns a factor off with weight zero', () => {
    const s = settings()
    s.velocity.linkedIdsPerDevice.weight = 0
    assert.deepEqual(computeRisk(inputs({ deviceActivity: activity({ linkedIds: 50 }) }), s).factors, [])
  })
})

describe('behavior', () => {
  const withBehavior = (value: unknown, error?: string): StoredEvent => {
    const base = event()
    base.payload.extended = { behavior: { value, duration: 1, ...(error ? { error } : {}) } as never }
    return base
  }
  const summary = (extra: Record<string, number> = {}) => ({
    observedMs: 8000,
    firstInteractionMs: null,
    pointerMoves: 0,
    clicks: 0,
    keyPresses: 0,
    scrolls: 0,
    touches: 0,
    syntheticEvents: 0,
    ...extra,
  })
  const ids = (e: StoredEvent, change: (s: ReturnType<typeof settings>) => void = () => undefined) => {
    const s = settings()
    change(s)
    return computeRisk(inputs({ event: e }), s).factors.map((f) => [f.id, f.weight])
  }

  it('says nothing when the page did not turn the signal on, or reported nonsense', () => {
    assert.deepEqual(ids(event()), [])
    for (const bad of [
      null,
      'x',
      5,
      {},
      summary({ clicks: -1 }),
      { ...summary(), touches: 'many' },
      { ...summary(), observedMs: NaN },
    ]) {
      assert.equal(behaviorOf(withBehavior(bad)), undefined, JSON.stringify(bad))
    }
    assert.equal(behaviorOf(withBehavior(summary(), 'failed')), undefined)
  })

  it('adds the real interactions and keeps the made-up events apart', () => {
    assert.deepEqual(
      behaviorOf(
        withBehavior(
          summary({ pointerMoves: 4, clicks: 1, keyPresses: 2, scrolls: 3, touches: 5, syntheticEvents: 7 }),
        ),
      ),
      {
        observedMs: 8000,
        interactions: 15,
        syntheticEvents: 7,
      },
    )
  })

  it('weighs events made by a script, from the threshold on', () => {
    assert.deepEqual(ids(withBehavior(summary({ clicks: 1, syntheticEvents: 1 }))), [['behavior:synthetic_events', 20]])
    assert.deepEqual(
      ids(withBehavior(summary({ clicks: 1, syntheticEvents: 2 })), (s) => (s.behavior.syntheticEventsThreshold = 3)),
      [],
    )
    assert.deepEqual(
      ids(withBehavior(summary({ clicks: 1, syntheticEvents: 3 })), (s) => (s.behavior.syntheticEventsThreshold = 3)),
      [['behavior:synthetic_events', 20]],
    )
  })

  it('reports no interaction only after the minimum time of observation, and only if there was none', () => {
    assert.deepEqual(ids(withBehavior(summary())), [['behavior:no_interaction', 5]])
    assert.deepEqual(ids(withBehavior(summary({ observedMs: 4999 }))), [], 'seen for too short a time to say')
    assert.deepEqual(
      ids(withBehavior(summary({ observedMs: 5000 }))),
      [['behavior:no_interaction', 5]],
      'the edge counts',
    )
    assert.deepEqual(ids(withBehavior(summary({ scrolls: 1 }))), [])
    assert.deepEqual(ids(withBehavior(summary({ touches: 1 }))), [])
  })

  it('gives the facts of the rules', () => {
    const facts = buildFacts(inputs({ event: withBehavior(summary({ clicks: 2, syntheticEvents: 1 })) }), null)
    assert.equal(facts['behavior.observedMs'], 8000)
    assert.equal(facts['behavior.interactions'], 2)
    assert.equal(facts['behavior.syntheticEvents'], 1)
    assert.equal('behavior.interactions' in buildFacts(inputs(), null), false)
  })
})

describe('buildFacts', () => {
  it('gives the facts that rules read, and leaves out what is not known', () => {
    const risk = computeRisk(inputs({ event: event({ tags: ['vpn'], country: 'BR' }) }), settings())
    const facts = buildFacts(
      inputs({
        event: { ...event({ tags: ['vpn'], country: 'BR' }), payload: { ...event().payload, linkedId: 'acct-1' } },
        tamper: tamperWith(['clock_skew', 'low']),
        deviceActivity: activity({ linkedIds: 4, ips: 2 }),
        ipActivity: activity({ devices: 7 }),
      }),
      risk,
    )
    assert.deepEqual(facts, {
      'ip.tags': ['vpn'],
      'ip.version': 4,
      'ip.country': 'BR',
      'event.viaProxy': false,
      'event.linkedId': 'acct-1',
      'risk.score': 20,
      'risk.level': 'low',
      'risk.factors': ['ip_tag:vpn'],
      'tamper.high': 0,
      'tamper.medium': 0,
      'tamper.low': 1,
      'tamper.signals': ['clock_skew'],
      'identity.visitorId': 'v_1',
      'identity.matched': true,
      'identity.new': false,
      'identity.ambiguous': false,
      'identity.possibleLink': false,
      'identity.storedIdConflict': false,
      'identity.learned': true,
      'velocity.linkedIdsPerDevice': 4,
      'velocity.ipsPerDevice': 2,
      'velocity.devicesPerIp': 7,
    })
    const bare = buildFacts(inputs({ resolution: null, tamper: null }), null)
    assert.deepEqual(Object.keys(bare).sort(), ['event.viaProxy', 'ip.tags', 'ip.version'])
  })

  it('shows a probability only when the model is calibrated', () => {
    assert.equal('identity.probability' in buildFacts(inputs(), null), false)
    assert.equal(
      buildFacts(inputs({ resolution: resolution({ probability: 0.99, calibrated: true }) }), null)[
        'identity.probability'
      ],
      0.99,
    )
  })
})
