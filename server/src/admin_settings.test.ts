import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseConfig, sha256Hex } from './config'
import { RunningServer, startServer } from './server'
import { buildCatalog, helpCoverage, helpProblems } from './settings/catalog'
import { parameterHelp } from './settings/help'
import { parameters } from './settings/parameters'
import { importFileTenants } from './tenants/import'
import { MemoryTenantStore } from './tenants/store'

const ADMIN = 'adm_admin_secret_key'

const config = (extra: Record<string, unknown> = {}) =>
  parseConfig({
    nonceSecret: 'n'.repeat(32),
    adminKeySha256: [sha256Hex(ADMIN)],
    dashboard: true,
    tenants: [{ id: 'file', publicKey: 'pk_filetenant_0123456789', secretKeySha256: [sha256Hex('sk_filetenant')] }],
    plans: { pro: { limits: { collectPerMinutePerIp: 500 } } },
    ...extra,
  })

class Harness {
  constructor(readonly server: RunningServer) {}

  call(path: string, options: { method?: string; key?: string; body?: unknown } = {}) {
    return fetch(`http://127.0.0.1:${this.server.port}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.key === '' ? {} : { Authorization: `Bearer ${options.key ?? ADMIN}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  }
}

async function withServer(run: (h: Harness) => Promise<void>, extra: Record<string, unknown> = {}) {
  const server = await startServer(config(extra), { port: 0, webhookIntervalMs: 3_600_000 })
  try {
    await run(new Harness(server))
  } finally {
    await server.close()
  }
}

const endpoint = { id: 'main', url: 'https://hooks.example.com/x', secrets: ['a-secret-long-enough-1'] }

describe('the explanation of the parameters', () => {
  it('has no gaps: every parameter is explained or waiting, and nothing waits after it was explained', () => {
    assert.deepEqual(helpProblems(), [])
  })

  it('finds each kind of gap (the check itself, with made-up data)', () => {
    assert.deepEqual(helpProblems(['a', 'b'], { a: {} }, ['b']), [])
    assert.equal(helpProblems(['a', 'b'], { a: {} }, []).length, 1, 'b is neither explained nor waiting')
    assert.equal(helpProblems(['a'], { a: {} }, ['a']).length, 1, 'a is explained and still waiting')
    assert.equal(helpProblems(['a'], { a: {}, ghost: {} }, []).length, 1, 'ghost is not a parameter')
    assert.equal(helpProblems(['a'], { a: {} }, ['ghost']).length, 1, 'ghost waits but is not a parameter')
  })

  it('counts what is explained', () => {
    const coverage = helpCoverage()
    assert.equal(coverage.total, parameters.length)
    assert.equal(coverage.documented, Object.keys(parameterHelp).length)
    assert.equal(coverage.pending.length, coverage.total - coverage.documented)
  })

  it('explains every parameter that the panel makes a point of (the ones in use now)', () => {
    for (const path of [
      'identity.learnFromTampered',
      'tamper.severity',
      'risk.levels.high',
      'risk.velocity.linkedIdsPerDevice.threshold',
      'retention.eventsDays',
    ]) {
      assert.ok(parameterHelp[path], path)
    }
  })

  it('gives every explanation the parts that the panel draws', () => {
    for (const [path, help] of Object.entries(parameterHelp)) {
      assert.ok(help.title.length > 0, `${path} title`)
      assert.ok(help.summary.length > 0, `${path} summary`)
      assert.ok(help.what.length > 0, `${path} what`)
      assert.ok(help.useCases.length > 0, `${path} useCases`)
    }
  })

  it('travels as JSON: no kind has a function in it', () => {
    const roundTrip = JSON.parse(JSON.stringify(buildCatalog())) as ReturnType<typeof buildCatalog>
    assert.equal(roundTrip.length, parameters.length)
    assert.deepEqual(roundTrip.find((entry) => entry.path === 'rules.list')?.kind, { type: 'json' })
  })
})

describe('admin API: parameters and settings of a tenant', () => {
  it('shows the catalog only to the operator', async () => {
    await withServer(async (h) => {
      assert.equal((await h.call('/admin/v1/parameters', { key: 'adm_wrong' })).status, 401)
      assert.equal((await h.call('/admin/v1/parameters', { key: '' })).status, 401)
      assert.equal((await h.call('/admin/v1/parameters', { method: 'POST', body: {} })).status, 405)
      const body = (await (await h.call('/admin/v1/parameters')).json()) as {
        parameters: Array<{ path: string; help: { title: string } | null; readOnly: boolean }>
        coverage: { documented: number; total: number }
      }
      assert.equal(body.parameters.length, parameters.length)
      const learn = body.parameters.find((entry) => entry.path === 'identity.learnFromTampered')
      assert.ok((learn?.help?.title.length ?? 0) > 0)
      assert.equal(body.parameters.find((entry) => entry.path === 'webhooks.endpoints')?.readOnly, true)
      assert.equal(body.coverage.total, parameters.length)
    })
  })

  it('says what the tenant sets, what it falls back to, and where each value comes from', async () => {
    await withServer(async (h) => {
      const created = await h.call('/admin/v1/tenants', {
        method: 'POST',
        body: { id: 'shop', plan: 'pro', settings: { risk: { levels: { high: 70 } } } },
      })
      assert.equal(created.status, 201)
      assert.equal((await h.call('/admin/v1/tenants/shop/settings', { key: 'adm_wrong' })).status, 401)
      const view = (await (await h.call('/admin/v1/tenants/shop/settings')).json()) as {
        editable: boolean
        overrides: Record<string, unknown>
        effective: Record<string, unknown>
        inherited: Record<string, unknown>
        origins: Record<string, string>
      }
      assert.equal(view.editable, true)
      assert.deepEqual(view.overrides, { 'risk.levels.high': 70 })
      assert.equal(view.effective['risk.levels.high'], 70)
      assert.equal(view.inherited['risk.levels.high'], 60, 'without its own setting it would be the default')
      assert.equal(view.origins['risk.levels.high'], 'tenant')
      assert.equal(view.effective['limits.collectPerMinutePerIp'], 500)
      assert.equal(view.origins['limits.collectPerMinutePerIp'], 'plan')
      assert.equal(view.origins['retention.eventsDays'], 'built-in')
    })
  })

  it('says that a tenant of the file cannot be edited, and that an unknown tenant is not found', async () => {
    await withServer(async (h) => {
      const view = (await (await h.call('/admin/v1/tenants/file/settings')).json()) as { editable: boolean }
      assert.equal(view.editable, false)
      assert.equal((await h.call('/admin/v1/tenants/nobody/settings')).status, 404)
    })
  })

  it('does not show the secrets of webhooks, and refuses them when sent back as "[hidden]"', async () => {
    await withServer(async (h) => {
      await h.call('/admin/v1/tenants', {
        method: 'POST',
        body: { id: 'shop', settings: { webhooks: { endpoints: [endpoint] } } },
      })
      const text = await (await h.call('/admin/v1/tenants/shop/settings')).text()
      assert.ok(!text.includes('a-secret-long-enough-1'), 'the secret leaked')
      assert.ok(text.includes('[hidden]'))
      const sentBack = await h.call('/admin/v1/tenants/shop', {
        method: 'PATCH',
        body: { settings: { webhooks: { endpoints: [{ ...endpoint, secrets: ['[hidden]'] }] } } },
      })
      assert.equal(sentBack.status, 400)
      assert.equal(((await sentBack.json()) as { error: string }).error, 'hidden_placeholder')
    })
  })

  it('keeps what the panel only shows (keepReadOnly), and replaces the whole settings without it', async () => {
    await withServer(async (h) => {
      await h.call('/admin/v1/tenants', {
        method: 'POST',
        body: { id: 'shop', settings: { webhooks: { endpoints: [endpoint] } } },
      })
      const withKeep = await h.call('/admin/v1/tenants/shop', {
        method: 'PATCH',
        body: { settings: { risk: { levels: { high: 70 } } }, keepReadOnly: true },
      })
      assert.equal(withKeep.status, 200)
      const kept = (await (await h.call('/admin/v1/tenants/shop/settings')).json()) as {
        overrides: Record<string, unknown>
        effective: Record<string, unknown>
      }
      assert.equal(kept.effective['risk.levels.high'], 70)
      assert.equal(JSON.stringify(kept.overrides['webhooks.endpoints']).includes('main'), true, 'the endpoint was lost')

      const withoutKeep = await h.call('/admin/v1/tenants/shop', {
        method: 'PATCH',
        body: { settings: { risk: { levels: { high: 71 } } } },
      })
      assert.equal(withoutKeep.status, 200)
      const lost = (await (await h.call('/admin/v1/tenants/shop/settings')).json()) as {
        overrides: Record<string, unknown>
      }
      assert.equal('webhooks.endpoints' in lost.overrides, false, 'without keepReadOnly the settings are replaced')
    })
  })

  it('refuses a value that is out of range, naming the parameter, and saves nothing', async () => {
    await withServer(async (h) => {
      await h.call('/admin/v1/tenants', { method: 'POST', body: { id: 'shop' } })
      const refused = await h.call('/admin/v1/tenants/shop', {
        method: 'PATCH',
        body: { settings: { risk: { levels: { medium: 80, high: 50 } } }, keepReadOnly: true },
      })
      assert.equal(refused.status, 400)
      const body = (await refused.json()) as { error: string; problems: string[] }
      assert.equal(body.error, 'invalid_settings')
      assert.ok(body.problems.some((problem) => problem.includes('risk.levels.medium')))
      const view = (await (await h.call('/admin/v1/tenants/shop/settings')).json()) as {
        overrides: Record<string, unknown>
      }
      assert.deepEqual(view.overrides, {})
    })
  })
})

describe('import-tenants', () => {
  const fileTenant = {
    id: 'pwa',
    name: 'PWA',
    publicKey: 'pk_pwa_0123456789abcdef',
    secretKeySha256: [sha256Hex('sk_pwa')],
    allowedOrigins: ['https://app.example.com'],
    settings: { retention: { eventsDays: 60 } },
    status: 'active' as const,
  }

  it('copies the tenants with the SAME keys, origins and settings', async () => {
    const store = new MemoryTenantStore()
    const report = await importFileTenants([fileTenant], store, 1000)
    assert.deepEqual(report.imported, ['pwa'])
    const saved = await store.get('pwa')
    assert.equal(saved?.publicKey, fileTenant.publicKey)
    assert.deepEqual(saved?.secretKeySha256, fileTenant.secretKeySha256)
    assert.deepEqual(saved?.allowedOrigins, fileTenant.allowedOrigins)
    assert.deepEqual(saved?.settings, fileTenant.settings)
    assert.equal(saved?.createdAt, 1000)
  })

  it('is safe to run again: what is in the database is left alone, never overwritten', async () => {
    const store = new MemoryTenantStore()
    await importFileTenants([fileTenant], store, 1000)
    const saved = await store.get('pwa')
    assert.ok(saved)
    await store.update({ ...saved, settings: { retention: { eventsDays: 90 } } })
    const again = await importFileTenants([fileTenant], store, 2000)
    assert.deepEqual(again.imported, [])
    assert.equal(again.skipped[0].id, 'pwa')
    assert.deepEqual((await store.get('pwa'))?.settings, { retention: { eventsDays: 90 } })
  })

  it('leaves a tenant alone whose id is already in the database, even with other keys', async () => {
    const store = new MemoryTenantStore()
    await importFileTenants([fileTenant], store, 1000)
    const report = await importFileTenants(
      [{ ...fileTenant, publicKey: 'pk_other_0123456789abcdef', secretKeySha256: [sha256Hex('sk_other')] }],
      store,
      2000,
    )
    assert.deepEqual(report.imported, [])
    assert.equal(report.skipped[0].reason, 'already in the database')
    assert.equal((await store.get('pwa'))?.publicKey, fileTenant.publicKey, 'the record was overwritten')
  })

  it('leaves a tenant alone whose public key another tenant of the database already uses', async () => {
    const store = new MemoryTenantStore()
    await importFileTenants([fileTenant], store, 1000)
    const report = await importFileTenants([{ ...fileTenant, id: 'other' }], store, 2000)
    assert.deepEqual(report.imported, [])
    assert.match(report.skipped[0].reason, /public key/)
    assert.equal(await store.get('other'), undefined)
  })

  it('writes nothing in a dry run', async () => {
    const store = new MemoryTenantStore()
    const report = await importFileTenants([fileTenant], store, 1000, { dryRun: true })
    assert.deepEqual(report.imported, ['pwa'])
    assert.deepEqual(await store.list(), [])
  })
})

describe('the settings panel (served page)', () => {
  const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`)

  it('is served with a policy that allows no inline script, only when the dashboard is on', async () => {
    const off = await startServer(config({ dashboard: false }), { port: 0 })
    try {
      assert.equal((await get(off.port, '/dashboard/config')).status, 404)
    } finally {
      await off.close()
    }
    const on = await startServer(config(), { port: 0 })
    try {
      for (const path of ['/dashboard/config', '/dashboard/config/']) {
        const page = await get(on.port, path)
        assert.equal(page.status, 200, path)
        const csp = page.headers.get('content-security-policy') ?? ''
        assert.match(csp, /default-src 'none'/)
        assert.match(csp, /script-src 'self'(;|$)/)
        assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), csp)
        assert.equal(page.headers.get('x-frame-options'), 'DENY')
        assert.equal(page.headers.get('cache-control'), 'no-store')
      }
      const style = await (await get(on.port, '/dashboard/config/style.css')).text()
      // A rule such as "form { display: flex }" would otherwise show a form that has the attribute hidden
      assert.ok(style.includes('[hidden] { display: none !important; }'), 'hidden elements would show')
      assert.equal((await get(on.port, '/dashboard/config/other.js')).status, 404)
    } finally {
      await on.close()
    }
  })

  it('never turns what the server says into markup, never keeps the key, and has no inline code', async () => {
    const on = await startServer(config(), { port: 0 })
    try {
      const script = await (await get(on.port, '/dashboard/config/app.js')).text()
      const html = await (await get(on.port, '/dashboard/config')).text()
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
      // It is valid JavaScript (a literal that was cut by a stray backtick or backslash would not be)
      assert.doesNotThrow(() => new Function(script), 'the script does not parse')
    } finally {
      await on.close()
    }
  })

  it('draws the helptip with the explanation that the API sends, and asks twice before a risky change', async () => {
    const on = await startServer(config(), { port: 0 })
    try {
      const script = await (await get(on.port, '/dashboard/config/app.js')).text()
      // The message of a save must still be there when the list is loaded again (it was overwritten once)
      assert.ok(script.includes("loadTenant(current.tenantId, 'Aplicado."), 'the message of a save is lost')
      for (const part of [
        'helptip',
        'aria-expanded',
        'aria-controls',
        'Restaurar padrão',
        'keepReadOnly',
        'Entendi, aplicar mesmo assim',
      ]) {
        assert.ok(script.includes(part), `the script lacks ${part}`)
      }
    } finally {
      await on.close()
    }
  })
})
