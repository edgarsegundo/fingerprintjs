/** The shape that the browser library hashes: a component is `{ value }` or `{ error }`, plus a duration */
export type UnknownComponents = Record<string, { value?: unknown; error?: unknown; duration: number }>
