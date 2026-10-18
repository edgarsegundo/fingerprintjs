import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { StoredEvent } from '../store/types'

import { checkTamper } from './checks'

const macUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/155.0.0.0 Safari/537.36'

const snapshot = () => ({
  userAgent: macUserAgent,
  platform: 'MacIntel',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  language: 'pt-BR',
  languages: ['pt-BR', 'pt'],
  timezone: 'America/Sao_Paulo',
  locale: 'pt-BR',
  uaData: { brands: ['Google Chrome/155', 'Chromium/155'], mobile: false, platform: 'macOS' },
})

const signal = (value: unknown) => ({ value, duration: 1 })

/** A visit from an ordinary Chrome on a Mac, with every view agreeing */
function cleanEvent(): StoredEvent {
  return {
    requestId: 'r1',
    tenantId: 't1',
    receivedAt: 1000,
    network: {
      ip: '203.0.113.9',
      ipVersion: 4,
      ipPrefix: '203.0.113.0/24',
      ipSource: 'socket',
      ipIntel: { tags: [] },
      viaProxy: false,
      httpVersion: '2.0',
      headers: {
        order: [],
        casing: '',
        fp: 'x',
        values: {
          'user-agent': macUserAgent,
          'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
          'sec-ch-ua-platform': '"macOS"',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      },
    },
    payload: {
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: 1000,
      durationMs: 5,
      components: {
        platform: signal('MacIntel'),
        hardwareConcurrency: signal(8),
        deviceMemory: signal(8),
        screenResolution: signal([1440, 900]),
        timezone: signal('America/Sao_Paulo'),
        languages: signal([['pt-BR'], ['pt-BR', 'pt']]),
        userAgentData: signal({
          brands: ['Google Chrome'],
          mobile: false,
          platform: 'macOS',
          platformVersion: '15.0.0',
        }),
        webGlBasics: signal({ rendererUnmasked: 'ANGLE (Apple M1)', vendorUnmasked: 'Apple' }),
      },
      extended: {
        workerContext: signal({
          page: snapshot(),
          worker: { ...snapshot(), webgl: { unmaskedRenderer: 'ANGLE (Apple M1)' } },
        }),
        nativeIntegrity: signal({ nonNative: [], missing: [], navigatorOwnProperties: [], screenOwnProperties: [] }),
        automationHints: signal({
          webdriver: false,
          globals: [],
          documentAttributes: [],
          hasChromeDriverKeys: false,
          outerSize: [1440, 800],
        }),
        notificationPermission: signal({ api: 'default', query: 'prompt' }),
      },
    },
    derived: { clockSkewMs: 120, nonceContext: 'match' },
  }
}

/** Applies a change to a clean visit and returns the ids of what was found */
function found(change: (event: StoredEvent) => void): string[] {
  const event = cleanEvent()
  change(event)
  return checkTamper(event).signals.map((item) => item.id)
}

const workerOf = (event: StoredEvent) =>
  (event.payload.extended.workerContext.value as { worker: Record<string, unknown>; page: Record<string, unknown> })
    .worker
const pageOf = (event: StoredEvent) =>
  (event.payload.extended.workerContext.value as { worker: Record<string, unknown>; page: Record<string, unknown> })
    .page

describe('checkTamper on an honest visit', () => {
  it('finds nothing', () => {
    assert.deepEqual(checkTamper(cleanEvent()), { signals: [], counts: { high: 0, medium: 0, low: 0 } })
  })
})

describe('user agent', () => {
  it('flags a header that differs from what the page says', () => {
    assert.deepEqual(
      found((e) => (e.network.headers.values['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0) Chrome/155')).filter(
        (id) => id === 'user_agent_inconsistent',
      ),
      ['user_agent_inconsistent'],
    )
  })

  it('flags a worker that differs from the page, which is what a tool that patches only the page leaves behind', () => {
    assert.ok(
      found((e) => (workerOf(e).userAgent = 'Mozilla/5.0 (X11; Linux x86_64)')).includes('user_agent_inconsistent'),
    )
  })

  it('has nothing to compare when only one view exists', () => {
    assert.ok(
      !found((e) => {
        delete e.network.headers.values['user-agent']
        e.payload.extended.workerContext = signal({ page: snapshot(), worker: { unavailable: 'Error' } })
      }).includes('user_agent_inconsistent'),
    )
  })
})

describe('platform', () => {
  it('flags a Windows claim on a Mac in any of the places', () => {
    assert.ok(found((e) => (e.payload.components.platform = signal('Win32'))).includes('platform_inconsistent'))
    assert.ok(
      found((e) => (e.network.headers.values['sec-ch-ua-platform'] = '"Windows"')).includes('platform_inconsistent'),
    )
    assert.ok(found((e) => (workerOf(e).platform = 'Win32')).includes('platform_inconsistent'))
    assert.ok(
      found(
        (e) => (e.payload.components.userAgentData = signal({ brands: ['Google Chrome'], platform: 'Android' })),
      ).includes('platform_inconsistent'),
    )
  })

  it('says which two sources disagree', () => {
    const event = cleanEvent()
    event.payload.components.platform = signal('Win32')
    const detail = checkTamper(event).signals.find((item) => item.id === 'platform_inconsistent')?.detail ?? ''
    assert.match(detail, /navigator\.platform says windows/)
  })

  it('accepts an Android phone, which says Linux as the platform', () => {
    const android = (e: StoredEvent) => {
      const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36'
      e.network.headers.values['user-agent'] = ua
      e.network.headers.values['sec-ch-ua-platform'] = '"Android"'
      e.payload.components.platform = signal('Linux armv8l')
      e.payload.components.userAgentData = signal({ brands: ['Google Chrome'], mobile: true, platform: 'Android' })
      e.payload.extended.workerContext = signal({
        page: { ...snapshot(), userAgent: ua, platform: 'Linux armv8l' },
        worker: { ...snapshot(), userAgent: ua, platform: 'Linux armv8l' },
      })
    }
    assert.deepEqual(
      found(android).filter((id) => id.includes('platform') || id.includes('user_agent')),
      [],
    )
  })

  it('accepts an iPad that presents itself as a Mac', () => {
    assert.ok(!found((e) => (e.payload.components.platform = signal('iPad'))).includes('platform_inconsistent'))
  })

  it('ignores a platform it cannot read', () => {
    assert.ok(!found((e) => (e.payload.components.platform = signal('Plan9'))).includes('platform_inconsistent'))
  })
})

describe('page and worker', () => {
  it('flags a different number of cores as high and a different language as medium', () => {
    const cores = checkTamper(Object.assign(cleanEvent(), {}))
    assert.equal(cores.signals.length, 0)
    const event = cleanEvent()
    workerOf(event).hardwareConcurrency = 4
    assert.deepEqual(
      checkTamper(event).signals.map((item) => [item.id, item.severity]),
      [['worker_page_mismatch', 'high']],
    )
    const language = cleanEvent()
    workerOf(language).language = 'en-US'
    assert.deepEqual(
      checkTamper(language).signals.map((item) => [item.id, item.severity]),
      [['worker_page_mismatch', 'medium']],
    )
  })

  it('lists the fields that differ', () => {
    const event = cleanEvent()
    workerOf(event).deviceMemory = 4
    workerOf(event).timezone = 'Asia/Tokyo'
    const detail = checkTamper(event).signals.find((item) => item.id === 'worker_page_mismatch')?.detail ?? ''
    assert.ok(detail.includes('deviceMemory') && detail.includes('timezone'))
  })

  it('does nothing when the worker could not run (a content security policy is a normal reason)', () => {
    assert.deepEqual(
      found(
        (e) =>
          (e.payload.extended.workerContext = signal({ page: snapshot(), worker: { unavailable: 'SecurityError' } })),
      ),
      [],
    )
    assert.deepEqual(
      found((e) => delete e.payload.extended.workerContext),
      [],
    )
  })

  it('flags a different GPU in the worker, and ignores one that is empty', () => {
    assert.ok(
      found((e) => ((workerOf(e).webgl as Record<string, unknown>).unmaskedRenderer = 'NVIDIA RTX')).includes(
        'webgl_worker_mismatch',
      ),
    )
    assert.ok(
      !found((e) => ((workerOf(e).webgl as Record<string, unknown>).unmaskedRenderer = '')).includes(
        'webgl_worker_mismatch',
      ),
    )
    assert.ok(!found((e) => ((workerOf(e).webgl as unknown) = null)).includes('webgl_worker_mismatch'))
  })

  void pageOf
})

describe('GPU against platform', () => {
  const claim = (e: StoredEvent, userAgent: string, renderer: string) => {
    e.network.headers.values['user-agent'] = userAgent
    e.payload.components.webGlBasics = signal({ rendererUnmasked: renderer, renderer: 'x' })
  }
  const windowsUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36'

  it('flags a Metal GPU under a Windows user agent, and a Direct3D GPU under a Mac one', () => {
    assert.ok(
      found((e) =>
        claim(e, windowsUserAgent, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'),
      ).includes('gpu_platform_inconsistent'),
    )
    assert.ok(
      found((e) => claim(e, macUserAgent, 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)')).includes(
        'gpu_platform_inconsistent',
      ),
    )
  })

  it('accepts a GPU that fits the system', () => {
    const ids = (userAgent: string, renderer: string) =>
      found((e) => claim(e, userAgent, renderer)).filter((id) => id === 'gpu_platform_inconsistent')
    assert.deepEqual(ids(macUserAgent, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'), [])
    assert.deepEqual(ids(windowsUserAgent, 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)'), [])
    assert.deepEqual(ids(windowsUserAgent, 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)'), [])
    assert.deepEqual(ids('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari', 'Apple GPU'), [])
  })

  it('does not accuse on the names that run on several systems', () => {
    for (const renderer of [
      'Mesa Intel(R) UHD Graphics',
      'Adreno (TM) 740',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))',
      '',
    ]) {
      assert.ok(!found((e) => claim(e, windowsUserAgent, renderer)).includes('gpu_platform_inconsistent'), renderer)
    }
  })
})

describe('client hints and languages', () => {
  it('flags brands that differ between the header and the script', () => {
    assert.ok(
      found(
        (e) =>
          (e.network.headers.values['sec-ch-ua'] = '"Microsoft Edge";v="155", "Chromium";v="155", "Not.A/Brand";v="8"'),
      ).includes('client_hints_brands_mismatch'),
    )
  })

  it('ignores the decoy brand, whatever its spelling, and the Chromium brand', () => {
    for (const decoy of [
      '"Not(A:Brand";v="24"',
      '"Not A(Brand";v="99"',
      '"Not.A/Brand";v="8"',
      '"Not;A=Brand";v="99"',
    ]) {
      assert.ok(
        !found(
          (e) => (e.network.headers.values['sec-ch-ua'] = `"Chromium";v="155", "Google Chrome";v="155", ${decoy}`),
        ).includes('client_hints_brands_mismatch'),
        decoy,
      )
    }
  })

  it('flags a language that differs in the header and the page, but not a regional variant', () => {
    assert.ok(
      found((e) => (e.network.headers.values['accept-language'] = 'en-US,en;q=0.9')).includes(
        'language_header_mismatch',
      ),
    )
    assert.ok(
      !found((e) => (e.network.headers.values['accept-language'] = 'pt-PT,pt;q=0.9')).includes(
        'language_header_mismatch',
      ),
    )
    assert.ok(!found((e) => delete e.network.headers.values['accept-language']).includes('language_header_mismatch'))
  })
})

describe('integrity and automation', () => {
  it('flags replaced native functions as medium, since extensions do that too', () => {
    const event = cleanEvent()
    ;(event.payload.extended.nativeIntegrity.value as Record<string, unknown>).nonNative = [
      'Navigator.prototype.platform',
    ]
    assert.deepEqual(
      checkTamper(event).signals.map((item) => [item.id, item.severity]),
      [['native_functions_modified', 'medium']],
    )
  })

  it('flags values set straight on navigator or screen as high', () => {
    const event = cleanEvent()
    ;(event.payload.extended.nativeIntegrity.value as Record<string, unknown>).navigatorOwnProperties = ['userAgent']
    const result = checkTamper(event)
    assert.deepEqual(
      result.signals.map((item) => [item.id, item.severity]),
      [['navigator_overridden_on_instance', 'high']],
    )
    assert.match(result.signals[0].detail, /navigator\.userAgent/)
  })

  it('flags each automation trace', () => {
    for (const change of [
      { webdriver: true },
      { globals: ['_phantom'] },
      { documentAttributes: ['selenium'] },
      { hasChromeDriverKeys: true },
    ]) {
      const event = cleanEvent()
      Object.assign(event.payload.extended.automationHints.value as object, change)
      assert.deepEqual(
        checkTamper(event).signals.map((item) => [item.id, item.severity]),
        [['automation_markers', 'high']],
        JSON.stringify(change),
      )
    }
  })

  it('flags a headless user agent', () => {
    assert.deepEqual(
      found((e) => {
        e.network.headers.values['user-agent'] = macUserAgent.replace('Chrome/', 'HeadlessChrome/')
      }).filter((id) => id === 'headless_user_agent'),
      ['headless_user_agent'],
    )
  })

  it('flags the old headless tell in the notification permission, as the weakest evidence', () => {
    const event = cleanEvent()
    event.payload.extended.notificationPermission = signal({ api: 'denied', query: 'prompt' })
    assert.deepEqual(
      checkTamper(event).signals.map((item) => [item.id, item.severity]),
      [['notification_permission_inconsistent', 'low']],
    )
  })
})

describe('impossible values', () => {
  it('flags values that no browser reports', () => {
    for (const change of [
      (e: StoredEvent) => (e.payload.components.hardwareConcurrency = signal(0)),
      (e: StoredEvent) => (e.payload.components.hardwareConcurrency = signal(1.5)),
      (e: StoredEvent) => (e.payload.components.deviceMemory = signal(3)),
      (e: StoredEvent) => (e.payload.components.screenResolution = signal([0, 0])),
      (e: StoredEvent) => (e.payload.components.timezone = signal('Mars/Phobos')),
      (e: StoredEvent) => (e.payload.components.languages = signal([])),
    ]) {
      assert.deepEqual(found(change), ['impossible_values'], String(change))
    }
  })

  it('accepts what real browsers do report', () => {
    assert.deepEqual(
      found((e) => (e.payload.components.deviceMemory = signal(0.5))),
      [],
    )
    assert.deepEqual(
      found((e) => (e.payload.components.deviceMemory = signal(16))),
      [],
      'Chrome 155 reports 16',
    )
    assert.deepEqual(
      found((e) => (e.payload.components.hardwareConcurrency = signal(64))),
      [],
    )
    assert.deepEqual(
      found((e) => (e.payload.components.timezone = signal('UTC+180'))),
      [],
      'the fallback of the library when Intl is missing',
    )
    assert.deepEqual(
      found((e) => (e.payload.components.timezone = signal('Etc/GMT+3'))),
      [],
    )
  })
})

describe('time and challenge', () => {
  it('flags a clock that is minutes off, in either direction', () => {
    for (const skew of [301_000, -301_000, 86_400_000]) {
      assert.deepEqual(
        found((e) => (e.derived.clockSkewMs = skew)),
        ['clock_skew'],
        String(skew),
      )
    }
    assert.deepEqual(
      found((e) => (e.derived.clockSkewMs = 4 * 60 * 1000)),
      [],
    )
  })

  it('flags a challenge that was fetched by a different client, and only when that was observed', () => {
    assert.deepEqual(
      found((e) => (e.derived.nonceContext = 'mismatch')),
      ['nonce_context_mismatch'],
    )
    assert.deepEqual(
      found((e) => (e.derived.nonceContext = 'none')),
      [],
    )
    assert.deepEqual(
      found((e) => delete e.derived.nonceContext),
      [],
      'events from before this check existed',
    )
  })
})

describe('report', () => {
  it('orders the findings by severity and counts them', () => {
    const event = cleanEvent()
    event.derived.clockSkewMs = 999_999
    event.payload.components.platform = signal('Win32')
    ;(event.payload.extended.nativeIntegrity.value as Record<string, unknown>).nonNative = ['x']
    const report = checkTamper(event)
    assert.deepEqual(
      report.signals.map((item) => item.severity),
      ['high', 'medium', 'low'],
    )
    assert.deepEqual(report.counts, { high: 1, medium: 1, low: 1 })
  })

  it('survives a payload that is garbage, since it comes from the client, and finds nothing in it', () => {
    const event = cleanEvent()
    event.payload.components = {
      platform: signal({ not: 'a string' }),
      userAgentData: signal('text'),
      hardwareConcurrency: signal(null),
      timezone: signal(12),
      languages: signal({ a: 1 }),
      screenResolution: signal('wide'),
    }
    event.payload.extended = {
      workerContext: signal('nope'),
      nativeIntegrity: signal([1, 2]),
      automationHints: signal(5),
      notificationPermission: signal(null),
    }
    event.network.headers.values = { 'sec-ch-ua': '\u0000"""', 'accept-language': '', 'user-agent': '' }
    assert.doesNotThrow(() => checkTamper(event))
    assert.deepEqual(checkTamper(event).signals, [])
  })

  it('keeps the other findings when one check blows up on something strange', () => {
    const event = cleanEvent()
    event.derived.clockSkewMs = 999_999
    // Reading this header throws, which makes the client-hints check fail
    event.network.headers.values = new Proxy(event.network.headers.values, {
      get(target, name) {
        if (name === 'sec-ch-ua') {
          throw new Error('unreadable')
        }
        return Reflect.get(target, name)
      },
    })
    assert.deepEqual(
      checkTamper(event).signals.map((item) => item.id),
      ['clock_skew'],
    )
  })

  it('does not depend on whether the event came from memory or from the database', () => {
    const event = cleanEvent()
    event.payload.components.platform = signal('Win32')
    assert.deepEqual(checkTamper(JSON.parse(JSON.stringify(event))), checkTamper(event))
  })
})
