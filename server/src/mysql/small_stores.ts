import type { AuditEntry, AuditLog, AuditQuery, NewAuditEntry } from '../audit/log'
import type { GraphStore, GraphSummary } from '../graph/store'
import type { TenantRecord, TenantStore } from '../tenants/store'
import { dayOf, emptyTotals, UsageMeter, UsageMetric, usageMetrics, UsageTotals } from '../usage/meter'
import type { Delivery, DeliveryStatus, NewDelivery, WebhookQueue } from '../webhooks/queue'

import type { MysqlDatabase } from './database'

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const pieces: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    pieces.push(items.slice(start, start + size))
  }
  return pieces
}

// --- Webhook deliveries

interface DeliveryRow {
  id: string
  tenant_id: string
  endpoint_id: string
  body: string
  attempts: number
  next_attempt_at: number
  status: DeliveryStatus
  last_error: string | null
  created_at: number
  finished_at: number | null
}

const toDelivery = (row: DeliveryRow): Delivery => ({
  id: row.id,
  tenantId: row.tenant_id,
  endpointId: row.endpoint_id,
  body: row.body,
  attempts: Number(row.attempts),
  nextAttemptAt: Number(row.next_attempt_at),
  status: row.status,
  lastError: row.last_error,
  createdAt: Number(row.created_at),
  finishedAt: row.finished_at === null ? null : Number(row.finished_at),
})

export class MysqlWebhookQueue implements WebhookQueue {
  constructor(private readonly db: MysqlDatabase) {}

  async enqueue(delivery: NewDelivery, maxPending: number): Promise<boolean> {
    if ((await this.pendingCount(delivery.tenantId)) >= maxPending) {
      return false
    }
    await this.db.run(
      `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, body, next_attempt_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [delivery.id, delivery.tenantId, delivery.endpointId, delivery.body, delivery.createdAt, delivery.createdAt],
    )
    return true
  }

  async due(now: number, limit: number): Promise<Delivery[]> {
    const rows = await this.db.query<DeliveryRow>(
      `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id LIMIT ?`,
      [now, limit],
    )
    return rows.map(toDelivery)
  }

  async claimDue(now: number, limit: number, owner: string, leaseMs: number): Promise<Delivery[]> {
    return this.db.transaction(async (tx) => {
      // Rows that another instance holds locked right now are skipped, not waited for
      const free = await tx.query<{ id: string }>(
        `SELECT id FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
          ORDER BY next_attempt_at, id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, now, limit],
      )
      if (free.length === 0) {
        return []
      }
      const ids = free.map((row) => row.id)
      await tx.run('UPDATE webhook_deliveries SET claimed_by = ?, claimed_until = ? WHERE id IN (?)', [
        owner,
        now + leaseMs,
        ids,
      ])
      const rows = await tx.query<DeliveryRow>(
        'SELECT * FROM webhook_deliveries WHERE id IN (?) ORDER BY next_attempt_at, id',
        [ids],
      )
      return rows.map(toDelivery)
    })
  }

  async markDone(id: string, now: number): Promise<void> {
    await this.db.run(
      `UPDATE webhook_deliveries SET status = 'done', attempts = attempts + 1, finished_at = ?, last_error = NULL,
         claimed_by = NULL, claimed_until = NULL
       WHERE id = ?`,
      [now, id],
    )
  }

  async markRetry(id: string, nextAttemptAt: number, error: string): Promise<void> {
    await this.db.run(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?,
         claimed_by = NULL, claimed_until = NULL WHERE id = ?`,
      [nextAttemptAt, error, id],
    )
  }

  async markFailed(id: string, now: number, error: string): Promise<void> {
    await this.db.run(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, finished_at = ?, last_error = ?,
         claimed_by = NULL, claimed_until = NULL
       WHERE id = ?`,
      [now, error, id],
    )
  }

  async list(tenantId: string, options: { status?: DeliveryStatus; limit: number }): Promise<Delivery[]> {
    const rows = options.status
      ? await this.db.query<DeliveryRow>(
          `SELECT * FROM webhook_deliveries WHERE tenant_id = ? AND status = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [tenantId, options.status, options.limit],
        )
      : await this.db.query<DeliveryRow>(
          'SELECT * FROM webhook_deliveries WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          [tenantId, options.limit],
        )
    return rows.map(toDelivery)
  }

  async get(tenantId: string, id: string): Promise<Delivery | undefined> {
    const rows = await this.db.query<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE tenant_id = ? AND id = ?', [
      tenantId,
      id,
    ])
    return rows[0] && toDelivery(rows[0])
  }

  async retry(tenantId: string, id: string, now: number): Promise<boolean> {
    return (
      (
        await this.db.run(
          `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, finished_at = NULL
           WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
          [now, tenantId, id],
        )
      ).affected === 1
    )
  }

  async pendingCount(tenantId: string): Promise<number> {
    const [row] = await this.db.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM webhook_deliveries WHERE tenant_id = ? AND status = 'pending'",
      [tenantId],
    )
    return Number(row.c)
  }

  async backlog(now: number): Promise<{ pending: number; oldestDueAgeMs: number }> {
    const [row] = await this.db.query<{ pending: number; oldest: number | null }>(
      `SELECT COUNT(*) AS pending, MIN(CASE WHEN next_attempt_at <= ? THEN next_attempt_at END) AS oldest
         FROM webhook_deliveries WHERE status = 'pending'`,
      [now],
    )
    return { pending: Number(row.pending), oldestDueAgeMs: row.oldest === null ? 0 : now - Number(row.oldest) }
  }

  async deleteTenant(tenantId: string): Promise<number> {
    return (await this.db.run('DELETE FROM webhook_deliveries WHERE tenant_id = ?', [tenantId])).affected
  }

  async deleteForRequests(tenantId: string, requestIds: readonly string[]): Promise<number> {
    let removed = 0
    for (const requestId of requestIds) {
      removed += (
        await this.db.run('DELETE FROM webhook_deliveries WHERE tenant_id = ? AND INSTR(body, ?) > 0', [
          tenantId,
          `"requestId":"${requestId}"`,
        ])
      ).affected
    }
    return removed
  }

  async purgeTenant(tenantId: string, doneBefore: number, failedBefore: number): Promise<number> {
    return (
      await this.db.run(
        `DELETE FROM webhook_deliveries
         WHERE tenant_id = ? AND ((status = 'done' AND finished_at < ?) OR (status = 'failed' AND finished_at < ?))`,
        [tenantId, doneBefore, failedBefore],
      )
    ).affected
  }
}

// --- Audit log

interface AuditRow {
  seq: number
  at: number
  tenant_id: string
  action: AuditEntry['action']
  subject: string
  key_id: string
  requester: string
  status: number
}

export class MysqlAuditLog implements AuditLog {
  constructor(private readonly db: MysqlDatabase) {}

  async record(entry: NewAuditEntry): Promise<void> {
    await this.db.run(
      `INSERT INTO audit_log (at, tenant_id, action, subject, key_id, requester, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.at, entry.tenantId, entry.action, entry.subject, entry.keyId, entry.requester, entry.status],
    )
  }

  async list(tenantId: string, query: AuditQuery): Promise<AuditEntry[]> {
    const rows = await this.db.query<AuditRow>(
      `SELECT * FROM audit_log WHERE tenant_id = ? AND at >= ? AND at < ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
      [
        tenantId,
        query.since ?? 0,
        query.until ?? Number.MAX_SAFE_INTEGER,
        query.before ?? Number.MAX_SAFE_INTEGER,
        query.limit,
      ],
    )
    return rows.map((row) => ({
      seq: Number(row.seq),
      at: Number(row.at),
      tenantId: row.tenant_id,
      action: row.action,
      subject: row.subject,
      keyId: row.key_id,
      requester: row.requester,
      status: Number(row.status),
    }))
  }

  async purgeTenant(tenantId: string, before: number): Promise<number> {
    return (await this.db.run('DELETE FROM audit_log WHERE tenant_id = ? AND at < ?', [tenantId, before])).affected
  }
}

// --- Tenants made through the admin API

export class MysqlTenantStore implements TenantStore {
  constructor(private readonly db: MysqlDatabase) {}

  async list(): Promise<TenantRecord[]> {
    const rows = await this.db.query<{ record_json: string }>('SELECT record_json FROM tenants ORDER BY created_at, id')
    return rows.map((row) => JSON.parse(row.record_json) as TenantRecord)
  }

  async get(id: string): Promise<TenantRecord | undefined> {
    const rows = await this.db.query<{ record_json: string }>('SELECT record_json FROM tenants WHERE id = ?', [id])
    return rows[0] && (JSON.parse(rows[0].record_json) as TenantRecord)
  }

  async create(record: TenantRecord): Promise<void> {
    try {
      await this.db.run('INSERT INTO tenants (id, public_key, record_json, created_at) VALUES (?, ?, ?, ?)', [
        record.id,
        record.publicKey,
        JSON.stringify(record),
        record.createdAt,
      ])
    } catch {
      // The primary key and the unique index refuse a repeated id or public key
      throw new Error('The tenant id or the public key is already in use')
    }
  }

  async update(record: TenantRecord): Promise<void> {
    const { affected } = await this.db.run('UPDATE tenants SET public_key = ?, record_json = ? WHERE id = ?', [
      record.publicKey,
      JSON.stringify(record),
      record.id,
    ])
    if (affected !== 1) {
      throw new Error('No such tenant')
    }
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM tenants WHERE id = ?', [id])).affected === 1
  }
}

// --- Usage

export class MysqlUsageMeter implements UsageMeter {
  constructor(private readonly db: MysqlDatabase) {}

  async add(tenantId: string, metric: UsageMetric, at: number, amount = 1): Promise<void> {
    await this.db.run(
      `INSERT INTO usage_daily (tenant_id, day, metric, count) VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE count = usage_daily.count + new.count`,
      [tenantId, dayOf(at), metric, amount],
    )
  }

  private rows(tenantId: string, month: string) {
    return this.db.query<{ day: string; metric: UsageMetric; count: number }>(
      'SELECT day, metric, count FROM usage_daily WHERE tenant_id = ? AND day LIKE ? ORDER BY day',
      [tenantId, `${month}-%`],
    )
  }

  async days(tenantId: string, month: string): Promise<Array<{ day: string } & UsageTotals>> {
    const byDay = new Map<string, UsageTotals>()
    for (const row of await this.rows(tenantId, month)) {
      const totals = byDay.get(row.day) ?? emptyTotals()
      if (usageMetrics.includes(row.metric)) {
        totals[row.metric] += Number(row.count)
      }
      byDay.set(row.day, totals)
    }
    return [...byDay].map(([day, totals]) => ({ day, ...totals }))
  }

  async month(tenantId: string, month: string): Promise<UsageTotals> {
    const total = emptyTotals()
    for (const row of await this.rows(tenantId, month)) {
      if (usageMetrics.includes(row.metric)) {
        total[row.metric] += Number(row.count)
      }
    }
    return total
  }

  async deleteTenant(tenantId: string): Promise<number> {
    return (await this.db.run('DELETE FROM usage_daily WHERE tenant_id = ?', [tenantId])).affected
  }
}

// --- Shared graph

export class MysqlGraphStore implements GraphStore {
  constructor(private readonly db: MysqlDatabase) {}

  async record(key: string, tenantId: string, at: number, flagged: boolean): Promise<void> {
    await this.db.run(
      `INSERT INTO graph_edges (graph_key, tenant_id, last_seen, last_flagged) VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         last_seen = GREATEST(graph_edges.last_seen, new.last_seen),
         last_flagged = GREATEST(graph_edges.last_flagged, new.last_flagged)`,
      [key, tenantId, at, flagged ? at : 0],
    )
  }

  async summary(key: string, tenantId: string, since: number): Promise<GraphSummary> {
    const [row] = await this.db.query<{ tenants: number; flagged: number }>(
      `SELECT COALESCE(SUM(last_seen >= ?), 0) AS tenants,
              COALESCE(SUM(last_flagged >= ? AND last_flagged > 0), 0) AS flagged
         FROM graph_edges WHERE graph_key = ? AND tenant_id != ?`,
      [since, since, key, tenantId],
    )
    return { tenants: Number(row.tenants), flaggedTenants: Number(row.flagged) }
  }

  async deleteKeys(tenantId: string, keys: readonly string[]): Promise<number> {
    let removed = 0
    for (const keyChunk of chunk(keys, 500)) {
      removed += (
        await this.db.run('DELETE FROM graph_edges WHERE tenant_id = ? AND graph_key IN (?)', [tenantId, keyChunk])
      ).affected
    }
    return removed
  }

  async deleteTenant(tenantId: string): Promise<number> {
    return (await this.db.run('DELETE FROM graph_edges WHERE tenant_id = ?', [tenantId])).affected
  }

  async purge(before: number): Promise<number> {
    return (await this.db.run('DELETE FROM graph_edges WHERE last_seen < ?', [before])).affected
  }
}
