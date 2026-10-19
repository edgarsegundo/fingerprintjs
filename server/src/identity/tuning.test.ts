import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { defaultSettings } from '../settings/settings'

import { defaultModel } from './model'
import { applyIdentitySettings, ModelCatalog } from './tuning'

const settings = () => defaultSettings().identity

describe('applyIdentitySettings', () => {
  it('leaves the model alone when no setting is given', () => {
    assert.deepEqual(applyIdentitySettings(defaultModel(), settings()), defaultModel())
  })

  it('does not overrule a fitted model with a default that nobody chose', () => {
    const fitted = {
      ...defaultModel(),
      calibrated: true,
      matchProbability: 0.8,
      maxWeight: 9,
      platt: { a: 0.31, b: -1.4 },
      m: { canvas: 0.9 },
    }
    const result = applyIdentitySettings(fitted, settings())
    assert.deepEqual(result, fitted)
  })

  it('applies each setting that is given, over the model', () => {
    const s = settings()
    s.matchProbability = 0.99
    s.maxWeight = 5
    s.disagreementFloor.stable = -9
    s.defaultM.semi = 0.7
    s.featureM = { canvas: 0.6 }
    s.featureVolatility = { fonts: 'volatile' }
    const result = applyIdentitySettings({ ...defaultModel(), m: { canvas: 0.9, fonts: 0.99 } }, s)
    assert.equal(result.matchProbability, 0.99)
    assert.equal(result.maxWeight, 5)
    assert.deepEqual(result.disagreementFloor, { stable: -9, semi: -3, volatile: -1.5 })
    assert.equal(result.defaultM.semi, 0.7)
    assert.deepEqual(
      result.m,
      { canvas: 0.6, fonts: 0.99 },
      'the setting wins where both speak, the model stays elsewhere',
    )
    assert.deepEqual(result.volatility, { fonts: 'volatile' })
  })

  it('changes the provisional scale only while the model is not calibrated', () => {
    const s = settings()
    s.scale = 0.5
    s.offset = -1
    assert.deepEqual(applyIdentitySettings(defaultModel(), s).platt, { a: 0.5, b: -1 })
    const calibrated = { ...defaultModel(), calibrated: true, platt: { a: 0.3, b: 0.2 } }
    assert.deepEqual(applyIdentitySettings(calibrated, s).platt, { a: 0.3, b: 0.2 })
  })

  it('does not change the model it is given', () => {
    const model = defaultModel()
    const s = settings()
    s.featureM = { canvas: 0.5 }
    s.defaultM.stable = 0.5
    applyIdentitySettings(model, s)
    assert.deepEqual(model, defaultModel())
  })
})

describe('ModelCatalog', () => {
  const withFolder = (run: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-catalog-'))
    try {
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('uses the base model for a tenant without a model file', () => {
    assert.deepEqual(new ModelCatalog().modelFor(settings()), defaultModel())
    const base = { ...defaultModel(), matchProbability: 0.9 }
    assert.equal(new ModelCatalog(base).modelFor(settings()).matchProbability, 0.9)
  })

  it('reads the model file of a tenant', () => {
    withFolder((dir) => {
      const file = path.join(dir, 'model.json')
      writeFileSync(file, JSON.stringify({ version: 1, calibrated: true, matchProbability: 0.6 }))
      const s = settings()
      s.modelFile = file
      const model = new ModelCatalog().modelFor(s)
      assert.equal(model.calibrated, true)
      assert.equal(model.matchProbability, 0.6)
    })
  })

  it('reads a model file again when it changes, and not before', () => {
    withFolder((dir) => {
      const file = path.join(dir, 'model.json')
      writeFileSync(file, JSON.stringify({ version: 1, matchProbability: 0.6 }))
      const s = settings()
      s.modelFile = file
      const catalog = new ModelCatalog()
      assert.equal(catalog.modelFor(s).matchProbability, 0.6)
      writeFileSync(file, JSON.stringify({ version: 1, matchProbability: 0.7 }))
      utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
      assert.equal(catalog.modelFor(s).matchProbability, 0.7)
    })
  })

  it('fails with a clear message for a missing or wrong file, which preload finds at start', () => {
    withFolder((dir) => {
      const s = settings()
      s.modelFile = path.join(dir, 'missing.json')
      assert.throws(() => new ModelCatalog().modelFor(s), /ENOENT/)
      const wrong = path.join(dir, 'wrong.json')
      writeFileSync(wrong, JSON.stringify({ version: 1, m: { canvas: 7 } }))
      s.modelFile = wrong
      assert.throws(() => new ModelCatalog().preload([s]), /Model:/)
    })
  })
})
