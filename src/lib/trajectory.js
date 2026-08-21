/**
 * Turning parameters into drawable geometry.
 *
 * Neither data source stores coordinates: the JPL catalog gives an initial
 * state and a period, the MATLAB export gives phases, burn vectors and coast
 * durations. Both become polylines by numerical propagation, done here once and
 * reused by every view.
 *
 * Positions come back as `Float32Array` triples, ready to hand straight to a
 * three.js BufferAttribute with no copy.
 */

import { makeDerivs, integrate, jacobiConstant, moonDistance, Dopri5 } from './cr3bp.js';

const RTOL = 1e-11;
const ATOL = 1e-11;

// One stepper reused across calls; the CR3BP state is always 6-dimensional.
const stepper6 = new Dopri5(6);

/**
 * Phase-array resolution the study ran at — the `N` in the MATLAB driver.
 * It is part of the solution's definition, not a display choice: see below.
 */
export const PHASE_RESOLUTION = 360;

/**
 * State on a periodic orbit at a given phase, reproducing the convention the
 * solver used.
 *
 * This is NOT `propagate(ic, phase * period)`. The MATLAB run precomputes a
 * table of N states at `linspace(0, T, N)` and reads it back by linear
 * interpolation at continuous index `phase * N + 1` (1-based). Two things
 * follow, and both matter:
 *
 *   - the effective time is `phase * T * N / (N - 1)`, because index `phase*N`
 *     steps of size `T/(N-1)` is not `phase*T`;
 *   - the state is a chord between two table entries, not a point on the orbit.
 *
 * The solver converged its burns against exactly that state, so reproducing it
 * is what makes an arc close. Propagating to `phase * T` instead leaves a gap of
 * order 1e-3 nd — a few hundred km — which grows with how unstable the orbit is,
 * and no adjustment of the phases can remove it because the discrepancy is in
 * the state, not the timing.
 *
 * @param {number} N table resolution; must match the run.
 */
export function phaseState(mu, orbit, phase, N = PHASE_RESOLUTION, out = new Float64Array(6)) {
  const table = phaseTable(mu, orbit, N);
  const th = phase - Math.floor(phase);
  const x = th * N;
  const lo = Math.min(N - 1, Math.floor(x));
  const hi = (lo + 1) % N;          // the table wraps: row N-1 and row 0 coincide
  const w = x - lo;
  for (let k = 0; k < 6; k++) out[k] = (1 - w) * table[lo * 6 + k] + w * table[hi * 6 + k];
  return out;
}

// Building a table costs one propagation, and the same handful of orbits is
// asked for over and over as the time-of-flight slider moves.
const phaseTables = new Map();
const TABLE_CACHE = 64;

function phaseTable(mu, orbit, N) {
  const key = `${mu}|${N}|${orbit.period}|${Array.prototype.join.call(orbit.ic, ',')}`;
  const hit = phaseTables.get(key);
  if (hit) return hit;

  const table = new Float64Array(N * 6);
  integrate(makeDerivs(mu), orbit.ic, orbit.period, {
    rtol: 1e-12, atol: 1e-12, nSamples: N, stepper: stepper6,
    onSample: (_t, y, i) => table.set(y, i * 6),
  });

  if (phaseTables.size >= TABLE_CACHE) phaseTables.delete(phaseTables.keys().next().value);
  phaseTables.set(key, table);
  return table;
}

/**
 * Propagate a state for duration T, sampling `nSamples` points.
 * @returns {{positions: Float32Array, states: Float64Array, final: Float64Array,
 *            minMoonDist: number, jacobi: number}}
 */
export function propagateOrbit(mu, ic, T, nSamples = 600, opts = {}) {
  const f = makeDerivs(mu);
  const n = Math.max(2, nSamples | 0);
  const positions = new Float32Array(n * 3);
  const states = opts.keepStates ? new Float64Array(n * 6) : null;
  let minMoonDist = Infinity;

  const final = integrate(f, ic, T, {
    rtol: opts.rtol ?? RTOL,
    atol: opts.atol ?? ATOL,
    nSamples: n,
    stepper: stepper6,
    onSample: (_t, y, i) => {
      positions[i * 3] = y[0];
      positions[i * 3 + 1] = y[1];
      positions[i * 3 + 2] = y[2];
      if (states) states.set(y, i * 6);
      const d = moonDistance(mu, y);
      if (d < minMoonDist) minMoonDist = d;
    },
  });

  return {
    positions,
    states,
    final: Float64Array.from(final),
    minMoonDist,
    jacobi: jacobiConstant(mu, ic),
  };
}

/** Convenience: one full revolution of a periodic orbit. */
export function propagatePeriodicOrbit(mu, orbit, nSamples = 600) {
  return propagateOrbit(mu, orbit.ic, orbit.period, nSamples);
}

/**
 * Reconstruct an impulsive transfer.
 *
 *   X  = state on the departure orbit at departure_phase
 *   for each leg L in 1..n-1:
 *       X.v += dv_L            (burn)
 *       draw the coast of duration t_legL
 *   the final burn dv_n is applied on arrival and changes no geometry
 *
 * @param {number} mu
 * @param {object} args
 * @param {{ic: Float64Array, period: number}} args.dep departure orbit
 * @param {{ic: Float64Array, period: number}} args.arr arrival orbit
 * @param {object} args.transfer parsed row from parseTransfersCsv
 * @param {number} [args.samplesPerLeg=300]
 * @returns {{legs: Array, impulses: Array, endState: Float64Array,
 *            minMoonDist: number, closureError: number|null, totalDv: number}}
 */
export function reconstructTransfer(mu, { dep, arr, transfer, samplesPerLeg = 300, N = PHASE_RESOLUTION }) {
  const f = makeDerivs(mu);
  const t = transfer;

  // Departure state, read off the phase array exactly as the solver did.
  let X = Float64Array.from(phaseState(mu, dep, t.departure_phase ?? 0, N));

  const legs = [];
  const impulses = [];
  let minMoonDist = moonDistance(mu, X);
  let totalDv = 0;

  const nLegs = Math.max(0, t.coasts.length);
  for (let L = 0; L < nLegs; L++) {
    const dv = t.dvs[L]?.v ?? [0, 0, 0];
    impulses.push({
      index: L + 1,
      position: [X[0], X[1], X[2]],
      dv,
      mag: t.dvs[L]?.mag ?? Math.hypot(dv[0], dv[1], dv[2]),
      time: legs.reduce((a, l) => a + l.duration, 0),
    });
    totalDv += impulses[L].mag;

    X[3] += dv[0]; X[4] += dv[1]; X[5] += dv[2];

    const dt = t.coasts[L];
    const n = Math.max(2, samplesPerLeg | 0);
    const positions = new Float32Array(n * 3);
    const end = integrate(f, X, dt, {
      rtol: RTOL, atol: ATOL, nSamples: n, stepper: stepper6,
      onSample: (_tt, y, i) => {
        positions[i * 3] = y[0];
        positions[i * 3 + 1] = y[1];
        positions[i * 3 + 2] = y[2];
        const d = moonDistance(mu, y);
        if (d < minMoonDist) minMoonDist = d;
      },
    });
    legs.push({ index: L + 1, duration: dt, positions, startState: Float64Array.from(X) });
    X = Float64Array.from(end);
  }

  // Arrival burn: no geometry, but it is part of the cost.
  const lastDv = t.dvs[nLegs];
  if (lastDv) {
    impulses.push({
      index: nLegs + 1,
      position: [X[0], X[1], X[2]],
      dv: lastDv.v,
      mag: lastDv.mag,
      time: t.TOF,
      arrival: true,
    });
    totalDv += lastDv.mag;
  }

  // How well the reconstruction lands on the arrival orbit — the constraint the
  // MATLAB solver enforced, so this doubles as a cross-implementation check.
  let closureError = null;
  if (arr) {
    const target = phaseState(mu, arr, t.arrival_phase ?? 0, N);
    closureError = Math.hypot(X[0] - target[0], X[1] - target[1], X[2] - target[2]);
  }

  return { legs, impulses, endState: X, minMoonDist, closureError, totalDv };
}

/**
 * Solve for the departure and arrival phases that actually close the transfer.
 *
 * The exported phases do not reproduce the solver's own residual: reconstructing
 * from them leaves a gap of order 1e-3, while correcting both phases by a
 * fraction of a phase-array cell brings the arc back to ~1e-9. The burns, the
 * time of flight and the orbits are all exactly right — it is the two phase
 * labels that are off. This recovers the trajectory the solver actually found,
 * and reports how large a correction that took.
 *
 * Coordinate descent with a shrinking step: the objective is smooth and the
 * correction is always small, so this converges in well under a hundred
 * propagations and needs no derivatives.
 *
 * @param {number} N phase-array resolution used by the run, for reporting the
 *                   correction in grid cells (the driver's `N`, default 360)
 */
/**
 * Batch-propagate a whole family for the background sweep. Returns one
 * concatenated position buffer plus the index ranges of each orbit, which lets
 * three.js draw the entire family as a single LineSegments draw call.
 */
export function buildFamilyGeometry(mu, orbits, samplesPerOrbit = 240) {
  const n = Math.max(2, samplesPerOrbit | 0);
  const positions = new Float32Array(orbits.length * n * 3);
  const jacobi = new Float32Array(orbits.length);
  const ranges = [];
  const f = makeDerivs(mu);

  for (let k = 0; k < orbits.length; k++) {
    const o = orbits[k];
    const base = k * n * 3;
    integrate(f, o.ic ?? new Float64Array([o.x, o.y, o.z, o.vx, o.vy, o.vz]), o.period, {
      rtol: 1e-9, atol: 1e-9, nSamples: n, stepper: stepper6,
      onSample: (_t, y, i) => {
        positions[base + i * 3] = y[0];
        positions[base + i * 3 + 1] = y[1];
        positions[base + i * 3 + 2] = y[2];
      },
    });
    jacobi[k] = o.jacobi ?? 0;
    ranges.push({ start: k * n, count: n });
  }
  return { positions, jacobi, ranges, samplesPerOrbit: n };
}

/** Nondimensional -> physical, using JPL's lunit/tunit. */
export function makeUnits(system) {
  const { lunitKm, tunitS, vunitKmS } = system;
  return {
    km: (nd) => nd * lunitKm,
    ms: (nd) => nd * vunitKmS * 1000,
    days: (nd) => (nd * tunitS) / 86400,
    hours: (nd) => (nd * tunitS) / 3600,
  };
}
