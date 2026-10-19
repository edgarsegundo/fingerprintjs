import type { DatabaseSync } from 'node:sqlite'

import type { MaybePromise } from '../async'

/** What is counted per tenant, for billing and for quotas */
export const usageMetrics = [
  'collects',
  'nonces',
  'apiReads',
  'webhooksDelivered',
  'webhooksFailed',
  'quotaRejected',
] as const

export type UsageMetric = typeof usageMetrics[number]
export type UsageTotals = Record<UsageMetric, number>

export const emptyTotals = (): UsageTotals =>
  Object.fromEntries(usageMetrics.map((metric) => [metric, 0])) as UsageTotals

/** The day of a time in UTC, such as `2026-10-19` */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** The month of a time in UTC, such as `2026-10` */
export const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7)

/** The time at which the next month starts, in UTC */
export function nextMonthStart(at: number): number {
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

export interface UsageMeter {
  add(tenantId: string, metric: UsageMetric, at: number, amount?: number): MaybePromise<void>
  /** Totals of a UTC month (`YYYY-MM`) */
  month(tenantId: string, month: string): MaybePromise<UsageTotals>
  /** Totals day by day of a UTC month, for the days that have any */
  days(tenantId: string, month: string): MaybePromise<Array<{ day: string } & UsageTotals>>
  /** Forgets everything about a tenant. Returns how many daily counters were deleted. */
  deleteTenant(tenantId: string): MaybePromise<number>
}

export class MemoryUsageMeter implements UsageMeter {
  /** tenant, then day, then metric */
  private readonly counts = new Map<string, Map<string, UsageTotals>>()

  add(tenantId: string, metric: UsageMetric, at: number, amount = 1): void {
    let days = this.counts.get(tenantId)
    if (!days) {
      days = new Map()
      this.counts.set(tenantId, days)
    }
    const day = dayOf(at)
    const totals = days.get(day) ?? emptyTotals()
    totals[metric] += amount
    days.set(day, totals)
  }

  days(tenantId: string, month: string): Array<{ day: string } & UsageTotals> {
    return [...(this.counts.get(tenantId) ?? [])]
      .filter(([day]) => day.startsWith(`${month}-`))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, totals]) => ({ day, ...totals }))
  }

  month(tenantId: string, month: string): UsageTotals {
    const total = emptyTotals()
    for (const day of this.days(tenantId, month)) {
      for (const metric of usageMetrics) {
        total[metric] += day[metric]
      }
    }
    return total
  }

  deleteTenant(tenantId: string): number {
    const removed = this.counts.get(tenantId)?.size ?? 0
    this.counts.delete(tenantId)
    return removed
  }
}

/** Keeps the counters in the same SQLite file as the events: one row per tenant, day and metric */
export class SqliteUsageMeter implements UsageMeter {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily (
        tenant_id TEXT NOT NULL,
        day TEXT NOT NULL,
        metric TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, day, metric)
      );
    `)
  }

  add(tenantId: string, metric: UsageMetric, at: number, amount = 1): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (tenant_id, day, metric, count) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, day, metric) DO UPDATE SET count = count + excluded.count`,
      )
      .run(tenantId, dayOf(at), metric, amount)
  }

  private rows(tenantId: string, month: string): Array<{ day: string; metric: UsageMetric; count: number }> {
    return this.db
      .prepare('SELECT day, metric, count FROM usage_daily WHERE tenant_id = ? AND day LIKE ? ORDER BY day')
      .all(tenantId, `${month}-%`) as unknown as Array<{ day: string; metric: UsageMetric; count: number }>
  }

  days(tenantId: string, month: string): Array<{ day: string } & UsageTotals> {
    const byDay = new Map<string, UsageTotals>()
    for (const row of this.rows(tenantId, month)) {
      const totals = byDay.get(row.day) ?? emptyTotals()
      if (usageMetrics.includes(row.metric)) {
        totals[row.metric] += Number(row.count)
      }
      byDay.set(row.day, totals)
    }
    return [...byDay].map(([day, totals]) => ({ day, ...totals }))
  }

  month(tenantId: string, month: string): UsageTotals {
    const total = emptyTotals()
    for (const row of this.rows(tenantId, month)) {
      if (usageMetrics.includes(row.metric)) {
        total[row.metric] += Number(row.count)
      }
    }
    return total
  }

  deleteTenant(tenantId: string): number {
    return Number(this.db.prepare('DELETE FROM usage_daily WHERE tenant_id = ?').run(tenantId).changes)
  }
}
