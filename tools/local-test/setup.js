#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prepares a local test: writes server/data/config.json with one test tenant (SQLite, port 8080) and prints the keys.
 * It does not touch an existing config, so running it again only shows how to use the one that is there.
 *
 *   node tools/local-test/setup.js
 */
const { createHash, randomBytes } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const dir = join(__dirname, '..', '..', 'server', 'data')
const file = join(dir, 'config.json')
const keysFile = join(dir, 'local-test-keys.json')

if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true })
  const token = (prefix, bytes) => `${prefix}${randomBytes(bytes).toString('base64url')}`
  const publicKey = token('pk_', 18)
  const secretKey = token('sk_', 32)
  const config = {
    nonceSecret: randomBytes(48).toString('base64url'),
    listen: { host: '127.0.0.1', port: 8080 },
    databasePath: join(dir, 'local-test.db'),
    // The test page is served from this address
    tenants: [
      {
        id: 'teste',
        publicKey,
        secretKeySha256: [createHash('sha256').update(secretKey).digest('hex')],
        allowedOrigins: ['http://127.0.0.1:8081'],
        settings: { identity: { storedId: { enabled: true } }, privacy: { ipStorage: 'full' } },
      },
    ],
  }
  writeFileSync(file, JSON.stringify(config, null, 2))
  // The secret key is shown once by the server's own rules; here it is kept in a local file for the test only
  writeFileSync(keysFile, JSON.stringify({ publicKey, secretKey }, null, 2))
  console.log('Created server/data/config.json (this folder is ignored by git).')
}

const keys = JSON.parse(readFileSync(keysFile, 'utf8'))
console.log('')
console.log(`Public key: ${keys.publicKey}`)
console.log(`Secret key: ${keys.secretKey}`)
console.log('')
console.log('Test page:  http://127.0.0.1:8081/tools/local-test/index.html?k=' + keys.publicKey)
console.log(
  'Latest visits:  curl -s -H "Authorization: Bearer ' + keys.secretKey + '" "http://127.0.0.1:8080/v1/events?limit=5"',
)
