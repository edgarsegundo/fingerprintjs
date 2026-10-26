/**
 * The loader tells you when the collector could not do its job.
 *
 * If the network blocks the port of the fingerprint server, the collector script (served by that server) never
 * loads, so it cannot report anything, and the server never sees the visit. This loader is a separate, tiny file that
 * you serve from your own site. It loads the collector, collects and sends, and when any of that fails it works out
 * the likely cause and posts a small report to an address on your own site.
 *
 * It never throws, never waits for anything the page needs, and sends nothing that identifies the visitor.
 */

export type FailureReason =
  | 'script_unreachable'
  | 'script_blocked'
  | 'script_broken'
  | 'request_unreachable'
  | 'request_blocked'
  | 'timeout'
  | 'server_refused'
  | 'server_error'
  | 'collect_error'

export type ReportedReason = FailureReason | 'ok'
export type FailurePhase = 'script' | 'nonce' | 'collect' | 'send'
export type ProbeResult = 'reachable' | 'unreachable' | 'skipped'

export interface LoaderOptions {
  /** Address of the collector script, on the fingerprint server */
  scriptUrl: string
  /** The fingerprint server, without a path: `https://id.example.com:8443` */
  endpoint: string
  /** The public key (`pk_...`) of the tenant */
  publicKey: string
  /** Where to post the reports: an address on your own site, such as `/fp-report` */
  reportTo: string
  /** The id of the account, never an e-mail. Passed to the collector. */
  linkedId?: string
  /** Passed to the collector: `consent`, `exclude`, `include` and the rest of its options */
  collectOptions?: Record<string, unknown>
  /** How long to wait for the script and for each request, in milliseconds. Default 8000. */
  timeoutMs?: number
  /** How long to wait for the probe, in milliseconds. Default 4000. */
  probeTimeoutMs?: number
  /**
   * The share of visits that worked and are reported anyway (0 to 1), to have a denominator on the receiver.
   * Default 0: only failures are reported.
   */
  successSampleRate?: number
}

export type LoaderResult = { ok: true; requestId: string } | { ok: false; reason: FailureReason; status?: number }

/** The parts of the collector that the loader uses. `window.FingerprintJS` has them. */
export interface CollectorApi {
  collect(options?: Record<string, unknown>): Promise<unknown>
  send(payload: unknown, options: { endpoint: string; timeoutMs?: number }): Promise<{ requestId: string }>
}

/** What the loader needs from the browser. Real in the page, replaced in tests. */
export interface Environment {
  loadScript(url: string, timeoutMs: number): Promise<'loaded' | 'error' | 'timeout'>
  collector(): CollectorApi | undefined
  fetch(url: string, init: RequestInit): Promise<Response>
  sendBeacon(url: string, body: string): boolean
  now(): number
  random(): number
  isOnline(): boolean | undefined
  connectionType(): string | undefined
  /** Whether this tab already sent a report, and a way to remember that it did */
  alreadyReported(): boolean
  markReported(): void
}

const defaultTimeoutMs = 8000
const defaultProbeTimeoutMs = 4000
const reportedKey = '_fp_reported'

function browserEnvironment(): Environment {
  return {
    loadScript: (url, timeoutMs) =>
      new Promise((resolve) => {
        const script = document.createElement('script')
        const timer = setTimeout(() => resolve('timeout'), timeoutMs)
        script.async = true
        script.onload = () => {
          clearTimeout(timer)
          resolve('loaded')
        }
        script.onerror = () => {
          clearTimeout(timer)
          resolve('error')
        }
        script.src = url
        const parent = document.head || document.documentElement
        parent.appendChild(script)
      }),
    collector: () => {
      const api = (window as unknown as { FingerprintJS?: Partial<CollectorApi> }).FingerprintJS
      return api && typeof api.collect === 'function' && typeof api.send === 'function'
        ? (api as CollectorApi)
        : undefined
    },
    fetch: (url, init) => fetch(url, init),
    sendBeacon: (url, body) => typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body),
    now: () => Date.now(),
    random: () => Math.random(),
    isOnline: () => (typeof navigator.onLine === 'boolean' ? navigator.onLine : undefined),
    connectionType: () =>
      (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType,
    alreadyReported: () => {
      try {
        return sessionStorage.getItem(reportedKey) === '1'
      } catch {
        return false
      }
    },
    markReported: () => {
      try {
        sessionStorage.setItem(reportedKey, '1')
      } catch {
        // Storage may be blocked. The report then repeats on each page load, which is harmless.
      }
    },
  }
}

/**
 * Asks the fingerprint server for something it always answers, without reading the answer (`no-cors`). The promise
 * only settles on whether a connection could be made: resolved means the network lets the visitor reach the server,
 * rejected means it does not (a closed port, a name that does not resolve, a blocker, a timeout).
 */
async function probe(options: LoaderOptions, env: Environment): Promise<ProbeResult> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = setTimeout(() => controller?.abort(), options.probeTimeoutMs ?? defaultProbeTimeoutMs)
  try {
    await env.fetch(`${trimEnd(options.endpoint)}/healthz`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller?.signal,
    })
    return 'reachable'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

const trimEnd = (url: string): string => url.replace(/\/+$/, '')

interface Outcome {
  reason: ReportedReason
  phase: FailurePhase
  status?: number
  probe: ProbeResult
}

interface Failure extends Outcome {
  reason: FailureReason
}

/** Works out what a thrown error from a request means. Network errors are told apart by the probe. */
async function classifyRequestError(
  error: unknown,
  phase: FailurePhase,
  options: LoaderOptions,
  env: Environment,
): Promise<Failure> {
  const message = error instanceof Error ? error.message : ''
  const name = (error as { name?: unknown } | null)?.name
  const status = /HTTP (\d{3})\b/.exec(message)?.[1]
  if (status !== undefined) {
    const code = Number(status)
    return { reason: code >= 500 ? 'server_error' : 'server_refused', phase, status: code, probe: 'skipped' }
  }
  if (name === 'AbortError') {
    return { reason: 'timeout', phase, probe: 'skipped' }
  }
  if (error instanceof Error && /has no (nonce|request id)/.test(message)) {
    return { reason: 'server_error', phase, probe: 'skipped' }
  }
  if (error instanceof TypeError) {
    // The browser gives no reason for a failed request. The probe says whether the server can be reached at all.
    const result = await probe(options, env)
    return { reason: result === 'reachable' ? 'request_blocked' : 'request_unreachable', phase, probe: result }
  }
  return { reason: 'collect_error', phase: 'collect', probe: 'skipped' }
}

/** Posts the report. It does not wait for the answer and it does not matter if it fails. */
function report(failure: Outcome, startedAt: number, options: LoaderOptions, env: Environment): void {
  if (failure.reason !== 'ok' && env.isOnline() === false) {
    return // a visitor without a connection is not a network that blocks the server
  }
  const body: Record<string, unknown> = {
    v: 1,
    reason: failure.reason,
    phase: failure.phase,
    probe: failure.probe,
    elapsedMs: Math.max(0, env.now() - startedAt),
    site: options.publicKey,
  }
  if (failure.status !== undefined) {
    body.status = failure.status
  }
  const online = env.isOnline()
  if (online !== undefined) {
    body.online = online
  }
  const connection = env.connectionType()
  if (connection !== undefined) {
    body.connection = connection
  }
  const text = JSON.stringify(body)
  try {
    if (env.sendBeacon(options.reportTo, text)) {
      return
    }
  } catch {
    // falls through to fetch
  }
  try {
    env
      .fetch(options.reportTo, { method: 'POST', body: text, keepalive: true, credentials: 'omit' })
      .catch(() => undefined)
  } catch {
    // nothing else to try
  }
}

async function run(options: LoaderOptions, env: Environment, startedAt: number): Promise<LoaderResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const endpoint = trimEnd(options.endpoint)
  const fail = (failure: Failure): LoaderResult => {
    // A device without a connection is not reported, and it does not use up the report of the tab
    if (!env.alreadyReported() && env.isOnline() !== false) {
      env.markReported()
      report(failure, startedAt, options, env)
    }
    return { ok: false, reason: failure.reason, ...(failure.status === undefined ? {} : { status: failure.status }) }
  }

  // 1. The collector script, unless the page already has it
  let collector = env.collector()
  if (!collector) {
    const loaded = await env.loadScript(options.scriptUrl, timeoutMs)
    if (loaded !== 'loaded') {
      const result = await probe(options, env)
      return fail({
        reason: result === 'reachable' ? 'script_blocked' : 'script_unreachable',
        phase: 'script',
        probe: result,
      })
    }
    collector = env.collector()
    if (!collector) {
      return fail({ reason: 'script_broken', phase: 'script', probe: 'skipped' })
    }
  }

  // 2. The challenge
  let nonce: string | undefined
  let profile: unknown
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = setTimeout(() => controller?.abort(), timeoutMs)
    try {
      const response = await env.fetch(`${endpoint}/v1/nonce?k=${encodeURIComponent(options.publicKey)}`, {
        credentials: 'omit',
        signal: controller?.signal,
      })
      if (!response.ok) {
        throw new Error(`The collector endpoint answered with HTTP ${response.status}`)
      }
      const data = (await response.json()) as { nonce?: unknown; profile?: unknown }
      if (typeof data.nonce !== 'string') {
        throw new Error('The challenge has no nonce')
      }
      nonce = data.nonce
      profile = data.profile
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return fail(await classifyRequestError(error, 'nonce', options, env))
  }

  // 3. Collect
  let payload: unknown
  try {
    payload = await collector.collect({
      ...options.collectOptions,
      nonce,
      ...(options.linkedId === undefined ? {} : { linkedId: options.linkedId }),
      ...profileOptions(profile, options.collectOptions),
    })
  } catch {
    return fail({ reason: 'collect_error', phase: 'collect', probe: 'skipped' })
  }

  // 4. Send
  try {
    const sent = await collector.send(payload, {
      endpoint: `${endpoint}/v1/collect?k=${encodeURIComponent(options.publicKey)}`,
      timeoutMs,
    })
    if (options.successSampleRate && env.random() < options.successSampleRate && !env.alreadyReported()) {
      env.markReported()
      report({ reason: 'ok', phase: 'send', probe: 'skipped' }, startedAt, options, env)
    }
    return { ok: true, requestId: sent.requestId }
  } catch (error) {
    return fail(await classifyRequestError(error, 'send', options, env))
  }
}

/**
 * The server may ask for less than the page asks (`exclude`) or for a known extra (`include`) in the challenge. Only
 * names are taken, in a safe shape, and a name the page excluded stays excluded.
 */
function profileOptions(profile: unknown, own?: Record<string, unknown>): { exclude?: string[]; include?: string[] } {
  if (typeof profile !== 'object' || profile === null) {
    return {}
  }
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
      : []
  const { exclude, include } = profile as { exclude?: unknown; include?: unknown }
  const ownExclude = Array.isArray(own?.exclude) ? (own?.exclude as string[]) : []
  const ownInclude = Array.isArray(own?.include) ? (own?.include as string[]) : []
  const result: { exclude?: string[]; include?: string[] } = {}
  const excluded = [...new Set([...ownExclude, ...names(exclude)])]
  const included = [...new Set([...ownInclude, ...names(include)])]
  if (excluded.length > 0) {
    result.exclude = excluded
  }
  if (included.length > 0) {
    result.include = included
  }
  return result
}

/**
 * Loads the collector, collects and sends. Resolves with the request id, or with the reason it did not work, and in
 * that case also posts one report per tab session to `reportTo`. It never rejects.
 */
export async function start(options: LoaderOptions, env: Environment = browserEnvironment()): Promise<LoaderResult> {
  const startedAt = env.now()
  try {
    return await run(options, env, startedAt)
  } catch {
    // The loader must never get in the way of the page, whatever went wrong inside it
    return { ok: false, reason: 'collect_error' }
  }
}
