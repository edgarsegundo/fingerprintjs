import { Cidr, isInAny, normalizeIp } from './cidr'

export interface ClientIp {
  ip: string
  /** `trusted_proxy` means the address came from a header set by a proxy listed in the configuration */
  source: 'socket' | 'trusted_proxy'
}

/**
 * Finds the address of the visitor.
 *
 * Headers such as `X-Forwarded-For` are written by whoever sends the request, so they are believed only when the
 * connection comes from a proxy that the operator listed as trusted. Even then, the list is read from the right:
 * the right end was written by the proxies we trust and the left end is whatever the visitor sent.
 * The first address from the right that isn't a trusted proxy is the visitor.
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedHeader: string | undefined,
  trustedProxies: readonly Cidr[],
): ClientIp | undefined {
  const socketIp = socketAddress === undefined ? undefined : normalizeIp(socketAddress)
  if (socketIp === undefined) {
    return undefined
  }
  if (forwardedHeader === undefined || !isInAny(trustedProxies, socketIp)) {
    return { ip: socketIp, source: 'socket' }
  }

  const entries = forwardedHeader.split(',').map((entry) => entry.trim())
  for (let index = entries.length - 1; index >= 0; index--) {
    const ip = normalizeIp(entries[index])
    if (ip === undefined) {
      // A malformed entry means the header can't be trusted, so the connection address is used
      return { ip: socketIp, source: 'socket' }
    }
    if (!isInAny(trustedProxies, ip)) {
      return { ip, source: 'trusted_proxy' }
    }
  }
  // Every address in the chain is a trusted proxy: the visitor is the leftmost one
  const leftmost = normalizeIp(entries[0])
  return leftmost === undefined ? { ip: socketIp, source: 'socket' } : { ip: leftmost, source: 'trusted_proxy' }
}
