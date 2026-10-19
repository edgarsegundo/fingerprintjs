import { readFileSync, statSync } from 'node:fs'

import type { Settings } from '../settings/settings'

import { defaultModel, Model, parseModel } from './model'

type IdentitySettings = Settings['identity']

/**
 * Puts the settings of a tenant over a model. A setting that is `null` leaves what the model says, so a fitted model is
 * not overruled by a default that nobody chose. The order is: built-in values, then the model file, then the settings.
 *
 * The provisional scale (`scale` and `offset`) is applied only while the model is not calibrated: a calibrated model
 * carries the scale that was fitted on data, and replacing it would throw that work away.
 */
export function applyIdentitySettings(model: Model, settings: IdentitySettings): Model {
  const defaultM = { ...model.defaultM }
  for (const level of ['stable', 'semi', 'volatile'] as const) {
    const value = settings.defaultM[level]
    if (value !== null) {
      defaultM[level] = value
    }
  }
  const disagreementFloor = { ...model.disagreementFloor }
  for (const level of ['stable', 'semi', 'volatile'] as const) {
    const value = settings.disagreementFloor[level]
    if (value !== null) {
      disagreementFloor[level] = value
    }
  }
  const volatility = { ...model.volatility, ...settings.featureVolatility }
  return {
    ...model,
    m: { ...model.m, ...settings.featureM },
    defaultM,
    disagreementFloor,
    ...(Object.keys(volatility).length > 0 ? { volatility } : {}),
    maxWeight: settings.maxWeight ?? model.maxWeight,
    matchProbability: settings.matchProbability ?? model.matchProbability,
    platt: model.calibrated ? model.platt : { a: settings.scale ?? model.platt.a, b: settings.offset ?? model.platt.b },
  }
}

/**
 * The model of each tenant. Model files are read once and again only when the file changes, so a new model takes
 * effect without a restart, and a tenant without a model file uses the base model.
 */
export class ModelCatalog {
  private readonly files = new Map<string, { modifiedAt: number; model: Model }>()

  constructor(private readonly base: Model = defaultModel()) {}

  /** The model for a tenant, with its settings applied. Throws if the model file cannot be read or is wrong. */
  modelFor(settings: IdentitySettings): Model {
    return applyIdentitySettings(this.file(settings.modelFile), settings)
  }

  private file(path: string | null): Model {
    if (path === null) {
      return this.base
    }
    const modifiedAt = statSync(path).mtimeMs
    const cached = this.files.get(path)
    if (cached && cached.modifiedAt === modifiedAt) {
      return cached.model
    }
    const model = parseModel(JSON.parse(readFileSync(path, 'utf8')))
    this.files.set(path, { modifiedAt, model })
    return model
  }

  /** Reads every model file named in the settings now, to find a wrong one at start and not at the first visit */
  preload(settingsList: IdentitySettings[]): void {
    for (const settings of settingsList) {
      this.modelFor(settings)
    }
  }
}
