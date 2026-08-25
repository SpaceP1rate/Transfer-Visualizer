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
 * Sampling controls for the adaptive path builder.
 *
 * A uniform grid in time is the wrong grid for this problem. An arc that passes
 * close to the Moon covers most of its turn in a small fraction of the flight
 * time, so a grid that looks generous over the whole leg puts only a handful of
 * points through the part that actually bends — the polyline then cuts the
 * corner, the drawn periapsis sits above the true one, and an arc that grazes
 * the surface can be drawn clearing it. Sampling is therefore driven by chord
 * length, with the allowance shrinking in proportion to the distance to the
 * Moon: far away the limit is loose, near the Moon it tightens to a small
 * fraction of the current altitude.
 */
const CHORD_FAR = 0.008;      // nd, ~3000 km — plenty in open space
const CHORD_NEAR = 6e-5;      // nd, ~23 km — the floor, used at the surface
const CHORD_FRACTION = 0.04;  // of the distance to the Moon's centre
const MAX_SPLIT = 96;         // per integrator step, a backstop against blow-up

const chordLimit = (dMoon) =>
  Math.min(CHORD_FAR, Math.max(CHORD_NEAR, CHORD_FRACTION * dMoon));

/**
 * Propagate and return a polyline whose vertex spacing follows the geometry.
 *
 * Sample times come back alongside the positions: the inertial view needs the
 * epoch of every vertex, and recomputing it from an index is only possible on a
 * uniform grid, which this deliberately is not.
 *
 * @returns {{positions: Float32Array, times: Float32Array, final: Float64Array,
 *            minMoonDist: number, jacobi: number}}
 */
export function samplePath(mu, ic, T, opts = {}) {
  const f = makeDerivs(mu);
  const t0 = opts.t0 ?? 0;
  const minPoints = Math.max(2, opts.minPoints ?? 64);
  const maxPoints = opts.maxPoints ?? 60000;

  const xs = [], ts = [];
  const y = new Float64Array(6);
  let minMoonDist = Infinity;
  // When the closest approach happens, not just how close it is: the inertial
  // view marks the Moon's position at that instant, which is only meaningful
  // with the epoch attached.
  let minMoonTime = null;
  let last = Float64Array.from(ic);

  const push = (t, s) => {
    if (xs.length / 3 >= maxPoints) return;
    xs.push(s[0], s[1], s[2]);
    ts.push(t);
    const d = moonDistance(mu, s);
    if (d < minMoonDist) { minMoonDist = d; minMoonTime = t; }
  };

  push(t0, last);

  // A ceiling on the time between vertices as well, so a short, quiet arc still
  // gets enough of them to read as a curve rather than a chord.
  const dtMax = Math.abs(T) / minPoints;

  const final = integrate(f, ic, T, {
    rtol: opts.rtol ?? RTOL,
    atol: opts.atol ?? ATOL,
    stepper: stepper6,
    t0,
    onSegment: (tStep, h, interp) => {
      interp(1, y);
      const chord = Math.hypot(y[0] - last[0], y[1] - last[1], y[2] - last[2]);
      // The tighter of the two endpoints' allowances: entering a close pass is
      // as important as leaving one.
      const allow = Math.min(
        chordLimit(moonDistance(mu, last)),
        chordLimit(moonDistance(mu, y))
      );
      const m = Math.max(
        1,
        Math.min(MAX_SPLIT, Math.max(Math.ceil(chord / allow), Math.ceil(Math.abs(h) / dtMax)))
      );
      for (let j = 1; j <= m; j++) {
        interp(j / m, y);
        push(tStep + (h * j) / m, y);
      }
      last.set(y);
    },
  });

  return {
    positions: Float32Array.from(xs),
    times: Float32Array.from(ts),
    final: Float64Array.from(final),
    minMoonDist,
    minMoonTime,
    jacobi: jacobiConstant(mu, ic),
  };
}

/**
 * Propagate a state for duration T.
 *
 * `nSamples` is now a lower bound on the vertex count rather than the count
 * itself — see samplePath.
 */
export function propagateOrbit(mu, ic, T, nSamples = 600, opts = {}) {
  return samplePath(mu, ic, T, { ...opts, minPoints: nSamples });
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
  let minMoonTime = 0;
  let totalDv = 0;

  const nLegs = Math.max(0, t.coasts.length);
  let elapsed = 0;
  for (let L = 0; L < nLegs; L++) {
    const dv = t.dvs[L]?.v ?? [0, 0, 0];
    impulses.push({
      index: L + 1,
      position: [X[0], X[1], X[2]],
      dv,
      mag: t.dvs[L]?.mag ?? Math.hypot(dv[0], dv[1], dv[2]),
      time: elapsed,
    });
    totalDv += impulses[L].mag;

    X[3] += dv[0]; X[4] += dv[1]; X[5] += dv[2];

    const dt = t.coasts[L];
    // Times are absolute along the transfer, counted from the departure burn,
    // so the inertial view can rotate every vertex by its own epoch.
    const arc = samplePath(mu, X, dt, {
      t0: elapsed, minPoints: samplesPerLeg, rtol: RTOL, atol: ATOL,
    });
    if (arc.minMoonDist < minMoonDist) {
      minMoonDist = arc.minMoonDist;
      minMoonTime = arc.minMoonTime ?? elapsed;
    }
    legs.push({
      index: L + 1,
      duration: dt,
      positions: arc.positions,
      times: arc.times,
      startState: Float64Array.from(X),
    });
    elapsed += dt;
    X = Float64Array.from(arc.final);
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

  return { legs, impulses, endState: X, minMoonDist, minMoonTime, closureError, totalDv };
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
