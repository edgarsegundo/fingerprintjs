import getBehavior, { countEvent, observeBehavior, summarize } from './behavior'

describe('Collector sources', () => {
  describe('behavior', () => {
    let handle: { stop(): void } | undefined

    afterEach(() => {
      handle?.stop()
      handle = undefined
    })

    it('has the shape, and only counts', () => {
      handle = observeBehavior()
      const summary = getBehavior()
      expect(Object.keys(summary).sort()).toEqual([
        'clicks',
        'firstInteractionMs',
        'keyPresses',
        'observedMs',
        'pointerMoves',
        'scrolls',
        'syntheticEvents',
        'touches',
      ])
      for (const value of Object.values(summary)) {
        expect(value === null || typeof value === 'number').toBe(true)
      }
      expect(summary.firstInteractionMs).toBeNull()
    })

    it('counts a script-made event as synthetic and not as an interaction', () => {
      handle = observeBehavior()
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      const summary = getBehavior()
      expect(summary.syntheticEvents).toBe(2)
      expect(summary.clicks).toBe(0)
      expect(summary.keyPresses).toBe(0)
      expect(summary.firstInteractionMs).toBeNull()
    })

    it('ignores events of other kinds', () => {
      handle = observeBehavior()
      document.body.dispatchEvent(new Event('input', { bubbles: true }))
      document.body.dispatchEvent(new Event('change', { bubbles: true }))
      expect(getBehavior().syntheticEvents).toBe(0)
    })

    it('starts once, and stopping forgets the counts and removes the listeners', () => {
      handle = observeBehavior()
      expect(observeBehavior()).toBe(handle)
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(getBehavior().syntheticEvents).toBe(1)
      handle.stop()
      handle = undefined
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      handle = observeBehavior()
      expect(getBehavior().syntheticEvents).toBe(0)
    })

    it('starts the observer by itself, and then it has seen almost nothing', () => {
      const summary = getBehavior()
      expect(summary.observedMs).toBeLessThan(1000)
      expect(summary.firstInteractionMs).toBeNull()
      handle = observeBehavior() // the same observer that getBehavior started
    })

    it('removes its listeners when it stops', () => {
      const remove = spyOn(window, 'removeEventListener').and.callThrough()
      handle = observeBehavior()
      handle.stop()
      handle = undefined
      const removed = remove.calls.allArgs().map(([type]) => type)
      for (const type of ['pointermove', 'click', 'keydown', 'wheel', 'touchstart']) {
        expect(removed).toContain(type)
      }
    })

    describe('summary', () => {
      const counters = { pointerMoves: 3, clicks: 1, keyPresses: 2, scrolls: 0, touches: 0, syntheticEvents: 0 }

      it('measures the time since the start, and until the first interaction', () => {
        expect(summarize({ startedAt: 1000, firstAt: 1400, counters }, 6000)).toEqual({
          observedMs: 5000,
          firstInteractionMs: 400,
          ...counters,
        })
      })

      it('says null, not zero, when nothing happened', () => {
        expect(summarize({ startedAt: 1000, firstAt: undefined, counters }, 2000).firstInteractionMs).toBeNull()
      })
    })

    describe('counting', () => {
      const fresh = () => ({
        firstAt: undefined as number | undefined,
        counters: { pointerMoves: 0, clicks: 0, keyPresses: 0, scrolls: 0, touches: 0, syntheticEvents: 0 },
      })

      it('counts each kind of event the browser produced, and remembers when the first one came', () => {
        const state = fresh()
        countEvent(state, { type: 'pointermove', isTrusted: true }, 100)
        countEvent(state, { type: 'pointermove', isTrusted: true }, 150)
        countEvent(state, { type: 'click', isTrusted: true }, 200)
        countEvent(state, { type: 'keydown', isTrusted: true }, 210)
        countEvent(state, { type: 'wheel', isTrusted: true }, 220)
        countEvent(state, { type: 'touchstart', isTrusted: true }, 230)
        expect(state.counters).toEqual({
          pointerMoves: 2,
          clicks: 1,
          keyPresses: 1,
          scrolls: 1,
          touches: 1,
          syntheticEvents: 0,
        })
        expect(state.firstAt).toBe(100)
      })

      it('counts a made-up event apart, and it is not the first interaction', () => {
        const state = fresh()
        countEvent(state, { type: 'click', isTrusted: false }, 100)
        expect(state.counters.clicks).toBe(0)
        expect(state.counters.syntheticEvents).toBe(1)
        expect(state.firstAt).toBeUndefined()
      })

      it('ignores other kinds of event and stops counting at the cap', () => {
        const state = fresh()
        countEvent(state, { type: 'input', isTrusted: true }, 1)
        expect(state.firstAt).toBeUndefined()
        state.counters.clicks = 10_000
        state.counters.syntheticEvents = 10_000
        countEvent(state, { type: 'click', isTrusted: true }, 1)
        countEvent(state, { type: 'click', isTrusted: false }, 1)
        expect(state.counters.clicks).toBe(10_000)
        expect(state.counters.syntheticEvents).toBe(10_000)
      })
    })

    it('does not carry the content of the events', () => {
      handle = observeBehavior()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'secret-password' }))
      expect(JSON.stringify(getBehavior())).not.toContain('secret')
    })
  })
})
