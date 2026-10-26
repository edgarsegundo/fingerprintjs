#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prepares a local test: writes config.json (in server/data) with one test tenant (SQLite, port 8080) and prints
 * the keys.
 * It does not touch an existing config, so running it again only shows how to use the one that is there.
 *
 *   node tools/local-test/setup.js
 */
const { createHash, randomBytes } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

// Folder and ports can be changed for a second, separate test (the guide's own check uses this)
const dir = process.env.FP_LOCAL_DATA || join(__dirname, '..', '..', 'server', 'data')
const apiPort = Number(process.env.FP_LOCAL_PORT || 8080)
const pagePort = Number(process.env.FP_LOCAL_PAGE_PORT || 8081)
const file = join(dir, 'config.json')
const keysFile = join(dir, 'local-test-keys.json')

if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true })
  const token = (prefix, bytes) => `${prefix}${randomBytes(bytes).toString('base64url')}`
  const publicKey = token('pk_', 18)
  const secretKey = token('sk_', 32)
  const config = {
    nonceSecret: randomBytes(48).toString('base64url'),
    listen: { host: '127.0.0.1', port: apiPort },
    databasePath: join(dir, 'local-test.db'),
    // The test page is served from this address
    tenants: [
      {
        id: 'teste',
        publicKey,
        secretKeySha256: [createHash('sha256').update(secretKey).digest('hex')],
        allowedOrigins: [`http://127.0.0.1:${pagePort}`],
        // `learnFromTampered: 'always'` is for this test only. By default a visit with high tamper evidence does not
        // teach
        // the engine, which is the right default for real use. Some browsers (Brave with Shields, for one) change what
        // the page reads on every visit and are marked as tampered, so with the default they would never be recognized
        settings: {
          identity: { storedId: { enabled: true }, learnFromTampered: 'always' },
          privacy: { ipStorage: 'full' },
        },
      },
    ],
  }
  writeFileSync(file, JSON.stringify(config, null, 2))
  // The secret key is shown once by the server's own rules; here it is kept in a local file for the test only
  writeFileSync(keysFile, JSON.stringify({ publicKey, secretKey }, null, 2))
  console.log('Created server/data/config.json (this folder is ignored by git).')
} else {
  // A config made by an earlier version of this script: add the test setting, keeping the keys
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const tenant = config.tenants[0]
  tenant.settings = tenant.settings || {}
  tenant.settings.identity = tenant.settings.identity || {}
  if (tenant.settings.identity.learnFromTampered === undefined) {
    tenant.settings.identity.learnFromTampered = 'always'
    writeFileSync(file, JSON.stringify(config, null, 2))
    console.log('Updated server/data/config.json: visits marked as tampered now teach the engine (for this test only).')
  }
}

const keys = JSON.parse(readFileSync(keysFile, 'utf8'))
console.log('')
console.log(`Public key: ${keys.publicKey}`)
console.log(`Secret key: ${keys.secretKey}`)
console.log('')
console.log(`Test page:  http://127.0.0.1:${pagePort}/tools/local-test/index.html?k=` + keys.publicKey)
console.log('See the visits:  node tools/local-test/check.js')
