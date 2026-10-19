import { readFileSync } from 'node:fs'

/** Which countries use each time zone, from the `zone.tab` file of the IANA time zone database */
export type TimezoneCountries = ReadonlyMap<string, readonly string[]>

/**
 * Reads `zone.tab` (on most systems at `/usr/share/zoneinfo/zone.tab`): tab-separated lines of country, coordinates,
 * zone name and an optional comment. Comment lines start with `#`.
 */
export function parseZoneTab(text: string): TimezoneCountries {
  const countries = new Map<string, string[]>()
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith('#') || rawLine.trim() === '') {
      continue
    }
    const [country, , zone] = rawLine.split('\t')
    if (!country || !zone || !/^[A-Z]{2}$/.test(country)) {
      throw new Error(`The time zone table has a line that is not "country, coordinates, zone": "${rawLine}"`)
    }
    countries.set(zone, [...(countries.get(zone) ?? []), country])
  }
  if (countries.size === 0) {
    throw new Error('The time zone table has no zones. Is it a zone.tab file?')
  }
  return countries
}

export function loadZoneTab(file: string): TimezoneCountries {
  return parseZoneTab(readFileSync(file, 'utf8'))
}

/**
 * Whether a zone reported by the browser fits a country found from the IP. `undefined` means "cannot tell": the zone
 * is not in the table (the browser may use an old alias for a zone that was renamed) or there is no country. It is
 * never a mismatch, so an alias cannot make an honest visitor look suspicious.
 */
export function zoneFitsCountry(
  table: TimezoneCountries,
  zone: string | undefined,
  country: string | undefined,
): boolean | undefined {
  if (!zone || !country) {
    return undefined
  }
  const countries = table.get(zone)
  return countries === undefined ? undefined : countries.includes(country.toUpperCase())
}
