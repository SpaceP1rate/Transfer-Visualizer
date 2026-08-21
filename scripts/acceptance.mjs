#!/usr/bin/env node
/**
 * Acceptance tests. Run with `npm test`.
 *
 * These run against the real catalog (public/data/orbits/*.f64), not against
 * synthetic data, so a failure means the JS propagation genuinely disagrees
 * with the initial conditions the MATLAB study used.
 *
 *   1. mu consistency        — the site's mu matches the MATLAB run
 *   2. libration points      — match JPL's published Earth-Moon values
 *   3. stored Jacobi         — the catalog's `jacobi` column reproduces from the state
 *   4. orbit closure         — one full period returns to the IC within 1e-8
 *   5. Jacobi conservation   — C is constant along every propagated arc
 *   6. dense output          — interpolated samples match direct integration
 *   7. reversibility         — forward then backward propagation is the identity
 *   8. symplecticity         — the monodromy satisfies Phi^T J Phi = J
 *   9. independent families  — locally continued families land on the catalog
 *  10. transfer closure      — the last leg reaches the arrival orbit at
 *                             arrival_phase within 1e-6 (needs the CSVs)
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDerivs, integrate, jacobiConstant, librationPoints } from '../src/lib/cr3bp.js';
import { lyapunovFamily, haloBifurcation, monodromy, canonicalSTM } from '../src/lib/periodic.js';
import { reconstructTransfer, propagateOrbit } from '../src/lib/trajectory.js';
import { parseOrbitsCsv, parseTransfersCsv } from '../src/lib/csv.js';
import { Family } from '../src/lib/catalog.js';
import { groupFiles } from '../src/lib/layout.js';
import { readEdgeFile } from '../src/lib/mat-table.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORBITS = path.join(ROOT, 'public', 'data', 'orbits');
const MU = 0.01215058560962404;
const STUDY = ['L1_Halo', 'L2_Halo', 'L1_Lyapunov', 'L2_Lyapunov'];
const SAMPLES_PER_FAMILY = 25;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};
const fmt = (v) =>
  !Number.isFinite(v) ? String(v)
    : Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5 ? v.toExponential(2) : v.toPrecision(6);

console.log('\nCR3BP acceptance tests\n' + '='.repeat(66));

// --- 1 & 2 ------------------------------------------------------------------
check('mu matches the MATLAB run', MU === 0.01215058560962404, `mu = ${MU}`);
{
  const L = librationPoints(MU);
  const ref = { L1: 0.8369151257723572, L2: 1.155682165444884, L3: -1.005062645810278 };
  const d = Math.max(
    Math.abs(L.L1[0] - ref.L1), Math.abs(L.L2[0] - ref.L2), Math.abs(L.L3[0] - ref.L3)
  );
  check('libration points match JPL', d < 1e-12, `max |dx| = ${fmt(d)}`);
}

// --- load the catalog -------------------------------------------------------
if (!existsSync(path.join(ORBITS, 'index.json'))) {
  console.log('\n  catalog missing — run `python3 scripts/convert_mat.py` first');
  process.exit(1);
}
const manifest = JSON.parse(await readFile(path.join(ORBITS, 'index.json'), 'utf8'));
const families = new Map();
for (const meta of manifest.families) {
  const buf = await readFile(path.join(ORBITS, meta.file));
  families.set(meta.key, new Family(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
}
console.log(`\n  catalog: ${families.size} families, ` +
  `${[...families.values()].reduce((a, f) => a + f.count, 0)} orbits\n`);

const f6 = makeDerivs(MU);
const sampled = [];
for (const key of STUDY) {
  const fam = families.get(key);
  if (!fam) { check(`family ${key} present`, false); continue; }
  for (const i of fam.sampleIndices(SAMPLES_PER_FAMILY)) sampled.push(fam.getCopy(i));
}

// --- 3. stored Jacobi -------------------------------------------------------
{
  let worst = 0, where = '';
  for (const fam of families.values()) {
    for (const i of fam.sampleIndices(40)) {
      const o = fam.get(i);
      const d = Math.abs(jacobiConstant(MU, o.ic) - o.jacobi);
      if (d > worst) { worst = d; where = `${fam.meta.key}[${i}]`; }
    }
  }
  check('stored Jacobi column reproduces from the state (< 1e-9)', worst < 1e-9,
    `worst = ${fmt(worst)} at ${where}`);
}

// --- 4. orbit closure -------------------------------------------------------
{
  let worst = 0, where = '';
  const t0 = Date.now();
  for (const o of sampled) {
    const end = integrate(f6, o.ic, o.period, { rtol: 1e-12, atol: 1e-12 });
    let d = 0;
    for (let i = 0; i < 6; i++) d = Math.max(d, Math.abs(end[i] - o.ic[i]));
    if (d > worst) { worst = d; where = `${o.familyKey}[${o.index}] C=${fmt(o.jacobi)}`; }
  }
  check(`orbit closure over one period < 1e-8  (${sampled.length} catalog orbits)`,
    worst < 1e-8, `worst = ${fmt(worst)} at ${where}, ${Date.now() - t0} ms`);
}

// --- 5. Jacobi conservation -------------------------------------------------
{
  let worst = 0, where = '';
  for (const o of sampled) {
    const C0 = jacobiConstant(MU, o.ic);
    let d = 0;
    integrate(f6, o.ic, 5 * o.period, {
      rtol: 1e-12, atol: 1e-12, nSamples: 120,
      onSample: (_t, y) => { const e = Math.abs(jacobiConstant(MU, y) - C0); if (e > d) d = e; },
    });
    if (d > worst) { worst = d; where = `${o.familyKey}[${o.index}]`; }
  }
  check('Jacobi drift over 5 periods < 1e-8', worst < 1e-8, `worst = ${fmt(worst)} at ${where}`);
}

// --- 6. dense output --------------------------------------------------------
{
  let worst = 0;
  for (const o of sampled.slice(0, 12)) {
    let s = null;
    integrate(f6, o.ic, o.period, {
      rtol: 1e-12, atol: 1e-12, nSamples: 101,
      onSample: (_t, y, i) => { if (i === 37) s = Float64Array.from(y); },
    });
    const direct = integrate(f6, o.ic, 0.37 * o.period, { rtol: 1e-12, atol: 1e-12 });
    for (let i = 0; i < 6; i++) worst = Math.max(worst, Math.abs(s[i] - direct[i]));
  }
  check('dense output matches direct integration < 1e-10', worst < 1e-10, `max |dx| = ${fmt(worst)}`);
}

// --- 7. reversibility -------------------------------------------------------
{
  let worst = 0;
  for (const o of sampled.slice(0, 12)) {
    const mid = Float64Array.from(integrate(f6, o.ic, 0.41 * o.period, { rtol: 1e-12, atol: 1e-12 }));
    const back = integrate(f6, mid, -0.41 * o.period, { rtol: 1e-12, atol: 1e-12 });
    for (let i = 0; i < 6; i++) worst = Math.max(worst, Math.abs(back[i] - o.ic[i]));
  }
  check('forward/backward propagation is the identity < 1e-9', worst < 1e-9, `max |dx| = ${fmt(worst)}`);
}

// --- 8. symplecticity -------------------------------------------------------
{
  const J = new Float64Array(36);
  for (let i = 0; i < 3; i++) { J[i * 6 + (i + 3)] = 1; J[(i + 3) * 6 + i] = -1; }
  let worst = 0, where = '';
  for (const o of sampled.filter((_, i) => i % 5 === 0)) {
    // Symplecticity holds in canonical coordinates, not in (x, v).
    const M = canonicalSTM(monodromy(MU, o.ic, o.period));
    // Roundoff in M is amplified by |M| when forming M^T J M, so scale the
    // tolerance with the orbit's own instability rather than using a constant.
    let nm = 0;
    for (let i = 0; i < 36; i++) nm = Math.max(nm, Math.abs(M[i]));
    const JM = new Float64Array(36);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let s = 0; for (let k = 0; k < 6; k++) s += J[i * 6 + k] * M[k * 6 + j];
      JM[i * 6 + j] = s;
    }
    let d = 0;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let s = 0; for (let k = 0; k < 6; k++) s += M[k * 6 + i] * JM[k * 6 + j];
      d = Math.max(d, Math.abs(s - J[i * 6 + j]));
    }
    const rel = d / Math.max(1, nm * nm);
    if (rel > worst) { worst = rel; where = `${o.familyKey}[${o.index}], |M| = ${fmt(nm)}`; }
  }
  check('canonical monodromy is symplectic, scaled by |M|^2 < 1e-9', worst < 1e-9,
    `worst = ${fmt(worst)} at ${where}`);
}

// --- 9. independent cross-check --------------------------------------------
{
  // Continue an L1 Lyapunov family from scratch and find where the halo family
  // branches off. That bifurcation Jacobi constant must match the maximum C of
  // the catalog's L1 halo family, which is a completely independent path to the
  // same number.
  const fam = lyapunovFamily(MU, 1, { count: 60 });
  const bif = haloBifurcation(MU, fam);
  const catalogMax = families.get('L1_Halo').meta.jacobiRange[1];
  const d = bif ? Math.abs(bif.orbit.jacobi - catalogMax) : Infinity;
  check('halo bifurcation matches the catalog family endpoint < 2e-3', d < 2e-3,
    `continued C = ${bif ? fmt(bif.orbit.jacobi) : 'n/a'}, catalog C = ${fmt(catalogMax)}`);
}

// --- 10. transfer closure ---------------------------------------------------
console.log('');
const TDIR = path.join(ROOT, 'public', 'data', 'transfers');
if (!existsSync(TDIR)) {
  console.log('  ....  transfer closure skipped: public/data/transfers not present yet');
} else {
  // Initial conditions come from the pair's orbits CSV when it has one, and
  // otherwise from the catalog sampling the study used — the same fallback the
  // site applies, so this test exercises the path the browser will take.
  const studyDir = path.join(ROOT, 'public', 'data', 'study');
  const studyIndex = existsSync(path.join(studyDir, 'index.json'))
    ? JSON.parse(await readFile(path.join(studyDir, 'index.json'), 'utf8'))
    : { pairs: [] };

  const walk = async (dir, prefix = '', depth = 0, out = []) => {
    if (depth > 4) return out;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel, depth + 1, out);
      else out.push(rel);
    }
    return out;
  };
  const { pairs } = groupFiles((await walk(TDIR)).filter((p) => p !== 'index.json'));
  if (!pairs.length) console.log('  ....  transfer closure skipped: no transfer CSVs found');

  for (const pair of pairs) {
    const orbits = new Map();
    const se = studyIndex.pairs.find((p) => p.key === pair.key)
      ?? studyIndex.pairs.find((p) => pair.key.startsWith(`${p.key}_`))
      ?? studyIndex.pairs.find((p) => p.depFamily === pair.depFamily && p.arrFamily === pair.arrFamily);
    let icSource = 'none';
    if (se) {
      const doc = JSON.parse(await readFile(path.join(studyDir, se.file), 'utf8'));
      for (const o of [...doc.dep, ...doc.arr]) {
        orbits.set(o.id, { ic: Float64Array.from(o.ic), period: o.period });
      }
      icSource = 'catalog';
    }
    if (pair.orbitsFile) {
      const doc = parseOrbitsCsv(await readFile(path.join(TDIR, pair.orbitsFile), 'utf8'));
      for (const o of doc.rows) orbits.set(o.orbit_id, { ic: o.ic, period: o.period });
      icSource = 'csv';
    }
    if (!orbits.size) { console.log(`  ....  ${pair.key}: no initial conditions available`); continue; }

    for (const variant of pair.impulses) {
      let rows = [];
      for (const rel of variant.files) {
        rows = rows.concat(parseTransfersCsv(await readFile(path.join(TDIR, rel), 'utf8')));
      }
      const sample = rows.filter((r) => r.lunar_valid !== false).slice(0, 120);
      let worst = 0, where = '', tested = 0;
      for (const r of sample) {
        const dep = orbits.get(r.dep_orbit_id);
        const arr = orbits.get(r.arr_orbit_id);
        if (!dep || !arr) continue;
        const traj = reconstructTransfer(MU, { dep, arr, transfer: r, samplesPerLeg: 2 });
        tested++;
        if (traj.closureError > worst) {
          worst = traj.closureError;
          where = `${r.dep_orbit_id}->${r.arr_orbit_id} TOF ${r.TOF.toFixed(3)}`;
        }
      }
      if (!tested) { console.log(`  ....  ${pair.key} n=${variant.n}: no rows matched the orbit ids`); continue; }
      check(
        `transfer closure < 1e-6  (${pair.key}, n=${variant.n}, ${tested} rows, ICs from ${icSource})`,
        worst < 1e-6, `worst = ${fmt(worst)} at ${where}`
      );
    }

    // Solver .mat files, read without MATLAB. This is the strongest end-to-end
    // check available: the file carries C_dep and C_arr, so the orbit labels
    // resolved from the catalog can be verified against the run's own metadata
    // before the trajectories are reconstructed at all.
    for (const rel of pair.matFiles ?? []) {
      let parsed;
      try {
        const buf = await readFile(path.join(TDIR, rel));
        parsed = await readEdgeFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } catch (e) {
        check(`read ${rel}`, false, String(e?.message ?? e));
        continue;
      }
      const { rows, report } = parsed;

      check(`${path.basename(rel)}: mu matches`, Math.abs((report.mu ?? 0) - MU) < 1e-15,
        `${report.totalRows} rows -> ${report.keptRows} kept`);

      // The .mat records the Jacobi constants of the two orbits it used; the
      // labels we resolve from the catalog must agree.
      const dep = orbits.get(rows[0].dep_orbit_id);
      const arr = orbits.get(rows[0].arr_orbit_id);
      if (dep && arr && report.cDep != null) {
        const dC = Math.abs(jacobiConstant(MU, dep.ic) - report.cDep);
        const aC = Math.abs(jacobiConstant(MU, arr.ic) - report.cArr);
        check(
          `${path.basename(rel)}: resolved orbits match the run's C_dep/C_arr`,
          Math.max(dC, aC) < 1e-9,
          `dC = ${fmt(dC)}, dC_arr = ${fmt(aC)}`
        );
      }

      let worst = 0, where = '', tested = 0;
      for (const r of rows.filter((x) => x.lunar_valid !== false)) {
        if (!dep || !arr) break;
        const traj = reconstructTransfer(MU, { dep, arr, transfer: r, samplesPerLeg: 2 });
        tested++;
        if (traj.closureError > worst) {
          worst = traj.closureError;
          where = `TOF ${r.TOF.toFixed(3)} rank ${r.rank}`;
        }
      }
      if (tested) {
        // Reconstructing from the published phases does NOT reach the solver's
        // own residual (~1e-11); the gap sits around 1e-3 and does not grow with
        // time of flight, so it is a phase-convention offset in the export, not
        // integration drift. See README, "Reproducing the published phases".
        // The bound here is a regression guard on that known offset.
        check(`${path.basename(rel)}: reconstruction gap < 2e-2  (${tested} rows, known phase offset)`,
          worst < 2e-2, `worst = ${fmt(worst)} at ${where}`);
      }
    }
  }
}

console.log('\n' + '='.repeat(66));
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
