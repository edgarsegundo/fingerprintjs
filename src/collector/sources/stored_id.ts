import { withTimeout } from '../utils'

/**
 * A random code that the browser keeps for the site and sends with each visit, so that the server can tell that it is
 * the same browser even when the other signals changed. The code is random, so it says nothing about the visitor: it is
 * worth only as long as the browser keeps it, and clearing the site data, a private window or a browser that limits
 * what a script may store make it disappear. The server treats a missing or changed code as "no evidence", never as
 * proof of a different device.
 *
 * It is a persistent identifier written to the visitor's device, so it is off by default and `collect` runs it only
 * when the page turned it on (`include: ['storedId']`) AND declared that the visitor agreed (`consent.basis` of
 * `consent`) or that the use is for fraud prevention (`legitimate_interest`). This file does not decide that: it
 * stores and reads when it is called.
 */
export interface StoredIdOptions {
  /** The name of the cookie, the local storage key and the database. Default `_fpid`. */
  name?: string
  /** How long the cookie lives. Default 365 and at most 400, the longest that Chrome keeps a cookie. */
  maxAgeDays?: number
}

export interface StoredIdResult {
  /** The code, or `null` if no place could keep one (everything refused) */
  token: string | null
  /** Where it was found before this call, so the server can see how well it survives */
  foundIn: Array<'cookie' | 'localStorage' | 'indexedDB'>
  /** True if this call made the code */
  created: boolean
}

export const defaultStoredIdName = '_fpid'
export const storedIdNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/
const tokenPattern = /^[A-Za-z0-9_-]{22,64}$/
const timeoutMs = 1500
const defaultMaxAgeDays = 365
const maxMaxAgeDays = 400

type Place = StoredIdResult['foundIn'][number]

function newToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  // base64url, without padding: 22 characters for 128 bits
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function valid(value: unknown): value is string {
  return typeof value === 'string' && tokenPattern.test(value)
}

function readCookie(name: string): string | undefined {
  try {
    for (const part of document.cookie.split(';')) {
      const text = part.trim()
      const at = text.indexOf('=')
      if (at > 0 && text.slice(0, at) === name) {
        return decodeURIComponent(text.slice(at + 1))
      }
    }
  } catch {
    // Cookies refused or not available
  }
  return undefined
}

function writeCookie(name: string, token: string, maxAgeDays: number): void {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${name}=${encodeURIComponent(token)}; Max-Age=${
      maxAgeDays * 86400
    }; Path=/; SameSite=Lax${secure}`
  } catch {
    // Refused
  }
}

function readLocal(name: string): string | undefined {
  try {
    return localStorage.getItem(name) ?? undefined
  } catch {
    return undefined
  }
}

function writeLocal(name: string, token: string): void {
  try {
    localStorage.setItem(name, token)
  } catch {
    // Full or refused
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('blocked'))
  })
}

async function readIndexed(name: string): Promise<string | undefined> {
  try {
    const db = await withTimeout(openDatabase(name), timeoutMs)
    try {
      return await withTimeout(
        new Promise<string | undefined>((resolve, reject) => {
          const request = db.transaction('kv', 'readonly').objectStore('kv').get('id')
          request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : undefined)
          request.onerror = () => reject(request.error)
        }),
        timeoutMs,
      )
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function writeIndexed(name: string, token: string): Promise<void> {
  try {
    const db = await withTimeout(openDatabase(name), timeoutMs)
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('kv', 'readwrite')
          transaction.objectStore('kv').put(token, 'id')
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }),
        timeoutMs,
      )
    } finally {
      db.close()
    }
  } catch {
    // Refused or full
  }
}

/** Removes the code from every place. For tests and for a page that lets the visitor take back their agreement. */
export async function forgetStoredId(options: StoredIdOptions = {}): Promise<void> {
  const name = options.name ?? defaultStoredIdName
  try {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`
    localStorage.removeItem(name)
  } catch {
    // Nothing to remove
  }
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      }),
      timeoutMs,
    )
  } catch {
    // Nothing to remove
  }
}

/**
 * Reads the code from the cookie, local storage and IndexedDB, makes one if none of them has it, and writes it back to
 * the places that lost it. If the places disagree, the one held by most of them wins (the first one on a tie).
 */
export default async function getStoredId(options: StoredIdOptions = {}): Promise<StoredIdResult> {
  const name = options.name ?? defaultStoredIdName
  const maxAgeDays = Math.min(maxMaxAgeDays, Math.max(1, Math.floor(options.maxAgeDays ?? defaultMaxAgeDays)))

  const found: Array<[Place, string | undefined]> = [
    ['cookie', readCookie(name)],
    ['localStorage', readLocal(name)],
    ['indexedDB', await readIndexed(name)],
  ]
  const counts = new Map<string, number>()
  for (const [, value] of found) {
    if (valid(value)) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  let token: string | undefined
  let best = 0
  for (const [, value] of found) {
    const count = valid(value) ? counts.get(value) ?? 0 : 0
    if (count > best) {
      best = count
      token = value
    }
  }
  const created = token === undefined
  const keep = token ?? newToken()

  // Write it back where it is missing or different, so that clearing one place does not lose the code
  if (readCookie(name) !== keep) {
    writeCookie(name, keep, maxAgeDays)
  }
  if (readLocal(name) !== keep) {
    writeLocal(name, keep)
  }
  if (found[2][1] !== keep) {
    await writeIndexed(name, keep)
  }

  // Say where it is now: a place that refuses to keep it should not be reported as holding it
  const holders = found.filter(([, value]) => value === keep).map(([place]) => place)
  const kept = readCookie(name) === keep || readLocal(name) === keep || (await readIndexed(name)) === keep
  return { token: kept ? keep : null, foundIn: holders, created: created && kept }
}
