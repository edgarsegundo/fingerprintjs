const voicesWaitMs = 750

export type SpeechVoiceInfo = {
  name: string
  lang: string
  /** `false` means a network voice (e.g. Google voices in Chrome), whose presence depends on the connection */
  local: boolean
  default: boolean
}

/**
 * The installed text-to-speech voices. They depend on the OS, its language packs and the browser.
 * Chrome loads the voice list asynchronously, so the first call often returns an empty list.
 * The list is kept in the order the browser returns it; the server decides how to compare.
 */
export default function getSpeechVoices(): Promise<SpeechVoiceInfo[]> | undefined {
  const synth = window.speechSynthesis
  if (!synth || typeof synth.getVoices !== 'function') {
    return undefined
  }

  const readVoices = () =>
    synth.getVoices().map((voice) => ({
      name: voice.name,
      lang: voice.lang,
      local: voice.localService,
      default: voice.default,
    }))

  return new Promise((resolve) => {
    const initial = readVoices()
    if (initial.length > 0) {
      resolve(initial)
      return
    }

    let isDone = false
    const finish = () => {
      if (!isDone) {
        isDone = true
        synth.removeEventListener('voiceschanged', finish)
        resolve(readVoices())
      }
    }
    synth.addEventListener('voiceschanged', finish)
    setTimeout(finish, voicesWaitMs)
  })
}
