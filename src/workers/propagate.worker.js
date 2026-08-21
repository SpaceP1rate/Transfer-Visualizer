/**
 * Propagation worker.
 *
 * All numerical integration happens here so that dragging the time-of-flight
 * slider or switching families never blocks the render loop. Geometry comes
 * back as transferable ArrayBuffers, so handing a family sweep to the main
 * thread costs a pointer move rather than a copy.
 */

import { makeDerivs, integrate, moonDistance } from '../lib/cr3bp.js';
import { Family, STRIDE } from '../lib/catalog.js';
import { reconstructTransfer, fitPhases } from '../lib/trajectory.js';
import { readEdgeFile } from '../lib/mat-table.js';

/** @type {Map<string, Family>} */
const families = new Map();
let MU = 0.01215058560962404;

const orbitFrom = (spec) => {
  if (spec.familyKey != null && spec.index != null) {
    const fam = families.get(spec.familyKey);
    if (!fam) throw new Error(`family ${spec.familyKey} not loaded in worker`);
    return fam.getCopy(spec.index);
  }
  return { ic: Float64Array.from(spec.ic), period: spec.period, jacobi: spec.jacobi };
};

const handlers = {
  /**
   * Parse one solver edge_*.mat and hand back only the reduced rows. A full
   * pairing is ~22k solutions and the raw parse allocates tens of megabytes, so
   * the reduction happens here and the bulk is dropped before it ever crosses
   * back to the main thread.
   */
  async parseEdgeMat({ buffer, path }) {
    try {
      const { rows, report } = await readEdgeFile(buffer);
      return { payload: { ok: true, path, rows, report } };
    } catch (e) {
      return { payload: { ok: false, path, error: String(e?.message ?? e) } };
    }
  },

  setMu({ mu }) {
    MU = mu;
    return { mu };
  },

  loadFamily({ key, meta, buffer }) {
    families.set(key, new Family(meta, buffer));
    return { key, count: families.get(key).count };
  },

  /**
   * Propagate one orbit for a full period.
   */
  orbit({ orbit, samples = 600 }) {
    const o = orbitFrom(orbit);
    const f = makeDerivs(MU);
    const n = Math.max(2, samples);
    const positions = new Float32Array(n * 3);
    let minMoon = Infinity;
    integrate(f, o.ic, o.period, {
      rtol: 1e-11, atol: 1e-11, nSamples: n,
      onSample: (_t, y, i) => {
        positions[i * 3] = y[0]; positions[i * 3 + 1] = y[1]; positions[i * 3 + 2] = y[2];
        const d = moonDistance(MU, y);
        if (d < minMoon) minMoon = d;
      },
    });
    return { payload: { positions, period: o.period, jacobi: o.jacobi, minMoon },
      transfer: [positions.buffer] };
  },

  /**
   * Propagate a set of family members into one concatenated buffer plus a
   * per-vertex colour attribute keyed to the Jacobi constant. Drawn as a single
   * LineSegments, so an entire family is one draw call.
   */
  familySweep({ key, indices, samples = 200, jacobiRange }) {
    const fam = families.get(key);
    if (!fam) throw new Error(`family ${key} not loaded in worker`);
    const f = makeDerivs(MU);
    const n = Math.max(2, samples);
    const m = indices.length;

    // Segment list: (n-1) segments per orbit, 2 vertices each.
    const verts = new Float32Array(m * (n - 1) * 2 * 3);
    const tvals = new Float32Array(m);
    const [cMin, cMax] = jacobiRange ?? fam.meta.jacobiRange;
    const span = cMax - cMin || 1;

    const buf = new Float32Array(n * 3);
    let w = 0;
    for (let k = 0; k < m; k++) {
      const o = fam.get(indices[k]);
      integrate(f, o.ic, o.period, {
        rtol: 1e-8, atol: 1e-8, nSamples: n,
        onSample: (_t, y, i) => {
          buf[i * 3] = y[0]; buf[i * 3 + 1] = y[1]; buf[i * 3 + 2] = y[2];
        },
      });
      for (let i = 0; i < n - 1; i++) {
        verts[w++] = buf[i * 3]; verts[w++] = buf[i * 3 + 1]; verts[w++] = buf[i * 3 + 2];
        verts[w++] = buf[(i + 1) * 3]; verts[w++] = buf[(i + 1) * 3 + 1]; verts[w++] = buf[(i + 1) * 3 + 2];
      }
      tvals[k] = (o.jacobi - cMin) / span;
    }
    return {
      payload: { positions: verts, t: tvals, segmentsPerOrbit: n - 1, count: m, jacobiRange: [cMin, cMax] },
      transfer: [verts.buffer, tvals.buffer],
    };
  },

  /** Solve for the phases that close the arc, and report the correction. */
  fitPhases({ dep, arr, transfer, N }) {
    return fitPhases(MU, { dep: orbitFrom(dep), arr: orbitFrom(arr), transfer, N });
  },

  /** Reconstruct one impulsive transfer. */
  transfer({ dep, arr, transfer, samplesPerLeg = 320, phases = null }) {
    const row = phases
      ? { ...transfer, departure_phase: phases.departurePhase, arrival_phase: phases.arrivalPhase }
      : transfer;
    const result = reconstructTransfer(MU, {
      dep: orbitFrom(dep), arr: orbitFrom(arr), transfer: row, samplesPerLeg,
    });
    const buffers = result.legs.map((l) => l.positions.buffer);
    return {
      payload: {
        legs: result.legs.map((l) => ({ index: l.index, duration: l.duration, positions: l.positions })),
        impulses: result.impulses,
        minMoonDist: result.minMoonDist,
        closureError: result.closureError,
        totalDv: result.totalDv,
      },
      transfer: buffers,
    };
  },
};

self.onmessage = async (e) => {
  const { id, type, args } = e.data;
  try {
    const out = await handlers[type](args);
    const payload = out && out.payload !== undefined ? out.payload : out;
    self.postMessage({ id, ok: true, payload }, out?.transfer ?? []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
