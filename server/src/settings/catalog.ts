import { ParameterHelp, parameterHelp, readOnlyParameters } from './help'
import { helpPending } from './help_pending'
import type { Kind } from './kinds'
import { Parameter, parameters } from './parameters'
import { describeKind, sectionTitles } from './reference'

/** A kind without functions, so that it can travel as JSON to the settings panel */
export type KindView =
  | { type: 'boolean' }
  | { type: 'integer'; min: number; max: number }
  | { type: 'number'; min: number; max: number; exclusive?: boolean }
  | { type: 'string' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'list'; item: KindView; max?: number }
  | { type: 'map'; value: KindView; keys?: readonly string[] }
  | { type: 'json' }

export function kindView(kind: Kind): KindView {
  switch (kind.type) {
    case 'list':
      return { type: 'list', item: kindView(kind.item), ...(kind.max === undefined ? {} : { max: kind.max }) }
    case 'map':
      return { type: 'map', value: kindView(kind.value), ...(kind.keys === undefined ? {} : { keys: kind.keys }) }
    case 'json':
      return { type: 'json' }
    default:
      return kind
  }
}

export interface CatalogEntry {
  path: string
  /** The first part of the path, such as `identity` */
  group: string
  groupTitle: string
  kind: KindView
  /** The allowed values, in words */
  kindText: string
  default: unknown
  nullable: boolean
  /** The short description of the table of parameters */
  description: string
  /** The long explanation, or `null` while it is not written */
  help: ParameterHelp | null
  /** Shown, not edited: the value holds secrets or has its own editor */
  readOnly: boolean
}

const entryOf = (parameter: Parameter): CatalogEntry => {
  const group = parameter.path.split('.')[0]
  return {
    path: parameter.path,
    group,
    groupTitle: sectionTitles[group] ?? group,
    kind: kindView(parameter.kind),
    kindText: describeKind(parameter.kind),
    default: parameter.default,
    nullable: parameter.nullable === true,
    description: parameter.description,
    help: parameterHelp[parameter.path] ?? null,
    readOnly: readOnlyParameters.has(parameter.path),
  }
}

/** Every parameter, with what the settings panel needs to draw its field and its explanation */
export function buildCatalog(): CatalogEntry[] {
  return parameters.map(entryOf)
}

/** How much of the table has a long explanation, and what is left. It is shown in the panel. */
export function helpCoverage(): { documented: number; total: number; pending: string[] } {
  const pending = parameters.filter((parameter) => !parameterHelp[parameter.path]).map((parameter) => parameter.path)
  return { documented: parameters.length - pending.length, total: parameters.length, pending }
}

/**
 * What is wrong with the bookkeeping of the explanations, as problems (empty when it is right). The three inputs can be
 * given, so that the check itself can be tested with made-up data.
 */
export function helpProblems(
  paths: readonly string[] = parameters.map((parameter) => parameter.path),
  explained: Readonly<Record<string, unknown>> = parameterHelp,
  waiting: readonly string[] = helpPending,
): string[] {
  const problems: string[] = []
  const known = new Set(paths)
  const pending = new Set(waiting)
  for (const path of Object.keys(explained)) {
    if (!known.has(path)) {
      problems.push(`help.ts documents "${path}", which is not a parameter`)
    }
    if (pending.has(path)) {
      problems.push(`"${path}" has an explanation, so it must leave help_pending.ts`)
    }
  }
  for (const path of waiting) {
    if (!known.has(path)) {
      problems.push(`help_pending.ts lists "${path}", which is not a parameter`)
    }
  }
  for (const path of known) {
    if (!explained[path] && !pending.has(path)) {
      problems.push(
        `"${path}" has no explanation: write it in help.ts (or, if it must wait, list it in help_pending.ts)`,
      )
    }
  }
  return problems
}
