import { createHash } from 'node:crypto'

import type { SerializedSignal } from '../ingest/validate'
import { browserOf } from '../net/browser'
import { coreHeaderFp } from '../net/headers'

/**
 * How often a feature of the same device changes between visits:
 * - stable: only a hardware or system change (GPU, fonts after an install)
 * - semi: changes with updates or settings (browser version, OS version, zoom)
 * - volatile: changes with the place (network address, a window position)
 */
export type Volatility = 'stable' | 'semi' | 'volatile'

/** What a visit looks like to the matcher. Both a stored event and a row of a dataset can be turned into this. */
export interface FeatureInput {
  components: Record<string, SerializedSignal>
  extended: Record<string, SerializedSignal>
  network: {
    ip?: string
    ipPrefix?: string
    ja4?: string
    ja4r?: string
    headerFp?: string
    /** The names of the headers in the order received (lower case, without proxy headers) */
    headerNames?: readonly string[]
    http2Fp?: string
    viaProxy: boolean
    /** The `user-agent` header, as the browser sent it */
    userAgent?: string
  }
}

/** Present features only: a feature that could not be read is absent, and absence is never evidence */
export type Features = Record<string, string>

/**
 * What a feature describes, which decides whether it can say two browsers are on the same machine:
 * - machine: the same on one machine whatever the browser (screen, system time zone, local voices, graphics family)
 * - browser: the engine, its version, its network stack or its storage; a different browser on the same machine differs
 * - network: where the visit came from
 */
export type FeatureScope = 'machine' | 'browser' | 'network'

interface FeatureSpec {
  scope: FeatureScope
  volatility: Volatility
  /**
   * True for a value that is made up for one device and shared with no other, such as the random code that the page
   * stores in the browser. Agreeing on it is worth the most that a feature can be worth, whatever the population says.
   */
  identifier?: boolean
  /** True for a feature that is no longer read (it never has a value) but whose name stays valid in saved settings */
  retired?: boolean
  extract(input: FeatureInput): string | undefined
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function valueOf(signal: SerializedSignal | undefined): unknown {
  return signal && !signal.error ? signal.value : undefined
}

const component = (input: FeatureInput, name: string) => valueOf(input.components[name])
const extended = (input: FeatureInput, name: string) => valueOf(input.extended[name])
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Simple value → token, absent when the value is missing or a "not available" marker */
function simple(name: string, isUsable: (value: unknown) => boolean = () => true) {
  return (input: FeatureInput): string | undefined => {
    const value = component(input, name)
    return value === undefined || value === null || !isUsable(value) ? undefined : digest(value)
  }
}

/** The values that the built-in sources use when they decided not to read the browser (Safari 17+, Firefox 120+) */
const skippedImage = new Set(['skipped', 'unsupported', 'unstable'])

/**
 * The JA4 without the parts that change between connections of the same browser. Verified with Chrome 155: a resumed
 * TLS session adds the extension 0x0029 (pre_shared_key), and padding (0x0015) depends on the length of the hello.
 * Both change the extension list and so the whole JA4 `c` part.
 */
export function ja4Normalized(ja4r: string | undefined): string | undefined {
  if (!ja4r) {
    return undefined
  }
  const parts = ja4r.split('_')
  if (parts.length < 3) {
    return undefined
  }
  const extensions = parts[2]
    .split(',')
    .filter((extension) => extension !== '' && extension !== '0029' && extension !== '0015')
  const signatures = parts[3]
  return digest([extensions, signatures ?? ''])
}

/** The kind of graphics card named by a renderer string. `software` is drawing without a card (SwiftShader). */
export function gpuFamilyOf(renderer: string): string {
  const text = renderer.toLowerCase()
  if (/swiftshader|llvmpipe|software|basic render/.test(text)) {
    return 'software'
  }
  if (/apple/.test(text)) {
    return 'apple'
  }
  if (/nvidia|geforce|quadro/.test(text)) {
    return 'nvidia'
  }
  if (/\bamd\b|radeon|\bati\b/.test(text)) {
    return 'amd'
  }
  if (/intel/.test(text)) {
    return 'intel'
  }
  if (/qualcomm|adreno/.test(text)) {
    return 'qualcomm'
  }
  if (/\bmali\b|\barm\b/.test(text)) {
    return 'arm'
  }
  return 'other'
}

export const featureSpecs: Record<string, FeatureSpec> = {
  // --- Rendering: hardware and drivers
  canvas: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const canvas = asObject(component(input, 'canvas'))
      if (!canvas || skippedImage.has(String(canvas.geometry)) || skippedImage.has(String(canvas.text))) {
        return undefined
      }
      return digest([canvas.geometry, canvas.text])
    },
  },
  webglRenderer: {
    scope: 'browser',
    volatility: 'stable',
    extract: (input) => {
      const basics = asObject(component(input, 'webGlBasics'))
      const renderer = basics?.rendererUnmasked || basics?.renderer
      return typeof renderer === 'string' && renderer !== '' ? digest(renderer) : undefined
    },
  },
  webglVendor: {
    scope: 'browser',
    volatility: 'stable',
    extract: (input) => {
      const basics = asObject(component(input, 'webGlBasics'))
      const vendor = basics?.vendorUnmasked || basics?.vendor
      return typeof vendor === 'string' && vendor !== '' ? digest(vendor) : undefined
    },
  },
  webglParameters: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const webgl = asObject(component(input, 'webGlExtensions'))
      return webgl ? digest([webgl.parameters, webgl.shaderPrecisions]) : undefined
    },
  },
  webglExtensions: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const webgl = asObject(component(input, 'webGlExtensions'))
      return webgl ? digest([webgl.extensions, webgl.extensionParameters]) : undefined
    },
  },
  audio: {
    scope: 'browser',
    volatility: 'semi',
    extract: simple('audio', (value) => typeof value === 'number' && value > 0),
  },
  // --- Fonts and text
  fonts: {
    scope: 'browser',
    volatility: 'stable',
    extract: simple('fonts', (value) => Array.isArray(value)),
  },
  fontPreferences: {
    scope: 'browser',
    volatility: 'semi',
    extract: simple('fontPreferences'),
  },
  // --- Engine
  math: {
    scope: 'browser',
    volatility: 'semi',
    extract: simple('math'),
  },
  // --- Screen and hardware
  screenResolution: {
    scope: 'machine',
    volatility: 'stable',
    extract: simple('screenResolution'),
  },
  screenFrame: {
    scope: 'browser',
    volatility: 'volatile',
    extract: simple('screenFrame'),
  },
  colorDepth: {
    scope: 'machine',
    volatility: 'stable',
    extract: simple('colorDepth'),
  },
  colorGamut: {
    scope: 'machine',
    volatility: 'stable',
    extract: simple('colorGamut'),
  },
  hdr: {
    scope: 'machine',
    volatility: 'stable',
    extract: simple('hdr'),
  },
  touch: {
    scope: 'browser',
    volatility: 'stable',
    extract: simple('touchSupport'),
  },
  hardwareConcurrency: {
    scope: 'browser',
    volatility: 'stable',
    extract: simple('hardwareConcurrency'),
  },
  deviceMemory: {
    scope: 'browser',
    volatility: 'stable',
    extract: simple('deviceMemory'),
  },
  // --- System and browser
  platform: {
    scope: 'machine',
    volatility: 'stable',
    extract: simple('platform'),
  },
  timezone: {
    scope: 'machine',
    volatility: 'semi',
    extract: simple('timezone'),
  },
  languages: {
    scope: 'browser',
    volatility: 'semi',
    extract: simple('languages'),
  },
  vendor: {
    scope: 'browser',
    volatility: 'stable',
    extract: simple('vendor'),
  },
  plugins: {
    scope: 'browser',
    volatility: 'semi',
    extract: simple('plugins'),
  },
  architecture: {
    scope: 'browser',
    volatility: 'stable',
    extract: simple('architecture'),
  },
  userAgentPlatform: {
    scope: 'browser',
    volatility: 'stable',
    extract: (input) => {
      const data = asObject(component(input, 'userAgentData'))
      return data ? digest([data.platform, data.mobile, data.architecture, data.bitness, data.model]) : undefined
    },
  },
  userAgentVersion: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const data = asObject(component(input, 'userAgentData'))
      return data ? digest([data.brands, data.platformVersion]) : undefined
    },
  },
  preferences: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) =>
      digest(
        ['invertedColors', 'forcedColors', 'monochrome', 'contrast', 'reducedMotion', 'reducedTransparency'].map(
          (name) => component(input, name),
        ),
      ),
  },
  // --- Extra signals of the collector
  speechVoices: {
    scope: 'machine',
    volatility: 'semi',
    extract: (input) => {
      const voices = extended(input, 'speechVoices')
      if (!Array.isArray(voices) || voices.length === 0) {
        return undefined
      }
      // Network voices come and go with the connection, so only the local ones identify the machine
      const local = voices
        .filter((voice) => asObject(voice)?.local === true)
        .map((voice) => [asObject(voice)?.name, asObject(voice)?.lang])
      return local.length === 0 ? undefined : digest(local.sort())
    },
  },
  mediaSupport: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const media = extended(input, 'mediaSupport')
      return media === undefined ? undefined : digest(media)
    },
  },
  storageQuota: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const quota = extended(input, 'storageQuota')
      // Grouped in powers of two: the quota follows the free disk and drifts a little all the time
      return typeof quota === 'number' && quota > 0 ? String(Math.round(Math.log2(quota))) : undefined
    },
  },
  // --- What only the server sees
  tlsCiphers: {
    scope: 'browser',
    volatility: 'stable',
    extract: (input) => input.network.ja4?.split('_')[1],
  },
  tlsExtensions: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => ja4Normalized(input.network.ja4r),
  },
  tlsVersionAlpn: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => {
      const a = input.network.ja4?.split('_')[0]
      // Version and ALPN, without the counts that change with session resumption
      return a && a.length === 10 ? `${a.slice(1, 3)}${a.slice(8, 10)}` : undefined
    },
  },
  // Retired: it hashed every header and its casing, so it changed inside one browser (cache headers, HTTP/1 vs 2).
  // The name stays so that saved settings that mention it are still valid. `headerCore` replaces it.
  headerOrder: {
    scope: 'browser',
    volatility: 'semi',
    retired: true,
    extract: () => undefined,
  },
  // The order of the headers and the HTTP/2 data describe the proxy when there is one
  headerCore: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) =>
      input.network.viaProxy || !input.network.headerNames ? undefined : coreHeaderFp(input.network.headerNames),
  },
  http2: {
    scope: 'browser',
    volatility: 'semi',
    extract: (input) => (input.network.viaProxy ? undefined : input.network.http2Fp),
  },
  // The family of the browser (chrome, firefox...): the same machine in another browser is a different browser here
  browserFamily: {
    scope: 'browser',
    volatility: 'stable',
    extract: (input) => (input.network.userAgent ? browserOf(input.network.userAgent) : undefined),
  },
  // The kind of graphics card, from the strings that every browser gives in its own words ("ANGLE (Intel Inc., ...)",
  // "Intel(R) HD Graphics 400, or similar", "Apple GPU"), so that it can be the same in two browsers of one machine
  gpuFamily: {
    scope: 'machine',
    volatility: 'stable',
    extract: (input) => {
      const basics = asObject(component(input, 'webGlBasics'))
      const renderer = basics?.rendererUnmasked || basics?.renderer
      return typeof renderer === 'string' && renderer !== '' ? gpuFamilyOf(renderer) : undefined
    },
  },
  // The random code the page keeps in the browser (cookie, local storage, IndexedDB). Clearing the site data loses it,
  // so a different or missing code is weak evidence, and the same code is the strongest there is.
  storedId: {
    scope: 'browser',
    volatility: 'volatile',
    identifier: true,
    extract: (input) => {
      const token = asObject(extended(input, 'storedId'))?.token
      return typeof token === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(token) ? digest(token) : undefined
    },
  },
  ipPrefix: {
    scope: 'network',
    volatility: 'volatile',
    extract: (input) => input.network.ipPrefix,
  },
  ip: {
    scope: 'network',
    volatility: 'volatile',
    extract: (input) => input.network.ip,
  },
}

export const featureNames = Object.keys(featureSpecs)

/** Whether the feature is a code made up for one device (see `FeatureSpec.identifier`) */
export function isIdentifier(feature: string): boolean {
  return featureSpecs[feature]?.identifier === true
}

export function scopeOf(feature: string): FeatureScope {
  return featureSpecs[feature]?.scope ?? 'browser'
}

export function volatilityOf(feature: string): Volatility {
  return featureSpecs[feature]?.volatility ?? 'volatile'
}

/** The features that this visit could provide. A feature that failed to read is simply not there. */
export function extractFeatures(input: FeatureInput): Features {
  const features: Features = {}
  for (const name of featureNames) {
    let value: string | undefined
    try {
      value = featureSpecs[name].extract(input)
    } catch {
      value = undefined
    }
    if (value !== undefined && value !== '') {
      features[name] = value
    }
  }
  return features
}

/** The input of the matcher for an event that was stored by the server */
export function featureInputOf(event: {
  payload: {
    components: FeatureInput['components']
    extended: FeatureInput['extended']
  }
  network: {
    ip: string
    ipPrefix: string
    viaProxy: boolean
    headers: { fp: string; order?: string[]; values?: Record<string, string> }
    tls?: { ja4: string; ja4_r?: string }
    http2?: { fp: string }
  }
}): FeatureInput {
  const { payload, network } = event
  return {
    components: payload.components,
    extended: payload.extended,
    network: {
      ip: network.ip,
      ipPrefix: network.ipPrefix,
      ja4: network.tls?.ja4,
      ja4r: network.tls?.ja4_r,
      headerFp: network.headers.fp,
      headerNames: network.headers.order,
      userAgent: network.headers.values?.['user-agent'],
      http2Fp: network.http2?.fp,
      viaProxy: network.viaProxy,
    },
  }
}
