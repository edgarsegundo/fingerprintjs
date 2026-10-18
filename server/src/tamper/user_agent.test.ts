import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { platformFromHint, platformFromNavigator, platformFromUserAgent, platformsAgree } from './user_agent'

describe('platformFromUserAgent', () => {
  it('reads the operating system of real user agents', () => {
    const webkit = 'AppleWebKit/537.36 (KHTML, like Gecko)'
    const chrome = 'Chrome/155.0.0.0 Safari/537.36'
    const cases: Array<[string, string | undefined]> = [
      [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${webkit} ${chrome}`, 'windows'],
      [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${webkit} ${chrome}`, 'macos'],
      [`Mozilla/5.0 (X11; Linux x86_64) ${webkit} ${chrome}`, 'linux'],
      [`Mozilla/5.0 (Linux; Android 14; Pixel 8) ${webkit} Chrome/155.0.0.0 Mobile Safari/537.36`, 'android'],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
          'Version/18.0 Mobile/15E148 Safari/604.1',
        'ios',
      ],
      [`Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${webkit} ${chrome}`, 'chromeos'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0', 'macos'],
      ['curl/8.4.0', undefined],
      ['', undefined],
    ]
    for (const [userAgent, expected] of cases) {
      assert.equal(platformFromUserAgent(userAgent), expected, userAgent.slice(0, 50))
    }
  })
})

describe('platformFromNavigator and platformFromHint', () => {
  it('reads navigator.platform', () => {
    const cases: Array<[string, string | undefined]> = [
      ['Win32', 'windows'],
      ['MacIntel', 'macos'],
      ['Linux x86_64', 'linux'],
      ['Linux armv8l', 'linux'],
      ['iPhone', 'ios'],
      ['iPad', 'ios'],
      ['CrOS', 'chromeos'],
      ['', undefined],
      ['Something', undefined],
    ]
    for (const [platform, expected] of cases) {
      assert.equal(platformFromNavigator(platform), expected, platform)
    }
  })

  it('reads the client hint, with or without quotes', () => {
    for (const [hint, expected] of [
      ['"macOS"', 'macos'],
      ['Windows', 'windows'],
      ['"Android"', 'android'],
      ['"Chrome OS"', 'chromeos'],
      ['"Linux"', 'linux'],
      ['iOS', 'ios'],
      ['"Plan 9"', undefined],
    ] as const) {
      assert.equal(platformFromHint(hint), expected, hint)
    }
  })
})

describe('platformsAgree', () => {
  it('accepts the cases that are legitimately described two ways', () => {
    assert.ok(platformsAgree('android', 'linux'), 'Android reports Linux as the platform')
    assert.ok(platformsAgree('chromeos', 'linux'))
    assert.ok(platformsAgree('ios', 'macos'), 'an iPad can present itself as a Mac')
    assert.ok(platformsAgree('windows', 'windows'))
  })

  it('refuses real contradictions', () => {
    for (const [a, b] of [
      ['windows', 'macos'],
      ['windows', 'linux'],
      ['windows', 'android'],
      ['macos', 'linux'],
      ['macos', 'android'],
      ['ios', 'windows'],
      ['ios', 'android'],
    ] as const) {
      assert.ok(!platformsAgree(a, b) && !platformsAgree(b, a), `${a} / ${b}`)
    }
  })
})
