import { useEffect, useMemo, useState } from 'react';
import { useStore, solutionAt, solutionsAt, orbitFor } from '../store.js';
import { series, status, ink } from '../theme.js';
import { fitPhasesAsync } from '../lib/propagator-client.js';

/**
 * Numbers for the selected transfer, nondimensional first with the physical
 * value alongside. Per-burn magnitudes are always listed: an interior burn that
 * comes out at essentially zero means a "3-impulse" solution is really a
 * two-impulse trajectory that a better-conditioned solver happened to find, and
 * only the per-burn breakdown makes that visible.
 */

const Row = ({ k, v, sub, tone }) => (
  <div className="stat-row">
    <span className="k">{k}</span>
    <span className="v" style={tone ? { color: tone } : undefined}>
      {v}{sub && <small>{sub}</small>}
    </span>
  </div>
);

export default function Readout() {
  const system = useStore((s) => s.system);
  const pairData = useStore((s) => s.pairData);
  const depIdx = useStore((s) => s.depIdx);
  const arrIdx = useStore((s) => s.arrIdx);
  const sliceIdx = useStore((s) => s.sliceIdx);
  const nImpulse = useStore((s) => s.nImpulse);
  const compareWith = useStore((s) => s.compareWith);
  const rank = useStore((s) => s.rank);
  const hideLunarInvalid = useStore((s) => s.hideLunarInvalid);
  const setState = useStore((s) => s.set);

  const d = useMemo(() => {
    const s = useStore.getState();
    if (!s.pairData) return null;
    const pd = s.pairData;
    return {
      dep: orbitFor(s, pd.depIds[depIdx]),
      arr: orbitFor(s, pd.arrIds[arrIdx]),
      row: solutionAt(s, nImpulse, depIdx, arrIdx, sliceIdx, rank),
      alternatives: solutionsAt(s, nImpulse, depIdx, arrIdx, sliceIdx),
      compare: compareWith != null && compareWith !== nImpulse
        ? solutionAt(s, compareWith, depIdx, arrIdx, sliceIdx, 1) : null,
      slice: pd.slices[sliceIdx],
    };
  }, [pairData, depIdx, arrIdx, sliceIdx, nImpulse, compareWith, rank, hideLunarInvalid]);

  // How far the reconstructed arc lands from the arrival orbit at the published
  // arrival phase. The solver enforced this to ~1e-11, so anything larger is a
  // disagreement between the export's phase convention and ours, and is worth
  // showing rather than quietly drawing an arc that misses.
  const [fit, setFit] = useState(null);
  useEffect(() => {
    let live = true;
    setFit(null);
    if (!d?.row || !d.dep || !d.arr) return;
    fitPhasesAsync(
      { ic: Array.from(d.dep.ic), period: d.dep.period },
      { ic: Array.from(d.arr.ic), period: d.arr.period },
      d.row, 360, 'gap'
    ).then((r) => { if (live) setFit(r); }).catch(() => {});
    return () => { live = false; };
  }, [d]);

  if (!system || !d) return null;
  const { vunitKmS, tunitS, lunitKm, moonRadius } = system;
  const ms = (nd) => `${(nd * vunitKmS * 1000).toFixed(1)} m/s`;
  const days = (nd) => `${((nd * tunitS) / 86400).toFixed(2)} d`;
  const km = (nd) => `${(nd * lunitKm).toFixed(0)} km`;

  const { dep, arr, row, compare, alternatives, slice } = d;

  return (
    <div className="card readout">
      <div className="stat-row" style={{ paddingBottom: 6 }}>
        <span className="k">{dep?.id ?? '—'} → {arr?.id ?? '—'}</span>
        <span className="k">{slice ? `TOF ${slice.tof.toFixed(4)}` : ''}</span>
      </div>

      {!row ? (
        <p style={{ color: ink.muted, fontSize: 12, margin: '4px 0 0' }}>
          No converged solution recorded for this cell at this time of flight.
        </p>
      ) : (
        <>
          <div className="hero">
            {ms(row.DV_total)}
            <small>{row.DV_total.toFixed(6)} nd</small>
          </div>

          {compare && (
            <div className="stat-row" style={{ marginTop: 4 }}>
              <span className="k">vs {compare.n_impulse}-impulse</span>
              <span
                className="v"
                style={{ color: row.DV_total <= compare.DV_total ? status.good : status.warning }}
              >
                {row.DV_total <= compare.DV_total ? '−' : '+'}
                {Math.abs((row.DV_total - compare.DV_total) * vunitKmS * 1000).toFixed(1)} m/s
              </span>
            </div>
          )}

          <hr />

          <table className="mini">
            <thead>
              <tr><th>burn</th><th className="num" style={{ textAlign: 'right' }}>Δv</th><th className="num" style={{ textAlign: 'right' }}>share</th></tr>
            </thead>
            <tbody>
              {row.dvs.map((dv, i) => {
                const share = row.DV_total > 0 ? dv.mag / row.DV_total : 0;
                const negligible = dv.mag * vunitKmS * 1000 < 0.5;
                return (
                  <tr key={i}>
                    <td>
                      {i === 0 ? 'departure' : i === row.dvs.length - 1 ? 'arrival' : `midcourse ${i}`}
                      {negligible && <span style={{ color: ink.muted }}> · negligible</span>}
                    </td>
                    <td className="num">{ms(dv.mag)}</td>
                    <td className="num">{(share * 100).toFixed(0)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <hr />

          <Row k="Time of flight" v={days(row.TOF)} sub={`${row.TOF.toFixed(4)} nd`} />
          {row.coasts.length > 1 && row.coasts.map((t, i) => (
            <Row key={i} k={`Leg ${i + 1}`} v={days(t)} sub={`${t.toFixed(4)} nd`} />
          ))}
          <Row k="Departure phase" v={`${(row.departure_phase * 100).toFixed(1)}%`} sub="of period" />
          <Row k="Arrival phase" v={`${(row.arrival_phase * 100).toFixed(1)}%`} sub="of period" />

          {row.min_moon_dist != null && (
            <Row
              k="Closest lunar pass"
              v={km(row.min_moon_dist)}
              sub={`${(row.min_moon_dist / moonRadius).toFixed(1)} R☾`}
              tone={row.lunar_valid === false ? status.critical : undefined}
            />
          )}

          {row.lunar_valid === false && (
            <div className="notice critical" style={{ marginTop: 8 }}>
              <b>Impacts the Moon.</b> This arc passes below the lunar surface and is kept only
              because the filter is off.
            </div>
          )}

          <hr />
          <Row k="Departure C" v={dep?.jacobi?.toFixed(5) ?? '—'} />
          <Row k="Arrival C" v={arr?.jacobi?.toFixed(5) ?? '—'} />
          {row.position_residual != null && (
            <Row
              k="Solver residual"
              v={row.position_residual.toExponential(1)}
              tone={row.position_residual > 1e-6 ? status.warning : undefined}
            />
          )}
          {fit && (
            <>
              <Row
                k="Endpoint match"
                v={km(fit.gapAfter)}
                sub={fit.gapAfter.toExponential(1)}
                tone={fit.gapAfter < 1e-6 ? status.good : status.warning}
              />
              <Row
                k="Phase correction"
                v={`${fit.cellsDep >= 0 ? '+' : ''}${fit.cellsDep.toFixed(2)} / ${fit.cellsArr >= 0 ? '+' : ''}${fit.cellsArr.toFixed(2)}`}
                sub={`cells of 1/${fit.N}`}
              />
            </>
          )}
          {row.chain_id != null && <Row k="Multistart seed" v={row.chain_id} />}
          {row.seeds_converged != null && (
            <Row k="Seeds converged here" v={row.seeds_converged} />
          )}

          {alternatives.length > 1 && (
            <>
              <hr />
              <div className="stat-row"><span className="k">Distinct branches</span></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {alternatives.map((alt) => (
                  <button
                    key={alt.rank ?? 1}
                    onClick={() => setState({ rank: alt.rank ?? 1 })}
                    style={{
                      background: (alt.rank ?? 1) === rank ? series.transfer : 'transparent',
                      color: (alt.rank ?? 1) === rank ? '#fff' : ink.secondary,
                      border: `1px solid ${ink.border}`,
                      borderRadius: 5,
                      padding: '3px 8px',
                      font: 'inherit',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    #{alt.rank ?? 1} · {ms(alt.DV_total)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
