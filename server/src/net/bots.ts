import { reverse, resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'

/** A search engine crawler that publishes how to tell the real one from a copy of its name */
export interface KnownBot {
  name: string
  /** What its user agent looks like */
  userAgent: RegExp
  /**
   * The domains that the host name of a real crawler ends in, each with its leading dot. These are the domains that the
   * search engines publish for this check; they should be read again from their documentation before being relied on.
   */
  domains: readonly string[]
}

export const knownBots: readonly KnownBot[] = [
  {
    name: 'googlebot',
    userAgent: /Googlebot|Google-InspectionTool|GoogleOther|AdsBot-Google|Mediapartners-Google|APIs-Google/i,
    domains: ['.googlebot.com', '.google.com', '.googleusercontent.com'],
  },
  { name: 'bingbot', userAgent: /bingbot|BingPreview|adidxbot/i, domains: ['.search.msn.com'] },
  { name: 'applebot', userAgent: /Applebot/i, domains: ['.applebot.apple.com'] },
  {
    name: 'yandexbot',
    userAgent: /YandexBot|YandexImages|YandexMobileBot/i,
    domains: ['.yandex.ru', '.yandex.net', '.yandex.com'],
  },
  { name: 'baiduspider', userAgent: /Baiduspider/i, domains: ['.baidu.com', '.baidu.jp'] },
]

export interface Crawler {
  /** The crawler that the user agent says it is */
  claimed: string
  /**
   * `true`: the address belongs to that crawler (the name of its host is in the published domains, and that name points
   * back to the address). `false`: it does not. `null`: it could not be checked (DNS did not answer in time).
   */
  verified: boolean | null
}

/** The two questions of the check. Replaceable, so that the tests do not need a network. */
export interface DnsResolver {
  /** The names of an address. Rejects with a `code` such as `ENOTFOUND` when there are none. */
  reverse(ip: string): Promise<string[]>
  /** The addresses (IPv4 and IPv6) of a name */
  addresses(host: string): Promise<string[]>
}

export const systemResolver: DnsResolver = {
  reverse: (ip) => reverse(ip),
  async addresses(host) {
    const found: string[] = []
    let failure: unknown
    for (const lookup of [resolve4, resolve6]) {
      try {
        found.push(...(await lookup(host)))
      } catch (error) {
        // A name without records of one kind is normal; only another kind of failure is worth reporting
        if (!['ENODATA', 'ENOTFOUND'].includes(String((error as { code?: string }).code))) {
          failure = error
        }
      }
    }
    if (found.length === 0 && failure !== undefined) {
      throw failure
    }
    return found
  },
}

const noAnswerCodes = new Set(['ENOTFOUND', 'ENODATA'])
const isNoAnswer = (error: unknown): boolean => noAnswerCodes.has(String((error as { code?: string }).code))

/** The same address written two ways is one address */
function canonical(ip: string): string {
  const version = isIP(ip)
  if (version === 6) {
    try {
      return new URL(`http://[${ip}]`).hostname.toLowerCase()
    } catch {
      return ip.toLowerCase()
    }
  }
  return ip
}

export interface VerifierOptions {
  resolver?: DnsResolver
  now?: () => number
  /** How many names may be waiting for DNS at once. More than this, a visit is not checked and is called unknown. */
  maxConcurrent?: number
  maxCacheEntries?: number
}

export interface VerifyParams {
  timeoutMs: number
  cacheSeconds: number
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

/**
 * Tells a real search crawler from someone who only borrowed its name. A crawler is checked in two steps, the way the
 * search engines ask for it: the name of the address must be in the engine's domains, and that name must lead back to
 * the same address. Only a user agent that claims to be a known crawler is ever looked up, answers are remembered for a
 * while, and a lookup that cannot be answered is `null` and never `false`: a DNS that is down must not make a real
 * crawler look fake.
 */
export class CrawlerVerifier {
  private readonly resolver: DnsResolver
  private readonly now: () => number
  private readonly maxConcurrent: number
  private readonly maxCacheEntries: number
  private readonly cache = new Map<string, { until: number; verified: boolean }>()
  private waiting = 0

  constructor(options: VerifierOptions = {}) {
    this.resolver = options.resolver ?? systemResolver
    this.now = options.now ?? Date.now
    this.maxConcurrent = options.maxConcurrent ?? 8
    this.maxCacheEntries = options.maxCacheEntries ?? 10_000
  }

  /** The crawler that the user agent claims to be, or `undefined` when it claims none */
  static claimedBy(userAgent: string | undefined): KnownBot | undefined {
    return userAgent === undefined ? undefined : knownBots.find((bot) => bot.userAgent.test(userAgent))
  }

  async check(userAgent: string | undefined, ip: string, params: VerifyParams): Promise<Crawler | undefined> {
    const bot = CrawlerVerifier.claimedBy(userAgent)
    if (!bot) {
      return undefined
    }
    const key = `${bot.name}|${canonical(ip)}`
    const cached = this.cache.get(key)
    if (cached && cached.until > this.now()) {
      return { claimed: bot.name, verified: cached.verified }
    }
    if (this.waiting >= this.maxConcurrent) {
      return { claimed: bot.name, verified: null }
    }
    this.waiting++
    try {
      const verified = await withTimeout(this.lookup(bot, ip), params.timeoutMs)
      this.remember(key, verified, params.cacheSeconds)
      return { claimed: bot.name, verified }
    } catch (error) {
      if (isNoAnswer(error)) {
        // The address has no name at all: a real crawler always has one
        this.remember(key, false, params.cacheSeconds)
        return { claimed: bot.name, verified: false }
      }
      return { claimed: bot.name, verified: null }
    } finally {
      this.waiting--
    }
  }

  private async lookup(bot: KnownBot, ip: string): Promise<boolean> {
    const names = await this.resolver.reverse(ip)
    const wanted = canonical(ip)
    for (const raw of names) {
      const name = raw.toLowerCase().replace(/\.$/, '')
      // The dot in the domain is part of the test: "evilgooglebot.com" is not in "googlebot.com"
      if (!bot.domains.some((domain) => name.endsWith(domain))) {
        continue
      }
      let back: string[]
      try {
        back = await this.resolver.addresses(name)
      } catch (error) {
        if (isNoAnswer(error)) {
          continue
        }
        throw error
      }
      if (back.some((address) => canonical(address) === wanted)) {
        return true
      }
    }
    return false
  }

  private remember(key: string, verified: boolean, seconds: number): void {
    if (this.cache.size >= this.maxCacheEntries) {
      // Past the limit the oldest answers go first. A Map keeps the order in which keys were added.
      const oldest = this.cache.keys().next()
      if (!oldest.done) {
        this.cache.delete(oldest.value)
      }
    }
    this.cache.set(key, { until: this.now() + seconds * 1000, verified })
  }
}
