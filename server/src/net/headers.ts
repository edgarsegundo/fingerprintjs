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
