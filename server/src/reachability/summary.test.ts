import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ReportReason } from './report'
import { ReportStore } from './store'
import { renderSummary, summarize } from './summary'

const day = 86_400_000
// 2026-10-19 15:00 UTC, which is noon in Brasilia
const now = Date.UTC(2026, 9, 19, 15, 0, 0)

function row(store: ReportStore, reason: ReportReason, extra: Partial<Parameters<ReportStore['insert']>[0]> = {}) {
  store.insert({
    receivedAt: now - 1000,
    reason,
    phase: 'script',
    probe: 'unreachable',
    elapsedMs: 100,
    browser: 'chrome',
    mobile: false,
    ...extra,
  })
}

describe('reachability summary', () => {
  it('works on an empty database', () => {
    const summary = summarize(new ReportStore(':memory:'), { days: 30, now, utcOffsetHours: -3 })
    assert.equal(summary.total, 0)
    assert.match(renderSummary(summary), /Avisos recebidos: 0/)
  })

  it('counts by reason, browser and phone, within the days asked', () => {
    const store = new ReportStore(':memory:')
    row(store, 'script_unreachable', { browser: 'safari', mobile: true })
    row(store, 'script_unreachable')
    row(store, 'script_blocked', { probe: 'reachable', browser: 'firefox' })
    row(store, 'server_refused', { status: 403, probe: 'skipped' })
    row(store, 'ok', { probe: 'skipped' })
    row(store, 'script_unreachable', { receivedAt: now - 40 * day })
    const summary = summarize(store, { days: 30, now, utcOffsetHours: -3 })
    assert.equal(summary.total, 5)
    assert.equal(summary.unreachable, 3)
    assert.equal(summary.failures, 4)
    assert.deepEqual(summary.byReason[0], { key: 'script_unreachable', count: 2 })
    assert.deepEqual(summary.mobile, { mobile: 1, desktop: 3 })
    assert.deepEqual(summary.byStatus, [{ key: '403', count: 1 }])
    assert.deepEqual(summary.byProbe.map((entry) => entry.key).sort(), ['reachable', 'skipped', 'unreachable'])
    assert.ok(!summary.byBrowser.some((entry) => entry.count === 0))
  })

  it('puts the hour of the day at the offset asked', () => {
    const store = new ReportStore(':memory:')
    row(store, 'script_unreachable')
    row(store, 'script_blocked', { receivedAt: now - 3_600_000 * 13 })
    row(store, 'server_error', { status: 500 }) // not an unreachable visit
    const brasilia = summarize(store, { days: 3, now, utcOffsetHours: -3 }).unreachableByHour
    assert.equal(brasilia[11], 1, '14:59 UTC is 11:59 in Brasilia')
    assert.equal(brasilia[23], 1, '02:00 UTC is 23:00 of the day before in Brasilia')
    assert.equal(
      brasilia.reduce((a, b) => a + b, 0),
      2,
    )
    const utc = summarize(store, { days: 3, now, utcOffsetHours: 0 }).unreachableByHour
    assert.equal(utc[14], 1)
    assert.equal(utc[2], 1)
  })

  it('groups networks by number and name, and counts the different prefixes inside', () => {
    const store = new ReportStore(':memory:')
    row(store, 'script_unreachable', { asn: 28573, network: 'CLARO', prefixHash: 'aaaa' })
    row(store, 'script_unreachable', { asn: 28573, network: 'CLARO', prefixHash: 'bbbb' })
    row(store, 'script_unreachable', { asn: 28573, network: 'CLARO', prefixHash: 'bbbb' })
    row(store, 'script_blocked', { prefixHash: 'cccc' })
    row(store, 'script_blocked', { prefixHash: 'cccc' })
    row(store, 'server_error', { status: 500, asn: 1, network: 'Other', prefixHash: 'dddd' })
    const networks = summarize(store, { days: 1, now, utcOffsetHours: 0 }).networks
    assert.deepEqual(networks, [
      { label: 'AS28573 CLARO', reports: 3, prefixes: 2 },
      { label: 'prefix cccc', reports: 2, prefixes: 1 },
    ])
  })

  it('deletes by age', () => {
    const store = new ReportStore(':memory:')
    row(store, 'script_unreachable', { receivedAt: now - 100 * day })
    row(store, 'script_unreachable', { receivedAt: now - 1 * day })
    assert.equal(store.purge(now - 90 * day), 1)
    assert.deepEqual(
      store.dump().map((entry) => entry.received_at),
      [now - 1 * day],
    )
  })

  it('writes the text in Portuguese with the reading notes', () => {
    const store = new ReportStore(':memory:')
    row(store, 'script_unreachable', { asn: 28573, network: 'CLARO', prefixHash: 'aaaa' })
    const text = renderSummary(summarize(store, { days: 30, now, utcOffsetHours: -3 }))
    assert.match(text, /Visitas que não chegaram ao coletor: 1/)
    assert.match(text, /AS28573 CLARO/)
    assert.match(text, /Como ler:/)
    assert.match(text, /script_unreachable: o script/)
  })
})
