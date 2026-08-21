import { useStore } from '../store.js';
import DvSurface from './DvSurface.jsx';
import { series, ink, rampGradient, status } from '../theme.js';

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
  const rowsByN = useStore((s) => s.rowsByN);
  const nImpulse = useStore((s) => s.nImpulse);
  const compareWith = useStore((s) => s.compareWith);
  const depIdx = useStore((s) => s.depIdx);
  const arrIdx = useStore((s) => s.arrIdx);
  const sliceIdx = useStore((s) => s.sliceIdx);
  const sweepCount = useStore((s) => s.sweepCount);
  const system = useStore((s) => s.system);
  const view = useStore((s) => s.view);
  const scan = useStore((s) => s.scan);
  const sourceError = useStore((s) => s.sourceError);
  const allFamilies = useStore((s) => s.allFamilies);
  const catalog = useStore((s) => s.catalog);
  const set = useStore((s) => s.set);

  const available = [...rowsByN.keys()].sort((a, b) => a - b);
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

          <Field label="Impulses">
            {available.length > 1 ? (
              <select value={nImpulse ?? ''} onChange={(e) => set({ nImpulse: Number(e.target.value), rank: 1 })}>
                {available.map((n) => (
                  <option key={n} value={n}>{n}-impulse · {rowsByN.get(n).length} solutions</option>
                ))}
              </select>
            ) : (
              <input type="number" value={nImpulse ?? 2} readOnly disabled />
            )}
          </Field>

          {available.length > 1 && (
            <Field label="Overlay">
              <select
                value={compareWith ?? ''}
                onChange={(e) => set({ compareWith: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <option value="">none</option>
                {available.filter((n) => n !== nImpulse).map((n) => (
                  <option key={n} value={n}>{n}-impulse</option>
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
          <Check k="hideLunarInvalid" label="Hide arcs that hit the Moon" />
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
          <Check k="showSweep" label="Family sweep" />
          <Check k="showGrid" label="Reference grid" />
          <Check k="showLagrange" label="Libration points" />
        </div>
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
              <span className="swatch"><i style={{ background: series.departure }} />Departure orbit</span>
              <span className="swatch"><i style={{ background: series.arrival }} />Arrival orbit</span>
              <span className="swatch"><i style={{ background: series.transfer }} />Transfer, {nImpulse ?? 'n'}-impulse</span>
              {compareWith != null && (
                <span className="swatch" style={{ color: series.transferAlt }}>
                  <i className="dashed" />
                  <span style={{ color: ink.secondary }}>Transfer, {compareWith}-impulse</span>
                </span>
              )}
              <span className="swatch"><i className="dot" style={{ background: ink.primary }} />Impulse</span>
              <span className="swatch"><i style={{ background: status.critical }} />Lunar impact</span>
            </>
          )}
          <span className="swatch"><i className="dot" style={{ background: ink.secondary }} />Libration point</span>
        </div>
      </div>
    </aside>
  );
}
