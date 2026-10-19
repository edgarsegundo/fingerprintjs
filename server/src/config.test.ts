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

describe('the database in the configuration', () => {
  it('is SQLite by default, in memory, and the old field still names the file', () => {
    assert.deepEqual(parseConfig(raw()).database, { type: 'sqlite', path: ':memory:' })
    assert.deepEqual(parseConfig({ ...raw(), databasePath: '/data/events.db' }).database, {
      type: 'sqlite',
      path: '/data/events.db',
    })
    assert.deepEqual(parseConfig({ ...raw(), database: { type: 'sqlite', path: 'x.db' } }).database, {
      type: 'sqlite',
      path: 'x.db',
    })
    assert.equal(parseConfig({ ...raw(), database: { type: 'sqlite', path: 'x.db' } }).databasePath, 'x.db')
  })

  it('takes MySQL with sensible defaults, and takes the password from the environment by default', () => {
    const config = parseConfig({ ...raw(), database: { type: 'mysql', user: 'fp', database: 'fingerprint' } })
    assert.deepEqual(config.database, {
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'fp',
      password: undefined,
      passwordEnv: 'FP_MYSQL_PASSWORD',
      database: 'fingerprint',
      connectionLimit: 10,
      lockConnections: 16,
      lockWaitSeconds: 15,
      ssl: false,
      connectTimeoutMs: 10_000,
    })
    assert.equal(config.databasePath, ':memory:', 'the SQLite field has nothing to say about MySQL')
  })

  it('reads every MySQL option', () => {
    const config = parseConfig({
      ...raw(),
      database: {
        type: 'mysql',
        host: 'mysql',
        port: 3307,
        user: 'fp',
        password: 'p@ss word',
        passwordEnv: 'MY_PASSWORD',
        database: 'fp_prod',
        connectionLimit: 20,
        lockConnections: 4,
        lockWaitSeconds: 30,
        ssl: true,
        connectTimeoutMs: 3000,
      },
    })
    assert.deepEqual(config.database, {
      type: 'mysql',
      host: 'mysql',
      port: 3307,
      user: 'fp',
      password: 'p@ss word',
      passwordEnv: 'MY_PASSWORD',
      database: 'fp_prod',
      connectionLimit: 20,
      lockConnections: 4,
      lockWaitSeconds: 30,
      ssl: true,
      connectTimeoutMs: 3000,
    })
  })

  it('reads lists of ranges with columns, and refuses wrong columns', () => {
    const lists = (ranges: unknown) => parseConfig({ ...raw(), ipLists: [{ tag: 'vpn', file: 'x.csv', ranges }] })
    assert.deepEqual(
      lists({ from: 0, to: 1, numeric: true, match: { column: 2, equals: ['VPN'] } }).ipLists[0].ranges,
      {
        from: 0,
        to: 1,
        numeric: true,
        match: { column: 2, equals: ['VPN'] },
      },
    )
    assert.equal(parseConfig({ ...raw(), ipLists: [{ tag: 'a', file: 'a.txt' }] }).ipLists[0].ranges, undefined)
    assert.throws(() => lists({ from: 0 }), /ranges\.to/)
    assert.throws(() => lists({ from: -1, to: 1 }), /ranges\.from/)
    assert.throws(() => lists({ from: 0, to: 1, numeric: 'yes' }), /numeric/)
    assert.throws(() => lists({ from: 0, to: 1, match: { column: 2, equals: [] } }), /match/)
    assert.throws(() => lists('text'), /ranges must be an object/)
  })

  it('refuses what is wrong, naming the field', () => {
    const mysql = (extra: Record<string, unknown>) =>
      parseConfig({ ...raw(), database: { type: 'mysql', user: 'fp', database: 'fingerprint', ...extra } })
    assert.throws(() => parseConfig({ ...raw(), database: { type: 'postgres' } }), /sqlite or mysql/)
    assert.throws(() => parseConfig({ ...raw(), database: 'mysql' }), /database must be an object/)
    assert.throws(() => parseConfig({ ...raw(), database: { type: 'mysql', database: 'x' } }), /database\.user/)
    assert.throws(() => parseConfig({ ...raw(), database: { type: 'mysql', user: 'fp' } }), /database\.database/)
    assert.throws(() => mysql({ database: 'bad name; DROP' }), /database\.database/)
    assert.throws(() => mysql({ database: 'a'.repeat(65) }), /database\.database/)
    assert.throws(() => mysql({ user: "fp'" }), /database\.user/)
    assert.throws(() => mysql({ host: 'bad host' }), /database\.host/)
    assert.throws(() => mysql({ port: 70000 }), /at most 65535/)
    assert.throws(() => mysql({ port: 0 }), /database\.port/)
    assert.throws(() => mysql({ connectionLimit: 101 }), /at most 100/)
    assert.throws(() => mysql({ connectionLimit: '5' }), /connectionLimit/)
    assert.throws(() => mysql({ lockConnections: 101 }), /at most 100/)
    assert.throws(() => mysql({ lockWaitSeconds: 601 }), /at most 600/)
    assert.throws(() => parseConfig({ ...raw(), sharedLimits: true }), /sharedLimits needs database.type mysql/)
    assert.equal(
      parseConfig({
        ...raw(),
        sharedLimits: true,
        database: { type: 'mysql', user: 'fp', database: 'fingerprint' },
      }).sharedLimits,
      true,
    )
    assert.equal(parseConfig(raw()).sharedLimits, false)
    assert.throws(() => mysql({ ssl: 'yes' }), /database\.ssl/)
    assert.throws(() => mysql({ passwordEnv: 'not valid' }), /passwordEnv/)
  })
})
