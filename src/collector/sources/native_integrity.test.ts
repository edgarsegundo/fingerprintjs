import { defined } from '../../../tests/utils'

import getNativeIntegrity from './native_integrity'

describe('Collector sources', () => {
  describe('nativeIntegrity', () => {
    it('finds nothing in an unmodified browser', () => {
      const result = getNativeIntegrity()
      expect(result.nonNative).toEqual([])
      expect(result.navigatorOwnProperties).toEqual([])
      expect(result.screenOwnProperties).toEqual([])
      // `missing` may legitimately have items (e.g. an API that the browser lacks) but the core ones must exist
      expect(result.missing).not.toContain('Function.prototype.toString')
      expect(result.missing).not.toContain('Navigator.prototype.userAgent')
    })

    it('detects a property defined straight on navigator', () => {
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Spoofed', configurable: true })
      try {
        expect(getNativeIntegrity().navigatorOwnProperties).toEqual(['userAgent'])
      } finally {
        delete (navigator as unknown as Record<string, unknown>).userAgent
      }
      expect(getNativeIntegrity().navigatorOwnProperties).toEqual([])
    })

    it('detects a replaced getter on the prototype', () => {
      const original = defined(Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform'))
      Object.defineProperty(Navigator.prototype, 'platform', { ...original, get: () => 'Spoofed' })
      try {
        expect(getNativeIntegrity().nonNative).toEqual(['Navigator.prototype.platform'])
      } finally {
        Object.defineProperty(Navigator.prototype, 'platform', original)
      }
      expect(getNativeIntegrity().nonNative).toEqual([])
    })

    it('detects a replaced method', () => {
      const original = HTMLCanvasElement.prototype.toDataURL
      HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
        return ''
      }
      try {
        expect(getNativeIntegrity().nonNative).toEqual(['HTMLCanvasElement.prototype.toDataURL'])
      } finally {
        HTMLCanvasElement.prototype.toDataURL = original
      }
    })
  })
})
