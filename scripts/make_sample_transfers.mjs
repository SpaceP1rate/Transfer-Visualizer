#!/usr/bin/env node
/**
 * Generate a small DEMO transfer dataset so the site has something to show
 * before the research exports are dropped in.
 *
 * These are real converged two-impulse solutions, not invented numbers: for
 * each (departure orbit, arrival orbit, phase seed, time of flight) it solves
 * the same boundary-value problem the MATLAB study solves —
 *
 *     find dv1 such that  r( TOF ; x_dep(theta) + dv1 )  =  r_arr(phi)
 *
 * by Newton's method, using the state-transition matrix block dr/dv0 as the
 * exact Jacobian. dv2 is then the velocity discontinuity at arrival.
 *
 * It is NOT the research data: the phase grid is coarse and it makes no attempt
 * at a global search, so the delta-V surface is an upper bound on the study's.
 * Files are written with a `DEMO` marker in the folder name.
 *
 *   node scripts/make_sample_transfers.mjs [--pair L1_Halo_to_L2_Lyapunov] [--slices 12]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDerivs, makeDerivsSTM, integrate, moonDistance } from '../src/lib/cr3bp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDY = path.join(ROOT, 'public', 'data', 'study');
const OUT = path.join(ROOT, 'public', 'data', 'transfers');

const MU = 0.01215058560962404;
const R_MOON = 1737.4 / 384400; // the MATLAB run's lunar radius, in its own LU
const TOL = 1e-11;

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const N_SLICES = Number(argOf('slices', 14));
const N_SEEDS = Number(argOf('seeds', 6));   // phase seeds per axis
const ONLY = argOf('pair', null);

const f6 = makeDerivs(MU);
const f42 = makeDerivsSTM(MU);

const stateAt = (ic, t) =>
  t <= 0 ? Float64Array.from(ic) : Float64Array.from(integrate(f6, ic, t, { rtol: TOL, atol: TOL }));

function withSTM(x) {
  const y = new Float64Array(42);
  y.set(x);
  for (let i = 0; i < 6; i++) y[6 + i * 6 + i] = 1;
  return y;
}

/** Solve a 3x3 system by Gaussian elimination with partial pivoting. */
function solve3(A, b) {
  const M = [[A[0], A[1], A[2], b[0]], [A[3], A[4], A[5], b[1]], [A[6], A[7], A[8], b[2]]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const w = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= w * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/**
 * Newton on dv1. Returns null if it does not converge or the step blows up.
 */
function solveTransfer(xDep, rTarget, vTarget, TOF, dv1Guess) {
  let dv = Float64Array.from(dv1Guess);
  for (let it = 0; it < 30; it++) {
    const x0 = Float64Array.from(xDep);
    x0[3] += dv[0]; x0[4] += dv[1]; x0[5] += dv[2];
    const yT = integrate(f42, withSTM(x0), TOF, { rtol: TOL, atol: TOL });

    const F = [yT[0] - rTarget[0], yT[1] - rTarget[1], yT[2] - rTarget[2]];
    const err = Math.hypot(F[0], F[1], F[2]);
    if (err < 1e-11) {
      const dv2 = [vTarget[0] - yT[3], vTarget[1] - yT[4], vTarget[2] - yT[5]];
      return { dv1: Array.from(dv), dv2, residual: err };
    }
    if (!Number.isFinite(err) || err > 50) return null;

    // dr(T)/dv(0): rows 0..2, columns 3..5 of the STM.
    const J = [
      yT[6 + 0 * 6 + 3], yT[6 + 0 * 6 + 4], yT[6 + 0 * 6 + 5],
      yT[6 + 1 * 6 + 3], yT[6 + 1 * 6 + 4], yT[6 + 1 * 6 + 5],
      yT[6 + 2 * 6 + 3], yT[6 + 2 * 6 + 4], yT[6 + 2 * 6 + 5],
    ];
    const step = solve3(J, F);
    if (!step) return null;
    // Damp: an undamped Newton step near a singular Jacobian throws the arc
    // onto a completely different branch and the iteration never returns.
    const norm = Math.hypot(step[0], step[1], step[2]);
    const scale = norm > 0.5 ? 0.5 / norm : 1;
    for (let i = 0; i < 3; i++) dv[i] -= scale * step[i];
  }
  return null;
}

/** Minimum distance to the Moon along an arc, sampled like the MATLAB tagger. */
function minMoonDist(x0, TOF, samples = 400) {
  let m = Infinity;
  integrate(f6, x0, TOF, {
    rtol: TOL, atol: TOL, nSamples: samples,
    onSample: (_t, y) => { const d = moonDistance(MU, y); if (d < m) m = d; },
  });
  return m;
}

// ---------------------------------------------------------------------------

const index = JSON.parse(await readFile(path.join(STUDY, 'index.json'), 'utf8'));
const targets = index.pairs.filter((p) => !ONLY || p.key === ONLY);

for (const entry of targets) {
  const doc = JSON.parse(await readFile(path.join(STUDY, entry.file), 'utf8'));
  const dir = path.join(OUT, `${doc.key}_DEMO`);
  await mkdir(path.join(dir, 'n2'), { recursive: true });

  // Precompute phase states so each orbit is propagated once.
  const phases = Array.from({ length: N_SEEDS }, (_, i) => i / N_SEEDS);
  const depStates = doc.dep.map((o) =>
    phases.map((th) => stateAt(Float64Array.from(o.ic), th * o.period)));
  const arrStates = doc.arr.map((o) =>
    phases.map((ph) => stateAt(Float64Array.from(o.ic), ph * o.period)));

  // Use a subset of the study's own TOF grid so slice indices stay meaningful.
  const stride = Math.max(1, Math.floor(doc.tofGrid.length / N_SLICES));
  const slices = [];
  for (let i = 0; i < doc.tofGrid.length; i += stride) slices.push(i);

  const rows = [];
  const t0 = Date.now();

  for (let d = 0; d < doc.dep.length; d++) {
    for (let a = 0; a < doc.arr.length; a++) {
      for (const k of slices) {
        const TOF = doc.tofGrid[k];
        if (TOF < 0.25) continue; // very short arcs rarely converge from a cold seed
        let best = null;
        for (let ti = 0; ti < N_SEEDS; ti++) {
          for (let pi = 0; pi < N_SEEDS; pi++) {
            const xDep = depStates[d][ti];
            const xArr = arrStates[a][pi];
            // Cold seed: the straight-line rate that would close the gap.
            const guess = [
              (xArr[0] - xDep[0]) / TOF - xDep[3],
              (xArr[1] - xDep[1]) / TOF - xDep[4],
              (xArr[2] - xDep[2]) / TOF - xDep[5],
            ];
            const sol = solveTransfer(xDep, xArr, xArr.subarray(3, 6), TOF, guess);
            if (!sol) continue;
            const dv1m = Math.hypot(...sol.dv1);
            const dv2m = Math.hypot(...sol.dv2);
            const total = dv1m + dv2m;
            if (!best || total < best.total) {
              best = { ...sol, total, dv1m, dv2m, theta: phases[ti], phi: phases[pi], TOF, k };
            }
          }
        }
        if (!best) continue;

        const x0 = Float64Array.from(depStates[d][phases.indexOf(best.theta)]);
        x0[3] += best.dv1[0]; x0[4] += best.dv1[1]; x0[5] += best.dv1[2];
        const mmd = minMoonDist(x0, best.TOF);

        rows.push({
          dep_orbit_id: doc.dep[d].id,
          arr_orbit_id: doc.arr[a].id,
          n_impulse: 2,
          TOF: best.TOF,
          DV_total: best.total,
          departure_phase: best.theta,
          arrival_phase: best.phi,
          dv1_x: best.dv1[0], dv1_y: best.dv1[1], dv1_z: best.dv1[2],
          dv2_x: best.dv2[0], dv2_y: best.dv2[1], dv2_z: best.dv2[2],
          dv1_mag: best.dv1m, dv2_mag: best.dv2m,
          t_leg1: best.TOF,
          min_moon_dist: mmd,
          lunar_valid: mmd >= R_MOON,
          chain_id: 0,
          position_residual: best.residual,
          tof_idx: best.k + 1,
          rank: 1,
        });
      }
    }
    process.stdout.write(`  ${doc.key}: departure ${d + 1}/${doc.dep.length}, ${rows.length} rows\r`);
  }

  const header = Object.keys(rows[0]);
  const csv = [
    header.join(','),
    ...rows.map((r) => header.map((h) => {
      const v = r[h];
      if (typeof v !== 'number') return v;
      return Number.isInteger(v) ? String(v) : v.toPrecision(12);
    }).join(',')),
  ].join('\n');
  await writeFile(path.join(dir, 'n2', `transfers_${doc.key}_n2.csv`), csv);

  console.log(
    `\n  ${doc.key}_DEMO: ${rows.length} solutions, ` +
    `${rows.filter((r) => !r.lunar_valid).length} lunar-invalid, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)} s`
  );
}
