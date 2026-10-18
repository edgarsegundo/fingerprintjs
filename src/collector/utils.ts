/**
 * Rejects with an error named `timeout` if the promise doesn't settle in time.
 * A signal source that hangs must not make the whole collection hang.
 */
export function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const error = new Error(`Timed out after ${timeoutMs}ms`)
      error.name = 'timeout'
      reject(error)
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
}
