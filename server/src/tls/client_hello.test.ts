import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { maxHelloBytes, parseClientHello } from './client_hello'
import { alpnExtension, buildClientHello, ja4SpecExample, sniExtension, supportedGroupsExtension } from './testing'

function parsedHello(bytes: Buffer) {
  const result = parseClientHello(bytes)
  assert.equal(result.status, 'ok')
  return result.status === 'ok' ? result : (undefined as never)
}

describe('parseClientHello', () => {
  it('reads the fields of a hello', () => {
    const bytes = buildClientHello({
      ciphers: [0x1301, 0xc02b],
      extensions: [
        sniExtension('www.example.com'),
        alpnExtension([Buffer.from('h2')]),
        supportedGroupsExtension([0x001d, 0x0017]),
      ],
    })
    const { hello, consumed } = parsedHello(bytes)
    assert.deepEqual(hello.ciphers, [0x1301, 0xc02b])
    assert.deepEqual(hello.extensions, [0x0000, 0x0010, 0x000a])
    assert.equal(hello.serverName, 'www.example.com')
    assert.equal(hello.hasSni, true)
    assert.deepEqual(hello.supportedGroups, [0x001d, 0x0017])
    assert.equal(hello.alpn[0].toString(), 'h2')
    assert.equal(consumed, bytes.length)
  })

  it('reports how many bytes it used, so the rest is not lost', () => {
    const hello = buildClientHello(ja4SpecExample())
    assert.equal(parsedHello(Buffer.concat([hello, Buffer.from('trailing bytes')])).consumed, hello.length)
  })

  it('asks for more bytes at every possible cut of the hello', () => {
    const bytes = buildClientHello(ja4SpecExample())
    for (let length = 0; length < bytes.length; length++) {
      assert.equal(parseClientHello(bytes.subarray(0, length)).status, 'incomplete', `cut at ${length}`)
    }
  })

  it('reassembles a hello that is split into several records', () => {
    const spec = ja4SpecExample()
    const whole = parsedHello(buildClientHello(spec)).hello
    const split = parsedHello(buildClientHello({ ...spec, recordSize: 50 })).hello
    assert.deepEqual(split, whole)
  })

  it('recognizes traffic that is not TLS', () => {
    for (const text of ['GET / HTTP/1.1\r\n', 'SSH-2.0-OpenSSH', '\x00\x00']) {
      assert.equal(parseClientHello(Buffer.from(text, 'latin1')).status, 'not_tls', text)
    }
  })

  it('rejects a hello that lies about its lengths', () => {
    const bytes = Buffer.from(buildClientHello(ja4SpecExample()))
    // Make the cipher suite length point far past the end of the message
    const cipherLengthOffset = 5 + 4 + 2 + 32 + 1 + 32
    bytes.writeUInt16BE(0xfff0, cipherLengthOffset)
    assert.equal(parseClientHello(bytes).status, 'malformed')
  })

  it('rejects a handshake that is not a ClientHello and a record of impossible size', () => {
    const notHello = Buffer.from(buildClientHello(ja4SpecExample()))
    notHello[5] = 0x02 // ServerHello
    assert.equal(parseClientHello(notHello).status, 'malformed')
    assert.equal(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff, 0x01])).status, 'malformed')
  })

  it('refuses a huge announced message instead of waiting for it', () => {
    const bytes = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0xff, 0xff, 0xff])
    const result = parseClientHello(bytes)
    assert.equal(result.status, 'too_large')
    assert.ok(0xffffff + 4 > maxHelloBytes)
  })

  it('does not fail on a hello without extensions', () => {
    const { hello } = parsedHello(buildClientHello({ legacyVersion: 0x0301, ciphers: [0x002f] }))
    assert.deepEqual(hello.extensions, [])
    assert.equal(hello.hasSni, false)
  })

  it('survives random garbage after a valid record header', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const garbage = Buffer.alloc(120)
      let state = seed
      for (let index = 0; index < garbage.length; index++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        garbage[index] = state >> 8
      }
      Buffer.from([0x16, 0x03, 0x01, 0x00, 0x73, 0x01]).copy(garbage)
      assert.doesNotThrow(() => parseClientHello(garbage))
    }
  })
})
