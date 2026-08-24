#!/usr/bin/env node
/**
 * Reduce raw solver output to the committed solution set.
 *
 * The solver writes one `edge_<DEP>_<dd>_to_<ARR>_<aa>.mat` per orbit pairing —
 * around 22k converged solutions and a few megabytes each. A single family pair
 * is therefore of order 200-300 MB and a full study runs to most of a gigabyte,
 * which is far past what a repository can carry or a browser can load.
 *
 * What the site actually needs is the delta-V surface: the best solution in each
 * (departure, arrival, time-of-flight) cell, plus enough of the runners-up to
 * show where the multistart found genuinely different branches rather than one
 * basin. That is what this keeps — typically 180 rows per pairing instead of
 * 22k, turning ~800 MB of .mat into ~15 MB of CSV.
 *
 * This is the Node equivalent of scripts/export_edges.m and needs neither
 * MATLAB nor any npm package: the MAT reader is in src/lib/mat.js.
 *
 *   node scripts/reduce_solutions.mjs                 # every edges_* folder
 *   node scripts/reduce_solutions.mjs --branches 5    # keep more runners-up
 *   node scripts/reduce_solutions.mjs --only L1_Halo_to_L2_Halo
 *   node scripts/reduce_solutions.mjs --jobs 4
 *
 * Input   public/data/solutions/edges_<DEP>_to_<ARR>_n<k>[_p<P>]/edge_*.mat
 * Output  public/data/solutions/<DEP>_to_<ARR>/n<k>[_p<P>]/transfers_<DEP>_to_<ARR>_n<k>[_p<P>].csv
 *
 * The raw edges_* folders are matched by .gitignore, so they stay on disk and
 * out of the repository. Run scripts/build_data_index.mjs afterwards.
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const DIR = path.join(ROOT, 'public', 'data', 'solutions');

// Columns written, in order. Built per file rather than fixed: the n-impulse
// driver writes as many burns and legs as the run had, and a hardcoded
// three-burn header would either truncate a 4-impulse solve or pad a 2-impulse
// one with empty columns. src/lib/csv.js discovers the width the same way.
function makeColumns(maxImpulse) {
  const burns = Math.max(2, maxImpulse);
  const cols = [
    'dep_orbit_id', 'arr_orbit_id', 'n_impulse', 'TOF', 'DV_total',
    'departure_phase', 'arrival_phase',
  ];
  for (let k = 1; k <= burns; k++) cols.push(`dv${k}_x`, `dv${k}_y`, `dv${k}_z`);
  for (let k = 1; k <= burns; k++) cols.push(`dv${k}_mag`);
  for (let k = 1; k <= burns - 1; k++) cols.push(`t_leg${k}`);
  cols.push(
    'min_moon_dist', 'lunar_valid', 'chain_id', 'position_residual',
    'node_residual', 'tof_idx', 'delta_C', 'rank', 'seeds_converged',
  );
  return cols;
}

// ---------------------------------------------------------------------------
// Worker: one process per core, each parsing whole files.
// ---------------------------------------------------------------------------
if (process.env.REDUCE_WORKER) {
  const { readEdgeFile } = await import('../src/lib/mat-table.js');
  process.on('message', async (msg) => {
    if (msg.done) process.exit(0);
    try {
      const buf = await readFile(msg.file);
      const { rows, report } = await readEdgeFile(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        { K: msg.branches }
      );
      process.send({ ok: true, file: msg.file, rows, total: report.totalRows, truncated: report.truncated });
    } catch (e) {
      process.send({ ok: false, file: msg.file, error: String(e?.message ?? e) });
    }
  });
  process.send({ ready: true });
}

// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * `edges_L1_Halo_to_L2_Halo_n2`      -> { pair: 'L1_Halo_to_L2_Halo', n: 2, p: null }
 * `edges_L1_Halo_to_L2_Halo_n2_p25`  -> { pair: 'L1_Halo_to_L2_Halo', n: 2, p: 25 }
 *
 * `p` is the phase-grid resolution the multistart searched (25 x 25 seeds), so
 * two folders that differ only in `p` are different solves of the same problem
 * and both are kept.
 */
function parseFolder(name) {
  const stripped = name.replace(/^edges[_-]/i, '');
  const m = /^(.+?)_n(\d+)(?:_p(\d+))?$/i.exec(stripped);
  if (m) return { pair: m[1], n: Number(m[2]), p: m[3] ? Number(m[3]) : null };
  return { pair: stripped, n: null, p: null };
}

const num = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toPrecision(12);
};

function toCsvRow(r, columns) {
  const cell = {
    dep_orbit_id: r.dep_orbit_id,
    arr_orbit_id: r.arr_orbit_id,
    n_impulse: r.n_impulse,
    TOF: r.TOF,
    DV_total: r.DV_total,
    departure_phase: r.departure_phase,
    arrival_phase: r.arrival_phase,
    min_moon_dist: r.min_moon_dist,
    lunar_valid: r.lunar_valid,
    chain_id: r.chain_id,
    position_residual: r.position_residual,
    node_residual: r.node_residual,
    tof_idx: r.tof_idx,
    delta_C: r.delta_C,
    rank: r.rank,
    seeds_converged: r.seeds_converged,
  };
  r.dvs.forEach((d, k) => {
    cell[`dv${k + 1}_x`] = d.v[0];
    cell[`dv${k + 1}_y`] = d.v[1];
    cell[`dv${k + 1}_z`] = d.v[2];
    cell[`dv${k + 1}_mag`] = d.mag;
  });
  r.coasts.forEach((t, k) => { cell[`t_leg${k + 1}`] = t; });
  return columns.map((c) => num(cell[c])).join(',');
}

/** Run `files` through a pool of forked workers, calling onRow for each result. */
function runPool(files, branches, jobs, onFile) {
  return new Promise((resolve) => {
    let cursor = 0, active = 0, done = 0;
    const errors = [];
    const workers = [];

    const feed = (w) => {
      if (cursor >= files.length) {
        w.send({ done: true });
        if (--active === 0) resolve({ done, errors });
        return;
      }
      w.send({ file: files[cursor++], branches });
    };

    for (let i = 0; i < Math.min(jobs, files.length); i++) {
      const w = fork(HERE, [], { env: { ...process.env, REDUCE_WORKER: '1' }, silent: false });
      workers.push(w);
      active++;
      w.on('message', (m) => {
        if (m.ready) return feed(w);
        done++;
        if (m.ok) onFile(m);
        else errors.push(`${path.basename(m.file)}: ${m.error}`);
        process.stdout.write(`\r    ${done}/${files.length} pairings`);
        feed(w);
      });
      w.on('exit', () => { /* handled by the counter above */ });
    }
  });
}

async function main() {
  if (!existsSync(DIR)) {
    console.log('no public/data/solutions — nothing to reduce');
    return;
  }
  const branches = Number(arg('branches', 3));
  const jobs = Number(arg('jobs', Math.max(1, Math.min(8, cpus().length - 1))));
  const only = arg('only', null);

  const entries = (await readdir(DIR, { withFileTypes: true })).filter((e) => e.isDirectory());
  const targets = [];
  for (const e of entries) {
    const files = (await readdir(path.join(DIR, e.name)))
      .filter((f) => /^edge_.*\.mat$/i.test(f))
      .map((f) => path.join(DIR, e.name, f))
      .sort();
    if (!files.length) continue;
    const { pair, n, p } = parseFolder(e.name);
    if (only && pair !== only) continue;
    targets.push({ folder: e.name, pair, n, p, files });
  }

  if (!targets.length) {
    console.log('no edges_* folders with edge_*.mat found under public/data/solutions');
    return;
  }

  console.log(`reducing ${targets.length} solve folder(s) with ${jobs} worker(s), keeping ${branches} branch(es) per slice\n`);

  for (const t of targets) {
    let bytes = 0;
    for (const f of t.files) bytes += (await stat(f)).size;
    console.log(`  ${t.folder}  ${t.files.length} pairings, ${(bytes / 1e6).toFixed(0)} MB`);

    const rows = [];
    let rawTotal = 0;
    const truncated = [];
    const started = Date.now();
    const { errors } = await runPool(t.files, branches, jobs, (m) => {
      rawTotal += m.total;
      if (m.truncated) truncated.push(path.basename(m.file));
      for (const r of m.rows) rows.push(r);
    });
    process.stdout.write('\r');

    if (!rows.length) {
      console.log(`    nothing converged — skipped${errors.length ? ` (${errors[0]})` : ''}`);
      continue;
    }

    // The impulse count comes from the folder when it names one, and otherwise
    // from the burns actually present in the rows.
    const n = t.n ?? Math.max(...rows.map((r) => r.n_impulse ?? 2));
    const tag = `n${n}${t.p ? `_p${t.p}` : ''}`;
    const outDir = path.join(DIR, t.pair, tag);
    await mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `transfers_${t.pair}_${tag}.csv`);

    rows.sort((a, b) =>
      a.dep_orbit_id.localeCompare(b.dep_orbit_id) ||
      a.arr_orbit_id.localeCompare(b.arr_orbit_id) ||
      (a.tof_idx ?? 0) - (b.tof_idx ?? 0) ||
      (a.rank ?? 1) - (b.rank ?? 1));

    const columns = makeColumns(Math.max(...rows.map((r) => r.dvs.length)));
    const csv = [columns.join(','), ...rows.map((r) => toCsvRow(r, columns))].join('\n');
    await writeFile(outFile, csv);

    const invalid = rows.filter((r) => r.lunar_valid === false).length;
    console.log(
      `    ${rawTotal.toLocaleString()} solutions -> ${rows.length.toLocaleString()} kept` +
      ` (${invalid} lunar-invalid), ${(csv.length / 1e6).toFixed(1)} MB` +
      `, ${((Date.now() - started) / 1000).toFixed(0)} s`
    );
    if (truncated.length) {
      console.log(
        `    !! ${truncated.length} file(s) were truncated mid-save and recovered: ` +
        `${truncated.slice(0, 3).join(', ')}${truncated.length > 3 ? ' …' : ''}`
      );
    }
    if (errors.length) console.log(`    !! ${errors.length} file(s) failed, e.g. ${errors[0]}`);
    console.log(`    wrote ${path.relative(ROOT, outFile)}`);
  }

  console.log('\nnow run:  node scripts/build_data_index.mjs');
}

// Called last: top-level `const` helpers above are not initialised until the
// module body has finished evaluating.
if (!process.env.REDUCE_WORKER) await main();
