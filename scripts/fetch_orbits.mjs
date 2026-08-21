#!/usr/bin/env node
/**
 * Build-time fetcher for JPL's Three-Body Periodic Orbits API.
 *
 * NASA's SSD/CNEOS API Fair Use Policy forbids embedding these APIs in a
 * website (CORS policy) and requires one request at a time. So this script is
 * run locally, sequentially, with a polite delay, and its output is committed
 * to the repo as static JSON. The site never talks to ssd-api.jpl.nasa.gov.
 *
 *   node scripts/fetch_orbits.mjs [--force]
 *
 * Output: public/data/orbits/<key>.json          (research window, full res)
 *         public/data/orbits/<key>.sweep.json    (whole family, downsampled)
 *         public/data/orbits/index.json          (manifest + system constants)
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'orbits');
const API = 'https://ssd-api.jpl.nasa.gov/periodic_orbits.api';

const DOC_VERSION = '1.0'; // docs at https://ssd-api.jpl.nasa.gov/doc/periodic_orbits.html
const DELAY_MS = 1500; // one request at a time, politely spaced
const SWEEP_MAX = 400; // background-sweep members kept per family

// Research Jacobi windows: departure C in [3.00, 3.18], arrival C in [3.00, 3.16].
// Fetched with a margin so the study members are never clipped at an edge.
const WINDOW = { jacobimin: 2.95, jacobimax: 3.25 };

/** Families the site knows about. `key` is what the UI and the CSVs use. */
export const FAMILIES = [
  { key: 'L1_Halo_N', label: 'L1 Halo (north)', q: { family: 'halo', libr: 1, branch: 'N' } },
  { key: 'L1_Halo_S', label: 'L1 Halo (south)', q: { family: 'halo', libr: 1, branch: 'S' } },
  { key: 'L2_Halo_N', label: 'L2 Halo (north)', q: { family: 'halo', libr: 2, branch: 'N' } },
  { key: 'L2_Halo_S', label: 'L2 Halo (south)', q: { family: 'halo', libr: 2, branch: 'S' } },
  { key: 'L1_Lyapunov', label: 'L1 Lyapunov', q: { family: 'lyapunov', libr: 1 } },
  { key: 'L2_Lyapunov', label: 'L2 Lyapunov', q: { family: 'lyapunov', libr: 2 } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function url(q) {
  const u = new URL(API);
  u.searchParams.set('sys', 'earth-moon');
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  return u.toString();
}

let lastRequestAt = 0;
async function get(q) {
  const wait = DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  const target = url(q);
  process.stdout.write(`  GET ${target}\n`);
  const res = await fetch(target, { headers: { accept: 'application/json' } });
  lastRequestAt = Date.now();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${target}`);
  const json = await res.json();
  const v = json?.signature?.version;
  if (v !== DOC_VERSION) {
    console.warn(
      `\n  !! API signature.version is "${v}", expected "${DOC_VERSION}".\n` +
        `     Re-read https://ssd-api.jpl.nasa.gov/doc/periodic_orbits.html before trusting this data.\n`
    );
  }
  return json;
}

/** Every numeric value in the API response is a JSON string. */
const num = (s) => parseFloat(s);

/**
 * Rows arrive as string arrays keyed by `fields`. Flatten to a compact
 * columnar-ish record the browser can use without a parse pass.
 */
function toRecords(json) {
  const f = json.fields;
  const ix = Object.fromEntries(f.map((name, i) => [name, i]));
  return json.data.map((row) => ({
    x: num(row[ix.x]),
    y: num(row[ix.y]),
    z: num(row[ix.z]),
    vx: num(row[ix.vx]),
    vy: num(row[ix.vy]),
    vz: num(row[ix.vz]),
    jacobi: num(row[ix.jacobi]),
    period: num(row[ix.period]),
    stability: num(row[ix.stability]),
  }));
}

function parseSystem(sys) {
  const vec = (a) => a.map(num);
  return {
    name: sys.name,
    mu: num(sys.mass_ratio),
    radiusSecondaryKm: num(sys.radius_secondary),
    lunitKm: num(sys.lunit),
    tunitS: num(sys.tunit),
    // velocity unit, km/s
    vunitKmS: num(sys.lunit) / num(sys.tunit),
    // lunar radius, nondimensional
    moonRadius: num(sys.radius_secondary) / num(sys.lunit),
    L1: vec(sys.L1),
    L2: vec(sys.L2),
    L3: vec(sys.L3),
    L4: vec(sys.L4),
    L5: vec(sys.L5),
  };
}

/** Even-stride downsample that always keeps both endpoints of the family. */
function downsample(records, max) {
  if (records.length <= max) return records;
  const out = [];
  const step = (records.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(records[Math.round(i * step)]);
  return out;
}

async function main() {
  const force = process.argv.includes('--force');
  await mkdir(OUT, { recursive: true });

  let system = null;
  const manifest = { generatedAt: new Date().toISOString(), apiVersion: null, families: [] };

  for (const fam of FAMILIES) {
    console.log(`\n${fam.key}`);
    const windowPath = path.join(OUT, `${fam.key}.json`);
    const sweepPath = path.join(OUT, `${fam.key}.sweep.json`);

    let windowDoc, sweepDoc;

    if (!force && existsSync(windowPath) && existsSync(sweepPath)) {
      console.log('  cached, skipping (pass --force to refetch)');
      windowDoc = JSON.parse(await readFile(windowPath, 'utf8'));
      sweepDoc = JSON.parse(await readFile(sweepPath, 'utf8'));
      system ??= windowDoc.system ?? null;
    } else {
      const win = await get({ ...fam.q, ...WINDOW });
      const all = await get(fam.q);

      manifest.apiVersion = win.signature?.version ?? null;
      system ??= parseSystem(win.system);

      windowDoc = {
        key: fam.key,
        label: fam.label,
        system,
        query: { sys: 'earth-moon', ...fam.q, ...WINDOW },
        count: parseInt(win.count, 10),
        limits: win.limits,
        orbits: toRecords(win),
      };
      const allRecords = toRecords(all);
      sweepDoc = {
        key: fam.key,
        label: fam.label,
        count: parseInt(all.count, 10),
        limits: all.limits,
        sampled: Math.min(allRecords.length, SWEEP_MAX),
        orbits: downsample(allRecords, SWEEP_MAX),
      };

      await writeFile(windowPath, JSON.stringify(windowDoc));
      await writeFile(sweepPath, JSON.stringify(sweepDoc));
    }

    console.log(
      `  window ${windowDoc.orbits.length} orbits, family ${sweepDoc.count} orbits ` +
        `(${sweepDoc.orbits.length} kept for the sweep)`
    );

    manifest.families.push({
      key: fam.key,
      label: fam.label,
      windowCount: windowDoc.orbits.length,
      familyCount: sweepDoc.count,
      jacobiRange: sweepDoc.limits?.jacobi?.map(num) ?? null,
      periodRange: sweepDoc.limits?.period?.map(num) ?? null,
    });
  }

  // The system block is identical across families; store it once.
  if (!system) {
    const first = JSON.parse(await readFile(path.join(OUT, `${FAMILIES[0].key}.json`), 'utf8'));
    system = first.system ?? null;
  }
  manifest.system = system;

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, path.join(OUT, 'index.json'))}`);
  if (system) {
    console.log(`  mu    = ${system.mu}`);
    console.log(`  lunit = ${system.lunitKm} km`);
    console.log(`  tunit = ${system.tunitS} s`);
    console.log(`  vunit = ${system.vunitKmS} km/s`);
    console.log(`  moon  = ${system.moonRadius} nd radius`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
