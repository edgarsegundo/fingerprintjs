import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RateLimiter } from './ratelimit'

describe('RateLimiter', () => {
  it('allows the limit and then refuses, telling how long to wait', () => {
    const now = 0
    const limiter = new RateLimiter(3, 60_000, () => now)
    assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a')], [0, 0, 0])
    const wait = limiter.take('a')
    assert.ok(wait > 0 && wait <= 20, `wait was ${wait}`)
  })

  it('refills over time', () => {
    let now = 0
    const limiter = new RateLimiter(60, 60_000, () => now)
    for (let i = 0; i < 60; i++) {
      limiter.take('a')
    }
    assert.ok(limiter.take('a') > 0)
    now += 2000 // two seconds give two tokens at 60 per minute
    assert.equal(limiter.take('a'), 0)
    assert.equal(limiter.take('a'), 0)
    assert.ok(limiter.take('a') > 0)
  })

  it('counts each key on its own', () => {
    const limiter = new RateLimiter(1, 60_000, () => 0)
    assert.equal(limiter.take('a'), 0)
    assert.ok(limiter.take('a') > 0)
    assert.equal(limiter.take('b'), 0)
  })

  it('never lets the memory grow without bound', () => {
    const limiter = new RateLimiter(1, 60_000, () => 0, 100)
    for (let i = 0; i < 1000; i++) {
      limiter.take(`key${i}`)
    }
    assert.ok((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size <= 100)
  })
})
