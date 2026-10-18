export interface ClientHello {
  /** `client_version` inside the hello. TLS 1.3 clients still write 0x0303 here. */
  legacyVersion: number
  /** Cipher suites in the order sent, GREASE included */
  ciphers: number[]
  /** Extension types in the order sent, GREASE included */
  extensions: number[]
  supportedVersions: number[]
  signatureAlgorithms: number[]
  supportedGroups: number[]
  ecPointFormats: number[]
  /** Protocol names offered with ALPN, in order */
  alpn: Buffer[]
  hasSni: boolean
  serverName?: string
}

export type ParseResult =
  | { status: 'ok'; hello: ClientHello; consumed: number }
  /** The bytes so far are a valid start; wait for more */
  | { status: 'incomplete' }
  | { status: 'not_tls' | 'malformed' | 'too_large'; reason: string }

/** The largest handshake message that is parsed. Real hellos are 0.5 to 3 KB; post-quantum key shares add 1.2 KB. */
export const maxHelloBytes = 64 * 1024

const recordHeaderLength = 5
const handshakeRecord = 0x16
const clientHelloType = 0x01
/** The size limit of one TLS record payload (2^14), plus the slack that RFC 8446 allows */
const maxRecordPayload = 16384 + 256

class Truncated extends Error {}

class Reader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset
  }

  u8(): number {
    this.need(1)
    return this.buffer[this.offset++]
  }

  u16(): number {
    this.need(2)
    const value = this.buffer.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  u24(): number {
    this.need(3)
    const value = this.buffer.readUIntBE(this.offset, 3)
    this.offset += 3
    return value
  }

  bytes(length: number): Buffer {
    this.need(length)
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  private need(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new Truncated()
    }
  }
}

function readU16List(data: Buffer, lengthBytes: 1 | 2): number[] {
  const reader = new Reader(data)
  const length = lengthBytes === 1 ? reader.u8() : reader.u16()
  const list = new Reader(reader.bytes(length))
  const values: number[] = []
  while (list.remaining > 0) {
    values.push(list.u16())
  }
  return values
}

function parseBody(body: Buffer): ClientHello {
  const reader = new Reader(body)
  const hello: ClientHello = {
    legacyVersion: reader.u16(),
    ciphers: [],
    extensions: [],
    supportedVersions: [],
    signatureAlgorithms: [],
    supportedGroups: [],
    ecPointFormats: [],
    alpn: [],
    hasSni: false,
  }
  reader.bytes(32) // random
  reader.bytes(reader.u8()) // session id

  const ciphers = new Reader(reader.bytes(reader.u16()))
  while (ciphers.remaining > 0) {
    hello.ciphers.push(ciphers.u16())
  }
  reader.bytes(reader.u8()) // compression methods

  if (reader.remaining === 0) {
    return hello // Very old clients send no extensions
  }
  const extensions = new Reader(reader.bytes(reader.u16()))
  while (extensions.remaining > 0) {
    const type = extensions.u16()
    const data = extensions.bytes(extensions.u16())
    hello.extensions.push(type)
    switch (type) {
      case 0x0000: {
        hello.hasSni = true
        const names = new Reader(new Reader(data).bytes(new Reader(data).u16() + 2).subarray(2))
        while (names.remaining > 0) {
          const nameType = names.u8()
          const name = names.bytes(names.u16())
          if (nameType === 0 && hello.serverName === undefined) {
            hello.serverName = name.toString('latin1')
          }
        }
        break
      }
      case 0x000a:
        hello.supportedGroups = readU16List(data, 2)
        break
      case 0x000b: {
        const formats = new Reader(data)
        const list = formats.bytes(formats.u8())
        hello.ecPointFormats = Array.from(list)
        break
      }
      case 0x000d:
        hello.signatureAlgorithms = readU16List(data, 2)
        break
      case 0x0010: {
        const outer = new Reader(data)
        const protocols = new Reader(outer.bytes(outer.u16()))
        while (protocols.remaining > 0) {
          hello.alpn.push(Buffer.from(protocols.bytes(protocols.u8())))
        }
        break
      }
      case 0x002b:
        hello.supportedVersions = readU16List(data, 1)
        break
      default:
        break
    }
  }
  return hello
}

/**
 * Reads a TLS ClientHello from the first bytes of a connection.
 *
 * The hello may arrive in several TCP segments and may be split in several TLS records, so the caller calls this again
 * with more bytes while the answer is `incomplete`. Nothing is trusted: every length is checked and a lie
 * gives `malformed`.
 */
export function parseClientHello(buffer: Buffer): ParseResult {
  if (buffer.length === 0) {
    return { status: 'incomplete' }
  }
  if (buffer[0] !== handshakeRecord) {
    return { status: 'not_tls', reason: `first byte is 0x${buffer[0].toString(16)}, not a handshake record` }
  }

  // Collect the handshake bytes of consecutive records
  let offset = 0
  let handshake = Buffer.alloc(0)
  let total = -1
  while (total < 0 || handshake.length < total) {
    if (buffer.length - offset < recordHeaderLength) {
      return { status: 'incomplete' }
    }
    if (buffer[offset] !== handshakeRecord) {
      return { status: 'malformed', reason: 'a record in the middle of the hello is not a handshake record' }
    }
    if (buffer[offset + 1] !== 3) {
      return { status: 'not_tls', reason: `record version major is ${buffer[offset + 1]}` }
    }
    const length = buffer.readUInt16BE(offset + 3)
    if (length === 0 || length > maxRecordPayload) {
      return { status: 'malformed', reason: `record length ${length}` }
    }
    if (buffer.length - offset - recordHeaderLength < length) {
      return { status: 'incomplete' }
    }
    handshake = Buffer.concat([
      handshake,
      buffer.subarray(offset + recordHeaderLength, offset + recordHeaderLength + length),
    ])
    offset += recordHeaderLength + length

    if (total < 0 && handshake.length >= 4) {
      if (handshake[0] !== clientHelloType) {
        return { status: 'malformed', reason: `handshake type ${handshake[0]} is not a ClientHello` }
      }
      total = 4 + handshake.readUIntBE(1, 3)
      if (total > maxHelloBytes) {
        return { status: 'too_large', reason: `ClientHello of ${total} bytes` }
      }
    }
  }

  try {
    return { status: 'ok', hello: parseBody(handshake.subarray(4, total)), consumed: offset }
  } catch (error) {
    if (error instanceof Truncated) {
      return { status: 'malformed', reason: 'a length field points past the end of the message' }
    }
    throw error
  }
}
