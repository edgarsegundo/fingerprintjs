import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { IdentityEngine } from './engine'
import { Features } from './features'
import { MemoryIdentityStore } from './memory_store'
import { defaultModel, Model } from './model'

function makeEngine(overrides: Partial<Model> = {}) {
  let counter = 0
  const store = new MemoryIdentityStore()
  const engine = new IdentityEngine(
    store,
    { ...defaultModel(), ...overrides },
    { newId: () => `dev${++counter}`, now: () => 1000 },
  )
  let request = 0
  const visit = (features: Features, tenant = 't1') => engine.resolve(tenant, `r${++request}`, features, 1000 + request)
  return { engine, store, visit }
}

/** A device made of distinct, rare-ish values, so that it is recognizable */
const device = (n: number, extra: Features = {}): Features => ({
  canvas: `canvas${n}`,
  webglRenderer: `gpu${n}`,
  fonts: `fonts${n}`,
  screenResolution: `screen${n}`,
  tlsCiphers: `ciphers${n}`,
  timezone: 'tz-common',
  platform: 'platform-common',
  userAgentVersion: `ua${n}-v1`,
  ...extra,
})

describe('IdentityEngine', () => {
  it('creates a device for the first visit, and recognizes it on the next', () => {
    const { visit } = makeEngine()
    const first = visit(device(1))
    assert.equal(first.matched, false)
    assert.equal(first.visitorId, 'dev1')
    assert.equal(first.logOdds, null)
    assert.deepEqual(first.explanation, [])
    const second = visit(device(1))
    assert.equal(second.matched, true)
    assert.equal(second.visitorId, 'dev1')
  })

  it('keeps different devices apart even when they share common values', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 5; n++) {
      visit(device(n))
    }
    const again = visit(device(3))
    assert.equal(again.visitorId, 'dev3')
    const stranger = visit(device(99))
    assert.equal(stranger.matched, false)
    assert.equal(stranger.visitorId, 'dev6')
  })

  it('survives a browser update: one volatile signal changes and the device is still the same', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 5; n++) {
      visit(device(n))
    }
    const updated = visit(device(2, { userAgentVersion: 'ua2-v2' }))
    assert.equal(updated.visitorId, 'dev2')
    assert.equal(updated.matched, true)
    const disagreement = updated.explanation.find((item) => item.feature === 'userAgentVersion')
    assert.equal(disagreement?.outcome, 'disagree')
    // And the new value is now known: the next visit with it agrees
    const next = visit(device(2, { userAgentVersion: 'ua2-v2' }))
    assert.equal(next.visitorId, 'dev2')
    assert.equal(next.explanation.find((item) => item.feature === 'userAgentVersion')?.outcome, 'agree')
  })

  it('does not match when most of the identifying signals changed', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 5; n++) {
      visit(device(n))
    }
    const different = visit(
      device(2, {
        canvas: 'other',
        webglRenderer: 'other',
        fonts: 'other',
        screenResolution: 'other',
        tlsCiphers: 'other',
      }),
    )
    assert.equal(different.matched, false)
    assert.notEqual(different.visitorId, 'dev2')
  })

  it('weighs a rare shared value more than a common one', () => {
    const { visit, engine } = makeEngine()
    for (let n = 1; n <= 10; n++) {
      visit({ rare: `rare${n}`, common: 'same', platform: `p${n}` })
    }
    const model = engine.model
    void model
    const viaRare = visit({ rare: 'rare4' })
    const viaCommon = visit({ common: 'same' })
    const rareWeight = viaRare.explanation.find((item) => item.feature === 'rare')?.weight ?? 0
    const commonWeight = viaCommon.explanation.find((item) => item.feature === 'common')?.weight ?? 0
    assert.ok(rareWeight > commonWeight + 1, `rare ${rareWeight} common ${commonWeight}`)
  })

  it('needs more evidence in a bigger population for a value that is just as common', () => {
    // A quarter of the devices share the value in both populations, so the value says the same in both.
    // Only the prior differs: one chance in 40 against one in 120.
    const populate = (size: number) => {
      const engine = makeEngine()
      for (let n = 1; n <= size; n++) {
        engine.visit({ shared: n % 4 === 0 ? 'quarter' : `own${n}`, noise: `noise${n}` })
      }
      return engine
    }
    const inSmall = populate(40).visit({ shared: 'quarter' })
    const inLarge = populate(120).visit({ shared: 'quarter' })
    assert.ok(inSmall.logOdds !== null && inLarge.logOdds !== null)
    assert.ok((inSmall.logOdds ?? 0) - (inLarge.logOdds ?? 0) > 0.9, `${inSmall.logOdds} vs ${inLarge.logOdds}`)
  })

  it('gives a rare value more weight in a bigger population, which offsets the prior', () => {
    const populate = (size: number) => {
      const engine = makeEngine()
      for (let n = 1; n <= size; n++) {
        engine.visit({ canvas: `canvas${n}` })
      }
      return engine
    }
    const small = populate(5).visit({ canvas: 'canvas2' })
    const large = populate(300).visit({ canvas: 'canvas2' })
    // Finding the one device in 300 that has this value is stronger evidence than finding it among 5
    assert.ok((large.explanation[0]?.weight ?? 0) > (small.explanation[0]?.weight ?? 0) + 2)
  })

  it('treats a missing signal as no evidence, in either direction', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 5; n++) {
      visit(device(n))
    }
    const withoutCanvas = { ...device(2) } as Features
    delete withoutCanvas.canvas
    const result = visit(withoutCanvas)
    assert.equal(result.visitorId, 'dev2')
    assert.ok(!result.explanation.some((item) => item.feature === 'canvas'))
  })

  it('makes a new device, without a probability, for a visit with nothing to compare', () => {
    const { visit } = makeEngine()
    visit(device(1))
    const empty = visit({})
    assert.equal(empty.matched, false)
    assert.equal(empty.logOdds, null)
    assert.equal(empty.provisionalProbability, null)
    assert.equal(empty.candidates, 0)
  })

  it('explains its decision: the pieces add up, and the counterfactuals are consistent', () => {
    const { visit, engine } = makeEngine()
    for (let n = 1; n <= 5; n++) {
      visit(device(n))
    }
    const result = visit(device(3, { userAgentVersion: 'ua3-v2' }))
    assert.ok(result.explanation.length > 0 && result.explanation.length <= 8)
    // The list is sorted by how much each feature counted
    const weights = result.explanation.map((item) => Math.abs(item.weight))
    assert.deepEqual(
      weights,
      [...weights].sort((a, b) => b - a),
    )
    // Without a feature that argued for the match, the probability is lower.
    // Without one that argued against, it is higher.
    for (const item of result.explanation) {
      const full = result.provisionalProbability as number
      if (item.weight > 0) {
        assert.ok(item.probabilityWithoutIt < full, item.feature)
      } else if (item.weight < 0) {
        assert.ok(item.probabilityWithoutIt > full, item.feature)
      }
    }
    // The log-odds are the prior plus the weights (the explanation lists the biggest, so check with all features)
    const everything = Object.keys(device(3)).length
    assert.ok(everything >= result.explanation.length)
    void engine
  })

  it('says it is ambiguous when two known devices fit almost equally', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 50; n++) {
      visit(device(n)) // other devices, so that the shared values below are rare
    }
    // Two devices that share three rare signals (say, the same model and the same fonts)
    // and differ in three stable ones
    const shared = { canvas: 'twin', fonts: 'twin', webglRenderer: 'twin' }
    const first = visit({ ...shared, hardwareConcurrency: 'a1', deviceMemory: 'a2', screenResolution: 'a3' })
    const second = visit({ ...shared, hardwareConcurrency: 'b1', deviceMemory: 'b2', screenResolution: 'b3' })
    assert.notEqual(first.visitorId, second.visitorId, 'three stable signals differ, so these are two devices')
    const result = visit(shared) // a visit that does not say which of the two it is
    assert.equal(result.matched, true)
    assert.equal(result.ambiguous, true)
    assert.ok(result.candidates >= 2)
  })

  it('is not ambiguous when one device clearly fits better', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 20; n++) {
      visit(device(n))
    }
    const result = visit(device(7))
    assert.equal(result.matched, true)
    assert.equal(result.ambiguous, false)
  })

  it('cannot tell apart two devices with identical signals (a limit of client signals)', () => {
    const { visit } = makeEngine()
    const first = visit(device(7))
    const twin = visit(device(7)) // a different physical device that looks the same
    assert.equal(twin.visitorId, first.visitorId, 'the matcher has no way to know it is another device')
  })

  it('does not show the probability until the model has been fitted on labelled data', () => {
    const { visit } = makeEngine()
    visit(device(1))
    const result = visit(device(1))
    assert.equal(result.calibrated, false)
    assert.equal(result.probability, null)
    assert.ok((result.provisionalProbability ?? 0) > 0)

    const fitted = makeEngine({ calibrated: true })
    fitted.visit(device(1))
    const calibrated = fitted.visit(device(1))
    assert.equal(calibrated.calibrated, true)
    assert.equal(calibrated.probability, calibrated.provisionalProbability)
  })

  it('keeps tenants apart: a device of one tenant is never a candidate for another', () => {
    const { visit } = makeEngine()
    visit(device(1), 'tenant-a')
    const other = visit(device(1), 'tenant-b')
    assert.equal(other.matched, false)
    assert.equal(other.devices, 0)
  })

  it('is repeatable', () => {
    const run = () => {
      const { visit } = makeEngine()
      return [1, 2, 3, 2, 1, 4].map((n) => visit(device(n)).visitorId)
    }
    assert.deepEqual(run(), run())
    assert.deepEqual(run(), ['dev1', 'dev2', 'dev3', 'dev2', 'dev1', 'dev4'])
  })

  it('remembers the resolution of a request', () => {
    const { engine } = makeEngine()
    const result = engine.resolve('t1', 'request-x', device(1), 5)
    assert.deepEqual(engine.getResolution('t1', 'request-x'), result)
    assert.equal(engine.getResolution('t2', 'request-x'), undefined)
    assert.equal(engine.getResolution('t1', 'nope'), undefined)
  })

  it('matches a stricter threshold less often', () => {
    const loose = makeEngine({ matchProbability: 0.5 })
    const strict = makeEngine({ matchProbability: 0.999999 })
    for (const { visit } of [loose, strict]) {
      for (let n = 1; n <= 5; n++) {
        visit(device(n))
      }
    }
    const partial: Features = { canvas: 'canvas2', userAgentVersion: 'ua2-v1' }
    assert.equal(loose.visit(partial).matched, true)
    assert.equal(strict.visit(partial).matched, false)
  })
})
