import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { RunningServer, startServer } from './server'

const ADMIN = 'adm_admin_secret_key'
const FILE_PK = 'pk_filetenant_0123456789'
const FILE_SK = 'sk_filetenant_secret'

const config = (extra: Record<string, unknown> = {}) =>
  parseConfig({
    nonceSecret: 'n'.repeat(32),
    adminKeySha256: [sha256Hex(ADMIN)],
    tenants: [{ id: 'file', publicKey: FILE_PK, secretKeySha256: [sha256Hex(FILE_SK)] }],
    plans: {
      free: { limits: { collectPerMinutePerIp: 7 }, quota: { collectsPerMonth: 2 } },
      pro: { limits: { collectPerMinutePerIp: 500 } },
    },
    rateLimit: { collectPerMinutePerIp: 1000, collectPerMinutePerTenant: 1000, noncePerMinutePerIp: 1000 },
    ...extra,
  })

interface Created {
  tenant: { id: string; publicKey: string; keyIds: string[]; status: string; plan: string | null; source: string }
  secretKey: string
}

class Harness {
  constructor(readonly server: RunningServer) {}

  call(path: string, options: { method?: string; key?: string; body?: unknown; raw?: string } = {}) {
    return fetch(`http://127.0.0.1:${this.server.port}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.key === '' ? {} : { Authorization: `Bearer ${options.key ?? ADMIN}` }),
        ...(options.body !== undefined || options.raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    })
  }

  async create(body: Record<string, unknown>): Promise<Created> {
    const response = await this.call('/admin/v1/tenants', { method: 'POST', body })
    assert.equal(response.status, 201, await response.clone().text())
    return (await response.json()) as Created
  }

  async visit(tenant: Created['tenant'] | { publicKey: string }, linkedId = 'acct1'): Promise<Response> {
    const signal = (value: unknown) => ({ value, duration: 1 })
    const nonce = (await (
      await fetch(`http://127.0.0.1:${this.server.port}/v1/nonce?k=${tenant.publicKey}`)
    ).json()) as {
      nonce?: string
    }
    return fetch(`http://127.0.0.1:${this.server.port}/v1/collect?k=${tenant.publicKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 1,
        libVersion: '5.3.0',
        collectedAt: Date.now(),
        durationMs: 1,
        nonce: nonce.nonce,
        linkedId,
        components: { canvas: signal({ winding: true, geometry: 'g', text: 't' }), fonts: signal(['f']) },
        extended: {},
      }),
    })
  }

  read(secret: string, path: string) {
    return fetch(`http://127.0.0.1:${this.server.port}${path}`, { headers: { Authorization: `Bearer ${secret}` } })
  }
}

async function withServer(
  run: (h: Harness) => Promise<void>,
  extra: Record<string, unknown> = {},
  options: Parameters<typeof startServer>[1] = {},
) {
  const server = await startServer(config(extra), { port: 0, webhookIntervalMs: 3_600_000, ...options })
  try {
    await run(new Harness(server))
  } finally {
    await server.close()
  }
}

describe('admin API: who may use it', () => {
  it('is off without admin keys, and answers 401 to anything but an admin key', async () => {
    await withServer(
      async (h) => {
        assert.equal((await h.call('/admin/v1/tenants')).status, 404)
      },
      { adminKeySha256: undefined },
    )
    await withServer(async (h) => {
      assert.equal((await h.call('/admin/v1/tenants', { key: '' })).status, 401)
      assert.equal((await h.call('/admin/v1/tenants', { key: 'adm_wrong' })).status, 401)
      assert.equal(
        (await h.call('/admin/v1/tenants', { key: FILE_SK })).status,
        401,
        'a tenant key is not an admin key',
      )
      assert.equal((await h.call('/admin/v1/tenants')).status, 200)
      assert.equal((await h.read(ADMIN, '/v1/events')).status, 401, 'an admin key does not read tenant data')
      assert.equal((await h.call('/admin/v1/nothing')).status, 404)
      assert.equal((await h.call('/admin/v1/tenants', { method: 'PUT' })).status, 405)
    })
  })

  it('limits attempts with a wrong key', async () => {
    await withServer(
      async (h) => {
        const statuses: number[] = []
        for (let i = 0; i < 6; i++) {
          statuses.push((await h.call('/admin/v1/tenants', { key: 'adm_wrong' })).status)
        }
        assert.ok(statuses.includes(429), statuses.join(','))
      },
      { defaults: { limits: { authFailuresPerMinutePerIp: 3 } } },
    )
  })
})

describe('admin API: tenants', () => {
  it('makes a tenant that works at once, shows its secret key once, and keeps it apart from the others', async () => {
    await withServer(async (h) => {
      const created = await h.create({
        id: 'shop',
        name: 'Shop',
        allowedOrigins: ['https://shop.example'],
        plan: 'pro',
      })
      assert.match(created.tenant.publicKey, /^pk_[A-Za-z0-9_-]{24}$/)
      assert.match(created.secretKey, /^sk_[A-Za-z0-9_-]{43}$/)
      assert.deepEqual(
        [created.tenant.source, created.tenant.status, created.tenant.plan],
        ['database', 'active', 'pro'],
      )
      assert.deepEqual(created.tenant.keyIds, [sha256Hex(created.secretKey).slice(0, 8)])

      const visit = await h.visit(created.tenant)
      assert.equal(visit.status, 200)
      const { requestId } = (await visit.json()) as { requestId: string }
      assert.equal((await h.read(created.secretKey, `/v1/events/${requestId}`)).status, 200)
      assert.equal((await h.read(FILE_SK, `/v1/events/${requestId}`)).status, 404, 'another tenant cannot read it')
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 200)

      const detail = (await (await h.call('/admin/v1/tenants/shop')).json()) as Record<string, unknown>
      assert.ok(!JSON.stringify(detail).includes(created.secretKey), 'the secret key is not shown again')
      assert.equal(detail.name, 'Shop')
      const list = (await (await h.call('/admin/v1/tenants')).json()) as { tenants: Array<{ id: string }> }
      assert.deepEqual(
        list.tenants.map((tenant) => tenant.id),
        ['file', 'shop'],
      )
    })
  })

  it('refuses what is wrong, saying what', async () => {
    await withServer(async (h) => {
      await h.create({ id: 'taken' })
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ id: 'taken' }, 409, 'id_taken'],
        [{ id: 'file' }, 409, 'id_taken'],
        [{ id: 'bad id' }, 400, 'invalid_parameter'],
        [{}, 400, 'invalid_parameter'],
        [{ id: 'x1', extra: true }, 400, 'unknown_field'],
        [{ id: 'x2', plan: 'gold' }, 400, 'unknown_plan'],
        [{ id: 'x3', name: 'n'.repeat(101) }, 400, 'invalid_parameter'],
        [{ id: 'x4', allowedOrigins: ['shop.example'] }, 400, 'invalid_parameter'],
        [{ id: 'x5', allowedOrigins: ['https://shop.example/path'] }, 400, 'invalid_parameter'],
        [{ id: 'x6', allowedOrigins: 'https://shop.example' }, 400, 'invalid_parameter'],
        [{ id: 'x7', settings: 'nope' }, 400, 'invalid_parameter'],
        [{ id: 'x8', settings: { identity: { matchProbabilty: 0.9 } } }, 400, 'invalid_settings'],
        [{ id: 'x9', settings: { limits: { maxBodyBytes: -1 } } }, 400, 'invalid_settings'],
      ]
      for (const [body, status, error] of cases) {
        const response = await h.call('/admin/v1/tenants', { method: 'POST', body })
        assert.equal(response.status, status, JSON.stringify(body))
        assert.equal(((await response.json()) as { error: string }).error, error, JSON.stringify(body))
      }
      const problems = (await (
        await h.call('/admin/v1/tenants', {
          method: 'POST',
          body: { id: 'z', settings: { identity: { matchProbabilty: 0.9 } } },
        })
      ).json()) as { problems: string[] }
      assert.match(problems.problems[0], /did you mean "identity.matchProbability"/)
      assert.equal((await h.call('/admin/v1/tenants', { method: 'POST', raw: '{not json' })).status, 400)
      assert.equal((await h.call('/admin/v1/tenants', { method: 'POST', raw: '[]' })).status, 400)
      assert.equal(
        (
          await h.call('/admin/v1/tenants', {
            method: 'POST',
            raw: JSON.stringify({ id: 'big', name: 'x'.repeat(70_000) }),
          })
        ).status,
        413,
      )
      const list = (await (await h.call('/admin/v1/tenants')).json()) as { tenants: unknown[] }
      assert.equal(list.tenants.length, 2, 'nothing was made by the refused requests')
    })
  })

  it('puts a tenant on a plan, with its own settings over it, and hides webhook secrets', async () => {
    await withServer(async (h) => {
      await h.create({
        id: 'shop',
        plan: 'free',
        settings: {
          limits: { maxBodyBytes: 9999 },
          webhooks: {
            endpoints: [{ id: 'main', url: 'https://hooks.example.com/x', secrets: ['a-secret-long-enough-1'] }],
          },
        },
      })
      const detail = (await (await h.call('/admin/v1/tenants/shop')).json()) as {
        effectiveSettings: { limits: Record<string, number>; quota: Record<string, number> }
      }
      assert.equal(detail.effectiveSettings.limits.collectPerMinutePerIp, 7, 'from the plan')
      assert.equal(detail.effectiveSettings.limits.maxBodyBytes, 9999, 'from the tenant')
      assert.equal(detail.effectiveSettings.quota.collectsPerMonth, 2)
      assert.ok(!JSON.stringify(detail).includes('a-secret-long-enough-1'))
      assert.ok(JSON.stringify(detail).includes('[hidden]'))
    })
  })

  it('changes a tenant, checks the whole result before saving, and does not touch a tenant of the file', async () => {
    await withServer(async (h) => {
      const created = await h.create({ id: 'shop', plan: 'free' })
      const patch = (body: unknown, id = 'shop') => h.call(`/admin/v1/tenants/${id}`, { method: 'PATCH', body })

      const renamed = await patch({ name: 'New name', allowedOrigins: ['https://shop.example'], plan: 'pro' })
      assert.equal(renamed.status, 200)
      const after = (await (await h.call('/admin/v1/tenants/shop')).json()) as {
        name: string
        plan: string
        allowedOrigins: string[]
      }
      assert.deepEqual([after.name, after.plan, after.allowedOrigins], ['New name', 'pro', ['https://shop.example']])

      assert.equal((await patch({ settings: { identity: { matchProbability: 2 } } })).status, 400)
      assert.equal((await patch({ status: 'gone' })).status, 400)
      assert.equal((await patch({ plan: 'gold' })).status, 400)
      assert.equal((await patch({ unknown: 1 })).status, 400)
      assert.equal((await patch({ name: 'x' }, 'file')).status, 409, 'a tenant of the file is changed in the file')
      assert.equal((await patch({ name: 'x' }, 'nobody')).status, 404)
      assert.equal(
        ((await (await h.call('/admin/v1/tenants/shop')).json()) as { name: string }).name,
        'New name',
        'refused changes left it as it was',
      )

      // The key still works after every change
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 200)
      await patch({ name: null })
      assert.equal(((await (await h.call('/admin/v1/tenants/shop')).json()) as { name: string | null }).name, null)
    })
  })

  it('suspends a tenant: it cannot collect, it can still read, and it can come back', async () => {
    await withServer(async (h) => {
      const created = await h.create({ id: 'shop' })
      assert.equal((await h.visit(created.tenant)).status, 200)
      await h.call('/admin/v1/tenants/shop', { method: 'PATCH', body: { status: 'suspended' } })
      const nonce = await fetch(`http://127.0.0.1:${h.server.port}/v1/nonce?k=${created.tenant.publicKey}`)
      assert.equal(nonce.status, 403)
      assert.deepEqual(await nonce.json(), { error: 'tenant_suspended' })
      assert.equal((await h.visit(created.tenant)).status, 403)
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 200, 'it can still get its data out')
      await h.call('/admin/v1/tenants/shop', { method: 'PATCH', body: { status: 'active' } })
      assert.equal((await h.visit(created.tenant)).status, 200)
    })
  })

  it('suspends a tenant of the file by its status in the file', async () => {
    const server = await startServer(
      parseConfig({
        nonceSecret: 'n'.repeat(32),
        tenants: [{ id: 'file', publicKey: FILE_PK, secretKeySha256: [sha256Hex(FILE_SK)], status: 'suspended' }],
      }),
      { port: 0 },
    )
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/v1/nonce?k=${FILE_PK}`)).status, 403)
    } finally {
      await server.close()
    }
  })

  it('keeps the tenants across a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-saas-'))
    try {
      const databasePath = path.join(dir, 'events.db')
      let created: Created | undefined
      await withServer(
        async (h) => {
          created = await h.create({ id: 'shop', plan: 'pro' })
          await h.visit(created.tenant)
        },
        { databasePath },
      )
      await withServer(
        async (h) => {
          assert.ok(created)
          assert.equal((await h.visit(created.tenant)).status, 200, 'the public key is known again')
          const events = (await (await h.read(created.secretKey, '/v1/events')).json()) as { events: unknown[] }
          assert.equal(events.events.length, 2, 'and so is the data')
          const detail = (await (await h.call('/admin/v1/tenants/shop')).json()) as { plan: string }
          assert.equal(detail.plan, 'pro')
        },
        { databasePath },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets the file win over a tenant of the database after a reload', async () => {
    await withServer(async (h) => {
      const created = await h.create({ id: 'shop' })
      const next = config({
        tenants: [
          { id: 'file', publicKey: FILE_PK, secretKeySha256: [sha256Hex(FILE_SK)] },
          { id: 'shop', publicKey: 'pk_fromfile_0123456789ab', secretKeySha256: [sha256Hex('sk_fromfile')] },
        ],
      })
      await h.server.reloadConfig(next)
      assert.equal((await h.read('sk_fromfile', '/v1/events')).status, 200)
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 401, 'the shadowed tenant cannot be used')
    })
  })
})

describe('admin API: keys', () => {
  it('adds a key, revokes one, and never leaves a tenant without any', async () => {
    await withServer(async (h) => {
      const created = await h.create({ id: 'shop' })
      const addResponse = await h.call('/admin/v1/tenants/shop/keys', { method: 'POST' })
      assert.equal(addResponse.status, 201)
      const added = (await addResponse.json()) as { keyId: string; secretKey: string }
      assert.equal(added.keyId, sha256Hex(added.secretKey).slice(0, 8))
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 200, 'the old key still works')
      assert.equal((await h.read(added.secretKey, '/v1/events')).status, 200)

      const oldId = created.tenant.keyIds[0]
      assert.equal((await h.call(`/admin/v1/tenants/shop/keys/${oldId}`, { method: 'DELETE' })).status, 200)
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 401, 'revoked')
      assert.equal((await h.read(added.secretKey, '/v1/events')).status, 200)

      const last = await h.call(`/admin/v1/tenants/shop/keys/${added.keyId}`, { method: 'DELETE' })
      assert.equal(last.status, 409)
      assert.deepEqual(await last.json(), { error: 'last_key' })
      assert.equal((await h.call('/admin/v1/tenants/shop/keys/00000000', { method: 'DELETE' })).status, 404)
      assert.equal((await h.call('/admin/v1/tenants/shop/keys/short', { method: 'DELETE' })).status, 404)
      assert.equal((await h.call('/admin/v1/tenants/shop/keys', { method: 'GET' })).status, 405)
      assert.equal(
        (await h.call('/admin/v1/tenants/file/keys', { method: 'POST' })).status,
        409,
        'the file owns its keys',
      )
      assert.equal((await h.call('/admin/v1/tenants/nobody/keys', { method: 'POST' })).status, 404)
    })
  })

  it('allows at most five keys', async () => {
    await withServer(async (h) => {
      await h.create({ id: 'shop' })
      for (let i = 0; i < 4; i++) {
        assert.equal((await h.call('/admin/v1/tenants/shop/keys', { method: 'POST' })).status, 201)
      }
      const sixth = await h.call('/admin/v1/tenants/shop/keys', { method: 'POST' })
      assert.equal(sixth.status, 409)
      assert.deepEqual(await sixth.json(), { error: 'too_many_keys', max: 5 })
    })
  })
})

describe('admin API: removing a tenant', () => {
  it('asks to confirm, then removes the tenant and all it kept, and nothing of another', async () => {
    await withServer(async (h) => {
      const doomed = await h.create({ id: 'doomed' })
      await h.visit(doomed.tenant)
      await h.visit(doomed.tenant, 'acct2')
      await h.visit({ publicKey: FILE_PK })
      assert.equal((await h.call('/admin/v1/tenants/doomed', { method: 'DELETE' })).status, 400)
      assert.equal((await h.call('/admin/v1/tenants/doomed?confirm=other', { method: 'DELETE' })).status, 400)
      assert.equal((await h.read(doomed.secretKey, '/v1/events')).status, 200, 'not removed yet')

      const response = await h.call('/admin/v1/tenants/doomed?confirm=doomed', { method: 'DELETE' })
      assert.equal(response.status, 200)
      const result = (await response.json()) as { events: number; devices: number }
      assert.equal(result.events, 2)
      assert.equal(result.devices, 2, 'both visits made a device, since two signals are too little to match')
      assert.equal((await h.read(doomed.secretKey, '/v1/events')).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${h.server.port}/v1/nonce?k=${doomed.tenant.publicKey}`)).status, 401)
      assert.equal((await h.call('/admin/v1/tenants/doomed')).status, 404)
      const other = (await (await h.read(FILE_SK, '/v1/events')).json()) as { events: unknown[] }
      assert.equal(other.events.length, 1, 'the other tenant is untouched')
      assert.equal((await h.call('/admin/v1/tenants/file?confirm=file', { method: 'DELETE' })).status, 409)

      // The id can be used again, as a new tenant with nothing of the old one
      const again = await h.create({ id: 'doomed' })
      const events = (await (await h.read(again.secretKey, '/v1/events')).json()) as { events: unknown[] }
      assert.equal(events.events.length, 0)
    })
  })
})

describe('usage and quotas', () => {
  const t0 = Date.parse('2026-10-15T12:00:00Z')

  it('counts what a tenant does and shows it to the tenant and to the admin', async () => {
    let clock = t0
    await withServer(
      async (h) => {
        const created = await h.create({ id: 'shop' })
        await h.visit(created.tenant)
        await h.visit(created.tenant, 'acct2')
        await h.read(created.secretKey, '/v1/events')
        clock = Date.parse('2026-10-16T01:00:00Z')
        await h.read(created.secretKey, '/v1/events')

        const usage = (await (await h.read(created.secretKey, '/v1/usage?month=2026-10')).json()) as {
          month: string
          totals: Record<string, number>
          days: Array<{ day: string; apiReads: number }>
          quotas: Record<string, number>
        }
        assert.equal(usage.month, '2026-10')
        assert.deepEqual(
          [usage.totals.collects, usage.totals.nonces, usage.totals.apiReads],
          [2, 2, 2],
          'reading the usage is not counted',
        )
        assert.deepEqual(
          usage.days.map((day) => [day.day, day.apiReads]),
          [
            ['2026-10-15', 1],
            ['2026-10-16', 1],
          ],
        )
        assert.deepEqual(usage.quotas, { collectsPerMonth: 0, apiReadsPerMonth: 0 })

        const admin = (await (await h.call('/admin/v1/usage?tenant=shop&month=2026-10')).json()) as {
          totals: Record<string, number>
        }
        assert.equal(admin.totals.collects, 2)
        const all = (await (await h.call('/admin/v1/usage?month=2026-10')).json()) as {
          tenants: Array<{ tenant: string; totals: Record<string, number> }>
        }
        assert.deepEqual(
          all.tenants.map((entry) => [entry.tenant, entry.totals.collects]),
          [
            ['file', 0],
            ['shop', 2],
          ],
        )

        assert.equal((await h.read(created.secretKey, '/v1/usage?month=2026-13')).status, 400)
        assert.equal((await h.read(created.secretKey, '/v1/usage?month=oct')).status, 400)
        assert.equal((await h.call('/admin/v1/usage?month=bad')).status, 400)
        assert.equal((await h.call('/admin/v1/usage?tenant=nobody')).status, 404)
        const empty = (await (await h.read(created.secretKey, '/v1/usage?month=2025-01')).json()) as {
          totals: Record<string, number>
        }
        assert.equal(empty.totals.collects, 0)
      },
      {},
      { now: () => clock },
    )
  })

  it('refuses visits over the monthly quota with the time to wait, and starts again next month', async () => {
    let clock = t0
    await withServer(
      async (h) => {
        const created = await h.create({ id: 'shop', settings: { quota: { collectsPerMonth: 2 } } })
        assert.equal((await h.visit(created.tenant)).status, 200)
        assert.equal((await h.visit(created.tenant)).status, 200)
        const over = await h.visit(created.tenant)
        assert.equal(over.status, 429)
        assert.deepEqual(await over.json(), { error: 'quota_exceeded', metric: 'collects' })
        assert.equal(
          over.headers.get('retry-after'),
          String(Math.ceil((Date.parse('2026-11-01T00:00:00Z') - t0) / 1000)),
        )
        assert.equal(
          (await h.read(created.secretKey, '/v1/events')).status,
          200,
          'reading is not blocked by the collect quota',
        )
        const usage = (await (await h.read(created.secretKey, '/v1/usage')).json()) as {
          totals: Record<string, number>
        }
        assert.deepEqual([usage.totals.collects, usage.totals.quotaRejected], [2, 1])

        clock = Date.parse('2026-11-01T00:00:00Z')
        assert.equal((await h.visit(created.tenant)).status, 200, 'a new month, a new quota')
      },
      {},
      { now: () => clock },
    )
  })

  it('applies the quota of the plan, and 0 means no limit', async () => {
    await withServer(async (h) => {
      const free = await h.create({ id: 'free1', plan: 'free' })
      await h.visit(free.tenant)
      await h.visit(free.tenant)
      assert.equal((await h.visit(free.tenant)).status, 429, 'two a month on the free plan')
      const unlimited = await h.create({ id: 'pro1', plan: 'pro' })
      for (let i = 0; i < 5; i++) {
        assert.equal((await h.visit(unlimited.tenant)).status, 200)
      }
    })
  })

  it('limits the reads of the API by month, but never the reading of the usage', async () => {
    await withServer(async (h) => {
      const created = await h.create({ id: 'shop', settings: { quota: { apiReadsPerMonth: 2 } } })
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 200)
      assert.equal((await h.read(created.secretKey, '/v1/events')).status, 200)
      const over = await h.read(created.secretKey, '/v1/events')
      assert.equal(over.status, 429)
      assert.deepEqual(await over.json(), { error: 'quota_exceeded', metric: 'apiReads' })
      assert.equal((await h.read(created.secretKey, '/v1/usage')).status, 200)
    })
  })
})
