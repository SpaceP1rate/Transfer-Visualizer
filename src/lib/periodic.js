/**
 * Periodic orbits in the CR3BP: differential correction and family continuation.
 *
 * Used two ways:
 *   1. As ground truth for the acceptance tests — a corrected orbit closes on
 *      itself to ~1e-12 by construction, so any closure failure is the
 *      integrator's fault, not the data's.
 *   2. As a local fallback family generator, so the site is developable before
 *      the JPL catalog snapshot is fetched.
 *
 * The JPL catalog remains the authoritative source for what the site displays.
 */

import { makeDerivs, makeDerivsSTM, integrate, integrateToEvent, jacobiConstant, librationPoints, Dopri5 } from './cr3bp.js';

const TOL = 1e-12;

/** Identity-seeded 42-vector: state + row-major 6x6 STM. */
function stateWithSTM(s) {
  const y = new Float64Array(42);
  y.set(s.subarray ? s.subarray(0, 6) : s.slice(0, 6));
  for (let i = 0; i < 6; i++) y[6 + i * 6 + i] = 1;
  return y;
}

const yIsZero = (_t, y) => y[1];

/**
 * Propagate a symmetric orbit IC to its next y = 0 crossing, carrying the STM.
 * For an IC of the form [x0, 0, z0, 0, vy0, 0] that crossing is the half period.
 */
function halfPeriod(mu, ic, tMax = 20) {
  const f = makeDerivsSTM(mu);
  const y0 = stateWithSTM(ic);
  const r = integrateToEvent(f, y0, tMax, yIsZero, { rtol: TOL, atol: TOL, tMin: 1e-3 });
  if (!r.found) throw new Error('halfPeriod: no y=0 crossing found');
  return { t: r.t, y: Float64Array.from(r.y) };
}

/**
 * Differentially correct a symmetric periodic orbit.
 *
 * Free variables depend on `fix`:
 *   'z'  — hold z0, vary (x0, vy0). Standard for halo families.
 *   'x'  — hold x0, vary (z0, vy0).
 *   'planar' — hold x0, vary vy0 only (Lyapunov: z ≡ 0).
 *
 * Targets vx = vz = 0 at the half-period crossing, which by the mirror theorem
 * makes the orbit periodic.
 *
 * @returns {{ic: Float64Array, period: number, jacobi: number, iterations: number, residual: number}}
 */
export function correctPeriodic(mu, guess, { fix = 'z', maxIter = 40, tol = 1e-11, maxStep = 0.05 } = {}) {
  const ic = Float64Array.from(guess);
  const f = makeDerivs(mu);
  const dy = new Float64Array(6);
  // Newton on a collinear-point orbit is sensitive: the unstable manifold
  // amplifies any overshoot into a completely different trajectory, and the
  // next iterate then targets the wrong y = 0 crossing. Damping the step keeps
  // the iteration inside the basin.
  const damp = (d) => {
    const m = Math.max(Math.abs(d[0]), Math.abs(d[1]));
    return m > maxStep ? maxStep / m : 1;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const { t: tHalf, y } = halfPeriod(mu, ic);
    const vx = y[3], vz = y[5], vy = y[4];

    const residual = fix === 'planar' ? Math.abs(vx) : Math.hypot(vx, vz);
    if (residual < tol) {
      return {
        ic,
        period: 2 * tHalf,
        jacobi: jacobiConstant(mu, ic),
        iterations: iter,
        residual,
      };
    }

    f(tHalf, y, dy);
    const ax = dy[3], az = dy[5];
    const P = (r, c) => y[6 + r * 6 + c]; // STM entry, 0-based

    if (fix === 'planar') {
      // delta_vx = (P(3,4) - ax*P(1,4)/vy) * delta_vy0
      const m = P(3, 4) - (ax * P(1, 4)) / vy;
      if (!isFinite(m) || Math.abs(m) < 1e-14) throw new Error('correctPeriodic: singular (planar)');
      const d = [-vx / m, 0];
      ic[4] += d[0] * damp(d);
    } else {
      const cA = fix === 'z' ? 0 : 2; // varied position component: x0 or z0
      const cB = 4; // vy0
      const m11 = P(3, cA) - (ax * P(1, cA)) / vy;
      const m12 = P(3, cB) - (ax * P(1, cB)) / vy;
      const m21 = P(5, cA) - (az * P(1, cA)) / vy;
      const m22 = P(5, cB) - (az * P(1, cB)) / vy;
      const det = m11 * m22 - m12 * m21;
      if (!isFinite(det) || Math.abs(det) < 1e-14) throw new Error('correctPeriodic: singular');
      const d = [(-vx * m22 + vz * m12) / det, (-vz * m11 + vx * m21) / det];
      const s = damp(d);
      ic[cA] += d[0] * s;
      ic[cB] += d[1] * s;
    }
  }
  throw new Error('correctPeriodic: did not converge');
}

/** Monodromy matrix (STM over one full period) as a row-major Float64Array(36). */
export function monodromy(mu, ic, period) {
  const f = makeDerivsSTM(mu);
  const y = integrate(f, stateWithSTM(ic), period, { rtol: TOL, atol: TOL });
  return Float64Array.from(y.subarray(6, 42));
}

/**
 * Convert a state-transition matrix from rotating-frame position/velocity
 * coordinates to canonical position/momentum coordinates.
 *
 * The CR3BP is Hamiltonian, but only in the conjugate momenta
 *   px = vx - y,   py = vy + x,   pz = vz
 * The STM propagated in (x, v) is therefore *not* symplectic; L M L^-1 is.
 * Without this transformation a symplecticity check fails by O(|M|^2) and looks
 * like an integrator bug when nothing is wrong.
 */
export function canonicalSTM(M) {
  const L = new Float64Array(36);
  const Li = new Float64Array(36);
  for (let i = 0; i < 6; i++) { L[i * 6 + i] = 1; Li[i * 6 + i] = 1; }
  L[3 * 6 + 1] = -1; Li[3 * 6 + 1] = 1;   // px = vx - y
  L[4 * 6 + 0] = 1; Li[4 * 6 + 0] = -1;   // py = vy + x

  const mul = (A, B) => {
    const O = new Float64Array(36);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += A[i * 6 + k] * B[k * 6 + j];
      O[i * 6 + j] = s;
    }
    return O;
  };
  return mul(mul(L, M), Li);
}

/** Out-of-plane 2x2 block [[z,z],[z,vz];...] of the monodromy, valid when z === 0. */
function outOfPlaneBlock(M) {
  // rows/cols 2 (z) and 5 (vz)
  return [M[2 * 6 + 2], M[2 * 6 + 5], M[5 * 6 + 2], M[5 * 6 + 5]];
}

/**
 * Natural-parameter continuation with a secant predictor and an adaptive step.
 *
 * Near a collinear libration point the orbits are small and violently unstable,
 * so a fixed step that works at large amplitude throws the corrector out of its
 * basin at small amplitude. Growing the step only after a success, and halving
 * it after a failure, walks the whole family without hand-tuning.
 *
 * @param {(p:number, predicted:Float64Array|null)=>Float64Array} seed builds an IC guess for parameter p
 * @param {(ic:Float64Array)=>object} correct returns the corrected solution
 * @param {number} p0 starting parameter
 */
function continueFamily(seed, correct, p0, { count, dpInit, dpMax, dpMin, pMax }) {
  const family = [];
  let p = p0;
  let dp = dpInit;
  let prev = null, prevPrev = null;

  while (family.length < count && Math.abs(p) <= Math.abs(pMax)) {
    // Secant predictor: extrapolate the last two converged members in p.
    let predicted = null;
    if (prev && prevPrev) {
      const w = (p - prev.p) / (prev.p - prevPrev.p);
      predicted = Float64Array.from(prev.ic);
      for (let i = 0; i < 6; i++) predicted[i] += w * (prev.ic[i] - prevPrev.ic[i]);
    } else if (prev) {
      predicted = Float64Array.from(prev.ic);
    }

    let sol = null;
    try {
      sol = correct(seed(p, predicted));
    } catch {
      sol = null;
    }

    if (sol) {
      family.push({ ic: Float64Array.from(sol.ic), period: sol.period, jacobi: sol.jacobi });
      prevPrev = prev;
      prev = { p, ic: Float64Array.from(sol.ic) };
      p += dp;
      dp = Math.sign(dp) * Math.min(Math.abs(dp) * 1.35, Math.abs(dpMax));
    } else {
      p -= dp;              // step back
      dp *= 0.4;            // and try a smaller one
      if (Math.abs(dp) < Math.abs(dpMin)) break;
      p += dp;
    }
  }
  return family;
}

/**
 * Generate a planar Lyapunov family about L1 or L2 by continuation in the
 * x-amplitude, seeded from the linearised in-plane mode.
 *
 * @returns {Array<{ic:Float64Array, period:number, jacobi:number}>}
 */
export function lyapunovFamily(mu, libr, { count = 120, seedOffset = 0.002, maxAmplitude = 0.22 } = {}) {
  const L = librationPoints(mu);
  const xL = (libr === 1 ? L.L1 : L.L2)[0];

  // Linearised in-plane motion about a collinear point: with
  // Uxx = 1 + 2c2, Uyy = 1 - c2, the oscillatory frequency and the y/x
  // amplitude ratio give a first-order periodic guess.
  const c2 = collinearC2(mu, libr, xL);
  const Uxx = 1 + 2 * c2, Uyy = 1 - c2;
  // s^2 + (2 - Uxx - Uyy) s + Uxx*Uyy = 0, take the oscillatory root
  const b = 2 - Uxx - Uyy;
  const disc = Math.sqrt(b * b - 4 * Uxx * Uyy);
  const s = (-b - disc) / 2; // negative root -> s = -omega^2
  const omega = Math.sqrt(-s);
  const kappa = (omega * omega + Uxx) / (2 * omega);

  // Parameter is the x-amplitude a = xL - x0, growing toward the primary.
  const seed = (a, predicted) => {
    if (predicted) {
      const ic = Float64Array.from(predicted);
      ic[0] = xL - a; ic[1] = 0; ic[2] = 0; ic[3] = 0; ic[5] = 0;
      return ic;
    }
    return new Float64Array([xL - a, 0, 0, 0, a * kappa * omega, 0]);
  };

  return continueFamily(
    seed,
    (ic) => correctPeriodic(mu, ic, { fix: 'planar', maxStep: 0.02 }),
    seedOffset,
    {
      count,
      dpInit: seedOffset * 0.05,
      dpMax: maxAmplitude / 40,
      dpMin: 1e-7,
      pMax: maxAmplitude,
    }
  );
}

/** c2 coefficient of the collinear-point expansion, used only for the seed. */
function collinearC2(mu, libr, xL) {
  const gamma = libr === 1 ? (1 - mu) - xL : xL - (1 - mu);
  const g = Math.abs(gamma);
  const n = 2;
  if (libr === 1) {
    return (1 / (g * g * g)) * (mu + Math.pow(-1, n) * (1 - mu) * Math.pow(g, n + 1) / Math.pow(1 - g, n + 1));
  }
  return (1 / (g * g * g)) * (Math.pow(-1, n) * mu + Math.pow(-1, n) * (1 - mu) * Math.pow(g, n + 1) / Math.pow(1 + g, n + 1));
}

/**
 * Locate the halo bifurcation on a Lyapunov family. For a planar orbit the
 * (z, vz) block of the variational equations decouples exactly, and the halo
 * family branches off where that block has eigenvalue +1, i.e. trace = 2.
 * Returns the bracketing index and a bisected orbit at the bifurcation.
 */
export function haloBifurcation(mu, family) {
  const traceOf = (o) => {
    const B = outOfPlaneBlock(monodromy(mu, o.ic, o.period));
    return B[0] + B[3];
  };
  let prev = traceOf(family[0]);
  for (let i = 1; i < family.length; i++) {
    const cur = traceOf(family[i]);
    if ((prev - 2) * (cur - 2) < 0) {
      // Bisect on x0 between the two members.
      let lo = family[i - 1].ic[0], hi = family[i].ic[0], gLo = prev - 2;
      let best = family[i];
      for (let it = 0; it < 40; it++) {
        const mid = 0.5 * (lo + hi);
        const guess = Float64Array.from(family[i].ic);
        guess[0] = mid;
        const sol = correctPeriodic(mu, guess, { fix: 'planar' });
        const gm = traceOf(sol) - 2;
        best = sol;
        if (gLo * gm < 0) hi = mid; else { lo = mid; gLo = gm; }
        if (hi - lo < 1e-12) break;
      }
      return { index: i, orbit: best };
    }
    prev = cur;
  }
  return null;
}

/**
 * Generate a halo family by stepping z0 off the Lyapunov bifurcation orbit and
 * continuing in z0. `branch` is 'N' (z0 > 0) or 'S' (z0 < 0); the two are exact
 * mirror images through the xy-plane.
 */
export function haloFamily(mu, libr, { branch = 'N', count = 120, seedZ = 0.002, maxZ = 0.25, lyapunov = null } = {}) {
  const lyap = lyapunov ?? lyapunovFamily(mu, libr, { count: 90 });
  const bif = haloBifurcation(mu, lyap);
  if (!bif) throw new Error('haloFamily: no bifurcation found on the Lyapunov family');

  const sign = branch === 'S' ? -1 : 1;
  const base = Float64Array.from(bif.orbit.ic);

  const seed = (z, predicted) => {
    const ic = Float64Array.from(predicted ?? base);
    ic[1] = 0; ic[3] = 0; ic[5] = 0;
    ic[2] = sign * z;
    return ic;
  };

  return continueFamily(
    seed,
    (ic) => correctPeriodic(mu, ic, { fix: 'z', maxStep: 0.02 }),
    seedZ,
    { count, dpInit: seedZ * 0.4, dpMax: maxZ / 30, dpMin: 1e-7, pMax: maxZ }
  );
}

export { stateWithSTM };
