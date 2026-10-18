export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'chromeos'

/**
 * The operating system a user agent string claims. The order of the tests matters: an Android user agent also says
 * "Linux", an iPhone one also says "Mac OS X", and Chrome OS says "X11".
 */
export function platformFromUserAgent(userAgent: string): PlatformFamily | undefined {
  if (/\bAndroid\b/i.test(userAgent)) {
    return 'android'
  }
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) {
    return 'ios'
  }
  if (/\bCrOS\b/.test(userAgent)) {
    return 'chromeos'
  }
  if (/\bWindows\b/i.test(userAgent)) {
    return 'windows'
  }
  if (/\bMacintosh\b|\bMac OS X\b/.test(userAgent)) {
    return 'macos'
  }
  if (/\bLinux\b|\bX11\b/.test(userAgent)) {
    return 'linux'
  }
  return undefined
}

/** What `navigator.platform` says: `Win32`, `MacIntel`, `Linux x86_64`, `iPhone`... */
export function platformFromNavigator(platform: string): PlatformFamily | undefined {
  if (/^Win/i.test(platform)) {
    return 'windows'
  }
  if (/^Mac/i.test(platform)) {
    return 'macos'
  }
  if (/^(iPhone|iPad|iPod)/.test(platform)) {
    return 'ios'
  }
  if (/^CrOS/i.test(platform)) {
    return 'chromeos'
  }
  if (/^Linux/i.test(platform)) {
    return 'linux'
  }
  return undefined
}

/** The value of `Sec-CH-UA-Platform` or of `userAgentData.platform`: `Windows`, `macOS`, `Android`, `Chrome OS`... */
export function platformFromHint(hint: string): PlatformFamily | undefined {
  const value = hint.replace(/"/g, '').trim().toLowerCase()
  switch (value) {
    case 'windows':
      return 'windows'
    case 'macos':
      return 'macos'
    case 'linux':
      return 'linux'
    case 'android':
      return 'android'
    case 'ios':
      return 'ios'
    case 'chrome os':
    case 'chromeos':
      return 'chromeos'
    default:
      return undefined
  }
}

/**
 * Two claims about the platform agree if they can describe the same machine. This is deliberately generous, because a
 * false accusation costs more than a missed one here:
 * - Android and Chrome OS are Linux, and `navigator.platform` says "Linux" on Android;
 * - an iPad can present itself as a Mac (the "desktop site" mode), and then `navigator.platform` says `MacIntel`.
 */
export function platformsAgree(a: PlatformFamily, b: PlatformFamily): boolean {
  if (a === b) {
    return true
  }
  const linuxLike: PlatformFamily[] = ['linux', 'android', 'chromeos']
  if (linuxLike.includes(a) && linuxLike.includes(b)) {
    return true
  }
  return (a === 'macos' && b === 'ios') || (a === 'ios' && b === 'macos')
}
