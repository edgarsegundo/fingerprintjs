import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { MaybePromise } from '../async'

export type DeliveryStatus = 'pending' | 'done' | 'failed'

export interface Delivery {
  id: string
  tenantId: string
  endpointId: string
  /** The exact text that is sent, kept so that every attempt sends the same bytes */
  body: string
  attempts: number
  nextAttemptAt: number
  status: DeliveryStatus
  lastError: string | null
  createdAt: number
  finishedAt: number | null
}

export type NewDelivery = Pick<Delivery, 'id' | 'tenantId' | 'endpointId' | 'body' | 'createdAt'>

/**
 * The deliveries that were promised and the ones that are done. It is persistent, so a restart does not lose a
 * delivery that was waiting for its next attempt.
 */
export interface WebhookQueue {
  /** Adds a delivery to be sent now. Returns `false`, adding nothing, if the tenant has `maxPending` waiting. */
  enqueue(delivery: NewDelivery, maxPending: number): MaybePromise<boolean>
  /** Pending deliveries whose time has come, the oldest due first */
  due(now: number, limit: number): MaybePromise<Delivery[]>
  /**
   * Like `due`, but each delivery is also reserved for `owner` for `leaseMs`, so that another instance of the server
   * reading the same queue does not take it. A reservation that is not finished or renewed ends by itself, which is
   * how the deliveries of an instance that died come back. A queue that only one process reads does not need it.
   */
  claimDue?(now: number, limit: number, owner: string, leaseMs: number): MaybePromise<Delivery[]>
  markDone(id: string, now: number): MaybePromise<void>
  /** The attempt failed and another one is scheduled */
  markRetry(id: string, nextAttemptAt: number, error: string): MaybePromise<void>
  /** The attempt failed and there will be no other */
  markFailed(id: string, now: number, error: string): MaybePromise<void>
  list(tenantId: string, options: { status?: DeliveryStatus; limit: number }): MaybePromise<Delivery[]>
  get(tenantId: string, id: string): MaybePromise<Delivery | undefined>
  /** Puts a failed delivery back to be sent now. Returns `false` if there is no failed delivery with that id. */
  retry(tenantId: string, id: string, now: number): MaybePromise<boolean>
  pendingCount(tenantId: string): MaybePromise<number>
  /** Deliveries waiting, for all tenants, and how long the oldest due one has been waiting (ms), or 0 */
  backlog(now: number): MaybePromise<{ pending: number; oldestDueAgeMs: number }>
  /** Deletes every delivery of the tenant. Returns how many. */
  deleteTenant(tenantId: string): MaybePromise<number>
  /** Deletes every delivery of the tenant that tells about one of these visits, whatever its status */
  deleteForRequests(tenantId: string, requestIds: readonly string[]): MaybePromise<number>
  /** Deletes the finished deliveries of a tenant that ended before the given times. Returns how many. */
  purgeTenant(tenantId: string, doneBefore: number, failedBefore: number): MaybePromise<number>
}

export class MemoryWebhookQueue implements WebhookQueue {
  private readonly items = new Map<string, Delivery>()

  enqueue(delivery: NewDelivery, maxPending: number): boolean {
    if (this.pendingCount(delivery.tenantId) >= maxPending) {
      return false
    }
    this.items.set(delivery.id, {
      ...delivery,
      attempts: 0,
      nextAttemptAt: delivery.createdAt,
      status: 'pending',
      lastError: null,
      finishedAt: null,
    })
    return true
  }

  due(now: number, limit: number): Delivery[] {
    return [...this.items.values()]
      .filter((item) => item.status === 'pending' && item.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((item) => ({ ...item }))
  }

  markDone(id: string, now: number): void {
    const item = this.items.get(id)
    if (item) {
      Object.assign(item, { status: 'done', attempts: item.attempts + 1, finishedAt: now, lastError: null })
    }
  }

  markRetry(id: string, nextAttemptAt: number, error: string): void {
    const item = this.items.get(id)
    if (item) {
      Object.assign(item, { attempts: item.attempts + 1, nextAttemptAt, lastError: error })
    }
  }

  markFailed(id: string, now: number, error: string): void {
    const item = this.items.get(id)
    if (item) {
      Object.assign(item, { status: 'failed', attempts: item.attempts + 1, finishedAt: now, lastError: error })
    }
  }

  list(tenantId: string, options: { status?: DeliveryStatus; limit: number }): Delivery[] {
    return [...this.items.values()]
      .filter((item) => item.tenantId === tenantId && (options.status === undefined || item.status === options.status))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, options.limit)
      .map((item) => ({ ...item }))
  }

  get(tenantId: string, id: string): Delivery | undefined {
    const item = this.items.get(id)
    return item && item.tenantId === tenantId ? { ...item } : undefined
  }

  retry(tenantId: string, id: string, now: number): boolean {
    const item = this.items.get(id)
    if (!item || item.tenantId !== tenantId || item.status !== 'failed') {
      return false
    }
    Object.assign(item, { status: 'pending', nextAttemptAt: now, finishedAt: null })
    return true
  }

  backlog(now: number): { pending: number; oldestDueAgeMs: number } {
    const pending = [...this.items.values()].filter((item) => item.status === 'pending')
    const due = pending.filter((item) => item.nextAttemptAt <= now)
    return {
      pending: pending.length,
      oldestDueAgeMs: due.length === 0 ? 0 : now - Math.min(...due.map((item) => item.nextAttemptAt)),
    }
  }

  pendingCount(tenantId: string): number {
    return [...this.items.values()].filter((item) => item.tenantId === tenantId && item.status === 'pending').length
  }

  deleteTenant(tenantId: string): number {
    let removed = 0
    for (const [id, item] of this.items) {
      if (item.tenantId === tenantId) {
        this.items.delete(id)
        removed++
      }
    }
    return removed
  }

  deleteForRequests(tenantId: string, requestIds: readonly string[]): number {
    let removed = 0
    for (const [id, item] of this.items) {
      if (
        item.tenantId === tenantId &&
        requestIds.some((requestId) => item.body.includes(`"requestId":"${requestId}"`))
      ) {
        this.items.delete(id)
        removed++
      }
    }
    return removed
  }

  purgeTenant(tenantId: string, doneBefore: number, failedBefore: number): number {
    let removed = 0
    for (const [id, item] of this.items) {
      if (item.tenantId !== tenantId) {
        continue
      }
      const limit = item.status === 'done' ? doneBefore : item.status === 'failed' ? failedBefore : -1
      if (item.finishedAt !== null && item.finishedAt < limit) {
        this.items.delete(id)
        removed++
      }
    }
    return removed
  }
}

interface Row {
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

const toDelivery = (row: Row): Delivery => ({
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

/** Keeps the deliveries in the same SQLite file as the events */
export class SqliteWebhookQueue implements WebhookQueue {
  private readonly insert: StatementSync
  private readonly selectDue: StatementSync
  private readonly done: StatementSync
  private readonly retryLater: StatementSync
  private readonly failed: StatementSync
  private readonly selectOne: StatementSync
  private readonly requeue: StatementSync
  private readonly countPending: StatementSync

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant ON webhook_deliveries (tenant_id, status, created_at);
    `)
    this.insert = db.prepare(
      `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, body, next_attempt_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    this.selectDue = db.prepare(
      `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id LIMIT ?`,
    )
    this.done = db.prepare(
      `UPDATE webhook_deliveries SET status = 'done', attempts = attempts + 1, finished_at = ?, last_error = NULL
       WHERE id = ?`,
    )
    this.retryLater = db.prepare(
      'UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?',
    )
    this.failed = db.prepare(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, finished_at = ?, last_error = ?
       WHERE id = ?`,
    )
    this.selectOne = db.prepare('SELECT * FROM webhook_deliveries WHERE tenant_id = ? AND id = ?')
    this.requeue = db.prepare(
      `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, finished_at = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
    )
    this.countPending = db.prepare(
      "SELECT COUNT(*) AS c FROM webhook_deliveries WHERE tenant_id = ? AND status = 'pending'",
    )
  }

  enqueue(delivery: NewDelivery, maxPending: number): boolean {
    if (this.pendingCount(delivery.tenantId) >= maxPending) {
      return false
    }
    this.insert.run(
      delivery.id,
      delivery.tenantId,
      delivery.endpointId,
      delivery.body,
      delivery.createdAt,
      delivery.createdAt,
    )
    return true
  }

  due(now: number, limit: number): Delivery[] {
    return (this.selectDue.all(now, limit) as unknown as Row[]).map(toDelivery)
  }

  markDone(id: string, now: number): void {
    this.done.run(now, id)
  }

  markRetry(id: string, nextAttemptAt: number, error: string): void {
    this.retryLater.run(nextAttemptAt, error, id)
  }

  markFailed(id: string, now: number, error: string): void {
    this.failed.run(now, error, id)
  }

  list(tenantId: string, options: { status?: DeliveryStatus; limit: number }): Delivery[] {
    const rows = options.status
      ? this.db
          .prepare(
            `SELECT * FROM webhook_deliveries WHERE tenant_id = ? AND status = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(tenantId, options.status, options.limit)
      : this.db
          .prepare('SELECT * FROM webhook_deliveries WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(tenantId, options.limit)
    return (rows as unknown as Row[]).map(toDelivery)
  }

  get(tenantId: string, id: string): Delivery | undefined {
    const row = this.selectOne.get(tenantId, id) as Row | undefined
    return row && toDelivery(row)
  }

  retry(tenantId: string, id: string, now: number): boolean {
    return Number(this.requeue.run(now, tenantId, id).changes) === 1
  }

  backlog(now: number): { pending: number; oldestDueAgeMs: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS pending, MIN(CASE WHEN next_attempt_at <= ? THEN next_attempt_at END) AS oldest
           FROM webhook_deliveries WHERE status = 'pending'`,
      )
      .get(now) as { pending: number; oldest: number | null }
    return { pending: Number(row.pending), oldestDueAgeMs: row.oldest === null ? 0 : now - Number(row.oldest) }
  }

  pendingCount(tenantId: string): number {
    return Number((this.countPending.get(tenantId) as { c: number }).c)
  }

  deleteTenant(tenantId: string): number {
    return Number(this.db.prepare('DELETE FROM webhook_deliveries WHERE tenant_id = ?').run(tenantId).changes)
  }

  deleteForRequests(tenantId: string, requestIds: readonly string[]): number {
    let removed = 0
    const statement = this.db.prepare('DELETE FROM webhook_deliveries WHERE tenant_id = ? AND instr(body, ?) > 0')
    for (const requestId of requestIds) {
      removed += Number(statement.run(tenantId, `"requestId":"${requestId}"`).changes)
    }
    return removed
  }

  purgeTenant(tenantId: string, doneBefore: number, failedBefore: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM webhook_deliveries
         WHERE tenant_id = ? AND ((status = 'done' AND finished_at < ?) OR (status = 'failed' AND finished_at < ?))`,
      )
      .run(tenantId, doneBefore, failedBefore)
    return Number(result.changes)
  }
}
