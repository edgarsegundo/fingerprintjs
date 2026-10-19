import { prepareForSources } from '../agent'
import { sources } from '../sources'
import { loadSources, UnknownComponents } from '../utils/entropy_source'

import { CollectPayload, ConsentStatement, makePayload, serializeComponents } from './payload'
import { extendedSources, optInSourceNames } from './sources'
import { defaultStoredIdName, storedIdNamePattern } from './sources/stored_id'
import { send, SendOptions, SendResult } from './transport'

/**
 * Options of collecting signals
 */
export interface CollectOptions {
  /**
   * A one-time challenge issued by your server. It is echoed in the payload so that the server can reject
   * a payload that was captured and replayed. Without it, the payload can be replayed.
   */
  nonce?: string
  /**
   * An opaque identifier of your own, up to 128 characters of letters, digits and `_ - . :` (an e-mail address is
   * refused on purpose). Use an internal id, never a name, e-mail, phone or document number.
   * The server stores it with the event.
   */
  linkedId?: string
  /**
   * The legal basis you rely on and the version of the privacy text the visitor saw. It is stored with the visit. A
   * server set to require consent refuses a visit whose `basis` is not `consent`. Collect only after the visitor agreed
   * when your basis is consent: this option records the decision, it does not make it.
   */
  consent?: Readonly<ConsentStatement>
  /**
   * The names of signals not to collect, from both `components` and `extended` of the payload.
   * Use it to collect less (data minimization) or to skip a signal that conflicts with your page,
   * for example `workerContext` when the Content Security Policy forbids `blob:` workers.
   */
  exclude?: readonly string[]
  /**
   * The names of signals that are off by default and must be collected. Today: `webGpu`, which makes Chrome print
   * a console message on machines without a usable GPU, and `behavior`, a count of interactions (see
   * `observeBehavior`). `exclude` wins over `include`.
   */
  include?: readonly string[]
  /**
   * The name of the cookie, local storage key and database that hold the stored code of `include: ['storedId']`.
   * A name that is not a lookalike of a common tracker is also harder for a blocklist to learn. Default `_fpid`.
   */
  storedIdName?: string
  /** How long the stored code lives in the cookie, in days. Default 365, at most 400. */
  storedIdMaxAgeDays?: number
  /**
   * When the browser doesn't support `requestIdleCallback` a `setTimeout` will be used. The value is in milliseconds.
   * @default 50
   */
  delayFallback?: number
  /** Whether to print debug messages of the built-in sources to the console */
  debug?: boolean
}

/**
 * Collects the raw signals of the browser without computing a visitor identifier.
 * Send the result to your server with `send`, or use `collectAndSend`.
 *
 * Unlike `load()`, this function doesn't send the anonymous usage statistics request to the library's CDN.
 *
 * This API is experimental: it may change in a minor version.
 */
const linkedIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const consentVersionPattern = /^[A-Za-z0-9_.:-]{1,64}$/

export async function collect(options: Readonly<CollectOptions> = {}): Promise<CollectPayload> {
  // `typeof` matters: a caller that passes `null` (for example from `URLSearchParams.get`) is not a string
  if (
    options.linkedId !== undefined &&
    (typeof options.linkedId !== 'string' || !linkedIdPattern.test(options.linkedId))
  ) {
    throw new Error('linkedId must be 1 to 128 characters of letters, digits and _ - . : (no e-mail addresses)')
  }
  if (options.consent !== undefined) {
    const { basis, version } = options.consent as { basis?: unknown; version?: unknown }
    if (
      !['consent', 'legitimate_interest', 'contract', 'other'].includes(basis as string) ||
      typeof version !== 'string' ||
      !consentVersionPattern.test(version)
    ) {
      throw new Error('consent needs a basis (consent, legitimate_interest, contract or other) and a version text')
    }
  }
  if (
    options.storedIdName !== undefined &&
    (typeof options.storedIdName !== 'string' || !storedIdNamePattern.test(options.storedIdName))
  ) {
    throw new Error('storedIdName must be 1 to 32 characters of letters, digits and _, not starting with a digit')
  }
  const startedAt = Date.now()
  const include: readonly string[] = options.include ?? []
  // A code written to the visitor's device needs the page to say that the visitor agreed or that it is for fraud
  // prevention. Without that, the source is left out even if it was asked for, and nothing is read or written.
  const storedIdAllowed =
    include.includes('storedId') &&
    (options.consent?.basis === 'consent' || options.consent?.basis === 'legitimate_interest')
  const exclude: readonly string[] = [
    ...(options.exclude ?? []),
    ...optInSourceNames.filter((name) => !include.includes(name) || (name === 'storedId' && !storedIdAllowed)),
  ]

  // The delay is required to get consistent signals, see `prepareForSources`
  await prepareForSources(options.delayFallback)

  // Both groups of sources start loading right away and run in parallel.
  // The exclusion list is a plain string list, so the result is typed as unknown components.
  const getComponents = loadSources(
    sources,
    { cache: {}, debug: options.debug },
    exclude,
  ) as () => Promise<UnknownComponents>
  const getExtended = loadSources(
    extendedSources,
    { name: options.storedIdName ?? defaultStoredIdName, maxAgeDays: options.storedIdMaxAgeDays },
    exclude,
  ) as () => Promise<UnknownComponents>

  const [components, extended] = await Promise.all([getComponents(), getExtended()])

  return makePayload(
    {
      components: serializeComponents(components),
      extended: serializeComponents(extended),
      nonce: options.nonce,
      linkedId: options.linkedId,
      consent:
        options.consent === undefined ? undefined : { basis: options.consent.basis, version: options.consent.version },
    },
    startedAt,
  )
}

/**
 * Collects the raw signals and sends them to the server.
 * Resolves with the request id that your backend uses to read the identification result.
 */
export async function collectAndSend(
  sendOptions: Readonly<SendOptions>,
  collectOptions?: Readonly<CollectOptions>,
): Promise<SendResult> {
  return send(await collect(collectOptions), sendOptions)
}

export { send, SendOptions, SendResult }
/**
 * Turns the `profile` that the server may send with the challenge (`GET /v1/nonce`) into options of `collect`:
 * which signals to leave out and which opt-in signals to add. Anything else in the profile, and any name that is not
 * a signal name, is ignored, and `include` is limited to the opt-in signals that this library has. A profile is a
 * request from the server: it can ask for less or for a known extra, and nothing more.
 *
 *     const { nonce, profile } = await (await fetch(`${endpoint}/v1/nonce?k=${key}`)).json()
 *     await collectAndSend({ endpoint, ... }, { nonce, ...profileToOptions(profile) })
 */
export function profileToOptions(profile: unknown): {
  exclude?: string[]
  include?: string[]
  storedIdMaxAgeDays?: number
} {
  if (typeof profile !== 'object' || profile === null) {
    return {}
  }
  const names = (value: unknown, allowed?: readonly string[]): string[] =>
    Array.isArray(value)
      ? value
          .filter((name): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
          .filter((name) => allowed === undefined || allowed.includes(name))
          .slice(0, 100)
      : []
  const { exclude, include, storedIdMaxAgeDays } = profile as {
    exclude?: unknown
    include?: unknown
    storedIdMaxAgeDays?: unknown
  }
  const result: { exclude?: string[]; include?: string[]; storedIdMaxAgeDays?: number } = {}
  const excluded = names(exclude)
  const included = names(include, optInSourceNames)
  if (excluded.length > 0) {
    result.exclude = excluded
  }
  if (included.length > 0) {
    result.include = included
  }
  if (typeof storedIdMaxAgeDays === 'number' && Number.isInteger(storedIdMaxAgeDays)) {
    result.storedIdMaxAgeDays = Math.min(400, Math.max(1, storedIdMaxAgeDays))
  }
  return result
}

export { CollectPayload, ConsentStatement, SerializedComponent, PAYLOAD_SCHEMA_VERSION } from './payload'
export { extendedSources }
export { forgetStoredId } from './sources/stored_id'
export { observeBehavior, BehaviorSummary } from './sources/behavior'
