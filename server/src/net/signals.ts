import type { IncomingMessage } from 'node:http'
import type { Http2ServerRequest } from 'node:http2'
import type { TLSSocket } from 'node:tls'

import { Config } from '../config'
import { ConnectionRegistry } from '../tls/tls_front'

import { Cidr, ipPrefix, isInAny, normalizeIp, parseIp } from './cidr'
import { resolveClientIp } from './client_ip'
import { HeaderSignals, headerSignals } from './headers'
import { Http2Signals, http2Signals } from './http2'
import { IpIntel, IpIntelProvider } from './ip_intel'

export type Req = IncomingMessage | Http2ServerRequest

export interface TlsSignals {
  ja4: string
  /** `front` is read by this server from the ClientHello. `header` is told by a trusted proxy. */
  source: 'front' | 'header'
  /** The unhashed form of the JA4 (only with `front`) */
  ja4_r?: string
  version?: string
  sni?: boolean
  alpn?: string
  /** What was actually negotiated with this server, to compare with what the hello offered */
  negotiated?: { protocol: string | null; cipher?: string; alpn?: string | false | null }
}

export interface NetworkSignals {
  ip: string
  ipVersion: 4 | 6
  /** /24 of an IPv4 address and /64 of an IPv6 address */
  ipPrefix: string
  ipSource: 'socket' | 'trusted_proxy'
  ipIntel: IpIntel
  /**
   * True when the connection comes from a trusted proxy. Then the header order, the casing and the HTTP/2 data
   * describe the proxy's request to this server, not the visitor's request, so they must not be compared across visits.
   * The values of the headers (such as the user agent) are still the visitor's.
   */
  viaProxy: boolean
  httpVersion: string
  headers: HeaderSignals
  tls?: TlsSignals
  /** Why there is no TLS fingerprint, when this server reads it and could not */
  tlsStatus?: string
  http2?: Http2Signals
}

export interface SignalContext {
  config: Config
  trustedProxies: readonly Cidr[]
  intel: IpIntelProvider
  registry: ConnectionRegistry
}

const ja4Pattern = /^[tqd][0-9a-z]{2}[di]\d{4}[0-9a-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/

function firstHeader(req: Req, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** The TCP/TLS socket under the request. For HTTP/2 it is the socket of the session. */
function rawSocket(req: Req): TLSSocket | IncomingMessage['socket'] {
  return 'stream' in req ? (req.stream.session?.socket as IncomingMessage['socket']) : req.socket
}

/**
 * Collects everything the server can see about the connection and the request: the things a script in the page
 * can neither read nor fake. Returns `undefined` only if the connection has no usable address.
 */
export function extractNetworkSignals(req: Req, context: SignalContext): NetworkSignals | undefined {
  const socket = rawSocket(req)
  const connection = context.registry.get(socket.remotePort)
  // With the TLS front, the inner server's peer is always the front itself (127.0.0.1).
  // The visitor's address is the one the front saw on the public socket, so that is the one to use.
  const peerAddress = connection ? connection.clientIp : socket.remoteAddress
  const client = resolveClientIp(peerAddress, firstHeader(req, context.config.clientIpHeader), context.trustedProxies)
  const parsed = client && parseIp(client.ip)
  if (!client || !parsed) {
    return undefined
  }

  const isHttp2 = 'stream' in req
  const socketIp = normalizeIp(peerAddress ?? '')
  const signals: NetworkSignals = {
    ip: client.ip,
    ipVersion: parsed.family,
    ipPrefix: ipPrefix(client.ip) as string,
    ipSource: client.source,
    ipIntel: context.intel.lookup(client.ip),
    viaProxy: socketIp !== undefined && isInAny(context.trustedProxies, socketIp),
    httpVersion: req.httpVersion,
    headers: headerSignals(req.rawHeaders),
  }

  if (isHttp2) {
    signals.http2 = http2Signals(req)
  }

  if (connection?.ja4) {
    const tlsSocket = socket as TLSSocket
    signals.tls = {
      ja4: connection.ja4.ja4,
      source: 'front',
      ja4_r: connection.ja4.ja4_r,
      version: connection.ja4.version,
      sni: connection.ja4.sni,
      alpn: connection.ja4.alpn,
      negotiated: tlsSocket.encrypted
        ? { protocol: tlsSocket.getProtocol(), cipher: tlsSocket.getCipher()?.name, alpn: tlsSocket.alpnProtocol }
        : undefined,
    }
  } else if (connection) {
    signals.tlsStatus = connection.sniffStatus
  } else if (context.config.ja4Header) {
    // Only a proxy that we trust may tell us the fingerprint; anyone else could write any value
    const told = firstHeader(req, context.config.ja4Header)
    if (told !== undefined && socketIp !== undefined && isInAny(context.trustedProxies, socketIp)) {
      if (ja4Pattern.test(told)) {
        signals.tls = { ja4: told, source: 'header' }
      } else {
        signals.tlsStatus = 'invalid_header'
      }
    }
  }
  return signals
}
