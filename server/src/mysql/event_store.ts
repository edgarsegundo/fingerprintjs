import type { EventStore, ListOptions, StoredEvent } from '../store/types'

import type { MysqlDatabase } from './database'

interface Row {
  request_id: string
  tenant_id: string
  received_at: number
  payload_json: string
  network_json: string
  derived_json: string
}

function toEvent(row: Row): StoredEvent {
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    receivedAt: Number(row.received_at),
    payload: JSON.parse(row.payload_json),
    network: JSON.parse(row.network_json),
    derived: JSON.parse(row.derived_json),
  }
}

/** A statement can carry only so many parameters; a long list of ids is sent in pieces */
const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const pieces: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    pieces.push(items.slice(start, start + size))
  }
  return pieces
}

/** Events and used nonces in MySQL. Same contract as the SQLite and memory stores. */
export class MysqlEventStore implements EventStore {
  constructor(private readonly db: MysqlDatabase) {}

  async ping(): Promise<void> {
    await this.db.query('SELECT 1')
  }

  async insertEvent(event: StoredEvent): Promise<void> {
    await this.db.run(
      `INSERT INTO events
         (request_id, tenant_id, received_at, ip, ja4, header_fp, linked_id, payload_json, network_json, derived_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    )
  }

  async getEvent(tenantId: string, requestId: string): Promise<StoredEvent | undefined> {
    const rows = await this.db.query<Row>('SELECT * FROM events WHERE tenant_id = ? AND request_id = ?', [
      tenantId,
      requestId,
    ])
    return rows[0] && toEvent(rows[0])
  }

  async listEvents(tenantId: string, options: ListOptions): Promise<StoredEvent[]> {
    const { since = 0, until = Number.MAX_SAFE_INTEGER, after, limit, linkedId, ip, newestFirst = false } = options
    const where = ['tenant_id = ?', 'received_at >= ?', 'received_at < ?']
    const values: unknown[] = [tenantId, since, until]
    if (linkedId !== undefined) {
      where.push('linked_id = ?')
      values.push(linkedId)
    }
    if (ip !== undefined) {
      where.push('ip = ?')
      values.push(ip)
    }
    if (after) {
      const comparison = newestFirst ? '<' : '>'
      where.push(`(received_at ${comparison} ? OR (received_at = ? AND request_id ${comparison} ?))`)
      values.push(after.receivedAt, after.receivedAt, after.requestId)
    }
    const direction = newestFirst ? 'DESC' : 'ASC'
    // The conditions are fixed text; every value goes in as a parameter
    const rows = await this.db.query<Row>(
      `SELECT * FROM events WHERE ${where.join(' AND ')}
       ORDER BY received_at ${direction}, request_id ${direction} LIMIT ?`,
      [...values, limit],
    )
    return rows.map(toEvent)
  }

  async deleteEvents(tenantId: string, requestIds: readonly string[]): Promise<number> {
    let deleted = 0
    for (const ids of chunk(requestIds, 500)) {
      deleted += (await this.db.run('DELETE FROM events WHERE tenant_id = ? AND request_id IN (?)', [tenantId, ids]))
        .affected
    }
    return deleted
  }

  async deleteByLinkedId(tenantId: string, linkedId: string): Promise<number> {
    return (await this.db.run('DELETE FROM events WHERE tenant_id = ? AND linked_id = ?', [tenantId, linkedId]))
      .affected
  }

  async consumeNonce(fingerprint: string, expiresAt: number): Promise<boolean> {
    // The primary key makes the second use of a nonce add nothing, in one step with the check
    return (
      (
        await this.db.run('INSERT IGNORE INTO used_nonces (fingerprint, expires_at) VALUES (?, ?)', [
          fingerprint,
          expiresAt,
        ])
      ).affected === 1
    )
  }

  async purgeTenant(tenantId: string, nowMs: number, retentionMs: number): Promise<number> {
    return (
      await this.db.run('DELETE FROM events WHERE tenant_id = ? AND received_at < ?', [tenantId, nowMs - retentionMs])
    ).affected
  }

  async purgeNonces(nowMs: number): Promise<number> {
    return (await this.db.run('DELETE FROM used_nonces WHERE expires_at < ?', [nowMs])).affected
  }

  async purge(nowMs: number, retentionMs: number): Promise<{ events: number; nonces: number }> {
    return {
      events: (await this.db.run('DELETE FROM events WHERE received_at < ?', [nowMs - retentionMs])).affected,
      nonces: await this.purgeNonces(nowMs),
    }
  }

  close(): void {
    // The connection belongs to the storage, which closes it once for all the stores
  }
}
