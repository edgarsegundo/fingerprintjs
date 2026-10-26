import {
  canonical,
  Link,
  linkOfRow,
  LinkKind,
  LinkRecord,
  LinkStatus,
  mergeRecord,
  movedLink,
  PersonStore,
} from '../person/store'

import type { MysqlDatabase, Queryable } from './database'

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

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const parts: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    parts.push(items.slice(i, i + size))
  }
  return parts
}

async function write(db: Queryable, tenantId: string, link: Link): Promise<void> {
  await db.run(
    `REPLACE INTO identity_links (tenant_id, a, b, kind, strength, first_seen, last_seen, days, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, link.a, link.b, link.kind, link.strength, link.firstSeen, link.lastSeen, link.days, link.status],
  )
}

async function read(db: Queryable, tenantId: string, a: string, b: string, kind: LinkKind): Promise<Link | undefined> {
  const [row] = await db.query<Row>(
    'SELECT * FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND kind = ? FOR UPDATE',
    [tenantId, a, b, kind],
  )
  return row && linkOfRow(row)
}

/** The ties between devices, in the MySQL database that the instances of the server share */
export class MysqlPersonStore implements PersonStore {
  constructor(private readonly db: MysqlDatabase) {}

  async record(tenantId: string, link: LinkRecord): Promise<boolean> {
    if (link.a === link.b) {
      return false
    }
    const [a, b] = canonical(link.a, link.b)
    return this.db.transaction(async (tx) => {
      const rejected = await tx.query(
        `SELECT 1 AS x FROM identity_links
          WHERE tenant_id = ? AND a = ? AND b = ? AND status = 'rejected' LIMIT 1 FOR UPDATE`,
        [tenantId, a, b],
      )
      if (rejected.length > 0) {
        return false
      }
      await write(tx, tenantId, mergeRecord(await read(tx, tenantId, a, b, link.kind), link))
      return true
    })
  }

  async linksOf(tenantId: string, deviceIds: readonly string[], limit: number): Promise<Link[]> {
    if (deviceIds.length === 0) {
      return []
    }
    const found = new Map<string, Link>()
    for (const ids of chunk(deviceIds, 200)) {
      const rows = await this.db.query<Row>(
        `SELECT * FROM identity_links WHERE tenant_id = ? AND (a IN (?) OR b IN (?))
          ORDER BY strength DESC, last_seen DESC LIMIT ?`,
        [tenantId, ids, ids, limit],
      )
      for (const row of rows) {
        found.set(`${row.a}\u0000${row.b}\u0000${row.kind}`, linkOfRow(row))
      }
    }
    return [...found.values()]
      .sort(
        (x, y) =>
          y.strength - x.strength ||
          y.lastSeen - x.lastSeen ||
          (`${x.a}${x.b}${x.kind}` < `${y.a}${y.b}${y.kind}` ? -1 : 1),
      )
      .slice(0, limit)
  }

  async decide(tenantId: string, a: string, b: string, status: LinkStatus, at: number): Promise<void> {
    const [x, y] = canonical(a, b)
    if (x === y) {
      return
    }
    await this.db.transaction(async (tx) => {
      if (status === 'auto') {
        await tx.run("DELETE FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND kind = 'manual'", [
          tenantId,
          x,
          y,
        ])
      } else {
        const existing = await read(tx, tenantId, x, y, 'manual')
        await write(tx, tenantId, {
          ...(existing ?? { a: x, b: y, kind: 'manual' as const, strength: 1, firstSeen: at, days: 1 }),
          lastSeen: at,
          status,
        })
      }
      await tx.run(
        "UPDATE identity_links SET status = ? WHERE tenant_id = ? AND a = ? AND b = ? AND kind != 'manual'",
        [status === 'rejected' ? 'rejected' : 'auto', tenantId, x, y],
      )
    })
  }

  async repoint(tenantId: string, from: string, to: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        'SELECT * FROM identity_links WHERE tenant_id = ? AND (a = ? OR b = ?) FOR UPDATE',
        [tenantId, from, from],
      )
      let moved = 0
      for (const row of rows) {
        const link = linkOfRow(row)
        await tx.run('DELETE FROM identity_links WHERE tenant_id = ? AND a = ? AND b = ? AND kind = ?', [
          tenantId,
          link.a,
          link.b,
          link.kind,
        ])
        const [a, b] = canonical(to, link.a === from ? link.b : link.a)
        const next = movedLink(link, from, to, await read(tx, tenantId, a, b, link.kind))
        if (next) {
          await write(tx, tenantId, next)
          moved++
        }
      }
      return moved
    })
  }

  async deleteDevices(tenantId: string, deviceIds: readonly string[]): Promise<number> {
    let removed = 0
    for (const ids of chunk(deviceIds, 200)) {
      removed += (
        await this.db.run('DELETE FROM identity_links WHERE tenant_id = ? AND (a IN (?) OR b IN (?))', [
          tenantId,
          ids,
          ids,
        ])
      ).affected
    }
    return removed
  }

  async purgeTenant(tenantId: string, before: number): Promise<number> {
    return (await this.db.run('DELETE FROM identity_links WHERE tenant_id = ? AND last_seen < ?', [tenantId, before]))
      .affected
  }

  async deleteTenant(tenantId: string): Promise<number> {
    return (await this.db.run('DELETE FROM identity_links WHERE tenant_id = ?', [tenantId])).affected
  }
}
