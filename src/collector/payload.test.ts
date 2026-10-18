import { version } from '../../package.json'

import { makePayload, PAYLOAD_SCHEMA_VERSION, serializeComponents } from './payload'

describe('Collector payload', () => {
  describe('serializeComponents', () => {
    it('keeps values and durations', () => {
      const result = serializeComponents({ a: { value: { x: [1, 'two'] }, duration: 5 } })
      expect(result).toEqual({ a: { value: { x: [1, 'two'] }, duration: 5 } })
    })

    it('marks an undefined value by the absence of both value and error', () => {
      const result = serializeComponents({ a: { value: undefined, duration: 1 } })
      expect(result.a).toEqual({ duration: 1 })
      expect('value' in result.a).toBe(false)
      expect('error' in result.a).toBe(false)
    })

    it('sends only the name and the message of an error, never the stack', () => {
      const error = new TypeError('boom')
      const result = serializeComponents({ a: { error, duration: 2 } })
      expect(result.a).toEqual({ error: { name: 'TypeError', message: 'boom' }, duration: 2 })
      expect(JSON.stringify(result)).not.toContain('stack')
    })

    it('handles errors that are not Error objects and long messages', () => {
      const result = serializeComponents({
        a: { error: 'plain text', duration: 0 },
        b: { error: new Error('x'.repeat(1000)), duration: 0 },
      })
      expect(result.a.error).toEqual({ name: 'Error', message: 'plain text' })
      expect(result.b.error?.message.length).toBe(200)
    })

    it('produces a JSON-serializable result', () => {
      const result = serializeComponents({ a: { value: 1, duration: 0 }, b: { error: new Error('e'), duration: 0 } })
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    })
  })

  describe('makePayload', () => {
    it('fills the envelope', () => {
      const startedAt = Date.now() - 100
      const payload = makePayload({ components: {}, extended: {} }, startedAt)
      expect(payload.schema).toBe(PAYLOAD_SCHEMA_VERSION)
      expect(payload.libVersion).toBe(version)
      expect(payload.collectedAt).toBe(startedAt)
      expect(payload.durationMs).toBeGreaterThanOrEqual(100)
    })

    it('includes the nonce only when it is given', () => {
      expect('nonce' in makePayload({ components: {}, extended: {} }, Date.now())).toBe(false)
      expect(makePayload({ components: {}, extended: {}, nonce: 'n1' }, Date.now()).nonce).toBe('n1')
    })
  })
})
