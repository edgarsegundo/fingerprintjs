export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other'

/**
 * A rough guess of the browser from the user agent, only to split a report into groups. It is not used to identify
 * anyone, and a user agent can be faked, so it is not a security signal either.
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
