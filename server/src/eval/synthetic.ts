import type { Dataset, EvalEvent } from './dataset'
import { seededRandom } from './stats'

export interface SyntheticOptions {
  seed: number
  devices: number
  visitsPerDevice: number
  days: number
  /** Chance per day that the browser of a device is updated, which changes the version-dependent components */
  updatesPerDay?: number
  /** Chance that a visit has small noise in a component that is normally stable */
  noiseRate?: number
  /** 0 spreads devices evenly over the attribute values; higher values make a few values very common */
  skew?: number
}

const day = 24 * 60 * 60 * 1000

/**
 * A made-up population with a known truth, used to test the harness: the label of each visit is its device.
 * Devices have attributes drawn from skewed distributions (so some devices look alike, as in reality), and their
 * browsers update over time (so the version-dependent components drift).
 *
 * Nothing measured on this data says anything about the real world. Its only use is to check that the metrics see
 * what was put in: a population that drifts must show instability, and one that does not must not.
 */
export function generateSynthetic(options: SyntheticOptions): Dataset {
  const random = seededRandom(options.seed)
  const skew = options.skew ?? 1.2
  const updatesPerDay = options.updatesPerDay ?? 0.02
  const noiseRate = options.noiseRate ?? 0

  // Zipf-like choice among `size` values
  const pick = (size: number) => {
    const weights = Array.from({ length: size }, (_, index) => 1 / Math.pow(index + 1, skew))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let draw = random() * total
    for (let index = 0; index < size; index++) {
      draw -= weights[index]
      if (draw <= 0) {
        return index
      }
    }
    return size - 1
  }

  const events: EvalEvent[] = []
  const origin = Date.UTC(2026, 0, 1)

  for (let device = 0; device < options.devices; device++) {
    const attributes = {
      platform: pick(3),
      screen: pick(6),
      gpu: pick(10),
      timezone: pick(8),
      languages: pick(5),
      fonts: pick(12),
      canvas: pick(14),
    }
    const browser = pick(3)

    const times = Array.from({ length: options.visitsPerDevice }, () => origin + random() * options.days * day).sort(
      (a, b) => a - b,
    )
    // Version of the browser at each visit: it goes up at random moments
    let version = 100 + pick(5)
    let previous = times[0]
    times.forEach((time, visit) => {
      const elapsedDays = (time - previous) / day
      previous = time
      if (random() < 1 - Math.pow(1 - updatesPerDay, elapsedDays)) {
        version++
      }
      const noisy = random() < noiseRate
      const signal = (value: unknown) => ({ value, duration: 1 })
      // Where the visit came from: usually the device's home network, sometimes another place
      const atHome = random() < 0.8
      const networkId = atHome ? 1000 + device : 5000 + Math.floor(random() * 4000)
      // A resumed TLS session adds an extension, and padding comes and goes: the same browser has several JA4 forms
      const resumed = random() < 0.4
      const padded = random() < 0.3
      const extensions = [`0005`, `000a`, `000b`, `000d`, `0017`, `002b`, `0033`, `ff0${browser}`]
      if (resumed) {
        extensions.push('0029')
      }
      if (padded) {
        extensions.push('0015')
      }
      const ciphers = `cipher${browser}`
      const extensionHash = `ext${browser}${version >= 110 ? 'b' : 'a'}`
      events.push({
        requestId: `syn-${device}-${visit}`,
        receivedAt: Math.round(time),
        label: `device_${device}`,
        components: {
          platform: signal(`platform_${attributes.platform}`),
          screenResolution: signal([attributes.screen, 1080]),
          timezone: signal(`tz_${attributes.timezone}`),
          languages: signal([`lang_${attributes.languages}`]),
          fonts: signal([`fonts_${attributes.fonts}`]),
          canvas: signal({
            winding: true,
            geometry: `geometry_${attributes.canvas}_${attributes.gpu}`,
            text: `text_${attributes.canvas}_${attributes.gpu}`,
          }),
          webGlBasics: signal({
            rendererUnmasked: `gpu_${attributes.gpu}`,
            vendorUnmasked: `vendor_${attributes.gpu % 3}`,
            renderer: 'x',
            vendor: 'y',
          }),
          userAgentData: signal({
            platform: `os_${attributes.platform}`,
            mobile: false,
            brands: [`browser_${browser}`],
            platformVersion: `${version}.0`,
          }),
          math: signal(`math_${version}`),
          screenFrame: signal(noisy ? [Math.floor(random() * 5), 0, 0, 0] : [0, 0, 0, 0]),
        },
        extended: {},
        network: {
          ip: `10.${networkId % 250}.${Math.floor(networkId / 250)}.${1 + Math.floor(random() * 250)}`,
          ipPrefix: `10.${networkId % 250}.${Math.floor(networkId / 250)}.0/24`,
          ja4: `t13d15${extensions.length + 9}h2_${ciphers}_${extensionHash}`,
          ja4r: `t13d15${extensions.length + 9}h2_${ciphers}_${extensions.sort().join(',')}`,
          headerFp: `headers_${browser}`,
          http2Fp: `h2_${browser}`,
          viaProxy: false,
          httpVersion: '2.0',
          ipTags: [],
        },
        userAgent: ['Mozilla/5.0 Chrome/150.0', 'Mozilla/5.0 Firefox/150.0', 'Mozilla/5.0 Version/18.0 Safari/605.1'][
          browser
        ],
      })
    })
  }

  return {
    meta: {
      format: 1,
      source: 'synthetic',
      createdAt: origin,
      ipPseudonymized: true,
      note: `seed ${options.seed}, ${options.devices} devices`,
    },
    events,
  }
}
