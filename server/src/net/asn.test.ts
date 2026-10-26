import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAsnCsv } from './asn'

describe('network file', () => {
  const byRange = { from: 0, to: 1, asn: 2, name: 3 }

  it('finds the network of an address, with first and last address columns', () => {
    const table = parseAsnCsv(
      [
        'start,end,asn,name',
        '189.0.0.0,189.0.255.255,28573,"CLARO S.A."',
        '189.1.0.0,189.1.0.255,AS7738,Telemar',
        '2804:14c::,2804:14c:ffff:ffff:ffff:ffff:ffff:ffff,18881,"Vivo, Telefonica"',
        '10.0.0.0,10.0.0.255,0,',
      ].join('\n'),
      byRange,
    )
    assert.deepEqual(table.lookup('189.0.12.7'), { asn: 28573, name: 'CLARO S.A.' })
    assert.deepEqual(table.lookup('189.0.255.255'), { asn: 28573, name: 'CLARO S.A.' }, 'the last address is inside')
    assert.deepEqual(table.lookup('189.1.0.9'), { asn: 7738, name: 'Telemar' }, 'the "AS" prefix is accepted')
    assert.deepEqual(table.lookup('2804:14c:1::5'), { asn: 18881, name: 'Vivo, Telefonica' })
    assert.equal(table.lookup('189.2.0.0'), undefined)
    assert.equal(table.lookup('188.255.255.255'), undefined)
    assert.equal(table.lookup('10.0.0.5'), undefined, 'a range the file calls unknown is not a network')
    assert.equal(table.lookup('not an ip'), undefined)
  })

  it('reads a file with one CIDR column and only the name', () => {
    const table = parseAsnCsv('189.0.0.0/16,Operator A\n200.1.2.0/24,Operator B', { from: 0, name: 1 })
    assert.deepEqual(table.lookup('189.0.4.4'), { name: 'Operator A' })
    assert.deepEqual(table.lookup('200.1.2.200'), { name: 'Operator B' })
    assert.equal(table.size, 2)
  })

  it('cleans the name: no control characters, a short length', () => {
    const table = parseAsnCsv(`1.0.0.0/24,"A\u0007B\tC${'x'.repeat(500)}"`, { from: 0, name: 1 })
    const name = table.lookup('1.0.0.1')?.name ?? ''
    assert.ok(name.length <= 80)
    assert.ok(!/\p{Cc}/u.test(name))
  })

  it('refuses a wrong layout instead of finding nothing, and says the line', () => {
    assert.throws(() => parseAsnCsv('1.0.0.0,1.0.0.255,AU', { from: 0, to: 1 }), /at least one of the columns/)
    assert.throws(() => parseAsnCsv('1.0.0.0,1.0.0.255,x', byRange), /line 1.*not a network number/)
    assert.throws(() => parseAsnCsv('1.0.0.0,1.0.0.255', byRange), /line 1/)
    assert.throws(() => parseAsnCsv('1.0.0.0,1.0.0.255,1,A\nbroken', byRange), /line 2/)
    assert.throws(() => parseAsnCsv('1.0.0.255,1.0.0.0,1,A', byRange), /line 1.*first and last/)
    assert.throws(() => parseAsnCsv('1.0.0.0,2001:db8::,1,A', byRange), /line 1/)
    assert.throws(() => parseAsnCsv('1.0.0.0/24,A\nnot-a-range,Name', { from: 0, name: 1 }), /line 2.*not a range/)
  })

  it('refuses overlapping ranges', () => {
    assert.throws(() => parseAsnCsv('1.0.0.0,1.0.0.255,1,A\n1.0.0.200,1.0.1.9,2,B', byRange), /overlap at 1\.0\.0\.200/)
  })
})
