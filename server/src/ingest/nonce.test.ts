import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { issueNonce, nonceFingerprint, verifyNonce } from './nonce'

const secret = 'test-secret-with-at-least-32-characters!!'
const now = 1_700_000_000_000
const expiry = Math.floor(now / 1000) * 1000 + 300_000

describe('nonce', () => {
  it('verifies a fresh nonce for the tenant it was issued to', () => {
    const token = issueNonce(secret, 't1', now, 300)
    assert.deepEqual(verifyNonce(secret, 't1', token, now + 1000), { ok: true, expiresAt: expiry, context: 'none' })
  })

  it('issues a different token every time', () => {
    assert.notEqual(issueNonce(secret, 't1', now, 300), issueNonce(secret, 't1', now, 300))
    assert.notEqual(nonceFingerprint('a'), nonceFingerprint('b'))
  })

  it('expires', () => {
    const token = issueNonce(secret, 't1', now, 300)
    assert.equal(verifyNonce(secret, 't1', token, now + 299_000).ok, true)
    assert.deepEqual(verifyNonce(secret, 't1', token, now + 301_000), { ok: false, reason: 'expired' })
  })

  it('is worthless for another tenant or with another secret', () => {
    const token = issueNonce(secret, 't1', now, 300)
    assert.deepEqual(verifyNonce(secret, 't2', token, now), { ok: false, reason: 'signature' })
    assert.deepEqual(verifyNonce('another-secret-another-secret-32chars', 't1', token, now), {
      ok: false,
      reason: 'signature',
    })
  })

  it('detects tampering with the expiry, the random part, the context tag or the signature', () => {
    const [v, expires, random, tag, mac] = issueNonce(secret, 't1', now, 300, 'net|tls|ua').split('.')
    const forged = [
      [v, String(Number(expires) + 100000), random, tag, mac],
      [v, expires, 'AAAAAAAAAAAAAAAA', tag, mac],
      [v, expires, random, 'AAAAAAAA', mac],
      [v, expires, random, tag, 'A'.repeat(22)],
    ].map((parts) => parts.join('.'))
    for (const token of forged) {
      assert.deepEqual(verifyNonce(secret, 't1', token, now), { ok: false, reason: 'signature' })
    }
  })

  it('rejects garbage without throwing, and the old format', () => {
    for (const bad of [
      '',
      'x',
      'n2.1.2.3',
      'n1.1.AAAAAAAAAAAAAAAA.x',
      'n2.abc.AAAAAAAAAAAAAAAA.________.x',
      'a.b.c.d.e.f',
      'n2.1.AAAA.________.x',
    ]) {
      assert.deepEqual(verifyNonce(secret, 't1', bad, now), { ok: false, reason: 'format' }, bad)
    }
  })
})

describe('the context of a nonce', () => {
  const context = '203.0.113.0/24|8daaf6152771|Mozilla/5.0 Chrome/155'

  it('matches when the same client uses it', () => {
    const token = issueNonce(secret, 't1', now, 300, context)
    assert.deepEqual(verifyNonce(secret, 't1', token, now, context), { ok: true, expiresAt: expiry, context: 'match' })
  })

  it('reports a mismatch, and still accepts the nonce, when another client uses it', () => {
    const token = issueNonce(secret, 't1', now, 300, context)
    for (const other of [
      '198.51.100.0/24|8daaf6152771|Mozilla/5.0 Chrome/155',
      '203.0.113.0/24|other|Mozilla/5.0 Chrome/155',
      '203.0.113.0/24|8daaf6152771|curl/8',
    ]) {
      assert.deepEqual(
        verifyNonce(secret, 't1', token, now, other),
        { ok: true, expiresAt: expiry, context: 'mismatch' },
        other,
      )
    }
  })

  it('has nothing to compare when the nonce was issued without one, or is checked without one', () => {
    const without = verifyNonce(secret, 't1', issueNonce(secret, 't1', now, 300), now, context)
    assert.equal(without.ok && without.context, 'none')
    const unchecked = verifyNonce(secret, 't1', issueNonce(secret, 't1', now, 300, context), now)
    assert.equal(unchecked.ok && unchecked.context, 'none')
  })

  it('does not reveal the context in the token, and ties the tag to the tenant', () => {
    const token = issueNonce(secret, 't1', now, 300, context)
    assert.ok(!token.includes('203.0.113') && !token.includes('Chrome'))
    const sameContextOtherTenant = issueNonce(secret, 't2', now, 300, context)
    assert.notEqual(token.split('.')[3], sameContextOtherTenant.split('.')[3])
  })
})
