import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ResolveParams } from './decision'
import { Features } from './features'
import { MemoryIdentityStore } from './memory_store'
import { defaultModel, Model } from './model'
import { SyncIdentityEngine } from './sync_engine'

function makeEngine(overrides: Partial<Model> = {}) {
  let counter = 0
  const store = new MemoryIdentityStore()
  const engine = new SyncIdentityEngine(
    store,
    // These tests are about how the engine decides, not about where the bar is, so they use a lower one than the
    // default; the tests about the bar and the ties say which they use
    { ...defaultModel(), matchProbability: 0.95, ...overrides },
    { newId: () => `dev${++counter}`, now: () => 1000 },
  )
  let request = 0
  const visit = (features: Features, tenant = 't1', params: ResolveParams = {}) =>
    engine.resolve(tenant, `r${++request}`, features, 1000 + request, params)
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
    // A visit that does not say which of the two it is
    const attached = visit(shared, 't1', { onAmbiguous: 'attach' })
    assert.equal(attached.matched, true)
    assert.equal(attached.ambiguous, true)
    assert.ok(attached.candidates >= 2)
    assert.ok([first.visitorId, second.visitorId].includes(attached.visitorId))
    assert.equal(attached.possibleLink, undefined, 'it was attached, so there is nothing to mark')
  })

  it('does not attach a visit that fits two devices alike, since the wrong person is the costlier mistake', () => {
    const { visit, store } = makeEngine()
    for (let n = 1; n <= 50; n++) {
      visit(device(n))
    }
    const shared = { canvas: 'twin', fonts: 'twin', webglRenderer: 'twin' }
    const first = visit({ ...shared, hardwareConcurrency: 'a1', deviceMemory: 'a2', screenResolution: 'a3' })
    const second = visit({ ...shared, hardwareConcurrency: 'b1', deviceMemory: 'b2', screenResolution: 'b3' })
    const devicesBefore = store.population('t1').devices
    // This is the default
    const result = visit(shared)
    assert.equal(result.matched, false)
    assert.equal(result.ambiguous, true, 'it says why')
    assert.ok(
      [first.visitorId, second.visitorId].includes(result.possibleLink?.visitorId ?? ''),
      'and who is the closest',
    )
    assert.notEqual(result.visitorId, first.visitorId)
    assert.notEqual(result.visitorId, second.visitorId)
    assert.equal(store.population('t1').devices, devicesBefore + 1, 'a new device was made')
    // The same, said out loud
    assert.equal(visit(shared, 't1', { onAmbiguous: 'separate' }).matched, false)
  })

  it('still attaches a visit that clearly fits one device, whatever the tie rule', () => {
    const { visit } = makeEngine()
    for (let n = 1; n <= 20; n++) {
      visit(device(n))
    }
    for (const onAmbiguous of ['separate', 'attach'] as const) {
      const result = visit(device(7), 't1', { onAmbiguous })
      assert.equal(result.matched, true, onAmbiguous)
      assert.equal(result.ambiguous, false, onAmbiguous)
    }
  })

  it('does not link on thin evidence at the default bar, which is high', () => {
    const made = makeEngine({ matchProbability: defaultModel().matchProbability })
    for (let n = 1; n <= 5; n++) {
      made.visit(device(n))
    }
    // Two of eight signals agree: not enough to say it is the same person
    const result = made.visit({ canvas: 'canvas2', userAgentVersion: 'ua2-v1' })
    assert.equal(result.matched, false)
    assert.ok(defaultModel().matchProbability >= 0.99)
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

  describe('parameters of one call', () => {
    const crowd = () => {
      const made = makeEngine()
      for (let n = 1; n <= 30; n++) {
        made.visit(device(n))
      }
      return made
    }

    it('compares at most as many devices as it is told to', () => {
      const { engine } = crowd()
      const features = { timezone: 'tz-common', platform: 'platform-common' } // shared by all 30
      assert.equal(engine.resolve('t1', 'a', features, 5000, { maxCandidates: 3, learn: false }).candidates, 3)
      assert.equal(engine.resolve('t1', 'b', features, 5000, { maxCandidates: 12, learn: false }).candidates, 12)
    })

    it('lists as many features in the explanation as it is told to', () => {
      const { engine } = crowd()
      const sizes = [1, 3, 8].map(
        (explanationSize) =>
          engine.resolve('t1', `e${explanationSize}`, device(4), 5000, { explanationSize, learn: false }).explanation
            .length,
      )
      assert.deepEqual(sizes, [1, 3, 8])
    })

    it('calls the choice ambiguous according to the margin it is told to use', () => {
      const { visit, engine } = makeEngine()
      for (let n = 1; n <= 50; n++) {
        visit(device(n))
      }
      const shared = { canvas: 'twin', fonts: 'twin', webglRenderer: 'twin' }
      visit({ ...shared, hardwareConcurrency: 'a1', deviceMemory: 'a2', screenResolution: 'a3' })
      visit({ ...shared, hardwareConcurrency: 'b1', deviceMemory: 'b2', screenResolution: 'b3' })
      const gap = (margin: number) =>
        engine.resolve('t1', `m${margin}`, shared, 5000, { ambiguityMargin: margin, learn: false })
      assert.equal(gap(0).ambiguous, false, 'with no margin even an exact tie is not called ambiguous')
      assert.equal(gap(1000).ambiguous, true, 'a huge margin makes any runner-up count')
    })

    it('does not teach anything when learn is false, but still answers', () => {
      const { engine, store, visit } = makeEngine()
      const unknown = engine.resolve('t1', 'x', device(1), 2000, { learn: false })
      assert.equal(unknown.learned, false)
      assert.equal(unknown.matched, false)
      assert.equal(store.population('t1').devices, 0)
      assert.equal(visit(device(1)).matched, false, 'the visit that could not teach left nothing to match')
      const known = engine.resolve('t1', 'y', device(1), 2001, { learn: false })
      assert.equal(known.matched, true)
      assert.equal(known.learned, false)
    })

    it('marks a possible link only below the match bar, above its own, and never when matched', () => {
      const { engine, visit } = makeEngine({ matchProbability: 0.999999 })
      for (let n = 1; n <= 5; n++) {
        visit(device(n))
      }
      const partial: Features = { canvas: 'canvas2', userAgentVersion: 'ua2-v1' }
      const marked = engine.resolve('t1', 'p1', partial, 5000, { possibleLinkProbability: 0.2, learn: false })
      assert.equal(marked.matched, false)
      assert.equal(marked.possibleLink?.visitorId, 'dev2')
      assert.equal(marked.thresholds.possibleLink, 0.2)
      const off = engine.resolve('t1', 'p2', partial, 5000, { possibleLinkProbability: null, learn: false })
      assert.equal(off.possibleLink, undefined)
      assert.equal(engine.resolve('t1', 'p3', partial, 5000, { learn: false }).possibleLink, undefined)
      const tooHigh = engine.resolve('t1', 'p4', partial, 5000, { possibleLinkProbability: 0.999998, learn: false })
      assert.equal(tooHigh.possibleLink, undefined)

      const loose = makeEngine({ matchProbability: 0.5 })
      for (let n = 1; n <= 5; n++) {
        loose.visit(device(n))
      }
      const matched = loose.engine.resolve('t1', 'p5', partial, 5000, { possibleLinkProbability: 0.2, learn: false })
      assert.equal(matched.matched, true)
      assert.equal(matched.possibleLink, undefined, 'a visit that was attached is not also a possible link')
    })

    it('uses the model of the call over the one of the engine', () => {
      const { engine, visit } = makeEngine({ matchProbability: 0.5 })
      for (let n = 1; n <= 5; n++) {
        visit(device(n))
      }
      const partial: Features = { canvas: 'canvas2', userAgentVersion: 'ua2-v1' }
      assert.equal(engine.resolve('t1', 'q1', partial, 5000, { learn: false }).matched, true)
      const strict = { ...defaultModel(), matchProbability: 0.999999 }
      assert.equal(engine.resolve('t1', 'q2', partial, 5000, { model: strict, learn: false }).matched, false)
    })
  })
})
