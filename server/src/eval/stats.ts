export interface Interval {
  /** The measured proportion, 0 to 1. `NaN` when there is nothing to measure (n = 0). */
  value: number
  low: number
  high: number
  /** How many cases it was measured on */
  n: number
  /** How many devices those cases come from. Only set by `clusterInterval`. */
  clusters?: number
}

/**
 * A proportion with its 95% confidence interval (Wilson score). Unlike the textbook formula it behaves at 0 and at n:
 * zero false matches in 30 pairs does not mean a rate of 0, it means "at most about 11%". That is what makes a small
 * dataset honest.
 */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) {
    return { value: NaN, low: NaN, high: NaN, n }
  }
  const p = successes / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { value: p, low: Math.max(0, center - half), high: Math.min(1, center + half), n }
}

/** Shannon entropy in bits of a distribution given by counts */
export function shannonEntropyBits(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0) {
    return 0
  }
  let bits = 0
  for (const count of counts) {
    if (count > 0) {
      const p = count / total
      bits -= p * Math.log2(p)
    }
  }
  return bits
}

/**
 * The "rule of three": with zero errors seen in n independent trials, the true error rate is below 3/n
 * with 95% confidence. It tells how many trials are needed to claim a given rate.
 */
export function ruleOfThree(n: number): number {
  return n === 0 ? NaN : 3 / n
}

/** The area under the ROC curve: the chance that a random same-device pair scores above a random different pair */
export function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) {
    return NaN
  }
  const all = [
    ...positives.map((score) => ({ score, positive: true })),
    ...negatives.map((score) => ({ score, positive: false })),
  ].sort((a, b) => a.score - b.score)

  // Ranks start at 1; equal scores share the average rank, so ties count as half
  let positiveRankSum = 0
  for (let start = 0; start < all.length; ) {
    let end = start
    while (end + 1 < all.length && all[end + 1].score === all[start].score) {
      end++
    }
    const averageRank = (start + end) / 2 + 1
    for (let index = start; index <= end; index++) {
      if (all[index].positive) {
        positiveRankSum += averageRank
      }
    }
    start = end + 1
  }
  const p = positives.length
  const n = negatives.length
  return (positiveRankSum - (p * (p + 1)) / 2) / (p * n)
}

export interface RocPoint {
  /** A pair is called "same device" when its score is greater than or equal to this */
  threshold: number
  /** False match rate: different devices called the same */
  fmr: number
  /** False non-match rate: the same device called different */
  fnmr: number
}

function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle] < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/** The error rates at every distinct score, sorted by threshold */
export function rocCurve(positives: readonly number[], negatives: readonly number[]): RocPoint[] {
  const sortedPositives = [...positives].sort((a, b) => a - b)
  const sortedNegatives = [...negatives].sort((a, b) => a - b)
  const thresholds = [...new Set([...positives, ...negatives])].sort((a, b) => a - b)
  // One more threshold above every score: nothing is called "same"
  thresholds.push(Number.POSITIVE_INFINITY)
  return thresholds.map((threshold) => ({
    threshold,
    fnmr: sortedPositives.length === 0 ? NaN : lowerBound(sortedPositives, threshold) / sortedPositives.length,
    fmr:
      sortedNegatives.length === 0
        ? NaN
        : (sortedNegatives.length - lowerBound(sortedNegatives, threshold)) / sortedNegatives.length,
  }))
}

/** Where the two error rates are equal (the closest point of the curve) */
export function equalErrorRate(points: readonly RocPoint[]): { rate: number; threshold: number } {
  let best: RocPoint | undefined
  for (const point of points) {
    if (Number.isNaN(point.fmr) || Number.isNaN(point.fnmr)) {
      continue
    }
    if (!best || Math.abs(point.fmr - point.fnmr) < Math.abs(best.fmr - best.fnmr)) {
      best = point
    }
  }
  return best ? { rate: (best.fmr + best.fnmr) / 2, threshold: best.threshold } : { rate: NaN, threshold: NaN }
}

/** The point with the lowest FNMR among those whose FMR does not exceed the target */
export function operatingPointAtFmr(points: readonly RocPoint[], targetFmr: number): RocPoint | undefined {
  let best: RocPoint | undefined
  for (const point of points) {
    if (point.fmr <= targetFmr && (!best || point.fnmr < best.fnmr)) {
      best = point
    }
  }
  return best
}

/** Mulberry32, a small seeded generator, so that the sampling of pairs is the same on every run */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ClusterOutcome {
  /** The devices of the pair. Equal for a pair of two visits of one device. */
  a: string
  b: string
  /** Whether the event being counted happened (an error, for FNMR and FMR) */
  hit: boolean
}

/**
 * A proportion over pairs of visits with a 95% interval that accounts for the pairs not being independent.
 *
 * Pairs that share a device share its quirks: ten pairs of one odd phone are not ten independent trials. A plain
 * interval over pairs would be far too narrow. This one resamples whole devices (a cluster bootstrap), so the width
 * depends on how many devices there are, which is the number that really limits what can be claimed.
 *
 * - With fewer than `minClusters` devices the interval is 0 to 1: the data cannot say.
 * - With no hits, or only hits, a bootstrap would give a zero-width interval; the bound is taken from a Wilson interval
 *   that counts each device as one trial, which is conservative.
 */
export function clusterInterval(
  outcomes: readonly ClusterOutcome[],
  options: { seed?: number; resamples?: number; minClusters?: number } = {},
): Interval {
  const { seed = 1, resamples = 300, minClusters = 10 } = options
  const n = outcomes.length
  if (n === 0) {
    return { value: NaN, low: NaN, high: NaN, n, clusters: 0 }
  }
  const index = new Map<string, number>()
  for (const { a, b } of outcomes) {
    for (const label of [a, b]) {
      if (!index.has(label)) {
        index.set(label, index.size)
      }
    }
  }
  const clusters = index.size
  const hits = outcomes.filter((outcome) => outcome.hit).length
  const value = hits / n

  if (clusters < minClusters) {
    return { value, low: 0, high: 1, n, clusters }
  }
  if (hits === 0 || hits === n) {
    const bound = wilson(Math.round(value * clusters), clusters)
    return { value, low: bound.low, high: bound.high, n, clusters }
  }

  const random = seededRandom(seed)
  const pairs = outcomes.map((outcome) => ({
    a: index.get(outcome.a) as number,
    b: index.get(outcome.b) as number,
    hit: outcome.hit,
  }))
  const proportions: number[] = []
  const multiplicity = new Array<number>(clusters)
  for (let resample = 0; resample < resamples; resample++) {
    multiplicity.fill(0)
    for (let draw = 0; draw < clusters; draw++) {
      multiplicity[Math.floor(random() * clusters)]++
    }
    let weight = 0
    let weightedHits = 0
    for (const pair of pairs) {
      const w = pair.a === pair.b ? multiplicity[pair.a] : multiplicity[pair.a] * multiplicity[pair.b]
      weight += w
      if (pair.hit) {
        weightedHits += w
      }
    }
    if (weight > 0) {
      proportions.push(weightedHits / weight)
    }
  }
  proportions.sort((x, y) => x - y)
  const at = (quantile: number) =>
    proportions[Math.min(proportions.length - 1, Math.floor(quantile * proportions.length))]
  return { value, low: at(0.025), high: at(0.975), n, clusters }
}
