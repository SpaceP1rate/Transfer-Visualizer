import { create } from 'zustand';
import { openCatalog } from './lib/catalog.js';
import { parseTransfersCsv, parseOrbitsCsv } from './lib/csv.js';
import { shareFamily, setMu, parseEdgeMatAsync, poolSize } from './lib/propagator-client.js';
import { SolutionsSource } from './lib/source.js';
import { variantKey } from './lib/layout.js';

const BASE = import.meta.env.BASE_URL ?? './';
export const url = (p) => `${BASE}${p}`.replace(/([^:])\/{2,}/g, '$1/');

const getJson = async (p) => {
  const r = await fetch(url(p));
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};

/** "L1_Halo_07" -> 7, for ordering the grid axes the way the run indexed them. */
const suffix = (id) => {
  const m = /_(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

/**
 * Everything the views need about one family pair, derived from the CSV rather
 * than assumed: the grid axes are the orbit labels that actually appear, and
 * the TOF slices are the ones the run actually recorded.
 */
function derivePairData(rowsByVariant, orbitsCsv, studyDoc) {
  const all = [...rowsByVariant.values()].flat();
  const depIds = [...new Set(all.map((r) => r.dep_orbit_id))].sort((a, b) => suffix(a) - suffix(b));
  const arrIds = [...new Set(all.map((r) => r.arr_orbit_id))].sort((a, b) => suffix(a) - suffix(b));

  // TOF slices: prefer the run's own TOF_idx; otherwise cluster on the value.
  const hasIdx = all.length > 0 && all.every((r) => r.tof_idx != null);
  let slices;
  if (hasIdx) {
    const byIdx = new Map();
    for (const r of all) {
      if (!byIdx.has(r.tof_idx)) byIdx.set(r.tof_idx, []);
      byIdx.get(r.tof_idx).push(r.TOF);
    }
    slices = [...byIdx.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, tofs]) => ({ idx, tof: tofs.reduce((x, y) => x + y, 0) / tofs.length }));
  } else {
    const uniq = [...new Set(all.map((r) => Math.round(r.TOF * 1e9) / 1e9))].sort((a, b) => a - b);
    slices = uniq.map((tof, i) => ({ idx: i + 1, tof }));
  }

  // Initial conditions, resolved by label. The orbits CSV wins when present;
  // otherwise fall back to the catalog sampling the run used.
  const orbits = new Map();
  if (studyDoc) {
    for (const o of [...studyDoc.dep, ...studyDoc.arr]) {
      orbits.set(o.id, {
        id: o.id, ic: Float64Array.from(o.ic), period: o.period, jacobi: o.jacobi,
        family: o.family, source: 'catalog',
      });
    }
  }
  if (orbitsCsv) {
    for (const o of orbitsCsv.rows) {
      orbits.set(o.orbit_id, {
        id: o.orbit_id, ic: o.ic, period: o.period, jacobi: o.jacobi,
        family: o.family, source: 'csv',
      });
    }
  }

  const missing = [...new Set([...depIds, ...arrIds])].filter((id) => !orbits.has(id));
  const icSource = orbitsCsv ? 'csv' : studyDoc ? 'catalog' : 'none';

  // Row lookup: variant ("n3_p25") -> "dep|arr|tofIdx" -> rows (ranked)
  const lookup = new Map();
  for (const [n, rows] of rowsByVariant) {
    const m = new Map();
    for (const r of rows) {
      const slice = r.tof_idx ?? slices.find((s) => Math.abs(s.tof - r.TOF) < 1e-9)?.idx;
      const k = `${r.dep_orbit_id}|${r.arr_orbit_id}|${slice}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    for (const list of m.values()) list.sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1) || a.DV_total - b.DV_total);
    lookup.set(n, m);
  }

  return { depIds, arrIds, slices, orbits, missing, icSource, lookup };
}

/**
 * The phase grid a run searched, as a side length.
 *
 * The folder name carries it when the run was tagged (`n2_p25`). Older folders
 * are not, but the rows still say: seeds are numbered 1..n_seeds and the grid is
 * square, so the largest seed index recovers the side. Anything that is not a
 * perfect square is reported as a raw seed count rather than guessed at.
 */
function gridSize(rows, p) {
  if (p) return { side: p, seeds: p * p, exact: true };
  let seeds = 0;
  for (const r of rows) {
    const c = Number(r.chain_id);
    if (Number.isFinite(c) && c > seeds) seeds = c;
  }
  if (!seeds) return null;
  const side = Math.round(Math.sqrt(seeds));
  return side * side === seeds
    ? { side, seeds, exact: false }
    : { side: null, seeds, exact: false };
}

/**
 * A solve folder may be named for a variant of a run ("..._DEMO", "_v2"), so
 * match it back to the catalog sampling by exact key, then key prefix, then the
 * family names it implies.
 */
function matchStudy(entry, studyIndex) {
  const study = studyIndex?.pairs ?? [];
  return (
    study.find((s) => s.key === entry.key) ??
    study.find((s) => entry.key.startsWith(`${s.key}_`)) ??
    (entry.depFamily && entry.arrFamily
      ? study.find((s) => s.depFamily === entry.depFamily && s.arrFamily === entry.arrFamily)
      : null) ??
    null
  );
}

/** Borrow the catalog sampling's label and family keys for a solve folder. */
function decorate(p, studyIndex) {
  const s = matchStudy(p, studyIndex);
  const tag = s && p.key !== s.key ? p.key.slice(s.key.length + 1).replace(/_/g, ' ') : '';
  return {
    ...p,
    label: s ? `${s.label}${tag ? ` · ${tag}` : ''}` : p.label,
    depFamily: s?.depFamily ?? p.depFamily,
    arrFamily: s?.arrFamily ?? p.arrFamily,
  };
}

export const useStore = create((set, get) => ({
  phase: 'loading',
  error: null,
  system: null,
  catalog: null,
  families: new Map(),

  studyIndex: null,
  source: null,
  sourceError: null,
  loading: false,
  scan: null,          // { done, total, errors } while reading .mat pairings
  study: null,
  pairKey: null,
  pairs: [],              // merged list of pairs the site can show

  rowsByVariant: new Map(),   // "n3_p25" -> rows
  variants: [],               // [{ n, p, key, rows }] in menu order
  pairData: null,
  nImpulse: null,
  phaseRes: null,             // phase-grid resolution, null when the run had one

  depIdx: 0,
  arrIdx: 0,
  sliceIdx: 0,            // index into pairData.slices
  rank: 1,

  view: '3D',
  inertial: false,
  showSweep: true,
  showGrid: true,
  showLagrange: true,
  sweepCount: 70,
  allFamilies: [],     // every catalog family, shown when no solutions are committed
  followSelection: true,

  // ------------------------------------------------------------------------
  async init() {
    try {
      const cat = await openCatalog(url('data/orbits'));
      await setMu(cat.system.mu);

      let studyIndex = null;
      try { studyIndex = await getJson('data/study/index.json'); } catch { /* optional */ }
      const source = await SolutionsSource.open(url('data/solutions'));

      const allFamilies = cat.manifest.families.map((f) => f.key);
      const pairs = (source?.listPairs() ?? []).map((p) => decorate(p, studyIndex));

      set({
        phase: 'ready', system: cat.system, catalog: cat, studyIndex, source, pairs, allFamilies,
      });

      if (pairs.length) {
        await get().loadPair(pairs[0].key);
      } else {
        // Nothing committed yet: show the whole catalog instead of an empty scene.
        await Promise.all(allFamilies.map((k) => get().ensureFamily(k)));
      }
    } catch (e) {
      set({ phase: 'error', error: String(e?.message ?? e) });
    }
  },

  async ensureFamily(key) {
    const { families, catalog } = get();
    if (families.has(key)) return families.get(key);
    const fam = await catalog.load(key);
    await shareFamily(fam);
    const next = new Map(get().families);
    next.set(key, fam);
    set({ families: next });
    return fam;
  },

  async loadPair(pairKey) {
    const { pairs, studyIndex, source } = get();
    const entry = pairs.find((p) => p.key === pairKey);
    if (!entry) return;
    set({ pairKey, loading: true, sourceError: null });

    const studyEntry = matchStudy(entry, studyIndex);
    const studyDoc = studyEntry ? await getJson(`data/study/${studyEntry.file}`) : null;

    let orbitsCsv = null;
    const rowsByVariant = new Map();
    const variantMeta = new Map();   // key -> { n, p }
    // Arcs that pass below the lunar surface are not solutions of the problem
    // being posed, so they are dropped on the way in. Every surface, minimum
    // and readout downstream is therefore over the valid set only, with no
    // filter to forget to apply.
    const push = (n, p, all) => {
      const rows = all.filter((r) => r.lunar_valid !== false);
      if (!rows.length) return;
      const k = variantKey(n, p);
      variantMeta.set(k, { n, p: p ?? null });
      const existing = rowsByVariant.get(k);
      rowsByVariant.set(k, existing ? existing.concat(rows) : rows);
    };
    // Raw .mat pairings carry no folder, so they are grouped by the impulse
    // count the rows themselves declare.
    const addRows = (rows) => {
      const byN = new Map();
      for (const r of rows) {
        const n = r.n_impulse ?? 2;
        if (!byN.has(n)) byN.set(n, []);
        byN.get(n).push(r);
      }
      for (const [n, rs] of byN) push(n, null, rs);
    };

    try {
      if (source) {
        if (entry.orbitsFile) {
          orbitsCsv = parseOrbitsCsv(await source.readText(entry.orbitsFile));
        }
        // Keyed by the folder's k and phase grid, not by anything inferred from
        // the rows: the n<k>[_p<P>] directory is what the run declares, and it
        // is what the selectors offer.
        for (const variant of entry.impulses ?? []) {
          let rows = [];
          for (const file of variant.files) {
            rows = rows.concat(parseTransfersCsv(await source.readText(file)));
          }
          push(variant.n, variant.p ?? null, rows);
        }

        // Solver .mat files: one pairing each, ~22k solutions apiece. They are
        // parsed and reduced in the worker pool so neither the raw rows nor the
        // decompressed subsystem ever reach the main thread.
        const mats = entry.matFiles ?? [];
        if (mats.length) {
          const errors = [];
          let done = 0;
          set({ scan: { done: 0, total: mats.length, errors: 0 } });

          const width = Math.max(1, poolSize());
          let cursor = 0;
          const runOne = async () => {
            while (cursor < mats.length) {
              const path = mats[cursor++];
              try {
                const buf = await source.readBinary(path);
                const res = await parseEdgeMatAsync(buf, path);
                if (res.ok) addRows(res.rows);
                else errors.push(`${path}: ${res.error}`);
              } catch (e) {
                errors.push(`${path}: ${e?.message ?? e}`);
              }
              done++;
              if (done % 2 === 0 || done === mats.length) {
                set({ scan: { done, total: mats.length, errors: errors.length } });
              }
            }
          };
          await Promise.all(Array.from({ length: width }, runOne));
          set({ scan: null });
          if (errors.length) set({ sourceError: `${errors.length} file(s) failed: ${errors[0]}` });
        }
      }
    } catch (e) {
      set({ scan: null, sourceError: String(e?.message ?? e) });
    }

    const depFamily = studyDoc?.depFamily ?? entry.depFamily;
    const arrFamily = studyDoc?.arrFamily ?? entry.arrFamily;
    await Promise.all([depFamily, arrFamily].filter(Boolean).map((k) => get().ensureFamily(k)));

    const pairData = derivePairData(rowsByVariant, orbitsCsv, studyDoc);
    const variants = [...rowsByVariant.entries()]
      .map(([key, rows]) => {
        const meta = variantMeta.get(key);
        return { key, ...meta, grid: gridSize(rows, meta.p), rows };
      })
      .sort((a, b) => a.n - b.n || (a.p ?? 0) - (b.p ?? 0));

    // Keep the current selection when the new pair also has it; otherwise fall
    // back to the first variant rather than leaving a dangling one selected.
    const ns = [...new Set(variants.map((v) => v.n))].sort((a, b) => a - b);
    const n = ns.includes(get().nImpulse) ? get().nImpulse : (ns[0] ?? null);
    const ps = variants.filter((v) => v.n === n).map((v) => v.p ?? null);
    const p = ps.includes(get().phaseRes) ? get().phaseRes : (ps[0] ?? null);

    set({
      study: studyDoc,
      rowsByVariant,
      variants,
      pairData,
      depFamily,
      arrFamily,
      nImpulse: n,
      phaseRes: p,
      depIdx: 0,
      arrIdx: 0,
      sliceIdx: Math.min(get().sliceIdx, Math.max(0, pairData.slices.length - 1)),
      rank: 1,
      loading: false,
    });
  },

  set: (patch) => set(patch),
}));

// ---------------------------------------------------------------------------
// Selectors — all read straight out of what the CSV provided.
// ---------------------------------------------------------------------------

/**
 * The lookup table for an impulse count at the currently selected phase grid.
 *
 * Callers ask by impulse count alone — the phase resolution is a separate,
 * global choice. When the exact combination was not solved (comparing against a
 * 2-impulse run that only exists at one resolution, say), the densest grid
 * available for that impulse count stands in rather than the comparison
 * silently disappearing.
 */
function variantLookup(state, n) {
  const pd = state.pairData;
  if (!pd || n == null) return null;
  const exact = pd.lookup.get(variantKey(n, state.phaseRes));
  if (exact) return exact;
  const alt = (state.variants ?? [])
    .filter((v) => v.n === n)
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))[0];
  return alt ? pd.lookup.get(alt.key) ?? null : null;
}

/** Every solution recorded for one cell of the (departure, arrival, TOF) grid. */
export function solutionsAt(state, n, depIdx, arrIdx, sliceIdx) {
  const pd = state.pairData;
  const table = variantLookup(state, n);
  if (!table) return [];
  const depId = pd.depIds[depIdx], arrId = pd.arrIds[arrIdx];
  const slice = pd.slices[sliceIdx];
  if (!depId || !arrId || !slice) return [];
  return table.get(`${depId}|${arrId}|${slice.idx}`) ?? [];
}

/** The solution the 3D view draws: the requested rank, or the cheapest kept. */
export function solutionAt(state, n, depIdx, arrIdx, sliceIdx, rank = state.rank) {
  const list = solutionsAt(state, n, depIdx, arrIdx, sliceIdx);
  if (!list.length) return null;
  return list.find((r) => (r.rank ?? 1) === rank) ?? list[0];
}

/**
 * Minimum delta-V over the departure x arrival grid at one TOF slice.
 * NaN marks a cell where nothing converged (or everything was filtered out).
 */
export function dvGrid(state, n, sliceIdx) {
  const pd = state.pairData;
  const nd = pd?.depIds.length ?? 0, na = pd?.arrIds.length ?? 0;
  const out = new Float64Array(nd * na).fill(NaN);
  if (!pd || !variantLookup(state, n) || !pd.slices[sliceIdx]) return { values: out, nd, na };

  for (let d = 0; d < nd; d++) {
    for (let a = 0; a < na; a++) {
      const list = solutionsAt(state, n, d, a, sliceIdx);
      if (list.length) out[d * na + a] = Math.min(...list.map((r) => r.DV_total));
    }
  }
  return { values: out, nd, na };
}

/**
 * Cells where the n-impulse solution costs more than the two-impulse one.
 * The n-impulse feasible set contains the two-impulse one, so at a true optimum
 * this is impossible — every hit marks a solver local minimum, which is worth
 * showing rather than smoothing away.
 */
export function localMinimaViolations(state, n, sliceIdx, epsilon = 1e-9) {
  if (n === 2 || !variantLookup(state, 2) || !variantLookup(state, n)) return [];
  const two = dvGrid(state, 2, sliceIdx);
  const multi = dvGrid(state, n, sliceIdx);
  const out = [];
  for (let k = 0; k < two.values.length; k++) {
    const a = two.values[k], b = multi.values[k];
    if (Number.isFinite(a) && Number.isFinite(b) && b > a + epsilon) {
      out.push({ dep: Math.floor(k / two.na), arr: k % two.na, two: a, multi: b });
    }
  }
  return out;
}

/** Resolve an orbit label to its initial condition. */
export const orbitFor = (state, id) => state.pairData?.orbits.get(id) ?? null;
