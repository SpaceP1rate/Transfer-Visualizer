import { useEffect } from 'react';
import { useStore } from './store.js';
import { useMediaQuery } from './hooks.js';
import Scene from './components/Scene.jsx';
import Sidebar from './components/Sidebar.jsx';
import Readout, { ReadoutSummary } from './components/Readout.jsx';
import BottomSheet from './components/BottomSheet.jsx';
import { ink } from './theme.js';

export default function App() {
  const phase = useStore((s) => s.phase);
  const error = useStore((s) => s.error);
  const system = useStore((s) => s.system);
  const pairData = useStore((s) => s.pairData);
  const init = useStore((s) => s.init);

  // Below this width there is not enough room for a sidebar and a usable scene
  // side by side, so the scene takes the screen and the controls move into a
  // sheet. It is a different tree, not just different CSS.
  const compact = useMediaQuery('(max-width: 1023px)');

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

  const header = (
    <header>
      <div className="brand">
        <h1>CR3BP Transfer Visualizer</h1>
        <span className="byline">A. Hakobyan</span>
      </div>
      <span className="meta optional-1">Earth–Moon · synodic frame · nondimensional</span>
      <span className="spacer" />
      {pairData?.icSource === 'catalog' && (
        <span
          className="meta optional-3"
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
  );

  if (compact) {
    return (
      <div className="app compact">
        {header}
        <main>
          <Scene />
        </main>
        <BottomSheet summary={<ReadoutSummary />}>
          <Readout inline />
          <Sidebar />
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      <Sidebar />
      <main>
        <Scene />
        <Readout />
      </main>
    </div>
  );
}
