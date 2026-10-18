import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { CollectPayload, SUPPORTED_SCHEMA, validatePayload } from './validate'

function goodPayload(): CollectPayload {
  return {
    schema: 1,
    libVersion: '5.3.0',
    collectedAt: Date.now(),
    durationMs: 120,
    nonce: 'abc',
    components: {
      canvas: { value: { winding: true }, duration: 5 },
      audio: { error: { name: 'Error', message: 'x' }, duration: 1 },
    },
    extended: { mediaSupport: { duration: 0 } },
  }
}

function problemsOf(mutate: (payload: Record<string, unknown>) => void): string[] {
  const payload = goodPayload() as unknown as Record<string, unknown>
  mutate(payload)
  const result = validatePayload(payload)
  assert.equal(result.ok, false)
  return result.ok ? [] : result.problems
}

describe('validatePayload', () => {
  it('accepts a good payload, including a signal with neither value nor error', () => {
    assert.equal(validatePayload(goodPayload()).ok, true)
  })

  it('accepts a payload without a nonce', () => {
    const payload = goodPayload() as unknown as Record<string, unknown>
    delete payload.nonce
    assert.equal(validatePayload(payload).ok, true)
  })

  it('rejects things that are not objects', () => {
    for (const bad of [null, 5, 'x', [], undefined]) {
      assert.equal(validatePayload(bad).ok, false)
    }
  })

  it('rejects an unknown schema version instead of guessing', () => {
    assert.match(problemsOf((p) => (p.schema = 2))[0], /unsupported schema/)
    assert.match(problemsOf((p) => delete p.schema)[0], /unsupported schema/)
  })

  it('rejects bad envelope fields', () => {
    assert.ok(problemsOf((p) => (p.libVersion = 5)).some((x) => x.includes('libVersion')))
    assert.ok(problemsOf((p) => (p.collectedAt = 'now')).some((x) => x.includes('collectedAt')))
    assert.ok(problemsOf((p) => (p.durationMs = -1)).some((x) => x.includes('durationMs')))
    assert.ok(problemsOf((p) => (p.nonce = 'x'.repeat(300))).some((x) => x.includes('nonce')))
    assert.ok(problemsOf((p) => (p.nonce = 5)).some((x) => x.includes('nonce')))
  })

  it('accepts an opaque linkedId and refuses anything that looks like personal data', () => {
    const withId = (linkedId: unknown) => ({ ...goodPayload(), linkedId })
    assert.equal(validatePayload(withId('user_42:phone-1.a')).ok, true)
    for (const bad of ['ana@example.com', '', 'a b', 'x'.repeat(129), 5, null, 'João', '+5511999990000']) {
      assert.equal(validatePayload(withId(bad)).ok, false, JSON.stringify(bad))
    }
  })

  it('rejects names that could pollute a prototype, even though JSON.parse creates them as own keys', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const payload = JSON.parse(
        '{"schema":1,"libVersion":"1","collectedAt":1,"durationMs":1,' +
          `"components":{"${name}":{"duration":1}},"extended":{}}`,
      )
      const result = validatePayload(payload)
      assert.equal(result.ok, false, name)
    }
  })

  it('rejects odd signal names, odd fields and non-object signals', () => {
    assert.ok(
      problemsOf((p) => ((p.components as Record<string, unknown>)['bad name!'] = { duration: 1 })).some((x) =>
        x.includes('invalid signal name'),
      ),
    )
    assert.ok(
      problemsOf((p) => ((p.components as Record<string, unknown>).canvas = { duration: 1, extra: 1 })).some((x) =>
        x.includes('unknown field'),
      ),
    )
    assert.ok(
      problemsOf((p) => ((p.components as Record<string, unknown>).canvas = 7)).some((x) =>
        x.includes('must be an object'),
      ),
    )
  })

  it('rejects a bad duration, and a signal with both value and error', () => {
    assert.ok(
      problemsOf((p) => ((p.components as Record<string, unknown>).canvas = { duration: 'slow' })).some((x) =>
        x.includes('duration'),
      ),
    )
    assert.ok(
      problemsOf(
        (p) =>
          ((p.components as Record<string, unknown>).canvas = {
            duration: 1,
            value: 1,
            error: { name: 'a', message: 'b' },
          }),
      ).some((x) => x.includes('both')),
    )
  })

  it('limits the number of signals and the size of errors', () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`s${i}`, { duration: 1 }]))
    assert.ok(problemsOf((p) => (p.extended = many)).some((x) => x.includes('more than')))
    assert.ok(
      problemsOf(
        (p) =>
          ((p.components as Record<string, unknown>).audio = {
            duration: 1,
            error: { name: 'E', message: 'x'.repeat(300) },
          }),
      ).some((x) => x.includes('too long')),
    )
  })

  it('reports at most 20 problems', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, 5]))
    assert.ok(problemsOf((p) => (p.extended = many)).length <= 20)
  })

  it('stays in step with the schema version of the browser library', () => {
    // dist/ingest -> dist -> server -> repository root
    const source = readFileSync(path.resolve(__dirname, '../../../src/collector/payload.ts'), 'utf8')
    const match = /PAYLOAD_SCHEMA_VERSION = (\d+)/.exec(source)
    assert.ok(match, 'the constant must exist in the browser library')
    assert.equal(Number(match[1]), SUPPORTED_SCHEMA)
  })
})
