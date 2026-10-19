import assert from 'node:assert/strict'
import type { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'

import { BlockedAddressError, isBlockedAddress, postJson } from './safe_http'

describe('blocked addresses', () => {
  it('blocks private, local and reserved ranges at both of their edges, and nothing around them', () => {
    const cases: Array<[string, boolean]> = [
      ['10.0.0.0', true],
      ['10.255.255.255', true],
      ['9.255.255.255', false],
      ['11.0.0.0', false],
      ['172.15.255.255', false],
      ['172.16.0.0', true],
      ['172.31.255.255', true],
      ['172.32.0.0', false],
      ['192.168.0.1', true],
      ['192.167.255.255', false],
      ['100.63.255.255', false],
      ['100.64.0.0', true],
      ['100.127.255.255', true],
      ['100.128.0.0', false],
      ['127.0.0.1', true],
      ['127.255.255.255', true],
      ['169.254.169.254', true],
      ['169.253.255.255', false],
      ['0.0.0.0', true],
      ['224.0.0.1', true],
      ['255.255.255.255', true],
      ['8.8.8.8', false],
      ['93.184.216.34', false],
      ['::1', true],
      ['::', true],
      ['fe80::1', true],
      ['fc00::1', true],
      ['fdff::1', true],
      ['fb00::1', false],
      ['2001:db8::1', true],
      ['ff02::1', true],
      ['2606:4700:4700::1111', false],
      ['::ffff:10.0.0.1', true],
      ['::ffff:8.8.8.8', false],
      ['not an address', true],
      ['', true],
    ]
    for (const [address, blocked] of cases) {
      assert.equal(isBlockedAddress(address), blocked, address)
    }
  })
})

describe('postJson', () => {
  interface Seen {
    method?: string
    url?: string
    headers: http.IncomingHttpHeaders
    body: string
  }

  async function receiver(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const seen: Seen[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
        handler(req, res)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    return {
      seen,
      url: `http://127.0.0.1:${port}`,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    }
  }

  const base = { timeoutMs: 2000, allowPrivateNetworks: true }

  it('sends the body and the headers as given, and returns the status', async () => {
    const target = await receiver((_req, res) => res.writeHead(202).end('thanks'))
    try {
      const result = await postJson(
        `${target.url}/hook?x=1`,
        '{"a":"é"}',
        { 'Content-Type': 'application/json', 'X-Test': 'yes' },
        base,
      )
      assert.deepEqual(result, { status: 202, body: 'thanks' })
      const [seen] = target.seen
      assert.equal(seen.method, 'POST')
      assert.equal(seen.url, '/hook?x=1')
      assert.equal(seen.body, '{"a":"é"}')
      assert.equal(seen.headers['x-test'], 'yes')
      assert.equal(seen.headers['content-length'], String(Buffer.byteLength('{"a":"é"}')), 'the length is in bytes')
    } finally {
      await target.close()
    }
  })

  it('does not reach a private address unless allowed, and does not even connect', async () => {
    const target = await receiver((_req, res) => res.writeHead(200).end())
    try {
      await assert.rejects(
        postJson(target.url, '{}', {}, { ...base, allowPrivateNetworks: false }),
        BlockedAddressError,
      )
      await assert.rejects(
        postJson(`http://[::1]:${target.port}`, '{}', {}, { ...base, allowPrivateNetworks: false }),
        BlockedAddressError,
      )
      assert.equal(target.seen.length, 0)
    } finally {
      await target.close()
    }
  })

  it('checks the address that a name resolves to, and refuses if any of them is private', async () => {
    const target = await receiver((_req, res) => res.writeHead(200).end())
    const answers = (list: string[]): typeof dnsLookup =>
      ((_host: string, _options: unknown, callback: (e: null, a: unknown) => void) =>
        callback(
          null,
          list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
        )) as never
    try {
      const strict = { ...base, allowPrivateNetworks: false, url: `http://hook.example.test:${target.port}` }
      await assert.rejects(
        postJson(strict.url, '{}', {}, { ...strict, lookup: answers(['127.0.0.1']) }),
        BlockedAddressError,
      )
      await assert.rejects(
        postJson(strict.url, '{}', {}, { ...strict, lookup: answers(['93.184.216.34', '10.0.0.5']) }),
        BlockedAddressError,
        'one private answer among public ones is enough to refuse',
      )
      assert.equal(target.seen.length, 0)
      // Allowed: the connection goes to the address that the lookup gave
      const allowed = await postJson(strict.url, '{}', {}, { ...base, lookup: answers(['127.0.0.1']) })
      assert.equal(allowed.status, 200)
    } finally {
      await target.close()
    }
  })

  it('does not follow a redirect', async () => {
    const target = await receiver((req, res) => {
      if (req.url === '/first') {
        res.writeHead(302, { Location: '/second' }).end()
      } else {
        res.writeHead(200).end()
      }
    })
    try {
      const result = await postJson(`${target.url}/first`, '{}', {}, base)
      assert.equal(result.status, 302)
      assert.deepEqual(
        target.seen.map((seen) => seen.url),
        ['/first'],
      )
    } finally {
      await target.close()
    }
  })

  it('gives up when the receiver does not answer', async () => {
    const target = await receiver(() => undefined)
    try {
      const started = Date.now()
      await assert.rejects(postJson(target.url, '{}', {}, { ...base, timeoutMs: 100 }), /timed out/)
      assert.ok(Date.now() - started < 1500)
    } finally {
      await target.close()
    }
  })

  it('keeps only the start of a long answer', async () => {
    const target = await receiver((_req, res) => res.writeHead(500).end('x'.repeat(5000)))
    try {
      const result = await postJson(target.url, '{}', {}, { ...base, maxResponseBytes: 10 })
      assert.deepEqual(result, { status: 500, body: 'xxxxxxxxxx' })
    } finally {
      await target.close()
    }
  })

  it('refuses an address that is not a web address', async () => {
    await assert.rejects(postJson('not a url', '{}', {}, base), /not a valid URL/)
    await assert.rejects(postJson('ftp://example.com/x', '{}', {}, base), /https:\/\/ or http:\/\//)
    await assert.rejects(postJson('file:///etc/passwd', '{}', {}, base), /https:\/\/ or http:\/\//)
  })
})
