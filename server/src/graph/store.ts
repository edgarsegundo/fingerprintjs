import type { DatabaseSync } from 'node:sqlite'

import type { MaybePromise } from '../async'

/** What the other tenants have seen of a device. Counts only: no event, no account, no address, no tenant name. */
export interface GraphSummary {
  /** In how many OTHER tenants the key was seen in the window */
  tenants: number
  /** In how many OTHER tenants a visit with this key was flagged in the window */
  flaggedTenants: number
}

export interface GraphStore {
  /** Notes that a tenant saw the key. `flagged` marks that the tenant considers the visit abusive. */
  record(key: string, tenantId: string, at: number, flagged: boolean): MaybePromise<void>
  /** What tenants other than `tenantId` saw since `since` */
  summary(key: string, tenantId: string, since: number): MaybePromise<GraphSummary>
  /** Forgets what the tenant contributed for these keys (a data subject request). Returns how many. */
  deleteKeys(tenantId: string, keys: readonly string[]): MaybePromise<number>
  /** Forgets everything the tenant contributed (it left). Returns how many. */
  deleteTenant(tenantId: string): MaybePromise<number>
  /** Forgets what was last seen before the time, for every tenant. Returns how many. */
  purge(before: number): MaybePromise<number>
}

interface Edge {
  lastSeen: number
  /** Last time a visit with this key was flagged by the tenant, or 0 */
  lastFlagged: number
}

export class MemoryGraphStore implements GraphStore {
  /** key, then tenant */
  private readonly edges = new Map<string, Map<string, Edge>>()

  record(key: string, tenantId: string, at: number, flagged: boolean): void {
    let tenants = this.edges.get(key)
    if (!tenants) {
      tenants = new Map()
      this.edges.set(key, tenants)
    }
    const edge = tenants.get(tenantId) ?? { lastSeen: 0, lastFlagged: 0 }
    edge.lastSeen = Math.max(edge.lastSeen, at)
    if (flagged) {
      edge.lastFlagged = Math.max(edge.lastFlagged, at)
    }
    tenants.set(tenantId, edge)
  }

  summary(key: string, tenantId: string, since: number): GraphSummary {
    let tenants = 0
    let flaggedTenants = 0
    for (const [other, edge] of this.edges.get(key) ?? []) {
      if (other === tenantId) {
        continue
      }
      if (edge.lastSeen >= since) {
        tenants++
      }
      if (edge.lastFlagged >= since && edge.lastFlagged > 0) {
        flaggedTenants++
      }
    }
    return { tenants, flaggedTenants }
  }

  deleteKeys(tenantId: string, keys: readonly string[]): number {
    let removed = 0
    for (const key of keys) {
      if (this.edges.get(key)?.delete(tenantId)) {
        removed++
      }
    }
    return removed
  }

  deleteTenant(tenantId: string): number {
    let removed = 0
    for (const tenants of this.edges.values()) {
      removed += tenants.delete(tenantId) ? 1 : 0
    }
    return removed
  }

  purge(before: number): number {
    let removed = 0
    for (const [key, tenants] of this.edges) {
      for (const [tenantId, edge] of tenants) {
        if (edge.lastSeen < before) {
          tenants.delete(tenantId)
          removed++
        }
      }
      if (tenants.size === 0) {
        this.edges.delete(key)
      }
    }
    return removed
  }
}

/** Keeps the edges in the same SQLite file as the events */
export class SqliteGraphStore implements GraphStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_edges (
        graph_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        last_flagged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (graph_key, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS graph_edges_tenant ON graph_edges (tenant_id);
      CREATE INDEX IF NOT EXISTS graph_edges_seen ON graph_edges (last_seen);
    `)
  }

  record(key: string, tenantId: string, at: number, flagged: boolean): void {
    this.db
      .prepare(
        `INSERT INTO graph_edges (graph_key, tenant_id, last_seen, last_flagged) VALUES (?, ?, ?, ?)
         ON CONFLICT (graph_key, tenant_id) DO UPDATE SET
           last_seen = MAX(last_seen, excluded.last_seen),
           last_flagged = MAX(last_flagged, excluded.last_flagged)`,
      )
      .run(key, tenantId, at, flagged ? at : 0)
  }

  summary(key: string, tenantId: string, since: number): GraphSummary {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(last_seen >= ?), 0) AS tenants,
                COALESCE(SUM(last_flagged >= ? AND last_flagged > 0), 0) AS flagged
           FROM graph_edges WHERE graph_key = ? AND tenant_id != ?`,
      )
      .get(since, since, key, tenantId) as { tenants: number; flagged: number }
    return { tenants: Number(row.tenants), flaggedTenants: Number(row.flagged) }
  }

  deleteKeys(tenantId: string, keys: readonly string[]): number {
    let removed = 0
    const statement = this.db.prepare('DELETE FROM graph_edges WHERE tenant_id = ? AND graph_key = ?')
    for (const key of keys) {
      removed += Number(statement.run(tenantId, key).changes)
    }
    return removed
  }

  deleteTenant(tenantId: string): number {
    return Number(this.db.prepare('DELETE FROM graph_edges WHERE tenant_id = ?').run(tenantId).changes)
  }

  purge(before: number): number {
    return Number(this.db.prepare('DELETE FROM graph_edges WHERE last_seen < ?').run(before).changes)
  }
}
