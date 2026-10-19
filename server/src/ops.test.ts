import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { summarizeEvent } from './ops'
import type { StoredEvent } from './store/types'

function event(ip: string, extra: Partial<StoredEvent['network']> = {}, linkedId?: string): StoredEvent {
  return {
    requestId: 'r1',
    tenantId: 't1',
    receivedAt: Date.UTC(2026, 9, 18, 12, 0, 0),
    network: {
      ip,
      ipVersion: 4,
      ipPrefix: '',
      ipSource: 'socket',
      ipIntel: { tags: [] },
      viaProxy: false,
      httpVersion: '2.0',
      headers: { order: [], casing: '', fp: 'x', values: {} },
      tls: { ja4: 't13d1517h2_8daaf6152771_cb7bf5808d99', source: 'front' },
      ...extra,
    },
    payload: { schema: 1, libVersion: '5.3.0', collectedAt: 1, durationMs: 1, linkedId, components: {}, extended: {} },
    derived: { clockSkewMs: 0 },
  }
}

describe('summarizeEvent', () => {
  it('shows the time, label, address, protocol and JA4', () => {
    const line = summarizeEvent(event('203.0.113.9', {}, 'p01.iphone-safari'))
    for (const expected of [
      '2026-10-18T12:00:00.000Z',
      'label=p01.iphone-safari',
      'ip=203.0.113.9',
      'http=2.0',
      'ja4=t13d1517h2_8daaf6152771_cb7bf5808d99',
      'viaProxy=false',
    ]) {
      assert.ok(line.includes(expected), expected)
    }
    assert.ok(!line.includes('WARNING'))
  })

  it('warns about the addresses that Docker or a local connection show instead of the visitor', () => {
    for (const ip of ['172.17.0.1', '172.18.0.5', '172.31.255.1', '127.0.0.1']) {
      assert.ok(summarizeEvent(event(ip)).includes('WARNING'), ip)
    }
    for (const ip of ['172.15.0.1', '172.32.0.1', '203.0.113.9', '2001:db8::1']) {
      assert.ok(!summarizeEvent(event(ip)).includes('WARNING'), ip)
    }
  })

  it('shows the visitor, whether it came back, and says when the probability is only provisional', () => {
    const base = {
      visitorId: 'v_abc',
      matched: true,
      ambiguous: false,
      learned: true,
      logOdds: 7,
      probability: null,
      provisionalProbability: 0.9731,
      calibrated: false,
      thresholds: { match: 0.95, possibleLink: null },
      candidates: 1,
      devices: 4,
      explanation: [],
      resolvedAt: 1,
    }
    const line = summarizeEvent(event('203.0.113.9'), base)
    for (const expected of ['visitor=v_abc', 'returning', 'p=0.973(provisional)']) {
      assert.ok(line.includes(expected), expected)
    }
    assert.ok(!line.includes('AMBIGUOUS'))
    const calibrated = summarizeEvent(event('203.0.113.9'), {
      ...base,
      calibrated: true,
      probability: 0.9731,
      ambiguous: true,
    })
    assert.ok(calibrated.includes('p=0.973') && !calibrated.includes('provisional') && calibrated.includes('AMBIGUOUS'))
    assert.ok(
      summarizeEvent(event('203.0.113.9'), {
        ...base,
        matched: false,
        probability: null,
        provisionalProbability: null,
      }).includes('new  p=-'),
    )
  })

  it('says why there is no JA4 when there is none', () => {
    const line = summarizeEvent(event('203.0.113.9', { tls: undefined, tlsStatus: 'not_tls' }))
    assert.ok(line.includes('ja4=not_tls'))
    assert.ok(summarizeEvent(event('203.0.113.9', { tls: undefined })).includes('ja4=-'))
    assert.ok(summarizeEvent(event('203.0.113.9')).includes('label=-'))
  })
})
