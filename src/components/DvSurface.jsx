import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, dvGrid, localMinimaViolations } from '../store.js';
import { ink, rampCss, rampGradient, status } from '../theme.js';

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

const CELL = 26;
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

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !nd || !na) return;
    const w = PAD.left + na * CELL + PAD.right;
    const h = PAD.top + nd * CELL + PAD.bottom;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
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
          ctx.fillStyle = rampCss(1 - (v - min) / span);
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
  }, [grid, min, max, minCell, violations, depIdx, arrIdx, nd, na]);

  if (!nd || !na) {
    return <p style={{ color: ink.muted, fontSize: 12, margin: 0 }}>No solution grid for this pair yet.</p>;
  }

  const toCell = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const scale = r.width / (PAD.left + na * CELL + PAD.right);
    const ai = Math.floor(((e.clientX - r.left) / scale - PAD.left) / CELL);
    const di = Math.floor(((e.clientY - r.top) / scale - PAD.top) / CELL);
    if (ai < 0 || ai >= na || di < 0 || di >= nd) return null;
    return { dep: di, arr: ai };
  };

  const vunit = system?.vunitKmS ?? 1;

  return (
    <div className="panel">
      <h2>Δv surface · {nImpulse}-impulse</h2>
      <div className="heatwrap">
        <canvas
          ref={canvasRef}
          onMouseMove={(e) => {
            const c = toCell(e);
            if (!c) return setHover(null);
            const v = grid.values[c.dep * na + c.arr];
            setHover({ ...c, v, x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => setHover(null)}
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

      <div className="rampbar" style={{ background: rampGradient, transform: 'scaleX(-1)' }} />
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
