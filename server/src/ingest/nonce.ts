import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * A nonce is a one-time challenge. The browser gets it first and sends it back inside the payload.
 * A payload captured by someone else can't be replayed, because the nonce was already used or has expired.
 *
 * The token is signed, so the server doesn't need to remember the nonces it issued, only the ones used:
 * `n2.<expires at, seconds>.<random>.<context>.<signature>`. The signature covers the tenant, so a nonce from one
 * tenant is worthless for another.
 *
 * The context is a short tag of who asked for the nonce: their network, TLS stack and user agent. When the payload
 * arrives, the same tag is computed again. If it differs, the nonce was fetched by one client and used by another,
 * which is what a payload forged somewhere else with a nonce from a real browser looks like. It is reported as
 * evidence and not as a rejection, because a phone that moves from Wi-Fi to the mobile network between the two
 * requests changes network legitimately.
 */

export type ContextMatch = 'match' | 'mismatch' | 'none'

export type NonceCheck =
  | { ok: true; expiresAt: number; context: ContextMatch }
  | { ok: false; reason: 'format' | 'signature' | 'expired' }

const version = 'n2'
/** The tag of a nonce that was issued without a context */
const noContext = '________'

const contextTag = (secret: string, tenantId: string, context: string): string =>
  createHmac('sha256', secret).update(`ctx|${tenantId}|${context}`).digest('base64url').slice(0, 8)

function sign(secret: string, tenantId: string, expiresAtSeconds: number, random: string, tag: string): string {
  return createHmac('sha256', secret)
    .update(`${version}|${tenantId}|${expiresAtSeconds}|${random}|${tag}`)
    .digest('base64url')
    .slice(0, 22)
}

export function issueNonce(
  secret: string,
  tenantId: string,
  nowMs: number,
  ttlSeconds: number,
  context?: string,
): string {
  const expiresAtSeconds = Math.floor(nowMs / 1000) + ttlSeconds
  const random = randomBytes(12).toString('base64url')
  const tag = context === undefined ? noContext : contextTag(secret, tenantId, context)
  return `${version}.${expiresAtSeconds}.${random}.${tag}.${sign(secret, tenantId, expiresAtSeconds, random, tag)}`
}

export function verifyNonce(
  secret: string,
  tenantId: string,
  token: string,
  nowMs: number,
  context?: string,
): NonceCheck {
  const parts = token.split('.')
  if (
    parts.length !== 5 ||
    parts[0] !== version ||
    !/^\d{1,12}$/.test(parts[1]) ||
    !/^[A-Za-z0-9_-]{16}$/.test(parts[2]) ||
    !/^[A-Za-z0-9_-]{8}$/.test(parts[3])
  ) {
    return { ok: false, reason: 'format' }
  }
  const expiresAtSeconds = Number(parts[1])
  const expected = Buffer.from(sign(secret, tenantId, expiresAtSeconds, parts[2], parts[3]))
  const given = Buffer.from(parts[4])
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' }
  }
  if (nowMs >= expiresAtSeconds * 1000) {
    return { ok: false, reason: 'expired' }
  }
  let match: ContextMatch = 'none'
  if (context !== undefined && parts[3] !== noContext) {
    const wanted = Buffer.from(contextTag(secret, tenantId, context))
    const issued = Buffer.from(parts[3])
    match = wanted.length === issued.length && timingSafeEqual(wanted, issued) ? 'match' : 'mismatch'
  }
  return { ok: true, expiresAt: expiresAtSeconds * 1000, context: match }
}

/** What the store remembers about a used nonce: a hash, not the token */
export function nonceFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
