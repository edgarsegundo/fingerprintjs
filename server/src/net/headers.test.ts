import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { coreHeaderFp, headerSignals } from './headers'

const chromeLike = [
  'Host',
  'example.com',
  'Connection',
  'keep-alive',
  'sec-ch-ua',
  '"Chromium";v="155"',
  'User-Agent',
  'Mozilla/5.0',
  'Accept-Language',
  'pt-BR,pt;q=0.9',
  'Cookie',
  'secret=1',
  'Authorization',
  'Bearer x',
]

describe('headerSignals', () => {
  it('keeps the order and records how each name was written', () => {
    const result = headerSignals(chromeLike)
    assert.deepEqual(result.order, [
      'host',
      'connection',
      'sec-ch-ua',
      'user-agent',
      'accept-language',
      'cookie',
      'authorization',
    ])
    assert.equal(result.casing, 'TTlTTTT')
  })

  it('stores only the allowed header values, never cookies or credentials', () => {
    const { values } = headerSignals(chromeLike)
    assert.deepEqual(Object.keys(values).sort(), ['accept-language', 'sec-ch-ua', 'user-agent'])
    assert.ok(!JSON.stringify(values).includes('secret'))
    assert.ok(!JSON.stringify(values).includes('Bearer'))
  })

  it('leaves out headers added by proxies and the HTTP/2 pseudo-headers', () => {
    const result = headerSignals([
      ':method',
      'GET',
      'X-Forwarded-For',
      '1.2.3.4',
      'cf-ray',
      'abc',
      'Via',
      '1.1 proxy',
      'user-agent',
      'x',
    ])
    assert.deepEqual(result.order, ['user-agent'])
  })

  it('gives the same fingerprint for the same client and a different one when the order changes', () => {
    const swapped = [...chromeLike.slice(2, 4), ...chromeLike.slice(0, 2), ...chromeLike.slice(4)]
    assert.equal(headerSignals(chromeLike).fp, headerSignals([...chromeLike]).fp)
    assert.notEqual(headerSignals(chromeLike).fp, headerSignals(swapped).fp)
  })

  it('tells apart the same order written with a different casing', () => {
    assert.notEqual(
      headerSignals(['Host', 'a', 'User-Agent', 'b']).fp,
      headerSignals(['host', 'a', 'user-agent', 'b']).fp,
    )
  })

  it('limits the length of a stored value and joins repeated headers', () => {
    const result = headerSignals(['accept', 'x'.repeat(2000), 'accept', 'y'])
    assert.equal(result.values.accept.length, 512 + 2 + 1)
  })

  it('copes with an empty list and an odd trailing element', () => {
    assert.deepEqual(headerSignals([]).order, [])
    assert.deepEqual(headerSignals(['host']).order, [])
  })
})

describe('coreHeaderFp', () => {
  const core = ['user-agent', 'accept', 'accept-language', 'sec-ch-ua', 'content-type', 'origin']

  it('ignores optional headers and where they appear', () => {
    const noisy = [
      'host',
      'cache-control',
      'user-agent',
      'pragma',
      'accept',
      'if-none-match',
      'accept-language',
      'priority',
      'sec-ch-ua',
      'content-type',
      'origin',
    ]
    assert.equal(coreHeaderFp(noisy), coreHeaderFp(core))
  })

  it('is the same for HTTP/1.1 (Title-Case) and HTTP/2 (lower case) of the same browser', () => {
    const h1 = headerSignals(['Host', 'a', 'User-Agent', 'b', 'Accept', 'c', 'Content-Type', 'd', 'Origin', 'e'])
    const h2 = headerSignals(['user-agent', 'b', 'accept', 'c', 'content-type', 'd', 'origin', 'e'])
    assert.notEqual(h1.fp, h2.fp, 'the old fingerprint was not stable here')
    assert.equal(coreHeaderFp(h1.order), coreHeaderFp(h2.order))
  })

  it('changes when the order of the core headers changes, and tells two engines apart', () => {
    assert.notEqual(coreHeaderFp(core), coreHeaderFp(['accept', 'user-agent', ...core.slice(2)]))
    assert.notEqual(coreHeaderFp(core), coreHeaderFp(core.filter((name) => name !== 'sec-ch-ua')))
  })

  it('has no value when no core header is present', () => {
    assert.equal(coreHeaderFp(['host', 'cookie']), undefined)
    assert.equal(coreHeaderFp([]), undefined)
  })
})
