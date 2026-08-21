import { create } from 'zustand';
import { openCatalog } from './lib/catalog.js';
import { parseTransfersCsv, parseOrbitsCsv } from './lib/csv.js';
import { shareFamily, setMu } from './lib/propagator-client.js';
import { RemoteSource } from './lib/source.js';

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
function derivePairData(rowsByN, orbitsCsv, studyDoc) {
  const all = [...rowsByN.values()].flat();
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

  // Row lookup: n -> "dep|arr|tofIdx" -> rows (ranked)
  const lookup = new Map();
  for (const [n, rows] of rowsByN) {
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
  study: null,
  pairKey: null,
  pairs: [],              // merged list of pairs the site can show

  rowsByN: new Map(),
  pairData: null,
  nImpulse: null,
  compareWith: null,

  depIdx: 0,
  arrIdx: 0,
  sliceIdx: 0,            // index into pairData.slices
  rank: 1,
  hideLunarInvalid: true,

  view: '3D',
  showSweep: true,
  showGrid: true,
  showLagrange: true,
  sweepCount: 70,
  followSelection: true,

  // ------------------------------------------------------------------------
  async init() {
    try {
      const cat = await openCatalog(url('data/orbits'));
      await setMu(cat.system.mu);

      let studyIndex = null, source = null;
      try { studyIndex = await getJson('data/study/index.json'); } catch { /* optional */ }
      try { source = await RemoteSource.open(url('data/transfers')); } catch { /* optional */ }

      set({ phase: 'ready', system: cat.system, catalog: cat, studyIndex, source });
      const pairs = get().buildPairs();
      if (!pairs.length) throw new Error('no transfer or study data found under data/');
      await get().loadPair(pairs[0].key);
    } catch (e) {
      set({ phase: 'error', error: String(e?.message ?? e) });
    }
  },

  /**
   * A pair is showable if the active source has solutions for it, or — geometry
   * only — if the catalog sampling knows about it.
   */
  buildPairs() {
    const { source, studyIndex } = get();
    const study = studyIndex?.pairs ?? [];

    // A solver folder may be named for a variant of a run ("..._DEMO", "_v2"),
    // so match it back to the catalog sampling by key prefix or by family names
    // and borrow that entry's label and families.
    const matchStudy = (p) =>
      study.find((s) => s.key === p.key) ??
      study.find((s) => p.key.startsWith(`${s.key}_`)) ??
      study.find((s) => s.depFamily === p.depFamily && s.arrFamily === p.arrFamily) ??
      null;

    const pairs = [];
    const covered = new Set();
    for (const p of source?.listPairs() ?? []) {
      const s = matchStudy(p);
      if (s) covered.add(s.key);
      const tag = s && p.key !== s.key ? p.key.slice(s.key.length + 1).replace(/_/g, ' ') : '';
      pairs.push({
        ...p,
        hasTransfers: true,
        label: s ? `${s.label}${tag ? ` · ${tag}` : ''}` : p.label,
        depFamily: s?.depFamily ?? p.depFamily,
        arrFamily: s?.arrFamily ?? p.arrFamily,
      });
    }
    for (const s of study) {
      if (!covered.has(s.key)) pairs.push({ ...s, hasTransfers: false });
    }
    set({ pairs });
    return pairs;
  },

  /** Swap in a folder chosen from disk, or back to the repository data. */
  async setSource(source) {
    set({ source, sourceError: null });
    const pairs = get().buildPairs();
    const keep = pairs.find((p) => p.key === get().pairKey) ?? pairs[0];
    if (keep) await get().loadPair(keep.key);
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

    // Match the catalog sampling to this pair. Exact key first, then a key with
    // a trailing tag stripped (e.g. "..._DEMO"), then the family names — so a
    // folder named for a variant of a run still resolves its orbits.
    const [entryDep, entryArr] = [entry.depFamily, entry.arrFamily];
    const studyEntry =
      studyIndex?.pairs?.find((p) => p.key === pairKey) ??
      studyIndex?.pairs?.find((p) => pairKey.startsWith(`${p.key}_`)) ??
      (entryDep && entryArr
        ? studyIndex?.pairs?.find((p) => p.depFamily === entryDep && p.arrFamily === entryArr)
        : null);
    const studyDoc = studyEntry ? await getJson(`data/study/${studyEntry.file}`) : null;

    let orbitsCsv = null;
    const rowsByN = new Map();
    try {
      if (entry.hasTransfers && source) {
        if (entry.orbitsFile) {
          orbitsCsv = parseOrbitsCsv(await source.readText(pairKey, entry.orbitsFile));
        }
        for (const variant of entry.impulses ?? []) {
          let rows = [];
          for (const file of variant.files) {
            rows = rows.concat(parseTransfersCsv(await source.readText(pairKey, file)));
          }
          if (rows.length) rowsByN.set(variant.n, rows);
        }
      }
    } catch (e) {
      set({ sourceError: String(e?.message ?? e) });
    }

    const depFamily = studyDoc?.depFamily ?? entry.depFamily;
    const arrFamily = studyDoc?.arrFamily ?? entry.arrFamily;
    await Promise.all([depFamily, arrFamily].filter(Boolean).map((k) => get().ensureFamily(k)));

    const pairData = derivePairData(rowsByN, orbitsCsv, studyDoc);
    const available = [...rowsByN.keys()].sort((a, b) => a - b);
    const n = available.includes(get().nImpulse) ? get().nImpulse : (available[0] ?? null);

    set({
      study: studyDoc,
      rowsByN,
      pairData,
      depFamily,
      arrFamily,
      nImpulse: n,
      compareWith: available.length > 1 ? available.find((k) => k !== n) ?? null : null,
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

const keep = (state, r) => !(state.hideLunarInvalid && r.lunar_valid === false);

/** Every solution recorded for one cell of the (departure, arrival, TOF) grid. */
export function solutionsAt(state, n, depIdx, arrIdx, sliceIdx) {
  const pd = state.pairData;
  if (!pd || !pd.lookup.has(n)) return [];
  const depId = pd.depIds[depIdx], arrId = pd.arrIds[arrIdx];
  const slice = pd.slices[sliceIdx];
  if (!depId || !arrId || !slice) return [];
  return (pd.lookup.get(n).get(`${depId}|${arrId}|${slice.idx}`) ?? []).filter((r) => keep(state, r));
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
  if (!pd || !pd.lookup.has(n) || !pd.slices[sliceIdx]) return { values: out, nd, na };

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
  if (n === 2 || !state.rowsByN.has(2) || !state.rowsByN.has(n)) return [];
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
