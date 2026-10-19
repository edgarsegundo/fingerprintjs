import type { DatabaseSync } from 'node:sqlite'

import type { MaybePromise } from '../async'

/** What was done with the data through the API. The content that was read is never written here. */
export type AuditAction =
  | 'event.read'
  | 'events.list'
  | 'visitor.read'
  | 'visitor.delete'
  | 'visitor.merge'
  | 'visitor.split'
  | 'subject.export'
  | 'subject.delete'
  | 'deliveries.list'
  | 'delivery.retry'
  | 'audit.read'
  | 'usage.read'
  | 'drift.read'
  | 'anonymity.read'
  | 'admin.tenant.create'
  | 'admin.tenant.update'
  | 'admin.key.add'
  | 'admin.key.revoke'

export interface AuditEntry {
  /** Sort key: time, then the sequence number */
  seq: number
  at: number
  tenantId: string
  action: AuditAction
  /** What was asked for, such as a request id, a visitor id or a linked id. Empty for a list. */
  subject: string
  /** Which secret key was used: the first characters of its hash. Never the key. */
  keyId: string
  /** A keyed hash of the address of the caller, so that two accesses from one place can be seen to be the same */
  requester: string
  /** The HTTP status of the answer */
  status: number
}

export type NewAuditEntry = Omit<AuditEntry, 'seq'>

export interface AuditQuery {
  since?: number
  until?: number
  /** Continue after this entry (the `seq` of the last one of the previous page), going back in time */
  before?: number
  limit: number
}

export interface AuditLog {
  record(entry: NewAuditEntry): MaybePromise<void>
  /** The entries of one tenant, newest first */
  list(tenantId: string, query: AuditQuery): MaybePromise<AuditEntry[]>
  /** Deletes the entries of the tenant older than the time. Returns how many. */
  purgeTenant(tenantId: string, before: number): MaybePromise<number>
}

export class MemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = []
  private seq = 0

  record(entry: NewAuditEntry): void {
    this.entries.push({ ...entry, seq: ++this.seq })
  }

  list(tenantId: string, query: AuditQuery): AuditEntry[] {
    return this.entries
      .filter(
        (entry) =>
          entry.tenantId === tenantId &&
          entry.at >= (query.since ?? 0) &&
          entry.at < (query.until ?? Number.MAX_SAFE_INTEGER) &&
          entry.seq < (query.before ?? Number.MAX_SAFE_INTEGER),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, query.limit)
      .map((entry) => ({ ...entry }))
  }

  purgeTenant(tenantId: string, before: number): number {
    const keep = this.entries.filter((entry) => entry.tenantId !== tenantId || entry.at >= before)
    const removed = this.entries.length - keep.length
    this.entries.length = 0
    this.entries.push(...keep)
    return removed
  }
}

interface Row {
  seq: number
  at: number
  tenant_id: string
  action: AuditAction
  subject: string
  key_id: string
  requester: string
  status: number
}

/** Keeps the entries in the same SQLite file as the events */
export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT NOT NULL,
        key_id TEXT NOT NULL,
        requester TEXT NOT NULL,
        status INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_tenant ON audit_log (tenant_id, seq);
    `)
  }

  record(entry: NewAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (at, tenant_id, action, subject, key_id, requester, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.at, entry.tenantId, entry.action, entry.subject, entry.keyId, entry.requester, entry.status)
  }

  list(tenantId: string, query: AuditQuery): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log WHERE tenant_id = ? AND at >= ? AND at < ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        tenantId,
        query.since ?? 0,
        query.until ?? Number.MAX_SAFE_INTEGER,
        query.before ?? Number.MAX_SAFE_INTEGER,
        query.limit,
      ) as unknown as Row[]
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

  purgeTenant(tenantId: string, before: number): number {
    const result = this.db.prepare('DELETE FROM audit_log WHERE tenant_id = ? AND at < ?').run(tenantId, before)
    return Number(result.changes)
  }
}
