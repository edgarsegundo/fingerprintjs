import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Volatility } from './features'
import { agreementWeight, disagreementWeight, priorLogOdds, smoothedAgreement } from './model'

const volatilities: Volatility[] = ['stable', 'semi', 'volatile']
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
        for (const volatility of volatilities) {
          const weight = disagreementWeight(m, u, volatility)
          assert.ok(weight <= 0, `m ${m} u ${u} ${volatility} gave ${weight}`)
        }
      }
    }
  })

  it('stops one changed signal from ruling out a match: the pull of a disagreement has a floor', () => {
    assert.ok(disagreementWeight(0.995, 0.01, 'stable') >= -6)
    assert.ok(disagreementWeight(0.995, 0.01, 'semi') >= -3)
    assert.ok(disagreementWeight(0.995, 0.01, 'volatile') >= -1.5)
    // And a volatile signal is allowed to change more than a stable one
    assert.ok(disagreementWeight(0.9, 0.01, 'volatile') > disagreementWeight(0.9, 0.01, 'stable'))
  })

  it('gives more weight to a rarer value, and to a signal that is kept more reliably', () => {
    assert.ok(agreementWeight(0.98, 1000, 2) > agreementWeight(0.98, 1000, 100))
    assert.ok(agreementWeight(0.98, 1000, 100) > agreementWeight(0.98, 1000, 800))
    assert.ok(agreementWeight(0.98, 1000, 5) > agreementWeight(0.7, 1000, 5))
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
