/**
 * Promise-based RPC to the propagation worker pool.
 *
 * Requests are tagged so several can be in flight at once, and each request may
 * declare a `channel`: a newer request on the same channel supersedes any
 * pending one, which is what keeps a dragged slider from queueing up dozens of
 * stale propagations.
 */

const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

class Pool {
  constructor() {
    this.workers = [];
    this.pending = new Map();   // id -> {resolve, reject, channel}
    this.channelSeq = new Map(); // channel -> latest id
    this.next = 0;
    this.rr = 0;
    for (let i = 0; i < POOL_SIZE; i++) this.workers.push(this._spawn());
  }

  _spawn() {
    const w = new Worker(new URL('../workers/propagate.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const { id, ok, payload, error } = e.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.channel && this.channelSeq.get(entry.channel) !== id) return; // superseded
      ok ? entry.resolve(payload) : entry.reject(new Error(error));
    };
    return w;
  }

  /** Send to every worker (used for shared state such as the loaded families). */
  broadcast(type, args, transfer = []) {
    return Promise.all(this.workers.map((w) => this._send(w, type, args, transfer, null, true)));
  }

  call(type, args, { channel = null, transfer = [] } = {}) {
    const w = this.workers[this.rr++ % this.workers.length];
    return this._send(w, type, args, transfer, channel, false);
  }

  /** Route every call for a key to the same worker, so its cache is warm. */
  callSticky(key, type, args, opts = {}) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const w = this.workers[Math.abs(h) % this.workers.length];
    return this._send(w, type, args, opts.transfer ?? [], opts.channel ?? null, false);
  }

  _send(worker, type, args, transfer, channel, cloneArgs) {
    const id = ++this.next;
    if (channel) this.channelSeq.set(channel, id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, channel });
      // A broadcast cannot transfer the same buffer to several workers, so it
      // sends structured clones instead.
      worker.postMessage({ id, type, args }, cloneArgs ? [] : transfer);
    });
  }
}

let pool = null;
export function getPool() {
  if (!pool) pool = new Pool();
  return pool;
}

/** Load a family's table into every worker. */
export async function shareFamily(family) {
  const p = getPool();
  await p.broadcast('loadFamily', {
    key: family.meta.key,
    meta: family.meta,
    buffer: family.table.buffer,
  });
}

export const setMu = (mu) => getPool().broadcast('setMu', { mu });

export const propagateOrbitAsync = (orbit, samples, channel) =>
  getPool().call('orbit', { orbit, samples }, { channel });

export const familySweepAsync = (key, indices, samples, jacobiRange, channel) =>
  getPool().callSticky(key, 'familySweep', { key, indices, samples, jacobiRange }, { channel });

export const transferAsync = (dep, arr, transfer, samplesPerLeg, channel) =>
  getPool().call('transfer', { dep, arr, transfer, samplesPerLeg }, { channel });
