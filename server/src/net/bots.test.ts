import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CrawlerVerifier, DnsResolver } from './bots'

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const params = { timeoutMs: 200, cacheSeconds: 60 }

/** A DNS made of tables, that counts how often it was asked */
function dns(names: Record<string, string[] | Error>, addresses: Record<string, string[] | Error>) {
  const calls = { reverse: 0, addresses: 0 }
  const resolver: DnsResolver = {
    async reverse(ip) {
      calls.reverse++
      const answer = names[ip] ?? Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    },
    async addresses(host) {
      calls.addresses++
      const answer = addresses[host] ?? Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    },
  }
  return { resolver, calls }
}

describe('verifying search crawlers', () => {
  it('says true for a real crawler: a name in the published domain that leads back to the address', async () => {
    const { resolver } = dns(
      { '66.249.66.1': ['crawl-66-249-66-1.googlebot.com.'] },
      { 'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'] },
    )
    const verifier = new CrawlerVerifier({ resolver })
    assert.deepEqual(await verifier.check(GOOGLEBOT, '66.249.66.1', params), { claimed: 'googlebot', verified: true })
  })

  it('says true for a real crawler on IPv6, whichever way the address is written', async () => {
    const { resolver } = dns(
      { '2001:4860:4801:10::1': ['crawl-1.googlebot.com'] },
      { 'crawl-1.googlebot.com': ['2001:4860:4801:0010:0000:0000:0000:0001'] },
    )
    const verifier = new CrawlerVerifier({ resolver })
    assert.equal((await verifier.check(GOOGLEBOT, '2001:4860:4801:10::1', params))?.verified, true)
  })

  it('says false for a copy of the name, in each way a copy can fail', async () => {
    const cases: Array<[string, Record<string, string[]>, Record<string, string[]>]> = [
      ['another domain', { '203.0.113.5': ['host.example.com'] }, { 'host.example.com': ['203.0.113.5'] }],
      ['a lookalike domain', { '203.0.113.5': ['evilgooglebot.com'] }, { 'evilgooglebot.com': ['203.0.113.5'] }],
      [
        'a suffix inside a longer name',
        { '203.0.113.5': ['crawl.googlebot.com.evil.net'] },
        { 'crawl.googlebot.com.evil.net': ['203.0.113.5'] },
      ],
      [
        'a name that leads to another address',
        { '203.0.113.5': ['crawl.googlebot.com'] },
        { 'crawl.googlebot.com': ['66.249.66.1'] },
      ],
      ['no name', {}, {}],
    ]
    for (const [label, names, addresses] of cases) {
      const { resolver } = dns(names, addresses)
      const result = await new CrawlerVerifier({ resolver }).check(GOOGLEBOT, '203.0.113.5', params)
      assert.deepEqual(result, { claimed: 'googlebot', verified: false }, label)
    }
  })

  it('says unknown, never false, when DNS cannot answer: a failure, or no answer in time', async () => {
    const failing = dns({ '66.249.66.1': Object.assign(new Error('server failure'), { code: 'ESERVFAIL' }) }, {})
    assert.deepEqual(
      await new CrawlerVerifier({ resolver: failing.resolver }).check(GOOGLEBOT, '66.249.66.1', params),
      {
        claimed: 'googlebot',
        verified: null,
      },
    )
    const slow: DnsResolver = { reverse: () => new Promise(() => undefined), addresses: async () => [] }
    assert.equal(
      (await new CrawlerVerifier({ resolver: slow }).check(GOOGLEBOT, '66.249.66.1', { ...params, timeoutMs: 20 }))
        ?.verified,
      null,
    )
    const half = dns(
      { '66.249.66.1': ['crawl.googlebot.com'] },
      { 'crawl.googlebot.com': Object.assign(new Error('x'), { code: 'ESERVFAIL' }) },
    )
    assert.equal(
      (await new CrawlerVerifier({ resolver: half.resolver }).check(GOOGLEBOT, '66.249.66.1', params))?.verified,
      null,
    )
  })

  it('does not look anything up for a visitor that does not claim to be a crawler', async () => {
    const { resolver, calls } = dns({}, {})
    const verifier = new CrawlerVerifier({ resolver })
    assert.equal(
      await verifier.check('Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605', '203.0.113.5', params),
      undefined,
    )
    assert.equal(await verifier.check(undefined, '203.0.113.5', params), undefined)
    assert.deepEqual(calls, { reverse: 0, addresses: 0 })
  })

  it('remembers an answer for the time asked, and asks again after it', async () => {
    let clock = 1_000_000
    const { resolver, calls } = dns(
      { '66.249.66.1': ['crawl.googlebot.com'] },
      { 'crawl.googlebot.com': ['66.249.66.1'] },
    )
    const verifier = new CrawlerVerifier({ resolver, now: () => clock })
    await verifier.check(GOOGLEBOT, '66.249.66.1', params)
    await verifier.check(GOOGLEBOT, '66.249.66.1', params)
    assert.equal(calls.reverse, 1)
    clock += 61_000
    await verifier.check(GOOGLEBOT, '66.249.66.1', params)
    assert.equal(calls.reverse, 2)
  })

  it('does not remember an unknown, so that a DNS that comes back is used', async () => {
    const { resolver, calls } = dns({ '66.249.66.1': Object.assign(new Error('x'), { code: 'ESERVFAIL' }) }, {})
    const verifier = new CrawlerVerifier({ resolver })
    await verifier.check(GOOGLEBOT, '66.249.66.1', params)
    await verifier.check(GOOGLEBOT, '66.249.66.1', params)
    assert.equal(calls.reverse, 2)
  })

  it('does not wait on more lookups than it was allowed, and calls the rest unknown', async () => {
    const release: Array<() => void> = []
    let asked = 0
    const resolver: DnsResolver = {
      reverse: () => {
        asked++
        return new Promise((resolve) => release.push(() => resolve(['crawl.googlebot.com'])))
      },
      addresses: async () => ['66.249.66.1'],
    }
    const verifier = new CrawlerVerifier({ resolver, maxConcurrent: 2 })
    const first = verifier.check(GOOGLEBOT, '66.249.66.1', { ...params, timeoutMs: 5000 })
    const second = verifier.check(GOOGLEBOT, '66.249.66.2', { ...params, timeoutMs: 5000 })
    const third = await verifier.check(GOOGLEBOT, '66.249.66.3', params)
    assert.deepEqual(third, { claimed: 'googlebot', verified: null })
    assert.equal(asked, 2, 'the third was not even asked')
    release.forEach((go) => go())
    await Promise.all([first, second])
  })

  it('keeps the memory of answers within its limit', async () => {
    const { resolver, calls } = dns({}, {})
    const verifier = new CrawlerVerifier({ resolver, maxCacheEntries: 3 })
    for (let n = 1; n <= 10; n++) {
      await verifier.check(GOOGLEBOT, `203.0.113.${n}`, params)
    }
    await verifier.check(GOOGLEBOT, '203.0.113.1', params) // gone from the memory: asked again
    assert.equal(calls.reverse, 11)
    await verifier.check(GOOGLEBOT, '203.0.113.10', params) // still there
    assert.equal(calls.reverse, 11)
  })
})
