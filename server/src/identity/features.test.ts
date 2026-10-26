import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  extractFeatures,
  FeatureInput,
  featureNames,
  gpuFamilyOf,
  isIdentifier,
  ja4Normalized,
  volatilityOf,
} from './features'

const sig = (value: unknown) => ({ value, duration: 1 })

function visit(overrides: Partial<FeatureInput> = {}): FeatureInput {
  return {
    components: {
      canvas: sig({ winding: true, geometry: 'data:geometry', text: 'data:text' }),
      webGlBasics: sig({
        rendererUnmasked: 'ANGLE (Apple M1)',
        vendorUnmasked: 'Google Inc. (Apple)',
        renderer: 'x',
        vendor: 'y',
      }),
      webGlExtensions: sig({
        parameters: ['a'],
        shaderPrecisions: ['b'],
        extensions: ['c'],
        extensionParameters: ['d'],
      }),
      audio: sig(124.04),
      fonts: sig(['Arial', 'Menlo']),
      screenResolution: sig([1440, 900]),
      timezone: sig('America/Sao_Paulo'),
      platform: sig('MacIntel'),
      userAgentData: sig({
        brands: ['Google Chrome'],
        mobile: false,
        platform: 'macOS',
        platformVersion: '15.0.0',
        architecture: 'arm',
      }),
    },
    extended: {
      speechVoices: sig([
        { name: 'Daniel', lang: 'en-GB', local: true, default: true },
        { name: 'Google US English', lang: 'en-US', local: false, default: false },
      ]),
      storageQuota: sig(10737418240),
    },
    network: {
      ip: '203.0.113.7',
      ipPrefix: '203.0.113.0/24',
      ja4: 't13d1517h2_8daaf6152771_cb7bf5808d99',
      ja4r: 't13d1517h2_002f,0035_0005,000a,0015,0029,002b_0403,0804',
      headerFp: 'hfp',
      headerNames: ['host', 'user-agent', 'accept', 'accept-language', 'sec-ch-ua', 'content-type', 'origin'],
      http2Fp: 'h2fp',
      viaProxy: false,
    },
    ...overrides,
  }
}

describe('the stored code', () => {
  const withCode = (token: unknown): FeatureInput => {
    const base = visit()
    return { ...base, extended: { ...base.extended, storedId: sig({ token, foundIn: ['cookie'], created: false }) } }
  }
  const GOOD = 'AbCdEfGhIjKlMnOpQrStUv'

  it('becomes a feature made of a digest, never the code itself', () => {
    const features = extractFeatures(withCode(GOOD))
    assert.match(features.storedId, /^[0-9a-f]{12}$/)
    assert.ok(!Object.values(features).includes(GOOD))
    assert.equal(features.storedId, extractFeatures(withCode(GOOD)).storedId, 'the same code, the same feature')
    assert.notEqual(features.storedId, extractFeatures(withCode('ZyXwVuTsRqPoNmLkJiHgFe')).storedId)
  })

  it('is absent when there is no code, or what came is not a code', () => {
    assert.ok(!('storedId' in extractFeatures(visit())))
    for (const bad of [null, undefined, '', 'short', 'has space in it xxxxxxxx', 'x'.repeat(65), 42, ['a'], { a: 1 }]) {
      assert.ok(!('storedId' in extractFeatures(withCode(bad))), String(bad))
    }
  })

  it('is the only feature that is a code made up for one device, and it is one that changes with the site data', () => {
    assert.deepEqual(featureNames.filter(isIdentifier), ['storedId'])
    assert.equal(volatilityOf('storedId'), 'volatile')
  })
})

describe('extractFeatures', () => {
  it('reads the features a visit provides', () => {
    const features = extractFeatures(visit())
    for (const name of [
      'canvas',
      'webglRenderer',
      'fonts',
      'screenResolution',
      'platform',
      'userAgentPlatform',
      'tlsCiphers',
      'ip',
      'headerCore',
      'storageQuota',
    ]) {
      assert.ok(name in features, name)
    }
    assert.equal(features.tlsCiphers, '8daaf6152771')
    assert.equal(features.tlsVersionAlpn, '13h2')
    assert.equal(features.storageQuota, '33') // log2(10 GiB) = 33.3
  })

  it('is the same for the same visit and different for a different value', () => {
    assert.deepEqual(extractFeatures(visit()), extractFeatures(visit()))
    const other = visit()
    other.components.fonts = sig(['Arial'])
    assert.notEqual(extractFeatures(other).fonts, extractFeatures(visit()).fonts)
  })

  it('leaves out what could not be read, instead of inventing a value', () => {
    const broken = visit()
    broken.components.canvas = { error: { name: 'Error', message: 'x' }, duration: 1 }
    broken.components.audio = sig(-4) // the library's marker for "audio skipped"
    broken.components.fonts = { duration: 1 } // undefined
    const features = extractFeatures(broken)
    assert.ok(!('canvas' in features) && !('audio' in features) && !('fonts' in features))
  })

  it('treats the markers of a browser that hides the canvas as absent, not as a shared value', () => {
    for (const marker of ['skipped', 'unsupported', 'unstable']) {
      const hidden = visit()
      hidden.components.canvas = sig({ winding: false, geometry: marker, text: marker })
      assert.ok(!('canvas' in extractFeatures(hidden)), marker)
    }
  })

  it('does not use the order of the headers or the HTTP/2 data when a proxy is in front', () => {
    const proxied = visit()
    proxied.network.viaProxy = true
    const features = extractFeatures(proxied)
    assert.ok(!('headerCore' in features) && !('http2' in features))
    assert.ok('tlsCiphers' in features, 'the other signals stay')
  })

  it('never reads the retired headerOrder, but keeps its name valid for saved settings', () => {
    assert.ok(featureNames.includes('headerOrder'))
    assert.ok(!('headerOrder' in extractFeatures(visit())))
  })

  it('keeps headerCore when the browser adds optional headers, and changes it when the core order changes', () => {
    const base = extractFeatures(visit()).headerCore
    assert.ok(base)
    const withCache = visit()
    withCache.network.headerNames = [
      'host',
      'cache-control',
      'pragma',
      'user-agent',
      'if-none-match',
      'accept',
      'accept-language',
      'sec-ch-ua',
      'priority',
      'content-type',
      'origin',
    ]
    assert.equal(extractFeatures(withCache).headerCore, base)
    const swapped = visit()
    swapped.network.headerNames = [
      'host',
      'accept',
      'user-agent',
      'accept-language',
      'sec-ch-ua',
      'content-type',
      'origin',
    ]
    assert.notEqual(extractFeatures(swapped).headerCore, base)
  })

  it('has no headerCore for an event whose header names were not kept', () => {
    const old = visit()
    delete old.network.headerNames
    assert.ok(!('headerCore' in extractFeatures(old)))
  })

  it('uses only the local voices, since network voices come and go', () => {
    const withNetworkVoice = visit()
    const without = visit()
    without.extended.speechVoices = sig([{ name: 'Daniel', lang: 'en-GB', local: true, default: false }])
    assert.equal(extractFeatures(withNetworkVoice).speechVoices, extractFeatures(without).speechVoices)
    const none = visit()
    none.extended.speechVoices = sig([{ name: 'Google', lang: 'en', local: false, default: false }])
    assert.ok(!('speechVoices' in extractFeatures(none)))
  })

  it('groups the storage quota so that small drifts do not change it', () => {
    const a = visit()
    const b = visit()
    b.extended.storageQuota = sig(10737418240 - 50_000_000)
    assert.equal(extractFeatures(a).storageQuota, extractFeatures(b).storageQuota)
  })

  it('does not fail on an empty visit', () => {
    const features = extractFeatures({ components: {}, extended: {}, network: { viaProxy: true } })
    assert.deepEqual(features, { preferences: features.preferences })
  })

  it('knows the volatility of every feature, and treats an unknown one as volatile', () => {
    for (const name of featureNames) {
      assert.ok(['stable', 'semi', 'volatile'].includes(volatilityOf(name)), name)
    }
    assert.equal(volatilityOf('nonexistent'), 'volatile')
    assert.equal(volatilityOf('webglRenderer'), 'stable')
    assert.equal(volatilityOf('ip'), 'volatile')
  })
})

describe('ja4Normalized', () => {
  it('is the same with and without the extensions of a resumed session and of padding', () => {
    const fresh = 't13d1517h2_002f,0035_0005,000a,002b_0403,0804'
    const resumed = 't13d1518h2_002f,0035_0005,000a,0029,002b_0403,0804'
    const padded = 't13d1518h2_002f,0035_0005,000a,0015,002b_0403,0804'
    assert.equal(ja4Normalized(fresh), ja4Normalized(resumed))
    assert.equal(ja4Normalized(fresh), ja4Normalized(padded))
  })

  it('still tells browsers apart', () => {
    assert.notEqual(ja4Normalized('t13d1517h2_x_0005,000a_0403'), ja4Normalized('t13d1517h2_x_0005,000b_0403'))
    assert.notEqual(ja4Normalized('t13d1517h2_x_0005,000a_0403'), ja4Normalized('t13d1517h2_x_0005,000a_0804'))
  })

  it('handles missing or odd input', () => {
    assert.equal(ja4Normalized(undefined), undefined)
    assert.equal(ja4Normalized(''), undefined)
    assert.equal(ja4Normalized('only_two'), undefined)
  })
})

describe('gpuFamilyOf', () => {
  it('gives the same family for what each browser says about the same card', () => {
    assert.equal(gpuFamilyOf('ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)'), 'intel')
    assert.equal(gpuFamilyOf('Intel(R) HD Graphics 400, or similar'), 'intel')
    assert.equal(gpuFamilyOf('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), 'apple')
    assert.equal(gpuFamilyOf('Apple GPU'), 'apple')
    assert.equal(gpuFamilyOf('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'nvidia')
    assert.equal(gpuFamilyOf('ANGLE (AMD, AMD Radeon Pro 560X OpenGL Engine, OpenGL 4.1)'), 'amd')
    assert.equal(gpuFamilyOf('Adreno (TM) 640'), 'qualcomm')
    assert.equal(gpuFamilyOf('Mali-G78'), 'arm')
  })

  it('keeps software drawing apart from a real card, and does not invent a family', () => {
    assert.equal(
      gpuFamilyOf('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'),
      'software',
    )
    assert.equal(gpuFamilyOf('Something Unknown'), 'other')
  })
})

describe('browserFamily and gpuFamily as features', () => {
  it('reads the browser family from the user agent header, and is absent without one', () => {
    const firefox = visit()
    firefox.network.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
    assert.equal(extractFeatures(firefox).browserFamily, 'firefox')
    const none = visit()
    delete none.network.userAgent
    assert.ok(!('browserFamily' in extractFeatures(none)), 'no header is not the family "other"')
  })

  it('reads the family of the card from WebGL, in either browser wording', () => {
    const masked = visit()
    masked.components.webGlBasics = sig({ renderer: 'Intel(R) HD Graphics 400, or similar', rendererUnmasked: '' })
    const unmasked = visit()
    unmasked.components.webGlBasics = sig({
      renderer: 'ANGLE (Intel Inc.)',
      rendererUnmasked: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)',
    })
    assert.equal(extractFeatures(masked).gpuFamily, extractFeatures(unmasked).gpuFamily)
    assert.notEqual(extractFeatures(masked).webglRenderer, extractFeatures(unmasked).webglRenderer)
  })
})
