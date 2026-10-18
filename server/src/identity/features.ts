import { createHash } from 'node:crypto'

import type { SerializedSignal } from '../ingest/validate'

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
    http2Fp?: string
    viaProxy: boolean
  }
}

/** Present features only: a feature that could not be read is absent, and absence is never evidence */
export type Features = Record<string, string>

interface FeatureSpec {
  volatility: Volatility
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

export const featureSpecs: Record<string, FeatureSpec> = {
  // --- Rendering: hardware and drivers
  canvas: {
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
    volatility: 'stable',
    extract: (input) => {
      const basics = asObject(component(input, 'webGlBasics'))
      const renderer = basics?.rendererUnmasked || basics?.renderer
      return typeof renderer === 'string' && renderer !== '' ? digest(renderer) : undefined
    },
  },
  webglVendor: {
    volatility: 'stable',
    extract: (input) => {
      const basics = asObject(component(input, 'webGlBasics'))
      const vendor = basics?.vendorUnmasked || basics?.vendor
      return typeof vendor === 'string' && vendor !== '' ? digest(vendor) : undefined
    },
  },
  webglParameters: {
    volatility: 'semi',
    extract: (input) => {
      const webgl = asObject(component(input, 'webGlExtensions'))
      return webgl ? digest([webgl.parameters, webgl.shaderPrecisions]) : undefined
    },
  },
  webglExtensions: {
    volatility: 'semi',
    extract: (input) => {
      const webgl = asObject(component(input, 'webGlExtensions'))
      return webgl ? digest([webgl.extensions, webgl.extensionParameters]) : undefined
    },
  },
  audio: { volatility: 'semi', extract: simple('audio', (value) => typeof value === 'number' && value > 0) },
  // --- Fonts and text
  fonts: { volatility: 'stable', extract: simple('fonts', (value) => Array.isArray(value)) },
  fontPreferences: { volatility: 'semi', extract: simple('fontPreferences') },
  // --- Engine
  math: { volatility: 'semi', extract: simple('math') },
  // --- Screen and hardware
  screenResolution: { volatility: 'stable', extract: simple('screenResolution') },
  screenFrame: { volatility: 'volatile', extract: simple('screenFrame') },
  colorDepth: { volatility: 'stable', extract: simple('colorDepth') },
  colorGamut: { volatility: 'stable', extract: simple('colorGamut') },
  hdr: { volatility: 'stable', extract: simple('hdr') },
  touch: { volatility: 'stable', extract: simple('touchSupport') },
  hardwareConcurrency: { volatility: 'stable', extract: simple('hardwareConcurrency') },
  deviceMemory: { volatility: 'stable', extract: simple('deviceMemory') },
  // --- System and browser
  platform: { volatility: 'stable', extract: simple('platform') },
  timezone: { volatility: 'semi', extract: simple('timezone') },
  languages: { volatility: 'semi', extract: simple('languages') },
  vendor: { volatility: 'stable', extract: simple('vendor') },
  plugins: { volatility: 'semi', extract: simple('plugins') },
  architecture: { volatility: 'stable', extract: simple('architecture') },
  userAgentPlatform: {
    volatility: 'stable',
    extract: (input) => {
      const data = asObject(component(input, 'userAgentData'))
      return data ? digest([data.platform, data.mobile, data.architecture, data.bitness, data.model]) : undefined
    },
  },
  userAgentVersion: {
    volatility: 'semi',
    extract: (input) => {
      const data = asObject(component(input, 'userAgentData'))
      return data ? digest([data.brands, data.platformVersion]) : undefined
    },
  },
  preferences: {
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
    volatility: 'semi',
    extract: (input) => {
      const media = extended(input, 'mediaSupport')
      return media === undefined ? undefined : digest(media)
    },
  },
  storageQuota: {
    volatility: 'semi',
    extract: (input) => {
      const quota = extended(input, 'storageQuota')
      // Grouped in powers of two: the quota follows the free disk and drifts a little all the time
      return typeof quota === 'number' && quota > 0 ? String(Math.round(Math.log2(quota))) : undefined
    },
  },
  // --- What only the server sees
  tlsCiphers: {
    volatility: 'stable',
    extract: (input) => input.network.ja4?.split('_')[1],
  },
  tlsExtensions: {
    volatility: 'semi',
    extract: (input) => ja4Normalized(input.network.ja4r),
  },
  tlsVersionAlpn: {
    volatility: 'semi',
    extract: (input) => {
      const a = input.network.ja4?.split('_')[0]
      // Version and ALPN, without the counts that change with session resumption
      return a && a.length === 10 ? `${a.slice(1, 3)}${a.slice(8, 10)}` : undefined
    },
  },
  // The order of the headers and the HTTP/2 data describe the proxy when there is one
  headerOrder: {
    volatility: 'semi',
    extract: (input) => (input.network.viaProxy ? undefined : input.network.headerFp),
  },
  http2: {
    volatility: 'semi',
    extract: (input) => (input.network.viaProxy ? undefined : input.network.http2Fp),
  },
  ipPrefix: { volatility: 'volatile', extract: (input) => input.network.ipPrefix },
  ip: { volatility: 'volatile', extract: (input) => input.network.ip },
}

export const featureNames = Object.keys(featureSpecs)

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
  payload: { components: FeatureInput['components']; extended: FeatureInput['extended'] }
  network: {
    ip: string
    ipPrefix: string
    viaProxy: boolean
    headers: { fp: string }
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
      http2Fp: network.http2?.fp,
      viaProxy: network.viaProxy,
    },
  }
}
