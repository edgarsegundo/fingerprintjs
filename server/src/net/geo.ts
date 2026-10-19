import { readFileSync } from 'node:fs'

import { formatIp, IpFamily, parseCidr, parseIp } from './cidr'
import type { IpIntel, IpIntelProvider } from './ip_intel'

interface Range {
  start: bigint
  end: bigint
  country: string
}

const countryCode = /^[A-Za-z]{2}$/

/**
 * Splits a line of a CSV that may quote its fields, such as `"1.0.0.0","1.0.0.255","AU"`. It is only the shape of the
 * files published by IP geolocation databases, not a general CSV reader: a field with a comma inside is not supported.
 */
const fields = (line: string): string[] => line.split(',').map((field) => field.trim().replace(/^"(.*)"$/, '$1'))

/**
 * Where an address is, by country. The file is the operator's: one line per range, either `range,CC` (a CIDR) or
 * `first,last,CC` (the layout of the free DB-IP "Lite" country file). The project ships no data, and a database is
 * only as good as its maker says: IP geolocation is wrong for many mobile networks, VPNs and company networks.
 */
export class CountryTable {
  private readonly ranges: Record<IpFamily, Range[]> = { 4: [], 6: [] }

  constructor(entries: ReadonlyArray<{ family: IpFamily; start: bigint; end: bigint; country: string }>) {
    for (const family of [4, 6] as const) {
      const sorted = entries
        .filter((entry) => entry.family === family)
        .map(({ start, end, country }) => ({ start, end, country }))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      for (let index = 1; index < sorted.length; index++) {
        if (sorted[index].start <= sorted[index - 1].end) {
          const at = formatIp({ family, value: sorted[index].start })
          throw new Error(`The geolocation ranges overlap at ${at}. Each address must belong to one range.`)
        }
      }
      this.ranges[family] = sorted
    }
  }

  lookup(address: string): string | undefined {
    const ip = parseIp(address)
    if (!ip) {
      return undefined
    }
    const ranges = this.ranges[ip.family]
    let low = 0
    let high = ranges.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (ip.value < ranges[middle].start) {
        high = middle - 1
      } else if (ip.value > ranges[middle].end) {
        low = middle + 1
      } else {
        return ranges[middle].country
      }
    }
    return undefined
  }
}

/** Reads the CSV. A first line that is not data (a header) is skipped; any other bad line stops it with its number. */
export function parseCountryCsv(text: string): CountryTable {
  const entries: Array<{ family: IpFamily; start: bigint; end: bigint; country: string }> = []
  const lines = text.split(/\r?\n/)
  let first = true
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/#.*/, '').trim()
    if (line === '') {
      return
    }
    const parts = fields(line)
    const isHeader = first && parseIp(parts[0].split('/')[0]) === undefined
    first = false
    if (isHeader) {
      return
    }
    const fail = (): never => {
      throw new Error(`Geolocation file, line ${index + 1}: expected "range,CC" or "first,last,CC", found "${line}"`)
    }
    const country = (parts.length === 2 ? parts[1] : parts[2]) ?? ''
    if ((parts.length !== 2 && parts.length !== 3) || !countryCode.test(country)) {
      return fail()
    }
    if (country.toUpperCase() === 'ZZ') {
      return // "unknown" in this format
    }
    if (parts.length === 2) {
      const cidr = parseCidr(parts[0])
      if (!cidr) {
        return fail()
      }
      const size = 1n << BigInt((cidr.family === 4 ? 32 : 128) - cidr.bits)
      entries.push({
        family: cidr.family,
        start: cidr.base,
        end: cidr.base + size - 1n,
        country: country.toUpperCase(),
      })
      return
    }
    const start = parseIp(parts[0])
    const end = parseIp(parts[1])
    if (!start || !end || start.family !== end.family || end.value < start.value) {
      return fail()
    }
    entries.push({ family: start.family, start: start.value, end: end.value, country: country.toUpperCase() })
  })
  return new CountryTable(entries)
}

export function loadCountryTable(file: string): CountryTable {
  return parseCountryCsv(readFileSync(file, 'utf8'))
}

/** Puts together what several providers know: all the tags, and the first country that any of them gives */
export class CompositeIntel implements IpIntelProvider {
  constructor(private readonly providers: readonly IpIntelProvider[]) {}

  lookup(ip: string): IpIntel {
    const tags = new Set<string>()
    let country: string | undefined
    for (const provider of this.providers) {
      const found = provider.lookup(ip)
      found.tags.forEach((tag) => tags.add(tag))
      country = country ?? found.country
    }
    return { tags: [...tags], ...(country ? { country } : {}) }
  }
}

/** Answers with the country only */
export class GeoProvider implements IpIntelProvider {
  constructor(private readonly table: CountryTable) {}

  lookup(ip: string): IpIntel {
    const country = this.table.lookup(ip)
    return { tags: [], ...(country ? { country } : {}) }
  }
}
