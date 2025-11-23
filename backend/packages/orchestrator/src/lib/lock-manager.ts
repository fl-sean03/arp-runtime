export class LockManager {
  private mutexes: Map<string, Promise<void>> = new Map();

  /**
   * Serialize execution of tasks for a given key.
   * Ensures that for a given key, 'fn' is only executed after the previous task for that key has completed.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexes.get(key) || Promise.resolve();
    
    // Create a completion signal for THIS task
    let resolve!: () => void;
    const completion = new Promise<void>(r => { resolve = r; });

    // Chain the next mutex to the current one + our completion
    // We don't want the chain to fail if we fail, so we always resolve completion
    const newMutex = mutex.then(() => completion);
    this.mutexes.set(key, newMutex);

    // Wait for turn
    await mutex;

    try {
      return await fn();
    } finally {
      resolve(); // Signal we are done, allowing next to proceed
      if (this.mutexes.get(key) === newMutex) {
        this.mutexes.delete(key);
      }
    }
  }
}