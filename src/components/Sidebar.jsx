import { useRef, useState } from 'react';
import { useStore } from '../store.js';
import { LocalSource, RemoteSource, hasDirectoryPicker } from '../lib/source.js';
import { url } from '../store.js';
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

/** Pick a folder of CSV exports off disk. Nothing is uploaded. */
function SourcePicker() {
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  const inputRef = useRef(null);
  const [note, setNote] = useState(null);

  const adopt = async (src) => {
    const pairs = src.listPairs();
    if (!pairs.length) {
      setNote(`No transfer CSVs recognised in “${src.name}”. Expected transfers_*_n<k>.csv, or n<k>/ folders inside a pair folder.`);
      return;
    }
    const mats = pairs.reduce((a, p) => a + (p.matFiles?.length ?? 0), 0);
    setNote(
      `${src.name}: ${pairs.length} pair${pairs.length > 1 ? 's' : ''}, ` +
      `${src.files?.size ?? 0} file(s)${mats ? ` — ${mats} solver .mat read directly` : ''}`
    );
    await setSource(src);
  };

  return (
    <div className="panel">
      <h2>Data source</h2>
      <div style={{ display: 'flex', gap: 6 }}>
        {hasDirectoryPicker && (
          <button
            className="btn"
            onClick={async () => {
              try {
                const handle = await window.showDirectoryPicker({ mode: 'read' });
                adopt(await LocalSource.fromDirectoryHandle(handle));
              } catch { /* dismissed */ }
            }}
          >Choose folder…</button>
        )}
        <button className="btn" onClick={() => inputRef.current?.click()}>
          {hasDirectoryPicker ? 'Browse…' : 'Choose folder…'}
        </button>
        <button
          className="btn"
          onClick={async () => {
            try { adopt(await RemoteSource.open(url('data/transfers'))); }
            catch { setNote('No transfer data is committed to this site yet.'); }
          }}
        >Repository</button>
      </div>
      <input
        ref={inputRef}
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={(e) => e.target.files?.length && adopt(LocalSource.fromFileList(e.target.files))}
      />
      <p style={{ margin: 0, fontSize: 11, color: ink.muted }}>
        {source
          ? <>Reading <b style={{ color: ink.secondary }}>{source.name}</b>{source.kind === 'local' ? ' from your disk — nothing is uploaded.' : '.'}</>
          : 'No solution data loaded. Orbit geometry still works.'}
      </p>
      {note && <p style={{ margin: 0, fontSize: 11, color: ink.muted }}>{note}</p>}
    </div>
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
  const set = useStore((s) => s.set);

  const available = [...rowsByN.keys()].sort((a, b) => a - b);
  const slices = pairData?.slices ?? [];
  const slice = slices[sliceIdx];

  return (
    <aside>
      {scan && (
        <div className="panel">
          <h2>Reading solver output</h2>
          <div className="progress"><i style={{ width: `${(scan.done / scan.total) * 100}%` }} /></div>
          <div className="rampscale">
            <span>{scan.done} / {scan.total} pairings</span>
            <span>{scan.errors ? `${scan.errors} failed` : ''}</span>
          </div>
        </div>
      )}

      {sourceError && !scan && (
        <div className="notice critical">{sourceError}</div>
      )}

      <div className="panel">
        <h2>Family pair</h2>
        <select value={pairKey ?? ''} onChange={(e) => loadPair(e.target.value)}>
          {pairs.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}{p.hasTransfers ? '' : ' (geometry only)'}
            </option>
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
            <input
              type="number"
              min={2}
              max={9}
              value={nImpulse ?? 2}
              onChange={(e) => set({ nImpulse: Number(e.target.value), rank: 1 })}
              disabled={available.length <= 1}
            />
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

      {pairData && slices.length > 0 && (
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

      {pairData && (
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
          <Check k="closeArc" label="Fit phases so the arc closes" />
        </div>
      )}

      <DvSurface />

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
        </div>
      </div>

      <SourcePicker />
    </aside>
  );
}
