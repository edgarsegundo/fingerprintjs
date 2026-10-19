import { readFileSync } from 'node:fs'

import { Cidr, parseCidr, RangeSet } from './cidr'
import { parseRangeFile, RangeFileFormat } from './ip_lists'

export interface IpIntel {
  /** Labels of the lists the address is in, such as `datacenter` or `tor_exit` */
  tags: string[]
  /** Two-letter country of the address, when a geolocation file is configured. Wrong often enough to be only a hint. */
  country?: string
}

export interface IpIntelProvider {
  lookup(ip: string): IpIntel
}

/**
 * A file that labels addresses. By default each line is a CIDR (or one address). With `ranges`, each line is a row of
 * comma separated values with the first and last address of a range, in the columns named there.
 */
export interface IpListFile {
  tag: string
  file: string
  ranges?: RangeFileFormat
}

/** Reads one range per line. Empty lines and everything after `#` are ignored. */
export function parseCidrList(text: string): { cidrs: Cidr[]; invalid: string[] } {
  const cidrs: Cidr[] = []
  const invalid: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    if (line === '') {
      continue
    }
    const cidr = parseCidr(line)
    if (cidr) {
      cidrs.push(cidr)
    } else {
      invalid.push(line)
    }
  }
  return { cidrs, invalid }
}

/**
 * Labels an address by the lists it belongs to (data center ranges, Tor exit nodes, known VPNs, etc.).
 * The project ships no data: the operator provides the lists, so the licenses of the data are the operator's choice.
 * Lookups are logarithmic in the size of each list.
 */
export class CidrListProvider implements IpIntelProvider {
  private readonly lists: Array<{ tag: string; set: RangeSet }>

  constructor(lists: ReadonlyArray<{ tag: string; cidrs: readonly Cidr[] }>) {
    this.lists = lists.map(({ tag, cidrs }) => ({ tag, set: new RangeSet(cidrs) }))
  }

  static fromFiles(files: ReadonlyArray<IpListFile>): CidrListProvider {
    return new CidrListProvider(
      files.map((entry) => {
        const { tag, file } = entry
        const text = readFileSync(file, 'utf8')
        if (entry.ranges) {
          const { cidrs, rows, skipped } = parseRangeFile(text, entry.ranges)
          // One line may be a header; many skipped lines mean that the columns are not the ones of this file
          if (skipped > Math.max(1, rows * 0.01)) {
            throw new Error(
              `The IP list "${file}": ${skipped} of ${rows} lines are not a range in columns ` +
                `${entry.ranges.from} and ${entry.ranges.to}. Check the columns and whether they are whole numbers`,
            )
          }
          return { tag, cidrs }
        }
        const { cidrs, invalid } = parseCidrList(text)
        if (invalid.length > 0) {
          throw new Error(`The IP list "${file}" has invalid lines, the first is: ${invalid[0]}`)
        }
        return { tag, cidrs }
      }),
    )
  }

  lookup(ip: string): IpIntel {
    return { tags: this.lists.filter(({ set }) => set.has(ip)).map(({ tag }) => tag) }
  }
}

export const noIpIntel: IpIntelProvider = { lookup: () => ({ tags: [] }) }
