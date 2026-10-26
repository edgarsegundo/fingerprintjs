import { DatabaseSync } from 'node:sqlite'

import type { BrowserFamily, ConnectionType, ProbeResult, ReportPhase, ReportReason } from './report'

/**
 * One stored report. There is no address in it, on purpose: the network is told apart by its number (when a file of
 * networks was given) and by `prefixHash`, a keyed hash of the /24 (IPv4) or /64 (IPv6) that can be counted
 * but not read.
 */
export interface ReportRow {
  receivedAt: number
  reason: ReportReason
  phase: ReportPhase
  probe: ProbeResult
  status?: number
  elapsedMs: number
  online?: boolean
  connection?: ConnectionType
  site?: string
  browser: BrowserFamily
  mobile: boolean
  asn?: number
  network?: string
  prefixHash?: string
}

export interface Count {
  key: string
  count: number
}

export interface NetworkCount {
  /** The number and name of the network, or `prefix <hash>` when the file of networks did not know the address */
  label: string
  reports: number
  /** How many different /24 (or /64) prefixes sent them: one noisy visitor is not a whole network */
  prefixes: number
}

/** Columns that a summary may group by. A fixed list, because the name goes into the SQL text. */
export const groupableColumns = ['reason', 'probe', 'phase', 'browser', 'status', 'connection', 'site'] as const
export type GroupableColumn = typeof groupableColumns[number]

const hourMs = 3_600_000

export class ReportStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        phase TEXT NOT NULL,
        probe TEXT NOT NULL,
        status INTEGER,
        elapsed_ms INTEGER NOT NULL,
        online INTEGER,
        connection TEXT,
        site TEXT,
        browser TEXT NOT NULL,
        mobile INTEGER NOT NULL,
        asn INTEGER,
        network TEXT,
        prefix_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS reports_received_at ON reports (received_at);
    `)
  }

  insert(row: ReportRow): void {
    this.db
      .prepare(
        `INSERT INTO reports (received_at, reason, phase, probe, status, elapsed_ms, online, connection, site,
           browser, mobile, asn, network, prefix_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.receivedAt,
        row.reason,
        row.phase,
        row.probe,
        row.status ?? null,
        row.elapsedMs,
        row.online === undefined ? null : row.online ? 1 : 0,
        row.connection ?? null,
        row.site ?? null,
        row.browser,
        row.mobile ? 1 : 0,
        row.asn ?? null,
        row.network ?? null,
        row.prefixHash ?? null,
      )
  }

  /** Deletes the reports received before the given time. Returns how many. */
  purge(before: number): number {
    return Number(this.db.prepare('DELETE FROM reports WHERE received_at < ?').run(before).changes)
  }

  count(since: number, reasons?: readonly ReportReason[]): number {
    const filter = reasons ? ` AND reason IN (${reasons.map(() => '?').join(',')})` : ''
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM reports WHERE received_at >= ?${filter}`)
      .get(since, ...(reasons ?? [])) as { n: number }
    return Number(row.n)
  }

  countBy(column: GroupableColumn, since: number, reasons?: readonly ReportReason[]): Count[] {
    if (!(groupableColumns as readonly string[]).includes(column)) {
      throw new Error(`Cannot group by "${column}"`)
    }
    const filter = reasons ? ` AND reason IN (${reasons.map(() => '?').join(',')})` : ''
    const rows = this.db
      .prepare(
        `SELECT COALESCE(CAST(${column} AS TEXT), '-') AS key, COUNT(*) AS n FROM reports
         WHERE received_at >= ?${filter} GROUP BY key ORDER BY n DESC, key`,
      )
      .all(since, ...(reasons ?? [])) as Array<{ key: string; n: number }>
    return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
  }

  /** Reports on phones and on computers */
  countMobile(since: number, reasons?: readonly ReportReason[]): { mobile: number; desktop: number } {
    const filter = reasons ? ` AND reason IN (${reasons.map(() => '?').join(',')})` : ''
    const rows = this.db
      .prepare(`SELECT mobile, COUNT(*) AS n FROM reports WHERE received_at >= ?${filter} GROUP BY mobile`)
      .all(since, ...(reasons ?? [])) as Array<{ mobile: number; n: number }>
    const result = { mobile: 0, desktop: 0 }
    for (const row of rows) {
      result[row.mobile ? 'mobile' : 'desktop'] = Number(row.n)
    }
    return result
  }

  /** Reports per hour of the day (0 to 23) at the given offset from UTC, in hours */
  countByHour(since: number, utcOffsetHours: number, reasons?: readonly ReportReason[]): number[] {
    const filter = reasons ? ` AND reason IN (${reasons.map(() => '?').join(',')})` : ''
    const rows = this.db
      .prepare(`SELECT received_at AS at FROM reports WHERE received_at >= ?${filter}`)
      .all(since, ...(reasons ?? [])) as Array<{ at: number }>
    const hours = new Array<number>(24).fill(0)
    for (const row of rows) {
      const hour = (((Math.floor(Number(row.at) / hourMs) + utcOffsetHours) % 24) + 24) % 24
      hours[hour]++
    }
    return hours
  }

  /** The networks that sent most of the given reasons */
  topNetworks(since: number, reasons: readonly ReportReason[], limit: number): NetworkCount[] {
    const rows = this.db
      .prepare(
        `SELECT asn, network, prefix_hash AS prefixHash FROM reports
         WHERE received_at >= ? AND reason IN (${reasons.map(() => '?').join(',')})`,
      )
      .all(since, ...reasons) as Array<{ asn: number | null; network: string | null; prefixHash: string | null }>
    const groups = new Map<string, { reports: number; prefixes: Set<string> }>()
    for (const row of rows) {
      const label =
        row.asn !== null || row.network !== null
          ? [row.asn !== null ? `AS${row.asn}` : '', row.network ?? ''].filter(Boolean).join(' ')
          : row.prefixHash !== null
          ? `prefix ${row.prefixHash}`
          : 'unknown'
      const group = groups.get(label) ?? { reports: 0, prefixes: new Set<string>() }
      group.reports++
      if (row.prefixHash !== null) {
        group.prefixes.add(row.prefixHash)
      }
      groups.set(label, group)
    }
    return [...groups.entries()]
      .map(([label, group]) => ({ label, reports: group.reports, prefixes: group.prefixes.size }))
      .sort((a, b) => b.reports - a.reports || a.label.localeCompare(b.label))
      .slice(0, limit)
  }

  /** The oldest and newest report, or `undefined` for an empty table */
  span(): { first: number; last: number } | undefined {
    const row = this.db.prepare('SELECT MIN(received_at) AS first, MAX(received_at) AS last FROM reports').get() as {
      first: number | null
      last: number | null
    }
    return row.first === null || row.last === null ? undefined : { first: Number(row.first), last: Number(row.last) }
  }

  /** Reads every row; for tests that check what was kept */
  dump(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM reports ORDER BY id').all() as Array<Record<string, unknown>>
  }

  close(): void {
    this.db.close()
  }
}
