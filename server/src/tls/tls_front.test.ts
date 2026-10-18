import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it } from 'node:test'

import { buildClientHello, ja4SpecExample } from './testing'
import { ConnectionRegistry, createTlsFront } from './tls_front'

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  )
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** An inner server that records what it receives and the remote port of each connection */
async function makeInner() {
  const received: Buffer[] = []
  const remotePorts: number[] = []
  const server = net.createServer((socket) => {
    remotePorts.push(socket.remotePort as number)
    socket.on('data', (chunk) => {
      received.push(chunk)
      socket.write('pong')
    })
  })
  const port = await listen(server)
  return { server, port, received, remotePorts }
}

function exchange(port: number, payload: Buffer | Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', async () => {
      for (const piece of Array.isArray(payload) ? payload : [payload]) {
        client.write(piece)
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    client.once('data', (data) => {
      client.destroy()
      resolve(data.toString())
    })
    client.on('error', reject)
  })
}

describe('createTlsFront', () => {
  it('computes the JA4 and passes the bytes on unchanged', async () => {
    const inner = await makeInner()
    const registry = new ConnectionRegistry()
    const front = createTlsFront({ innerPort: inner.port, registry })
    const frontPort = await listen(front)
    try {
      const hello = buildClientHello(ja4SpecExample())
      assert.equal(await exchange(frontPort, hello), 'pong')

      assert.deepEqual(Buffer.concat(inner.received), hello, 'the inner server must get exactly the same bytes')
      const info = registry.get(inner.remotePorts[0])
      assert.equal(info?.sniffStatus, 'ok')
      assert.equal(info?.ja4?.ja4, 't13d1516h2_8daaf6152771_e5627efa2ab1')
      assert.equal(info?.clientIp, '127.0.0.1')
      assert.equal(info?.hello?.ciphers.length, 15)
    } finally {
      await close(front)
      await close(inner.server)
    }
  })

  it('handles a hello that arrives in several pieces', async () => {
    const inner = await makeInner()
    const registry = new ConnectionRegistry()
    const front = createTlsFront({ innerPort: inner.port, registry })
    const frontPort = await listen(front)
    try {
      const hello = buildClientHello({ ...ja4SpecExample(), recordSize: 60 })
      const pieces = [hello.subarray(0, 3), hello.subarray(3, 90), hello.subarray(90)]
      assert.equal(await exchange(frontPort, pieces), 'pong')
      assert.deepEqual(Buffer.concat(inner.received), hello)
      assert.equal(registry.get(inner.remotePorts[0])?.ja4?.ja4, 't13d1516h2_8daaf6152771_e5627efa2ab1')
    } finally {
      await close(front)
      await close(inner.server)
    }
  })

  it('passes traffic that is not TLS through and says why there is no fingerprint', async () => {
    const inner = await makeInner()
    const registry = new ConnectionRegistry()
    const front = createTlsFront({ innerPort: inner.port, registry })
    const frontPort = await listen(front)
    try {
      assert.equal(await exchange(frontPort, Buffer.from('GET / HTTP/1.1\r\n\r\n')), 'pong')
      const info = registry.get(inner.remotePorts[0])
      assert.equal(info?.sniffStatus, 'not_tls')
      assert.equal(info?.ja4, undefined)
    } finally {
      await close(front)
      await close(inner.server)
    }
  })

  it('forgets a connection when it closes', async () => {
    const inner = await makeInner()
    const registry = new ConnectionRegistry()
    const front = createTlsFront({ innerPort: inner.port, registry })
    const frontPort = await listen(front)
    try {
      await exchange(frontPort, buildClientHello(ja4SpecExample()))
      for (let attempt = 0; attempt < 50 && registry.size > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(registry.size, 0)
    } finally {
      await close(front)
      await close(inner.server)
    }
  })

  it('cuts off a client that never finishes its hello', async () => {
    const inner = await makeInner()
    const registry = new ConnectionRegistry()
    const front = createTlsFront({ innerPort: inner.port, registry, helloTimeoutMs: 100 })
    const frontPort = await listen(front)
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const client: net.Socket = net.connect(frontPort, '127.0.0.1', () =>
          client.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x50])),
        )
        client.on('close', () => resolve(true))
        client.on('error', () => undefined)
        setTimeout(() => resolve(false), 2000)
      })
      assert.equal(closed, true)
      assert.equal(inner.remotePorts.length, 0, 'nothing is forwarded for an unfinished hello')
    } finally {
      await close(front)
      await close(inner.server)
    }
  })
})
