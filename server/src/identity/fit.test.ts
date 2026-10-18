import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateIdentity } from '../eval/identity_eval'
import { seededRandom } from '../eval/stats'
import { generateSynthetic } from '../eval/synthetic'

import { collectCalibrationExamples, datasetId, estimateM, expectedCalibrationError, fitModel, fitPlatt } from './fit'
import { defaultModel, parseModel, probabilityOf } from './model'

describe('fitPlatt', () => {
  it('recovers the scale and offset that produced the data', () => {
    const random = seededRandom(7)
    const trueA = 0.6
    const trueB = -1
    const examples = Array.from({ length: 6000 }, () => {
      const x = random() * 16 - 8
      return { x, positive: random() < 1 / (1 + Math.exp(-(trueA * x + trueB))) }
    })
    const fit = fitPlatt(examples)
    assert.equal(fit.converged, true)
    assert.ok(Math.abs(fit.a - trueA) < 0.08, `a = ${fit.a}`)
    assert.ok(Math.abs(fit.b - trueB) < 0.12, `b = ${fit.b}`)
  })

  it('stays finite when the two classes are perfectly separated', () => {
    const examples = [
      ...Array.from({ length: 50 }, (_, i) => ({ x: 5 + i * 0.1, positive: true })),
      ...Array.from({ length: 50 }, (_, i) => ({ x: -5 - i * 0.1, positive: false })),
    ]
    const fit = fitPlatt(examples)
    assert.ok(Number.isFinite(fit.a) && Number.isFinite(fit.b))
    assert.ok(fit.a > 0)
  })
})

describe('expectedCalibrationError', () => {
  it('is zero for a perfectly calibrated set and large for an overconfident one', () => {
    const calibrated = [...Array.from({ length: 80 }, () => ({ probability: 0.8, positive: true })).slice(0, 80)]
    const half = [
      ...Array.from({ length: 8 }, () => ({ probability: 0.8, positive: true })),
      ...Array.from({ length: 2 }, () => ({ probability: 0.8, positive: false })),
    ]
    assert.ok(expectedCalibrationError(half) < 1e-9, 'saying 80% when 8 of 10 happen is calibrated')
    const overconfident = Array.from({ length: 10 }, (_, i) => ({ probability: 0.99, positive: i < 5 }))
    assert.ok(Math.abs(expectedCalibrationError(overconfident) - 0.49) < 1e-9)
    void calibrated
    assert.ok(Number.isNaN(expectedCalibrationError([])))
  })
})

describe('estimateM', () => {
  it('finds that a feature that drifts keeps its value less often than one that does not', () => {
    const data = generateSynthetic({ seed: 8, devices: 150, visitsPerDevice: 6, days: 60, updatesPerDay: 0.05 })
    const { m, estimates } = estimateM(data.events)
    assert.ok(m.webglRenderer > 0.97, `webglRenderer ${m.webglRenderer}`)
    assert.ok(m.userAgentVersion < 0.9, `userAgentVersion ${m.userAgentVersion}`)
    assert.ok(m.webglRenderer > m.userAgentVersion + 0.1)
    assert.ok(estimates.userAgentVersion.n > 100)
  })

  it('says that nothing drifts when nothing does', () => {
    const data = generateSynthetic({
      seed: 8,
      devices: 150,
      visitsPerDevice: 6,
      days: 60,
      updatesPerDay: 0,
      noiseRate: 0,
    })
    assert.ok(estimateM(data.events).m.userAgentVersion > 0.97)
  })

  it('leaves out a feature with too few comparisons, and never reports a perfect or hopeless one', () => {
    const small = generateSynthetic({ seed: 8, devices: 3, visitsPerDevice: 3, days: 5 })
    assert.deepEqual(estimateM(small.events).m, {}, 'a handful of comparisons proves nothing')
    const still = generateSynthetic({
      seed: 8,
      devices: 200,
      visitsPerDevice: 6,
      days: 60,
      updatesPerDay: 0,
      noiseRate: 0,
    })
    for (const value of Object.values(estimateM(still.events).m)) {
      assert.ok(value <= 0.995 && value >= 0.02)
    }
  })
})

describe('datasetId', () => {
  it('depends on the visits and not on their order', () => {
    const data = generateSynthetic({ seed: 1, devices: 5, visitsPerDevice: 3, days: 5 })
    assert.equal(datasetId(data), datasetId({ ...data, events: [...data.events].reverse() }))
    assert.notEqual(datasetId(data), datasetId({ ...data, events: data.events.slice(1) }))
  })
})

describe('fitModel (on made-up data: it checks the code, not the accuracy)', () => {
  const training = generateSynthetic({
    seed: 11,
    devices: 300,
    visitsPerDevice: 6,
    days: 60,
    updatesPerDay: 0.04,
    noiseRate: 0.02,
  })

  it('learns the chance of keeping a value, calibrates the scale and says where it came from', () => {
    const { model, summary, warnings } = fitModel(training, { seed: 1, now: 123 })
    assert.equal(model.calibrated, true)
    assert.equal(model.fittedFrom?.datasetId, datasetId(training))
    assert.equal(model.fittedFrom?.fittedAt, 123)
    assert.ok(model.platt.a > 0)
    assert.ok(summary.featuresFitted > 5 && summary.featuresFitted <= summary.featuresTotal)
    assert.equal(summary.devicesForM + summary.devicesForCalibration, summary.devices)
    assert.ok(summary.calibration && summary.calibration.examples >= 100)
    assert.ok(
      warnings.some((warning) => warning.includes('mesmos dados')),
      'it must say that the calibration is measured on its own data',
    )
  })

  it('keeps the model marked as not calibrated when there is too little data', () => {
    const tiny = generateSynthetic({ seed: 11, devices: 8, visitsPerDevice: 3, days: 10 })
    const { model, warnings } = fitModel(tiny)
    assert.equal(model.calibrated, false)
    assert.equal(model.fittedFrom, undefined)
    assert.ok(warnings.some((warning) => warning.includes('NÃO calibrado')))
    assert.deepEqual(model.platt, defaultModel().platt)
  })

  it('produces probabilities that match what happens, on data that was not used to fit it', () => {
    const { model } = fitModel(training, { seed: 1 })
    const fresh = generateSynthetic({
      seed: 12,
      devices: 300,
      visitsPerDevice: 6,
      days: 60,
      updatesPerDay: 0.04,
      noiseRate: 0.02,
    })
    // The examples are the raw evidence and what happened; the probability comes from the fitted scale
    const raw = collectCalibrationExamples(fresh.events, { ...model, platt: { a: 1, b: 0 } })
    const fitted = expectedCalibrationError(
      raw.map((example) => ({ probability: probabilityOf(model, example.x), positive: example.positive })),
    )
    assert.ok(fitted < 0.1, `calibration error on new data: ${fitted}`)
  })

  it('is judged as optimistic when evaluated on the data it was fitted on, and not on new data', () => {
    const { model } = fitModel(training, { seed: 1 })
    const fresh = generateSynthetic({ seed: 13, devices: 60, visitsPerDevice: 4, days: 30 })
    assert.equal(evaluateIdentity(training, { model, datasetId: datasetId(training), legacy: false }).inSample, true)
    assert.equal(evaluateIdentity(fresh, { model, datasetId: datasetId(fresh), legacy: false }).inSample, false)
  })

  it('writes a model that can be read back', () => {
    const { model } = fitModel(training, { seed: 1 })
    const roundTrip = parseModel(JSON.parse(JSON.stringify(model)))
    assert.equal(roundTrip.calibrated, true)
    assert.deepEqual(roundTrip.m, model.m)
    assert.deepEqual(roundTrip.platt, model.platt)
  })

  it('is repeatable', () => {
    assert.deepEqual(fitModel(training, { seed: 3, now: 1 }), fitModel(training, { seed: 3, now: 1 }))
  })
})

describe('parseModel', () => {
  it('reads the default model back and fills what is missing', () => {
    assert.deepEqual(parseModel({ version: 1 }), defaultModel())
  })

  it('refuses a number that cannot be a probability, a missing version, and a bad scale', () => {
    for (const bad of [
      null,
      {},
      { version: 2 },
      { version: 1, m: { canvas: 1 } },
      { version: 1, m: { canvas: 0 } },
      { version: 1, matchProbability: 1.5 },
      { version: 1, platt: { a: -1, b: 0 } },
      { version: 1, defaultM: { stable: 'high' } },
    ]) {
      assert.throws(() => parseModel(bad), /Model:/, JSON.stringify(bad))
    }
  })
})
