import { defined } from '../../../tests/utils'

import getSpeechVoices from './speech_voices'

describe('Collector sources', () => {
  describe('speechVoices', () => {
    it('returns the list of voices or undefined when the API is missing', async () => {
      const promise = getSpeechVoices()
      if (!window.speechSynthesis) {
        expect(promise).toBeUndefined()
        return
      }

      const voices = await promise
      expect(Array.isArray(voices)).toBe(true)
      for (const voice of defined(voices)) {
        expect(typeof voice.name).toBe('string')
        expect(typeof voice.lang).toBe('string')
        expect(typeof voice.local).toBe('boolean')
        expect(typeof voice.default).toBe('boolean')
      }
    }, 5000)

    it('stops waiting when the browser never announces the voices', async () => {
      if (!window.speechSynthesis) {
        return
      }
      spyOn(window.speechSynthesis, 'getVoices').and.returnValue([])
      const startedAt = Date.now()
      expect(await getSpeechVoices()).toEqual([])
      expect(Date.now() - startedAt).toBeLessThan(3000)
    }, 5000)
  })
})
