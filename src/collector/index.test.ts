import { version } from '../../package.json'
import * as FP from '../index'
import { sources } from '../sources'

import { optInSourceNames } from './sources'

import { collect, collectAndSend, extendedSources, PAYLOAD_SCHEMA_VERSION, profileToOptions } from '.'

const defaultExtendedKeys = Object.keys(extendedSources).filter((key) => !optInSourceNames.includes(key))

describe('Collector', () => {
  it('collects every built-in and extended signal', async () => {
    const payload = await collect()

    expect(payload.schema).toBe(PAYLOAD_SCHEMA_VERSION)
    expect(payload.libVersion).toBe(version)
    expect(Object.keys(payload.components)).toEqual(Object.keys(sources))
    expect(Object.keys(payload.extended)).toEqual(defaultExtendedKeys)
    expect('nonce' in payload).toBe(false)
    for (const component of [...Object.values(payload.components), ...Object.values(payload.extended)]) {
      expect(typeof component.duration).toBe('number')
    }
  }, 30000)

  it('makes a payload that survives JSON', async () => {
    const payload = await collect()
    // Values that JSON can't hold (a Map, a function, etc.) would change after the first round trip.
    // `undefined` fields are dropped by design, so the payload itself can't be compared to its copy.
    const json = JSON.stringify(payload)
    expect(JSON.stringify(JSON.parse(json))).toBe(json)
  }, 30000)

  it('contains no visitor identifier', async () => {
    const payload = await collect()
    expect(Object.keys(payload).sort()).toEqual(
      ['collectedAt', 'components', 'durationMs', 'extended', 'libVersion', 'schema'].sort(),
    )
  }, 30000)

  it('echoes the nonce', async () => {
    expect((await collect({ nonce: 'challenge-1' })).nonce).toBe('challenge-1')
  }, 30000)

  it('carries the linkedId and refuses the ones that look like personal data', async () => {
    expect((await collect({ linkedId: 'user_42:phone-1' })).linkedId).toBe('user_42:phone-1')
    expect('linkedId' in (await collect())).toBe(false)
    for (const bad of ['ana@example.com', '', 'with space', 'x'.repeat(129), 'João', null, 5] as unknown as string[]) {
      let error: unknown
      try {
        await collect({ linkedId: bad })
      } catch (caught) {
        error = caught
      }
      expect(error).withContext(JSON.stringify(bad)).toBeInstanceOf(Error)
    }
  }, 30000)

  it('carries the statement of consent as given, and only a well-formed one', async () => {
    const payload = await collect({ consent: { basis: 'consent', version: '2026-10' } })
    expect(payload.consent).toEqual({ basis: 'consent', version: '2026-10' })
    expect('consent' in (await collect())).toBe(false)
    for (const basis of ['legitimate_interest', 'contract', 'other'] as const) {
      expect((await collect({ consent: { basis, version: 'v1' } })).consent?.basis).toBe(basis)
    }
    const bad = [
      { basis: 'whatever', version: 'v1' },
      { basis: 'consent' },
      { basis: 'consent', version: '' },
      { basis: 'consent', version: 'x'.repeat(65) },
      { basis: 'consent', version: 'with space' },
      { version: 'v1' },
      null,
    ]
    for (const consent of bad) {
      let error: unknown
      try {
        await collect({ consent } as never)
      } catch (caught) {
        error = caught
      }
      expect(error).withContext(JSON.stringify(consent)).toBeInstanceOf(Error)
    }
  }, 30000)

  it('skips the excluded signals of both groups', async () => {
    const payload = await collect({ exclude: ['canvas', 'fonts', 'workerContext', 'speechVoices'] })
    expect('canvas' in payload.components).toBe(false)
    expect('fonts' in payload.components).toBe(false)
    expect('screenResolution' in payload.components).toBe(true)
    expect('workerContext' in payload.extended).toBe(false)
    expect('speechVoices' in payload.extended).toBe(false)
    expect('mediaSupport' in payload.extended).toBe(true)
  }, 30000)

  it('leaves the signals with a visible side effect off unless they are requested', async () => {
    expect('webGpu' in (await collect()).extended).toBe(false)
    expect('webGpu' in (await collect({ include: ['webGpu'] })).extended).toBe(true)
    expect('webGpu' in (await collect({ include: ['webGpu'], exclude: ['webGpu'] })).extended).toBe(false)
  }, 30000)

  it('keeps the built-in components identical to the ones of the original agent', async () => {
    const agent = await FP.load({ monitoring: false })
    const legacy = (await agent.get()).components
    const payload = await collect()

    for (const key of Object.keys(legacy) as Array<keyof typeof legacy>) {
      const component = legacy[key]
      const expected = 'error' in component ? undefined : component.value
      expect(JSON.stringify(payload.components[key].value)).withContext(key).toBe(JSON.stringify(expected))
    }
  }, 30000)

  it('sends the collected payload and returns the request id', async () => {
    const fetchMock = jasmine
      .createSpy<typeof fetch>('fetch')
      .and.callFake(async () => new Response(JSON.stringify({ requestId: 'r-42' })))
    const result = await collectAndSend({ endpoint: '/collect', fetch: fetchMock }, { nonce: 'n' })

    expect(result).toEqual({ requestId: 'r-42' })
    const body = JSON.parse(fetchMock.calls.mostRecent().args[1]?.body as string)
    expect(body.schema).toBe(PAYLOAD_SCHEMA_VERSION)
    expect(body.nonce).toBe('n')
  }, 30000)
})

describe('profileToOptions', () => {
  it('takes the signals to leave out and the known opt-in signals to add', () => {
    expect(
      profileToOptions({ exclude: ['fonts', 'speechVoices'], include: ['behavior', 'webGpu'], elevated: true }),
    ).toEqual({
      exclude: ['fonts', 'speechVoices'],
      include: ['behavior', 'webGpu'],
    })
  })

  it('does not let the server ask for a signal that is not an opt-in one', () => {
    expect(profileToOptions({ include: ['canvas', 'workerContext', 'behavior'] })).toEqual({ include: ['behavior'] })
  })

  it('ignores names that are not names of signals, and anything that is not a list', () => {
    expect(profileToOptions({ exclude: ['ok_name', '__proto__x y', '1bad', '', 5, null, 'a'.repeat(65)] })).toEqual({
      exclude: ['ok_name'],
    })
    expect(profileToOptions({ exclude: 'fonts', include: { 0: 'behavior' } })).toEqual({})
  })

  it('takes the life of the stored code as a whole number of days, cut to what a browser keeps', () => {
    expect(profileToOptions({ include: ['storedId'], storedIdMaxAgeDays: 90 })).toEqual({
      include: ['storedId'],
      storedIdMaxAgeDays: 90,
    })
    expect(profileToOptions({ storedIdMaxAgeDays: 100000 })).toEqual({ storedIdMaxAgeDays: 400 })
    expect(profileToOptions({ storedIdMaxAgeDays: -5 })).toEqual({ storedIdMaxAgeDays: 1 })
    for (const bad of ['30', 1.5, null, NaN, {}]) {
      expect(profileToOptions({ storedIdMaxAgeDays: bad }))
        .withContext(String(bad))
        .toEqual({})
    }
  })

  it('gives nothing for a profile that is not an object', () => {
    for (const bad of [undefined, null, 'fonts', 5, [], true]) {
      expect(profileToOptions(bad)).withContext(String(bad)).toEqual({})
    }
  })

  it('cuts a very long list', () => {
    const many = Array.from({ length: 300 }, (_, i) => `signal${i}`)
    expect(profileToOptions({ exclude: many }).exclude?.length).toBe(100)
  })
})
