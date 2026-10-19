import type { Features } from '../identity/features'

/** How one feature changed between two periods */
export interface FeatureDrift {
  feature: string
  /** Visits with the feature in each period */
  previousVisits: number
  currentVisits: number
  /** Share of the visits of the current period whose value was never seen in the previous one, from 0 to 1 */
  novelty: number | null
  /**
   * Jensen-Shannon divergence between the distributions of the values, from 0 (the same) to 1 (nothing in common).
   * It is symmetric and always defined, unlike the plain KL divergence.
   */
  divergence: number | null
  /** The divergence is at or over the threshold, with enough visits in both periods to trust it */
  drifted: boolean
}

function distribution(items: readonly Features[], feature: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = item[feature]
    if (value !== undefined) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return counts
}

const total = (counts: Map<string, number>): number => [...counts.values()].reduce((sum, count) => sum + count, 0)

/** Jensen-Shannon divergence in base 2 between two sets of counts */
export function jensenShannon(a: Map<string, number>, b: Map<string, number>): number {
  const totalA = total(a)
  const totalB = total(b)
  if (totalA === 0 || totalB === 0) {
    return 0
  }
  let divergence = 0
  for (const value of new Set([...a.keys(), ...b.keys()])) {
    const p = (a.get(value) ?? 0) / totalA
    const q = (b.get(value) ?? 0) / totalB
    const m = (p + q) / 2
    if (p > 0) {
      divergence += 0.5 * p * Math.log2(p / m)
    }
    if (q > 0) {
      divergence += 0.5 * q * Math.log2(q / m)
    }
  }
  // Rounding can leave 1e-17 over the bounds
  return Math.min(1, Math.max(0, divergence))
}

/**
 * Compares the features of two periods, one by one. A feature that shifts without any change in the browsers that
 * visit is a hint that a browser update changed it, or that something spoofs it at scale. The result is a hint for a
 * person to look at, and it says nothing about why.
 *
 * With fewer than `minSamples` visits in either period the divergence is not computed: a handful of visits can differ
 * by chance alone.
 */
export function computeDrift(
  previous: readonly Features[],
  current: readonly Features[],
  options: { threshold: number; minSamples: number },
): FeatureDrift[] {
  const names = new Set<string>()
  for (const item of [...previous, ...current]) {
    Object.keys(item).forEach((name) => names.add(name))
  }
  const result: FeatureDrift[] = []
  for (const feature of names) {
    const before = distribution(previous, feature)
    const now = distribution(current, feature)
    const previousVisits = total(before)
    const currentVisits = total(now)
    const enough = previousVisits >= options.minSamples && currentVisits >= options.minSamples
    let unseen = 0
    for (const [value, count] of now) {
      if (!before.has(value)) {
        unseen += count
      }
    }
    const divergence = enough ? jensenShannon(before, now) : null
    result.push({
      feature,
      previousVisits,
      currentVisits,
      novelty: enough ? unseen / currentVisits : null,
      divergence,
      drifted: divergence !== null && divergence >= options.threshold,
    })
  }
  return result.sort(
    (a, b) =>
      (b.divergence ?? -1) - (a.divergence ?? -1) || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0),
  )
}
