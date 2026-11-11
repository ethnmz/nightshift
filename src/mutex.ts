/** Serializes async sections (all remote git operations in one checkout share ref locks). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
