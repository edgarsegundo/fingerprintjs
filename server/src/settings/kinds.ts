/**
 * How the value of a parameter is checked. One small set of kinds is enough for every parameter, and the same
 * description is used to validate a value, to fill the default and to write the reference document.
 */
export type Kind =
  | { type: 'boolean' }
  | { type: 'integer'; min: number; max: number }
  /** `exclusive` excludes the two ends, for probabilities */
  | { type: 'number'; min: number; max: number; exclusive?: boolean }
  | { type: 'string' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'list'; item: Kind; max?: number }
  /** An object with free keys, or with keys from a fixed list */
  | { type: 'map'; value: Kind; keys?: readonly string[] }
  /** Anything with its own rules; the function returns the problem, or `undefined` if the value is fine */
  | { type: 'json'; validate: (value: unknown) => string | undefined }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Returns what is wrong with the value, or `undefined`. The text starts with the expectation, not with the path. */
export function checkValue(kind: Kind, value: unknown): string | undefined {
  switch (kind.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false, without quotes'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= kind.min && value <= kind.max
        ? undefined
        : `must be a whole number from ${kind.min} to ${kind.max}`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'must be a number'
      }
      return (kind.exclusive ? value > kind.min && value < kind.max : value >= kind.min && value <= kind.max)
        ? undefined
        : `must be a number ${kind.exclusive ? 'between' : 'from'} ${kind.min} ${kind.exclusive ? 'and' : 'to'} ${
            kind.max
          }${kind.exclusive ? ' (the ends are not allowed)' : ''}`
    case 'string':
      return typeof value === 'string' ? undefined : 'must be text'
    case 'enum':
      return typeof value === 'string' && kind.values.includes(value)
        ? undefined
        : `must be one of: ${kind.values.join(', ')}`
    case 'list': {
      if (!Array.isArray(value)) {
        return 'must be a list'
      }
      if (kind.max !== undefined && value.length > kind.max) {
        return `must have at most ${kind.max} items`
      }
      for (const [index, item] of value.entries()) {
        const problem = checkValue(kind.item, item)
        if (problem) {
          return `item ${index} ${problem}`
        }
      }
      return undefined
    }
    case 'map': {
      if (!isPlainObject(value)) {
        return 'must be an object'
      }
      for (const [key, item] of Object.entries(value)) {
        if (kind.keys && !kind.keys.includes(key)) {
          return `has an unknown key "${key.slice(0, 40)}"${suggestion(key, kind.keys)}`
        }
        const problem = checkValue(kind.value, item)
        if (problem) {
          return `"${key.slice(0, 40)}" ${problem}`
        }
      }
      return undefined
    }
    case 'json':
      return kind.validate(value)
  }
}

/** The number of single-character edits between two words */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/** ` (did you mean "x"?)` for the closest known name, or nothing if none is close enough to be a typo */
export function suggestion(name: string, known: readonly string[]): string {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(name.length / 4))
    ? ` (did you mean "${best}"?)`
    : ''
}
