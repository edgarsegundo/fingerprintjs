import { createHmac } from 'node:crypto'

import type { Features } from '../identity/features'

/**
 * The features that make the key of the shared graph. Only things about the device itself (no address, no connection),
 * and chosen to be steady between visits, because the key is an EXACT match: one changed value is another key.
 * A tenant that drops one of these signals makes keys that no other tenant can match, on purpose.
 */
export const graphKeyFeatures = [
  'canvas',
  'webglRenderer',
  'webglVendor',
  'webglParameters',
  'fonts',
  'screenResolution',
  'colorDepth',
  'hardwareConcurrency',
  'deviceMemory',
  'platform',
  'audio',
  'mediaSupport',
] as const

/**
 * A pseudonymous key for the device, the same in every tenant that takes part, or `undefined` when there is too
 * little to go on (fewer than `minFeatures` of the features above): a key made of two common values would join
 * thousands of unrelated devices.
 *
 * It is an HMAC with a secret that only this deployment has, so the key cannot be computed, or tested against a guess,
 * by anyone outside it. It is not anonymous: for whoever holds the secret it identifies the device across tenants.
 */
export function graphKeyOf(features: Features, secret: string, minFeatures: number): string | undefined {
  const present = graphKeyFeatures.filter((name) => features[name] !== undefined && features[name] !== '')
  if (present.length < minFeatures) {
    return undefined
  }
  const text = present.map((name) => `${name}=${features[name]}`).join('\n')
  return `g_${createHmac('sha256', secret).update('shared-graph-v1\n').update(text).digest('base64url').slice(0, 27)}`
}
