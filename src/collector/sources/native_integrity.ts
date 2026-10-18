import { isFunctionNative } from '../../utils/misc'

// [path of the object, property name]. Each property must be a native method or a native getter.
const checkedProperties: Array<[string, string]> = [
  ['Function.prototype', 'toString'],
  ['Navigator.prototype', 'userAgent'],
  ['Navigator.prototype', 'platform'],
  ['Navigator.prototype', 'hardwareConcurrency'],
  ['Navigator.prototype', 'languages'],
  ['Navigator.prototype', 'webdriver'],
  ['Screen.prototype', 'width'],
  ['HTMLCanvasElement.prototype', 'toDataURL'],
  ['CanvasRenderingContext2D.prototype', 'getImageData'],
  ['WebGLRenderingContext.prototype', 'getParameter'],
  ['Date.prototype', 'getTimezoneOffset'],
  ['Intl.DateTimeFormat.prototype', 'resolvedOptions'],
  ['Permissions.prototype', 'query'],
]

export type NativeIntegrity = {
  /** Properties whose function doesn't look native, e.g. `Navigator.prototype.userAgent` */
  nonNative: string[]
  /** Properties that don't exist where they should. It is normal for some APIs in some browsers. */
  missing: string[]
  /** Own properties of `navigator`. Empty in an unmodified browser: the properties live on the prototype. */
  navigatorOwnProperties: string[]
  /** Own properties of `screen`. Empty in an unmodified browser. */
  screenOwnProperties: string[]
}

function resolvePath(path: string): unknown {
  let current: unknown = window
  for (const part of path.split('.')) {
    current = (current as Record<string, unknown> | undefined)?.[part]
  }
  return current
}

/**
 * Raw evidence of tampering with the browser APIs. Spoofing tools replace getters and methods with their own
 * functions or define the values straight on the instance. None of the results is a verdict: a proxy can imitate
 * the native look, and some extensions (privacy, accessibility) legitimately patch APIs.
 * The server weighs the evidence together with the other signals.
 */
export default function getNativeIntegrity(): NativeIntegrity {
  const nonNative: string[] = []
  const missing: string[] = []

  for (const [path, property] of checkedProperties) {
    const owner = resolvePath(path)
    const descriptor = owner ? Object.getOwnPropertyDescriptor(owner, property) : undefined
    const func = descriptor && (descriptor.get ?? descriptor.value)
    if (typeof func !== 'function') {
      missing.push(`${path}.${property}`)
    } else if (!isFunctionNative(func)) {
      nonNative.push(`${path}.${property}`)
    }
  }

  return {
    nonNative,
    missing,
    navigatorOwnProperties: Object.getOwnPropertyNames(navigator).sort(),
    screenOwnProperties: Object.getOwnPropertyNames(screen).sort(),
  }
}
