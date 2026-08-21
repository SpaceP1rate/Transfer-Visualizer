/**
 * Circular restricted three-body problem: equations of motion, an adaptive
 * Dormand–Prince 5(4) integrator with dense output, and the derived quantities
 * the site needs (Jacobi constant, libration points, closest approach).
 *
 * Everything is nondimensional in the synodic (rotating) frame centred on the
 * barycentre: the primary sits at (-mu, 0, 0), the secondary at (1-mu, 0, 0),
 * X points from primary to secondary, Z along the angular velocity vector.
 *
 * Hot paths avoid allocation: states are plain `Float64Array(6)` and the
 * derivative function writes into a caller-owned output array. This module has
 * no imports so it runs identically in Node (tests) and the browser (workers).
 */

// ---------------------------------------------------------------------------
// Equations of motion
// ---------------------------------------------------------------------------

/**
 * Build the CR3BP derivative function for a given mass ratio.
 * @param {number} mu
 * @returns {(t: number, y: Float64Array, dy: Float64Array) => void}
 */
export function makeDerivs(mu) {
  const mu1 = 1 - mu;
  return function derivs(_t, y, dy) {
    const x = y[0], yy = y[1], z = y[2];
    const vx = y[3], vy = y[4], vz = y[5];

    const dx1 = x + mu;
    const dx2 = x - mu1;
    const y2 = yy * yy;
    const z2 = z * z;

    const r1sq = dx1 * dx1 + y2 + z2;
    const r2sq = dx2 * dx2 + y2 + z2;
    // r^-3 without a separate sqrt+pow: (r^2)^-1.5
    const c1 = mu1 / (r1sq * Math.sqrt(r1sq));
    const c2 = mu / (r2sq * Math.sqrt(r2sq));

    dy[0] = vx;
    dy[1] = vy;
    dy[2] = vz;
    dy[3] = 2 * vy + x - c1 * dx1 - c2 * dx2;
    dy[4] = -2 * vx + yy - c1 * yy - c2 * yy;
    dy[5] = -c1 * z - c2 * z;
  };
}

/**
 * Derivative function for the 42-dimensional state (6 state + 36 STM entries,
 * row-major). Needed by the differential corrector; not used for drawing.
 */
export function makeDerivsSTM(mu) {
  const mu1 = 1 - mu;
  return function derivsSTM(_t, y, dy) {
    const x = y[0], yy = y[1], z = y[2];
    const vx = y[3], vy = y[4], vz = y[5];

    const dx1 = x + mu;
    const dx2 = x - mu1;
    const y2 = yy * yy;
    const z2 = z * z;
    const r1sq = dx1 * dx1 + y2 + z2;
    const r2sq = dx2 * dx2 + y2 + z2;
    const r1 = Math.sqrt(r1sq), r2 = Math.sqrt(r2sq);
    const r1_3 = r1sq * r1, r2_3 = r2sq * r2;
    const r1_5 = r1_3 * r1sq, r2_5 = r2_3 * r2sq;
    const c1 = mu1 / r1_3, c2 = mu / r2_3;

    dy[0] = vx;
    dy[1] = vy;
    dy[2] = vz;
    dy[3] = 2 * vy + x - c1 * dx1 - c2 * dx2;
    dy[4] = -2 * vx + yy - c1 * yy - c2 * yy;
    dy[5] = -c1 * z - c2 * z;

    // Second partials of the pseudo-potential (symmetric 3x3 block U).
    const a1 = mu1 / r1_5, a2 = mu / r2_5;
    const Uxx = 1 - c1 - c2 + 3 * a1 * dx1 * dx1 + 3 * a2 * dx2 * dx2;
    const Uyy = 1 - c1 - c2 + 3 * a1 * y2 + 3 * a2 * y2;
    const Uzz = -c1 - c2 + 3 * a1 * z2 + 3 * a2 * z2;
    const Uxy = 3 * a1 * dx1 * yy + 3 * a2 * dx2 * yy;
    const Uxz = 3 * a1 * dx1 * z + 3 * a2 * dx2 * z;
    const Uyz = 3 * a1 * yy * z + 3 * a2 * yy * z;

    // Phi' = A Phi, with A = [[0, I], [U, Omega]], Omega = [[0,2,0],[-2,0,0],[0,0,0]]
    for (let col = 0; col < 6; col++) {
      const p0 = y[6 + 0 * 6 + col];
      const p1 = y[6 + 1 * 6 + col];
      const p2 = y[6 + 2 * 6 + col];
      const p3 = y[6 + 3 * 6 + col];
      const p4 = y[6 + 4 * 6 + col];
      const p5 = y[6 + 5 * 6 + col];

      dy[6 + 0 * 6 + col] = p3;
      dy[6 + 1 * 6 + col] = p4;
      dy[6 + 2 * 6 + col] = p5;
      dy[6 + 3 * 6 + col] = Uxx * p0 + Uxy * p1 + Uxz * p2 + 2 * p4;
      dy[6 + 4 * 6 + col] = Uxy * p0 + Uyy * p1 + Uyz * p2 - 2 * p3;
      dy[6 + 5 * 6 + col] = Uxz * p0 + Uyz * p1 + Uzz * p2;
    }
  };
}

// ---------------------------------------------------------------------------
// Dormand–Prince 5(4) with FSAL and 4th-order dense output (Hairer DOPRI5)
// ---------------------------------------------------------------------------

const A21 = 1 / 5;
const A31 = 3 / 40, A32 = 9 / 40;
const A41 = 44 / 45, A42 = -56 / 15, A43 = 32 / 9;
const A51 = 19372 / 6561, A52 = -25360 / 2187, A53 = 64448 / 6561, A54 = -212 / 729;
const A61 = 9017 / 3168, A62 = -355 / 33, A63 = 46732 / 5247, A64 = 49 / 176, A65 = -5103 / 18656;
const B1 = 35 / 384, B3 = 500 / 1113, B4 = 125 / 192, B5 = -2187 / 6784, B6 = 11 / 84;
const C2 = 1 / 5, C3 = 3 / 10, C4 = 4 / 5, C5 = 8 / 9;
// b - bhat, for the embedded error estimate
const E1 = 71 / 57600, E3 = -71 / 16695, E4 = 71 / 1920, E5 = -17253 / 339200,
  E6 = 22 / 525, E7 = -1 / 40;
// dense-output coefficients
const D1 = -12715105075 / 11282082432, D3 = 87487479700 / 32700410799,
  D4 = -10690763975 / 1880347072, D5 = 701980252875 / 199316789632,
  D6 = -1453857185 / 822651844, D7 = 69997945 / 29380423;

const SAFETY = 0.9, MIN_FACTOR = 0.2, MAX_FACTOR = 8.0;

/**
 * Adaptive DP5(4) stepper with dense output. Reusable across many propagations
 * so the per-call scratch buffers are allocated once.
 */
export class Dopri5 {
  /** @param {number} n state dimension */
  constructor(n) {
    this.n = n;
    this.y = new Float64Array(n);
    this.yNew = new Float64Array(n);
    this.tmp = new Float64Array(n);
    this.k1 = new Float64Array(n);
    this.k2 = new Float64Array(n);
    this.k3 = new Float64Array(n);
    this.k4 = new Float64Array(n);
    this.k5 = new Float64Array(n);
    this.k6 = new Float64Array(n);
    this.k7 = new Float64Array(n);
    this.r1 = new Float64Array(n);
    this.r2 = new Float64Array(n);
    this.r3 = new Float64Array(n);
    this.r4 = new Float64Array(n);
    this.r5 = new Float64Array(n);
    this.nsteps = 0;
    this.nrejected = 0;
    this.nfev = 0;
  }

  /** Interpolate the current accepted step at theta in [0,1] into `out`. */
  interpolate(theta, out) {
    const { r1, r2, r3, r4, r5, n } = this;
    const th1 = 1 - theta;
    for (let i = 0; i < n; i++) {
      out[i] = r1[i] + theta * (r2[i] + th1 * (r3[i] + theta * (r4[i] + th1 * r5[i])));
    }
    return out;
  }

  /**
   * Take one trial step of size h from (t, y). Returns the scaled error norm;
   * the caller decides whether to accept. On return `yNew` and the dense
   * coefficients describe the trial step.
   */
  _step(f, t, h, rtol, atol) {
    const { n, y, yNew, tmp, k1, k2, k3, k4, k5, k6, k7 } = this;

    for (let i = 0; i < n; i++) tmp[i] = y[i] + h * A21 * k1[i];
    f(t + C2 * h, tmp, k2);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + h * (A31 * k1[i] + A32 * k2[i]);
    f(t + C3 * h, tmp, k3);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + h * (A41 * k1[i] + A42 * k2[i] + A43 * k3[i]);
    f(t + C4 * h, tmp, k4);
    for (let i = 0; i < n; i++)
      tmp[i] = y[i] + h * (A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i]);
    f(t + C5 * h, tmp, k5);
    for (let i = 0; i < n; i++)
      tmp[i] = y[i] + h * (A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i]);
    f(t + h, tmp, k6);
    for (let i = 0; i < n; i++)
      yNew[i] = y[i] + h * (B1 * k1[i] + B3 * k3[i] + B4 * k4[i] + B5 * k5[i] + B6 * k6[i]);
    f(t + h, yNew, k7); // FSAL: becomes k1 of the next step when accepted
    this.nfev += 6;

    let err = 0;
    for (let i = 0; i < n; i++) {
      const e = h * (E1 * k1[i] + E3 * k3[i] + E4 * k4[i] + E5 * k5[i] + E6 * k6[i] + E7 * k7[i]);
      const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(yNew[i]));
      const r = e / sc;
      err += r * r;
    }
    return Math.sqrt(err / n);
  }

  _prepareDense(h) {
    const { n, y, yNew, k1, k3, k4, k5, k6, k7, r1, r2, r3, r4, r5 } = this;
    for (let i = 0; i < n; i++) {
      const dy = yNew[i] - y[i];
      const bspl = h * k1[i] - dy;
      r1[i] = y[i];
      r2[i] = dy;
      r3[i] = bspl;
      r4[i] = dy - h * k7[i] - bspl;
      r5[i] = h * (D1 * k1[i] + D3 * k3[i] + D4 * k4[i] + D5 * k5[i] + D6 * k6[i] + D7 * k7[i]);
    }
  }
}

/**
 * Integrate `f` from t0 over duration T, invoking `onSample(t, state)` at
 * `nSamples` evenly spaced times (inclusive of both ends) via dense output.
 * T may be negative. Returns the final state (a view of internal storage —
 * copy it if you need to keep it).
 *
 * @param {Function} f derivative function (t, y, dy)
 * @param {ArrayLike<number>} y0 initial state, length n
 * @param {number} T duration (signed)
 * @param {object} [opts]
 * @param {number} [opts.rtol=1e-12]
 * @param {number} [opts.atol=1e-12]
 * @param {number} [opts.nSamples=0] 0 = final state only
 * @param {(t:number, y:Float64Array, i:number)=>void} [opts.onSample]
 * @param {Dopri5} [opts.stepper] reuse a stepper to avoid reallocation
 * @param {number} [opts.maxSteps=200000]
 */
export function integrate(f, y0, T, opts = {}) {
  const n = y0.length;
  const rtol = opts.rtol ?? 1e-12;
  const atol = opts.atol ?? 1e-12;
  const nSamples = opts.nSamples ?? 0;
  const onSample = opts.onSample;
  const maxSteps = opts.maxSteps ?? 200000;
  const st = opts.stepper && opts.stepper.n === n ? opts.stepper : new Dopri5(n);
  const t0 = opts.t0 ?? 0;

  st.y.set(y0);
  st.nsteps = 0; st.nrejected = 0; st.nfev = 0;

  if (T === 0) {
    if (onSample) for (let i = 0; i < nSamples; i++) onSample(t0, st.y, i);
    return st.y;
  }

  const dir = T > 0 ? 1 : -1;
  const tEnd = t0 + T;
  const sampleDt = nSamples > 1 ? T / (nSamples - 1) : 0;
  let nextSample = 0;
  const out = new Float64Array(n);

  f(t0, st.y, st.k1);
  st.nfev++;

  // Initial step guess: a small fraction of the interval, bounded by the
  // local timescale |y|/|y'|.
  let d0 = 0, d1 = 0;
  for (let i = 0; i < n; i++) { d0 += st.y[i] * st.y[i]; d1 += st.k1[i] * st.k1[i]; }
  d0 = Math.sqrt(d0); d1 = Math.sqrt(d1);
  let h = dir * Math.min(Math.abs(T) / 100, d1 > 0 ? 0.01 * (d0 + 1e-3) / d1 : Math.abs(T) / 100);
  if (h === 0) h = dir * Math.abs(T) / 100;

  let t = t0;

  if (onSample && nSamples > 0) { onSample(t0, st.y, 0); nextSample = 1; }

  while ((tEnd - t) * dir > 0) {
    if (st.nsteps++ > maxSteps) throw new Error('integrate: step limit exceeded');
    if ((t + h - tEnd) * dir > 0) h = tEnd - t;

    const err = st._step(f, t, h, rtol, atol);

    if (err <= 1) {
      st._prepareDense(h);
      const tNew = t + h;

      // Emit every sample time that fell inside this step.
      if (onSample && nSamples > 1) {
        while (nextSample < nSamples) {
          const ts = t0 + nextSample * sampleDt;
          if ((ts - tNew) * dir > 0) break;
          const theta = h === 0 ? 0 : (ts - t) / h;
          st.interpolate(Math.min(Math.max(theta, 0), 1), out);
          onSample(ts, out, nextSample);
          nextSample++;
        }
      }

      t = tNew;
      st.y.set(st.yNew);
      st.k1.set(st.k7); // FSAL
      const factor = err === 0 ? MAX_FACTOR
        : Math.min(MAX_FACTOR, SAFETY * Math.pow(err, -0.2));
      h *= factor;
    } else {
      st.nrejected++;
      h *= Math.max(MIN_FACTOR, SAFETY * Math.pow(err, -0.2));
    }
  }

  // Guard against a final sample missed by floating-point step truncation.
  if (onSample && nSamples > 1) {
    while (nextSample < nSamples) { onSample(tEnd, st.y, nextSample); nextSample++; }
  }

  return st.y;
}

/**
 * Integrate forward until `g(t, y)` crosses zero in the given direction, then
 * refine the crossing to machine precision by bisection on the dense output.
 * Returns `{ t, y, found }`.
 */
export function integrateToEvent(f, y0, tMax, g, opts = {}) {
  const n = y0.length;
  const rtol = opts.rtol ?? 1e-12;
  const atol = opts.atol ?? 1e-12;
  const direction = opts.direction ?? 0; // +1 rising, -1 falling, 0 either
  const tMin = opts.tMin ?? 0;
  const st = opts.stepper && opts.stepper.n === n ? opts.stepper : new Dopri5(n);
  const out = new Float64Array(n);

  st.y.set(y0);
  f(0, st.y, st.k1);
  let t = 0;
  let h = Math.min(tMax / 100, 1e-2);
  let gPrev = g(t, st.y);

  while (t < tMax) {
    if ((t + h) > tMax) h = tMax - t;
    const err = st._step(f, t, h, rtol, atol);
    if (err > 1) { h *= Math.max(MIN_FACTOR, SAFETY * Math.pow(err, -0.2)); continue; }

    st._prepareDense(h);
    const tNew = t + h;
    const gNew = g(tNew, st.yNew);

    const crossed = gPrev * gNew < 0 &&
      (direction === 0 || (direction > 0 ? gNew > gPrev : gNew < gPrev));

    if (crossed && tNew > tMin) {
      let lo = 0, hi = 1, gLo = gPrev;
      for (let it = 0; it < 80; it++) {
        const mid = 0.5 * (lo + hi);
        st.interpolate(mid, out);
        const gm = g(t + mid * h, out);
        if (gm === 0) { lo = hi = mid; break; }
        if (gLo * gm < 0) hi = mid; else { lo = mid; gLo = gm; }
        if (hi - lo < 1e-15) break;
      }
      const theta = 0.5 * (lo + hi);
      st.interpolate(theta, out);
      return { t: t + theta * h, y: out, found: true };
    }

    t = tNew;
    st.y.set(st.yNew);
    st.k1.set(st.k7);
    gPrev = gNew;
    h *= Math.min(MAX_FACTOR, SAFETY * Math.pow(err === 0 ? 1e-16 : err, -0.2));
  }
  return { t, y: st.y, found: false };
}

// ---------------------------------------------------------------------------
// Derived quantities
// ---------------------------------------------------------------------------

/**
 * Jacobi constant C = 2U - v^2, conserved along any CR3BP arc.
 *
 * Uses JPL's convention (no mu*(1-mu) term), which puts C_L1 for Earth-Moon at
 * 3.18834 and matches the `jacobi` column of the periodic-orbit catalog. The
 * variant that adds mu*(1-mu) shifts every value by 0.0120 — enough to make
 * catalog lookups by Jacobi constant silently miss.
 */
export function jacobiConstant(mu, s) {
  const x = s[0], y = s[1], z = s[2];
  const r1 = Math.hypot(x + mu, y, z);
  const r2 = Math.hypot(x - 1 + mu, y, z);
  const v2 = s[3] * s[3] + s[4] * s[4] + s[5] * s[5];
  return x * x + y * y + 2 * (1 - mu) / r1 + 2 * mu / r2 - v2;
}

/** Collinear libration points from the quintic; L4/L5 in closed form. */
export function librationPoints(mu) {
  const mu1 = 1 - mu;
  // f(x) = 0 for the collinear points, solved by Newton with standard seeds.
  const solve = (guess) => {
    let x = guess;
    for (let i = 0; i < 100; i++) {
      const d1 = x + mu, d2 = x - mu1;
      const s1 = Math.sign(d1), s2 = Math.sign(d2);
      const a1 = Math.abs(d1), a2 = Math.abs(d2);
      const f = x - mu1 * s1 / (a1 * a1) - mu * s2 / (a2 * a2);
      const df = 1 + 2 * mu1 / (a1 * a1 * a1) + 2 * mu / (a2 * a2 * a2);
      const dx = f / df;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    return x;
  };
  const g = Math.cbrt(mu / (3 * mu1));
  return {
    L1: [solve(mu1 - g), 0, 0],
    L2: [solve(mu1 + g), 0, 0],
    L3: [solve(-1 - 5 * mu / 12), 0, 0],
    L4: [0.5 - mu, Math.sqrt(3) / 2, 0],
    L5: [0.5 - mu, -Math.sqrt(3) / 2, 0],
  };
}

/** Distance from a state to the secondary (the Moon), nondimensional. */
export function moonDistance(mu, s) {
  return Math.hypot(s[0] - 1 + mu, s[1], s[2]);
}
