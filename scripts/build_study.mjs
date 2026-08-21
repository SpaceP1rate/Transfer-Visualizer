#!/usr/bin/env node
/**
 * Reproduce the exact orbit members the MATLAB study used, straight from the
 * catalog, and commit them as a small JSON the site loads.
 *
 * `sample_family` in family_to_family_global_two_impulse_transfer.m is
 * deterministic:
 *
 *     mask = C >= C_min & C <= C_max          (catalog order preserved)
 *     idxs = round(linspace(1, n_total, n_samples))
 *
 * so the ten departure and ten arrival orbits can be regenerated here rather
 * than round-tripped through a CSV. The labels match the MATLAB run's
 * `sprintf('%s_%02d', FAMILY, idx)`, which is what the transfer tables key on.
 *
 * Run: node scripts/build_study.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Family, STRIDE } from '../src/lib/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORBITS = path.join(ROOT, 'public', 'data', 'orbits');
const OUT = path.join(ROOT, 'public', 'data', 'study');

/** Mirrors the parameter block at the top of the MATLAB driver. */
const N_SAMPLES = 10;
const C_DEP = [3.0, 3.18];
const C_ARR = [3.0, 3.16];
const TOF_MIN = 0.1;
const TOF_POINTS = 60;

// Every ordered pair among the study families. Each document is a few KB, and
// generating all of them means any run the solver produces — including
// directions the current sweep has not covered — resolves its orbit labels
// without a rebuild.
const FAMILIES = ['L1_Halo', 'L1_Lyapunov', 'L2_Halo', 'L2_Lyapunov'];
const PAIRS = FAMILIES.flatMap((dep) =>
  FAMILIES.filter((arr) => arr !== dep).map((arr) => ({ dep, arr }))
);

/** MATLAB linspace + round, 1-based, returned as 0-based indices. */
function sampleIndices(nTotal, nSamples) {
  if (nSamples === 1) return [0];
  const out = [];
  for (let i = 0; i < nSamples; i++) {
    const v = 1 + (i * (nTotal - 1)) / (nSamples - 1);
    out.push(Math.round(v) - 1);
  }
  return out;
}

function sampleFamily(fam, [cMin, cMax], nSamples, label) {
  const masked = [];
  for (let i = 0; i < fam.count; i++) {
    const c = fam.table[i * STRIDE + 6];
    if (c >= cMin && c <= cMax) masked.push(i);
  }
  if (masked.length < nSamples) {
    throw new Error(`${fam.meta.key}: only ${masked.length} orbits in C = [${cMin}, ${cMax}]`);
  }
  return sampleIndices(masked.length, nSamples).map((k, n) => {
    const o = fam.getCopy(masked[k]);
    return {
      id: `${label}_${String(n + 1).padStart(2, '0')}`,
      idx: n + 1,
      family: fam.meta.key,
      catalogIndex: o.index,
      ic: Array.from(o.ic),
      period: o.period,
      jacobi: o.jacobi,
      stability: o.stability,
    };
  });
}

const manifest = JSON.parse(await readFile(path.join(ORBITS, 'index.json'), 'utf8'));
const cache = new Map();
async function loadFamily(key) {
  if (cache.has(key)) return cache.get(key);
  const meta = manifest.families.find((f) => f.key === key);
  if (!meta) throw new Error(`family ${key} is not in the catalog`);
  const buf = await readFile(path.join(ORBITS, meta.file));
  const fam = new Family(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  cache.set(key, fam);
  return fam;
}

await mkdir(OUT, { recursive: true });
const index = { generated: new Date().toISOString(), nSamples: N_SAMPLES, cDep: C_DEP, cArr: C_ARR, pairs: [] };

for (const { dep, arr } of PAIRS) {
  const depFam = await loadFamily(dep);
  const arrFam = await loadFamily(arr);
  const depOrbits = sampleFamily(depFam, C_DEP, N_SAMPLES, dep);
  const arrOrbits = sampleFamily(arrFam, C_ARR, N_SAMPLES, arr);

  // The driver shares one TOF grid across every pairing:
  //   TOF_max = mean of all sampled departure and arrival periods
  const periods = [...depOrbits, ...arrOrbits].map((o) => o.period);
  const tofMax = periods.reduce((a, b) => a + b, 0) / periods.length;
  const tofGrid = Array.from(
    { length: TOF_POINTS },
    (_, i) => TOF_MIN + (i * (tofMax - TOF_MIN)) / (TOF_POINTS - 1)
  );

  const key = `${dep}_to_${arr}`;
  const doc = {
    key,
    label: `${depFam.meta.label} → ${arrFam.meta.label}`,
    depFamily: dep,
    arrFamily: arr,
    depBranch: depFam.meta.branch,
    arrBranch: arrFam.meta.branch,
    cDep: C_DEP,
    cArr: C_ARR,
    tofGrid,
    dep: depOrbits,
    arr: arrOrbits,
  };
  await writeFile(path.join(OUT, `${key}.json`), JSON.stringify(doc));

  index.pairs.push({
    key,
    label: doc.label,
    depFamily: dep,
    arrFamily: arr,
    file: `${key}.json`,
    tofRange: [TOF_MIN, tofMax],
    tofPoints: TOF_POINTS,
    depJacobi: [depOrbits[0].jacobi, depOrbits[depOrbits.length - 1].jacobi],
    arrJacobi: [arrOrbits[0].jacobi, arrOrbits[arrOrbits.length - 1].jacobi],
  });

  console.log(
    `${key.padEnd(30)} dep C ${depOrbits[0].jacobi.toFixed(4)}..${depOrbits[9].jacobi.toFixed(4)}` +
    `  arr C ${arrOrbits[0].jacobi.toFixed(4)}..${arrOrbits[9].jacobi.toFixed(4)}` +
    `  TOF <= ${tofMax.toFixed(4)}`
  );
}

await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\nwrote ${path.relative(ROOT, path.join(OUT, 'index.json'))}`);
