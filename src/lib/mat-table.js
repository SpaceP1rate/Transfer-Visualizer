/**
 * Reading MATLAB `table` objects, and the solver's edge files, without MATLAB.
 *
 * A saved `table` is an opaque MCOS object: the variable in the file is just a
 * handle, and the contents live in the subsystem's FileWrapper cell array. Two
 * of those cells carry everything that matters —
 *
 *     one cell of N char arrays        the variable names, in order
 *     one cell of N columns            the data, each of nrows entries
 *
 * Rather than hardcoding their positions (which have moved between MATLAB
 * releases), they are located by shape: find the column set whose members all
 * have the same length, then the name set with a matching count. That makes the
 * reader tolerant of layout changes and, more importantly, makes a layout it
 * does not recognise fail loudly instead of returning shifted columns.
 */

import { readMat, parseSubsystem } from './mat.js';

const isCell = (x) => x && x.kind === 'cell';
const isNum = (x) => x && x.kind === 'num';

/** Length of a column, whether it is numeric or a cell of strings. */
function columnLength(col) {
  if (isNum(col)) return col.value.length;
  if (isCell(col)) return col.cells.length;
  return -1;
}

/**
 * Pull every MATLAB table out of a parsed MAT-file.
 * @returns {Map<string, {names: string[], columns: Array, nrows: number}>}
 */
export function extractTables(mat) {
  const out = new Map();
  const fw = parseSubsystem(mat.subsystem, mat.littleEndian);
  if (!fw || !isCell(fw)) return out;

  const cells = fw.cells;

  // Candidate data blocks: a cell whose members are all the same length.
  const blocks = [];
  for (const c of cells) {
    if (!isCell(c) || c.cells.length === 0) continue;
    const lens = c.cells.map(columnLength);
    if (lens.some((l) => l < 0)) continue;
    if (new Set(lens).size !== 1) continue;
    if (lens[0] < 1) continue;
    blocks.push({ cell: c, nvars: c.cells.length, nrows: lens[0] });
  }
  // Candidate name blocks: a cell of char arrays.
  const nameBlocks = cells.filter(
    (c) => isCell(c) && c.cells.length > 0 && c.cells.every((x) => x && x.kind === 'char')
  );

  for (const b of blocks) {
    const nb = nameBlocks.find((n) => n.cells.length === b.nvars);
    if (!nb) continue;
    const names = nb.cells.map((x) => x.value);
    // A data block that is itself the name block (all char) is not a table.
    if (b.cell === nb) continue;
    out.set(
      mat.vars.size === 1 ? [...mat.vars.keys()][0] : `table${out.size + 1}`,
      { names, columns: b.cell.cells, nrows: b.nrows }
    );
  }
  return out;
}

/** Column accessor that works for both numeric columns and cells of strings. */
function accessor(col) {
  if (isNum(col)) {
    const v = col.value;
    return (i) => v[i];
  }
  if (isCell(col)) {
    const cs = col.cells;
    return (i) => (cs[i]?.kind === 'char' ? cs[i].value : cs[i]?.value ?? null);
  }
  return () => null;
}

/**
 * Read one `edge_*.mat` and return rows in the shape src/lib/csv.js produces,
 * so downstream code cannot tell which source a solution came from.
 *
 * The MATLAB column names are mapped onto the site's schema here; anything not
 * listed is carried through under its own lowercased name.
 */
const FIELD_MAP = {
  from: 'dep_orbit_id',
  to: 'arr_orbit_id',
  dv_total: 'DV_total',
  tof: 'TOF',
  departure_phase: 'departure_phase',
  arrival_phase: 'arrival_phase',
  tof_idx: 'tof_idx',
  position_residual: 'position_residual',
  node_residual: 'node_residual',
  delta_c: 'delta_C',
  chain_id: 'chain_id',
  min_moon_dist: 'min_moon_dist',
  lunar_valid: 'lunar_valid',
  transfer_type: 'transfer_type',
};

export function tableToRows(table) {
  const { names, columns, nrows } = table;
  const get = columns.map(accessor);
  const key = names.map((n) => n.trim().toLowerCase());

  // Locate the burn-vector columns however many there are.
  const dvIndex = [];
  for (let k = 1; ; k++) {
    const ix = ['x', 'y', 'z'].map((ax) => key.indexOf(`dv${k}_${ax}`));
    if (ix.some((i) => i < 0)) break;
    dvIndex.push(ix);
  }
  const legIndex = [];
  for (let k = 1; ; k++) {
    const i = key.indexOf(`t_leg${k}`);
    if (i < 0) break;
    legIndex.push(i);
  }

  const at = (name) => {
    const i = key.indexOf(name);
    return i < 0 ? null : get[i];
  };
  const TOFc = at('tof');
  const dvTotalC = at('dv_total');
  const depC = at('from') ?? at('dep_orbit_id');
  const arrC = at('to') ?? at('arr_orbit_id');
  const depPhaseC = at('departure_phase');
  const arrPhaseC = at('arrival_phase');
  const tofIdxC = at('tof_idx');
  const mmdC = at('min_moon_dist');
  const validC = at('lunar_valid');
  const chainC = at('chain_id');
  const resC = at('position_residual');
  const nodeResC = at('node_residual');
  const dCC = at('delta_c');
  const typeC = at('transfer_type');

  const rows = new Array(nrows);
  for (let i = 0; i < nrows; i++) {
    const dvs = dvIndex.map((ix) => {
      const v = [get[ix[0]](i), get[ix[1]](i), get[ix[2]](i)];
      return { v, mag: Math.hypot(v[0], v[1], v[2]) };
    });
    const TOF = TOFc ? TOFc(i) : null;
    let coasts = legIndex.map((j) => get[j](i));
    if (!coasts.length && TOF != null) coasts = [TOF];

    rows[i] = {
      dep_orbit_id: depC ? String(depC(i)) : '',
      arr_orbit_id: arrC ? String(arrC(i)) : '',
      n_impulse: dvs.length,
      transfer_type: typeC ? String(typeC(i)) : null,
      tof_idx: tofIdxC ? tofIdxC(i) : null,
      delta_C: dCC ? dCC(i) : null,
      rank: 1,
      seeds_converged: null,
      TOF,
      DV_total: dvTotalC ? dvTotalC(i) : dvs.reduce((a, d) => a + d.mag, 0),
      departure_phase: depPhaseC ? depPhaseC(i) : 0,
      arrival_phase: arrPhaseC ? arrPhaseC(i) : 0,
      dvs,
      coasts,
      min_moon_dist: mmdC ? mmdC(i) : null,
      // Logical columns often arrive as 0/1 doubles because the assembling
      // script initialised the accumulator as [].
      lunar_valid: validC ? Boolean(validC(i)) : null,
      chain_id: chainC ? chainC(i) : null,
      position_residual: resC ? resC(i) : null,
      node_residual: nodeResC ? nodeResC(i) : null,
    };
  }
  return rows;
}

/**
 * Reduce a pairing's full multistart output the way scripts/export_edges.m does:
 * per TOF slice keep the cheapest solution plus up to K-1 more that are
 * genuinely different branches, and record how many seeds converged there.
 *
 * A full run is ~22k rows per pairing and ~100 pairings per family pair; holding
 * all of that in the browser is neither possible nor useful, and the delta-V
 * surface only ever asks for the best solution in each cell.
 */
export function reduceRows(rows, { K = 3, angleTol = 0.15, magTol = 0.02 } = {}) {
  const bySlice = new Map();
  for (const r of rows) {
    const k = r.tof_idx ?? Math.round(r.TOF * 1e9);
    if (!bySlice.has(k)) bySlice.set(k, []);
    bySlice.get(k).push(r);
  }

  const distinct = (v, kept) => {
    const nv = Math.hypot(...v);
    for (const w of kept) {
      const nw = Math.hypot(...w);
      let sameDir = true;
      if (nv > 1e-15 && nw > 1e-15) {
        const ca = Math.min(1, Math.max(-1, (v[0] * w[0] + v[1] * w[1] + v[2] * w[2]) / (nv * nw)));
        sameDir = Math.acos(ca) < angleTol;
      }
      const sameMag = Math.abs(nv - nw) <= magTol * Math.max(nv, nw);
      if (sameDir && sameMag) return false;
    }
    return true;
  };

  const out = [];
  for (const list of bySlice.values()) {
    list.sort((a, b) => a.DV_total - b.DV_total);
    const kept = [];
    const keptDv = [];
    for (const r of list) {
      if (kept.length >= K) break;
      const v = r.dvs[0]?.v ?? [0, 0, 0];
      if (kept.length === 0 || distinct(v, keptDv)) {
        kept.push(r);
        keptDv.push(v);
      }
    }
    kept.forEach((r, i) => {
      r.rank = i + 1;
      r.seeds_converged = list.length;
      out.push(r);
    });
  }
  return out;
}

/**
 * Read one edge file end to end: parse, convert, reduce.
 * Returns the reduced rows plus a small report for the UI.
 */
export async function readEdgeFile(buffer, opts = {}) {
  const mat = await readMat(buffer);
  const tables = extractTables(mat);
  if (!tables.size) {
    throw new Error('no MATLAB table found in this .mat');
  }
  const table = [...tables.values()][0];
  const rows = tableToRows(table);
  const reduced = reduceRows(rows, opts);
  return {
    rows: reduced,
    report: {
      names: table.names,
      totalRows: table.nrows,
      keptRows: reduced.length,
      mu: mat.vars.get('mu')?.value?.[0] ?? null,
      cDep: mat.vars.get('C_dep')?.value?.[0] ?? null,
      cArr: mat.vars.get('C_arr')?.value?.[0] ?? null,
    },
  };
}

/**
 * Read a JPL catalog snapshot (plain structs, no MCOS) into the same shape
 * scripts/convert_mat.py produces, so a fresh catalog can be dropped in without
 * running the Python step.
 */
export async function readCatalogMat(buffer) {
  const mat = await readMat(buffer);
  const mu = mat.vars.get('mu')?.value?.[0];
  if (mu == null) throw new Error('no `mu` in this file — is it the orbit catalog?');

  const families = [];
  for (const [key, v] of mat.vars) {
    if (v.kind !== 'struct') continue;
    const rec = v.records?.[0];
    if (!rec?.x0 || !rec?.period || !rec?.energy) continue;
    const x0 = rec.x0.value;
    const n = rec.period.value.length;
    // x0 is stored column-major as [n x 6].
    const table = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 6; c++) table[i * 9 + c] = x0[c * n + i];
      table[i * 9 + 6] = rec.energy.value[i];
      table[i * 9 + 7] = rec.period.value[i];
      table[i * 9 + 8] = rec.stability?.value?.[i] ?? NaN;
    }
    families.push({ key, count: n, table });
  }
  return { mu, families };
}
