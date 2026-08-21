/**
 * CSV readers for the MATLAB solver exports.
 *
 * Both readers are schema-driven rather than position-driven: columns are found
 * by name, and the impulse count is discovered from however many `dvN_*` /
 * `t_legN` columns the file actually has. That way a 4- or 5-impulse export
 * drops in without a code change — the site's impulse selector just gains
 * another entry.
 */

/** Minimal RFC4180-ish splitter: handles quoted fields and CRLF. */
function splitRows(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

const numOrNull = (s) => {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '' || t.toLowerCase() === 'nan' || t.toLowerCase() === 'null') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/** Seed and chain identifiers are integers in practice but may be exported as
 *  floats ("7.00000000000"); keep them readable without assuming either. */
const idOrNum = (s) => {
  const t = (s ?? '').trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6) : t;
};

const boolOrNull = (s) => {
  if (s === undefined) return null;
  const t = s.trim().toLowerCase();
  if (t === '') return null;
  if (t === 'true' || t === '1' || t === 'yes' || t === 'y') return true;
  if (t === 'false' || t === '0' || t === 'no' || t === 'n') return false;
  return null;
};

function headerIndex(header) {
  const ix = new Map();
  header.forEach((h, i) => ix.set(h.trim().toLowerCase(), i));
  return ix;
}

/**
 * Parse `orbits_<DEP>_to_<ARR>.csv`.
 * Columns: orbit_id, role, idx, family, x, y, z, vx, vy, vz, period, jacobi
 *
 * @returns {{rows: Array, byId: Map<string, object>, dep: Array, arr: Array,
 *            families: {dep: string, arr: string}, branchHint: string|null}}
 */
export function parseOrbitsCsv(text) {
  const rows = splitRows(text);
  if (rows.length < 2) throw new Error('orbits CSV: no data rows');
  const ix = headerIndex(rows[0]);
  const need = ['orbit_id', 'role', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'period'];
  for (const k of need) if (!ix.has(k)) throw new Error(`orbits CSV: missing column "${k}"`);
  const at = (r, k) => r[ix.get(k)];

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ic = new Float64Array([
      numOrNull(at(r, 'x')), numOrNull(at(r, 'y')), numOrNull(at(r, 'z')),
      numOrNull(at(r, 'vx')), numOrNull(at(r, 'vy')), numOrNull(at(r, 'vz')),
    ]);
    out.push({
      orbit_id: at(r, 'orbit_id').trim(),
      role: at(r, 'role').trim().toLowerCase(),
      idx: ix.has('idx') ? numOrNull(at(r, 'idx')) : i,
      family: ix.has('family') ? at(r, 'family').trim() : null,
      ic,
      period: numOrNull(at(r, 'period')),
      jacobi: ix.has('jacobi') ? numOrNull(at(r, 'jacobi')) : null,
    });
  }

  const byId = new Map(out.map((o) => [o.orbit_id, o]));
  const dep = out.filter((o) => o.role === 'dep').sort((a, b) => a.idx - b.idx);
  const arr = out.filter((o) => o.role === 'arr').sort((a, b) => a.idx - b.idx);

  // The MATLAB export does not record the halo branch. Infer it: for a northern
  // halo the initial condition sits above the xy-plane, for a southern one below.
  const zs = out.map((o) => o.ic[2]).filter((z) => Math.abs(z) > 1e-8);
  const branchHint = zs.length === 0 ? null
    : zs.every((z) => z > 0) ? 'N'
      : zs.every((z) => z < 0) ? 'S'
        : 'mixed';

  return {
    rows: out,
    byId,
    dep,
    arr,
    families: { dep: dep[0]?.family ?? null, arr: arr[0]?.family ?? null },
    branchHint,
  };
}

/**
 * Parse `transfers_<DEP>_to_<ARR>_n<k>.csv`.
 *
 * The number of impulses per row comes from `n_impulse` when present, otherwise
 * from how many `dvN_*` groups are non-blank. Burn vectors and leg durations are
 * returned as arrays sized to that row's impulse count, so downstream code never
 * has to know which n it is looking at.
 */
export function parseTransfersCsv(text) {
  const rows = splitRows(text);
  if (rows.length < 2) return [];
  const ix = headerIndex(rows[0]);
  const at = (r, k) => r[ix.get(k)];
  const has = (k) => ix.has(k);

  // Discover how wide the schema is.
  let maxDv = 0;
  while (has(`dv${maxDv + 1}_x`)) maxDv++;
  let maxLeg = 0;
  while (has(`t_leg${maxLeg + 1}`)) maxLeg++;

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => c.trim() === '')) continue;

    const dvs = [];
    for (let k = 1; k <= maxDv; k++) {
      const x = numOrNull(at(r, `dv${k}_x`));
      const y = numOrNull(at(r, `dv${k}_y`));
      const z = numOrNull(at(r, `dv${k}_z`));
      if (x === null && y === null && z === null) continue;
      const v = [x ?? 0, y ?? 0, z ?? 0];
      const magCol = has(`dv${k}_mag`) ? numOrNull(at(r, `dv${k}_mag`)) : null;
      dvs.push({ v, mag: magCol ?? Math.hypot(v[0], v[1], v[2]) });
    }

    const TOF = numOrNull(at(r, 'tof'));
    const legs = [];
    for (let k = 1; k <= maxLeg; k++) {
      const t = numOrNull(at(r, `t_leg${k}`));
      if (t === null) continue;
      legs.push(t);
    }

    const n = has('n_impulse') ? numOrNull(at(r, 'n_impulse')) ?? dvs.length : dvs.length;

    // The MATLAB export names the endpoint columns From/To; accept either.
    const depId = has('dep_orbit_id') ? at(r, 'dep_orbit_id') : has('from') ? at(r, 'from') : '';
    const arrId = has('arr_orbit_id') ? at(r, 'arr_orbit_id') : has('to') ? at(r, 'to') : '';

    // For n = 2 the export leaves t_leg2 blank and t_leg1 equals TOF; more
    // generally the coast durations must sum to TOF, so fill a missing tail.
    let coasts = legs.slice(0, Math.max(0, n - 1));
    if (coasts.length === 0 && TOF !== null) coasts = [TOF];
    if (coasts.length === n - 2 && TOF !== null) {
      coasts.push(TOF - coasts.reduce((a, b) => a + b, 0));
    }

    out.push({
      dep_orbit_id: depId.trim(),
      arr_orbit_id: arrId.trim(),
      n_impulse: n,
      transfer_type: has('transfer_type') ? at(r, 'transfer_type').trim() : null,
      tof_idx: has('tof_idx') ? numOrNull(at(r, 'tof_idx')) : null,
      delta_C: has('delta_c') ? numOrNull(at(r, 'delta_c')) : null,
      rank: has('rank') ? numOrNull(at(r, 'rank')) : 1,
      seeds_converged: has('seeds_converged') ? numOrNull(at(r, 'seeds_converged')) : null,
      TOF,
      DV_total: has('dv_total') ? numOrNull(at(r, 'dv_total')) : dvs.reduce((a, d) => a + d.mag, 0),
      departure_phase: numOrNull(at(r, 'departure_phase')) ?? 0,
      arrival_phase: numOrNull(at(r, 'arrival_phase')) ?? 0,
      dvs,
      coasts,
      min_moon_dist: has('min_moon_dist') ? numOrNull(at(r, 'min_moon_dist')) : null,
      lunar_valid: has('lunar_valid') ? boolOrNull(at(r, 'lunar_valid')) : null,
      chain_id: has('chain_id') ? idOrNum(at(r, 'chain_id')) : null,
      position_residual: has('position_residual') ? numOrNull(at(r, 'position_residual')) : null,
      node_residual: has('node_residual') ? numOrNull(at(r, 'node_residual')) : null,
    });
  }
  return out;
}

/** Column set actually present, for diagnostics in the UI. */
export function csvHeader(text) {
  const rows = splitRows(text);
  return rows[0]?.map((h) => h.trim()) ?? [];
}
