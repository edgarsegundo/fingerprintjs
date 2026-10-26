import { createHash } from 'node:crypto'

/** Headers added by proxies and CDNs. They say nothing about the visitor's browser, so they are left out. */
const proxyHeaderPrefixes = [
  'x-forwarded-',
  'x-envoy-',
  'x-amz',
  'x-azure-',
  'cf-',
  'fastly-',
  'x-real-ip',
  'x-client-ip',
  'x-request-id',
  'x-correlation-id',
  'true-client-ip',
  'cdn-loop',
  'forwarded',
  'via',
]

/** The only header values that are stored. Cookies, credentials and the like are never stored. */
const storedValueHeaders = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-full-version-list',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-gpc',
  'dnt',
  'upgrade-insecure-requests',
  'priority',
])

/**
 * The headers that a browser sends on every request of the collector, whatever the state of its cache, the protocol
 * (HTTP/1.1 or HTTP/2) or the DevTools. The list is part of the definition of the `headerCore` feature, so it is
 * never a setting: changing it changes every value and breaks the history.
 */
const coreHeaderNames = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'content-type',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
])

const maxValueLength = 512

export interface HeaderSignals {
  /** Lower-case header names in the order the browser sent them, without proxy headers and pseudo-headers */
  order: string[]
  /**
   * How each name was written, one character per header in the same order:
   * `l` lower case, `T` Title-Case, `m` anything else. HTTP/2 forces lower case, so it is `l` for all there.
   */
  casing: string
  /** Short hash of `order` and `casing`. Browsers and HTTP libraries differ here, and so do their versions. */
  fp: string
  values: Record<string, string>
}

/**
 * Short hash of the relative order of the core headers that are present, without the casing. Unlike `fp`, it does not
 * change when the browser adds an optional header (`cache-control`, `pragma`, `if-*`, `priority`) or switches between
 * HTTP/1.1 and HTTP/2. It still tells browser engines apart, because they order and send these headers differently.
 */
export function coreHeaderFp(order: readonly string[]): string | undefined {
  const core = order.filter((name) => coreHeaderNames.has(name))
  if (core.length === 0) {
    return undefined
  }
  return createHash('sha256').update(core.join(',')).digest('hex').slice(0, 16)
}

function casingOf(name: string): 'l' | 'T' | 'm' {
  if (name === name.toLowerCase()) {
    return 'l'
  }
  const isTitle = name
    .split('-')
    .every((word) => word === '' || word === word[0].toUpperCase() + word.slice(1).toLowerCase())
  return isTitle ? 'T' : 'm'
}

function isProxyHeader(lowerName: string): boolean {
  return proxyHeaderPrefixes.some((prefix) => lowerName === prefix || lowerName.startsWith(prefix))
}

/**
 * The header order and the way the names are written are set by the HTTP client, not by the page, so JavaScript
 * can't read or fake them. This format is the project's own and is not JA4H, which is not licensed for this use.
 *
 * @param rawHeaders Node's `rawHeaders`: names and values alternate, in the order received, with original casing
 */
export function headerSignals(rawHeaders: readonly string[]): HeaderSignals {
  const order: string[] = []
  let casing = ''
  const values: Record<string, string> = {}

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const lowerName = name.toLowerCase()
    if (name.startsWith(':') || isProxyHeader(lowerName)) {
      continue
    }
    order.push(lowerName)
    casing += casingOf(name)
    if (storedValueHeaders.has(lowerName)) {
      const value = rawHeaders[index + 1].slice(0, maxValueLength)
      values[lowerName] = lowerName in values ? `${values[lowerName]}, ${value}` : value
    }
  }

  const fp = createHash('sha256')
    .update(`${order.join(',')}|${casing}`)
    .digest('hex')
    .slice(0, 16)
  return { order, casing, fp, values }
}
