import { createHash } from 'node:crypto'

import { ClientHello } from './client_hello'

/**
 * JA4, the TLS client fingerprint of FoxIO, as specified in
 * https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md (read on 2026-10-17).
 * Only JA4 (BSD 3-Clause) is implemented. The other JA4+ methods have a license that does not allow selling them.
 */

export interface Ja4 {
  /** The fingerprint: `a_b_c` */
  ja4: string
  /** The same inputs before hashing, to show why two fingerprints differ. This rendering is the project's own. */
  ja4_r: string
  version: string
  sni: boolean
  /** The first ALPN protocol offered, as text, or `undefined` if none */
  alpn?: string
}

const emptyHash = '000000000000'

/** GREASE values are random placeholders that browsers add on purpose: 0x0a0a, 0x1a1a, ..., 0xfafa */
export function isGrease(value: number): boolean {
  return (value & 0x0f0f) === 0x0a0a && value >> 8 === (value & 0xff)
}

const versionNames = new Map<number, string>([
  [0x0304, '13'],
  [0x0303, '12'],
  [0x0302, '11'],
  [0x0301, '10'],
  [0x0300, 's3'],
  [0x0002, 's2'],
  [0xfeff, 'd1'],
  [0xfefd, 'd2'],
  [0xfefc, 'd3'],
])

export function versionCode(hello: ClientHello): string {
  const offered = hello.supportedVersions.filter((version) => !isGrease(version))
  const version = offered.length > 0 ? Math.max(...offered) : hello.legacyVersion
  return versionNames.get(version) ?? '00'
}

const isAlphanumeric = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)

/** First and last character of the first ALPN protocol, or of its hex form when they are not letters or digits */
export function alpnMarker(first: Buffer | undefined): string {
  if (first === undefined || first.length === 0) {
    return '00'
  }
  const firstByte = first[0]
  const lastByte = first[first.length - 1]
  if (isAlphanumeric(firstByte) && isAlphanumeric(lastByte)) {
    return String.fromCharCode(firstByte) + String.fromCharCode(lastByte)
  }
  const hex = first.toString('hex')
  return hex[0] + hex[hex.length - 1]
}

const hex4 = (value: number) => value.toString(16).padStart(4, '0')
const sha12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)
const twoDigits = (count: number) => String(Math.min(count, 99)).padStart(2, '0')

/** @param transport `t` for TLS over TCP. Only that is used here, `q` (QUIC) and `d` (DTLS) are for completeness. */
export function computeJa4(hello: ClientHello, transport: 't' | 'q' | 'd' = 't'): Ja4 {
  const ciphers = hello.ciphers.filter((cipher) => !isGrease(cipher))
  const extensions = hello.extensions.filter((extension) => !isGrease(extension))
  const signatureAlgorithms = hello.signatureAlgorithms.filter((algorithm) => !isGrease(algorithm))

  const sni = hello.extensions.includes(0x0000)
  const version = versionCode(hello)
  const a = `${transport}${version}${sni ? 'd' : 'i'}${twoDigits(ciphers.length)}${twoDigits(
    extensions.length,
  )}${alpnMarker(hello.alpn[0])}`

  const cipherText = ciphers.map(hex4).sort().join(',')
  const b = ciphers.length === 0 ? emptyHash : sha12(cipherText)

  // SNI and ALPN are left out of the hash so that the same browser gives the same value for any site
  const hashedExtensions = extensions.filter((extension) => extension !== 0x0000 && extension !== 0x0010)
  const extensionText = hashedExtensions.map(hex4).sort().join(',')
  const signatureText = signatureAlgorithms.map(hex4).join(',')
  const c =
    hashedExtensions.length === 0
      ? emptyHash
      : sha12(signatureText === '' ? extensionText : `${extensionText}_${signatureText}`)

  const first = hello.alpn[0]
  return {
    ja4: `${a}_${b}_${c}`,
    ja4_r: `${a}_${cipherText}_${extensionText}${signatureText === '' ? '' : `_${signatureText}`}`,
    version,
    sni,
    alpn: first && first.length > 0 ? first.toString('latin1') : undefined,
  }
}
