import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CidrListProvider, parseCidrList } from './ip_intel'

describe('parseCidrList', () => {
  it('skips comments and blank lines and reports invalid lines', () => {
    const { cidrs, invalid } = parseCidrList('# header\n10.0.0.0/8 # private\n\n  \r\n2001:db8::/32\nbogus\n')
    assert.equal(cidrs.length, 2)
    assert.deepEqual(invalid, ['bogus'])
  })
})

describe('CidrListProvider', () => {
  const provider = new CidrListProvider([
    { tag: 'datacenter', cidrs: parseCidrList('34.0.0.0/8\n2001:db8::/32').cidrs },
    { tag: 'tor_exit', cidrs: parseCidrList('34.5.6.7').cidrs },
  ])

  it('returns the tags of every list that contains the address', () => {
    assert.deepEqual(provider.lookup('34.5.6.7').tags, ['datacenter', 'tor_exit'])
    assert.deepEqual(provider.lookup('34.9.9.9').tags, ['datacenter'])
    assert.deepEqual(provider.lookup('2001:db8::1').tags, ['datacenter'])
  })

  it('returns no tags for an ordinary address', () => {
    assert.deepEqual(provider.lookup('203.0.113.5').tags, [])
  })
})
