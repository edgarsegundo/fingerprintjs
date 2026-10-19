import { version } from '../../package.json'
import { UnknownComponents } from '../utils/entropy_source'

/**
 * Version of the payload shape. It must be bumped on every incompatible change.
 * The server must reject versions it doesn't know instead of guessing.
 */
export const PAYLOAD_SCHEMA_VERSION = 1

/** Longest error message that is sent to the server, to keep the payload small and free of page content */
const maxErrorMessageLength = 200

/**
 * One signal in the payload.
 * - `value` is present when the source succeeded with a defined value;
 * - `error` is present when the source failed;
 * - when both are absent, the source succeeded and returned `undefined` (e.g. the API isn't supported).
 *
 * Note: the payload is JSON, so `NaN` and `Infinity` arrive as `null`.
 */
export type SerializedComponent = {
  value?: unknown
  error?: { name: string; message: string }
  /** How long the source took in milliseconds */
  duration: number
}

export interface ConsentStatement {
  /** The legal basis the page relies on */
  basis: 'consent' | 'legitimate_interest' | 'contract' | 'other'
  /** The version of the privacy text that the visitor saw or accepted, such as `2026-10` */
  version: string
}

/**
 * The raw signals sent to the server.
 *
 * The client deliberately doesn't compute a visitor identifier: the server decides which identifier a visit gets,
 * so a tampered client can't pick its own identity.
 */
export interface CollectPayload {
  schema: typeof PAYLOAD_SCHEMA_VERSION
  libVersion: string
  /** Client clock, `Date.now()`. Untrusted; useful for clock skew analysis only. */
  collectedAt: number
  /** How long collecting took in milliseconds */
  durationMs: number
  /** The server-issued challenge echoed back (anti-replay). The server validates it. */
  nonce?: string
  /**
   * An opaque identifier chosen by the website, such as an internal account id or a test device name.
   * The server stores it with the event, which lets the website find the visits of one of its own users and lets the
   * evaluation tools know which visits really belong together.
   */
  linkedId?: string
  /**
   * What the page says about the legal basis for this collection. It is a statement of the page, kept with the visit so
   * that it can be audited later; the browser cannot prove it. A server may refuse visits that do not carry consent.
   */
  consent?: ConsentStatement
  /** The built-in entropy sources of the library. Same keys and values as `GetResult.components`. */
  components: Record<string, SerializedComponent>
  /** The extra signals that exist only in the collector (`src/collector/sources`) */
  extended: Record<string, SerializedComponent>
}

function serializeError(error: unknown): NonNullable<SerializedComponent['error']> {
  // The stack isn't sent: it may contain file paths and URLs of the page
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, maxErrorMessageLength) }
  }
  return { name: 'Error', message: String(error).slice(0, maxErrorMessageLength) }
}

export function serializeComponents(components: UnknownComponents): Record<string, SerializedComponent> {
  const result: Record<string, SerializedComponent> = {}
  for (const key of Object.keys(components)) {
    const component = components[key]
    const { duration } = component
    if ('error' in component) {
      result[key] = { error: serializeError(component.error), duration }
    } else if (component.value === undefined) {
      result[key] = { duration }
    } else {
      result[key] = { value: component.value, duration }
    }
  }
  return result
}

export function makePayload(
  parts: Pick<CollectPayload, 'components' | 'extended' | 'nonce' | 'linkedId' | 'consent'>,
  startedAt: number,
): CollectPayload {
  const payload: CollectPayload = {
    schema: PAYLOAD_SCHEMA_VERSION,
    libVersion: version,
    collectedAt: startedAt,
    durationMs: Date.now() - startedAt,
    components: parts.components,
    extended: parts.extended,
  }
  if (parts.nonce !== undefined) {
    payload.nonce = parts.nonce
  }
  if (parts.linkedId !== undefined) {
    payload.linkedId = parts.linkedId
  }
  if (parts.consent !== undefined) {
    payload.consent = parts.consent
  }
  return payload
}
