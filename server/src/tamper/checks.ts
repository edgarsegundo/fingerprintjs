import type { StoredEvent } from '../store/types'

import {
  PlatformFamily,
  platformFromHint,
  platformFromNavigator,
  platformFromUserAgent,
  platformsAgree,
} from './user_agent'

export type Severity = 'low' | 'medium' | 'high'

export interface TamperSignal {
  id: string
  severity: Severity
  /** What was found, in words an operator can act on */
  detail: string
}

export interface TamperReport {
  /** The evidence found. An empty list means that nothing was found, not that nothing is wrong. */
  signals: TamperSignal[]
  counts: Record<Severity, number>
}

/** What can be tuned per tenant. Every field is optional and the defaults are the ones of the settings. */
export interface TamperOptions {
  /** Checks that are not run: their signals never appear */
  disabledChecks?: readonly string[]
  /** Replaces the severity of a check. The severity of the built-in table is a judgement, and a tenant may differ. */
  severity?: Readonly<Record<string, Severity>>
  /** A browser clock further than this from the server's is reported, in seconds */
  clockSkewSeconds?: number
}

type Check = (event: StoredEvent, options: { clockSkewSeconds: number }) => TamperSignal | undefined

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const component = (event: StoredEvent, name: string): unknown => {
  const signal = event.payload.components[name]
  return signal && !signal.error ? signal.value : undefined
}

const extended = (event: StoredEvent, name: string): unknown => {
  const signal = event.payload.extended[name]
  return signal && !signal.error ? signal.value : undefined
}

interface Snapshot {
  userAgent?: unknown
  platform?: unknown
  hardwareConcurrency?: unknown
  deviceMemory?: unknown
  language?: unknown
  languages?: unknown
  timezone?: unknown
  locale?: unknown
  uaData?: unknown
  webgl?: unknown
}

/**
 * The views of `navigator` that the collector took: the page's, the worker's and a hidden iframe's (each `undefined` if
 * it did not run or could not be read).
 */
function views(event: StoredEvent): { page?: Snapshot; worker?: Snapshot; frame?: Snapshot } {
  const value = extended(event, 'workerContext')
  if (!isObject(value)) {
    return {}
  }
  const page = isObject(value.page) ? (value.page as Snapshot) : undefined
  const worker = isObject(value.worker) && !('unavailable' in value.worker) ? (value.worker as Snapshot) : undefined
  const frame = isObject(value.frame) && !('unavailable' in value.frame) ? (value.frame as Snapshot) : undefined
  return { page, worker, frame }
}

const headerValue = (event: StoredEvent, name: string): string | undefined => event.network.headers.values[name]

/** The first language tag of an `Accept-Language` header */
const firstLanguage = (header: string): string => header.split(',')[0].split(';')[0].trim().toLowerCase()

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The browser says what it is in several places that a spoofing tool must all remember to change: the HTTP header, the
 * page, a worker, the client hints. They are independent views, so a contradiction between them is real evidence.
 */
const userAgentInconsistent: Check = (event) => {
  const { page, worker } = views(event)
  const header = headerValue(event, 'user-agent')
  const claims: Array<[string, unknown]> = [
    ['header', header],
    ['page', page?.userAgent],
    ['worker', worker?.userAgent],
  ]
  const present = claims.filter(([, value]) => typeof value === 'string')
  const different = present.some(([, value]) => value !== present[0][1])
  if (present.length < 2 || !different) {
    return undefined
  }
  return {
    id: 'user_agent_inconsistent',
    severity: 'high',
    detail: `The user agent is not the same in the ${present.map(([where]) => where).join(', ')}.`,
  }
}

const platformInconsistent: Check = (event) => {
  const { page, worker } = views(event)
  const claims: Array<[string, PlatformFamily | undefined]> = []
  const userAgent = headerValue(event, 'user-agent')
  if (userAgent) {
    claims.push(['user-agent header', platformFromUserAgent(userAgent)])
  }
  const hintHeader = headerValue(event, 'sec-ch-ua-platform')
  if (hintHeader) {
    claims.push(['Sec-CH-UA-Platform header', platformFromHint(hintHeader)])
  }
  const navigatorPlatform = component(event, 'platform')
  if (typeof navigatorPlatform === 'string') {
    claims.push(['navigator.platform', platformFromNavigator(navigatorPlatform)])
  }
  if (typeof page?.userAgent === 'string') {
    claims.push(['page user agent', platformFromUserAgent(page.userAgent)])
  }
  if (typeof worker?.platform === 'string') {
    claims.push(['worker navigator.platform', platformFromNavigator(worker.platform)])
  }
  const hintData = component(event, 'userAgentData')
  if (isObject(hintData) && typeof hintData.platform === 'string') {
    claims.push(['userAgentData.platform', platformFromHint(hintData.platform)])
  }
  const known = claims.filter((claim): claim is [string, PlatformFamily] => claim[1] !== undefined)
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      if (!platformsAgree(known[i][1], known[j][1])) {
        return {
          id: 'platform_inconsistent',
          severity: 'high',
          detail: `${known[i][0]} says ${known[i][1]}, but ${known[j][0]} says ${known[j][1]}.`,
        }
      }
    }
  }
  return undefined
}

const highFields = ['platform', 'hardwareConcurrency', 'deviceMemory', 'uaData'] as const
const mediumFields = ['language', 'languages', 'timezone', 'locale'] as const

/** The worker is a fresh JavaScript context. Tools that patch only the page leave it telling the truth. */
const workerPageMismatch: Check = (event) => {
  const { page, worker } = views(event)
  if (!page || !worker) {
    return undefined
  }
  const high = highFields.filter(
    (field) => page[field] !== undefined && worker[field] !== undefined && !sameJson(page[field], worker[field]),
  )
  const medium = mediumFields.filter(
    (field) => page[field] !== undefined && worker[field] !== undefined && !sameJson(page[field], worker[field]),
  )
  if (high.length === 0 && medium.length === 0) {
    return undefined
  }
  return {
    id: 'worker_page_mismatch',
    severity: high.length > 0 ? 'high' : 'medium',
    detail: `The page and a worker disagree on: ${[...high, ...medium].join(', ')}.`,
  }
}

/**
 * A hidden iframe of the same page has a `navigator` of its own. A tool that changes the one of the top window by
 * script leaves the iframe's telling the truth, and a tool that works at the browser level (a debugger, a setting of
 * the browser) changes both. So this finds the clumsier tool, and finding nothing says little. It is medium evidence,
 * not high, because an extension that injects into frames may touch them differently.
 */
const iframePageMismatch: Check = (event) => {
  const { page, frame } = views(event)
  if (!page || !frame) {
    return undefined
  }
  const fields = [...highFields, 'userAgent' as const].filter(
    (field) => page[field] !== undefined && frame[field] !== undefined && !sameJson(page[field], frame[field]),
  )
  const soft = mediumFields.filter(
    (field) => page[field] !== undefined && frame[field] !== undefined && !sameJson(page[field], frame[field]),
  )
  if (fields.length === 0 && soft.length === 0) {
    return undefined
  }
  return {
    id: 'iframe_page_mismatch',
    severity: fields.length > 0 ? 'medium' : 'low',
    detail: `The page and a frame of the same page disagree on: ${[...fields, ...soft].join(', ')}.`,
  }
}

const webglWorkerMismatch: Check = (event) => {
  const { worker } = views(event)
  const basics = component(event, 'webGlBasics')
  const workerWebgl = isObject(worker?.webgl) ? worker?.webgl : undefined
  if (!isObject(basics) || !workerWebgl) {
    return undefined
  }
  const page = basics.rendererUnmasked
  const inWorker = workerWebgl.unmaskedRenderer
  if (typeof page === 'string' && page !== '' && typeof inWorker === 'string' && inWorker !== '' && page !== inWorker) {
    return {
      id: 'webgl_worker_mismatch',
      severity: 'high',
      detail: `The GPU is "${page}" in the page and "${inWorker}" in a worker.`,
    }
  }
  return undefined
}

/**
 * The graphics API in the name of the GPU says which operating system it runs on: Metal exists only on Apple systems
 * and Direct3D only on Windows. A user agent that claims another system with such a GPU was changed on the surface.
 * Only these two are used, because they are unambiguous: OpenGL and Vulkan names run on several systems.
 */
const gpuPlatformInconsistent: Check = (event) => {
  const basics = component(event, 'webGlBasics')
  const renderer = isObject(basics) ? `${basics.rendererUnmasked ?? ''} ${basics.renderer ?? ''}` : ''
  const claim = platformFromUserAgent(headerValue(event, 'user-agent') ?? '')
  if (!claim || renderer.trim() === '') {
    return undefined
  }
  const apple: PlatformFamily[] = ['macos', 'ios']
  if (/\bMetal\b/i.test(renderer) && !apple.includes(claim)) {
    return {
      id: 'gpu_platform_inconsistent',
      severity: 'high',
      detail: `The GPU uses Metal (Apple systems) but the user agent says ${claim}.`,
    }
  }
  if (/Direct3D/i.test(renderer) && claim !== 'windows') {
    return {
      id: 'gpu_platform_inconsistent',
      severity: 'high',
      detail: `The GPU uses Direct3D (Windows) but the user agent says ${claim}.`,
    }
  }
  return undefined
}

const grease = /not.?a.?brand|not.?a.?\(?brand/i

/** Brand names of the `Sec-CH-UA` header, without the decoy brand and without "Chromium" if there is another */
function headerBrands(header: string): string[] {
  const names = [...header.matchAll(/"([^"]+)"\s*;\s*v=/g)]
    .map((match) => match[1])
    .filter((name) => !grease.test(name))
  return (names.length > 1 ? names.filter((name) => name !== 'Chromium') : names).sort()
}

const clientHintsBrandsMismatch: Check = (event) => {
  const header = headerValue(event, 'sec-ch-ua')
  const data = component(event, 'userAgentData')
  if (!header || !isObject(data) || !Array.isArray(data.brands)) {
    return undefined
  }
  const fromHeader = headerBrands(header)
  const fromScript = data.brands.filter((brand): brand is string => typeof brand === 'string').sort()
  if (fromHeader.length === 0 || fromScript.length === 0 || sameJson(fromHeader, fromScript)) {
    return undefined
  }
  return {
    id: 'client_hints_brands_mismatch',
    severity: 'medium',
    detail: `The browser brands are [${fromHeader.join(', ')}] in the header and [${fromScript.join(
      ', ',
    )}] in the script.`,
  }
}

const languageHeaderMismatch: Check = (event) => {
  const header = headerValue(event, 'accept-language')
  const { page } = views(event)
  if (!header || typeof page?.language !== 'string') {
    return undefined
  }
  const inHeader = firstLanguage(header).split('-')[0]
  const inScript = page.language.toLowerCase().split('-')[0]
  return inHeader !== '' && inScript !== '' && inHeader !== inScript
    ? {
        id: 'language_header_mismatch',
        severity: 'low',
        detail: `The language is "${inHeader}" in the header and "${inScript}" in the page.`,
      }
    : undefined
}

const nativeFunctionsModified: Check = (event) => {
  const integrity = extended(event, 'nativeIntegrity')
  if (!isObject(integrity) || !Array.isArray(integrity.nonNative) || integrity.nonNative.length === 0) {
    return undefined
  }
  // Privacy and accessibility extensions also patch APIs, so this alone is not a high-severity finding
  return {
    id: 'native_functions_modified',
    severity: 'medium',
    detail: `Functions that should be native were replaced: ${integrity.nonNative.slice(0, 5).join(', ')}.`,
  }
}

/**
 * What a page reads to tell devices apart. A tool that fakes a device sets these straight on `navigator`. A polyfill or
 * an extension adds other names (`share`, `canShare`...), which say nothing about who the visitor is.
 */
const identityNavigatorProperties = new Set([
  'appVersion',
  'cpuClass',
  'deviceMemory',
  'doNotTrack',
  'hardwareConcurrency',
  'language',
  'languages',
  'maxTouchPoints',
  'mimeTypes',
  'oscpu',
  'platform',
  'plugins',
  'product',
  'productSub',
  'userAgent',
  'userAgentData',
  'vendor',
  'vendorSub',
  'webdriver',
])

const navigatorOverridden: Check = (event) => {
  const integrity = extended(event, 'nativeIntegrity')
  if (!isObject(integrity)) {
    return undefined
  }
  const navigatorNames: string[] = Array.isArray(integrity.navigatorOwnProperties)
    ? integrity.navigatorOwnProperties.filter((name): name is string => typeof name === 'string')
    : []
  const screenNames: string[] = Array.isArray(integrity.screenOwnProperties)
    ? integrity.screenOwnProperties.filter((name): name is string => typeof name === 'string')
    : []
  // Nothing is added to `screen` by a polyfill, so any own property of it counts
  const identity = [
    ...navigatorNames.filter((name) => identityNavigatorProperties.has(name)).map((name) => `navigator.${name}`),
    ...screenNames.map((name) => `screen.${name}`),
  ]
  if (identity.length > 0) {
    return {
      id: 'navigator_overridden_on_instance',
      severity: 'high',
      detail: `Values were set straight on the object: ${identity.slice(0, 5).join(', ')}.`,
    }
  }
  const other = navigatorNames.map((name) => `navigator.${name}`)
  return other.length === 0
    ? undefined
    : {
        id: 'navigator_overridden_on_instance',
        severity: 'low',
        detail:
          'Names that do not identify the device were added straight on the object ' +
          `(a polyfill or an extension does this): ${other.slice(0, 5).join(', ')}.`,
      }
}

const automationMarkers: Check = (event) => {
  const hints = extended(event, 'automationHints')
  if (!isObject(hints)) {
    return undefined
  }
  const found: string[] = []
  if (hints.webdriver === true) {
    found.push('navigator.webdriver is true')
  }
  if (Array.isArray(hints.globals) && hints.globals.length > 0) {
    found.push(`automation globals (${hints.globals.slice(0, 3).join(', ')})`)
  }
  if (Array.isArray(hints.documentAttributes) && hints.documentAttributes.length > 0) {
    found.push(`driver attributes (${hints.documentAttributes.join(', ')})`)
  }
  if (hints.hasChromeDriverKeys === true) {
    found.push('ChromeDriver keys')
  }
  return found.length === 0
    ? undefined
    : { id: 'automation_markers', severity: 'high', detail: `Found ${found.join('; ')}.` }
}

const headlessUserAgent: Check = (event) =>
  /HeadlessChrome/.test(headerValue(event, 'user-agent') ?? '')
    ? { id: 'headless_user_agent', severity: 'high', detail: 'The user agent says HeadlessChrome.' }
    : undefined

const notificationInconsistent: Check = (event) => {
  const value = extended(event, 'notificationPermission')
  return isObject(value) && value.api === 'denied' && value.query === 'prompt'
    ? {
        id: 'notification_permission_inconsistent',
        severity: 'low',
        detail: 'Notification.permission says denied but the Permissions API says prompt.',
      }
    : undefined
}

const isValidTimezone = (name: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** A value that was not reported (missing, or `null`, which is what `NaN` becomes in JSON) is not a finding */
const reported = (value: unknown): boolean => value !== undefined && value !== null

const impossibleValues: Check = (event) => {
  const problems: string[] = []
  const { page } = views(event)
  // Both places are looked at: a tool may fake one and forget the other
  const cores = [component(event, 'hardwareConcurrency'), page?.hardwareConcurrency].filter(reported)
  for (const value of cores) {
    if (!(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 512)) {
      problems.push(`hardwareConcurrency ${JSON.stringify(value)}`)
    }
  }
  const memory = [component(event, 'deviceMemory'), page?.deviceMemory].filter(reported)
  for (const value of memory) {
    if (!(typeof value === 'number' && value >= 0.25 && value <= 512 && Math.log2(value) % 1 === 0)) {
      problems.push(`deviceMemory ${JSON.stringify(value)}`)
    }
  }
  const screen = component(event, 'screenResolution')
  if (Array.isArray(screen) && screen.some((side) => typeof side === 'number' && side <= 0)) {
    problems.push(`screen ${JSON.stringify(screen)}`)
  }
  const timezone = component(event, 'timezone')
  if (typeof timezone === 'string' && !/^UTC[+-]?\d*$/.test(timezone) && !isValidTimezone(timezone)) {
    problems.push(`timezone "${timezone.slice(0, 40)}"`)
  }
  const languages = component(event, 'languages')
  if (Array.isArray(languages) && languages.length === 0) {
    problems.push('no languages')
  }
  return problems.length === 0
    ? undefined
    : {
        id: 'impossible_values',
        severity: 'medium',
        detail: `Values no real browser reports: ${[...new Set(problems)].join('; ')}.`,
      }
}

const clockSkew: Check = (event, options) =>
  Math.abs(event.derived.clockSkewMs) > options.clockSkewSeconds * 1000
    ? {
        id: 'clock_skew',
        severity: 'low',
        detail: `The clock of the browser is ${Math.round(event.derived.clockSkewMs / 1000)} seconds off.`,
      }
    : undefined

const nonceContextMismatch: Check = (event) =>
  event.derived.nonceContext === 'mismatch'
    ? {
        id: 'nonce_context_mismatch',
        severity: 'medium',
        detail:
          'The challenge was fetched by a client with another network, TLS stack or user agent ' +
          'than the one that sent the payload.',
      }
    : undefined

const checks: Check[] = [
  userAgentInconsistent,
  platformInconsistent,
  workerPageMismatch,
  iframePageMismatch,
  webglWorkerMismatch,
  gpuPlatformInconsistent,
  clientHintsBrandsMismatch,
  languageHeaderMismatch,
  nativeFunctionsModified,
  navigatorOverridden,
  automationMarkers,
  headlessUserAgent,
  notificationInconsistent,
  impossibleValues,
  clockSkew,
  nonceContextMismatch,
]

const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/**
 * Looks for contradictions and impossible values in a stored visit.
 * It is evidence for a human or a later rule to weigh, never a verdict: some legitimate setups (privacy extensions,
 * remote desktops, travel) trigger the weaker signals. A check that fails on a strange value is skipped, since the
 * payload comes from the client and anything can be in it.
 */
export function checkTamper(event: StoredEvent, options: TamperOptions = {}): TamperReport {
  const disabled = new Set(options.disabledChecks ?? [])
  const resolved = { clockSkewSeconds: options.clockSkewSeconds ?? 300 }
  const signals: TamperSignal[] = []
  for (const check of checks) {
    try {
      const signal = check(event, resolved)
      if (signal && !disabled.has(signal.id)) {
        signals.push({ ...signal, severity: options.severity?.[signal.id] ?? signal.severity })
      }
    } catch {
      // A malformed value must not hide the other findings
    }
  }
  signals.sort((a, b) => order[a.severity] - order[b.severity] || (a.id < b.id ? -1 : 1))
  return {
    signals,
    counts: {
      high: signals.filter((signal) => signal.severity === 'high').length,
      medium: signals.filter((signal) => signal.severity === 'medium').length,
      low: signals.filter((signal) => signal.severity === 'low').length,
    },
  }
}
