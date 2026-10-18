import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Cidr, cidrContains, formatIp, ipPrefix, isInAny, normalizeIp, parseCidr, parseIp, RangeSet } from './cidr'

function cidr(text: string): Cidr {
  const parsed = parseCidr(text)
  assert.ok(parsed, `${text} should parse`)
  return parsed
}

describe('parseIp', () => {
  it('parses IPv4 and IPv6', () => {
    assert.deepEqual(parseIp('1.2.3.4'), { family: 4, value: 0x01020304n })
    assert.deepEqual(parseIp('::1'), { family: 6, value: 1n })
    assert.deepEqual(parseIp('::'), { family: 6, value: 0n })
    assert.equal(parseIp('2001:db8::ff00:42:8329')?.family, 6)
  })

  it('turns an IPv4-mapped IPv6 address into IPv4', () => {
    assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4')
    assert.equal(normalizeIp('::ffff:0102:0304'), '1.2.3.4')
  })

  it('removes the zone id', () => {
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0:0:0:0:0:0:1')
  })

  it('rejects things that are not addresses', () => {
    for (const bad of ['', 'abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.4/8', '1:2:3', ':::', '1::2::3', 'g::1']) {
      assert.equal(parseIp(bad), undefined, bad)
    }
  })

  it('round-trips through formatIp', () => {
    assert.equal(normalizeIp('2001:DB8::1'), '2001:db8:0:0:0:0:0:1')
    assert.equal(formatIp(parseIp('10.0.0.255') as never), '10.0.0.255')
  })
})

describe('parseCidr and cidrContains', () => {
  it('matches addresses inside the range only', () => {
    const range = cidr('10.0.0.0/8')
    assert.ok(cidrContains(range, parseIp('10.255.255.255') as never))
    assert.ok(!cidrContains(range, parseIp('11.0.0.0') as never))
    assert.ok(!cidrContains(range, parseIp('::1') as never))
  })

  it('clears the host bits of the base', () => {
    assert.deepEqual(cidr('10.1.2.3/8'), cidr('10.0.0.0/8'))
  })

  it('handles a single address, /0 and IPv6', () => {
    assert.ok(cidrContains(cidr('1.2.3.4'), parseIp('1.2.3.4') as never))
    assert.ok(!cidrContains(cidr('1.2.3.4'), parseIp('1.2.3.5') as never))
    assert.ok(cidrContains(cidr('0.0.0.0/0'), parseIp('203.0.113.9') as never))
    assert.ok(cidrContains(cidr('2001:db8::/32'), parseIp('2001:db8:ffff::1') as never))
    assert.ok(!cidrContains(cidr('2001:db8::/32'), parseIp('2001:db9::1') as never))
  })

  it('rejects invalid ranges', () => {
    for (const bad of ['10.0.0.0/33', '::/129', '10.0.0.0/-1', '10.0.0.0/8/8', 'x/8', '10.0.0.0/a']) {
      assert.equal(parseCidr(bad), undefined, bad)
    }
  })

  it('isInAny accepts the mapped form of an IPv4 address', () => {
    assert.ok(isInAny([cidr('10.0.0.0/8')], '::ffff:10.1.1.1'))
    assert.ok(!isInAny([cidr('10.0.0.0/8')], 'not an ip'))
  })
})

describe('ipPrefix', () => {
  it('uses /24 for IPv4 and /64 for IPv6', () => {
    assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24')
    assert.equal(ipPrefix('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64')
    assert.equal(ipPrefix('nope'), undefined)
  })

  it('gives the same prefix for the rotating part of an IPv6 address', () => {
    assert.equal(ipPrefix('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipPrefix('2001:db8:1:2:1:2:3:4'))
  })
})

describe('RangeSet', () => {
  const set = new RangeSet(['10.0.0.0/8', '10.1.0.0/16', '192.168.0.0/24', '2001:db8::/32', '8.8.8.8'].map(cidr))

  it('finds addresses in the list and only those', () => {
    for (const inside of ['10.0.0.1', '10.1.2.3', '192.168.0.200', '2001:db8::5', '8.8.8.8']) {
      assert.ok(set.has(inside), inside)
    }
    for (const outside of ['9.255.255.255', '11.0.0.0', '192.168.1.0', '2001:db9::1', '8.8.8.9', 'x', '::1']) {
      assert.ok(!set.has(outside), outside)
    }
  })

  it('merges overlapping and adjacent ranges', () => {
    const merged = new RangeSet(['10.0.0.0/25', '10.0.0.128/25', '10.0.0.0/24'].map(cidr))
    assert.ok(merged.has('10.0.0.0') && merged.has('10.0.0.255') && !merged.has('10.0.1.0'))
  })

  it('is empty-safe', () => {
    assert.ok(!new RangeSet([]).has('1.2.3.4'))
  })
})
