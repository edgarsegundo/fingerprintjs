import { send as realSend } from '../collector/transport'

import { CollectorApi, Environment, LoaderOptions, start } from './loader'

const endpoint = 'https://id.example.com:8443'
const options: LoaderOptions = {
  scriptUrl: `${endpoint}/static/pw.js`,
  endpoint,
  publicKey: 'pk_test123',
  reportTo: '/fp-report',
  linkedId: 'account-7',
  timeoutMs: 50,
  probeTimeoutMs: 50,
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

interface Rig {
  env: Environment
  /** Every call to the fake `fetch`, by address */
  fetched: string[]
  /** The bodies posted with `sendBeacon` and with the `keepalive` fetch */
  reports: Array<Record<string, unknown>>
  collectCalls: Array<Record<string, unknown> | undefined>
  loadedScripts: string[]
  state: { reported: boolean }
}

/** A page whose network behaves as the test says. Anything not given works. */
function rig(
  overrides: {
    script?: 'loaded' | 'error' | 'timeout'
    hasCollector?: boolean
    collectorOnLoad?: boolean
    nonce?: Handler
    collect?: () => Promise<unknown>
    collectEndpoint?: Handler
    healthz?: Handler
    online?: boolean
    beacon?: boolean | 'throw'
    reportFetch?: 'throw' | 'reject'
    alreadyReported?: boolean
    random?: number
  } = {},
): Rig {
  const fetched: string[] = []
  const reports: Array<Record<string, unknown>> = []
  const collectCalls: Array<Record<string, unknown> | undefined> = []
  const loadedScripts: string[] = []
  const state = { reported: overrides.alreadyReported ?? false }
  let collectorPresent = overrides.hasCollector ?? false

  const fakeFetch = (url: string, init: RequestInit): Promise<Response> => {
    fetched.push(url)
    if (url === '/fp-report') {
      if (overrides.reportFetch === 'throw') {
        throw new Error('sync failure')
      }
      reports.push(JSON.parse(init.body as string))
      return overrides.reportFetch === 'reject' ? Promise.reject(new TypeError('nope')) : Promise.resolve(json({}))
    }
    const handler: Handler | undefined = url.includes('/healthz')
      ? overrides.healthz
      : url.includes('/v1/nonce')
      ? overrides.nonce
      : overrides.collectEndpoint
    if (handler) {
      return Promise.resolve(handler(url, init))
    }
    return Promise.resolve(
      url.includes('/v1/nonce')
        ? json({ nonce: 'n-1' })
        : url.includes('/healthz')
        ? json({})
        : json({ requestId: 'req-1' }),
    )
  }

  const collector: CollectorApi = {
    collect: (collectOptions) => {
      collectCalls.push(collectOptions)
      return overrides.collect ? overrides.collect() : Promise.resolve({ schema: 1 })
    },
    send: (payload, sendOptions) => realSend(payload as never, { ...sendOptions, fetch: fakeFetch as never }),
  }

  const env: Environment = {
    loadScript: (url) => {
      loadedScripts.push(url)
      const result = overrides.script ?? 'loaded'
      if (result === 'loaded' && overrides.collectorOnLoad !== false) {
        collectorPresent = true
      }
      return Promise.resolve(result)
    },
    collector: () => (collectorPresent ? collector : undefined),
    fetch: fakeFetch as never,
    sendBeacon: (url, body) => {
      if (overrides.beacon === 'throw') {
        throw new Error('beacon failure')
      }
      if (overrides.beacon === false) {
        return false
      }
      expect(url).toBe('/fp-report')
      reports.push(JSON.parse(body))
      return true
    },
    now: () => Date.now(),
    random: () => overrides.random ?? 0.5,
    isOnline: () => overrides.online ?? true,
    connectionType: () => '4g',
    alreadyReported: () => state.reported,
    markReported: () => {
      state.reported = true
    },
  }
  return { env, fetched, reports, collectCalls, loadedScripts, state }
}

const refuse: Handler = () => Promise.reject(new TypeError('Failed to fetch'))

describe('Loader', () => {
  afterEach(() => {
    try {
      sessionStorage.removeItem('_fp_reported')
    } catch {
      // storage may be blocked
    }
  })

  it('collects and sends, and reports nothing when it works', async () => {
    const page = rig()
    const result = await start(options, page.env)
    expect(result).toEqual({ ok: true, requestId: 'req-1' })
    expect(page.reports).toEqual([])
    expect(page.loadedScripts).toEqual([options.scriptUrl])
    expect(page.collectCalls[0]).toEqual({ nonce: 'n-1', linkedId: 'account-7' })
    expect(page.fetched.some((url) => url.includes('/healthz')))
      .withContext('no probe when nothing failed')
      .toBe(false)
  })

  it('does not load the script again when the page already has the collector', async () => {
    const page = rig({ hasCollector: true })
    expect((await start(options, page.env)).ok).toBe(true)
    expect(page.loadedScripts).toEqual([])
  })

  it('passes the options of the page to the collector, and adds what the server asks for', async () => {
    const page = rig({
      nonce: () => json({ nonce: 'n-2', profile: { exclude: ['audio', 'bad name!'], include: ['webGpu'] } }),
    })
    await start(
      { ...options, collectOptions: { consent: { basis: 'consent', version: 'v1' }, exclude: ['fonts'] } },
      page.env,
    )
    expect(page.collectCalls[0]).toEqual({
      consent: { basis: 'consent', version: 'v1' },
      nonce: 'n-2',
      linkedId: 'account-7',
      exclude: ['fonts', 'audio'],
      include: ['webGpu'],
    })
  })

  describe('when the script does not load', () => {
    it('says the network when the server cannot be reached at all', async () => {
      const page = rig({ script: 'error', healthz: refuse })
      const result = await start(options, page.env)
      expect(result).toEqual({ ok: false, reason: 'script_unreachable' })
      expect(page.reports.length).toBe(1)
      expect(page.reports[0]).toEqual(
        jasmine.objectContaining({
          v: 1,
          reason: 'script_unreachable',
          phase: 'script',
          probe: 'unreachable',
          online: true,
          connection: '4g',
          site: 'pk_test123',
        }),
      )
      expect(page.fetched.find((url) => url.includes('/healthz'))).toBe(`${endpoint}/healthz`)
    })

    it('says a blocker when the server can be reached', async () => {
      const page = rig({ script: 'error' })
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'script_blocked' })
      expect(page.reports[0]).toEqual(jasmine.objectContaining({ reason: 'script_blocked', probe: 'reachable' }))
    })

    it('treats a script that never answers like one that failed, and the probe decides', async () => {
      const page = rig({ script: 'timeout', healthz: refuse })
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'script_unreachable' })
      const reachable = rig({ script: 'timeout' })
      expect(await start(options, reachable.env)).toEqual({ ok: false, reason: 'script_blocked' })
    })

    it('stops waiting for a probe that never answers', async () => {
      const page = rig({ script: 'error' })
      // A probe that never answers is cut by its signal, so check that it is given and that it aborts
      const signals: AbortSignal[] = []
      const original = page.env.fetch
      page.env.fetch = (url, init) => {
        if (url.includes('/healthz') && init.signal) {
          signals.push(init.signal)
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
        }
        return original(url, init)
      }
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'script_unreachable' })
      expect(signals.length).toBe(1)
      expect(signals[0].aborted).toBe(true)
    })

    it('says broken when the script loaded but is not the collector', async () => {
      const page = rig({ collectorOnLoad: false })
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'script_broken' })
      expect(page.reports[0]).toEqual(jasmine.objectContaining({ reason: 'script_broken', probe: 'skipped' }))
    })
  })

  describe('when a request fails', () => {
    it('tells a request that cannot get through from one that a blocker or a missing origin stopped', async () => {
      const down = rig({ nonce: refuse, healthz: refuse })
      expect(await start(options, down.env)).toEqual({ ok: false, reason: 'request_unreachable' })
      expect(down.reports[0]).toEqual(jasmine.objectContaining({ phase: 'nonce', probe: 'unreachable' }))

      const blocked = rig({ collectEndpoint: refuse })
      expect(await start(options, blocked.env)).toEqual({ ok: false, reason: 'request_blocked' })
      expect(blocked.reports[0]).toEqual(jasmine.objectContaining({ phase: 'send', probe: 'reachable' }))
    })

    it('keeps the status of a refusal and of a server error, and does not probe for them', async () => {
      for (const [status, reason] of [
        [401, 'server_refused'],
        [403, 'server_refused'],
        [422, 'server_refused'],
        [429, 'server_refused'],
        [500, 'server_error'],
        [503, 'server_error'],
      ] as const) {
        const page = rig({ collectEndpoint: () => json({ error: 'x' }, status) })
        expect(await start(options, page.env)).toEqual({ ok: false, reason, status })
        expect(page.reports[0]).toEqual(jasmine.objectContaining({ reason, status, phase: 'send', probe: 'skipped' }))
        expect(page.fetched.some((url) => url.includes('/healthz'))).toBe(false)
      }
      const nonce = rig({ nonce: () => json({}, 403) })
      expect(await start(options, nonce.env)).toEqual({ ok: false, reason: 'server_refused', status: 403 })
      expect(nonce.reports[0]).toEqual(jasmine.objectContaining({ phase: 'nonce' }))
    })

    it('says server error for an answer that is not what the server sends', async () => {
      const noNonce = rig({ nonce: () => json({ nope: true }) })
      expect(await start(options, noNonce.env)).toEqual({ ok: false, reason: 'server_error' })
      const noId = rig({ collectEndpoint: () => json({}) })
      expect(await start(options, noId.env)).toEqual({ ok: false, reason: 'server_error' })
    })

    it('says timeout when the request is aborted', async () => {
      const page = rig({
        collectEndpoint: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      })
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'timeout' })
      expect(page.reports[0]).toEqual(jasmine.objectContaining({ reason: 'timeout', phase: 'send' }))
    })

    it('says collect error when reading the signals fails', async () => {
      const page = rig({ collect: () => Promise.reject(new Error('boom')) })
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'collect_error' })
      expect(page.reports[0]).toEqual(jasmine.objectContaining({ phase: 'collect' }))
    })
  })

  describe('the report', () => {
    it('has only what is needed to count, and nothing that identifies the visitor', async () => {
      const page = rig({ script: 'error', healthz: refuse })
      await start({ ...options, linkedId: 'user-12345' }, page.env)
      const body = page.reports[0]
      expect(Object.keys(body).sort()).toEqual(
        ['connection', 'elapsedMs', 'online', 'phase', 'probe', 'reason', 'site', 'v'].sort(),
      )
      expect(JSON.stringify(body)).not.toContain('user-12345')
      expect(JSON.stringify(body).length).toBeLessThan(600)
    })

    it('is sent once per tab session', async () => {
      const page = rig({ script: 'error', healthz: refuse })
      await start(options, page.env)
      await start(options, page.env)
      expect(page.reports.length).toBe(1)
      const second = await start(options, page.env)
      expect(second.ok).withContext('the result still says what happened').toBe(false)
    })

    it('is not sent from a device that is offline', async () => {
      const page = rig({ script: 'error', healthz: refuse, online: false })
      expect(await start(options, page.env)).toEqual({ ok: false, reason: 'script_unreachable' })
      expect(page.reports).toEqual([])
      expect(page.state.reported).withContext('the report of the tab is kept for later').toBe(false)
    })

    it('falls back to fetch with keepalive when the beacon is refused or throws', async () => {
      for (const beacon of [false, 'throw'] as const) {
        const page = rig({ script: 'error', healthz: refuse, beacon })
        await start(options, page.env)
        expect(page.reports.length).toBe(1)
        expect(page.fetched).toContain('/fp-report')
      }
    })

    it('can sample the visits that worked, to give the receiver a denominator', async () => {
      const sampled = rig({ random: 0.001 })
      await start({ ...options, successSampleRate: 0.01 }, sampled.env)
      expect(sampled.reports[0]).toEqual(jasmine.objectContaining({ reason: 'ok', probe: 'skipped' }))
      const skipped = rig({ random: 0.5 })
      await start({ ...options, successSampleRate: 0.01 }, skipped.env)
      expect(skipped.reports).toEqual([])
      const off = rig({ random: 0 })
      await start(options, off.env)
      expect(off.reports).toEqual([])
    })
  })

  it('never throws or rejects, whatever breaks inside the page', async () => {
    const throwing = rig()
    throwing.env.loadScript = () => {
      throw new Error('boom')
    }
    throwing.env.collector = () => undefined
    expect(await start(options, throwing.env)).toEqual({ ok: false, reason: 'collect_error' })

    const reportFails = rig({ script: 'error', healthz: refuse, beacon: false, reportFetch: 'throw' })
    expect((await start(options, reportFails.env)).ok).toBe(false)

    const reportRejects = rig({ script: 'error', healthz: refuse, beacon: false, reportFetch: 'reject' })
    expect((await start(options, reportRejects.env)).ok).toBe(false)
  })

  describe('in a real browser', () => {
    // The test page already has the library loaded, and the loader would not load the script again
    let library: unknown
    beforeEach(() => {
      library = (window as unknown as { FingerprintJS?: unknown }).FingerprintJS
      // A global declared with `var` can be changed but not deleted
      ;(window as unknown as { FingerprintJS?: unknown }).FingerprintJS = undefined
    })
    afterEach(() => {
      ;(window as unknown as { FingerprintJS?: unknown }).FingerprintJS = library
    })

    it('sees a port that nobody listens on as unreachable', async () => {
      const result = await start({
        scriptUrl: 'http://127.0.0.1:9/fp.js',
        endpoint: 'http://127.0.0.1:9',
        publicKey: 'pk_test123',
        reportTo: '/fp-report-test',
        timeoutMs: 3000,
        probeTimeoutMs: 3000,
      })
      expect(result).toEqual({ ok: false, reason: 'script_unreachable' })
    })

    it('sees a script that fails to load from a server that answers as blocked', async () => {
      // The test server answers for this origin, so the probe reaches it, and the script address does not exist
      const result = await start({
        scriptUrl: `${location.origin}/nothing-here-${Date.now()}.js`,
        endpoint: location.origin,
        publicKey: 'pk_test123',
        reportTo: '/fp-report-test',
        timeoutMs: 3000,
        probeTimeoutMs: 3000,
      })
      expect(result).toEqual({ ok: false, reason: 'script_blocked' })
    })
  })
})
