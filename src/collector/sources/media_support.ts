const mediaTypes = [
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/mp4; codecs="dvh1.05.06"',
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="av01.0.05M.08"',
  'video/ogg; codecs="theora"',
  'video/x-matroska',
  'audio/mpeg',
  'audio/aac',
  'audio/flac',
  'audio/x-m4a',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="ec-3"',
  'audio/webm; codecs="opus"',
  'audio/ogg; codecs="opus"',
  'audio/ogg; codecs="vorbis"',
  'audio/wav; codecs="1"',
  'application/vnd.apple.mpegurl',
]

export type MediaSupport = {
  /** The answer of `canPlayType` for every type: '', 'maybe' or 'probably' */
  canPlayType: Record<string, string>
  /** The types accepted by Media Source Extensions. `null` means MSE doesn't exist. */
  mediaSource: string[] | null
  /** The types accepted by `MediaRecorder`. `null` means `MediaRecorder` doesn't exist. */
  mediaRecorder: string[] | null
}

/**
 * The audio and video formats the browser can decode. It depends on the browser build and, for hardware codecs,
 * on the GPU and the OS. The check is synchronous, side-effect free and doesn't touch the DOM.
 */
export default function getMediaSupport(): MediaSupport {
  const video = document.createElement('video')
  const canPlayType: Record<string, string> = {}
  for (const type of mediaTypes) {
    canPlayType[type] = video.canPlayType(type)
  }

  const { MediaSource, MediaRecorder } = window
  return {
    canPlayType,
    mediaSource:
      typeof MediaSource?.isTypeSupported === 'function'
        ? mediaTypes.filter((type) => MediaSource.isTypeSupported(type))
        : null,
    mediaRecorder:
      typeof MediaRecorder?.isTypeSupported === 'function'
        ? mediaTypes.filter((type) => MediaRecorder.isTypeSupported(type))
        : null,
  }
}
