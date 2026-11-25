/** An answer that took longer than its limit. */
export class Timeout extends Error {}

/** The promise's outcome, or a Timeout rejection after `ms`; the promise itself keeps running. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout('timeout')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
