import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { loadOrCreateSecret, startReceiver } from './run'
import { ReportStore } from './store'

const day = 86_400_000

function inTempDir<T>(work: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'reach-'))
  return Promise.resolve(work(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const settings = (db: string) => ({
  db,
  port: 0,
  host: '127.0.0.1',
  allowedOrigins: [],
  trustForwardedFrom: [],
  keepDays: 90,
})

describe('reachability receiver start', () => {
  it('makes the secret once, readable by the owner only, and reuses it', () =>
    inTempDir((dir) => {
      const file = join(dir, 'key')
      const first = loadOrCreateSecret(file)
      assert.equal(first.length, 32)
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.deepEqual(loadOrCreateSecret(file), first)
      writeFileSync(file, 'abcd\n')
      assert.throws(() => loadOrCreateSecret(file), /at least 16 bytes/)
    }))

  it('deletes the old reports when it starts, and takes new ones', () =>
    inTempDir(async (dir) => {
      const db = join(dir, 'reach.db')
      const now = Date.UTC(2026, 9, 19)
      const seed = new ReportStore(db)
      const base = {
        reason: 'script_unreachable',
        phase: 'script',
        probe: 'unreachable',
        elapsedMs: 1,
        browser: 'chrome',
        mobile: false,
      } as const
      seed.insert({ ...base, receivedAt: now - 120 * day })
      seed.insert({ ...base, receivedAt: now - 10 * day })
      seed.close()

      const receiver = await startReceiver(settings(db), () => now)
      try {
        assert.deepEqual(
          receiver.store.dump().map((row) => row.received_at),
          [now - 10 * day],
          'the report of 120 days ago is gone and the one of 10 days ago is kept',
        )
        const status = await new Promise<number>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: receiver.port, method: 'POST', path: '/report' }, (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          })
          req.on('error', reject)
          req.end(JSON.stringify({ v: 1, reason: 'timeout', phase: 'send', probe: 'reachable', elapsedMs: 9000 }))
        })
        assert.equal(status, 204)
        assert.equal(receiver.store.dump().length, 2)
      } finally {
        await receiver.close()
      }
      statSync(`${db}.secret`)
    }))

  it('refuses to start on a wrong setting instead of running half-configured', async () => {
    await assert.rejects(startReceiver({ ...settings(':memory:'), keepDays: 0 }), /keep-days/)
    await assert.rejects(startReceiver({ ...settings(':memory:'), trustForwardedFrom: ['nope'] }), /not an address/)
    await assert.rejects(startReceiver({ ...settings(':memory:'), asnFile: '/nonexistent.csv' }), /--asn-file needs/)
    await assert.rejects(
      startReceiver({ ...settings(':memory:'), asnFile: '/nonexistent.csv', asnColumns: { from: 0, asn: 1 } }),
      /ENOENT/,
    )
  })
})
