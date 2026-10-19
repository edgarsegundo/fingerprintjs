import { isIP } from 'node:net'

export type IpFamily = 4 | 6

export interface ParsedIp {
  family: IpFamily
  value: bigint
}

export interface Cidr {
  family: IpFamily
  /** First address of the range, with the host bits cleared */
  base: bigint
  bits: number
}

function parseIPv4(text: string): number | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) {
    return undefined
  }
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined
    }
    const octet = Number(part)
    if (octet > 255) {
      return undefined
    }
    value = value * 256 + octet
  }
  return value
}

function parseIPv6(input: string): bigint | undefined {
  let text = input
  const zoneIndex = text.indexOf('%')
  if (zoneIndex >= 0) {
    text = text.slice(0, zoneIndex)
  }

  // An embedded IPv4 address (::ffff:1.2.3.4) takes the place of the last two groups
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    const v4 = parseIPv4(text.slice(lastColon + 1))
    if (v4 === undefined) {
      return undefined
    }
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) {
    return undefined
  }
  const split = (part: string) => (part === '' ? [] : part.split(':'))
  const head = split(halves[0])
  const tail = halves.length === 2 ? split(halves[1]) : []
  let groups: string[]
  if (halves.length === 2) {
    if (head.length + tail.length > 7) {
      return undefined
    }
    groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) {
    return undefined
  }

  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return undefined
    }
    value = (value << 16n) | BigInt(parseInt(group, 16))
  }
  return value
}

/** Parses an IPv4 or IPv6 address. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is returned as IPv4. */
export function parseIp(input: string): ParsedIp | undefined {
  const text = input.trim()
  const family = isIP(text.split('%')[0])
  if (family === 4) {
    const v4 = parseIPv4(text)
    return v4 === undefined ? undefined : { family: 4, value: BigInt(v4) }
  }
  if (family === 6) {
    const v6 = parseIPv6(text)
    if (v6 === undefined) {
      return undefined
    }
    if (v6 >> 32n === 0xffffn) {
      return { family: 4, value: v6 & 0xffffffffn }
    }
    return { family: 6, value: v6 }
  }
  return undefined
}

export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) {
    const v = Number(ip.value)
    return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')
  }
  const groups: string[] = []
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((ip.value >> shift) & 0xffffn).toString(16))
  }
  return groups.join(':')
}

/** The address as a normalized string, or `undefined` if it isn't an IP address */
export function normalizeIp(input: string): string | undefined {
  const parsed = parseIp(input)
  return parsed && formatIp(parsed)
}

function totalBits(family: IpFamily): number {
  return family === 4 ? 32 : 128
}

function maskFor(family: IpFamily, bits: number): bigint {
  const total = totalBits(family)
  return ((1n << BigInt(total)) - 1n) ^ ((1n << BigInt(total - bits)) - 1n)
}

/** Parses `10.0.0.0/8`, `2001:db8::/32` or a single address (a /32 or /128). Returns `undefined` if invalid. */
export function parseCidr(input: string): Cidr | undefined {
  const parts = input.trim().split('/')
  if (parts.length > 2) {
    return undefined
  }
  const [addressText, bitsText] = parts
  const ip = parseIp(addressText)
  if (!ip) {
    return undefined
  }
  let bits = totalBits(ip.family)
  if (bitsText !== undefined) {
    if (!/^\d{1,3}$/.test(bitsText)) {
      return undefined
    }
    bits = Number(bitsText)
    // An IPv4-mapped IPv6 range such as ::ffff:10.0.0.0/104 is expressed against IPv4
    if (isIP(addressText) === 6 && ip.family === 4) {
      bits -= 96
    }
    if (bits < 0 || bits > totalBits(ip.family)) {
      return undefined
    }
  }
  return { family: ip.family, base: ip.value & maskFor(ip.family, bits), bits }
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  return cidr.family === ip.family && (ip.value & maskFor(cidr.family, cidr.bits)) === cidr.base
}

/** True if the address belongs to any of the ranges */
export function isInAny(cidrs: readonly Cidr[], address: string): boolean {
  const ip = parseIp(address)
  return !!ip && cidrs.some((cidr) => cidrContains(cidr, ip))
}

/** The address with the host part cleared: the first `bits4` bits of an IPv4 address or `bits6` of an IPv6 one */
export function truncateIp(address: string, bits4: number, bits6: number): string | undefined {
  const ip = parseIp(address)
  if (!ip) {
    return undefined
  }
  const bits = ip.family === 4 ? bits4 : bits6
  return formatIp({ family: ip.family, value: ip.value & maskFor(ip.family, bits) })
}

/**
 * The network of the address: /24 for IPv4 and /64 for IPv6.
 * IPv6 devices rotate the last 64 bits (privacy extensions), so the /64 is the stable part.
 */
export function ipPrefix(address: string): string | undefined {
  const ip = parseIp(address)
  if (!ip) {
    return undefined
  }
  const bits = ip.family === 4 ? 24 : 64
  const base = formatIp({ family: ip.family, value: ip.value & maskFor(ip.family, bits) })
  if (ip.family === 4) {
    return `${base}/${bits}`
  }
  return `${base.split(':').slice(0, 4).join(':')}::/${bits}`
}

/** A sorted, non-overlapping list of ranges that answers "is this address in the list" in logarithmic time */
export class RangeSet {
  private readonly ranges: Record<IpFamily, Array<[bigint, bigint]>> = { 4: [], 6: [] }

  constructor(cidrs: readonly Cidr[]) {
    for (const family of [4, 6] as const) {
      const sorted = cidrs
        .filter((cidr) => cidr.family === family)
        .map((cidr): [bigint, bigint] => [
          cidr.base,
          cidr.base | (maskFor(family, cidr.bits) ^ ((1n << BigInt(totalBits(family))) - 1n)),
        ])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      const merged: Array<[bigint, bigint]> = []
      for (const range of sorted) {
        const last = merged[merged.length - 1]
        if (last && range[0] <= last[1] + 1n) {
          if (range[1] > last[1]) {
            last[1] = range[1]
          }
        } else {
          merged.push([range[0], range[1]])
        }
      }
      this.ranges[family] = merged
    }
  }

  has(address: string): boolean {
    const ip = parseIp(address)
    if (!ip) {
      return false
    }
    const ranges = this.ranges[ip.family]
    let low = 0
    let high = ranges.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const [start, end] = ranges[middle]
      if (ip.value < start) {
        high = middle - 1
      } else if (ip.value > end) {
        low = middle + 1
      } else {
        return true
      }
    }
    return false
  }
}
