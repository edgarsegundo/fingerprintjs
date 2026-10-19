import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  agreementWeight,
  defaultModel,
  disagreementWeight,
  mFor,
  parseModel,
  priorLogOdds,
  scoreCandidate,
  smoothedAgreement,
  volatilityFor,
} from './model'

const floors = [-6, -3, -1.5, -20]
const probabilities = [0.02, 0.1, 0.5, 0.9, 0.98, 0.995]

describe('the weights of the model', () => {
  it('never lets agreeing count against a match, whatever the numbers', () => {
    for (const m of probabilities) {
      for (const devices of [1, 2, 10, 1000]) {
        for (const withValue of [1, Math.ceil(devices / 2), devices]) {
          const weight = agreementWeight(m, devices, Math.min(withValue, devices))
          assert.ok(weight >= 0, `m ${m} devices ${devices} with ${withValue} gave ${weight}`)
        }
      }
    }
  })

  it('never lets disagreeing count for a match, even when almost every pair of devices agrees', () => {
    for (const m of probabilities) {
      for (const u of [0, 0.1, 0.5, 0.9, 0.99, 0.999, 1, 1.5]) {
        for (const floor of floors) {
          const weight = disagreementWeight(m, u, floor)
          assert.ok(weight <= 0, `m ${m} u ${u} floor ${floor} gave ${weight}`)
        }
      }
    }
  })

  it('stops one changed signal from ruling out a match: the pull of a disagreement has a floor', () => {
    assert.equal(disagreementWeight(0.9999, 0.01, -6), -6)
    assert.equal(disagreementWeight(0.9999, 0.01, -3), -3)
    assert.equal(disagreementWeight(0.9999, 0.01, -1.5), -1.5)
    // A closer floor means that the signal is allowed to change more
    assert.ok(disagreementWeight(0.9, 0.01, -1.5) > disagreementWeight(0.9, 0.01, -6))
  })

  it('gives more weight to a rarer value, and to a signal that is kept more reliably', () => {
    assert.ok(agreementWeight(0.98, 1000, 2) > agreementWeight(0.98, 1000, 100))
    assert.ok(agreementWeight(0.98, 1000, 100) > agreementWeight(0.98, 1000, 800))
    assert.ok(agreementWeight(0.98, 1000, 5) > agreementWeight(0.7, 1000, 5))
  })

  it('caps what one feature can add, at the limit that is given', () => {
    assert.equal(agreementWeight(0.995, 1_000_000, 1, 5), 5)
    assert.ok(agreementWeight(0.995, 1_000_000, 1, 20) > 5)
  })

  it('has a finite weight even for a value that nobody else has', () => {
    for (const devices of [1, 2, 100, 1_000_000]) {
      const weight = agreementWeight(0.995, devices, 1)
      assert.ok(Number.isFinite(weight) && weight <= 12)
    }
  })

  it('makes the prior smaller as the population grows, and neutral for one device', () => {
    assert.ok(priorLogOdds(0) === 0) // (-0 === 0)
    assert.ok(priorLogOdds(1) === 0)
    assert.ok(priorLogOdds(10) > priorLogOdds(1000))
    assert.ok(priorLogOdds(1000) < 0)
  })

  it('smooths the agreement between devices and follows the data', () => {
    assert.equal(smoothedAgreement([]), 0.5, 'nothing known')
    assert.equal(smoothedAgreement([1]), 0.5, 'one device')
    assert.ok(smoothedAgreement([1, 1, 1, 1]) < 0.2, 'everyone different')
    assert.ok(smoothedAgreement([10]) > 0.9, 'everyone the same')
    assert.ok(smoothedAgreement([5, 5]) > smoothedAgreement([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]))
  })
})

describe('a code made up for one device', () => {
  const population = (devices: number) => ({
    devices,
    devicesWithValue: () => 1,
    agreementProbability: () => 0.5,
  })

  it('is worth the most that one feature can be, whatever the number of devices known', () => {
    const model = defaultModel()
    for (const devices of [1, 2, 50, 100000]) {
      const { contributions } = scoreCandidate(
        { storedId: 'code' },
        new Map([['storedId', new Set(['code'])]]),
        population(devices),
        model,
      )
      assert.deepEqual(contributions, [{ feature: 'storedId', outcome: 'agree', weight: model.maxWeight }])
    }
  })

  it('follows the limit of the model, and a lower limit is a lower weight', () => {
    const model = { ...defaultModel(), maxWeight: 5 }
    const { contributions } = scoreCandidate(
      { storedId: 'code' },
      new Map([['storedId', new Set(['code'])]]),
      population(10),
      model,
    )
    assert.equal(contributions[0].weight, 5)
  })

  it('counts lightly against a match when it is different, as for any feature that changes with the visitor', () => {
    const model = defaultModel()
    const { contributions } = scoreCandidate(
      { storedId: 'new' },
      new Map([['storedId', new Set(['old'])]]),
      population(1000),
      model,
    )
    assert.equal(contributions[0].outcome, 'disagree')
    assert.ok(contributions[0].weight <= 0 && contributions[0].weight >= model.disagreementFloor.volatile)
  })

  it('is left out when the device has never had a code, because nothing can be compared', () => {
    const { contributions } = scoreCandidate({ storedId: 'code' }, new Map(), population(10), defaultModel())
    assert.deepEqual(contributions, [])
  })
})

describe('the model carries its own limits', () => {
  it('has the built-in limits by default', () => {
    const model = defaultModel()
    assert.equal(model.maxWeight, 12)
    assert.deepEqual(model.disagreementFloor, { stable: -6, semi: -3, volatile: -1.5 })
  })

  it('takes how volatile a feature is from the model before the built-in classification', () => {
    const model = { ...defaultModel(), volatility: { webglRenderer: 'volatile' as const } }
    assert.equal(volatilityFor(defaultModel(), 'webglRenderer'), 'stable')
    assert.equal(volatilityFor(model, 'webglRenderer'), 'volatile')
    assert.equal(
      mFor(model, 'webglRenderer'),
      model.defaultM.volatile,
      'and so the default chance of keeping a value follows',
    )
  })

  it('reads the limits from a model file, and refuses wrong ones', () => {
    const parsed = parseModel({
      version: 1,
      maxWeight: 7,
      disagreementFloor: { stable: -9 },
      volatility: { fonts: 'semi' },
    })
    assert.equal(parsed.maxWeight, 7)
    assert.deepEqual(parsed.disagreementFloor, { stable: -9, semi: -3, volatile: -1.5 })
    assert.deepEqual(parsed.volatility, { fonts: 'semi' })
    for (const bad of [
      { maxWeight: 0 },
      { maxWeight: 'big' },
      { disagreementFloor: { stable: 1 } },
      { disagreementFloor: 5 },
      { volatility: { fonts: 'fast' } },
      { volatility: 5 },
    ]) {
      assert.throws(() => parseModel({ version: 1, ...bad }), /Model:/, JSON.stringify(bad))
    }
  })
})
