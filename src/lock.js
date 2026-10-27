// Sérialise les opérations d'un même propriétaire/type, sans bloquer les autres.
export class KeyedLock {
  #tails = new Map();

  async run(key, action) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#tails.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    }
  }
}
