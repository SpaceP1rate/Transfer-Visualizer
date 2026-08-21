import { readFile } from 'node:fs/promises';
import { readMat } from './src/lib/mat.js';
import { extractTables, tableToRows } from './src/lib/mat-table.js';
import { makeDerivs, integrate, jacobiConstant } from './src/lib/cr3bp.js';

const MU = 0.01215058560962404, f = makeDerivs(MU);
const file = 'public/data/solutions/edges_L1_Halo_to_L2_Halo_n2/edge_L1_Halo_02_to_L2_Halo_09.mat';
const b = await readFile(file);
const mat = await readMat(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const cDep = mat.vars.get('C_dep')?.value?.[0];
const cArr = mat.vars.get('C_arr')?.value?.[0];
const dIdx = mat.vars.get('d_idx')?.value?.[0];
const aIdx = mat.vars.get('a_idx')?.value?.[0];
console.log('stored:  C_dep', cDep, ' C_arr', cArr, ' d_idx', dIdx, ' a_idx', aIdx);

const doc = JSON.parse(await readFile('public/data/study/L1_Halo_to_L2_Halo.json', 'utf8'));
const dep = doc.dep[dIdx - 1], arr = doc.arr[aIdx - 1];
console.log('mine:    C_dep', jacobiConstant(MU, dep.ic), ' C_arr', jacobiConstant(MU, arr.ic));
console.log('         labels', dep.id, arr.id);
console.log('         dC dep', Math.abs(jacobiConstant(MU, dep.ic) - cDep).toExponential(2),
            ' dC arr', Math.abs(jacobiConstant(MU, arr.ic) - cArr).toExponential(2));

const rows = tableToRows([...extractTables(mat).values()][0]);
console.log('rows in file:', rows.length);

const st = (o, t) => Float64Array.from(integrate(f, Float64Array.from(o.ic), t, { rtol: 1e-13, atol: 1e-13 }));
const gap = (r) => {
  const X = st(dep, r.departure_phase * dep.period);
  X[3] += r.dvs[0].v[0]; X[4] += r.dvs[0].v[1]; X[5] += r.dvs[0].v[2];
  const E = integrate(f, X, r.TOF, { rtol: 1e-13, atol: 1e-13 });
  const T = st(arr, r.arrival_phase * arr.period);
  return Math.hypot(E[0] - T[0], E[1] - T[1], E[2] - T[2]);
};
const best = new Map();
for (const r of rows) { const k = r.tof_idx; if (!best.has(k) || r.DV_total < best.get(k).DV_total) best.set(k, r); }
const g = [...best.values()].map(gap).sort((x, y) => x - y);
console.log('gap from the raw .mat, 60 best-per-slice rows:');
console.log('   median', g[30].toExponential(2), ' p90', g[54].toExponential(2), ' worst', g[g.length-1].toExponential(2));
console.log('   stored residual max', Math.max(...rows.map(r => r.position_residual)).toExponential(2));
