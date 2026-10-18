/** Builds TLS ClientHello bytes for tests. It lives in `src` only so that the tests of several folders share it. */

export interface ExtensionSpec {
  type: number
  data?: Buffer
}

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff])

export function sniExtension(host: string): ExtensionSpec {
  const name = Buffer.from(host, 'latin1')
  const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name])
  return { type: 0x0000, data: Buffer.concat([u16(entry.length), entry]) }
}

export function alpnExtension(protocols: Buffer[]): ExtensionSpec {
  const list = Buffer.concat(protocols.map((protocol) => Buffer.concat([Buffer.from([protocol.length]), protocol])))
  return { type: 0x0010, data: Buffer.concat([u16(list.length), list]) }
}

export function supportedVersionsExtension(versions: number[]): ExtensionSpec {
  return { type: 0x002b, data: Buffer.concat([Buffer.from([versions.length * 2]), ...versions.map(u16)]) }
}

export function signatureAlgorithmsExtension(algorithms: number[]): ExtensionSpec {
  return { type: 0x000d, data: Buffer.concat([u16(algorithms.length * 2), ...algorithms.map(u16)]) }
}

export function supportedGroupsExtension(groups: number[]): ExtensionSpec {
  return { type: 0x000a, data: Buffer.concat([u16(groups.length * 2), ...groups.map(u16)]) }
}

export function ecPointFormatsExtension(formats: number[]): ExtensionSpec {
  return { type: 0x000b, data: Buffer.from([formats.length, ...formats]) }
}

export interface HelloSpec {
  legacyVersion?: number
  ciphers: number[]
  extensions?: ExtensionSpec[]
  /** Split the handshake message into records of at most this many bytes */
  recordSize?: number
}

/** The handshake message (type, length and body) without the record layer */
export function buildHandshake(spec: HelloSpec): Buffer {
  const ciphers = Buffer.concat(spec.ciphers.map(u16))
  const extensionBytes = (spec.extensions ?? []).map((extension) =>
    Buffer.concat([u16(extension.type), u16(extension.data?.length ?? 0), extension.data ?? Buffer.alloc(0)]),
  )
  const extensions = Buffer.concat(extensionBytes)
  const body = Buffer.concat([
    u16(spec.legacyVersion ?? 0x0303),
    Buffer.alloc(32, 7), // random
    Buffer.from([32]),
    Buffer.alloc(32, 9), // session id
    u16(ciphers.length),
    ciphers,
    Buffer.from([1, 0]), // compression methods: null
    ...(spec.extensions ? [u16(extensions.length), extensions] : []),
  ])
  return Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ])
}

/** A full TLS record stream carrying the ClientHello */
export function buildClientHello(spec: HelloSpec): Buffer {
  const handshake = buildHandshake(spec)
  const size = spec.recordSize ?? handshake.length
  const records: Buffer[] = []
  for (let offset = 0; offset < handshake.length; offset += size) {
    const chunk = handshake.subarray(offset, offset + size)
    records.push(Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(chunk.length), chunk]))
  }
  return Buffer.concat(records)
}

/**
 * The example of the JA4 specification: 15 ciphers, 16 extensions, signature algorithms, `h2`, SNI, TLS 1.3.
 * Expected fingerprint: `t13d1516h2_8daaf6152771_e5627efa2ab1`.
 */
export function ja4SpecExample(): HelloSpec {
  const plain = (type: number): ExtensionSpec => ({ type })
  return {
    ciphers: [
      0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f,
      0x0035,
    ],
    extensions: [
      plain(0x001b),
      sniExtension('example.com'),
      plain(0x0033),
      alpnExtension([Buffer.from('h2'), Buffer.from('http/1.1')]),
      plain(0x4469),
      plain(0x0017),
      plain(0x002d),
      signatureAlgorithmsExtension([0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]),
      plain(0x0005),
      plain(0x0023),
      plain(0x0012),
      supportedVersionsExtension([0x0304, 0x0303]),
      plain(0xff01),
      ecPointFormatsExtension([0]),
      supportedGroupsExtension([0x001d, 0x0017, 0x0018]),
      plain(0x0015),
    ],
  }
}
