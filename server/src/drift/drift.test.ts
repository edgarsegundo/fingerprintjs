import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeDrift, jensenShannon } from './drift'

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries))
const visits = (feature: string, values: Record<string, number>) =>
  Object.entries(values).flatMap(([value, n]) => Array.from({ length: n }, () => ({ [feature]: value })))

describe('jensenShannon', () => {
  it('is 0 for the same distribution (whatever the sample size) and 1 for none in common', () => {
    assert.equal(jensenShannon(counts({ a: 3, b: 1 }), counts({ a: 30, b: 10 })), 0)
    assert.equal(jensenShannon(counts({ a: 5 }), counts({ b: 7 })), 1)
  })

  it('is symmetric, between the bounds, and grows as the distributions part', () => {
    const near = jensenShannon(counts({ a: 9, b: 1 }), counts({ a: 8, b: 2 }))
    const far = jensenShannon(counts({ a: 9, b: 1 }), counts({ a: 2, b: 8 }))
    assert.ok(near > 0 && near < far && far < 1, `${near} ${far}`)
    assert.equal(
      jensenShannon(counts({ a: 9, b: 1 }), counts({ a: 2, b: 8 })),
      jensenShannon(counts({ a: 2, b: 8 }), counts({ a: 9, b: 1 })),
    )
  })

  it('has a known value for a worked case', () => {
    // p = (1, 0), q = (0.5, 0.5), so m = (0.75, 0.25), and JS is the mean of the two KL terms against m
    const expected = 0.5 * Math.log2(1 / 0.75) + 0.5 * (0.5 * Math.log2(0.5 / 0.75) + 0.5 * Math.log2(0.5 / 0.25))
    assert.ok(Math.abs(jensenShannon(counts({ a: 1 }), counts({ a: 1, b: 1 })) - expected) < 1e-12)
  })

  it('is 0 when either side is empty, since there is nothing to compare', () => {
    assert.equal(jensenShannon(counts({}), counts({ a: 1 })), 0)
    assert.equal(jensenShannon(counts({ a: 1 }), counts({})), 0)
  })
})

describe('computeDrift', () => {
  const options = { threshold: 0.3, minSamples: 20 }

  it('sees a feature whose values moved, and not one that stayed', () => {
    const previous = [...visits('gpu', { m1: 50, m2: 50 }), ...visits('tz', { br: 80, pt: 20 })]
    const current = [...visits('gpu', { m3: 90, m1: 10 }), ...visits('tz', { br: 78, pt: 22 })]
    const report = computeDrift(previous, current, options)
    const gpu = report.find((item) => item.feature === 'gpu')
    const tz = report.find((item) => item.feature === 'tz')
    assert.equal(gpu?.drifted, true)
    assert.equal(gpu?.novelty, 0.9, 'nine in ten visits have a value never seen before')
    assert.equal(tz?.drifted, false)
    assert.ok((tz?.divergence ?? 1) < 0.01)
    assert.equal(report[0].feature, 'gpu', 'the largest drift comes first')
  })

  it('says nothing when either period has too few visits', () => {
    const report = computeDrift(visits('gpu', { a: 19 }), visits('gpu', { b: 100 }), options)
    assert.deepEqual(report, [
      { feature: 'gpu', previousVisits: 19, currentVisits: 100, novelty: null, divergence: null, drifted: false },
    ])
    const exactly = computeDrift(visits('gpu', { a: 20 }), visits('gpu', { b: 20 }), options)
    assert.equal(exactly[0].drifted, true, 'twenty is enough')
  })

  it('applies the threshold at the edge', () => {
    const previous = visits('x', { a: 20 })
    const current = visits('x', { a: 20, b: 20 })
    const divergence = computeDrift(previous, current, { threshold: 1, minSamples: 1 })[0].divergence ?? 0
    assert.equal(
      computeDrift(previous, current, { threshold: divergence, minSamples: 1 })[0].drifted,
      true,
      'at the threshold',
    )
    assert.equal(computeDrift(previous, current, { threshold: divergence + 1e-9, minSamples: 1 })[0].drifted, false)
  })

  it('counts a feature that is missing in some visits only where it is there', () => {
    const previous = [...visits('a', { x: 30 }), ...visits('b', { y: 30 })]
    const current = [...visits('a', { x: 30 })]
    const report = computeDrift(previous, current, options)
    assert.deepEqual(
      report.map((item) => [item.feature, item.previousVisits, item.currentVisits]),
      [
        ['a', 30, 30],
        ['b', 30, 0],
      ],
    )
  })

  it('has nothing to report for no visits', () => {
    assert.deepEqual(computeDrift([], [], options), [])
  })
})
