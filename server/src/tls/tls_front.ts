import net from 'node:net'

import { normalizeIp } from '../net/cidr'

import { ClientHello, maxHelloBytes, parseClientHello } from './client_hello'
import { computeJa4, Ja4 } from './ja4'

export interface ConnectionInfo {
  /** The address of the visitor as the front saw it on the public socket */
  clientIp?: string
  /** Why there is no fingerprint, when there is none: the traffic was not TLS, the hello was broken, or too slow */
  sniffStatus: 'ok' | 'not_tls' | 'malformed' | 'too_large' | 'timeout'
  ja4?: Ja4
  /** The raw lists behind the fingerprint, for the explanation of why two hellos differ */
  hello?: Pick<ClientHello, 'legacyVersion' | 'ciphers' | 'extensions' | 'supportedGroups' | 'signatureAlgorithms'>
}

/**
 * Remembers what the front learned about each connection until the connection closes.
 * The key is the local port of the front's connection to the inner server, which the inner server sees as the remote
 * port of its client. Both live in the same process, so no data crosses a network or a header.
 */
export class ConnectionRegistry {
  private readonly connections = new Map<number, ConnectionInfo>()

  set(innerPort: number, info: ConnectionInfo): void {
    this.connections.set(innerPort, info)
  }

  get(innerPort: number | undefined): ConnectionInfo | undefined {
    return innerPort === undefined ? undefined : this.connections.get(innerPort)
  }

  delete(innerPort: number): void {
    this.connections.delete(innerPort)
  }

  get size(): number {
    return this.connections.size
  }
}

export interface TlsFrontOptions {
  /** Where the inner TLS server listens (the front connects there) */
  innerPort: number
  innerHost?: string
  registry: ConnectionRegistry
  /** How long the client has to send its whole ClientHello. After that, the connection is closed. */
  helloTimeoutMs?: number
}

/**
 * A TCP server that sits in front of the TLS server, reads the ClientHello of every connection, computes the JA4
 * and passes the bytes on unchanged.
 *
 * Node's `tls` doesn't expose the ClientHello, so the only way to get it without a separate proxy is to read the
 * first bytes of the connection before TLS does. The front never decrypts anything and never alters a byte.
 */
export function createTlsFront(options: TlsFrontOptions): net.Server {
  const { innerPort, innerHost = '127.0.0.1', registry, helloTimeoutMs = 5000 } = options

  return net.createServer((client) => {
    client.setNoDelay(true)
    const chunks: Buffer[] = []
    let received = 0
    let decided = false
    let inner: net.Socket | undefined
    // The port is read while the socket is open: after it closes, `localPort` is `undefined`
    let innerLocalPort: number | undefined

    const closeBoth = () => {
      client.destroy()
      inner?.destroy()
    }

    const connectInner = (info: ConnectionInfo) => {
      decided = true
      clearTimeout(timer)
      client.removeListener('data', onData)
      client.pause()
      inner = net.connect(innerPort, innerHost)
      inner.setNoDelay(true)
      inner.once('connect', () => {
        innerLocalPort = inner?.localPort
        if (innerLocalPort !== undefined) {
          registry.set(innerLocalPort, info)
        }
        inner?.write(Buffer.concat(chunks))
        chunks.length = 0
        client.pipe(inner as net.Socket)
        inner?.pipe(client)
        client.resume()
      })
      inner.once('close', () => {
        if (innerLocalPort !== undefined) {
          registry.delete(innerLocalPort)
        }
        client.destroy()
      })
      inner.on('error', closeBoth)
    }

    const clientIp = client.remoteAddress === undefined ? undefined : normalizeIp(client.remoteAddress)

    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      received += chunk.length
      const result = parseClientHello(Buffer.concat(chunks))
      if (result.status === 'incomplete') {
        if (received > maxHelloBytes) {
          connectInner({ clientIp, sniffStatus: 'too_large' })
        }
        return
      }
      if (result.status === 'ok') {
        const { hello } = result
        connectInner({
          clientIp,
          sniffStatus: 'ok',
          ja4: computeJa4(hello),
          hello: {
            legacyVersion: hello.legacyVersion,
            ciphers: hello.ciphers,
            extensions: hello.extensions,
            supportedGroups: hello.supportedGroups,
            signatureAlgorithms: hello.signatureAlgorithms,
          },
        })
        return
      }
      // Not TLS or broken: pass the bytes on anyway. The inner server rejects them, and that is its job.
      connectInner({ clientIp, sniffStatus: result.status })
    }

    const timer = setTimeout(() => {
      if (!decided) {
        // A client that never finishes its hello (slow-loris style) is cut off
        closeBoth()
      }
    }, helloTimeoutMs)

    client.on('data', onData)
    client.on('error', closeBoth)
    client.once('close', () => {
      clearTimeout(timer)
      inner?.destroy()
    })
  })
}
