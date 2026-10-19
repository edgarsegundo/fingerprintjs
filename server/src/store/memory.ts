import { EventStore, ListOptions, StoredEvent } from './types'

/** Keeps everything in memory. For tests and for trying the server; everything is lost when the process ends. */
export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, StoredEvent>()
  private readonly nonces = new Map<string, number>()

  ping(): void {
    // Memory is always there
  }

  insertEvent(event: StoredEvent): void {
    if (this.events.has(event.requestId)) {
      throw new Error('duplicate requestId')
    }
    // Stored as a copy so that later changes by the caller can't change the record
    this.events.set(event.requestId, structuredClone(event))
  }

  getEvent(tenantId: string, requestId: string): StoredEvent | undefined {
    const event = this.events.get(requestId)
    return event && event.tenantId === tenantId ? structuredClone(event) : undefined
  }

  listEvents(tenantId: string, options: ListOptions): StoredEvent[] {
    const { since = 0, until = Number.MAX_SAFE_INTEGER, after, limit, linkedId, ip, newestFirst = false } = options
    const sign = newestFirst ? -1 : 1
    return [...this.events.values()]
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.receivedAt >= since &&
          event.receivedAt < until &&
          (linkedId === undefined || event.payload.linkedId === linkedId) &&
          (ip === undefined || event.network.ip === ip),
      )
      .sort(
        (a, b) =>
          sign * (a.receivedAt - b.receivedAt) ||
          sign * (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0),
      )
      .filter(
        (event) =>
          !after ||
          sign * event.receivedAt > sign * after.receivedAt ||
          (event.receivedAt === after.receivedAt &&
            event.requestId !== after.requestId &&
            sign * (event.requestId > after.requestId ? 1 : -1) > 0),
      )
      .slice(0, limit)
      .map((event) => structuredClone(event))
  }

  deleteEvents(tenantId: string, requestIds: readonly string[]): number {
    let deleted = 0
    for (const id of requestIds) {
      if (this.events.get(id)?.tenantId === tenantId) {
        this.events.delete(id)
        deleted++
      }
    }
    return deleted
  }

  deleteByLinkedId(tenantId: string, linkedId: string): number {
    let deleted = 0
    for (const [id, event] of this.events) {
      if (event.tenantId === tenantId && event.payload.linkedId === linkedId) {
        this.events.delete(id)
        deleted++
      }
    }
    return deleted
  }

  consumeNonce(fingerprint: string, expiresAt: number): boolean {
    if (this.nonces.has(fingerprint)) {
      return false
    }
    this.nonces.set(fingerprint, expiresAt)
    return true
  }

  purgeTenant(tenantId: string, nowMs: number, retentionMs: number): number {
    let deleted = 0
    for (const [id, event] of this.events) {
      if (event.tenantId === tenantId && event.receivedAt < nowMs - retentionMs) {
        this.events.delete(id)
        deleted++
      }
    }
    return deleted
  }

  purgeNonces(nowMs: number): number {
    let deleted = 0
    for (const [fingerprint, expiresAt] of this.nonces) {
      if (expiresAt < nowMs) {
        this.nonces.delete(fingerprint)
        deleted++
      }
    }
    return deleted
  }

  purge(nowMs: number, retentionMs: number): { events: number; nonces: number } {
    let events = 0
    let nonces = 0
    for (const [id, event] of this.events) {
      if (event.receivedAt < nowMs - retentionMs) {
        this.events.delete(id)
        events++
      }
    }
    for (const [fingerprint, expiresAt] of this.nonces) {
      if (expiresAt < nowMs) {
        this.nonces.delete(fingerprint)
        nonces++
      }
    }
    return { events, nonces }
  }

  close(): void {
    this.events.clear()
    this.nonces.clear()
  }
}
