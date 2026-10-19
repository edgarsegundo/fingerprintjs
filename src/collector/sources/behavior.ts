/**
 * An opt-in summary of how the visitor interacted with the page: only COUNTS, never what was typed, where the pointer
 * was, which key was pressed or when each event happened. It exists to tell a person from a script that fills a form
 * without touching the page, and from a script that dispatches synthetic events (`isTrusted` is `false` for those).
 *
 * The observer has to be started early (for example when the page loads) to see anything: `collect` runs when the
 * form is sent, and what happened before must have been counted by then. If it is started by `collect` itself, the
 * summary says it saw almost nothing (`observedMs`), and the server takes that as "unknown", not as "no interaction".
 *
 * It is off by default (`collect({ include: ['behavior'] })`). Counting interaction is still a form of monitoring
 * behavior, so the page that turns it on must say so in its privacy notice.
 */
export interface BehaviorSummary {
  /** How long the observer has been running, in ms */
  observedMs: number
  /** Time from the start of the observer to the first interaction, or `null` if there was none */
  firstInteractionMs: number | null
  /** Pointer moves, clicks, key presses, scrolls and touches that the browser itself produced */
  pointerMoves: number
  clicks: number
  keyPresses: number
  scrolls: number
  touches: number
  /** Events of those kinds that a script created (`isTrusted` is false) */
  syntheticEvents: number
}

const cap = 10_000

const kinds = {
  pointermove: 'pointerMoves',
  click: 'clicks',
  keydown: 'keyPresses',
  wheel: 'scrolls',
  touchstart: 'touches',
} as const

export type Counters = Pick<BehaviorSummary, typeof kinds[keyof typeof kinds] | 'syntheticEvents'>

interface Observer {
  startedAt: number
  firstAt: number | undefined
  counters: Counters
  stop(): void
}

/**
 * Adds one event to the counts. A browser cannot be made to produce a trusted event in a test, so this is a function of
 * plain data, and the listener only passes the event on. Exported for the tests.
 */
export function countEvent(
  state: { firstAt: number | undefined; counters: Counters },
  event: { type: string; isTrusted: boolean },
  now: number,
): void {
  const field = kinds[event.type as keyof typeof kinds]
  if (!field) {
    return
  }
  if (event.isTrusted) {
    state.counters[field] = Math.min(cap, state.counters[field] + 1)
    state.firstAt = state.firstAt ?? now
  } else {
    state.counters.syntheticEvents = Math.min(cap, state.counters.syntheticEvents + 1)
  }
}

let current: Observer | undefined

const emptyCounters = (): Counters => ({
  pointerMoves: 0,
  clicks: 0,
  keyPresses: 0,
  scrolls: 0,
  touches: 0,
  syntheticEvents: 0,
})

/**
 * Starts counting interactions. Calling it again does nothing and returns the same handle.
 * `stop()` removes the listeners and forgets the counts.
 */
export function observeBehavior(): { stop(): void } {
  if (current) {
    return current
  }
  const observer: Observer = {
    startedAt: Date.now(),
    firstAt: undefined,
    counters: emptyCounters(),
    stop() {
      for (const kind of Object.keys(kinds)) {
        window.removeEventListener(kind, listener, { capture: true })
      }
      if (current === observer) {
        current = undefined
      }
    },
  }
  const listener = (event: Event) => countEvent(observer, event, Date.now())
  for (const kind of Object.keys(kinds)) {
    window.addEventListener(kind, listener, { capture: true, passive: true })
  }
  current = observer
  return observer
}

/** The summary of the counts at a moment. A function of plain data, exported for the tests. */
export function summarize(
  state: { startedAt: number; firstAt: number | undefined; counters: Counters },
  now: number,
): BehaviorSummary {
  return {
    observedMs: now - state.startedAt,
    firstInteractionMs: state.firstAt === undefined ? null : state.firstAt - state.startedAt,
    ...state.counters,
  }
}

/** The summary of what the observer has counted so far. It starts the observer if nobody did. */
export default function getBehavior(): BehaviorSummary {
  return summarize(current ?? (observeBehavior() as Observer), Date.now())
}
