import type { MaybePromise } from './async'

/**
 * Counters, gauges and histograms in the text format that Prometheus reads (version 0.0.4). It has no dependency and
 * keeps everything in memory, so a restart starts the counts again, which Prometheus handles as a counter reset.
 *
 * Labels are chosen by the code and not by the visitor: a label made from what a client sends (an address, a path, a
 * user agent) would let a client grow the memory of the server without limit.
 */
type Labels = Record<string, string>

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

function labelKey(labels: Labels): string {
  const names = Object.keys(labels).sort()
  return names.map((name) => `${name}="${escapeLabel(labels[name])}"`).join(',')
}

interface Family {
  name: string
  help: string
  type: 'counter' | 'gauge' | 'histogram'
}

export class Metrics {
  private readonly families: Family[] = []
  private readonly counters = new Map<string, Map<string, number>>()
  private readonly gauges = new Map<string, () => MaybePromise<Array<{ labels: Labels; value: number }>>>()
  private readonly histograms = new Map<
    string,
    { buckets: number[]; series: Map<string, { counts: number[]; sum: number; count: number }> }
  >()
  /** The most label sets a family keeps. Past it, new ones are counted together under `other`. */
  private readonly maxSeries = 500

  counter(name: string, help: string): void {
    this.families.push({ name, help, type: 'counter' })
    this.counters.set(name, new Map())
  }

  gauge(name: string, help: string, read: () => MaybePromise<Array<{ labels: Labels; value: number }>>): void {
    this.families.push({ name, help, type: 'gauge' })
    this.gauges.set(name, read)
  }

  histogram(name: string, help: string, buckets: number[]): void {
    this.families.push({ name, help, type: 'histogram' })
    this.histograms.set(name, { buckets: [...buckets].sort((a, b) => a - b), series: new Map() })
  }

  inc(name: string, labels: Labels = {}, amount = 1): void {
    const series = this.counters.get(name)
    if (!series) {
      throw new Error(`Unknown counter ${name}`)
    }
    const key = this.keyFor(series, labelKey(labels), labels)
    series.set(key, (series.get(key) ?? 0) + amount)
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const family = this.histograms.get(name)
    if (!family) {
      throw new Error(`Unknown histogram ${name}`)
    }
    const key = this.keyFor(family.series, labelKey(labels), labels)
    const entry = family.series.get(key) ?? { counts: family.buckets.map(() => 0), sum: 0, count: 0 }
    family.buckets.forEach((limit, index) => {
      if (value <= limit) {
        entry.counts[index]++
      }
    })
    entry.sum += value
    entry.count++
    family.series.set(key, entry)
  }

  private keyFor(series: Map<string, unknown>, key: string, labels: Labels): string {
    if (series.has(key) || series.size < this.maxSeries) {
      return key
    }
    return labelKey(Object.fromEntries(Object.keys(labels).map((name) => [name, 'other'])))
  }

  /** The whole page, in the order the families were declared */
  async render(): Promise<string> {
    const lines: string[] = []
    for (const family of this.families) {
      lines.push(`# HELP ${family.name} ${family.help.replace(/\n/g, ' ')}`, `# TYPE ${family.name} ${family.type}`)
      if (family.type === 'counter') {
        const series = this.counters.get(family.name) ?? new Map<string, number>()
        if (series.size === 0) {
          lines.push(`${family.name} 0`)
        }
        for (const [key, value] of series) {
          lines.push(`${family.name}${key ? `{${key}}` : ''} ${value}`)
        }
      } else if (family.type === 'gauge') {
        for (const { labels, value } of (await this.gauges.get(family.name)?.()) ?? []) {
          const key = labelKey(labels)
          lines.push(`${family.name}${key ? `{${key}}` : ''} ${value}`)
        }
      } else {
        const histogram = this.histograms.get(family.name)
        for (const [key, entry] of histogram?.series ?? []) {
          const prefix = key ? `${key},` : ''
          histogram?.buckets.forEach((limit, index) => {
            lines.push(`${family.name}_bucket{${prefix}le="${limit}"} ${entry.counts[index]}`)
          })
          lines.push(`${family.name}_bucket{${prefix}le="+Inf"} ${entry.count}`)
          lines.push(`${family.name}_sum${key ? `{${key}}` : ''} ${entry.sum}`)
          lines.push(`${family.name}_count${key ? `{${key}}` : ''} ${entry.count}`)
        }
      }
    }
    return `${lines.join('\n')}\n`
  }
}

/** The metrics of the server. Names follow the Prometheus conventions: base units, `_total` for counters. */
export function createServerMetrics(): Metrics {
  const metrics = new Metrics()
  metrics.counter('fp_http_requests_total', 'Requests answered, by route and status class.')
  metrics.histogram(
    'fp_http_request_duration_seconds',
    'Time to answer a request, by route.',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  )
  metrics.counter('fp_collects_total', 'Visits stored.')
  metrics.counter('fp_identity_resolutions_total', 'Visits given a visitor id, by result (new, matched or ambiguous).')
  metrics.counter('fp_identity_failures_total', 'Visits the matcher could not process.')
  metrics.counter('fp_quota_rejected_total', 'Requests refused because a monthly quota was used up, by metric.')
  metrics.counter('fp_webhook_deliveries_total', 'Webhook deliveries, by result (delivered, retry or failed).')
  metrics.counter('fp_errors_total', 'Requests that ended in an error of the server (5xx).')
  return metrics
}
