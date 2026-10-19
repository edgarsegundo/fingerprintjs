import type { MaybePromise } from '../async'
import type { CollectPayload } from '../ingest/validate'
import type { NetworkSignals } from '../net/signals'

export interface StoredEvent {
  /** Opaque id the browser receives. The backend of the customer uses it to read the event. */
  requestId: string
  tenantId: string
  receivedAt: number
  network: NetworkSignals
  payload: CollectPayload
  derived: {
    /** Server time minus the time the client says it collected. Large values mean a wrong or faked clock. */
    clockSkewMs: number
    /**
     * Whether the client that sent the payload looks like the one that fetched the challenge (same network, TLS stack
     * and user agent). `none` for a payload without a challenge.
     */
    nonceContext?: 'match' | 'mismatch' | 'none'
  }
}

export interface EventCursor {
  receivedAt: number
  requestId: string
}

export interface ListOptions {
  /** Events received at or after this time (ms) */
  since?: number
  /** Events received before this time (ms) */
  until?: number
  /** Continue after this event: the last one of the previous page */
  after?: EventCursor
  limit: number
  /** Only events that carry this `linkedId` */
  linkedId?: string
  /** Only events from this address */
  ip?: string
  /** Newest first. `after` then means "older than". The default is oldest first. */
  newestFirst?: boolean
}

/**
 * Where events and used nonces are kept. Every read is scoped to a tenant: there is no way to read an event
 * without saying whose it is.
 */
export interface EventStore {
  /** Throws if the storage cannot be used right now. For the readiness check. */
  ping(): MaybePromise<void>
  insertEvent(event: StoredEvent): MaybePromise<void>
  getEvent(tenantId: string, requestId: string): MaybePromise<StoredEvent | undefined>
  /** A page of the events of the tenant, oldest first, in a stable order (received time, then request id) */
  listEvents(tenantId: string, options: ListOptions): MaybePromise<StoredEvent[]>
  /** Deletes the events of the tenant with these request ids. Returns how many were deleted. */
  deleteEvents(tenantId: string, requestIds: readonly string[]): MaybePromise<number>
  /** Deletes every event of the tenant that carries the `linkedId`. Returns how many were deleted. */
  deleteByLinkedId(tenantId: string, linkedId: string): MaybePromise<number>
  /** Returns `false` if the nonce was already used. The check and the write are one atomic step. */
  consumeNonce(fingerprint: string, expiresAt: number): MaybePromise<boolean>
  /** Deletes the events of one tenant older than the retention period. Returns how many were deleted. */
  purgeTenant(tenantId: string, nowMs: number, retentionMs: number): MaybePromise<number>
  /** Deletes the nonces that expired. Returns how many were deleted. */
  purgeNonces(nowMs: number): MaybePromise<number>
  /** Deletes events older than the retention period and nonces that expired. Returns how many were deleted. */
  purge(nowMs: number, retentionMs: number): MaybePromise<{ events: number; nonces: number }>
  close(): MaybePromise<void>
}
