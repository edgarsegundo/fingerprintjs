import type { EvalEvent } from './dataset'
import type { UnknownComponents } from './legacy_types'

interface Library {
  hashComponents(components: UnknownComponents): string
}

let library: Library | undefined

/**
 * The visitor id of the original library, computed from the components of a visit.
 * It uses the built bundle of the browser library (`yarn build` first), so the baseline is the real algorithm and not
 * a copy of it that could drift.
 */
export function legacyVisitorId(event: EvalEvent): string {
  if (!library) {
    try {
      // The compiled file is at server/dist/eval/, the bundle at dist/ in the repository root
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      library = require('../../../dist/fp.cjs.js') as Library
    } catch (error) {
      throw new Error(
        `The browser library is not built. Run "yarn build" in the repository root. (${
          error instanceof Error ? error.message : error
        })`,
      )
    }
  }
  return library.hashComponents(event.components as UnknownComponents)
}
