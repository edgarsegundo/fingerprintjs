import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from '../config'
import { startServer } from '../server'

import { ApiError, FingerprintClient, signatureHeader, signWebhook, verifyWebhook } from './index'

describe('webhook signature', () => {
  const body = '{"requestId":"r1"}'
  const now = () => 1_800_000_000_000
  const at = 1_800_000_000
  const check = (signature: string | undefined, extra: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({ secret: 'whsec_one', body, signature, now, ...extra })

  it('accepts what was signed with the secret, for exactly that body', () => {
    assert.equal(check(signWebhook('whsec_one', body, at)), true)
    assert.equal(check(signWebhook('whsec_one', `${body} `, at)), false, 'one more space is another body')
    assert.equal(check(signWebhook('whsec_two', body, at)), false, 'another secret')
    assert.equal(check(signWebhook('whsec_one', body, at), { secret: 'whsec_other' }), false)
  })

  it('refuses a time that was changed after signing', () => {
    const signed = signWebhook('whsec_one', body, at)
    assert.equal(check(signed.replace(`t=${at}`, `t=${at + 1}`)), false)
  })

  it('accepts a recent time and refuses an old or a future one, the tolerance included', () => {
    const signedAt = (seconds: number) => signWebhook('whsec_one', body, seconds)
    assert.equal(check(signedAt(at - 300)), true)
    assert.equal(check(signedAt(at - 301)), false)
    assert.equal(check(signedAt(at + 300)), true)
    assert.equal(check(signedAt(at + 301)), false)
    assert.equal(check(signedAt(at - 301), { toleranceSeconds: 600 }), true)
  })

  it('accepts either secret while one is being replaced, on the side that signs and on the side that checks', () => {
    const both = signWebhook(['whsec_old', 'whsec_one'], body, at)
    assert.equal(check(both, { secret: 'whsec_old' }), true)
    assert.equal(check(both), true)
    assert.equal(check(signWebhook('whsec_old', body, at), { secret: ['whsec_one', 'whsec_old'] }), true)
    assert.equal(check(both, { secret: ['whsec_x', 'whsec_y'] }), false)
  })

  it('refuses what is not a signature, without throwing', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      `t=${at}`,
      `v1=${'0'.repeat(64)}`,
      `t=abc,v1=${'0'.repeat(64)}`,
      `t=${at},v1=zz`,
      `t=${at},v1=${'0'.repeat(63)}`,
      `t=-1,v1=${'0'.repeat(64)}`,
      `t=${at},v1=${'0'.repeat(64)}`,
      'x'.repeat(5000),
    ]) {
      assert.equal(check(bad), false, String(bad).slice(0, 40))
    }
  })

  it('names the header in lower case', () => {
    assert.equal(signatureHeader, 'x-fingerprint-signature')
  })
})

describe('client against a real server', () => {
  const PK = 'pk_sdk_0123456789abcdef'
  const SK = 'sk_sdk_secret'
  const config = parseConfig({
    nonceSecret: 'n'.repeat(32),
    tenants: [{ id: 'sdk', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
    nonce: undefined,
    requireNonce: false,
  })

  async function collect(port: number, linkedId: string): Promise<string> {
    const signal = (value: unknown) => ({ value, duration: 1 })
    const response = await fetch(`http://127.0.0.1:${port}/v1/collect?k=${PK}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 1,
        libVersion: '5.3.0',
        collectedAt: Date.now(),
        durationMs: 1,
        linkedId,
        components: { canvas: signal({ winding: true, geometry: 'g', text: 't' }), fonts: signal(['f']) },
        extended: {},
      }),
    })
    return ((await response.json()) as { requestId: string }).requestId
  }

  it('reads an event, lists, walks every page, shows a visitor, and reports errors', async () => {
    const server = await startServer(config, { port: 0 })
    try {
      const ids: string[] = []
      for (const linkedId of ['a1', 'a2', 'a3', 'a4', 'a5']) {
        ids.push(await collect(server.port, linkedId))
        await new Promise((resolve) => setTimeout(resolve, 3))
      }
      const client = new FingerprintClient({ baseUrl: `http://127.0.0.1:${server.port}/`, secretKey: SK })

      const event = await client.getEvent(ids[0])
      assert.equal(event.requestId, ids[0])
      assert.equal(event.identity?.calibrated, false)
      assert.equal(event.risk?.heuristic, true)

      const firstPage = await client.listEvents({ limit: 2, order: 'asc' })
      assert.deepEqual(
        firstPage.events.map((e) => e.requestId),
        ids.slice(0, 2),
      )
      assert.ok(firstPage.next)

      const all: string[] = []
      for await (const visit of client.iterateEvents({ limit: 2, order: 'asc' })) {
        all.push(visit.requestId)
      }
      assert.deepEqual(all, ids)
      const filtered = await client.listEvents({ linkedId: 'a3' })
      assert.deepEqual(
        filtered.events.map((e) => e.requestId),
        [ids[2]],
      )

      const visitorId = firstPage.events[0].visitorId ?? ''
      const visitor = await client.getVisitor(visitorId, { limit: 1 })
      assert.equal(visitor.visitorId, visitorId)
      assert.equal(visitor.events.length, 1)

      await assert.rejects(client.getEvent('00000000-0000-0000-0000-000000000000'), (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 404)
        return true
      })
      const wrong = new FingerprintClient({ baseUrl: `http://127.0.0.1:${server.port}`, secretKey: 'sk_wrong' })
      await assert.rejects(wrong.listEvents(), (error: unknown) => error instanceof ApiError && error.status === 401)
      await assert.rejects(client.listEvents({ limit: 0 }), (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.deepEqual(error.body, { error: 'invalid_parameter', parameter: 'limit' })
        return true
      })
    } finally {
      await server.close()
    }
  })

  it('refuses a key that is not a secret key, so that a public key is not put there by mistake', () => {
    assert.throws(() => new FingerprintClient({ baseUrl: 'http://x', secretKey: PK }), /sk_/)
  })

  it('gives up after the time it was given', async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const client = new FingerprintClient({ baseUrl: 'http://x', secretKey: SK, timeoutMs: 20, fetch: slow })
    // The timer of an abort signal does not keep the process alive, so the test does
    const keepAlive = setTimeout(() => undefined, 2000)
    try {
      await assert.rejects(client.getEvent('r1'), /aborted/)
    } finally {
      clearTimeout(keepAlive)
    }
  })
})
