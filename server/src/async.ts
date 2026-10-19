/**
 * What a store may answer: the value itself, or a promise of it. The stores that live in the process (memory, SQLite)
 * answer at once, which keeps them fast and keeps their tests plain; a store over the network (MySQL) answers with a
 * promise. Whoever uses a store through its interface waits for the answer in both cases.
 */
export type MaybePromise<T> = T | Promise<T>
