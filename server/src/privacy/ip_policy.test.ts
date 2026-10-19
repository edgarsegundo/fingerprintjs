import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { NetworkSignals } from '../net/signals'

import { ipHashKey, protectIp, protectNetwork } from './ip_policy'

const key = ipHashKey('a'.repeat(32))

const network = (ip: string, version: 4 | 6 = 4, prefix = '203.0.113.0/24'): NetworkSignals => ({
  ip,
  ipVersion: version,
  ipPrefix: prefix,
  ipSource: 'socket',
  ipIntel: { tags: ['datacenter'], country: 'BR' },
  viaProxy: false,
  httpVersion: '2.0',
  headers: { order: ['host'], casing: 'x', fp: 'abc', values: { 'user-agent': 'ua' } },
})

describe('protectIp', () => {
  it('keeps the address as it is, or cuts it to the network', () => {
    assert.equal(protectIp('203.0.113.77', 'full', key, 't1'), '203.0.113.77')
    assert.equal(protectIp('203.0.113.77', 'truncated', key, 't1'), '203.0.113.0')
    assert.equal(protectIp('203.0.113.255', 'truncated', key, 't1'), '203.0.113.0')
    assert.equal(protectIp('2001:db8:1:2:3:4:5:6', 'truncated', key, 't1'), '2001:db8:1:0:0:0:0:0')
    assert.equal(
      protectIp('::ffff:203.0.113.77', 'truncated', key, 't1'),
      '203.0.113.0',
      'a mapped IPv4 address is IPv4',
    )
    assert.equal(protectIp('not an address', 'truncated', key, 't1'), undefined)
    assert.equal(protectIp('203.0.113.77', 'none', key, 't1'), undefined)
  })

  it('hashes: stable, keyed, different for each tenant and each address, and never readable', () => {
    const hash = protectIp('203.0.113.77', 'hash', key, 't1') ?? ''
    assert.match(hash, /^h_[A-Za-z0-9_-]{22}$/)
    assert.equal(protectIp('203.0.113.77', 'hash', key, 't1'), hash)
    assert.notEqual(protectIp('203.0.113.78', 'hash', key, 't1'), hash)
    assert.notEqual(protectIp('203.0.113.77', 'hash', key, 't2'), hash)
    assert.notEqual(protectIp('203.0.113.77', 'hash', ipHashKey('b'.repeat(32)), 't1'), hash)
    assert.ok(!hash.includes('203'))
  })

  it('does not let a tenant name shift into the address', () => {
    // "t1\n" + "x" must not equal "t1" + "\nx": the separator cannot be part of a tenant id
    assert.notEqual(protectIp('1.1.1.1', 'hash', key, 'ab'), protectIp('1.1.1.1', 'hash', key, 'a'))
  })
})

describe('protectNetwork', () => {
  it('returns the same signals for full', () => {
    const original = network('203.0.113.77')
    assert.equal(protectNetwork(original, 'full', key, 't1'), original)
  })

  it('changes only the address and its network, keeping the labels and the rest', () => {
    const original = network('203.0.113.77')
    const copy = structuredClone(original)
    const truncated = protectNetwork(original, 'truncated', key, 't1')
    assert.deepEqual(truncated, { ...copy, ip: '203.0.113.0', ipPrefix: '203.0.113.0/24' })
    assert.deepEqual(original, copy, 'the original is not changed')
    const none = protectNetwork(original, 'none', key, 't1')
    assert.deepEqual(none, { ...copy, ip: '', ipPrefix: '' })
    const hash = protectNetwork(original, 'hash', key, 't1')
    assert.deepEqual({ ...hash, ip: '', ipPrefix: '' }, { ...copy, ip: '', ipPrefix: '' })
    assert.match(hash.ip, /^h_/)
    assert.match(hash.ipPrefix, /^hp_/)
  })

  it('cuts IPv6 to /48 and names the network that way', () => {
    const v6 = protectNetwork(network('2001:db8:1:2:3:4:5:6', 6, '2001:db8:1:2::/64'), 'truncated', key, 't1')
    assert.deepEqual([v6.ip, v6.ipPrefix], ['2001:db8:1:0:0:0:0:0', '2001:db8:1:0:0:0:0:0/48'])
  })

  it('gives two addresses of one network the same hash of the network, and two networks different ones', () => {
    const a = protectNetwork(network('203.0.113.1'), 'hash', key, 't1')
    const b = protectNetwork(network('203.0.113.2'), 'hash', key, 't1')
    const c = protectNetwork(network('198.51.100.1', 4, '198.51.100.0/24'), 'hash', key, 't1')
    assert.notEqual(a.ip, b.ip)
    assert.equal(a.ipPrefix, b.ipPrefix)
    assert.notEqual(a.ipPrefix, c.ipPrefix)
  })
})
