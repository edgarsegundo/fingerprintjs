import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { defaultModel } from '../identity/model'

import {
  Assignment,
  assignWithEngine,
  clusterMetrics,
  evaluateIdentity,
  renderIdentityReport,
  spreadOverDevices,
} from './identity_eval'
import { generateSynthetic } from './synthetic'

const assignment = (label: string, visitorId: string, n: number): Assignment => ({
  requestId: `${label}-${visitorId}-${n}`,
  label,
  visitorId,
})

describe('clusterMetrics', () => {
  it('counts the pairs exactly on a case worked out by hand', () => {
    // Device A has 3 visits, device B has 2. Visitor id x got A1, A2, B1, B2; y got A3.
    const metrics = clusterMetrics([
      assignment('A', 'x', 1),
      assignment('A', 'x', 2),
      assignment('A', 'y', 3),
      assignment('B', 'x', 4),
      assignment('B', 'x', 5),
    ])
    // Pairs of one device: 3 + 1 = 4, of which 2 stayed together -> recall 1/2.
    // Pairs with the same id: 6, of which 2 are one device -> precision 1/3.
    // Pairs of different devices: 10 - 4 = 6, of which 4 got the same id -> collision 2/3.
    assert.equal(metrics.pairRecall, 0.5)
    assert.equal(metrics.pairPrecision, 2 / 6)
    assert.equal(metrics.mergeRate, 4 / 6)
    assert.deepEqual([metrics.events, metrics.devices, metrics.visitorIds], [5, 2, 2])
  })

  it('gives the extremes for a perfect, a merged and a fully split result', () => {
    const rows = (idOf: (label: string, n: number) => string) =>
      ['A', 'B', 'C'].flatMap((label) => [1, 2, 3].map((n) => assignment(label, idOf(label, n), n)))
    const perfect = clusterMetrics(rows((label) => label))
    assert.deepEqual([perfect.pairRecall, perfect.pairPrecision, perfect.mergeRate], [1, 1, 0])
    const merged = clusterMetrics(rows(() => 'one'))
    assert.deepEqual([merged.pairRecall, merged.mergeRate], [1, 1])
    const split = clusterMetrics(rows((label, n) => `${label}${n}`))
    assert.equal(split.pairRecall, 0)
    assert.equal(split.mergeRate, 0)
    assert.ok(Number.isNaN(split.pairPrecision), 'no pair got the same id, so precision is undefined')
  })

  it('does not fail on no data or on one visit per device', () => {
    assert.ok(Number.isNaN(clusterMetrics([]).pairRecall))
    assert.ok(Number.isNaN(clusterMetrics([assignment('A', 'x', 1), assignment('B', 'y', 2)]).pairRecall))
  })
})

describe('spreadOverDevices', () => {
  const data = generateSynthetic({ seed: 2, devices: 60, visitsPerDevice: 4, days: 30 })
  const assignments = assignWithEngine(data)

  it('is repeatable and brackets the value', () => {
    const recall = (m: { pairRecall: number }) => m.pairRecall
    const a = spreadOverDevices(assignments, recall, { seed: 1 })
    assert.deepEqual(a, spreadOverDevices(assignments, recall, { seed: 1 }))
    const value = clusterMetrics(assignments).pairRecall
    assert.ok(a.low <= value + 0.05 && a.high >= value - 0.05)
    assert.ok(a.low >= 0 && a.high <= 1)
  })

  it('says nothing with fewer than five devices', () => {
    const few = assignments.filter((row) => ['device_0', 'device_1', 'device_2'].includes(row.label))
    assert.ok(Number.isNaN(spreadOverDevices(few, (m) => m.pairRecall).low))
  })
})

describe('assignWithEngine', () => {
  const data = generateSynthetic({ seed: 3, devices: 40, visitsPerDevice: 4, days: 30, updatesPerDay: 0.05 })

  it('does not depend on the order of the rows in the file, only on the time of the visits', () => {
    const shuffled = { ...data, events: [...data.events].reverse() }
    const key = (rows: Assignment[]) => rows.map((row) => `${row.requestId}:${row.visitorId}`).sort()
    assert.deepEqual(key(assignWithEngine(shuffled)), key(assignWithEngine(data)))
  })

  it('never lets the future change a decision: a visit is placed using only what came before it', () => {
    const ordered = [...data.events].sort((a, b) => a.receivedAt - b.receivedAt || (a.requestId < b.requestId ? -1 : 1))
    const first = ordered.slice(0, 60)
    const full = assignWithEngine(data)
    const prefix = assignWithEngine({ ...data, events: first })
    assert.deepEqual(
      prefix.map((row) => row.visitorId),
      full.slice(0, 60).map((row) => row.visitorId),
    )
  })

  it('uses the model it is given', () => {
    const strict = assignWithEngine(data, { ...defaultModel(), matchProbability: 0.999 })
    const loose = assignWithEngine(data, { ...defaultModel(), matchProbability: 0.5 })
    assert.ok(new Set(strict.map((row) => row.visitorId)).size > new Set(loose.map((row) => row.visitorId)).size)
  })
})

describe('evaluateIdentity (on made-up data: it checks the code, not the accuracy)', () => {
  const libraryBuilt = existsSync(path.resolve(__dirname, '../../../dist/fp.cjs.js'))

  it('shows the trade-off of the threshold: stricter makes more ids and fewer collisions', () => {
    const data = generateSynthetic({
      seed: 5,
      devices: 120,
      visitsPerDevice: 5,
      days: 60,
      updatesPerDay: 0.03,
      noiseRate: 0.02,
    })
    const thresholds = [0.5, 0.8, 0.95, 0.99, 0.999]
    const results = thresholds.map(
      (matchProbability) =>
        evaluateIdentity(data, { model: { ...defaultModel(), matchProbability }, legacy: false }).methods[0].metrics,
    )
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i].visitorIds >= results[i - 1].visitorIds, `ids at ${thresholds[i]}`)
      assert.ok(results[i].pairRecall <= results[i - 1].pairRecall + 1e-9, `stability at ${thresholds[i]}`)
      assert.ok(results[i].mergeRate <= results[i - 1].mergeRate + 1e-9, `collision at ${thresholds[i]}`)
    }
  })

  it(
    'finds the engine more stable than the exact hash when browsers update, and equal when nothing changes',
    { skip: libraryBuilt ? false : 'dist/ is not built' },
    () => {
      const drifting = evaluateIdentity(
        generateSynthetic({ seed: 5, devices: 120, visitsPerDevice: 5, days: 60, updatesPerDay: 0.05 }),
      )
      const [legacy, engine] = drifting.methods
      assert.equal(legacy.name, 'legacy-hash')
      assert.ok(
        engine.metrics.pairRecall > legacy.metrics.pairRecall + 0.2,
        `${engine.metrics.pairRecall} vs ${legacy.metrics.pairRecall}`,
      )
      assert.ok(engine.metrics.visitorIds < legacy.metrics.visitorIds, 'the hash makes a new id at every update')

      const still = evaluateIdentity(
        generateSynthetic({ seed: 5, devices: 120, visitsPerDevice: 5, days: 60, updatesPerDay: 0, noiseRate: 0 }),
      )
      assert.equal(still.methods[0].metrics.pairRecall, 1, 'an exact hash of unchanged signals is perfectly stable')
    },
  )

  it('warns about made-up data, few devices, and provisional parameters', () => {
    const report = evaluateIdentity(generateSynthetic({ seed: 1, devices: 10, visitsPerDevice: 3, days: 5 }), {
      legacy: false,
    })
    const text = report.warnings.join(' ')
    for (const expected of ['SINTÉTICOS', 'Só 10 aparelhos', 'provisórios']) {
      assert.ok(text.includes(expected), expected)
    }
  })

  it('warns when the model was fitted on the same data it is judged on', () => {
    const data = generateSynthetic({ seed: 1, devices: 40, visitsPerDevice: 3, days: 10 })
    const model = {
      ...defaultModel(),
      calibrated: true,
      fittedFrom: { devices: 40, visits: 120, datasetId: 'abc', fittedAt: 1 },
    }
    assert.equal(evaluateIdentity(data, { model, datasetId: 'abc', legacy: false }).inSample, true)
    assert.equal(evaluateIdentity(data, { model, datasetId: 'other', legacy: false }).inSample, false)
    assert.ok(
      evaluateIdentity(data, { model, datasetId: 'abc', legacy: false }).warnings.some((w) =>
        w.includes('mesmos dados'),
      ),
    )
  })

  it('renders a readable report that says it is not a confidence interval', () => {
    const data = generateSynthetic({ seed: 1, devices: 40, visitsPerDevice: 3, days: 10 })
    const text = renderIdentityReport(evaluateIdentity(data, { legacy: false }))
    for (const expected of [
      '# Relatório de identificação',
      'DADOS SINTÉTICOS',
      'identity-engine',
      'não é um intervalo de confiança',
    ]) {
      assert.ok(text.includes(expected), expected)
    }
    assert.ok(!text.includes('NaN') && !text.includes('undefined'))
  })
})
