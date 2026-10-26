import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { RunningServer, startServer } from './server'

const PK = 'pk_samemachine_0123456789abcdef'
const SK = 'sk_samemachine_secret'

const config = (settings: Record<string, unknown> = {}) =>
  parseConfig({
    nonceSecret: 'n'.repeat(32),
    tenants: [{ id: 't', publicKey: PK, secretKeySha256: [sha256Hex(SK)], settings }],
    rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
  })

const signal = (value: unknown) => ({ value, duration: 1 })

const chromeUa =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/155.0.0.0 Safari/537.36'
const firefoxUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'

/** The same machine: what the screen, the system and the graphics family say does not depend on the browser */
const machine = {
  screenResolution: signal([1792, 1120]),
  colorDepth: signal(30),
  colorGamut: signal('srgb'),
  hdr: signal(false),
  platform: signal('MacIntel'),
  timezone: signal('America/Sao_Paulo'),
}

async function visit(server: RunningServer, userAgent: string, renderer: string): Promise<string> {
  const base = `http://127.0.0.1:${server.port}`
  const { nonce } = (await (await fetch(`${base}/v1/nonce?k=${PK}`)).json()) as { nonce: string }
  const response = await fetch(`${base}/v1/collect?k=${PK}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now(),
      durationMs: 1,
      nonce,
      components: { ...machine, webGlBasics: signal({ renderer, vendor: 'v' }) },
      extended: {},
    }),
  })
  assert.equal(response.status, 200)
  return ((await response.json()) as { requestId: string }).requestId
}

const identityOf = async (server: RunningServer, requestId: string) =>
  (
    (await (
      await fetch(`http://127.0.0.1:${server.port}/v1/events/${requestId}`, {
        headers: { Authorization: `Bearer ${SK}` },
      })
    ).json()) as {
      identity: {
        visitorId: string
        matched: boolean
        sameMachine?: { links: Array<{ visitorId: string; browsers: string[] }> }
      }
    }
  ).identity

describe('same machine in another browser, through the server', () => {
  it('links the Firefox visit to the Chrome one without joining them', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      const first = await identityOf(
        server,
        await visit(server, chromeUa, 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)'),
      )
      const second = await identityOf(server, await visit(server, firefoxUa, 'Intel(R) HD Graphics 400, or similar'))
      assert.notEqual(second.visitorId, first.visitorId, 'one id per browser')
      assert.equal(second.matched, false)
      assert.deepEqual(
        second.sameMachine?.links.map((link) => [link.visitorId, link.browsers]),
        [[first.visitorId, ['chrome']]],
      )
    } finally {
      await server.close()
    }
  })

  it('links nothing when the tenant turned it off', async () => {
    const server = await startServer(config({ identity: { sameMachine: { enabled: false } } }), { port: 0 })
    try {
      await visit(server, chromeUa, 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)')
      const second = await identityOf(server, await visit(server, firefoxUa, 'Intel(R) HD Graphics 400, or similar'))
      assert.equal(second.sameMachine, undefined)
    } finally {
      await server.close()
    }
  })

  it('does not link two visits of the same browser', async () => {
    const server = await startServer(config(), { port: 0 })
    try {
      await visit(server, chromeUa, 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)')
      const second = await identityOf(
        server,
        await visit(server, chromeUa, 'ANGLE (Intel Inc., Intel(R) UHD Graphics 630, OpenGL 4.1)'),
      )
      assert.equal(second.sameMachine, undefined)
    } finally {
      await server.close()
    }
  })
})
