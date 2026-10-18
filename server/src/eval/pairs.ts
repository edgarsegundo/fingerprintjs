import type { EvalEvent } from './dataset'
import { seededRandom } from './stats'

export interface Pair {
  a: EvalEvent
  b: EvalEvent
  same: boolean
  /** Time between the two visits in ms (always positive) */
  gapMs: number
}

export interface PairOptions {
  seed?: number
  /** For a label with many visits, at most this many same-device pairs are used */
  maxPositivePerLabel?: number
  /** At most this many different-device pairs are used */
  maxNegatives?: number
}

/**
 * Builds the pairs that the metrics are measured on: all pairs of visits of one device (those are the cases that
 * should match) and a sample of pairs of visits of different devices (those should not).
 * The sampling is seeded, so the same dataset gives the same report.
 */
export function buildPairs(events: readonly EvalEvent[], options: PairOptions = {}): Pair[] {
  const random = seededRandom(options.seed ?? 1)
  const maxPositivePerLabel = options.maxPositivePerLabel ?? 200
  const maxNegatives = options.maxNegatives ?? 100_000
  const pairs: Pair[] = []

  const byLabel = new Map<string, EvalEvent[]>()
  for (const event of events) {
    byLabel.set(event.label, [...(byLabel.get(event.label) ?? []), event])
  }

  for (const visits of byLabel.values()) {
    const candidates: Array<[EvalEvent, EvalEvent]> = []
    for (let i = 0; i < visits.length; i++) {
      for (let j = i + 1; j < visits.length; j++) {
        candidates.push([visits[i], visits[j]])
      }
    }
    // A random subset when there are too many, keeping the order stable
    while (candidates.length > maxPositivePerLabel) {
      candidates.splice(Math.floor(random() * candidates.length), 1)
    }
    for (const [a, b] of candidates) {
      pairs.push({ a, b, same: true, gapMs: Math.abs(b.receivedAt - a.receivedAt) })
    }
  }

  if (byLabel.size >= 2) {
    // Every pair of visits of different devices is a candidate once. Sampling with replacement would count the same
    // pair many times and make a small dataset look big.
    const all = [...events]
    let crossPairs = (all.length * (all.length - 1)) / 2
    for (const visits of byLabel.values()) {
      crossPairs -= (visits.length * (visits.length - 1)) / 2
    }
    const add = (a: EvalEvent, b: EvalEvent) =>
      pairs.push({ a, b, same: false, gapMs: Math.abs(b.receivedAt - a.receivedAt) })

    if (crossPairs <= maxNegatives) {
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          if (all[i].label !== all[j].label) {
            add(all[i], all[j])
          }
        }
      }
    } else {
      const seen = new Set<number>()
      while (seen.size < maxNegatives) {
        const i = Math.floor(random() * all.length)
        const j = Math.floor(random() * all.length)
        const key = Math.min(i, j) * all.length + Math.max(i, j)
        if (all[i].label !== all[j].label && !seen.has(key)) {
          seen.add(key)
          add(all[i], all[j])
        }
      }
    }
  }
  return pairs
}
