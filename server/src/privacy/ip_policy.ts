import { createHmac } from 'node:crypto'

import { truncateIp } from '../net/cidr'
import type { NetworkSignals } from '../net/signals'

/**
 * What is kept of the visitor's address. The address is personal data, and it is the part of a visit that is easiest to
 * link to a person outside the system, so a tenant can keep less of it:
 * - `full`: the address as it is;
 * - `truncated`: IPv4 to /24 and IPv6 to /48, which still tells the network but not the household;
 * - `hash`: a keyed hash, different for each tenant. Two visits from the same address still match each other, and the
 *   address cannot be read back, but anyone who has the key can test a guess, so it is pseudonymous and not anonymous;
 * - `none`: nothing.
 *
 * The labels from the lists (data center, Tor) and the country are worked out before this and kept, in every mode.
 */
export type IpStorage = 'full' | 'truncated' | 'hash' | 'none'

export const ipStorageModes: readonly IpStorage[] = ['full', 'truncated', 'hash', 'none']

const hashOf = (key: Buffer, tenantId: string, text: string): string =>
  createHmac('sha256', key).update(`${tenantId}\n${text}`).digest('base64url').slice(0, 22)

/** The key of the address hashes, made from a secret so that the secret itself is never used for two purposes */
export function ipHashKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('ip-hash-v1').digest()
}

/** The stored form of an address under a mode. `undefined` means that nothing is kept. */
export function protectIp(address: string, mode: IpStorage, key: Buffer, tenantId: string): string | undefined {
  switch (mode) {
    case 'full':
      return address
    case 'truncated':
      return truncateIp(address, 24, 48)
    case 'hash':
      return `h_${hashOf(key, tenantId, address)}`
    case 'none':
      return undefined
  }
}

/** The network signals as they are stored: the address and its network, in the form the mode keeps */
export function protectNetwork(
  network: NetworkSignals,
  mode: IpStorage,
  key: Buffer,
  tenantId: string,
): NetworkSignals {
  if (mode === 'full') {
    return network
  }
  const ip = protectIp(network.ip, mode, key, tenantId) ?? ''
  let prefix = ''
  if (mode === 'truncated') {
    const cut = truncateIp(network.ip, 24, 48)
    prefix = cut === undefined ? '' : `${cut}/${network.ipVersion === 4 ? 24 : 48}`
  } else if (mode === 'hash') {
    prefix = `hp_${hashOf(key, tenantId, network.ipPrefix)}`
  }
  return { ...network, ip, ipPrefix: prefix }
}
