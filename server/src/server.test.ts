import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import tls from 'node:tls'

import { parseConfig, sha256Hex } from './config'
import { SqliteIdentityStore } from './identity/sqlite_store'
import { verifyWebhook } from './sdk/signature'
import { startServer } from './server'
import { MemoryEventStore } from './store/memory'
import { SqliteEventStore } from './store/sqlite'

/** The part of the identity answer that the tests look at */
interface IdentityView {
  visitorId: string
  matched: boolean
  calibrated: boolean
  probability: number | null
  provisionalProbability: number | null
  candidates: number
  devices: number
  explanation: Array<{ feature: string; outcome: string; weight: number }>
}

const SK = 'sk_tls_test_secret'
const PK = 'pk_tls_test_0123456789'

function hasOpenssl(): boolean {
  return spawnSync('openssl', ['version']).status === 0
}

describe('server with TLS (reads the ClientHello)', { skip: hasOpenssl() ? false : 'openssl is not installed' }, () => {
  async function withServer(run: (port: number, store: MemoryEventStore) => Promise<void>, host = '127.0.0.1') {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-tls-'))
    const keyFile = path.join(dir, 'key.pem')
    const certFile = path.join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )
    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
      tls: { keyFile, certFile },
      listen: { host },
      rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    })
    const store = new MemoryEventStore()
    const server = await startServer(config, { port: 0, store })
    try {
      await run(server.port, store)
    } finally {
      // `close` also closes the store; the test is over by then
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const body = (nonce: string) =>
    JSON.stringify({
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now(),
      durationMs: 1,
      nonce,
      components: {},
      extended: {},
    })

  function request(
    port: number,
    method: string,
    pathAndQuery: string,
    payload?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: pathAndQuery,
          rejectUnauthorized: false,
          headers: payload ? { 'Content-Type': 'application/json' } : {},
          agent: false,
        },
        (res) => {
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
  }

  it('stores the JA4 of the real TLS connection, and it is stable for the same client', async () => {
    await withServer(async (port, store) => {
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        const nonce = JSON.parse((await request(port, 'GET', `/v1/nonce?k=${PK}`)).body).nonce
        const collected = await request(port, 'POST', `/v1/collect?k=${PK}`, body(nonce))
        assert.equal(collected.status, 200)
        ids.push(JSON.parse(collected.body).requestId)
      }
      const [first, second] = ids.map((id) => store.getEvent('t1', id))
      assert.match(first?.network.tls?.ja4 ?? '', /^t13[di]\d{4}[0-9a-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/)
      assert.equal(first?.network.tls?.source, 'front')
      assert.equal(first?.network.tls?.version, '13')
      assert.equal(first?.network.tls?.sni, false, 'an IP address as host sends no SNI')
      assert.equal(first?.network.tls?.negotiated?.protocol, 'TLSv1.3')
      assert.equal(second?.network.tls?.ja4, first?.network.tls?.ja4)
      assert.ok(first?.network.tls?.ja4_r?.startsWith(first.network.tls.ja4.split('_')[0]))
    })
  })

  it('stores the address of the visitor, not the loopback address of the front', async (t) => {
    const net = await import('node:net')
    const ipv6Loopback = await new Promise<boolean>((resolve) => {
      const probe = net.createServer().once('error', () => resolve(false))
      probe.listen(0, '::1', () => probe.close(() => resolve(true)))
    })
    if (!ipv6Loopback) {
      t.skip('this machine has no IPv6 loopback')
      return
    }
    await withServer(async (port, store) => {
      const call = (method: string, pathAndQuery: string, payload?: string) =>
        new Promise<string>((resolve, reject) => {
          const req = https.request(
            {
              host: '::1',
              port,
              method,
              path: pathAndQuery,
              rejectUnauthorized: false,
              agent: false,
              headers: payload ? { 'Content-Type': 'application/json' } : {},
            },
            (res) => {
              let text = ''
              res.on('data', (chunk) => (text += chunk))
              res.on('end', () => resolve(text))
            },
          )
          req.on('error', reject)
          req.end(payload)
        })
      const nonce = JSON.parse(await call('GET', `/v1/nonce?k=${PK}`)).nonce
      const { requestId } = JSON.parse(await call('POST', `/v1/collect?k=${PK}`, body(nonce)))
      const event = store.getEvent('t1', requestId)
      assert.equal(event?.network.ip, '0:0:0:0:0:0:0:1')
      assert.equal(event?.network.ipVersion, 6)
      assert.notEqual(event?.network.ip, '127.0.0.1')
    }, '::')
  })

  it('reads the HTTP/2 offer of a client that speaks HTTP/2 over TLS', async () => {
    await withServer(async (port, store) => {
      const session = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false })
      try {
        const call = (method: string, p: string, payload?: string) =>
          new Promise<string>((resolve, reject) => {
            const stream = session.request({ ':method': method, ':path': p, 'content-type': 'application/json' })
            let text = ''
            stream.on('data', (chunk) => (text += chunk))
            stream.on('end', () => resolve(text))
            stream.on('error', reject)
            stream.end(payload)
          })
        const nonce = JSON.parse(await call('GET', `/v1/nonce?k=${PK}`)).nonce
        const { requestId } = JSON.parse(await call('POST', `/v1/collect?k=${PK}`, body(nonce)))
        const event = store.getEvent('t1', requestId)
        assert.equal(event?.network.httpVersion, '2.0')
        assert.equal(event?.network.tls?.alpn, 'h2')
        assert.equal(event?.network.tls?.negotiated?.alpn, 'h2')
        assert.ok(event?.network.tls?.ja4.startsWith('t13') && event.network.tls.ja4.includes('h2_'))
        assert.ok(event?.network.http2)
      } finally {
        session.close()
      }
    })
  })

  it('gives plain HTTP to a TLS port a clean failure and no fingerprint', async () => {
    await withServer(async (port) => {
      const net = await import('node:net')
      const answer = await new Promise<string>((resolve) => {
        const socket: import('node:net').Socket = net.connect(port, '127.0.0.1', () =>
          socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
        )
        let data = ''
        socket.on('data', (chunk) => (data += chunk.toString('latin1')))
        socket.on('close', () => resolve(data))
        socket.on('error', () => resolve(data))
        setTimeout(() => {
          socket.destroy()
          resolve(data)
        }, 1500)
      })
      assert.ok(!answer.includes('200 OK'), 'plain HTTP must not be served on the TLS port')
    })
  })
})

describe('server without TLS', () => {
  it('starts, serves the health check and stops', async () => {
    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
    })
    const server = await startServer(config, { port: 0, store: new MemoryEventStore() })
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200)
    } finally {
      await server.close()
    }
  })
})

describe('certificate renewal', { skip: hasOpenssl() ? false : 'openssl is not installed' }, () => {
  function makeCertificate(dir: string, name: string) {
    const key = path.join(dir, `${name}.key`)
    const cert = path.join(dir, `${name}.crt`)
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        `/CN=${name}.test`,
      ],
      { stdio: 'ignore' },
    )
    return { key, cert }
  }

  const servedName = (port: number) =>
    new Promise<string>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        const subject = socket.getPeerCertificate().subject
        socket.destroy()
        resolve(String(subject.CN))
      })
      socket.on('error', reject)
    })

  it('serves the renewed certificate to new connections without a restart, and survives a bad renewal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-renew-'))
    const old = makeCertificate(dir, 'old')
    const renewed = makeCertificate(dir, 'renewed')
    const live = { key: path.join(dir, 'live.key'), cert: path.join(dir, 'live.crt') }
    copyFileSync(old.key, live.key)
    copyFileSync(old.cert, live.cert)

    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
      tls: { keyFile: live.key, certFile: live.cert },
    })
    const logs: Array<Record<string, unknown>> = []
    const server = await startServer(config, {
      port: 0,
      store: new MemoryEventStore(),
      certCheckIntervalMs: 3_600_000,
      log: (entry) => logs.push(entry),
    })
    try {
      assert.equal(await servedName(server.port), 'old.test')
      assert.equal(server.reloadCertificates(), false, 'nothing changed yet')

      // The renewal replaces the files
      copyFileSync(renewed.key, live.key)
      copyFileSync(renewed.cert, live.cert)
      assert.equal(server.reloadCertificates(), true)
      assert.equal(await servedName(server.port), 'renewed.test')
      assert.equal(server.reloadCertificates(), false, 'it only switches when the files change')

      // A renewal caught half way: the new certificate with the old key does not belong together
      copyFileSync(old.cert, live.cert)
      assert.equal(server.reloadCertificates(), false)
      assert.equal(await servedName(server.port), 'renewed.test', 'the working certificate stays')
      assert.ok(logs.some((entry) => entry.route === 'certificates_reload_failed'))
      // A renewal that stays broken is tried again and reported again at every check, not silently forgotten
      assert.equal(server.reloadCertificates(), false)
      assert.equal(logs.filter((entry) => entry.route === 'certificates_reload_failed').length, 2)

      // Garbage in the file
      writeFileSync(live.cert, 'not a certificate')
      assert.equal(server.reloadCertificates(), false)
      assert.equal(await servedName(server.port), 'renewed.test')

      // And it recovers when the pair is complete again
      copyFileSync(old.key, live.key)
      copyFileSync(old.cert, live.cert)
      assert.equal(server.reloadCertificates(), true)
      assert.equal(await servedName(server.port), 'old.test')
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does nothing without TLS', async () => {
    const config = parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
    })
    const server = await startServer(config, { port: 0, store: new MemoryEventStore() })
    try {
      assert.equal(server.reloadCertificates(), false)
    } finally {
      await server.close()
    }
  })
})

describe('server that also serves the collection page', () => {
  it('serves the page and still takes visits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-page-'))
    try {
      for (const name of ['index.html', 'calibration.js', 'config.js', 'fp.min.js']) {
        writeFileSync(path.join(dir, name), `file ${name}`)
      }
      const config = parseConfig({
        nonceSecret: 'n'.repeat(32),
        tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
        calibrationDir: dir,
      })
      const server = await startServer(config, { port: 0, store: new MemoryEventStore() })
      try {
        assert.equal(await (await fetch(`http://127.0.0.1:${server.port}/`)).text(), 'file index.html')
        assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200)
      } finally {
        await server.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to start when the page is incomplete', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-page-'))
    try {
      const config = parseConfig({
        nonceSecret: 'n'.repeat(32),
        tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
        calibrationDir: dir,
      })
      await assert.rejects(startServer(config, { port: 0, store: new MemoryEventStore() }), /was not found/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('server with the identity engine', () => {
  const baseConfig = (extra: Record<string, unknown> = {}) =>
    parseConfig({
      nonceSecret: 'n'.repeat(32),
      // Mechanics of the server, not the bar of the matcher: a lower bar than the default
      defaults: { identity: { matchProbability: 0.95 } },
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
      rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
      ...extra,
    })

  /** A configuration whose only tenant has these settings of its own */
  const withSettings = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    baseConfig({
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)], settings }],
      ...extra,
    })

  const payload = (nonce: string, linkedId?: string, clockOffsetMs = 0) => {
    const signal = (value: unknown) => ({ value, duration: 1 })
    return JSON.stringify({
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now() - clockOffsetMs,
      durationMs: 1,
      nonce,
      ...(linkedId ? { linkedId } : {}),
      components: {
        canvas: signal({ winding: true, geometry: 'geometry-x', text: 'text-x' }),
        webGlBasics: signal({ rendererUnmasked: 'gpu-x', vendorUnmasked: 'vendor-x', renderer: 'r', vendor: 'v' }),
        fonts: signal(['font-x']),
        screenResolution: signal([1440, 900]),
      },
      extended: {},
    })
  }

  async function visit(port: number, linkedId?: string, clockOffsetMs = 0): Promise<string> {
    const base = `http://127.0.0.1:${port}`
    const { nonce } = (await (await fetch(`${base}/v1/nonce?k=${PK}`)).json()) as { nonce: string }
    const response = await fetch(`${base}/v1/collect?k=${PK}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload(nonce, linkedId, clockOffsetMs),
    })
    return ((await response.json()) as { requestId: string }).requestId
  }

  async function identityOf(port: number, requestId: string) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events/${requestId}`, {
      headers: { Authorization: `Bearer ${SK}` },
    })
    return ((await response.json()) as { identity: IdentityView | null }).identity
  }

  it('is on by default, with provisional parameters, and the answer says so', async () => {
    const server = await startServer(baseConfig(), { port: 0 })
    try {
      assert.ok(server.identity)
      const first = await identityOf(server.port, await visit(server.port))
      assert.equal(first?.matched, false)
      assert.equal(first?.calibrated, false)
      assert.equal(first?.probability, null)
    } finally {
      await server.close()
    }
  })

  async function eventOf(port: number, requestId: string) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events/${requestId}`, {
      headers: { Authorization: `Bearer ${SK}` },
    })
    return (await response.json()) as {
      identity: (IdentityView & { learned: boolean; possibleLink?: { visitorId: string } }) | null
      tamper: { signals: Array<{ id: string; severity: string }> } | null
    }
  }

  async function fullEventOf(port: number, requestId: string) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events/${requestId}`, {
      headers: { Authorization: `Bearer ${SK}` },
    })
    return (await response.json()) as {
      identity: { matched: boolean } | null
      network: { ipIntel: { country?: string } }
      risk: { score: number; level: string; factors: Array<{ id: string }> } | null
      decision: { action: string; ruleId: string | null; reason: string; matchedRules: string[] } | null
    }
  }

  it('can be turned off with the old switch', async () => {
    const server = await startServer(baseConfig({ identity: { enabled: false } }), { port: 0 })
    try {
      assert.equal(await identityOf(server.port, await visit(server.port)), null)
    } finally {
      await server.close()
    }
  })

  it('is turned on or off per tenant, over what all tenants share', async () => {
    const off = await startServer(withSettings({ identity: { enabled: false } }), { port: 0 })
    const on = await startServer(
      withSettings({ identity: { enabled: true } }, { defaults: { identity: { enabled: false } } }),
      { port: 0 },
    )
    try {
      assert.equal(await identityOf(off.port, await visit(off.port)), null)
      assert.notEqual(await identityOf(on.port, await visit(on.port)), null)
    } finally {
      await off.close()
      await on.close()
    }
  })

  it('leaves out the features a tenant turned off', async () => {
    const featuresOf = async (settings: Record<string, unknown>) => {
      const server = await startServer(withSettings(settings), { port: 0 })
      try {
        await visit(server.port)
        const again = await identityOf(server.port, await visit(server.port))
        return (again?.explanation ?? []).map((item) => item.feature)
      } finally {
        await server.close()
      }
    }
    assert.ok((await featuresOf({})).includes('fonts'))
    assert.ok(!(await featuresOf({ identity: { disabledFeatures: ['fonts'] } })).includes('fonts'))
  })

  it('does not let a visit teach the engine when the tenant says it looks tampered with', async () => {
    // A browser whose clock is an hour off is a "low" finding: it teaches by default and not under a stricter policy
    const matchedAfter = async (settings: Record<string, unknown>) => {
      const server = await startServer(withSettings(settings), { port: 0 })
      try {
        const first = await eventOf(server.port, await visit(server.port, undefined, 3_600_000))
        const second = await eventOf(server.port, await visit(server.port, undefined, 3_600_000))
        return {
          learned: first.identity?.learned,
          flagged: first.tamper?.signals.length,
          matched: second.identity?.matched,
        }
      } finally {
        await server.close()
      }
    }
    assert.deepEqual(await matchedAfter({}), { learned: true, flagged: 1, matched: true })
    assert.deepEqual(await matchedAfter({ identity: { learnFromTampered: 'never_flagged' } }), {
      learned: false,
      flagged: 1,
      matched: false,
    })
    // The severity is the tenant's to judge: raised to high, the default policy stops learning from it
    assert.deepEqual(await matchedAfter({ tamper: { severity: { clock_skew: 'high' } } }), {
      learned: false,
      flagged: 1,
      matched: false,
    })
    // With the evidence turned off there is nothing to judge by, so it learns, and the evidence is not shown
    const off = await startServer(
      withSettings({ tamper: { enabled: false }, identity: { learnFromTampered: 'never_flagged' } }),
      { port: 0 },
    )
    try {
      const event = await eventOf(off.port, await visit(off.port, undefined, 3_600_000))
      assert.equal(event.tamper, null)
      assert.equal(event.identity?.learned, true)
    } finally {
      await off.close()
    }
  })

  it('gives a risk and a decision from the rules of the tenant', async () => {
    const intel = { lookup: () => ({ tags: ['datacenter'], country: 'BR' }) }
    const settings = {
      risk: { ipTagWeights: { datacenter: 70 } },
      rules: {
        list: [
          {
            id: 'dc',
            when: { field: 'ip.tags', op: 'contains', value: 'datacenter' },
            decision: 'block',
            reason: 'Data center',
          },
        ],
        defaultDecision: 'allow',
      },
    }
    const server = await startServer(withSettings(settings), { port: 0, intel })
    try {
      const event = await fullEventOf(server.port, await visit(server.port))
      assert.equal(event.risk?.score, 70)
      assert.equal(event.risk?.level, 'high')
      assert.deepEqual(
        event.risk?.factors.map((f) => f.id),
        ['ip_tag:datacenter'],
      )
      assert.deepEqual(event.decision, { action: 'block', ruleId: 'dc', reason: 'Data center', matchedRules: ['dc'] })
      assert.equal(event.network.ipIntel.country, 'BR')
    } finally {
      await server.close()
    }
    const quiet = await startServer(withSettings({ risk: { enabled: false } }), { port: 0 })
    try {
      const event = await fullEventOf(quiet.port, await visit(quiet.port))
      assert.equal(event.risk, null)
      assert.equal(event.decision, null)
    } finally {
      await quiet.close()
    }
  })

  it('sees one device used with many accounts, and the tenant chooses how many are too many', async () => {
    const run = async (threshold: number) => {
      const server = await startServer(
        withSettings({ risk: { velocity: { linkedIdsPerDevice: { threshold, weight: 30 } } } }),
        { port: 0 },
      )
      try {
        let last = ''
        for (const account of ['acct1', 'acct2', 'acct3']) {
          last = await visit(server.port, account)
        }
        const event = await fullEventOf(server.port, last)
        return { ids: event.risk?.factors.map((f) => f.id), same: event.identity?.matched }
      } finally {
        await server.close()
      }
    }
    assert.deepEqual(await run(3), { ids: ['velocity:linked_ids_per_device'], same: true })
    assert.deepEqual(await run(4), { ids: [], same: true })
  })

  it('refuses a rule that cannot run when the configuration is read', () => {
    assert.throws(
      () =>
        withSettings({
          rules: { list: [{ id: 'a', when: { field: 'risk.scor', op: 'gte', value: 1 }, decision: 'block' }] },
        }),
      /unknown fact "risk.scor"/,
    )
    assert.throws(() => withSettings({ risk: { levels: { medium: 70, high: 60 } } }), /risk\.levels\.medium/)
  })

  it('lists the visits and shows a visitor with the SQLite store', async () => {
    const server = await startServer(baseConfig(), { port: 0 })
    try {
      const first = await visit(server.port, 'acct1')
      await new Promise((resolve) => setTimeout(resolve, 5)) // the order of the list is by time
      const second = await visit(server.port, 'acct2')
      const get = async (path: string) =>
        (await (
          await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${SK}` } })
        ).json()) as {
          events: Array<{ requestId: string; visitorId: string; matched: boolean }>
          next: string | null
          visits?: number
        }
      const list = await get('/v1/events?limit=1')
      assert.deepEqual(
        list.events.map((event) => event.requestId),
        [second],
      )
      assert.ok(list.next)
      const more = await get(`/v1/events?limit=1&after=${list.next}`)
      assert.deepEqual(
        more.events.map((event) => event.requestId),
        [first],
      )
      assert.deepEqual(
        (await get('/v1/events?linkedId=acct1')).events.map((event) => event.requestId),
        [first],
      )
      const visitor = await get(`/v1/visitors/${list.events[0].visitorId}`)
      assert.equal(visitor.visits, 2)
      assert.deepEqual(
        visitor.events.map((event) => event.requestId),
        [second, first],
      )
    } finally {
      await server.close()
    }
  })

  describe('webhooks', () => {
    interface Hit {
      headers: Record<string, string | string[] | undefined>
      body: string
    }

    async function receiver(status: (n: number) => number) {
      const hits: Hit[] = []
      const target = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
          res.writeHead(status(hits.length)).end()
        })
      })
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()))
      return {
        hits,
        url: `http://127.0.0.1:${(target.address() as net.AddressInfo).port}/hook`,
        close: () =>
          new Promise<void>((resolve) => {
            target.close(() => resolve())
            target.closeAllConnections()
          }),
      }
    }

    const secret = 'a-webhook-secret-long-enough'
    const settingsFor = (url: string, extra: Record<string, unknown> = {}, endpoint: Record<string, unknown> = {}) => ({
      webhooks: {
        endpoints: [{ id: 'main', url, secrets: [secret], ...endpoint }],
        allowHttp: true,
        allowPrivateNetworks: true,
        baseDelaySeconds: 1,
        ...extra,
      },
    })

    async function until(condition: () => boolean, ms = 4000) {
      const deadline = Date.now() + ms
      while (!condition() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.ok(condition(), 'the condition was not reached in time')
    }

    it('tells the receiver about a visit, signed, and the signature is the one the SDK checks', async () => {
      const target = await receiver(() => 200)
      const server = await startServer(withSettings(settingsFor(target.url)), { port: 0, webhookIntervalMs: 20 })
      try {
        const requestId = await visit(server.port, 'acct1')
        await until(() => target.hits.length === 1)
        const [hit] = target.hits
        const body = JSON.parse(hit.body) as {
          id: string
          type: string
          tenantId: string
          visit: { requestId: string; linkedId: string }
        }
        assert.equal(body.type, 'visit.completed')
        assert.equal(body.tenantId, 't1')
        assert.equal(body.visit.requestId, requestId)
        assert.equal(body.visit.linkedId, 'acct1')
        assert.equal(hit.headers['x-fingerprint-delivery'], body.id)
        assert.equal(hit.headers['content-type'], 'application/json')
        assert.equal(
          verifyWebhook({ secret, body: hit.body, signature: hit.headers['x-fingerprint-signature'] as string }),
          true,
        )
        assert.equal(
          verifyWebhook({
            secret: 'another-secret-entirely',
            body: hit.body,
            signature: hit.headers['x-fingerprint-signature'] as string,
          }),
          false,
        )
      } finally {
        await server.close()
        await target.close()
      }
    })

    it('tries again after a failure and lists a delivery that gave up, and sends it again on request', async () => {
      const target = await receiver((n) => (n === 1 ? 500 : 400))
      const server = await startServer(withSettings(settingsFor(target.url, { maxAttempts: 3 })), {
        port: 0,
        webhookIntervalMs: 20,
      })
      try {
        await visit(server.port, 'acct1')
        await until(() => target.hits.length === 2, 6000)
        assert.equal(target.hits[1].headers['x-fingerprint-attempt'], '2')
        const list = async () =>
          (await (
            await fetch(`http://127.0.0.1:${server.port}/v1/webhooks/deliveries?status=failed`, {
              headers: { Authorization: `Bearer ${SK}` },
            })
          ).json()) as { deliveries: Array<Record<string, unknown>> }
        let failed = await list()
        for (let i = 0; i < 50 && failed.deliveries.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 40))
          failed = await list()
        }
        assert.equal(failed.deliveries.length, 1)
        const [item] = failed.deliveries
        assert.equal(item.status, 'failed')
        assert.equal(item.attempts, 2, 'a 400 is final')
        assert.equal(item.lastError, 'The receiver answered 400')
        assert.ok(!('body' in item), 'the body is left out of the list')

        const retry = await fetch(`http://127.0.0.1:${server.port}/v1/webhooks/deliveries/${item.id}/retry`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SK}` },
        })
        assert.equal(retry.status, 200)
        await until(() => target.hits.length === 3)
        const missing = await fetch(`http://127.0.0.1:${server.port}/v1/webhooks/deliveries/nope/retry`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SK}` },
        })
        assert.equal(missing.status, 404)
        const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/webhooks/deliveries`)
        assert.equal(unauthorized.status, 401)
      } finally {
        await server.close()
        await target.close()
      }
    })

    it('sends only the visits that the endpoint asked for', async () => {
      const target = await receiver(() => 200)
      const server = await startServer(withSettings(settingsFor(target.url, {}, { minRiskScore: 50 })), {
        port: 0,
        webhookIntervalMs: 20,
        intel: { lookup: () => ({ tags: ['datacenter', 'tor_exit'] }) },
      })
      try {
        await visit(server.port, 'acct1')
        await until(() => target.hits.length === 1)
      } finally {
        await server.close()
      }
      const quiet = await startServer(withSettings(settingsFor(target.url, {}, { minRiskScore: 50 })), {
        port: 0,
        webhookIntervalMs: 20,
      })
      try {
        await visit(quiet.port, 'acct2')
        await new Promise((resolve) => setTimeout(resolve, 300))
        assert.equal(target.hits.length, 1, 'a visit with no risk is not sent')
      } finally {
        await quiet.close()
        await target.close()
      }
    })

    it('refuses at start an address on a private network unless it is allowed', () => {
      assert.throws(
        () => withSettings(settingsFor('http://127.0.0.1:9/hook', { allowPrivateNetworks: false })),
        /private address/,
      )
      assert.throws(() => withSettings(settingsFor('http://example.com/hook', { allowHttp: false })), /allowHttp/)
      assert.throws(
        () => withSettings(settingsFor('https://example.com/x', { baseDelaySeconds: 100, maxDelaySeconds: 50 })),
        /baseDelaySeconds/,
      )
    })

    it('keeps a delivery across a restart', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'fp-hooks-'))
      const target = await receiver(() => 200)
      try {
        const file = path.join(dir, 'events.db')
        const config = () => withSettings(settingsFor(target.url), { databasePath: file })
        const first = await startServer(config(), { port: 0, webhookIntervalMs: 3_600_000 })
        const requestId = await visit(first.port, 'acct1')
        await first.close()
        assert.equal(target.hits.length, 0, 'it had not been sent yet')
        const second = await startServer(config(), { port: 0, webhookIntervalMs: 20 })
        try {
          await until(() => target.hits.length === 1)
          assert.equal((JSON.parse(target.hits[0].body) as { visit: { requestId: string } }).visit.requestId, requestId)
        } finally {
          await second.close()
        }
      } finally {
        await target.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('marks a possible link when the closest device is certain enough but not enough to attach', async () => {
    const server = await startServer(
      withSettings({ identity: { matchProbability: 0.999999, possibleLinkProbability: 0.4 } }),
      { port: 0 },
    )
    try {
      const first = await eventOf(server.port, await visit(server.port))
      const second = await eventOf(server.port, await visit(server.port))
      assert.equal(second.identity?.matched, false)
      assert.equal(second.identity?.possibleLink?.visitorId, first.identity?.visitorId)
      assert.deepEqual((second.identity as unknown as { thresholds: unknown }).thresholds, {
        match: 0.999999,
        possibleLink: 0.4,
      })
    } finally {
      await server.close()
    }
  })

  it('uses a model file per tenant and refuses a wrong one at start and at reload', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-model-'))
    try {
      const modelFile = path.join(dir, 'model.json')
      writeFileSync(modelFile, JSON.stringify({ version: 1, calibrated: true, platt: { a: 0.9, b: 0 } }))
      const server = await startServer(withSettings({ identity: { modelFile } }), { port: 0 })
      try {
        await visit(server.port)
        const again = await identityOf(server.port, await visit(server.port))
        assert.equal(again?.calibrated, true)
        await assert.rejects(
          server.reloadConfig(withSettings({ identity: { modelFile: path.join(dir, 'gone.json') } })),
        )
        assert.equal((await identityOf(server.port, await visit(server.port)))?.calibrated, true, 'the old one stays')
      } finally {
        await server.close()
      }
      await assert.rejects(startServer(withSettings({ identity: { modelFile: path.join(dir, 'gone.json') } })))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a switch that is not a real boolean', () => {
    assert.throws(() => baseConfig({ identity: { enabled: 'false' } }), /identity\.enabled/)
  })

  it('uses the model file, and then the probability is shown', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-model-'))
    try {
      const modelFile = path.join(dir, 'model.json')
      writeFileSync(modelFile, JSON.stringify({ version: 1, calibrated: true, platt: { a: 0.9, b: 0 } }))
      const server = await startServer(baseConfig({ identity: { modelFile } }), { port: 0 })
      try {
        await visit(server.port)
        const again = await identityOf(server.port, await visit(server.port))
        assert.equal(again?.calibrated, true)
        assert.equal(typeof again?.probability, 'number')
      } finally {
        await server.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to start with a model file that is wrong, instead of using other numbers silently', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-model-'))
    try {
      const modelFile = path.join(dir, 'model.json')
      writeFileSync(modelFile, JSON.stringify({ version: 1, m: { canvas: 7 } }))
      await assert.rejects(startServer(baseConfig({ identity: { modelFile } }), { port: 0 }), /Model:/)
      writeFileSync(modelFile, 'not json')
      await assert.rejects(startServer(baseConfig({ identity: { modelFile } }), { port: 0 }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forgets the device of a person whose events were deleted', async () => {
    const server = await startServer(baseConfig(), { port: 0 })
    try {
      const first = await visit(server.port, 'p1.laptop')
      await visit(server.port, 'p1.laptop')
      assert.equal(server.store.deleteByLinkedId('t1', 'p1.laptop'), 2)
      const identityStore = new SqliteIdentityStore((server.store as SqliteEventStore).connection)
      assert.equal(identityStore.population('t1').devices, 1)
      assert.equal(identityStore.removeOrphans(), 1)
      assert.equal(identityStore.population('t1').devices, 0)
      assert.equal(identityStore.getResolution('t1', first), undefined)
    } finally {
      await server.close()
    }
  })
})

describe('dashboard, first-party script and base path', () => {
  const PKX = 'pk_site_0123456789abcdef'
  const config = (extra: Record<string, unknown> = {}) =>
    parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't1', publicKey: PKX, secretKeySha256: [sha256Hex('sk_x')] }],
      ...extra,
    })
  const get = (port: number, path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers })

  it('serves the dashboard only when asked, with a policy that allows no inline script', async () => {
    const off = await startServer(config(), { port: 0 })
    try {
      assert.equal((await get(off.port, '/dashboard/')).status, 404)
      assert.equal((await get(off.port, '/dashboard/app.js')).status, 404)
    } finally {
      await off.close()
    }
    const on = await startServer(config({ dashboard: true }), { port: 0 })
    try {
      for (const path of ['/dashboard', '/dashboard/']) {
        const page = await get(on.port, path)
        assert.equal(page.status, 200, path)
        assert.match(page.headers.get('content-type') ?? '', /text\/html/)
        const csp = page.headers.get('content-security-policy') ?? ''
        assert.match(csp, /default-src 'none'/)
        assert.match(csp, /script-src 'self'(;|$)/)
        assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), csp)
        assert.equal(page.headers.get('x-frame-options'), 'DENY')
        assert.equal(page.headers.get('cache-control'), 'no-store')
        assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
      }
      const script = await (await get(on.port, '/dashboard/app.js')).text()
      const html = await (await get(on.port, '/dashboard/')).text()
      // What comes from a visit is hostile text. The script must never turn it into markup, and must not keep the key.
      for (const forbidden of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'eval(',
        'new Function',
        'localStorage',
        'sessionStorage',
        'document.cookie',
      ]) {
        assert.ok(!script.includes(forbidden), `the script uses ${forbidden}`)
      }
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'an inline script')
      assert.ok(!/\son[a-z]+\s*=/i.test(html), 'an inline event handler')
      assert.ok(!/\sstyle\s*=/i.test(html), 'an inline style')
      assert.equal((await get(on.port, '/dashboard/style.css')).headers.get('content-type'), 'text/css; charset=utf-8')
      assert.equal((await get(on.port, '/dashboard/other.js')).status, 404)
      assert.equal(
        (await get(on.port, '/dashboard/../v1/events')).status,
        401,
        'a dot segment is normalized, not a way out',
      )
    } finally {
      await on.close()
    }
  })

  it('serves the browser script from the path of your choice, cached, and answers a conditional request', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-script-'))
    try {
      const file = path.join(dir, 'fp.min.js')
      writeFileSync(file, 'window.FingerprintJS = {}')
      const logs: Array<Record<string, unknown>> = []
      const server = await startServer(config({ collectorFile: file, collectorPath: '/assets/app-7f3a.js' }), {
        port: 0,
        log: (entry) => logs.push(entry),
      })
      try {
        const response = await get(server.port, '/assets/app-7f3a.js')
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'window.FingerprintJS = {}')
        assert.match(response.headers.get('content-type') ?? '', /javascript/)
        assert.equal(response.headers.get('cache-control'), 'public, max-age=3600')
        assert.equal(response.headers.get('access-control-allow-origin'), '*')
        const etag = response.headers.get('etag') ?? ''
        assert.ok(etag.length > 10)
        const again = await get(server.port, '/assets/app-7f3a.js', { 'If-None-Match': etag })
        assert.equal(again.status, 304)
        assert.equal((await get(server.port, '/assets/app-7f3a.js', { 'If-None-Match': '"other"' })).status, 200)
        assert.equal((await get(server.port, '/v1/collector.js')).status, 404, 'the default name is not served')
        const ready = logs.find((entry) => entry.route === 'collector_ready')
        assert.match(String(ready?.integrity), /^sha384-[A-Za-z0-9+/]{64}$/)
      } finally {
        await server.close()
      }
      assert.throws(() => config({ collectorFile: file, collectorPath: '/v1/events' }), /used by the server itself/)
      assert.throws(
        () => config({ collectorFile: file, collectorPath: '/dashboard/x.js' }),
        /used by the server itself/,
      )
      assert.throws(() => config({ collectorFile: file, collectorPath: '/a/../b.js' }), /must be a path/)
      assert.throws(() => config({ collectorFile: file, collectorPath: '/with space.js' }), /must be a path/)
      await assert.rejects(
        startServer(config({ collectorFile: path.join(dir, 'missing.js') }), { port: 0 }),
        /not found/,
      )
      assert.equal(config({ collectorFile: file }).collectorPath, '/v1/collector.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers under a base path and nowhere else, the health check apart', async () => {
    const server = await startServer(config({ basePath: '/fp', dashboard: true }), { port: 0 })
    try {
      assert.equal((await get(server.port, '/fp/dashboard/')).status, 200)
      assert.equal((await get(server.port, `/fp/v1/nonce?k=${PKX}`)).status, 200)
      assert.equal((await get(server.port, '/fp')).status, 404, 'the root of the prefix is not a route')
      assert.equal((await get(server.port, `/v1/nonce?k=${PKX}`)).status, 404, 'without the prefix')
      assert.equal((await get(server.port, '/dashboard/')).status, 404)
      assert.equal((await get(server.port, `/fpx/v1/nonce?k=${PKX}`)).status, 404, 'a longer name is not the prefix')
      assert.equal((await get(server.port, '/healthz')).status, 200)
      assert.equal((await get(server.port, '/fp/healthz')).status, 200)
    } finally {
      await server.close()
    }
    assert.throws(() => config({ basePath: 'fp' }), /basePath must be a path/)
    assert.throws(() => config({ basePath: '/fp/' }), /basePath must be a path/)
    assert.throws(() => config({ basePath: '/..' }), /basePath must be a path/)
    assert.throws(() => config({ dashboard: 'yes' }), /dashboard must be true or false/)
  })
})

describe('settings reloaded in a running server', () => {
  const config = (settings: Record<string, unknown>) =>
    parseConfig({
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)], settings }],
      nonce: undefined,
      requireNonce: false,
    })

  const send = async (port: number) =>
    (
      await fetch(`http://127.0.0.1:${port}/v1/collect?k=${PK}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: 1,
          libVersion: 'x',
          collectedAt: Date.now(),
          durationMs: 1,
          components: {},
          extended: {},
        }),
      })
    ).status

  it('changes behavior without a restart, and refuses a file with a mistake', async () => {
    const server = await startServer(config({ limits: { collectPerMinutePerIp: 1000 } }), {
      port: 0,
      store: new MemoryEventStore(),
    })
    try {
      assert.equal(await send(server.port), 200)
      await server.reloadConfig(config({ limits: { collectPerMinutePerIp: 1 } }))
      // One request goes through and the next is refused, as the new limit says
      const statuses = [await send(server.port), await send(server.port)]
      assert.ok(statuses.includes(429), `statuses ${statuses}`)

      const broken = config({})
      ;(broken.tenants[0].settings as Record<string, unknown>).retention = { eventsDays: 'many' }
      await assert.rejects(server.reloadConfig(broken), /retention\.eventsDays/)
      assert.equal(await send(server.port), 429, 'the settings that were working stay')
    } finally {
      await server.close()
    }
  })
})
