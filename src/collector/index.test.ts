import { version } from '../../package.json'
import * as FP from '../index'
import { sources } from '../sources'

import { optInSourceNames } from './sources'

import { collect, collectAndSend, extendedSources, PAYLOAD_SCHEMA_VERSION } from '.'

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
