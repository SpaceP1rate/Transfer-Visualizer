import { useEffect } from 'react';
import { useStore } from './store.js';
import Scene from './components/Scene.jsx';
import Sidebar from './components/Sidebar.jsx';
import Readout from './components/Readout.jsx';
import { ink } from './theme.js';

export default function App() {
  const phase = useStore((s) => s.phase);
  const error = useStore((s) => s.error);
  const system = useStore((s) => s.system);
  const pairData = useStore((s) => s.pairData);
  const init = useStore((s) => s.init);

  useEffect(() => { init(); }, [init]);

  if (phase === 'loading') return <div className="centered">Loading orbit catalog…</div>;
  if (phase === 'error') {
    return (
      <div className="centered" style={{ padding: 32, textAlign: 'center' }}>
        <div>
          <p style={{ color: ink.primary }}>Could not start.</p>
          <p style={{ fontSize: 12 }}>{error}</p>
          <p style={{ fontSize: 12 }}>
            Run <code>python3 scripts/convert_mat.py</code> then <code>node scripts/build_study.mjs</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>CR3BP Transfer Visualizer</h1>
          <span className="byline">A. Hakobyan</span>
        </div>
        <span className="meta optional-1">Earth–Moon · synodic frame · nondimensional</span>
        <span className="spacer" />
        {pairData?.icSource === 'catalog' && (
          <span
            className="meta"
            title="No orbits CSV was supplied with this solve folder, so the initial conditions were resolved from the JPL Three-Body Periodic Orbits catalog using the study's own sampling rule."
          >
            Periodic orbit initial conditions from the JPL three-body catalog
          </span>
        )}
        {system && (
          <span className="meta optional-2">
            μ {system.mu.toFixed(11)} · LU {system.lunitKm.toFixed(1)} km · TU {(system.tunitS / 86400).toFixed(4)} d
          </span>
        )}
      </header>
      <Sidebar />
      <main>
        <Scene />
        <Readout />
      </main>
    </div>
  );
}
