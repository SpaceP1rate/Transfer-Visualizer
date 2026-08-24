import { useStore } from '../store.js';
import DvSurface from './DvSurface.jsx';
import { series, ink, rampGradient, status } from '../theme.js';

/**
 * How a phase grid is named in the menu. The side length is always shown — a
 * run tagged `_p25` says so outright, an untagged one has it recovered from the
 * seed numbering, and only a non-square seed count falls back to the raw count.
 */
function gridLabel(v) {
  const g = v.grid;
  if (!g) return v.p ? `${v.p} x ${v.p}` : 'grid';
  if (g.side) return `${g.side} x ${g.side}${g.exact ? '' : '*'}`;
  return `${g.seeds.toLocaleString()} seeds`;
}

function Field({ label, children }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Check({ k, label }) {
  const v = useStore((s) => s[k]);
  const set = useStore((s) => s.set);
  return (
    <label className="check">
      <input type="checkbox" checked={!!v} onChange={(e) => set({ [k]: e.target.checked })} />
      {label}
    </label>
  );
}

export default function Sidebar() {
  const pairs = useStore((s) => s.pairs);
  const pairKey = useStore((s) => s.pairKey);
  const loadPair = useStore((s) => s.loadPair);
  const pairData = useStore((s) => s.pairData);
  const variants = useStore((s) => s.variants);
  const nImpulse = useStore((s) => s.nImpulse);
  const phaseRes = useStore((s) => s.phaseRes);
  const depIdx = useStore((s) => s.depIdx);
  const arrIdx = useStore((s) => s.arrIdx);
  const sliceIdx = useStore((s) => s.sliceIdx);
  const sweepCount = useStore((s) => s.sweepCount);
  const system = useStore((s) => s.system);
  const view = useStore((s) => s.view);
  const inertial = useStore((s) => s.inertial);
  const scan = useStore((s) => s.scan);
  const sourceError = useStore((s) => s.sourceError);
  const allFamilies = useStore((s) => s.allFamilies);
  const catalog = useStore((s) => s.catalog);
  const set = useStore((s) => s.set);

  // Impulse counts, and the phase grids solved for the selected one. Both lists
  // are what the folders hold — never a free-form number.
  const available = [...new Set(variants.map((v) => v.n))].sort((a, b) => a - b);
  const grids = variants.filter((v) => v.n === nImpulse);
  const slices = pairData?.slices ?? [];
  const slice = slices[sliceIdx];
  const hasSolutions = pairs.length > 0;

  return (
    <aside>
      {scan && (
        <div className="panel">
          <h2>Reading solve folder</h2>
          <div className="progress"><i style={{ width: `${(scan.done / scan.total) * 100}%` }} /></div>
          <div className="rampscale">
            <span>{scan.done} / {scan.total} pairings</span>
            <span>{scan.errors ? `${scan.errors} failed` : ''}</span>
          </div>
        </div>
      )}

      {sourceError && !scan && <div className="notice critical">{sourceError}</div>}

      {hasSolutions ? (
        <div className="panel">
          <h2>Solution</h2>
          <select value={pairKey ?? ''} onChange={(e) => loadPair(e.target.value)}>
            {pairs.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>

          {/* The impulse counts are the n<k> folders this solve actually has —
              never a free-form number, and never a count inferred from the rows.
              A pair with n2/ and n3/ offers 2 and 3, and nothing else. */}
          <Field label="Impulses">
            <select
              value={nImpulse ?? ''}
              onChange={(e) => {
                // Switching impulse count may land on a run solved at different
                // phase grids; keep the current one when it exists there.
                const n = Number(e.target.value);
                const ps = variants.filter((v) => v.n === n).map((v) => v.p ?? null);
                set({
                  nImpulse: n,
                  phaseRes: ps.includes(phaseRes) ? phaseRes : (ps[0] ?? null),
                  rank: 1,
                });
              }}
              disabled={available.length < 2}
            >
              {available.map((n) => (
                <option key={n} value={n}>{n}-impulse</option>
              ))}
            </select>
          </Field>

          {/* Phase grid is its own axis: n2_p25 and n2_p50 are two solves of the
              same problem at different multistart densities, so switching one
              must not disturb the other. */}
          {grids.length > 0 && (
            <Field label="Phase grid">
              <select
                value={phaseRes ?? ''}
                disabled={grids.length < 2}
                onChange={(e) => set({
                  phaseRes: e.target.value === '' ? null : Number(e.target.value),
                  rank: 1,
                })}
              >
                {grids.map((v) => (
                  <option key={v.key} value={v.p ?? ''}>
                    {gridLabel(v)} · {v.rows.length.toLocaleString()} solutions
                  </option>
                ))}
              </select>
            </Field>
          )}

        </div>
      ) : (
        <div className="panel">
          <h2>Solutions</h2>
          <div className="notice">
            <b>No solutions present.</b> Nothing is committed under
            {' '}<code>public/data/solutions/</code>, so the view is showing the full orbit
            catalog instead. Drop a solve folder in, run
            {' '}<code>node scripts/build_data_index.mjs</code>, and it appears here.
          </div>
          <div className="rampscale">
            <span>{allFamilies.length} families</span>
            <span>
              {catalog
                ? `${catalog.manifest.families.reduce((a, f) => a + f.count, 0).toLocaleString()} orbits`
                : ''}
            </span>
          </div>
        </div>
      )}

      {hasSolutions && slices.length > 0 && (
        <div className="panel">
          <h2>Time of flight</h2>
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={slices.length - 1}
              step={1}
              value={sliceIdx}
              onChange={(e) => set({ sliceIdx: Number(e.target.value), rank: 1 })}
            />
            <span className="value">
              {slice ? `${((slice.tof * system.tunitS) / 86400).toFixed(2)} d` : '—'}
            </span>
          </div>
          <div className="rampscale">
            <span>slice {sliceIdx + 1} / {slices.length}</span>
            <span>{slice ? `${slice.tof.toFixed(4)} nd` : ''}</span>
          </div>
        </div>
      )}

      {hasSolutions && pairData && (
        <div className="panel">
          <h2>Orbit pair</h2>
          <Field label="Departure">
            <select value={depIdx} onChange={(e) => set({ depIdx: Number(e.target.value), rank: 1 })}>
              {pairData.depIds.map((id, i) => <option key={id} value={i}>{id}</option>)}
            </select>
          </Field>
          <Field label="Arrival">
            <select value={arrIdx} onChange={(e) => set({ arrIdx: Number(e.target.value), rank: 1 })}>
              {pairData.arrIds.map((id, i) => <option key={id} value={i}>{id}</option>)}
            </select>
          </Field>
        </div>
      )}

      {hasSolutions && <DvSurface />}

      <div className="panel">
        <h2>Scene</h2>
        <div className="viewbar">
          {['3D', 'XY', 'XZ', 'YZ'].map((v) => (
            <button
              key={v}
              className={`btn${view === v ? ' on' : ''}`}
              onClick={() => set({ view: v })}
            >{v}</button>
          ))}
        </div>
        <div className="checks">
          <Check k="inertial" label="Inertial frame" />
          {!inertial && <Check k="showSweep" label="Family sweep" />}
          <Check k="showGrid" label="Reference grid" />
          {!inertial && <Check k="showLagrange" label="Libration points" />}
        </div>
        {inertial && (
          <div className="rampscale">
            <span>Arcs span one time of flight · ghost Moon marks departure</span>
          </div>
        )}
        <div className="slider-row">
          <input
            type="range" min={10} max={220} step={10}
            value={sweepCount}
            onChange={(e) => set({ sweepCount: Number(e.target.value) })}
          />
          <span className="value">{sweepCount} members</span>
        </div>
        <div className="rampbar" style={{ background: rampGradient }} />
        <div className="rampscale"><span>low C</span><span>Jacobi constant</span><span>high C</span></div>
      </div>

      <div className="panel">
        <h2>Legend</h2>
        <div className="swatches">
          {hasSolutions && (
            <>
              {/* Arcs first, in the order the eye meets them along a transfer:
                  the orbit you leave, the orbit you arrive on, the arc between.
                  The point markers come after, so line entries and point
                  entries are never interleaved. */}
              <span className="swatch"><i style={{ background: series.departure }} />Departure orbit</span>
              <span className="swatch"><i style={{ background: series.arrival }} />Arrival orbit</span>
              <span className="swatch"><i style={{ background: series.transfer }} />Transfer, {nImpulse ?? 'n'}-impulse</span>
              <span className="swatch"><i className="dot" style={{ background: ink.primary }} />Impulse</span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
