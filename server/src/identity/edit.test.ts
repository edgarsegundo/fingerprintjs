import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergeProfiles, profileOf, withoutObservations } from './edit'
import type { DeviceProfile } from './store'

const profile = (deviceId: string, visits: number, first: number, last: number, canvas: Record<string, number>) =>
  ({
    deviceId,
    visits,
    firstSeen: first,
    lastSeen: last,
    features: new Map([
      ['canvas', new Map(Object.entries(canvas).map(([v, count]) => [v, { count, lastSeen: last }]))],
    ]),
  } as DeviceProfile)

describe('editing profiles', () => {
  it('merges: values of both, counts added, the earliest first seen and the latest last seen', () => {
    const into = profile('a', 3, 10, 50, { x: 2, y: 1 })
    const from = profile('b', 2, 5, 90, { y: 1, z: 1 })
    const merged = mergeProfiles(into, from)
    assert.equal(merged.deviceId, 'a')
    assert.equal(merged.visits, 5)
    assert.equal(merged.firstSeen, 5)
    assert.equal(merged.lastSeen, 90)
    assert.deepEqual(
      [...(merged.features.get('canvas') ?? [])].map(([value, use]) => [value, use.count]),
      [
        ['x', 2],
        ['y', 2],
        ['z', 1],
      ],
    )
  })

  it('does not change what it is given', () => {
    const into = profile('a', 3, 10, 50, { x: 2 })
    const from = profile('b', 2, 5, 90, { x: 1 })
    mergeProfiles(into, from)
    withoutObservations(into, [{ features: { canvas: 'x' }, at: 1 }])
    assert.equal(into.features.get('canvas')?.get('x')?.count, 2)
    assert.equal(from.features.get('canvas')?.get('x')?.count, 1)
    assert.equal(into.visits, 3)
  })

  it('builds a device from visits alone', () => {
    const made = profileOf('n', [
      { features: { canvas: 'x', tz: 'a' }, at: 30 },
      { features: { canvas: 'x' }, at: 10 },
      { features: { canvas: 'y' }, at: 20 },
    ])
    assert.equal(made.visits, 3)
    assert.equal(made.firstSeen, 10)
    assert.equal(made.lastSeen, 30)
    assert.equal(made.features.get('canvas')?.get('x')?.count, 2)
    assert.equal(made.features.get('canvas')?.get('x')?.lastSeen, 30)
    assert.equal(made.features.get('tz')?.get('a')?.count, 1)
  })

  it('takes visits away: a count goes down, a value with none left is forgotten, older learning stays', () => {
    // 5 visits, but only 2 of them are still known: the other 3 taught x and are gone
    const device = profile('a', 5, 1, 50, { x: 4, y: 1 })
    const left = withoutObservations(device, [
      { features: { canvas: 'x' }, at: 40 },
      { features: { canvas: 'y' }, at: 50 },
    ])
    assert.equal(left.visits, 3)
    assert.equal(left.features.get('canvas')?.get('x')?.count, 3)
    assert.equal(left.features.get('canvas')?.has('y'), false)
    assert.equal(left.firstSeen, 1)
    const none = withoutObservations(profile('c', 1, 1, 1, { y: 1 }), [{ features: { canvas: 'y' }, at: 1 }])
    assert.equal(none.features.has('canvas'), false, 'a feature with no value is dropped')
    assert.equal(none.visits, 0)
  })

  it('does not go below zero when asked to take away something the device does not have', () => {
    const left = withoutObservations(profile('a', 1, 1, 1, { x: 1 }), [
      { features: { canvas: 'never', tz: 'none' }, at: 1 },
      { features: { canvas: 'x' }, at: 1 },
      { features: { canvas: 'x' }, at: 1 },
    ])
    assert.equal(left.visits, 0)
    assert.equal(left.features.size, 0)
  })
})
