import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, dvGrid, localMinimaViolations } from '../store.js';
import { ink, surfaceCss, surfaceGradient, status } from '../theme.js';

/**
 * Delta-V over the departure x arrival grid at one time of flight.
 *
 * Magnitude, so one sequential hue: darkest = cheapest, lightest = dearest,
 * against the dark surface. Cells where nothing converged stay empty rather
 * than being painted as "zero cost", which is the difference between a gap in
 * the search and a free transfer.
 *
 * Two annotations are deliberate rather than decorative:
 *   - the cheapest cell carries a ring and a direct label, because the minimum
 *     is what the grid is read for;
 *   - cells where the n-impulse solver came out dearer than the two-impulse one
 *     are marked, since that is impossible at a true optimum and therefore
 *     evidence of a local minimum.
 */

// The cell size is derived from the rendered width rather than fixed, so the
// canvas is never scaled after the fact. A canvas stretched by CSS needs its
// pointer coordinates divided back by that stretch on each axis independently,
// which is easy to get wrong and impossible to notice at the origin — the error
// is zero in the top-left corner and grows with distance from it.
const MIN_CELL = 14;
const PAD = { left: 34, top: 20, right: 6, bottom: 6 };

export default function DvSurface() {
  const canvasRef = useRef(null);
  const [hover, setHover] = useState(null);

  const pairData = useStore((s) => s.pairData);
  const nImpulse = useStore((s) => s.nImpulse);
  const sliceIdx = useStore((s) => s.sliceIdx);
  const depIdx = useStore((s) => s.depIdx);
  const arrIdx = useStore((s) => s.arrIdx);
  const hideLunarInvalid = useStore((s) => s.hideLunarInvalid);
  const system = useStore((s) => s.system);
  const setState = useStore((s) => s.set);

  const { grid, violations, min, max, minCell } = useMemo(() => {
    const s = useStore.getState();
    const g = dvGrid(s, nImpulse, sliceIdx);
    const finite = [...g.values].filter(Number.isFinite);
    let minCell = -1, lo = Infinity, hi = -Infinity;
    g.values.forEach((v, k) => {
      if (!Number.isFinite(v)) return;
      if (v < lo) { lo = v; minCell = k; }
      if (v > hi) hi = v;
    });
    return {
      grid: g,
      violations: localMinimaViolations(s, nImpulse, sliceIdx),
      min: finite.length ? lo : NaN,
      max: finite.length ? hi : NaN,
      minCell,
    };
  }, [pairData, nImpulse, sliceIdx, hideLunarInvalid]);

  const nd = grid.nd, na = grid.na;

  // Width the canvas is actually laid out at, measured rather than assumed.
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  // Re-run when the grid appears: on the first render there is no data yet, the
  // component returns early, and the element this observes does not exist.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [nd, na]);

  const CELL = na && width ? Math.max(MIN_CELL, (width - PAD.left - PAD.right) / na) : MIN_CELL;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !nd || !na || !width) return;
    const w = PAD.left + na * CELL + PAD.right;
    const h = PAD.top + nd * CELL + PAD.bottom;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // CSS size and drawing size agree exactly, so one CSS pixel is one drawing
    // unit and a pointer position needs no conversion at all.
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const span = max - min || 1;
    const violSet = new Set(violations.map((v) => v.dep * na + v.arr));

    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (let d = 0; d < nd; d++) {
      ctx.fillStyle = ink.muted;
      ctx.textAlign = 'right';
      ctx.fillText(String(d + 1), PAD.left - 6, PAD.top + d * CELL + CELL / 2);

      for (let a = 0; a < na; a++) {
        const k = d * na + a;
        const v = grid.values[k];
        const x = PAD.left + a * CELL;
        const y = PAD.top + d * CELL;

        if (!Number.isFinite(v)) {
          // No converged solution: hatch faintly so a gap never reads as cheap.
          ctx.fillStyle = ink.surface;
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
          ctx.strokeStyle = ink.axis;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 6, y + CELL - 6);
          ctx.lineTo(x + CELL - 6, y + 6);
          ctx.stroke();
        } else {
          ctx.fillStyle = surfaceCss((v - min) / span);
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
        }

        if (violSet.has(k)) {
          ctx.strokeStyle = status.warning;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 2.5, y + 2.5, CELL - 5, CELL - 5);
        }
        if (k === minCell) {
          ctx.strokeStyle = ink.primary;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
        }
        if (d === depIdx && a === arrIdx) {
          ctx.strokeStyle = ink.primary;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(x - 0.5, y - 0.5, CELL + 1, CELL + 1);
          ctx.setLineDash([]);
        }
      }
    }

    ctx.fillStyle = ink.muted;
    ctx.textAlign = 'center';
    for (let a = 0; a < na; a++) {
      ctx.fillText(String(a + 1), PAD.left + a * CELL + CELL / 2, PAD.top - 9);
    }
  }, [grid, min, max, minCell, violations, depIdx, arrIdx, nd, na, width, CELL]);

  if (!nd || !na) {
    return <p style={{ color: ink.muted, fontSize: 12, margin: 0 }}>No solution grid for this pair yet.</p>;
  }

  // A plain function, deliberately: this sits after an early return, and a hook
  // here changes the hook count between renders the moment the grid is empty.
  const toCell = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ai = Math.floor((e.clientX - r.left - PAD.left) / CELL);
    const di = Math.floor((e.clientY - r.top - PAD.top) / CELL);
    if (ai < 0 || ai >= na || di < 0 || di >= nd) return null;
    return { dep: di, arr: ai };
  };

  const vunit = system?.vunitKmS ?? 1;

  return (
    <div className="panel">
      <h2>Δv surface · {nImpulse}-impulse</h2>
      <div className="heatwrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onMouseMove={(e) => {
            const c = toCell(e);
            if (!c) return setHover(null);
            const v = grid.values[c.dep * na + c.arr];
            setHover({ ...c, v, x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => setHover(null)}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onClick={(e) => {
            const c = toCell(e);
            if (c) setState({ depIdx: c.dep, arrIdx: c.arr, rank: 1 });
          }}
        />
        {hover && (
          <div className="tooltip" style={{ left: hover.x + 14, top: hover.y - 8 }}>
            <b>{pairData.depIds[hover.dep]} → {pairData.arrIds[hover.arr]}</b>
            {Number.isFinite(hover.v)
              ? <>Δv {hover.v.toFixed(5)} nd · {(hover.v * vunit * 1000).toFixed(1)} m/s</>
              : <>no converged solution</>}
          </div>
        )}
      </div>

      <div className="rampbar" style={{ background: surfaceGradient }} />
      <div className="rampscale">
        <span>{Number.isFinite(min) ? `${(min * vunit * 1000).toFixed(0)} m/s` : '—'}</span>
        <span className="axis-label">departure ↓ · arrival →</span>
        <span>{Number.isFinite(max) ? `${(max * vunit * 1000).toFixed(0)} m/s` : '—'}</span>
      </div>

      {violations.length > 0 && (
        <div className="notice">
          <b>{violations.length} cell{violations.length > 1 ? 's' : ''}</b> where the {nImpulse}-impulse
          solution costs more than the 2-impulse one. The {nImpulse}-impulse feasible set contains the
          2-impulse one, so these mark solver local minima, not better physics.
        </div>
      )}
    </div>
  );
}
