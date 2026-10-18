import { prepareForSources } from '../agent'
import { sources } from '../sources'
import { loadSources, UnknownComponents } from '../utils/entropy_source'

import { CollectPayload, makePayload, serializeComponents } from './payload'
import { extendedSources, optInSourceNames } from './sources'
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
   * The names of signals not to collect, from both `components` and `extended` of the payload.
   * Use it to collect less (data minimization) or to skip a signal that conflicts with your page,
   * for example `workerContext` when the Content Security Policy forbids `blob:` workers.
   */
  exclude?: readonly string[]
  /**
   * The names of signals that are off by default and must be collected. Today: `webGpu`, which makes Chrome print
   * a console message on machines without a usable GPU. `exclude` wins over `include`.
   */
  include?: readonly string[]
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

export async function collect(options: Readonly<CollectOptions> = {}): Promise<CollectPayload> {
  // `typeof` matters: a caller that passes `null` (for example from `URLSearchParams.get`) is not a string
  if (
    options.linkedId !== undefined &&
    (typeof options.linkedId !== 'string' || !linkedIdPattern.test(options.linkedId))
  ) {
    throw new Error('linkedId must be 1 to 128 characters of letters, digits and _ - . : (no e-mail addresses)')
  }
  const startedAt = Date.now()
  const include: readonly string[] = options.include ?? []
  const exclude: readonly string[] = [
    ...(options.exclude ?? []),
    ...optInSourceNames.filter((name) => !include.includes(name)),
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
  const getExtended = loadSources(extendedSources, {}, exclude) as () => Promise<UnknownComponents>

  const [components, extended] = await Promise.all([getComponents(), getExtended()])

  return makePayload(
    {
      components: serializeComponents(components),
      extended: serializeComponents(extended),
      nonce: options.nonce,
      linkedId: options.linkedId,
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
export { CollectPayload, SerializedComponent, PAYLOAD_SCHEMA_VERSION } from './payload'
export { extendedSources }
