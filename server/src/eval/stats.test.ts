import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  auc,
  ClusterOutcome,
  clusterInterval,
  equalErrorRate,
  operatingPointAtFmr,
  rocCurve,
  ruleOfThree,
  seededRandom,
  shannonEntropyBits,
  wilson,
} from './stats'

const close = (actual: number, expected: number, tolerance = 0.002) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)

describe('wilson', () => {
  it('matches known values', () => {
    const half = wilson(50, 100)
    close(half.value, 0.5)
    close(half.low, 0.4038)
    close(half.high, 0.5962)
  })

  it('says "at most about 11%" for zero errors in 30 trials, not "zero"', () => {
    const none = wilson(0, 30)
    assert.equal(none.value, 0)
    assert.equal(none.low, 0)
    close(none.high, 0.1135)
  })

  it('stays inside 0 to 1 and handles all and nothing', () => {
    const all = wilson(30, 30)
    assert.ok(all.high <= 1 && all.low > 0.88)
    assert.ok(Number.isNaN(wilson(0, 0).value))
  })

  it('narrows as the sample grows', () => {
    const small = wilson(5, 50)
    const large = wilson(500, 5000)
    assert.ok(large.high - large.low < small.high - small.low)
  })
})

describe('ruleOfThree', () => {
  it('gives the number of trials needed', () => {
    close(ruleOfThree(3000), 0.001, 1e-9)
    assert.ok(Number.isNaN(ruleOfThree(0)))
  })
})

describe('shannonEntropyBits', () => {
  it('is log2(n) for a uniform distribution and 0 for a single value', () => {
    close(shannonEntropyBits([1, 1, 1, 1, 1, 1, 1, 1]), 3, 1e-9)
    assert.equal(shannonEntropyBits([10]), 0)
    assert.equal(shannonEntropyBits([]), 0)
    close(shannonEntropyBits([3, 1]), 0.8113, 0.001)
  })
})

describe('auc', () => {
  it('is 1 for perfect separation, 0 for the opposite and 0.5 for no information', () => {
    assert.equal(auc([0.9, 0.8, 0.7], [0.1, 0.2, 0.3]), 1)
    assert.equal(auc([0.1, 0.2], [0.8, 0.9]), 0)
    assert.equal(auc([0.5, 0.5], [0.5, 0.5]), 0.5)
  })

  it('counts a tie as half', () => {
    // positives [1, 0]; negatives [0, 0]: pairs (1>0)x2 = 2, (0=0)x2 = 1 -> 3 / 4
    assert.equal(auc([1, 0], [0, 0]), 0.75)
  })

  it('is NaN without both classes', () => {
    assert.ok(Number.isNaN(auc([], [1])))
    assert.ok(Number.isNaN(auc([1], [])))
  })
})

describe('rocCurve, equalErrorRate and operatingPointAtFmr', () => {
  const positives = [0.9, 0.8, 0.6, 0.4]
  const negatives = [0.5, 0.3, 0.2, 0.1]
  const curve = rocCurve(positives, negatives)

  it('has FMR 1 / FNMR 0 at the lowest threshold and FMR 0 / FNMR 1 above every score', () => {
    assert.deepEqual(curve[0], { threshold: 0.1, fmr: 1, fnmr: 0 })
    assert.deepEqual(curve[curve.length - 1], { threshold: Number.POSITIVE_INFINITY, fmr: 0, fnmr: 1 })
  })

  it('computes the error rates of a threshold', () => {
    const at = curve.find((point) => point.threshold === 0.5)
    // Called "same" when score >= 0.5: positives below 0.5 -> 1 of 4; negatives at or above 0.5 -> 1 of 4
    assert.deepEqual(at, { threshold: 0.5, fmr: 0.25, fnmr: 0.25 })
  })

  it('finds the equal error rate', () => {
    assert.equal(equalErrorRate(curve).rate, 0.25)
  })

  it('picks the lowest FNMR that respects the FMR target', () => {
    assert.equal(operatingPointAtFmr(curve, 0)?.threshold, 0.6)
    assert.equal(operatingPointAtFmr(curve, 0)?.fnmr, 0.25)
    assert.equal(operatingPointAtFmr(curve, 1)?.fnmr, 0)
  })
})

describe('clusterInterval', () => {
  // `devices` devices, each with `perDevice` pairs of its own visits; the first `bad` devices always fail
  function outcomes(devices: number, perDevice: number, bad: number): ClusterOutcome[] {
    const result: ClusterOutcome[] = []
    for (let device = 0; device < devices; device++) {
      for (let pair = 0; pair < perDevice; pair++) {
        result.push({ a: `d${device}`, b: `d${device}`, hit: device < bad })
      }
    }
    return result
  }

  it('is wider than a plain interval when the errors are concentrated in a few devices', () => {
    const data = outcomes(40, 20, 4) // 800 pairs, 10% errors, all from 4 devices
    const plain = wilson(data.filter((o) => o.hit).length, data.length)
    const clustered = clusterInterval(data)
    assert.equal(clustered.value, 0.1)
    assert.ok(
      clustered.high - clustered.low > 2 * (plain.high - plain.low),
      `${clustered.low}-${clustered.high} vs ${plain.low}-${plain.high}`,
    )
    assert.ok(clustered.low <= 0.1 && clustered.high >= 0.1)
    assert.equal(clustered.clusters, 40)
    assert.equal(clustered.n, 800)
  })

  it('narrows as devices are added', () => {
    const few = clusterInterval(outcomes(20, 5, 2))
    const many = clusterInterval(outcomes(200, 5, 20))
    assert.ok(many.high - many.low < few.high - few.low)
  })

  it('says it cannot tell with fewer than 10 devices', () => {
    const interval = clusterInterval(outcomes(9, 50, 0))
    assert.equal(interval.low, 0)
    assert.equal(interval.high, 1)
    assert.equal(interval.clusters, 9)
  })

  it('does not claim a zero rate from zero errors: the bound depends on the number of devices', () => {
    const interval = clusterInterval(outcomes(30, 100, 0))
    assert.equal(interval.value, 0)
    assert.equal(interval.low, 0)
    close(interval.high, 0.1135) // 0 of 30 devices, like the plain interval of 30 trials
    assert.ok(clusterInterval(outcomes(300, 10, 0)).high < interval.high)
  })

  it('treats a pair of two devices by both devices', () => {
    // 12 devices; the pairs between device 0 and anyone are the errors
    const data: ClusterOutcome[] = []
    for (let i = 0; i < 12; i++) {
      for (let j = i + 1; j < 12; j++) {
        data.push({ a: `d${i}`, b: `d${j}`, hit: i === 0 })
      }
    }
    const interval = clusterInterval(data)
    assert.ok(interval.low < interval.value && interval.high > interval.value)
    assert.equal(interval.clusters, 12)
  })

  it('is repeatable, and handles no data', () => {
    const data = outcomes(30, 4, 5)
    assert.deepEqual(clusterInterval(data, { seed: 3 }), clusterInterval(data, { seed: 3 }))
    assert.ok(Number.isNaN(clusterInterval([]).value))
  })
})

describe('seededRandom', () => {
  it('repeats for the same seed and differs for another', () => {
    const a = seededRandom(7)
    const b = seededRandom(7)
    const c = seededRandom(8)
    const seqA = [a(), a(), a()]
    assert.deepEqual(seqA, [b(), b(), b()])
    assert.notDeepEqual(seqA, [c(), c(), c()])
    assert.ok(seqA.every((value) => value >= 0 && value < 1))
  })
})
