import getAutomationHints from './automation_hints'

describe('Collector sources', () => {
  describe('automationHints', () => {
    it('returns the shape', () => {
      const result = getAutomationHints()
      expect(Array.isArray(result.globals)).toBe(true)
      expect(Array.isArray(result.documentAttributes)).toBe(true)
      expect(typeof result.hasChromeDriverKeys).toBe('boolean')
      expect(result.outerSize.length).toBe(2)
    })

    it('finds a known automation global', () => {
      const target = window as unknown as Record<string, unknown>
      target._phantom = {}
      try {
        expect(getAutomationHints().globals).toContain('_phantom')
      } finally {
        delete target._phantom
      }
      expect(getAutomationHints().globals).not.toContain('_phantom')
    })

    it('finds a driver attribute and a ChromeDriver key', () => {
      document.documentElement.setAttribute('selenium', '')
      ;(document as unknown as Record<string, unknown>).cdc_adoQpoasnfa76pfcZLmcfl_Array = []
      try {
        const result = getAutomationHints()
        expect(result.documentAttributes).toEqual(['selenium'])
        expect(result.hasChromeDriverKeys).toBe(true)
      } finally {
        document.documentElement.removeAttribute('selenium')
        delete (document as unknown as Record<string, unknown>).cdc_adoQpoasnfa76pfcZLmcfl_Array
      }
      expect(getAutomationHints().hasChromeDriverKeys).toBe(false)
    })
  })
})
