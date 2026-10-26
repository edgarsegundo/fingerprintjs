export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other'

/**
 * A rough guess of the browser family from the user agent. It splits reports into groups and feeds the `browserFamily`
 * feature (evidence that two visits are NOT the same browser, and the condition for a same-machine link). A user agent
 * can be faked, so it is never a security signal.
 */
export function browserOf(userAgent: string | undefined): BrowserFamily {
  if (!userAgent) {
    return 'other'
  }
  if (/\bEdg(e|A|iOS)?\//.test(userAgent)) {
    return 'edge'
  }
  if (/\b(Firefox|FxiOS)\//.test(userAgent)) {
    return 'firefox'
  }
  if (/\b(Chrome|HeadlessChrome|CriOS)\//.test(userAgent)) {
    return 'chrome'
  }
  if (/\bSafari\//.test(userAgent) && /\bVersion\//.test(userAgent)) {
    return 'safari'
  }
  return 'other'
}
