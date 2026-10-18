import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http2 from 'node:http2'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import tls from 'node:tls'

import { parseConfig, sha256Hex } from './config'
import { SqliteIdentityStore } from './identity/sqlite_store'
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
      tenants: [{ id: 't1', publicKey: PK, secretKeySha256: [sha256Hex(SK)] }],
      rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
      ...extra,
    })

  const payload = (nonce: string, linkedId?: string) => {
    const signal = (value: unknown) => ({ value, duration: 1 })
    return JSON.stringify({
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: Date.now(),
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

  async function visit(port: number, linkedId?: string): Promise<string> {
    const base = `http://127.0.0.1:${port}`
    const { nonce } = (await (await fetch(`${base}/v1/nonce?k=${PK}`)).json()) as { nonce: string }
    const response = await fetch(`${base}/v1/collect?k=${PK}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload(nonce, linkedId),
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

  it('can be turned off', async () => {
    const server = await startServer(baseConfig({ identity: { enabled: false } }), { port: 0 })
    try {
      assert.equal(server.identity, undefined)
      assert.equal(await identityOf(server.port, await visit(server.port)), null)
    } finally {
      await server.close()
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
