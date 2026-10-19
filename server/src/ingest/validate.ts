/**
 * The shape of the payload sent by the browser collector.
 * It mirrors `src/collector/payload.ts` of the browser library. A test checks that the schema version is the same.
 */
export const SUPPORTED_SCHEMA = 1

export interface SerializedSignal {
  value?: unknown
  error?: { name: string; message: string }
  duration: number
}

export interface CollectPayload {
  schema: number
  libVersion: string
  collectedAt: number
  durationMs: number
  nonce?: string
  linkedId?: string
  consent?: { basis: 'consent' | 'legitimate_interest' | 'contract' | 'other'; version: string }
  components: Record<string, SerializedSignal>
  extended: Record<string, SerializedSignal>
}

const maxSignalsPerGroup = 200
const maxProblems = 20
const linkedIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const consentVersionPattern = /^[A-Za-z0-9_.:-]{1,64}$/
const consentBases = ['consent', 'legitimate_interest', 'contract', 'other']
const signalNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
/** Names that would change the prototype of a plain object if some code later wrote them as a property */
const forbiddenNames = new Set(['__proto__', 'constructor', 'prototype'])

type Result = { ok: true; payload: CollectPayload } | { ok: false; problems: string[] }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function validateGroup(name: string, group: unknown, problems: string[]): void {
  if (!isPlainObject(group)) {
    problems.push(`${name} must be an object`)
    return
  }
  const keys = Object.keys(group)
  if (keys.length > maxSignalsPerGroup) {
    problems.push(`${name} has more than ${maxSignalsPerGroup} signals`)
    return
  }
  for (const key of keys) {
    const where = `${name}.${key.slice(0, 64)}`
    if (!signalNamePattern.test(key) || forbiddenNames.has(key)) {
      problems.push(`${where}: invalid signal name`)
      continue
    }
    const signal = group[key]
    if (!isPlainObject(signal)) {
      problems.push(`${where}: must be an object`)
      continue
    }
    for (const field of Object.keys(signal)) {
      if (field !== 'value' && field !== 'error' && field !== 'duration') {
        problems.push(`${where}: unknown field "${field.slice(0, 32)}"`)
      }
    }
    if (!isFiniteNumber(signal.duration) || signal.duration < 0 || signal.duration > 600_000) {
      problems.push(`${where}: duration must be a number from 0 to 600000`)
    }
    if ('error' in signal) {
      const error = signal.error
      if ('value' in signal) {
        problems.push(`${where}: has both value and error`)
      }
      if (!isPlainObject(error) || typeof error.name !== 'string' || typeof error.message !== 'string') {
        problems.push(`${where}: error must be { name, message }`)
      } else if (error.name.length > 64 || error.message.length > 256) {
        problems.push(`${where}: error is too long`)
      }
    }
  }
}

/**
 * Checks the structure of an untrusted payload. It checks the shape and the sizes, not whether the values are honest:
 * the values are evidence for the later phases to weigh. The total size is limited before this, on the request body.
 */
export function validatePayload(input: unknown): Result {
  const problems: string[] = []
  if (!isPlainObject(input)) {
    return { ok: false, problems: ['the payload must be a JSON object'] }
  }

  if (input.schema !== SUPPORTED_SCHEMA) {
    return { ok: false, problems: [`unsupported schema: ${JSON.stringify(input.schema)?.slice(0, 20)}`] }
  }
  if (typeof input.libVersion !== 'string' || input.libVersion.length > 32) {
    problems.push('libVersion must be a string of at most 32 characters')
  }
  if (!isFiniteNumber(input.collectedAt)) {
    problems.push('collectedAt must be a number')
  }
  if (!isFiniteNumber(input.durationMs) || input.durationMs < 0) {
    problems.push('durationMs must be a non-negative number')
  }
  if ('nonce' in input && (typeof input.nonce !== 'string' || input.nonce.length > 256)) {
    problems.push('nonce must be a string of at most 256 characters')
  }
  if ('linkedId' in input && (typeof input.linkedId !== 'string' || !linkedIdPattern.test(input.linkedId))) {
    problems.push('linkedId must be 1 to 128 characters of letters, digits and _ - . :')
  }
  if ('consent' in input) {
    const consent = input.consent
    if (
      !isPlainObject(consent) ||
      Object.keys(consent).some((key) => key !== 'basis' && key !== 'version') ||
      !consentBases.includes(consent.basis as string) ||
      typeof consent.version !== 'string' ||
      !consentVersionPattern.test(consent.version)
    ) {
      problems.push(
        'consent must be { basis: consent|legitimate_interest|contract|other, version: text of 1 to 64 characters }',
      )
    }
  }
  validateGroup('components', input.components, problems)
  validateGroup('extended', input.extended, problems)

  if (problems.length > 0) {
    return { ok: false, problems: problems.slice(0, maxProblems) }
  }
  return { ok: true, payload: input as unknown as CollectPayload }
}
