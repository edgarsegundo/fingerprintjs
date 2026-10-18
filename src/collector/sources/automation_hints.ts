// Globals that automation frameworks and headless browsers are known to leave in the page.
// The names are publicly documented by the frameworks and by open-source bot detectors.
const automationGlobals = [
  '_phantom',
  'callPhantom',
  '__nightmare',
  'domAutomation',
  'domAutomationController',
  '_Selenium_IDE_Recorder',
  '__webdriver_script_fn',
  '__driver_evaluate',
  '__webdriver_evaluate',
  '__selenium_evaluate',
  '__fxdriver_evaluate',
  '__driver_unwrapped',
  '__webdriver_unwrapped',
  '__selenium_unwrapped',
  '__fxdriver_unwrapped',
  '_WEBDRIVER_ELEM_CACHE',
  '__lastWatirAlert',
  '__lastWatirConfirm',
  '__lastWatirPrompt',
  '$chrome_asyncScriptInfo',
  '__playwright__binding__',
  '__pwInitScripts',
  '__playwright_evaluation_script__',
  '__puppeteer_evaluation_script__',
  'Cypress',
]

const automationAttributes = ['webdriver', 'selenium', 'driver']

export type AutomationHints = {
  /** `navigator.webdriver`, which the WebDriver specification requires to be `true` in automated browsers */
  webdriver?: boolean
  /** The names from the list above that exist in `window` */
  globals: string[]
  /** The attributes of `<html>` set by some drivers */
  documentAttributes: string[]
  /** ChromeDriver leaves properties named `cdc_...` on `document` */
  hasChromeDriverKeys: boolean
  /** `[outerWidth, outerHeight]`. Both are 0 in some headless browsers. */
  outerSize: [number, number]
}

/**
 * Raw traces of browser automation for the server to weigh. They are easy to remove for a determined attacker,
 * so they catch careless automation only. Each trace is cheap, local and has no side effects.
 */
export default function getAutomationHints(): AutomationHints {
  const root = document.documentElement
  return {
    webdriver: navigator.webdriver,
    globals: automationGlobals.filter((name) => name in window),
    documentAttributes: automationAttributes.filter((name) => root.hasAttribute(name)),
    hasChromeDriverKeys: Object.keys(document).some((key) => /^\$?cdc_/.test(key)),
    outerSize: [window.outerWidth, window.outerHeight],
  }
}
