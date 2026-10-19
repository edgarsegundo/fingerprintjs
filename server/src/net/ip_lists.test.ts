import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { CidrListProvider, parseCidrList } from './ip_intel'
import {
  csvCells,
  parseAwsRanges,
  parseGcpRanges,
  parseList,
  parseRangeFile,
  parseTorExitList,
  rangeToCidrs,
  renderList,
} from './ip_lists'

const aws = {
  syncToken: '1',
  prefixes: [
    { ip_prefix: '3.5.140.0/22', region: 'ap-northeast-2', service: 'AMAZON' },
    { ip_prefix: '3.5.140.0/22', region: 'ap-northeast-2', service: 'EC2' },
    { ip_prefix: '52.95.0.0/16', region: 'us-east-1', service: 'S3' },
    { ip_prefix: 'not-a-range', service: 'EC2' },
  ],
  ipv6_prefixes: [{ ipv6_prefix: '2600:1f00::/24', region: 'us-east-1', service: 'EC2' }],
}

describe('public IP lists', () => {
  it('reads the AWS list once per range, with IPv6, and counts what it could not read', () => {
    const all = parseAwsRanges(aws)
    assert.deepEqual(all.ranges, ['3.5.140.0/22', '52.95.0.0/16', '2600:1f00::/24'])
    assert.equal(all.skipped, 1)
  })

  it('keeps only the services that were asked for', () => {
    assert.deepEqual(parseAwsRanges(aws, ['S3']).ranges, ['52.95.0.0/16'])
    assert.deepEqual(parseAwsRanges(aws, ['EC2']).ranges, ['3.5.140.0/22', '2600:1f00::/24'])
    assert.deepEqual(parseAwsRanges(aws, ['NOPE']).ranges, [])
  })

  it('reads the Google Cloud list, both families', () => {
    const parsed = parseGcpRanges({
      prefixes: [{ ipv4Prefix: '34.35.0.0/16', scope: 'x' }, { ipv6Prefix: '2600:1900::/35' }, { service: 'x' }],
    })
    assert.deepEqual(parsed.ranges, ['34.35.0.0/16', '2600:1900::/35'])
    assert.equal(parsed.skipped, 1)
  })

  it('reads the Tor exit list: one address per line, comments and blanks ignored', () => {
    const parsed = parseTorExitList('171.25.193.25\n\n# note\n80.67.167.81  # trailing\nnot an ip\n171.25.193.25\n')
    assert.deepEqual(parsed.ranges, ['171.25.193.25', '80.67.167.81'])
    assert.equal(parsed.skipped, 1)
  })

  it('refuses a document of the wrong shape instead of writing an empty list', () => {
    assert.throws(() => parseAwsRanges({ nothing: true }), /AWS/)
    assert.throws(() => parseGcpRanges([]), /Google/)
    assert.throws(() => parseList('aws', '<html>', []), /not JSON/)
  })

  it('writes a file that the provider reads back, and that labels the addresses', () => {
    const parsed = parseList('aws', JSON.stringify(aws))
    const text = renderList('aws', parsed, 'https://example.test/x', new Date('2026-01-02T03:04:05Z'))
    assert.ok(text.startsWith('# aws ranges, fetched 2026-01-02T03:04:05.000Z from https://example.test/x'))
    const { cidrs, invalid } = parseCidrList(text)
    assert.deepEqual(invalid, [])
    const provider = new CidrListProvider([{ tag: 'datacenter', cidrs }])
    assert.deepEqual(provider.lookup('3.5.141.7').tags, ['datacenter'])
    assert.deepEqual(provider.lookup('2600:1f00::1').tags, ['datacenter'])
    assert.deepEqual(provider.lookup('203.0.113.9').tags, [])
  })
})

describe('lists of ranges with columns', () => {
  it('reads cells with quotes, commas inside quotes and doubled quotes', () => {
    assert.deepEqual(csvCells('"16777216","16777471","-"'), ['16777216', '16777471', '-'])
    assert.deepEqual(csvCells('a, b ,"c,d","e""f",'), ['a', 'b', 'c,d', 'e"f', ''])
  })

  it('covers a range with blocks that hold exactly its addresses, no more and no fewer', () => {
    const covered = (from: bigint, to: bigint) =>
      rangeToCidrs(4, from, to).map((cidr) => [cidr.base, cidr.base + (1n << BigInt(32 - cidr.bits)) - 1n])
    for (const [from, to] of [
      [0n, 0n],
      [5n, 5n],
      [1n, 6n],
      [16777216n, 16777471n],
      [3n, 1000n],
      [0n, 0xffffffffn],
      [0xfffffff0n, 0xffffffffn],
    ] as Array<[bigint, bigint]>) {
      const blocks = covered(from, to)
      assert.equal(blocks[0][0], from)
      assert.equal(blocks[blocks.length - 1][1], to)
      for (let i = 1; i < blocks.length; i++) {
        assert.equal(blocks[i][0], blocks[i - 1][1] + 1n, 'no gap and no overlap')
      }
    }
    assert.equal(rangeToCidrs(4, 16777216n, 16777471n).length, 1, 'an aligned block is one block')
    assert.deepEqual(rangeToCidrs(4, 6n, 5n), [], 'an empty range is nothing')
    assert.equal(rangeToCidrs(6, 0n, (1n << 128n) - 1n)[0].bits, 0)
  })

  const numeric = { from: 0, to: 1, numeric: true }

  it('reads numbers as IPv4 and large numbers as IPv6, skipping the header and counting what is not a range', () => {
    const text = [
      '"ip_from","ip_to","type"',
      '"16777216","16777471","VPN"',
      '"3232235776","3232236031","TOR"',
      '"42540766411282592856903984951653826560","42540766490510755371168322545197776895","VPN"',
      '"5","3","VPN"',
    ].join('\n')
    const result = parseRangeFile(text, numeric)
    assert.deepEqual([result.rows, result.skipped], [5, 2], 'the header and the range that goes backwards')
    const provider = new CidrListProvider([{ tag: 'vpn', cidrs: result.cidrs }])
    assert.deepEqual(provider.lookup('1.0.0.77').tags, ['vpn'])
    assert.deepEqual(provider.lookup('192.168.1.1').tags, ['vpn'])
    assert.deepEqual(provider.lookup('2001:db8::1').tags, ['vpn'])
    assert.deepEqual(provider.lookup('1.0.1.0').tags, [], 'one past the end of the first range')
    assert.deepEqual(provider.lookup('0.255.255.255').tags, [], 'one before the start')
  })

  it('reads addresses written as text, and only the rows whose column has a wanted value', () => {
    const text = '1.0.0.0,1.0.0.255,vpn\n2.0.0.0,2.0.0.255,TOR\n3.0.0.0,3.0.0.255,Vpn\n'
    const result = parseRangeFile(text, { from: 0, to: 1, numeric: false, match: { column: 2, equals: ['VPN'] } })
    assert.equal(result.skipped, 0)
    const provider = new CidrListProvider([{ tag: 'vpn', cidrs: result.cidrs }])
    assert.deepEqual(
      ['1.0.0.9', '2.0.0.9', '3.0.0.9'].map((ip) => provider.lookup(ip).tags.length),
      [1, 0, 1],
    )
  })

  it('refuses a file whose columns are not the ones that were said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iplist-'))
    const file = join(dir, 'list.csv')
    writeFileSync(file, '"a","b"\n"16777216","16777471"\n"16777472","16777727"\n')
    assert.throws(
      () => CidrListProvider.fromFiles([{ tag: 'x', file, ranges: { from: 5, to: 6, numeric: true } }]),
      /not a range in columns 5 and 6/,
    )
    const ok = CidrListProvider.fromFiles([{ tag: 'x', file, ranges: numeric }])
    assert.deepEqual(ok.lookup('1.0.0.1').tags, ['x'])
  })
})
