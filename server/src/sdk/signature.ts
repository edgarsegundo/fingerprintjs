import { createHmac, timingSafeEqual } from 'node:crypto'

/** The name of the header that carries the signature of a webhook */
export const signatureHeader = 'x-fingerprint-signature'

const hmac = (secret: string, timestamp: number, body: string): string =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

/**
 * The value of the signature header: `t=<seconds>,v1=<hmac>`. The HMAC covers the time and the exact body, so a
 * captured request cannot be sent again later (the receiver checks the time) nor with another body.
 * More than one secret may be given, for a change of secret without a gap: the receiver accepts any of them.
 */
export function signWebhook(secrets: string | readonly string[], body: string, timestampSeconds: number): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  return [`t=${timestampSeconds}`, ...list.map((secret) => `v1=${hmac(secret, timestampSeconds, body)}`)].join(',')
}

export interface VerifyOptions {
  /** The secret of the endpoint, or the old and the new one while it is being changed */
  secret: string | readonly string[]
  /** The exact bytes of the body as received. A parsed and serialized body is not the same text. */
  body: string
  /** The value of the `X-Fingerprint-Signature` header */
  signature: string | undefined
  /** How old, in seconds, a signature may be. Default 300. */
  toleranceSeconds?: number
  /** For tests */
  now?: () => number
}

/** True only if the signature is well made, comes from a known secret, matches this body and is recent */
export function verifyWebhook(options: VerifyOptions): boolean {
  const { signature, body, secret, toleranceSeconds = 300 } = options
  if (typeof signature !== 'string' || signature.length > 2000) {
    return false
  }
  const parts = signature.split(',').map((part) => part.trim())
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2)
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) {
    return false
  }
  const seconds = Number(timestamp)
  const nowSeconds = (options.now ?? Date.now)() / 1000
  if (Math.abs(nowSeconds - seconds) > toleranceSeconds) {
    return false
  }
  const candidates = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3))
  const secrets = typeof secret === 'string' ? [secret] : secret
  let valid = false
  // Every pair is compared, without stopping at the first hit, so that the time does not tell which one matched
  for (const known of secrets) {
    const expected = Buffer.from(hmac(known, seconds, body), 'hex')
    for (const candidate of candidates) {
      const given = /^[0-9a-f]{64}$/.test(candidate) ? Buffer.from(candidate, 'hex') : undefined
      if (given && timingSafeEqual(given, expected)) {
        valid = true
      }
    }
  }
  return valid
}
