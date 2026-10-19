import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createServerMetrics, Metrics } from './metrics'

describe('Metrics', () => {
  it('counts by labels and writes the text format with help and type', async () => {
    const metrics = new Metrics()
    metrics.counter('things_total', 'Things done.')
    metrics.inc('things_total', { kind: 'a' })
    metrics.inc('things_total', { kind: 'a' })
    metrics.inc('things_total', { kind: 'b' }, 5)
    assert.equal(
      await metrics.render(),
      [
        '# HELP things_total Things done.',
        '# TYPE things_total counter',
        'things_total{kind="a"} 2',
        'things_total{kind="b"} 5',
        '',
      ].join('\n'),
    )
  })

  it('writes a counter with no series as zero, so that it exists from the start', async () => {
    const metrics = new Metrics()
    metrics.counter('empty_total', 'Nothing yet.')
    assert.match(await metrics.render(), /^empty_total 0$/m)
  })

  it('sorts label names so that the same labels are one series, and escapes quotes and new lines', async () => {
    const metrics = new Metrics()
    metrics.counter('c_total', 'x')
    metrics.inc('c_total', { b: '1', a: '2' })
    metrics.inc('c_total', { a: '2', b: '1' })
    metrics.inc('c_total', { a: 'say "hi"\\\n' })
    const text = await metrics.render()
    assert.match(text, /c_total\{a="2",b="1"\} 2/)
    assert.ok(text.includes('c_total{a="say \\"hi\\"\\\\\\n"} 1'), text)
  })

  it('reads gauges when it renders', async () => {
    const metrics = new Metrics()
    let value = 1
    metrics.gauge('level', 'A level.', () => [{ labels: { zone: 'x' }, value }])
    assert.match(await metrics.render(), /level\{zone="x"\} 1/)
    value = 7
    assert.match(await metrics.render(), /level\{zone="x"\} 7/)
  })

  it('writes cumulative buckets, a +Inf bucket, a sum and a count', async () => {
    const metrics = new Metrics()
    metrics.histogram('d_seconds', 'Durations.', [0.1, 1])
    for (const value of [0.05, 0.1, 0.5, 2]) {
      metrics.observe('d_seconds', value, { route: 'x' })
    }
    const text = await metrics.render()
    assert.match(text, /d_seconds_bucket\{route="x",le="0.1"\} 2/, 'a value equal to the limit is inside it')
    assert.match(text, /d_seconds_bucket\{route="x",le="1"\} 3/)
    assert.match(text, /d_seconds_bucket\{route="x",le="\+Inf"\} 4/)
    assert.match(text, /d_seconds_sum\{route="x"\} 2.65/)
    assert.match(text, /d_seconds_count\{route="x"\} 4/)
  })

  it('refuses an unknown name instead of creating it', async () => {
    const metrics = new Metrics()
    assert.throws(() => metrics.inc('nope'), /Unknown counter/)
    assert.throws(() => metrics.observe('nope', 1), /Unknown histogram/)
  })

  it('keeps the memory bounded: past the limit of series, new label sets go together as other', async () => {
    const metrics = new Metrics()
    metrics.counter('wide_total', 'x')
    for (let i = 0; i < 700; i++) {
      metrics.inc('wide_total', { id: `value-${i}` })
    }
    const lines = (await metrics.render()).split('\n').filter((line) => line.startsWith('wide_total{'))
    assert.equal(lines.length, 501)
    assert.ok(lines.some((line) => line.startsWith('wide_total{id="other"} 200')))
  })

  it('declares the metrics of the server', async () => {
    const text = await createServerMetrics().render()
    for (const name of [
      'fp_http_requests_total',
      'fp_http_request_duration_seconds',
      'fp_collects_total',
      'fp_identity_resolutions_total',
      'fp_webhook_deliveries_total',
      'fp_quota_rejected_total',
      'fp_errors_total',
    ]) {
      assert.ok(text.includes(`# TYPE ${name} `), name)
    }
  })
})
