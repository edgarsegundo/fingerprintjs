import { readFileSync } from 'node:fs'

import { Cidr, parseCidr, RangeSet } from './cidr'

export interface IpIntel {
  /** Labels of the lists the address is in, such as `datacenter` or `tor_exit` */
  tags: string[]
}

export interface IpIntelProvider {
  lookup(ip: string): IpIntel
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

  static fromFiles(files: ReadonlyArray<{ tag: string; file: string }>): CidrListProvider {
    return new CidrListProvider(
      files.map(({ tag, file }) => {
        const { cidrs, invalid } = parseCidrList(readFileSync(file, 'utf8'))
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
