import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { requestContext } from './context'

const network = (overrides: { prefix?: string; ja4?: string; userAgent?: string } = {}) => ({
  ipPrefix: overrides.prefix ?? '203.0.113.0/24',
  tls:
    overrides.ja4 === undefined
      ? { ja4: 't13d1517h2_8daaf6152771_cb7bf5808d99', source: 'front' as const }
      : { ja4: overrides.ja4, source: 'front' as const },
  headers: { order: [], casing: '', fp: 'x', values: { 'user-agent': overrides.userAgent ?? 'Chrome/155' } },
})

describe('requestContext', () => {
  it('is the same for the same client', () => {
    assert.equal(requestContext(network()), requestContext(network()))
  })

  it('changes with the network, the TLS cipher list and the user agent, each on its own', () => {
    const base = requestContext(network())
    assert.notEqual(requestContext(network({ prefix: '198.51.100.0/24' })), base)
    assert.notEqual(requestContext(network({ ja4: 't13d1517h2_0d8feac7bc37_cb7bf5808d99' })), base)
    assert.notEqual(requestContext(network({ userAgent: 'curl/8' })), base)
  })

  it('does not change when the TLS session is resumed, which changes the extensions and their count', () => {
    assert.equal(requestContext(network({ ja4: 't13d1518h2_8daaf6152771_e2d80978ab2e' })), requestContext(network()))
  })

  it('works without TLS information (behind a proxy) and without a user agent', () => {
    const noTls = { ...network(), tls: undefined }
    assert.equal(requestContext(noTls), '203.0.113.0/24|-|Chrome/155')
    assert.equal(
      requestContext({ ...network(), headers: { order: [], casing: '', fp: 'x', values: {} } }).endsWith('|-'),
      true,
    )
  })
})
