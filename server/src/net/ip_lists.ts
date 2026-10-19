import { Cidr, IpFamily, parseCidr, parseIp } from './cidr'

/** The public lists that can become a file for `ipLists`. The project ships no data: the operator fetches it. */
export type ListKind = 'aws' | 'gcp' | 'tor'

/** Where each list is published. The operator can point to a mirror with `--url`. */
export const defaultListUrls: Record<ListKind, string> = {
  aws: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
  gcp: 'https://www.gstatic.com/ipranges/cloud.json',
  tor: 'https://check.torproject.org/torbulkexitlist',
}

export interface ParsedList {
  /** Valid ranges, each exactly once and in the order they appeared */
  ranges: string[]
  /** Entries that were not valid ranges. A large number means that the format changed. */
  skipped: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function collect(entries: ReadonlyArray<string | undefined>): ParsedList {
  const seen = new Set<string>()
  let skipped = 0
  for (const entry of entries) {
    if (typeof entry === 'string' && parseCidr(entry) !== undefined) {
      seen.add(entry.trim())
    } else {
      skipped++
    }
  }
  return { ranges: [...seen], skipped }
}

/**
 * The ranges of `ip-ranges.json` published by AWS. `services` keeps only those services (for example `EC2`); the list
 * called `AMAZON` contains the ranges of all the others too, so asking for it alone already covers everything.
 */
export function parseAwsRanges(json: unknown, services: readonly string[] = []): ParsedList {
  if (!isRecord(json) || !Array.isArray(json.prefixes)) {
    throw new Error('This is not the AWS list: the field "prefixes" is missing')
  }
  const wanted = (item: unknown) =>
    isRecord(item) && (services.length === 0 || (typeof item.service === 'string' && services.includes(item.service)))
  const v6 = Array.isArray(json.ipv6_prefixes) ? json.ipv6_prefixes : []
  return collect([
    ...json.prefixes.filter(wanted).map((item) => (item as Record<string, unknown>).ip_prefix as string | undefined),
    ...v6.filter(wanted).map((item) => (item as Record<string, unknown>).ipv6_prefix as string | undefined),
  ])
}

/** The ranges of `cloud.json` published by Google Cloud */
export function parseGcpRanges(json: unknown): ParsedList {
  if (!isRecord(json) || !Array.isArray(json.prefixes)) {
    throw new Error('This is not the Google Cloud list: the field "prefixes" is missing')
  }
  return collect(
    json.prefixes.map((item) =>
      isRecord(item) ? ((item.ipv4Prefix ?? item.ipv6Prefix) as string | undefined) : undefined,
    ),
  )
}

/** The bulk exit list of Tor: one address per line */
export function parseTorExitList(text: string): ParsedList {
  return collect(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line !== ''),
  )
}

/** Reads a list of the given kind from the text a server sent */
export function parseList(kind: ListKind, text: string, services: readonly string[] = []): ParsedList {
  if (kind === 'tor') {
    return parseTorExitList(text)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`The ${kind} list is not JSON. Is the address right?`)
  }
  return kind === 'aws' ? parseAwsRanges(json, services) : parseGcpRanges(json)
}

/** The file for `ipLists`: a header that says where the data came from, then one range per line */
export function renderList(kind: ListKind, parsed: ParsedList, source: string, fetchedAt: Date): string {
  return [
    `# ${kind} ranges, fetched ${fetchedAt.toISOString()} from ${source}`,
    `# ${parsed.ranges.length} ranges, ${parsed.skipped} entries skipped`,
    ...parsed.ranges,
    '',
  ].join('\n')
}

/** A file of address ranges with columns, such as the free lists of commercial IP databases */
export interface RangeFileFormat {
  /** The column (from 0) that holds the first address of the range */
  from: number
  /** The column that holds the last address of the range */
  to: number
  /**
   * The addresses are written as whole numbers, as some databases do (IPv4 up to 4294967295, larger numbers are IPv6).
   * Otherwise they are written as addresses.
   */
  numeric: boolean
  /** Only the rows where this column has one of these values (compared without regard to case) */
  match?: { column: number; equals: string[] }
}

/** The cells of one line of comma separated values. Quotes may hold commas; there are no line breaks inside. */
export function csvCells(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** The ranges of CIDR blocks that cover exactly the addresses from `from` to `to` */
export function rangeToCidrs(family: IpFamily, from: bigint, to: bigint): Cidr[] {
  const total = family === 4 ? 32 : 128
  const blocks: Cidr[] = []
  let start = from
  while (start <= to) {
    // The largest block that starts at `start` (its lowest set bit) and does not go past `to`
    let size = start === 0n ? 1n << BigInt(total) : start & -start
    while (start + size - 1n > to) {
      size >>= 1n
    }
    blocks.push({ family, base: start, bits: total - (size.toString(2).length - 1) })
    start += size
  }
  return blocks
}

function addressOf(cell: string | undefined, numeric: boolean): { family: IpFamily; value: bigint } | undefined {
  if (cell === undefined || cell === '') {
    return undefined
  }
  if (!numeric) {
    return parseIp(cell)
  }
  if (!/^\d{1,40}$/.test(cell)) {
    return undefined
  }
  const value = BigInt(cell)
  if (value <= 0xffffffffn) {
    return { family: 4, value }
  }
  return value < 1n << 128n ? { family: 6, value } : undefined
}

/**
 * Reads ranges from a file with columns. A first line that is a header is not a range and is counted in `skipped`,
 * as is
 * every line that is not a range. A file where most lines are skipped has the wrong columns, and the caller refuses it.
 */
export function parseRangeFile(
  text: string,
  format: RangeFileFormat,
): { cidrs: Cidr[]; rows: number; skipped: number } {
  const cidrs: Cidr[] = []
  let rows = 0
  let skipped = 0
  const wanted = format.match && new Set(format.match.equals.map((value) => value.toLowerCase()))
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue
    }
    const cells = csvCells(line)
    if (format.match && wanted && !wanted.has((cells[format.match.column] ?? '').toLowerCase())) {
      // A row that is not wanted is not a mistake, unless it is not a row of this file at all (a header: see below)
      if (addressOf(cells[format.from], format.numeric) !== undefined) {
        continue
      }
    }
    rows++
    const first = addressOf(cells[format.from], format.numeric)
    const last = addressOf(cells[format.to], format.numeric)
    if (!first || !last || first.family !== last.family || first.value > last.value) {
      skipped++
      continue
    }
    cidrs.push(...rangeToCidrs(first.family, first.value, last.value))
  }
  return { cidrs, rows, skipped }
}
