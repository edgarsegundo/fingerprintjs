import getMediaSupport from './media_support'

describe('Collector sources', () => {
  describe('mediaSupport', () => {
    it('answers for every media type', () => {
      const result = getMediaSupport()
      const answers = Object.values(result.canPlayType)
      expect(answers.length).toBeGreaterThan(20)
      for (const answer of answers) {
        expect(['', 'maybe', 'probably']).toContain(answer)
      }
      // Every browser decodes at least one of the common audio formats
      expect(answers.some((answer) => answer !== '')).toBe(true)
    })

    it('lists the supported types only, or null without the API', () => {
      const result = getMediaSupport()
      for (const list of [result.mediaSource, result.mediaRecorder]) {
        if (list !== null) {
          for (const type of list) {
            expect(type in result.canPlayType).toBe(true)
          }
        }
      }
      expect(result.mediaSource === null).toBe(typeof window.MediaSource?.isTypeSupported !== 'function')
    })

    it('is stable', () => {
      expect(getMediaSupport()).toEqual(getMediaSupport())
    })
  })
})
