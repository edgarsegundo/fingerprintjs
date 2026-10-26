import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { browserHint, parseReport } from './report'

const valid = { v: 1, reason: 'script_unreachable', phase: 'script', probe: 'unreachable', elapsedMs: 8123.6 }

describe('parseReport', () => {
  it('accepts a report and keeps only the known fields', () => {
    const report = parseReport({
      ...valid,
      status: 403,
      online: true,
      connection: '4g',
      site: 'pk_abc123',
      url: 'https://app.example.com/profile?email=a@b.c',
      linkedId: 'user-1',
    })
    assert.deepEqual(report, {
      reason: 'script_unreachable',
      phase: 'script',
      probe: 'unreachable',
      elapsedMs: 8124,
      status: 403,
      online: true,
      connection: '4g',
      site: 'pk_abc123',
    })
  })

  it('does not refuse a report for a connection type it does not know, it drops the field', () => {
    assert.equal(parseReport({ ...valid, connection: '5g' })?.connection, undefined)
  })

  it('refuses what is not a report of version 1', () => {
    const bad: unknown[] = [
      null,
      'text',
      42,
      [],
      {},
      { ...valid, v: 2 },
      { ...valid, v: undefined },
      { ...valid, reason: 'dns' },
      { ...valid, reason: undefined },
      { ...valid, phase: 'later' },
      { ...valid, probe: 'maybe' },
      { ...valid, elapsedMs: -1 },
      { ...valid, elapsedMs: Number.NaN },
      { ...valid, elapsedMs: Number.POSITIVE_INFINITY },
      { ...valid, elapsedMs: 11 * 60 * 1000 },
      { ...valid, elapsedMs: '5' },
      { ...valid, status: 99 },
      { ...valid, status: 600 },
      { ...valid, status: 200.5 },
      { ...valid, status: '403' },
      { ...valid, online: 'yes' },
      { ...valid, site: 'sk_secret' },
      { ...valid, site: `pk_${'a'.repeat(500)}` },
      { ...valid, site: 7 },
    ]
    for (const input of bad) {
      assert.equal(parseReport(input), undefined, JSON.stringify(input))
    }
  })
})

describe('browserHint', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'chrome', false],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0', 'edge', false],
    ['Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/121.0', 'firefox', false],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1',
      'safari',
      true,
    ],
    ['Mozilla/5.0 (iPhone) AppleWebKit/605 CriOS/120.0 Mobile/15E148 Safari/604.1', 'chrome', true],
    [
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537 Chrome/120 Mobile Safari/537 SamsungBrowser/23.0',
      'samsung',
      true,
    ],
    ['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537 Chrome/120 Mobile Safari/537 OPR/80', 'opera', true],
    ['curl/8.0', 'other', false],
  ]
  for (const [ua, family, mobile] of cases) {
    it(`reads ${family}${mobile ? ' on a phone' : ''}`, () => {
      assert.deepEqual(browserHint(ua), { family, mobile })
    })
  }

  it('copes with a missing or enormous header', () => {
    assert.deepEqual(browserHint(undefined), { family: 'other', mobile: false })
    assert.deepEqual(browserHint('x'.repeat(100_000)), { family: 'other', mobile: false })
  })
})
