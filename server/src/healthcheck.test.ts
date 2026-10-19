import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { check, readinessTarget } from './healthcheck'
import { startServer } from './server'
import { MemoryEventStore } from './store/memory'

describe('health check of the container', () => {
  it('reads the port, the scheme, the host and the base path from the configuration', () => {
    assert.deepEqual(readinessTarget('{}'), { port: 8080, secure: false, host: '127.0.0.1', path: '/readyz' })
    assert.deepEqual(
      readinessTarget(
        JSON.stringify({
          listen: { host: '0.0.0.0', port: 8443 },
          tls: { keyFile: 'k', certFile: 'c' },
          basePath: '/fp',
        }),
      ),
      { port: 8443, secure: true, host: '127.0.0.1', path: '/fp/readyz' },
    )
    assert.equal(readinessTarget(JSON.stringify({ listen: { host: '10.1.2.3' } })).host, '10.1.2.3')
    assert.equal(readinessTarget(JSON.stringify({ listen: { host: '::' } })).host, '127.0.0.1')
  })

  it('is healthy when the server is ready and not when it is not or is not there', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-health-'))
    const store = new MemoryEventStore()
    const raw = {
      nonceSecret: 'n'.repeat(32),
      tenants: [{ id: 't', publicKey: 'pk_health_0123456789abcdef', secretKeySha256: [sha256Hex('sk')] }],
    }
    const server = await startServer(parseConfig(raw), { port: 0, store })
    try {
      const file = path.join(dir, 'config.json')
      writeFileSync(file, JSON.stringify({ ...raw, listen: { host: '127.0.0.1', port: server.port } }))
      assert.equal(await check(file), true)
      store.ping = () => {
        throw new Error('gone')
      }
      assert.equal(await check(file), false, 'alive but not ready')
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
    const missing = path.join(dir, 'missing.json')
    mkdtempSync(path.join(tmpdir(), 'unused-'))
    writeFileSync(
      path.join(tmpdir(), 'fp-health-down.json'),
      JSON.stringify({ listen: { host: '127.0.0.1', port: 1 } }),
    )
    assert.equal(await check(path.join(tmpdir(), 'fp-health-down.json')), false, 'nothing listens')
    assert.ok(missing)
  })
})
