import type { DatabaseSync } from 'node:sqlite'

import type { MaybePromise } from '../async'

/**
 * Why two devices are tied together:
 * - linked_id: both had a visit with the same account id (the tenant's `linkedId`)
 * - same_machine: the same machine in two browsers (`identity.sameMachine`)
 * - network: they came from the same address a short while apart (evidence, a family shares an address)
 * - possible_link: one was the closest device that the other was not joined to
 * - manual: a person tied them
 */
export type LinkKind = 'linked_id' | 'same_machine' | 'network' | 'possible_link' | 'manual'

export const linkKinds: readonly LinkKind[] = ['linked_id', 'same_machine', 'network', 'possible_link', 'manual']

/** `auto` came from the engine; `confirmed` and `rejected` are a person's decision (D85), and `rejected` is final */
export type LinkStatus = 'auto' | 'confirmed' | 'rejected'

export interface Link {
  /** The pair is canonical: `a < b` */
  a: string
  b: string
  kind: LinkKind
  /** How strong: log-odds for same_machine and possible_link, 1 for the rest. Not calibrated. */
  strength: number
  firstSeen: number
  lastSeen: number
  /** On how many different days the tie was seen */
  days: number
  status: LinkStatus
}

export interface LinkRecord {
  a: string
  b: string
  kind: LinkKind
  strength: number
  at: number
}

const dayOf = (at: number) => Math.floor(at / 86_400_000)

export function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/**
 * The ties between the devices of a tenant. A person is never stored: it is the set of devices that the ties reach,
 * worked
 * out when it is read (`cluster.ts`), so there is no group to keep right when a device is merged, erased or expires.
 */
export interface PersonStore {
  /**
   * Notes a tie. An existing tie keeps its status and gets the stronger strength and the later time; a new day adds to
   * `days`. A pair that a person rejected stays rejected and gets nothing new. Returns false if nothing was written.
   */
  record(tenantId: string, link: LinkRecord): MaybePromise<boolean>
  /** Ties that touch any of the devices (at most `limit`, the strongest and most recent first) */
  linksOf(tenantId: string, deviceIds: readonly string[], limit: number): MaybePromise<Link[]>
  /**
   * A person's decision about a pair. `rejected` and `confirmed` are kept as a `manual` tie of their own, so they exist
   * even when the engine never tied the pair, and `rejected` also marks every other tie of the pair. `auto` takes the
   * decision back: it deletes the manual tie and sets the other ties of the pair to `auto`.
   */
  decide(tenantId: string, a: string, b: string, status: LinkStatus, at: number): MaybePromise<void>
  /** A device was merged into another: its ties follow it. Ties between the two are dropped. Returns how many moved. */
  repoint(tenantId: string, from: string, to: string): MaybePromise<number>
  /** Forgets every tie of these devices (a data subject request). Returns how many. */
  deleteDevices(tenantId: string, deviceIds: readonly string[]): MaybePromise<number>
  /** Forgets the ties of a tenant that were last seen before the time (retention). Returns how many. */
  purgeTenant(tenantId: string, before: number): MaybePromise<number>
  /** Forgets everything of a tenant (it left). Returns how many. */
  deleteTenant(tenantId: string): MaybePromise<number>
}

const keyOf = (a: string, b: string, kind: LinkKind) => `${a}\u0000${b}\u0000${kind}`

/** The result of noting a tie into what is already there. One place, so that every store behaves the same. */
export function mergeRecord(existing: Link | undefined, link: LinkRecord): Link {
  const [a, b] = canonical(link.a, link.b)
  if (!existing) {
    return {
      a,
      b,
      kind: link.kind,
      strength: link.strength,
      firstSeen: link.at,
      lastSeen: link.at,
      days: 1,
      status: 'auto',
    }
  }
  return {
    ...existing,
    strength: Math.max(existing.strength, link.strength),
    firstSeen: Math.min(existing.firstSeen, link.at),
    lastSeen: Math.max(existing.lastSeen, link.at),
    days:
      dayOf(link.at) !== dayOf(existing.lastSeen) && link.at > existing.lastSeen ? existing.days + 1 : existing.days,
  }
}

/**
 * What a tie becomes when `from` is merged into `to`, joined with the tie that the target already has (if any).
 * `undefined`
 * when the tie was between the two devices, which are now one. A rejection survives the move.
 */
export function movedLink(link: Link, from: string, to: string, existing: Link | undefined): Link | undefined {
  const other = link.a === from ? link.b : link.a
  if (other === to) {
    return undefined
  }
  const [a, b] = canonical(to, other)
  return {
    ...(existing ?? link),
    a,
    b,
    strength: Math.max(existing?.strength ?? 0, link.strength),
    firstSeen: Math.min(existing?.firstSeen ?? link.firstSeen, link.firstSeen),
    lastSeen: Math.max(existing?.lastSeen ?? 0, link.lastSeen),
    days: Math.max(existing?.days ?? 0, link.days),
    status:
      existing?.status === 'rejected' || link.status === 'rejected' ? 'rejected' : existing?.status ?? link.status,
  }
}

export class MemoryPersonStore implements PersonStore {
  private readonly tenants = new Map<string, Map<string, Link>>()

  private links(tenantId: string): Map<string, Link> {
    let links = this.tenants.get(tenantId)
    if (!links) {
      links = new Map()
      this.tenants.set(tenantId, links)
    }
    return links
  }

  private rejected(tenantId: string, a: string, b: string): boolean {
    return [...this.links(tenantId).values()].some((link) => link.a === a && link.b === b && link.status === 'rejected')
  }

  record(tenantId: string, link: LinkRecord): boolean {
    if (link.a === link.b) {
      return false
    }
    const [a, b] = canonical(link.a, link.b)
    if (this.rejected(tenantId, a, b)) {
      return false
    }
    const links = this.links(tenantId)
    const key = keyOf(a, b, link.kind)
    links.set(key, mergeRecord(links.get(key), link))
    return true
  }

  linksOf(tenantId: string, deviceIds: readonly string[], limit: number): Link[] {
    const wanted = new Set(deviceIds)
    return [...this.links(tenantId).values()]
      .filter((link) => wanted.has(link.a) || wanted.has(link.b))
      .sort(
        (x, y) =>
          y.strength - x.strength ||
          y.lastSeen - x.lastSeen ||
          (keyOf(x.a, x.b, x.kind) < keyOf(y.a, y.b, y.kind) ? -1 : 1),
      )
      .slice(0, limit)
      .map((link) => ({ ...link }))
  }

  decide(tenantId: string, a: string, b: string, status: LinkStatus, at: number): void {
    const [x, y] = canonical(a, b)
    if (x === y) {
      return
    }
    const links = this.links(tenantId)
    const manualKey = keyOf(x, y, 'manual')
    if (status === 'auto') {
      links.delete(manualKey)
    } else {
      links.set(manualKey, {
        ...(links.get(manualKey) ?? { a: x, b: y, kind: 'manual', strength: 1, firstSeen: at, days: 1 }),
        lastSeen: at,
        status,
      } as Link)
    }
    for (const link of links.values()) {
      if (link.a === x && link.b === y && link.kind !== 'manual') {
        link.status = status === 'rejected' ? 'rejected' : 'auto'
      }
    }
  }

  repoint(tenantId: string, from: string, to: string): number {
    const links = this.links(tenantId)
    let moved = 0
    for (const [key, link] of [...links]) {
      if (link.a !== from && link.b !== from) {
        continue
      }
      links.delete(key)
      const [a, b] = canonical(to, link.a === from ? link.b : link.a)
      const target = keyOf(a, b, link.kind)
      const next = movedLink(link, from, to, links.get(target))
      if (next) {
        links.set(target, next)
        moved++
      }
    }
    return moved
  }

  deleteDevices(tenantId: string, deviceIds: readonly string[]): number {
    const gone = new Set(deviceIds)
    let removed = 0
    for (const [key, link] of [...this.links(tenantId)]) {
      if (gone.has(link.a) || gone.has(link.b)) {
        this.links(tenantId).delete(key)
        removed++
      }
    }
    return removed
  }

  purgeTenant(tenantId: string, before: number): number {
    let removed = 0
    for (const [key, link] of [...this.links(tenantId)]) {
      if (link.lastSeen < before) {
        this.links(tenantId).delete(key)
        removed++
      }
    }
    return removed
  }

  deleteTenant(tenantId: string): number {
    const removed = this.tenants.get(tenantId)?.size ?? 0
    this.tenants.delete(tenantId)
    return removed
  }
}

interface Row {
  a: string
  b: string
  kind: LinkKind
  strength: number
  first_seen: number
  last_seen: number
  days: number
  status: LinkStatus
}

export const linkOfRow = (row: Row): Link => ({
  a: row.a,
  b: row.b,
  kind: row.kind,
  strength: Number(row.strength),
  firstSeen: Number(row.first_seen),
  lastSeen: Number(row.last_seen),
  days: Number(row.days),
  status: row.status,
})

/** Keeps the ties in the same SQLite file as the events */
export class SqlitePersonStore implements PersonStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_links (
        tenant_id TEXT NOT NULL,
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        kind TEXT NOT NULL,
        strength REAL NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        days INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'auto',
        PRIMARY KEY (tenant_id, a, b, kind)
      );
      CREATE INDEX IF NOT EXISTS identity_links_b ON identity_links (tenant_id, b);
      CREATE INDEX IF NOT EXISTS identity_links_seen ON identity_links (tenant_id, last_seen);
    `)
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private get(tenantId: string, a: string, b: string, kind: LinkKind): Link | undefined {
    const row = this.db
      .prepare('SELECT * FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND kind = ?')
      .get(tenantId, a, b, kind) as Row | undefined
    return row && linkOfRow(row)
  }

  private write(tenantId: string, link: Link): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO identity_links (tenant_id, a, b, kind, strength, first_seen, last_seen, days, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tenantId, link.a, link.b, link.kind, link.strength, link.firstSeen, link.lastSeen, link.days, link.status)
  }

  record(tenantId: string, link: LinkRecord): boolean {
    if (link.a === link.b) {
      return false
    }
    const [a, b] = canonical(link.a, link.b)
    return this.transaction(() => {
      const rejected = this.db
        .prepare(
          "SELECT 1 AS x FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND status = 'rejected' LIMIT 1",
        )
        .get(tenantId, a, b)
      if (rejected) {
        return false
      }
      this.write(tenantId, mergeRecord(this.get(tenantId, a, b, link.kind), link))
      return true
    })
  }

  linksOf(tenantId: string, deviceIds: readonly string[], limit: number): Link[] {
    const found = new Map<string, Link>()
    const statement = this.db.prepare(
      `SELECT * FROM identity_links WHERE tenant_id = ? AND (a = ? OR b = ?)
        ORDER BY strength DESC, last_seen DESC LIMIT ?`,
    )
    for (const id of deviceIds) {
      for (const row of statement.all(tenantId, id, id, limit) as unknown as Row[]) {
        found.set(keyOf(row.a, row.b, row.kind), linkOfRow(row))
      }
    }
    return [...found.values()]
      .sort(
        (x, y) =>
          y.strength - x.strength ||
          y.lastSeen - x.lastSeen ||
          (keyOf(x.a, x.b, x.kind) < keyOf(y.a, y.b, y.kind) ? -1 : 1),
      )
      .slice(0, limit)
  }

  decide(tenantId: string, a: string, b: string, status: LinkStatus, at: number): void {
    const [x, y] = canonical(a, b)
    if (x === y) {
      return
    }
    this.transaction(() => {
      if (status === 'auto') {
        this.db
          .prepare("DELETE FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND kind = 'manual'")
          .run(tenantId, x, y)
      } else {
        const existing = this.get(tenantId, x, y, 'manual')
        this.write(tenantId, {
          ...(existing ?? { a: x, b: y, kind: 'manual' as const, strength: 1, firstSeen: at, days: 1 }),
          lastSeen: at,
          status,
        })
      }
      this.db
        .prepare("UPDATE identity_links SET status = ? WHERE tenant_id = ? AND a = ? AND b = ? AND kind != 'manual'")
        .run(status === 'rejected' ? 'rejected' : 'auto', tenantId, x, y)
    })
  }

  repoint(tenantId: string, from: string, to: string): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare('SELECT * FROM identity_links WHERE tenant_id = ? AND (a = ? OR b = ?)')
        .all(tenantId, from, from) as unknown as Row[]
      let moved = 0
      for (const row of rows) {
        const link = linkOfRow(row)
        this.db
          .prepare('DELETE FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND kind = ?')
          .run(tenantId, link.a, link.b, link.kind)
        const [a, b] = canonical(to, link.a === from ? link.b : link.a)
        const next = movedLink(link, from, to, this.get(tenantId, a, b, link.kind))
        if (next) {
          this.write(tenantId, next)
          moved++
        }
      }
      return moved
    })
  }

  deleteDevices(tenantId: string, deviceIds: readonly string[]): number {
    let removed = 0
    const statement = this.db.prepare('DELETE FROM identity_links WHERE tenant_id = ? AND (a = ? OR b = ?)')
    for (const id of deviceIds) {
      removed += Number(statement.run(tenantId, id, id).changes)
    }
    return removed
  }

  purgeTenant(tenantId: string, before: number): number {
    return Number(
      this.db.prepare('DELETE FROM identity_links WHERE tenant_id = ? AND last_seen < ?').run(tenantId, before).changes,
    )
  }

  deleteTenant(tenantId: string): number {
    return Number(this.db.prepare('DELETE FROM identity_links WHERE tenant_id = ?').run(tenantId).changes)
  }
}
