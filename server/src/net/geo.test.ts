import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CompositeIntel, GeoProvider, parseCountryCsv } from './geo'
import { CidrListProvider, parseCidrList } from './ip_intel'
import { parseZoneTab, zoneFitsCountry } from './timezones'

describe('geolocation file', () => {
  const csv = [
    'ip_start,ip_end,country',
    '"1.0.0.0","1.0.0.255","AU"',
    '1.0.1.0,1.0.3.255,CN',
    '2001:db8::/32,br',
    '203.0.113.0/24,ZZ',
  ].join('\n')

  it('finds the country of an address in either layout, and says nothing about the rest', () => {
    const table = parseCountryCsv(csv)
    assert.equal(table.lookup('1.0.0.7'), 'AU')
    assert.equal(table.lookup('1.0.0.255'), 'AU', 'the last address of a range is inside it')
    assert.equal(table.lookup('1.0.1.0'), 'CN', 'the first address of the next range is inside it')
    assert.equal(table.lookup('1.0.2.9'), 'CN')
    assert.equal(table.lookup('1.0.4.0'), undefined, 'just after the last range')
    assert.equal(table.lookup('0.255.255.255'), undefined, 'just before the first range')
    assert.equal(table.lookup('2001:db8:ffff::1'), 'BR', 'country codes are upper-cased')
    assert.equal(table.lookup('203.0.113.4'), undefined, 'ZZ means unknown')
    assert.equal(table.lookup('not an ip'), undefined)
  })

  it('refuses a bad line, with its number, and overlapping ranges', () => {
    assert.throws(() => parseCountryCsv('1.0.0.0,1.0.0.255,AU\nbroken line here'), /line 2/)
    assert.throws(() => parseCountryCsv('1.0.0.0,1.0.0.255,AUS'), /line 1/)
    assert.throws(() => parseCountryCsv('1.0.0.255,1.0.0.0,AU\n'), /line 1/)
    assert.throws(() => parseCountryCsv('1.0.0.0,1.0.0.255,AU\n1.0.0.200,1.0.1.9,CN'), /overlap at 1\.0\.0\.200/)
  })

  it('puts the country next to the tags of the lists', () => {
    const { cidrs } = parseCidrList('1.0.0.0/24')
    const intel = new CompositeIntel([
      new CidrListProvider([{ tag: 'datacenter', cidrs }]),
      new GeoProvider(parseCountryCsv(csv)),
    ])
    assert.deepEqual(intel.lookup('1.0.0.7'), { tags: ['datacenter'], country: 'AU' })
    assert.deepEqual(intel.lookup('1.0.1.7'), { tags: [], country: 'CN' })
    assert.deepEqual(intel.lookup('9.9.9.9'), { tags: [] })
  })
})

describe('time zones against countries', () => {
  const table = parseZoneTab(
    [
      '# a comment',
      'BR\t-2332-04637\tAmerica/Sao_Paulo\tSoutheast',
      'PT\t+3843-00908\tEurope/Lisbon',
      'US\t+404251-0740023\tAmerica/New_York',
      '',
    ].join('\n'),
  )

  it('says yes, no or cannot tell', () => {
    assert.equal(zoneFitsCountry(table, 'America/Sao_Paulo', 'BR'), true)
    assert.equal(zoneFitsCountry(table, 'America/Sao_Paulo', 'br'), true)
    assert.equal(zoneFitsCountry(table, 'America/Sao_Paulo', 'PT'), false)
    assert.equal(zoneFitsCountry(table, 'Asia/Calcutta', 'IN'), undefined, 'an alias that is not in the table')
    assert.equal(zoneFitsCountry(table, undefined, 'BR'), undefined)
    assert.equal(zoneFitsCountry(table, 'America/Sao_Paulo', undefined), undefined)
  })

  it('refuses a file that is not a zone table', () => {
    assert.throws(() => parseZoneTab('# only a comment\n'), /no zones/)
    assert.throws(() => parseZoneTab('this is not\ta table'), /not "country/)
  })
})
