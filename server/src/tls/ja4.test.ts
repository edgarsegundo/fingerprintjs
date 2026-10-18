import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseClientHello } from './client_hello'
import { alpnMarker, computeJa4, isGrease } from './ja4'
import {
  alpnExtension,
  buildClientHello,
  ecPointFormatsExtension,
  ja4SpecExample,
  signatureAlgorithmsExtension,
  sniExtension,
  supportedVersionsExtension,
} from './testing'

function ja4Of(spec: Parameters<typeof buildClientHello>[0]) {
  const parsed = parseClientHello(buildClientHello(spec))
  assert.equal(parsed.status, 'ok')
  return computeJa4(parsed.status === 'ok' ? parsed.hello : (undefined as never))
}

describe('JA4', () => {
  it('matches the example of the specification', () => {
    const result = ja4Of(ja4SpecExample())
    assert.equal(result.ja4, 't13d1516h2_8daaf6152771_e5627efa2ab1')
    assert.equal(result.version, '13')
    assert.equal(result.sni, true)
    assert.equal(result.alpn, 'h2')
  })

  it('matches the specification variant without signature algorithms', () => {
    // The extension 0x000d stays in the list that is hashed; only the "_" suffix with the algorithms goes away.
    // The specification gives 6d807ffa2a79 for the extension string alone.
    const spec = ja4SpecExample()
    const withoutAlgorithms = {
      ...spec,
      extensions: (spec.extensions ?? []).map((extension) =>
        extension.type === 0x000d ? signatureAlgorithmsExtension([]) : extension,
      ),
    }
    assert.equal(ja4Of(withoutAlgorithms).ja4, 't13d1516h2_8daaf6152771_6d807ffa2a79')
  })

  it('ignores GREASE everywhere', () => {
    const spec = ja4SpecExample()
    const plain = ja4Of(spec)
    const greased = ja4Of({
      ...spec,
      ciphers: [0x0a0a, ...spec.ciphers, 0xfafa],
      extensions: [
        { type: 0x1a1a },
        ...(spec.extensions ?? []).map((extension) =>
          extension.type === 0x002b
            ? supportedVersionsExtension([0x2a2a, 0x0304, 0x0303])
            : extension.type === 0x000d
            ? signatureAlgorithmsExtension([0x3a3a, 0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601])
            : extension,
        ),
        { type: 0xeaea },
      ],
    })
    assert.equal(greased.ja4, plain.ja4)
  })

  it('does not depend on the order of ciphers and extensions, only on the signature algorithm order', () => {
    const spec = ja4SpecExample()
    const shuffled = ja4Of({
      ...spec,
      ciphers: [...spec.ciphers].reverse(),
      extensions: [...(spec.extensions ?? [])].reverse(),
    })
    assert.equal(shuffled.ja4, ja4Of(spec).ja4)
    const reorderedSignatures = ja4Of({
      ...spec,
      extensions: (spec.extensions ?? []).map((extension) =>
        extension.type === 0x000d
          ? signatureAlgorithmsExtension([0x0601, 0x0806, 0x0501, 0x0805, 0x0503, 0x0401, 0x0804, 0x0403])
          : extension,
      ),
    })
    assert.notEqual(reorderedSignatures.ja4.split('_')[2], ja4Of(spec).ja4.split('_')[2])
  })

  it('keeps the destination and the ALPN choice out of the hashes', () => {
    const base = ja4SpecExample()
    const other = ja4Of({
      ...base,
      extensions: (base.extensions ?? []).map((extension) =>
        extension.type === 0x0000
          ? sniExtension('another.example.org')
          : extension.type === 0x0010
          ? alpnExtension([Buffer.from('http/1.1')])
          : extension,
      ),
    })
    const original = ja4Of(base).ja4.split('_')
    const changed = other.ja4.split('_')
    assert.equal(changed[1], original[1])
    assert.equal(changed[2], original[2])
    assert.equal(changed[0], 't13d1516h1') // first and last character of "http/1.1"
  })

  it('marks a hello without SNI with i and falls back to the hello version without supported_versions', () => {
    const result = ja4Of({ legacyVersion: 0x0303, ciphers: [0xc02b], extensions: [ecPointFormatsExtension([0])] })
    assert.equal(result.ja4.split('_')[0], 't12i010100')
    assert.equal(result.sni, false)
    assert.equal(result.alpn, undefined)
  })

  it('prints zeros for empty cipher and extension lists', () => {
    const noExtensions = ja4Of({ ciphers: [] })
    assert.equal(noExtensions.ja4, 't12i000000_000000000000_000000000000')
    const onlyExcluded = ja4Of({ ciphers: [0x002f], extensions: [sniExtension('a.example')] })
    assert.equal(onlyExcluded.ja4.split('_')[2], '000000000000')
  })

  it('caps the counts at 99', () => {
    const ciphers = Array.from({ length: 120 }, (_, index) => 0x1000 + index)
    const extensions = Array.from({ length: 105 }, (_, index) => ({ type: 0x2000 + index }))
    assert.equal(ja4Of({ ciphers, extensions }).ja4.split('_')[0], 't12i999900')
  })

  it('exposes the unhashed form', () => {
    const { ja4_r } = ja4Of(ja4SpecExample())
    assert.ok(
      ja4_r.startsWith(
        't13d1516h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9_0005,000a,000b',
      ),
    )
    assert.ok(ja4_r.endsWith('_0403,0804,0401,0503,0805,0501,0806,0601'))
  })
})

describe('alpnMarker', () => {
  it('follows every example of the specification', () => {
    const cases: Array<[number[], string]> = [
      [[0xab], 'ab'],
      [[0x20], '20'],
      [[0xab, 0xcd], 'ad'],
      [[0x20, 0x61], '21'],
      [[0x30, 0xab], '3b'],
      [[0x61, 0x20], '60'],
      [[0x30, 0x31, 0xab, 0xcd], '3d'],
      [[0x30, 0xab, 0xcd, 0x31], '01'],
    ]
    for (const [bytes, expected] of cases) {
      assert.equal(alpnMarker(Buffer.from(bytes)), expected, Buffer.from(bytes).toString('hex'))
    }
  })

  it('uses 00 when there is no protocol and doubles a single letter', () => {
    assert.equal(alpnMarker(undefined), '00')
    assert.equal(alpnMarker(Buffer.alloc(0)), '00')
    assert.equal(alpnMarker(Buffer.from('h')), 'hh')
    assert.equal(alpnMarker(Buffer.from('h2')), 'h2')
    assert.equal(alpnMarker(Buffer.from('http/1.1')), 'h1')
  })
})

describe('isGrease', () => {
  it('recognizes exactly the 16 GREASE values', () => {
    const grease = Array.from({ length: 16 }, (_, index) => ((index << 4) | 0x0a) * 0x101)
    assert.ok(grease.every(isGrease))
    assert.ok(![0x0a0b, 0x0a1a, 0x1301, 0x0000, 0xffff].some(isGrease))
  })
})
