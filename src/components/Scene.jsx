import { useMemo, useRef, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Line, Html, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';

import { useStore, solutionAt, orbitFor } from '../store.js';
import { useAsync, toPoints } from '../hooks.js';
import { PHASE_RESOLUTION } from '../lib/trajectory.js';
import { propagateOrbitAsync, familySweepAsync, transferAsync } from '../lib/propagator-client.js';
import { ink, series, status, ramp } from '../theme.js';

/**
 * The rotating (synodic) frame, drawn in nondimensional units: the barycentre
 * at the origin, the Earth at (-mu, 0, 0), the Moon at (1-mu, 0, 0), both
 * stationary. Z is the angular-velocity axis, so the camera's up vector is Z.
 */

/**
 * A soft dot with a dark rim, drawn once and reused. Point sprites keep markers
 * at a fixed pixel size no matter how far the camera is, which is what a marker
 * should do — a world-sized sphere is invisible when zoomed out and swallows the
 * trajectory when zoomed in.
 */
function makeMarkerTexture(kind) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);

  if (kind === 'cross') {
    // Libration points are locations, not events, so they get a different mark
    // from an impulse: a thin cross reads as a coordinate and never looks like
    // a burn or a body.
    g.strokeStyle = '#ffffff';
    g.lineWidth = S * 0.09;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(S * 0.12, S / 2); g.lineTo(S * 0.88, S / 2);
    g.moveTo(S / 2, S * 0.12); g.lineTo(S / 2, S * 0.88);
    g.stroke();
  } else {
    g.beginPath();
    g.arc(S / 2, S / 2, S * 0.42, 0, Math.PI * 2);
    g.fillStyle = ink.page;
    g.fill();
    g.beginPath();
    g.arc(S / 2, S / 2, S * 0.30, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const markerTextures = {};
const getMarker = (kind = 'dot') => (markerTextures[kind] ??= makeMarkerTexture(kind));

/** Fixed-pixel-size markers at a list of positions. */
function Markers({ positions, color, size = 7, depthTest = true, kind = 'dot' }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
    return g;
  }, [positions]);
  useEffect(() => () => geom.dispose(), [geom]);
  if (!positions.length) return null;
  return (
    <points geometry={geom}>
      <pointsMaterial
        map={getMarker(kind)}
        color={color}
        size={size}
        sizeAttenuation={false}
        transparent
        alphaTest={0.35}
        depthTest={depthTest}
      />
    </points>
  );
}

/**
 * Rotating (synodic) -> inertial, for a whole polyline.
 *
 *   r_i = Rz(t) r_r,   omega = 1 in nondimensional units, so the angle is t
 *
 * Only positions are transformed; the velocity term (v_r + omega x r_r) matters
 * for dynamics but nothing here draws a velocity. Every vertex carries its own
 * epoch because the sample grid is adaptive, and `epoch` shifts a body's own
 * clock onto the shared one — the transfer's departure is t = 0, so a departure
 * orbit is drawn with a negative offset and an arrival orbit with TOF minus its
 * arrival phase time.
 */
function toInertial(positions, times, epoch = 0, out = new Float32Array(positions.length)) {
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const t = (times ? times[i] : 0) + epoch;
    const c = Math.cos(t), s = Math.sin(t);
    const x = positions[i * 3], y = positions[i * 3 + 1];
    out[i * 3] = c * x - s * y;
    out[i * 3 + 1] = s * x + c * y;
    out[i * 3 + 2] = positions[i * 3 + 2];
  }
  return out;
}

/** One point, same convention as above. */
const rotatePoint = (p, t) => [
  Math.cos(t) * p[0] - Math.sin(t) * p[1],
  Math.sin(t) * p[0] + Math.cos(t) * p[1],
  p[2],
];

/**
 * The epoch of a phase on a periodic orbit, in the solver's own convention —
 * index `phase * N` of an N-entry table spanning [0, T] in N-1 steps.
 */
const phaseTime = (phase, period, N = PHASE_RESOLUTION) =>
  (phase ?? 0) * period * (N / (N - 1));

/**
 * Arrowheads along a path, showing which way it is travelled.
 *
 * In the rotating frame the direction of motion is often guessable from the
 * geometry; in the inertial frame, where an orbit unrolls into a rosette, it is
 * not. Cones are placed at equal arc length and rescaled every frame against the
 * camera distance, so they keep a constant size on screen the way the other
 * markers do.
 */
function DirectionArrows({ positions, color, count = 6 }) {
  const ref = useRef();
  const { camera } = useThree();

  const nodes = useMemo(() => {
    if (!positions || positions.length < 12) return [];
    const n = positions.length / 3;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1] + Math.hypot(
        positions[i * 3] - positions[(i - 1) * 3],
        positions[i * 3 + 1] - positions[(i - 1) * 3 + 1],
        positions[i * 3 + 2] - positions[(i - 1) * 3 + 2]
      );
    }
    const total = cum[n - 1];
    if (!(total > 0)) return [];
    const out = [];
    let j = 1;
    for (let k = 0; k < count; k++) {
      const target = ((k + 0.5) / count) * total;
      while (j < n - 1 && cum[j] < target) j++;
      const a = Math.max(0, j - 1), b = Math.min(n - 1, j + 1);
      const dir = new THREE.Vector3(
        positions[b * 3] - positions[a * 3],
        positions[b * 3 + 1] - positions[a * 3 + 1],
        positions[b * 3 + 2] - positions[a * 3 + 2]
      );
      if (dir.lengthSq() === 0) continue;
      out.push({
        p: new THREE.Vector3(positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]),
        q: new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0), dir.normalize()
        ),
      });
    }
    return out;
  }, [positions, count]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh || !nodes.length) return;
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    for (let i = 0; i < nodes.length; i++) {
      // Constant apparent size: the cone grows with how far away it is.
      const d = camera.position.distanceTo(nodes[i].p);
      const sc = Math.max(0.001, d * 0.008);
      scale.set(sc, sc, sc);
      m.compose(nodes[i].p, nodes[i].q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (!nodes.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, nodes.length]} frustumCulled={false}>
      <coneGeometry args={[0.35, 1, 10]} />
      <meshBasicMaterial color={color} transparent opacity={0.95} depthWrite={false} />
    </instancedMesh>
  );
}

function Bodies({ tof = null }) {
  const system = useStore((s) => s.system);
  const showLagrange = useStore((s) => s.showLagrange);
  const inertial = useStore((s) => s.inertial);
  const { mu, moonRadius, earthRadius } = system;

  const L = useMemo(() => librationPoints(mu), [mu]);

  // Where the bodies are on the shared clock. The rotating frame holds them
  // still by construction; the inertial one carries them round at omega = 1, so
  // by arrival the Moon has moved through an angle equal to the time of flight.
  const t = inertial && Number.isFinite(tof) ? tof : 0;
  const earthAt = inertial ? rotatePoint([-mu, 0, 0], t) : [-mu, 0, 0];
  const moonAt = inertial ? rotatePoint([1 - mu, 0, 0], t) : [1 - mu, 0, 0];
  const ghostMoon = inertial && t !== 0 ? [1 - mu, 0, 0] : null;

  // The Moon's circle is the thing every arc is read against; without it the
  // inertial picture has no scale.
  const paths = useMemo(() => {
    if (!inertial) return null;
    const circle = (r) => {
      const pts = [];
      for (let i = 0; i <= 256; i++) {
        const a = (i / 256) * Math.PI * 2;
        pts.push([r * Math.cos(a), r * Math.sin(a), 0]);
      }
      return pts;
    };
    return { moon: circle(1 - mu), earth: circle(mu) };
  }, [inertial, mu]);

  return (
    <group>
      <mesh position={earthAt}>
        <sphereGeometry args={[earthRadius ?? 0.0164, 32, 24]} />
        <meshStandardMaterial color="#2b4a7a" roughness={0.9} metalness={0} />
      </mesh>
      <Html
        position={[earthAt[0], earthAt[1], earthAt[2] + (earthRadius ?? 0.0164) * 2.4]}
        center style={labelStyle} zIndexRange={LABEL_Z}
      >Earth</Html>

      {/* In the inertial frame the Moon has moved by the time the vehicle
          arrives. The ghost marks where it was at the departure burn and the
          solid body where it is at arrival, which is the difference between a
          transfer that meets the Moon and one that merely crosses its orbit. */}
      {ghostMoon && (
        <>
          <mesh position={ghostMoon}>
            <sphereGeometry args={[moonRadius, 20, 14]} />
            <meshStandardMaterial
              color="#8d8b84" roughness={1} metalness={0}
              transparent opacity={0.28} depthWrite={false}
            />
          </mesh>
          {/* At this scale the Moon is a few pixels across and a translucent
              one is easy to miss, so the ghost says what it is. */}
          <Html
            position={[ghostMoon[0], ghostMoon[1], ghostMoon[2] + moonRadius * 9]}
            center style={{ ...labelStyle, color: ink.muted }} zIndexRange={LABEL_Z}
          >Moon at departure</Html>
        </>
      )}

      <mesh position={moonAt}>
        <sphereGeometry args={[moonRadius, 24, 18]} />
        <meshStandardMaterial color="#8d8b84" roughness={1} metalness={0} />
      </mesh>
      <Html
        position={[moonAt[0], moonAt[1], moonAt[2] + moonRadius * 9]}
        center style={labelStyle} zIndexRange={LABEL_Z}
      >{ghostMoon ? 'Moon at arrival' : 'Moon'}</Html>

      {paths && (
        <>
          <Line points={paths.moon} color={ink.axis} lineWidth={1} transparent opacity={0.7} />
          <Line points={paths.earth} color={ink.axis} lineWidth={1} transparent opacity={0.5} />
        </>
      )}

      {/* Libration points are fixed points of the rotating frame and nothing
          else; in the inertial frame they would sweep circles of their own and
          mean nothing, so they are simply not drawn. */}
      {showLagrange && !inertial && (
        <>
          <Markers positions={Object.values(L)} color={ink.secondary} size={11} kind="cross" />
          {Object.entries(L).map(([name, p]) => (
            <Html
              key={name}
              position={p}
              center
              style={{ ...labelStyle, transform: 'translate(13px,-9px)' }}
              zIndexRange={LABEL_Z}
            >
              {name}
            </Html>
          ))}
        </>
      )}
    </group>
  );
}

/* Labels are overlays on the scene, not chrome: they sit above the canvas and
   below every panel. The library's default range tops out near 2^24, which wins
   against anything else on the page. */
const LABEL_Z = [6, 0];

const labelStyle = {
  color: ink.secondary,
  font: '11px system-ui, sans-serif',
  letterSpacing: '0.04em',
  pointerEvents: 'none',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};

/** Collinear points by Newton; L4/L5 in closed form. Mirrors src/lib/cr3bp.js. */
function librationPoints(mu) {
  const mu1 = 1 - mu;
  const solve = (guess) => {
    let x = guess;
    for (let i = 0; i < 80; i++) {
      const d1 = x + mu, d2 = x - mu1;
      const s1 = Math.sign(d1), s2 = Math.sign(d2);
      const a1 = Math.abs(d1), a2 = Math.abs(d2);
      const f = x - mu1 * s1 / (a1 * a1) - mu * s2 / (a2 * a2);
      const df = 1 + 2 * mu1 / (a1 ** 3) + 2 * mu / (a2 ** 3);
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

/**
 * Reference grid on the orbital plane.
 *
 * Two nested scales — 0.1 nd near the origin, 0.5 nd out to 8 — each faded to
 * nothing at its own edge by per-vertex alpha. A grid that simply stops draws a
 * hard rectangle in the middle of empty space and makes the scene look like it
 * sits on a table; fading it means there is never a visible boundary, so it
 * reads as an infinite plane at any zoom.
 */
function ReferenceGrid() {
  const geom = useMemo(() => {
    const pos = [];
    const col = [];
    const base = new THREE.Color(ink.axis);

    // Flat over most of the disc, dropping off only near the rim: fading the
    // whole thing evenly would just make a dim grid, and the point is that it
    // has no visible edge.
    const alpha = (x, y, R) => {
      const r = Math.min(1, Math.hypot(x, y) / R);
      const r4 = r * r * r * r;
      return 1 - r4;
    };

    // Each line is subdivided rather than drawn end to end. A single segment has
    // only its two endpoints to carry alpha, and every endpoint here sits on the
    // rim where alpha is zero — so an unsubdivided grid fades to nothing along
    // its entire length and disappears completely.
    const SEG = 48;
    const addLine = (ax, ay, bx, by, R, weight) => {
      let px = ax, py = ay, pa = alpha(ax, ay, R) * weight;
      for (let i = 1; i <= SEG; i++) {
        const t = i / SEG;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const a = alpha(x, y, R) * weight;
        pos.push(px, py, 0, x, y, 0);
        col.push(base.r, base.g, base.b, pa, base.r, base.g, base.b, a);
        px = x; py = y; pa = a;
      }
    };

    // Fine grid close in, coarse grid far out. The coarse one carries past where
    // the fine one has faded, so there is no ring where the detail changes.
    for (const [R, step, weight] of [[1.7, 0.1, 1.0], [9, 0.5, 0.75]]) {
      const n = Math.round(R / step);
      for (let i = -n; i <= n; i++) {
        const v = i * step;
        const half = Math.sqrt(Math.max(0, R * R - v * v));
        if (half <= 1e-9) continue;
        addLine(-half, v, half, v, R, weight);
        addLine(v, -half, v, half, R, weight);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    return g;
  }, []);

  useEffect(() => () => geom.dispose(), [geom]);

  return (
    <lineSegments geometry={geom} renderOrder={-1}>
      <lineBasicMaterial vertexColors transparent depthWrite={false} />
    </lineSegments>
  );
}

/**
 * A whole family drawn as one LineSegments, coloured by Jacobi constant along
 * the sequential ramp. One draw call regardless of how many members are shown.
 */
/**
 * @param {[number, number]|null} jacobiWindow limit the members drawn to this
 *        Jacobi range. With a solution loaded this is the C span the surface
 *        actually covers, so the sweep shows the family the study sampled from
 *        rather than the whole catalog branch — an L1 halo family runs from
 *        C 2.41 up to 3.17, and its low-C end is the near-rectilinear geometry
 *        that reads as a completely different family on screen.
 */
function FamilySweep({ familyKey, count, opacity = 0.42, jacobiWindow = null }) {
  const fam = useStore((s) => s.families.get(familyKey));
  const inertial = useStore((s) => s.inertial);
  const win = jacobiWindow ? `${jacobiWindow[0]}:${jacobiWindow[1]}` : 'all';

  const [data] = useAsync(() => {
    if (!fam) return null;
    let indices;
    if (jacobiWindow) {
      const inRange = fam.inJacobiRange(jacobiWindow[0], jacobiWindow[1]);
      if (!inRange.length) return null;
      const step = Math.max(1, Math.floor(inRange.length / count));
      indices = inRange.filter((_, i) => i % step === 0);
    } else {
      indices = fam.sampleIndices(count);
    }
    const range = jacobiWindow ?? fam.meta.jacobiRange;
    return familySweepAsync(familyKey, indices, 160, range, `sweep:${familyKey}`);
  }, [familyKey, fam, count, win]);

  const geom = useMemo(() => {
    if (!data) return null;
    const g = new THREE.BufferGeometry();

    // The sweep is a background reference, so each member is drawn on its own
    // clock: there is no epoch that would make an arbitrary family member line
    // up with the selected transfer, and pretending otherwise would imply a
    // phase relationship the data does not contain.
    let positions = data.positions;
    if (inertial && data.periods) {
      const n = data.segmentsPerOrbit + 1;
      const perOrbit = data.segmentsPerOrbit * 2;
      const times = new Float32Array(data.positions.length / 3);
      for (let k = 0; k < data.count; k++) {
        const T = data.periods[k];
        for (let i = 0; i < data.segmentsPerOrbit; i++) {
          const v = k * perOrbit + i * 2;
          times[v] = (T * i) / (n - 1);
          times[v + 1] = (T * (i + 1)) / (n - 1);
        }
      }
      positions = toInertial(data.positions, times);
    }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const perOrbit = data.segmentsPerOrbit * 2;
    const colors = new Float32Array(positions.length);
    for (let k = 0; k < data.count; k++) {
      const [r, gg, b] = ramp(data.t[k]);
      for (let i = 0; i < perOrbit; i++) {
        const o = (k * perOrbit + i) * 3;
        colors[o] = r; colors[o + 1] = gg; colors[o + 2] = b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [data, inertial]);

  useEffect(() => () => geom?.dispose(), [geom]);
  if (!geom) return null;
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial vertexColors transparent opacity={opacity} />
    </lineSegments>
  );
}

/**
 * One periodic orbit, propagated for a full revolution.
 *
 * `epoch` places the orbit's own t = 0 on the shared clock; it only matters in
 * the inertial frame, and propagation does not depend on it, so changing it
 * never costs a re-propagation.
 */
/**
 * One periodic orbit.
 *
 * In the rotating frame it is a full period from the stored initial condition —
 * the closed curve everyone expects. In the inertial frame, with a transfer
 * selected, it is instead the window the transfer actually spans: the departure
 * orbit forward from its burn for one TOF, the arrival orbit backward from its
 * burn for the same. Three arcs over one shared window is a picture of what
 * happens during the transfer; a full period each is a picture of three
 * unrelated durations laid on top of one another.
 */
function PeriodicOrbit({ orbit, color, opacity = 1, width = 2, epoch = 0, window: win = null, arrows = true }) {
  const inertial = useStore((s) => s.inertial);
  const active = inertial ? win : null;

  const [data] = useAsync(
    () => (orbit
      ? propagateOrbitAsync(
        { ic: Array.from(orbit.ic), period: orbit.period },
        700,
        active
          ? { phase: active.phase, duration: active.duration, t0: active.t0 }
          : {}
      )
      : null),
    [orbit?.id, orbit?.period, active?.phase, active?.duration, active?.t0]
  );
  const positions = useMemo(() => {
    if (!data) return null;
    // With a window the worker already stamped absolute times; without one the
    // orbit runs on its own clock and `epoch` places it on the shared one.
    return inertial ? toInertial(data.positions, data.times, active ? 0 : epoch) : data.positions;
  }, [data, inertial, epoch, active]);
  const points = useMemo(() => (positions ? toPoints(positions) : null), [positions]);
  if (!points) return null;
  return (
    <>
      <Line points={points} color={color} lineWidth={width} transparent opacity={opacity} />
      {arrows && <DirectionArrows positions={positions} color={color} />}
    </>
  );
}

/** One reconstructed transfer: coast arcs plus a marker at every impulse. */
function Transfer({ dep, arr, row, color, dashed = false, showImpulses = true, channel }) {
  const [data] = useAsync(() => {
    if (!dep || !arr || !row) return null;
    return transferAsync(
      { ic: Array.from(dep.ic), period: dep.period },
      { ic: Array.from(arr.ic), period: arr.period },
      row, 340, channel
    );
  }, [dep?.id, arr?.id, row, channel]);

  const inertial = useStore((s) => s.inertial);
  const legs = useMemo(() => {
    if (!data) return [];
    return data.legs.map((l) => toPoints(inertial ? toInertial(l.positions, l.times) : l.positions));
  }, [data, inertial]);
  const impulses = useMemo(() => {
    if (!data) return [];
    return data.impulses.map((im) => (inertial ? rotatePoint(im.position, im.time ?? 0) : im.position));
  }, [data, inertial]);
  if (!data) return null;

  return (
    <group>
      {legs.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color={color}
          lineWidth={dashed ? 1.5 : 2.4}
          dashed={dashed}
          dashSize={0.012}
          gapSize={0.012}
          transparent
          opacity={dashed ? 0.85 : 1}
        />
      ))}
      {showImpulses && (
        <Markers
          positions={impulses}
          color={ink.primary}
          size={8}
          depthTest={false}
        />
      )}
    </group>
  );
}

/**
 * Camera presets. Reading transfer geometry usually means looking straight down
 * one axis — the in-plane loop from above, the halo's z-excursion edge-on — so
 * the projections are one click away rather than a manual orbit each time.
 */
export const VIEWS = {
  '3D': { pos: [0.55, -1.15, 0.85], up: [0, 0, 1] },
  'XY': { pos: [0, 0, 1.55], up: [0, 1, 0] },
  'XZ': { pos: [0, -1.55, 0], up: [0, 0, 1] },
  'YZ': { pos: [1.75, 0, 0], up: [0, 0, 1] },
};

function CameraRig({ target, zoom = 1 }) {
  const { camera } = useThree();
  const controls = useRef();
  const view = useStore((s) => s.view);

  // Map convention on touch: one finger slides the scene, two fingers turn it,
  // and the pinch inside that two-finger gesture still zooms. Assigned on the
  // instance rather than passed as a prop — the controls read `touches` live,
  // and going through the declarative layer leaves the default bindings in
  // place. The mouse keeps orbit-first bindings, where drag-to-rotate is the
  // norm and there is a second button for panning.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.touches.ONE = THREE.TOUCH.PAN;
    c.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
  });

  useEffect(() => {
    const v = VIEWS[view] ?? VIEWS['3D'];
    // Presets are offsets from the framing target, so switching view keeps
    // whatever the user is looking at centred. `zoom` widens the framing when
    // the scene is the whole catalog rather than a single transfer.
    camera.up.set(...v.up);
    camera.position.set(
      target.x + v.pos[0] * zoom,
      target.y + v.pos[1] * zoom,
      target.z + v.pos[2] * zoom
    );
    camera.lookAt(target);
    controls.current?.update();
  }, [view, camera, target, zoom]);

  return (
    <OrbitControls
      ref={controls}
      target={target}
      enableDamping
      dampingFactor={0.12}
      minDistance={0.02}
      maxDistance={12}
    />
  );
}

export default function Scene() {
  const system = useStore((s) => s.system);
  const showSweep = useStore((s) => s.showSweep);
  const showGrid = useStore((s) => s.showGrid);
  const sweepCount = useStore((s) => s.sweepCount);
  const depFamily = useStore((s) => s.depFamily);
  const arrFamily = useStore((s) => s.arrFamily);

  // Subscribe to the primitives only, then derive off a snapshot. Selecting the
  // whole store here would re-render the canvas on every slider tick.
  const depIdx = useStore((s) => s.depIdx);
  const arrIdx = useStore((s) => s.arrIdx);
  const sliceIdx = useStore((s) => s.sliceIdx);
  const nImpulse = useStore((s) => s.nImpulse);
  const phaseRes = useStore((s) => s.phaseRes);
  const rank = useStore((s) => s.rank);
  const allFamilies = useStore((s) => s.allFamilies);
  const hasSolutions = useStore((s) => s.pairs.length > 0);
  const pairData = useStore((s) => s.pairData);
  const inertial = useStore((s) => s.inertial);

  const { depOrbit, arrOrbit, row } = useMemo(() => {
    const s = useStore.getState();
    if (!s.pairData) return {};
    return {
      depOrbit: orbitFor(s, s.pairData.depIds[depIdx]),
      arrOrbit: orbitFor(s, s.pairData.arrIds[arrIdx]),
      row: solutionAt(s, nImpulse, depIdx, arrIdx, sliceIdx, rank),
    };
  }, [pairData, depIdx, arrIdx, sliceIdx, nImpulse, phaseRes, rank]);

  // One clock for the whole scene, with the departure burn at t = 0. The
  // departure orbit therefore starts a phase-time *before* zero, and the
  // arrival orbit is offset so that its arrival phase falls at t = TOF — which
  // is what makes the transfer visibly join the two rosettes instead of
  // pointing at empty space.
  const epochs = useMemo(() => {
    if (!row || !depOrbit || !arrOrbit) return { dep: 0, arr: 0 };
    return {
      dep: -phaseTime(row.departure_phase, depOrbit.period),
      arr: (row.TOF ?? 0) - phaseTime(row.arrival_phase, arrOrbit.period),
    };
  }, [row, depOrbit, arrOrbit]);

  /**
   * The window each orbit is drawn over in the inertial view.
   *
   * Both orbits start at their own beginning — phase 0, the stored initial
   * condition — never at the burn, so what is drawn is the orbit itself rather
   * than a segment starting at an arbitrary point on it. The clock starts at
   * the departure burn in either case; only the duration changes:
   *
   *   TOF longer than the longest period  -> both run for one TOF
   *   otherwise                           -> each runs for its own period,
   *                                          and the transfer for its TOF
   */
  const windows = useMemo(() => {
    if (!row?.TOF) return { dep: null, arr: null };
    const longest = Math.max(depOrbit?.period ?? 0, arrOrbit?.period ?? 0);
    const long = row.TOF > longest;
    return {
      dep: { phase: null, duration: long ? row.TOF : (depOrbit?.period ?? row.TOF), t0: 0 },
      arr: { phase: null, duration: long ? row.TOF : (arrOrbit?.period ?? row.TOF), t0: 0 },
    };
  }, [row, depOrbit, arrOrbit]);

  // With a transfer selected the interesting region is the Earth-Moon corridor;
  // with the whole catalog on screen it is the entire system, including the
  // L4/L5 families that reach out to |r| ~ 1.
  // Framing. In the rotating frame the action is fixed in the Earth-Moon
  // corridor. In the inertial frame it is not: the two arcs sit near the Moon's
  // circle at whatever angle their epochs put them, so the camera is aimed at
  // the middle of the span they actually occupy rather than at the barycentre,
  // which would leave them off to one side.
  const { target, zoom } = useMemo(() => {
    const r = system ? 1 - system.mu : 1;
    if (!hasSolutions) return { target: new THREE.Vector3(0, 0, 0), zoom: 2.3 };
    if (!inertial) return { target: new THREE.Vector3(r - 0.08, 0, 0), zoom: 1 };

    // In the inertial view the arcs are spread along the Moon's circle over the
    // window being drawn, so both the aim point and the framing follow that
    // window: the centroid of a circular arc of angle `span`, and enough
    // distance to fit the chord it subtends.
    const span = Math.min(
      2 * Math.PI,
      Math.max(row?.TOF ?? 0, depOrbit?.period ?? 0, arrOrbit?.period ?? 0) || 1
    );
    const half = span / 2;
    const centroidR = half > 1e-6 ? r * (Math.sin(half) / half) : r;
    const chord = 2 * r * Math.sin(Math.min(half, Math.PI / 2));
    // The camera presets sit at |pos| ~ 1.55 and the field of view is 34 deg.
    const height = Math.max(0.6, chord * 1.45);
    return {
      target: new THREE.Vector3(centroidR * Math.cos(half), centroidR * Math.sin(half), 0),
      zoom: Math.min(3.2, height / 0.947),
    };
  }, [system, hasSolutions, inertial, row, depOrbit, arrOrbit]);

  // 13 families at full resolution is an unreadable thicket; thin them and let
  // the member slider bring detail back on demand.
  const catalogSweepCount = Math.min(40, Math.max(12, Math.round(sweepCount / 3)));

  // The Jacobi span each family actually contributes to the loaded surface,
  // taken from the orbits the run used rather than from the catalog extent.
  const jacobiWindows = useMemo(() => {
    const out = {};
    if (!pairData?.orbits) return out;
    for (const o of pairData.orbits.values()) {
      if (!o.family || !Number.isFinite(o.jacobi)) continue;
      const w = out[o.family];
      out[o.family] = w ? [Math.min(w[0], o.jacobi), Math.max(w[1], o.jacobi)] : [o.jacobi, o.jacobi];
    }
    // A hair of margin so the endpoint members are never clipped by rounding.
    for (const k of Object.keys(out)) {
      const [lo, hi] = out[k];
      const pad = Math.max(1e-6, (hi - lo) * 0.02);
      out[k] = [lo - pad, hi + pad];
    }
    return out;
  }, [pairData]);

  if (!system) return null;

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0.55, -1.15, 0.85], fov: 34, near: 0.001, far: 100, up: [0, 0, 1] }}
      gl={{ antialias: true }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(ink.page); }}
    >
      <ambientLight intensity={0.75} />
      <directionalLight position={[-3, -2, 4]} intensity={1.5} />

      {showGrid && <ReferenceGrid />}
      <Bodies tof={inertial ? row?.TOF ?? null : null} />

      {/* The sweep is a rotating-frame device: unrolled into inertial space it
          is a smear of unrelated epochs that hides the arcs it is meant to give
          context to. */}
      {showSweep && !inertial && (hasSolutions
        // With solutions loaded, only the two families in play are drawn, and
        // only across the Jacobi span the loaded surface covers.
        ? [depFamily, arrFamily]
          .filter((k, i, a) => k && a.indexOf(k) === i)
          .map((k) => (
            <FamilySweep
              key={k}
              familyKey={k}
              count={sweepCount}
              jacobiWindow={jacobiWindows[k]}
              // Unrolled into inertial space the sweep covers far more of the
              // screen, so it is dimmed to stay a background layer.
              opacity={inertial ? 0.2 : 0.42}
            />
          ))
        // Nothing committed: show the whole catalog, thinned so it stays legible.
        : allFamilies.map((k) => (
          <FamilySweep key={k} familyKey={k} count={catalogSweepCount} opacity={0.3} />
        )))}

      <PeriodicOrbit
        orbit={depOrbit} color={series.departure} epoch={epochs.dep} window={windows.dep}
      />
      <PeriodicOrbit
        orbit={arrOrbit} color={series.arrival} epoch={epochs.arr} window={windows.arr}
      />

      {row && (
        <Transfer dep={depOrbit} arr={arrOrbit} row={row} color={series.transfer} channel="primary" />
      )}

      <CameraRig target={target} zoom={zoom} />
      <GizmoHelper alignment="bottom-left" margin={[68, 68]}>
        <GizmoViewport axisColors={['#d95926', '#199e70', '#3987e5']} labelColor="#ffffff" />
      </GizmoHelper>
    </Canvas>
  );
}
