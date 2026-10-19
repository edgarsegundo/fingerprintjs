import { createHash, timingSafeEqual } from 'node:crypto'

import type { Req } from './net/signals'

/**
 * The parts of a response that are used.
 * Both `http.ServerResponse` and the HTTP/2 compatibility response have them.
 */
export interface Res {
  readonly headersSent: boolean
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string | Buffer): unknown
  once(event: 'finish', listener: () => void): unknown
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(String(body.error))
  }
}

export const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

export function reply(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    ...baseHeaders,
    ...(text === '' ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  })
  res.end(text)
}

/** Reads the body up to the limit. A body over the limit is dropped and not stored. */
export function readBody(req: Req, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, { error: 'payload_too_large' }))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      if (exceeded) {
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        exceeded = true
        chunks.length = 0
        reject(new HttpError(413, { error: 'payload_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Whether the request carries a bearer key whose SHA-256 is in the list. The comparison takes the same time for any
 * wrong key, and every stored hash is compared, so the time does not tell which one is near.
 */
export function bearerMatches(hashes: readonly string[], req: Req): boolean {
  const header = String(req.headers.authorization ?? '')
  const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (secret === '' || hashes.length === 0) {
    return false
  }
  const given = createHash('sha256').update(secret).digest()
  let found = false
  for (const stored of hashes) {
    if (timingSafeEqual(given, Buffer.from(stored, 'hex'))) {
      found = true
    }
  }
  return found
}
