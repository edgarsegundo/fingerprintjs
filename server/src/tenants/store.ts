import type { DatabaseSync } from 'node:sqlite'

import type { MaybePromise } from '../async'

export type TenantStatus = 'active' | 'suspended'

/** A tenant that was created through the admin API, as it is kept */
export interface TenantRecord {
  id: string
  name?: string
  publicKey: string
  /** SHA-256 (hex) of each valid secret key. The secrets themselves are never kept. */
  secretKeySha256: string[]
  allowedOrigins: string[]
  /** A name from `plans` of the configuration, or none */
  plan?: string
  /** Settings of this tenant only, in the shape of the `settings` of a tenant in the configuration file */
  settings: Record<string, unknown>
  status: TenantStatus
  createdAt: number
  updatedAt: number
}

/** Where the tenants made through the admin API are kept */
export interface TenantStore {
  list(): MaybePromise<TenantRecord[]>
  get(id: string): MaybePromise<TenantRecord | undefined>
  /** Adds a tenant. Throws if the id or the public key is already taken. */
  create(record: TenantRecord): MaybePromise<void>
  /** Replaces the tenant with the same id. Throws if it does not exist. */
  update(record: TenantRecord): MaybePromise<void>
  /** Returns `false` if there was no such tenant */
  delete(id: string): MaybePromise<boolean>
}

export class MemoryTenantStore implements TenantStore {
  private readonly records = new Map<string, TenantRecord>()

  list(): TenantRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map(copy)
  }

  get(id: string): TenantRecord | undefined {
    const record = this.records.get(id)
    return record && copy(record)
  }

  create(record: TenantRecord): void {
    if (this.records.has(record.id) || [...this.records.values()].some((r) => r.publicKey === record.publicKey)) {
      throw new Error('The tenant id or the public key is already in use')
    }
    this.records.set(record.id, copy(record))
  }

  update(record: TenantRecord): void {
    if (!this.records.has(record.id)) {
      throw new Error('No such tenant')
    }
    this.records.set(record.id, copy(record))
  }

  delete(id: string): boolean {
    return this.records.delete(id)
  }
}

const copy = (record: TenantRecord): TenantRecord => structuredClone(record)

interface Row {
  id: string
  public_key: string
  record_json: string
}

/** Keeps the tenants in the same SQLite file as the events */
export class SqliteTenantStore implements TenantStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  list(): TenantRecord[] {
    const rows = this.db.prepare('SELECT * FROM tenants ORDER BY created_at, id').all() as unknown as Row[]
    return rows.map((row) => JSON.parse(row.record_json) as TenantRecord)
  }

  get(id: string): TenantRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Row | undefined
    return row && (JSON.parse(row.record_json) as TenantRecord)
  }

  create(record: TenantRecord): void {
    // The primary key and the unique index make the database refuse a repeated id or public key
    try {
      this.db
        .prepare('INSERT INTO tenants (id, public_key, record_json, created_at) VALUES (?, ?, ?, ?)')
        .run(record.id, record.publicKey, JSON.stringify(record), record.createdAt)
    } catch {
      throw new Error('The tenant id or the public key is already in use')
    }
  }

  update(record: TenantRecord): void {
    const result = this.db
      .prepare('UPDATE tenants SET public_key = ?, record_json = ? WHERE id = ?')
      .run(record.publicKey, JSON.stringify(record), record.id)
    if (Number(result.changes) !== 1) {
      throw new Error('No such tenant')
    }
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id).changes) === 1
  }
}
