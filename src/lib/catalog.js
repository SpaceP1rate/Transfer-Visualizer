/**
 * Loader for the committed orbit catalog.
 *
 * Each family is a flat little-endian Float64 table, N rows of 9 columns
 * [x, y, z, vx, vy, vz, jacobi, period, stability]. Loading is a single fetch
 * into an ArrayBuffer with no parse step, and every accessor returns a
 * zero-copy subarray view, so switching families costs one network round trip
 * and no per-orbit allocation.
 */

export const COLUMNS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'jacobi', 'period', 'stability'];
export const STRIDE = COLUMNS.length;

export class Family {
  /**
   * @param {object} meta manifest entry
   * @param {ArrayBuffer} buffer raw .f64 contents
   */
  constructor(meta, buffer) {
    this.meta = meta;
    this.table = new Float64Array(buffer);
    this.count = this.table.length / STRIDE;
    if (!Number.isInteger(this.count)) {
      throw new Error(`${meta.key}: table length ${this.table.length} is not a multiple of ${STRIDE}`);
    }
    if (meta.count != null && meta.count !== this.count) {
      throw new Error(`${meta.key}: manifest says ${meta.count} orbits, file has ${this.count}`);
    }
    this._byJacobi = null;
  }

  /** Zero-copy orbit record. `ic` is a view into the table — do not mutate. */
  get(i) {
    if (i < 0 || i >= this.count) throw new RangeError(`orbit index ${i} out of range`);
    const o = i * STRIDE;
    return {
      familyKey: this.meta.key,
      index: i,
      ic: this.table.subarray(o, o + 6),
      jacobi: this.table[o + 6],
      period: this.table[o + 7],
      stability: this.table[o + 8],
    };
  }

  /** A detached copy, safe to keep and mutate. */
  getCopy(i) {
    const r = this.get(i);
    return { ...r, ic: Float64Array.from(r.ic) };
  }

  column(name) {
    const c = COLUMNS.indexOf(name);
    if (c < 0) throw new Error(`unknown column ${name}`);
    const out = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.table[i * STRIDE + c];
    return out;
  }

  /** Indices sorted by Jacobi constant, built once and cached. */
  get jacobiOrder() {
    if (!this._byJacobi) {
      const idx = new Int32Array(this.count);
      for (let i = 0; i < this.count; i++) idx[i] = i;
      const C = this.column('jacobi');
      this._byJacobi = Array.from(idx).sort((a, b) => C[a] - C[b]);
    }
    return this._byJacobi;
  }

  /** Nearest catalog member to a target Jacobi constant. */
  nearestJacobi(target) {
    const order = this.jacobiOrder;
    let lo = 0, hi = order.length - 1;
    const C = (k) => this.table[order[k] * STRIDE + 6];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (C(mid) < target) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(C(lo - 1) - target) < Math.abs(C(lo) - target)) lo--;
    return order[lo];
  }

  /** Every member with C in [min, max], in catalog order. */
  inJacobiRange(min, max) {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const c = this.table[i * STRIDE + 6];
      if (c >= min && c <= max) out.push(i);
    }
    return out;
  }

  /** Evenly spaced indices across the family, endpoints included. */
  sampleIndices(n) {
    if (n >= this.count) return Array.from({ length: this.count }, (_, i) => i);
    const step = (this.count - 1) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * step));
  }
}

/**
 * Browser loader. `base` is the data directory URL.
 * @returns {Promise<{manifest: object, load: (key: string) => Promise<Family>}>}
 */
export async function openCatalog(base = 'data/orbits') {
  const manifest = await (await fetch(`${base}/index.json`)).json();
  const byKey = new Map(manifest.families.map((f) => [f.key, f]));
  const cache = new Map();

  async function load(key) {
    if (cache.has(key)) return cache.get(key);
    const meta = byKey.get(key);
    if (!meta) throw new Error(`unknown family "${key}"`);
    const p = fetch(`${base}/${meta.file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${meta.file}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => new Family(meta, buf));
    cache.set(key, p);
    return p;
  }

  return { manifest, byKey, load, system: manifest.system };
}
