import { readFileSync } from 'node:fs'

import { formatIp, IpFamily, parseCidr, parseIp } from './cidr'

export interface AsnInfo {
  /** The autonomous system number, such as `28573`, when the file has it */
  asn?: number
  /** The name of the network, such as the operator, when the file has it */
  name?: string
}

interface Range extends AsnInfo {
  start: bigint
  end: bigint
}

/**
 * Where the columns are in the file, counted from 0. The project does not assume the layout of any provider: the
 * operator says which column holds what. A range is either `first` and `last` (two columns) or a single `cidr`.
 */
export interface AsnColumns {
  /** Column of the first address of the range, or of the whole range when it is a CIDR such as `189.0.0.0/16` */
  from: number
  /** Column of the last address; leave out when column `from` is a CIDR */
  to?: number
  asn?: number
  name?: number
}

const maxName = 80

/** Splits a CSV line that may quote its fields. A field with a comma inside must be quoted, and `""` is a quote. */
function csvFields(line: string): string[] {
  const result: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index++
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

/**
 * Which network an address belongs to. The file is the operator's, one line per range, and the project ships no data:
 * the layout depends on where the file came from, and a licence comes with the file. Nothing here stores an address.
 */
export class AsnTable {
  private readonly ranges: Record<IpFamily, Range[]> = { 4: [], 6: [] }

  constructor(entries: ReadonlyArray<AsnInfo & { family: IpFamily; start: bigint; end: bigint }>) {
    for (const family of [4, 6] as const) {
      const sorted = entries
        .filter((entry) => entry.family === family)
        .map(({ start, end, asn, name }) => ({ start, end, asn, name }))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      for (let index = 1; index < sorted.length; index++) {
        if (sorted[index].start <= sorted[index - 1].end) {
          const at = formatIp({ family, value: sorted[index].start })
          throw new Error(`The network ranges overlap at ${at}. Each address must belong to one range.`)
        }
      }
      this.ranges[family] = sorted
    }
  }

  get size(): number {
    return this.ranges[4].length + this.ranges[6].length
  }

  lookup(address: string): AsnInfo | undefined {
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
        const { asn, name } = ranges[middle]
        return { ...(asn === undefined ? {} : { asn }), ...(name === undefined ? {} : { name }) }
      }
    }
    return undefined
  }
}

/**
 * Reads the file. A first line that is not data (a header) is skipped; any other bad line stops it with its number,
 * and so does a column that does not exist, so a wrong layout fails at start instead of quietly finding nothing.
 */
export function parseAsnCsv(text: string, columns: AsnColumns): AsnTable {
  if (columns.asn === undefined && columns.name === undefined) {
    throw new Error('Say at least one of the columns: the network number (asn) or its name')
  }
  const entries: Array<AsnInfo & { family: IpFamily; start: bigint; end: bigint }> = []
  let first = true
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      return
    }
    const parts = csvFields(line)
    const fail = (why: string): never => {
      throw new Error(`Network file, line ${index + 1}: ${why}`)
    }
    const startText = parts[columns.from]
    const isHeader = first && (startText === undefined || parseIp(startText.split('/')[0]) === undefined)
    first = false
    if (isHeader) {
      return
    }
    if (startText === undefined) {
      return fail(`there is no column ${columns.from}`)
    }
    let family: IpFamily
    let start: bigint
    let end: bigint
    if (columns.to === undefined) {
      const cidr = parseCidr(startText)
      if (!cidr) {
        return fail(`"${startText}" is not a range such as 189.0.0.0/16`)
      }
      family = cidr.family
      start = cidr.base
      end = cidr.base + (1n << BigInt((cidr.family === 4 ? 32 : 128) - cidr.bits)) - 1n
    } else {
      const from = parseIp(startText)
      const to = parseIp(parts[columns.to] ?? '')
      if (!from || !to || from.family !== to.family || to.value < from.value) {
        return fail(`"${startText}" and "${parts[columns.to] ?? ''}" are not the first and last address of a range`)
      }
      family = from.family
      start = from.value
      end = to.value
    }
    const entry: AsnInfo & { family: IpFamily; start: bigint; end: bigint } = { family, start, end }
    if (columns.asn !== undefined) {
      const raw = (parts[columns.asn] ?? '').replace(/^AS/i, '')
      if (!/^\d{1,10}$/.test(raw)) {
        return fail(`"${parts[columns.asn] ?? ''}" is not a network number`)
      }
      if (Number(raw) > 0) {
        entry.asn = Number(raw)
      }
    }
    if (columns.name !== undefined) {
      const name = (parts[columns.name] ?? '').replace(/\p{Cc}/gu, ' ').slice(0, maxName)
      if (name !== '') {
        entry.name = name
      }
    }
    if (entry.asn === undefined && entry.name === undefined) {
      return // the file says "unknown" for this range
    }
    entries.push(entry)
  })
  return new AsnTable(entries)
}

export function loadAsnTable(file: string, columns: AsnColumns): AsnTable {
  return parseAsnCsv(readFileSync(file, 'utf8'), columns)
}
