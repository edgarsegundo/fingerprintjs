import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { authenticateSecret, findTenantByPublicKey, parseConfig, sha256Hex } from './config'

const secret = 'sk_the_secret_key_of_tenant_one'

function raw(): Record<string, unknown> {
  return {
    nonceSecret: 'n'.repeat(32),
    tenants: [
      { id: 't1', publicKey: 'pk_0123456789abcdef0123', secretKeySha256: [sha256Hex(secret)] },
      {
        id: 't2',
        publicKey: 'pk_fedcba9876543210fedc',
        secretKeySha256: [sha256Hex('other')],
        allowedOrigins: ['https://a.example'],
      },
    ],
  }
}

describe('parseConfig', () => {
  it('fills the defaults', () => {
    const config = parseConfig(raw())
    assert.equal(config.listen.host, '127.0.0.1')
    assert.equal(config.nonceTtlSeconds, 300)
    assert.equal(config.requireNonce, true)
    assert.equal(config.retentionDays, 30)
    assert.equal(config.clientIpHeader, 'x-forwarded-for')
    assert.deepEqual(config.tenants[0].allowedOrigins, [])
    assert.equal(config.databasePath, ':memory:')
  })

  it('refuses to start with a weak or missing nonce secret', () => {
    assert.throws(() => parseConfig({ ...raw(), nonceSecret: 'short' }), /nonceSecret/)
    assert.throws(() => parseConfig({ ...raw(), nonceSecret: undefined }), /nonceSecret/)
  })

  it('refuses bad tenants', () => {
    assert.throws(() => parseConfig({ ...raw(), tenants: [] }), /tenants/)
    assert.throws(
      () =>
        parseConfig({
          ...raw(),
          tenants: [{ id: 'bad id', publicKey: 'pk_0123456789abcdef0123', secretKeySha256: [sha256Hex('x')] }],
        }),
      /id/,
    )
    assert.throws(
      () => parseConfig({ ...raw(), tenants: [{ id: 'a', publicKey: 'nope', secretKeySha256: [sha256Hex('x')] }] }),
      /publicKey/,
    )
    assert.throws(
      () =>
        parseConfig({
          ...raw(),
          tenants: [{ id: 'a', publicKey: 'pk_0123456789abcdef0123', secretKeySha256: ['plaintext-secret'] }],
        }),
      /SHA-256/,
    )
  })

  it('refuses duplicated tenants', () => {
    const config = raw()
    const [first] = config.tenants as Array<Record<string, unknown>>
    config.tenants = [first, { ...first, publicKey: 'pk_aaaaaaaaaaaaaaaaaaaaaa' }]
    assert.throws(() => parseConfig(config), /unique/)
  })

  it('refuses a safety switch that is not a real boolean instead of treating it as off', () => {
    for (const bad of ['false', 'no', 0, null, 'true']) {
      assert.throws(() => parseConfig({ ...raw(), requireNonce: bad }), /requireNonce/, String(bad))
    }
    assert.equal(parseConfig({ ...raw(), requireNonce: false }).requireNonce, false)
    assert.equal(parseConfig({ ...raw(), requireNonce: true }).requireNonce, true)
  })

  it('refuses invalid numbers', () => {
    assert.throws(() => parseConfig({ ...raw(), retentionDays: 0 }), /retentionDays/)
    assert.throws(() => parseConfig({ ...raw(), maxBodyBytes: 'big' }), /maxBodyBytes/)
  })
})

describe('tenant lookup', () => {
  const config = parseConfig(raw())

  it('finds a tenant by public key', () => {
    assert.equal(findTenantByPublicKey(config, 'pk_fedcba9876543210fedc')?.id, 't2')
    assert.equal(findTenantByPublicKey(config, 'pk_unknown'), undefined)
    assert.equal(findTenantByPublicKey(config, null), undefined)
  })

  it('finds the tenant of a secret key and rejects wrong ones', () => {
    assert.equal(authenticateSecret(config, secret)?.id, 't1')
    assert.equal(authenticateSecret(config, 'other')?.id, 't2')
    assert.equal(authenticateSecret(config, 'wrong'), undefined)
    assert.equal(authenticateSecret(config, ''), undefined)
  })
})
