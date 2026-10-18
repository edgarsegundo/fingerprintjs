import type { EvalEvent } from './dataset'
import { legacyVisitorId } from './legacy'

/**
 * Anything that says how likely two visits are the same device, from 0 (surely not) to 1 (surely yes).
 * The matcher of phase 3 will be one more of these, measured on the same data and the same pairs.
 */
export interface Scorer {
  name: string
  description: string
  score(a: EvalEvent, b: EvalEvent): number
}

const cache = new WeakMap<EvalEvent, string>()

function cachedLegacyId(event: EvalEvent): string {
  let id = cache.get(event)
  if (id === undefined) {
    id = legacyVisitorId(event)
    cache.set(event, id)
  }
  return id
}

/** What the original library does: the same hash is a match, anything else is not */
export const legacyHashScorer: Scorer = {
  name: 'legacy-hash',
  description: 'Visitor id of the original library: 1 if the hashes are equal, otherwise 0.',
  score: (a, b) => (cachedLegacyId(a) === cachedLegacyId(b) ? 1 : 0),
}

/**
 * The simplest fuzzy match there is: the share of built-in components that are equal, all weighing the same.
 * It is a floor for the real matcher, not a candidate for it.
 */
export const componentOverlapScorer: Scorer = {
  name: 'component-overlap',
  description: 'Share of built-in components with equal values, all with the same weight. A floor, not a candidate.',
  score: (a, b) => {
    let compared = 0
    let equal = 0
    for (const key of Object.keys(a.components)) {
      const other = b.components[key]
      const mine = a.components[key]
      if (!other || 'error' in mine || 'error' in other) {
        continue
      }
      compared++
      if (JSON.stringify(mine.value) === JSON.stringify(other.value)) {
        equal++
      }
    }
    return compared === 0 ? 0 : equal / compared
  },
}
