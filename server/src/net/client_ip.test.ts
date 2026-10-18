import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Cidr, parseCidr } from './cidr'
import { resolveClientIp } from './client_ip'

const trusted = ['10.0.0.0/8', 'fd00::/8'].map((text) => parseCidr(text) as Cidr)

describe('resolveClientIp', () => {
  it('uses the socket address when there is no proxy header', () => {
    assert.deepEqual(resolveClientIp('203.0.113.5', undefined, trusted), { ip: '203.0.113.5', source: 'socket' })
  })

  it('ignores the header when the connection is not from a trusted proxy (spoofing attempt)', () => {
    assert.deepEqual(resolveClientIp('203.0.113.5', '1.1.1.1', trusted), { ip: '203.0.113.5', source: 'socket' })
    assert.deepEqual(resolveClientIp('203.0.113.5', '1.1.1.1', []), { ip: '203.0.113.5', source: 'socket' })
  })

  it('reads the header from a trusted proxy', () => {
    assert.deepEqual(resolveClientIp('10.0.0.2', '198.51.100.9', trusted), {
      ip: '198.51.100.9',
      source: 'trusted_proxy',
    })
  })

  it('reads from the right, so an address forged by the visitor on the left is ignored', () => {
    // The visitor sent "6.6.6.6"; the first proxy appended the real address; the second proxy appended itself
    assert.deepEqual(resolveClientIp('10.0.0.2', '6.6.6.6, 198.51.100.9, 10.0.0.1', trusted), {
      ip: '198.51.100.9',
      source: 'trusted_proxy',
    })
  })

  it('falls back to the socket address on a malformed entry', () => {
    assert.deepEqual(resolveClientIp('10.0.0.2', '198.51.100.9, not-an-ip', trusted), {
      ip: '10.0.0.2',
      source: 'socket',
    })
  })

  it('returns the leftmost address when the whole chain is trusted', () => {
    assert.deepEqual(resolveClientIp('10.0.0.2', '10.0.0.7, 10.0.0.1', trusted), {
      ip: '10.0.0.7',
      source: 'trusted_proxy',
    })
  })

  it('understands IPv6 and the IPv4-mapped form', () => {
    assert.deepEqual(resolveClientIp('::ffff:10.0.0.2', '2001:db8::7', trusted), {
      ip: '2001:db8:0:0:0:0:0:7',
      source: 'trusted_proxy',
    })
  })

  it('has no answer without a valid socket address', () => {
    assert.equal(resolveClientIp(undefined, '1.1.1.1', trusted), undefined)
    assert.equal(resolveClientIp('garbage', undefined, trusted), undefined)
  })
})
