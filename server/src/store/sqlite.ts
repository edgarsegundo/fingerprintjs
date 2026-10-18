import { DatabaseSync, StatementSync } from 'node:sqlite'

import { EventStore, ListOptions, StoredEvent } from './types'

interface EventRow {
  request_id: string
  tenant_id: string
  received_at: number
  payload_json: string
  network_json: string
  derived_json: string
}

function toEvent(row: EventRow): StoredEvent {
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    receivedAt: row.received_at,
    payload: JSON.parse(row.payload_json),
    network: JSON.parse(row.network_json),
    derived: JSON.parse(row.derived_json),
  }
}

/**
 * Keeps events in a SQLite file, using the `node:sqlite` module that ships with Node.
 * That module is marked experimental by Node, which is why the store is behind the `EventStore` interface:
 * it can be replaced (for example by PostgreSQL in phase 3) without touching the rest of the server.
 *
 * The JSON of the payload and of the network signals is kept whole, so that later phases can re-read old events.
 * The columns next to it exist for the lookups that the next phases need.
 */
export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync

  /** The open database, so that other stores (the identity store) can keep their tables in the same file */
  get connection(): DatabaseSync {
    return this.db
  }
  private readonly insert: StatementSync
  private readonly select: StatementSync
  private readonly list: StatementSync
  private readonly deleteLinked: StatementSync
  private readonly insertNonce: StatementSync
  private readonly deleteEvents: StatementSync
  private readonly deleteNonces: StatementSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        request_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        ip TEXT NOT NULL,
        ja4 TEXT,
        header_fp TEXT NOT NULL,
        linked_id TEXT,
        payload_json TEXT NOT NULL,
        network_json TEXT NOT NULL,
        derived_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_tenant_time ON events (tenant_id, received_at);
      CREATE INDEX IF NOT EXISTS events_tenant_ja4 ON events (tenant_id, ja4);
      CREATE TABLE IF NOT EXISTS used_nonces (
        fingerprint TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS used_nonces_expiry ON used_nonces (expires_at);
    `)
    // Databases created before `linked_id` existed get the column added
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'linked_id')) {
      this.db.exec('ALTER TABLE events ADD COLUMN linked_id TEXT')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS events_tenant_linked ON events (tenant_id, linked_id)')
    this.insert = this.db.prepare(
      `INSERT INTO events
         (request_id, tenant_id, received_at, ip, ja4, header_fp, linked_id, payload_json, network_json, derived_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.deleteLinked = this.db.prepare('DELETE FROM events WHERE tenant_id = ? AND linked_id = ?')
    this.list = this.db.prepare(
      `SELECT * FROM events
       WHERE tenant_id = ? AND received_at >= ? AND received_at < ?
         AND (received_at > ? OR (received_at = ? AND request_id > ?))
       ORDER BY received_at, request_id
       LIMIT ?`,
    )
    this.select = this.db.prepare('SELECT * FROM events WHERE tenant_id = ? AND request_id = ?')
    this.insertNonce = this.db.prepare('INSERT OR IGNORE INTO used_nonces (fingerprint, expires_at) VALUES (?, ?)')
    this.deleteEvents = this.db.prepare('DELETE FROM events WHERE received_at < ?')
    this.deleteNonces = this.db.prepare('DELETE FROM used_nonces WHERE expires_at < ?')
  }

  insertEvent(event: StoredEvent): void {
    this.insert.run(
      event.requestId,
      event.tenantId,
      event.receivedAt,
      event.network.ip,
      event.network.tls?.ja4 ?? null,
      event.network.headers.fp,
      event.payload.linkedId ?? null,
      JSON.stringify(event.payload),
      JSON.stringify(event.network),
      JSON.stringify(event.derived),
    )
  }

  getEvent(tenantId: string, requestId: string): StoredEvent | undefined {
    const row = this.select.get(tenantId, requestId) as EventRow | undefined
    return row && toEvent(row)
  }

  listEvents(tenantId: string, options: ListOptions): StoredEvent[] {
    const { since = 0, until = Number.MAX_SAFE_INTEGER, after, limit } = options
    const rows = this.list.all(
      tenantId,
      since,
      until,
      after?.receivedAt ?? -1,
      after?.receivedAt ?? -1,
      after?.requestId ?? '',
      limit,
    ) as unknown as EventRow[]
    return rows.map(toEvent)
  }

  deleteByLinkedId(tenantId: string, linkedId: string): number {
    return Number(this.deleteLinked.run(tenantId, linkedId).changes)
  }

  consumeNonce(fingerprint: string, expiresAt: number): boolean {
    return Number(this.insertNonce.run(fingerprint, expiresAt).changes) === 1
  }

  purge(nowMs: number, retentionMs: number): { events: number; nonces: number } {
    return {
      events: Number(this.deleteEvents.run(nowMs - retentionMs).changes),
      nonces: Number(this.deleteNonces.run(nowMs).changes),
    }
  }

  close(): void {
    this.db.close()
  }
}
