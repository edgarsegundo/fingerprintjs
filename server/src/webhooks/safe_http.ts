import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

import { Cidr, cidrContains, parseCidr, parseIp } from '../net/cidr'

/**
 * Addresses that a webhook must not reach by default: the machine itself, private networks, link-local addresses (which
 * include the metadata service of the cloud providers), carrier-grade NAT and documentation ranges. A tenant that can
 * set a URL could otherwise make the server call services that only the server can reach.
 */
const blockedRanges: Cidr[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  '100::/64',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((text) => parseCidr(text) as Cidr)

/** True for an address in a blocked range, and for text that is not an address at all */
export function isBlockedAddress(address: string): boolean {
  const ip = parseIp(address)
  return !ip || blockedRanges.some((range) => cidrContains(range, ip))
}

export class BlockedAddressError extends Error {
  constructor(readonly host: string) {
    super(`The address of "${host}" is in a private or reserved range, which webhooks may not reach`)
  }
}

export interface PostOptions {
  timeoutMs: number
  /** Allow private and reserved addresses. For a receiver on your own network. */
  allowPrivateNetworks: boolean
  /** Replaces the DNS lookup. For tests. */
  lookup?: typeof dnsLookup
  /** The most of the answer that is kept, in bytes. The rest is read and thrown away. */
  maxResponseBytes?: number
}

export interface PostResult {
  status: number
  /** The first bytes of the answer, for the log of a failure */
  body: string
}

/**
 * Sends a POST with a JSON body and returns the status. Differences from a plain `fetch`, each on purpose:
 * - the name is resolved here and the connection goes to the address that was checked, so a name that answers with a
 *   private address, or that changes its answer between the check and the connection, cannot reach the inside;
 * - redirects are never followed, because a redirect is a way to a new address that was not checked;
 * - the whole call, the connection included, ends at `timeoutMs`.
 */
export function postJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: PostOptions,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      reject(new Error('The address of the webhook is not a valid URL'))
      return
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('The address of the webhook must start with https:// or http://'))
      return
    }
    const host = target.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) !== 0 && !options.allowPrivateNetworks && isBlockedAddress(host)) {
      reject(new BlockedAddressError(host))
      return
    }

    const checkedLookup: typeof dnsLookup = ((hostname: string, lookupOptions: unknown, callback: unknown) => {
      const done = callback as (error: Error | null, address?: unknown, family?: number) => void
      const wantsAll = typeof lookupOptions === 'object' && lookupOptions !== null && 'all' in lookupOptions
      ;(options.lookup ?? dnsLookup)(hostname, { all: true }, (error, addresses) => {
        if (error) {
          done(error)
          return
        }
        const list = addresses as unknown as Array<{ address: string; family: number }>
        if (!options.allowPrivateNetworks && list.some((entry) => isBlockedAddress(entry.address))) {
          done(new BlockedAddressError(hostname))
          return
        }
        if (wantsAll) {
          done(null, list)
        } else {
          done(null, list[0].address, list[0].family)
        }
      })
    }) as typeof dnsLookup

    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: checkedLookup,
        // A new connection each time: a webhook is rare, and a reused one would skip the check above
        agent: false,
        timeout: options.timeoutMs,
      },
      (response) => {
        const limit = options.maxResponseBytes ?? 512
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (size < limit) {
            chunks.push(chunk.subarray(0, limit - size))
          }
          size += chunk.length
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
        response.on('error', reject)
      },
    )
    const deadline = setTimeout(() => request.destroy(new Error('The webhook timed out')), options.timeoutMs)
    request.on('timeout', () => request.destroy(new Error('The webhook timed out')))
    request.on('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    request.on('close', () => clearTimeout(deadline))
    request.end(body)
  })
}
