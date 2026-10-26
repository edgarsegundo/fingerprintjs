import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { browserOf } from '../net/browser'
import type { NetworkSignals } from '../net/signals'
import type { StoredEvent } from '../store/types'

import { buildDataset, EvalEvent, parseDataset, serializeDataset } from './dataset'
import { buildPairs } from './pairs'
import { buildReport, renderMarkdown } from './report'
import { componentOverlapScorer, legacyHashScorer, Scorer } from './scorers'
import { generateSynthetic } from './synthetic'

/** Equal when every component has the same value. It is what the hash of the original library tests, minus the hash. */
const exactScorer: Scorer = {
  name: 'exact',
  description: 'All components equal.',
  score: (a, b) => {
    const values = (e: EvalEvent) => JSON.stringify(Object.entries(e.components).map(([key, c]) => [key, c.value]))
    return values(a) === values(b) ? 1 : 0
  },
}
const exactId = (event: EvalEvent) => JSON.stringify(Object.entries(event.components).map(([key, c]) => [key, c.value]))

const day = 24 * 60 * 60 * 1000

describe('browserOf', () => {
  it('splits the usual user agents', () => {
    const cases: Array<[string, string]> = [
      ['Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', 'chrome'],
      ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0', 'edge'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0', 'firefox'],
      [
        'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'safari',
      ],
      [
        'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0 Mobile/15E148 Safari/604.1',
        'chrome',
      ],
      ['curl/8.4.0', 'other'],
    ]
    for (const [userAgent, expected] of cases) {
      assert.equal(browserOf(userAgent), expected, userAgent)
    }
    assert.equal(browserOf(undefined), 'other')
  })
})

describe('dataset', () => {
  const network: NetworkSignals = {
    ip: '203.0.113.77',
    ipVersion: 4,
    ipPrefix: '203.0.113.0/24',
    ipSource: 'socket',
    ipIntel: { tags: ['datacenter'] },
    viaProxy: false,
    httpVersion: '2.0',
    headers: { order: ['host'], casing: 'l', fp: 'hfp', values: { 'user-agent': 'UA/1' } },
    tls: { ja4: 't13d1516h2_8daaf6152771_e5627efa2ab1', source: 'front' },
    http2: { settings: {}, pseudoHeaderOrder: 'masp', fp: 'h2fp' },
  }
  const stored = (requestId: string, linkedId?: string): StoredEvent => ({
    requestId,
    tenantId: 't1',
    receivedAt: 1000,
    network,
    payload: {
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: 1,
      durationMs: 1,
      ...(linkedId ? { linkedId } : {}),
      components: { platform: { value: 'MacIntel', duration: 1 } },
      extended: {},
    },
    derived: { clockSkewMs: 0 },
  })

  it('keeps only the labelled events and says how many it left out', () => {
    const { dataset, skipped } = buildDataset([stored('a', 'dev_1'), stored('b'), stored('c', 'dev_2')])
    assert.equal(skipped, 1)
    assert.deepEqual(
      dataset.events.map((event) => event.label),
      ['dev_1', 'dev_2'],
    )
  })

  it('replaces the addresses by hashes unless asked to keep them, and the file never holds the address', () => {
    const hidden = buildDataset([stored('a', 'dev_1')]).dataset
    assert.match(hidden.events[0].network.ip ?? '', /^h_[0-9a-f]{12}$/)
    assert.equal(hidden.meta.ipPseudonymized, true)
    assert.ok(!serializeDataset(hidden).includes('203.0.113'))

    const kept = buildDataset([stored('a', 'dev_1')], { keepIp: true }).dataset
    assert.equal(kept.events[0].network.ip, '203.0.113.77')
    assert.equal(kept.meta.ipPseudonymized, false)
  })

  it('hashes the same address the same way within one export, and differently in another export', () => {
    const one = buildDataset([stored('a', 'd1'), stored('b', 'd2')]).dataset
    assert.equal(one.events[0].network.ip, one.events[1].network.ip)
    const other = buildDataset([stored('a', 'd1')]).dataset
    assert.notEqual(one.events[0].network.ip, other.events[0].network.ip)
  })

  it('copies the network signals the evaluation needs', () => {
    const [event] = buildDataset([stored('a', 'dev_1')]).dataset.events
    assert.equal(event.network.ja4, 't13d1516h2_8daaf6152771_e5627efa2ab1')
    assert.equal(event.network.headerFp, 'hfp')
    assert.equal(event.network.http2Fp, 'h2fp')
    assert.deepEqual(event.network.ipTags, ['datacenter'])
    assert.equal(event.userAgent, 'UA/1')
  })

  it('round-trips through the file format', () => {
    const dataset = buildDataset([stored('a', 'dev_1'), stored('b', 'dev_2')], { now: 5 }).dataset
    // JSON drops fields that are `undefined`, so the copy is compared with the JSON form of the original
    assert.deepEqual(parseDataset(serializeDataset(dataset)), JSON.parse(JSON.stringify(dataset)))
  })

  it('refuses files that are not datasets', () => {
    assert.throws(() => parseDataset(''), /empty/)
    assert.throws(() => parseDataset('{"type":"event"}\n'), /first line/)
    assert.throws(() => parseDataset('{"type":"meta","format":2}\n'), /first line/)
    assert.throws(() => parseDataset('{"type":"meta","format":1}\n{"type":"event","label":5}\n'), /not a valid event/)
  })
})

describe('buildPairs', () => {
  const dataset = generateSynthetic({ seed: 3, devices: 20, visitsPerDevice: 4, days: 10 })

  it('makes every same-device pair and a sample of different-device pairs', () => {
    const pairs = buildPairs(dataset.events, { maxNegatives: 500 })
    assert.equal(pairs.filter((pair) => pair.same).length, 20 * 6) // C(4,2) per device
    assert.equal(pairs.filter((pair) => !pair.same).length, 500)
    assert.ok(pairs.every((pair) => (pair.a.label === pair.b.label) === pair.same))
    assert.ok(pairs.every((pair) => pair.gapMs >= 0))
  })

  it('is the same on every run with the same seed, and differs with another', () => {
    const ids = (seed: number) =>
      buildPairs(dataset.events, { seed, maxNegatives: 50 }).map((pair) => pair.a.requestId + pair.b.requestId)
    assert.deepEqual(ids(1), ids(1))
    assert.notDeepEqual(ids(1), ids(2))
  })

  it('caps the pairs of a device with many visits', () => {
    const many = generateSynthetic({ seed: 1, devices: 2, visitsPerDevice: 40, days: 5 })
    const positives = buildPairs(many.events, { maxPositivePerLabel: 30, maxNegatives: 10 }).filter((pair) => pair.same)
    assert.equal(positives.length, 60)
  })

  it('never repeats a different-device pair, and uses all of them when there are few', () => {
    const small = generateSynthetic({ seed: 8, devices: 3, visitsPerDevice: 3, days: 2 })
    const negatives = buildPairs(small.events, { maxNegatives: 100_000 }).filter((pair) => !pair.same)
    // 9 visits: 36 pairs, 9 of them within a device, so 27 pairs of different devices exist
    assert.equal(negatives.length, 27)
    assert.equal(new Set(negatives.map((pair) => [pair.a.requestId, pair.b.requestId].sort().join('|'))).size, 27)
  })

  it('samples without repeating when there are more candidates than the cap', () => {
    const data = generateSynthetic({ seed: 8, devices: 30, visitsPerDevice: 4, days: 2 })
    const negatives = buildPairs(data.events, { maxNegatives: 300 }).filter((pair) => !pair.same)
    assert.equal(negatives.length, 300)
    assert.equal(new Set(negatives.map((pair) => [pair.a.requestId, pair.b.requestId].sort().join('|'))).size, 300)
  })

  it('makes no different-device pairs with a single device', () => {
    const one = generateSynthetic({ seed: 1, devices: 1, visitsPerDevice: 3, days: 1 })
    assert.equal(buildPairs(one.events).filter((pair) => !pair.same).length, 0)
  })
})

describe('scorers', () => {
  const [a, b] = generateSynthetic({ seed: 5, devices: 1, visitsPerDevice: 2, days: 0.01, updatesPerDay: 0 }).events

  it('component-overlap is 1 for identical components and ignores failed ones', () => {
    assert.equal(componentOverlapScorer.score(a, b), 1)
    const failed = {
      ...b,
      components: { ...b.components, platform: { error: { name: 'E', message: 'x' }, duration: 1 } },
    }
    assert.equal(componentOverlapScorer.score(a, failed), 1)
    const different = { ...b, components: { ...b.components, platform: { value: 'other', duration: 1 } } }
    assert.ok(componentOverlapScorer.score(a, different) < 1)
    assert.equal(componentOverlapScorer.score(a, { ...b, components: {} }), 0)
  })

  const libraryBuilt = existsSync(path.resolve(__dirname, '../../../dist/fp.cjs.js'))
  it(
    'legacy-hash equals the hash of the original library (needs yarn build)',
    { skip: libraryBuilt ? false : 'dist/ is not built' },
    () => {
      assert.equal(legacyHashScorer.score(a, b), 1)
      const different = { ...b, components: { ...b.components, platform: { value: 'other', duration: 1 } } }
      assert.equal(legacyHashScorer.score(a, different), 0)
      // The duration is not part of the hash: only values count
      const slower = { ...b, components: { ...b.components, platform: { ...b.components.platform, duration: 999 } } }
      assert.equal(legacyHashScorer.score(a, slower), 1)
    },
  )
})

describe('report on synthetic data (validates the harness, says nothing about real accuracy)', () => {
  const options = { seed: 1, idOf: exactId, maxNegatives: 4000 }

  it('sees no instability when nothing drifts, and the instability that was put in when things drift', () => {
    const stable = generateSynthetic({
      seed: 11,
      devices: 80,
      visitsPerDevice: 6,
      days: 60,
      updatesPerDay: 0,
      noiseRate: 0,
    })
    const drifting = generateSynthetic({
      seed: 11,
      devices: 80,
      visitsPerDevice: 6,
      days: 60,
      updatesPerDay: 0.05,
      noiseRate: 0,
    })

    const stableReport = buildReport(stable, [exactScorer], options).scorers[0]
    assert.equal(stableReport.fnmr.value, 0, 'a population that never changes must never be called different')

    const driftReport = buildReport(drifting, [exactScorer], options).scorers[0]
    assert.ok(driftReport.fnmr.value > 0.3, `fnmr ${driftReport.fnmr.value}`)

    // Instability grows with the time between visits, which is what a drifting browser should do
    const gaps = driftReport.byGap.filter((row) => row.positives >= 30)
    assert.ok(gaps.length >= 3)
    assert.ok(gaps[0].fnmr.value < gaps[gaps.length - 1].fnmr.value, JSON.stringify(gaps.map((g) => g.fnmr.value)))
  })

  it('sees the collisions that the skew of the population puts in', () => {
    const crowded = generateSynthetic({
      seed: 2,
      devices: 200,
      visitsPerDevice: 2,
      days: 5,
      skew: 2.5,
      updatesPerDay: 0,
    })
    const spread = generateSynthetic({ seed: 2, devices: 200, visitsPerDevice: 2, days: 5, skew: 0, updatesPerDay: 0 })
    const crowdedReport = buildReport(crowded, [exactScorer], options)
    const spreadReport = buildReport(spread, [exactScorer], options)
    assert.ok(crowdedReport.scorers[0].fmr.value > spreadReport.scorers[0].fmr.value)
    assert.ok(crowdedReport.anonymity.labelsWithUniqueId.value < spreadReport.anonymity.labelsWithUniqueId.value)
    assert.ok(crowdedReport.anonymity.entropyBits < spreadReport.anonymity.entropyBits)
    assert.ok(crowdedReport.anonymity.largestGroup > spreadReport.anonymity.largestGroup)
  })

  it('shows that a fuzzy match separates better than an exact one when things drift', () => {
    const drifting = generateSynthetic({ seed: 4, devices: 80, visitsPerDevice: 6, days: 60, updatesPerDay: 0.05 })
    const [exact, overlap] = buildReport(drifting, [exactScorer, componentOverlapScorer], options).scorers
    assert.ok(overlap.auc > exact.auc, `overlap ${overlap.auc} exact ${exact.auc}`)
    assert.ok(overlap.auc > 0.9)
  })

  it('is repeatable', () => {
    const data = generateSynthetic({ seed: 9, devices: 30, visitsPerDevice: 3, days: 20 })
    assert.deepEqual(buildReport(data, [exactScorer], options), buildReport(data, [exactScorer], options))
  })

  it('splits the results by browser', () => {
    const data = generateSynthetic({ seed: 9, devices: 90, visitsPerDevice: 3, days: 20 })
    const rows = buildReport(data, [exactScorer], options).scorers[0].byBrowser
    assert.deepEqual(rows.map((row) => row.browser).sort(), ['chrome', 'firefox', 'safari'])
    assert.equal(
      rows.reduce((sum, row) => sum + row.events, 0),
      270,
    )
  })
})

describe('boundaries', () => {
  const hour = 60 * 60 * 1000
  const event = (requestId: string, label: string, receivedAt: number): EvalEvent => ({
    requestId,
    receivedAt,
    label,
    components: {},
    extended: {},
    network: { viaProxy: false, httpVersion: '2.0', ipTags: [] },
  })
  const dataset = (events: EvalEvent[]) => ({
    meta: generateSynthetic({ seed: 1, devices: 1, visitsPerDevice: 1, days: 1 }).meta,
    events,
  })
  const fixed = (value: number): Scorer => ({ name: `fixed-${value}`, description: '', score: () => value })

  it('calls a pair "same device" when the score is equal to the threshold', () => {
    const events = [event('a1', 'a', 0), event('a2', 'a', 1000), event('b1', 'b', 0), event('b2', 'b', 1000)]
    const report = buildReport(dataset(events), [fixed(0.5)], { idOf: exactId, threshold: 0.5, maxNegatives: 50 })
      .scorers[0]
    assert.equal(report.fnmr.value, 0, 'a score at the threshold is a match, so the same device is not an error')
    assert.equal(report.fmr.value, 1, 'and a different device with a score at the threshold is a false match')
    const below = buildReport(dataset(events), [fixed(0.49)], { idOf: exactId, threshold: 0.5, maxNegatives: 50 })
      .scorers[0]
    assert.equal(below.fnmr.value, 1)
    assert.equal(below.fmr.value, 0)
  })

  it('puts a gap of exactly one hour in the next bucket', () => {
    const events = [event('a1', 'a', 0), event('a2', 'a', hour - 1), event('a3', 'a', hour), event('b1', 'b', 0)]
    const report = buildReport(dataset(events), [fixed(1)], { idOf: exactId }).scorers[0]
    const counts = Object.fromEntries(report.byGap.map((row) => [row.bucket, row.positives]))
    // pairs: a1-a2 = 1h-1ms, a1-a3 = 1h, a2-a3 = 1ms
    assert.equal(counts['menos de 1 hora'], 2)
    assert.equal(counts['1 hora a 1 dia'], 1)
  })

  it('counts every same-device pair in exactly one bucket', () => {
    const data = generateSynthetic({ seed: 21, devices: 25, visitsPerDevice: 5, days: 90 })
    const report = buildReport(data, [exactScorer], { idOf: exactId }).scorers[0]
    assert.equal(
      report.byGap.reduce((sum, row) => sum + row.positives, 0),
      report.positives,
    )
  })
})

describe('intervals in the report', () => {
  it('does not let a few devices look like a large sample: 3 devices give 0% to 100%', () => {
    const data = generateSynthetic({ seed: 6, devices: 3, visitsPerDevice: 20, days: 5, updatesPerDay: 0 })
    const report = buildReport(data, [exactScorer], { idOf: exactId, maxNegatives: 100_000 }).scorers[0]
    assert.equal(report.fmr.low, 0)
    assert.equal(report.fmr.high, 1)
    assert.equal(report.fmr.clusters, 3)
    assert.equal(report.negatives, 3 * 20 * 20, 'every distinct pair of visits of different devices, once')
  })

  it('gives a wider interval for the same number of pairs when they come from fewer devices', () => {
    const interval = (devices: number, visits: number) =>
      buildReport(
        generateSynthetic({ seed: 6, devices, visitsPerDevice: visits, days: 5, updatesPerDay: 0, skew: 2.5 }),
        [exactScorer],
        { idOf: exactId, maxNegatives: 2000 },
      ).scorers[0].fmr
    const fewDevices = interval(15, 20)
    const manyDevices = interval(150, 2)
    assert.equal(fewDevices.n, manyDevices.n, 'the same number of pairs')
    assert.ok(fewDevices.high - fewDevices.low > manyDevices.high - manyDevices.low)
    assert.equal(fewDevices.clusters, 15)
    assert.equal(manyDevices.clusters, 150)
  })

  it('shows the devices behind each interval in the text', () => {
    const data = generateSynthetic({ seed: 6, devices: 20, visitsPerDevice: 3, days: 5 })
    const text = renderMarkdown(buildReport(data, [exactScorer], { idOf: exactId }))
    assert.match(text, /pares de 20 aparelhos/)
    assert.ok(text.includes('bootstrap'))
  })
})

describe('warnings and rendering', () => {
  const options = { seed: 1, idOf: exactId }

  it('always says that synthetic data proves nothing', () => {
    const report = buildReport(
      generateSynthetic({ seed: 1, devices: 5, visitsPerDevice: 2, days: 1 }),
      [exactScorer],
      options,
    )
    assert.ok(report.warnings[0].startsWith('DADOS SINTÉTICOS'))
    assert.ok(renderMarkdown(report).includes('DADOS SINTÉTICOS'))
  })

  it('warns about a sample too small to claim a false match rate, with the rule of three', () => {
    const report = buildReport(
      generateSynthetic({ seed: 1, devices: 10, visitsPerDevice: 3, days: 2 }),
      [exactScorer],
      { ...options, maxNegatives: 100 },
    )
    assert.ok(report.warnings.some((warning) => warning.includes('regra dos três')))
    assert.equal(report.scorers[0].atTargetFmr.verifiable, false)
  })

  it('warns about few devices, a short period, and a single device', () => {
    const few = buildReport(
      generateSynthetic({ seed: 1, devices: 5, visitsPerDevice: 3, days: 2 }),
      [exactScorer],
      options,
    )
    assert.ok(few.warnings.some((warning) => warning.includes('aparelhos distintos')))
    assert.ok(few.warnings.some((warning) => warning.includes('estabilidade em 7 ou 30 dias')))
    const single = buildReport(
      generateSynthetic({ seed: 1, devices: 1, visitsPerDevice: 3, days: 2 }),
      [exactScorer],
      options,
    )
    assert.ok(single.warnings.some((warning) => warning.includes('falso match')))
  })

  it('warns when no device has a repeat visit', () => {
    const report = buildReport(
      generateSynthetic({ seed: 1, devices: 10, visitsPerDevice: 1, days: 2 }),
      [exactScorer],
      options,
    )
    assert.ok(report.warnings.some((warning) => warning.includes('mais de uma visita')))
    assert.equal(report.scorers[0].fnmr.n, 0)
  })

  it('renders a readable report with intervals', () => {
    const data = generateSynthetic({ seed: 1, devices: 30, visitsPerDevice: 3, days: 30 })
    const text = renderMarkdown(buildReport(data, [exactScorer, componentOverlapScorer], options))
    for (const expected of [
      '# Relatório de avaliação',
      '## Pontuador: exact',
      '## Pontuador: component-overlap',
      'IC 95%',
      'FNMR',
      'FMR',
      'AUC',
      '| menos de 1 hora |',
    ]) {
      assert.ok(text.includes(expected), expected)
    }
    assert.ok(!text.includes('NaN') && !text.includes('undefined'))
  })

  it('does not fail on an empty dataset', () => {
    const empty = { meta: generateSynthetic({ seed: 1, devices: 1, visitsPerDevice: 1, days: 1 }).meta, events: [] }
    const report = buildReport(empty, [exactScorer], options)
    assert.equal(report.events, 0)
    assert.ok(!renderMarkdown(report).includes('undefined'))
  })

  it('has day-sized gaps in the synthetic time axis', () => {
    const data = generateSynthetic({ seed: 1, devices: 2, visitsPerDevice: 2, days: 10 })
    const times = data.events.map((event) => event.receivedAt)
    assert.ok(Math.max(...times) - Math.min(...times) <= 10 * day)
  })
})
