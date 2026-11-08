// Event bus: fire-and-forget dispatch with async handler tracking.
// Errors never escape a handler — a broken listener must not stop the host.
export class Bus {
  constructor({ log = () => {}, onError = null } = {}) {
    this.handlers = new Map();
    this.inflight = 0;
    this.idleWaiters = [];
    this.log = log;
    this.onError = onError;
  }

  on(event, fn) {
    const list = this.handlers.get(event) || [];
    list.push(fn);
    this.handlers.set(event, list);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this.handlers.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(event, payload) {
    const list = this.handlers.get(event) || [];
    for (const fn of list.slice()) {
      let out;
      try {
        out = fn(payload);
      } catch (err) {
        this.onError?.(event, err);
        this.log(`bus: ${event} handler threw: ${err.message}`);
        continue;
      }
      if (out && typeof out.then === 'function') {
        this.inflight += 1;
        out
          .catch((err) => {
            this.onError?.(event, err);
            this.log(`bus: ${event} async handler rejected: ${err.message}`);
          })
          .finally(() => {
            this.inflight -= 1;
            if (this.inflight === 0) this.#flush();
          });
      }
    }
    return list.length;
  }

  drain() {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #flush() {
    const waiters = this.idleWaiters.splice(0);
    for (const w of waiters) w();
  }
}
