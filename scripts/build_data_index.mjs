#!/usr/bin/env node
/**
 * Index whatever transfer CSVs are committed under public/data/transfers and
 * write the manifest the site loads.
 *
 * Folder conventions live in src/lib/layout.js and are shared with the browser
 * folder picker, so a layout that works here works when the same folder is
 * opened from disk.
 *
 * Run: node scripts/build_data_index.mjs
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupFiles } from '../src/lib/layout.js';
import { parseTransfersCsv } from '../src/lib/csv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public', 'data', 'transfers');

const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

async function walk(dir, prefix = '', depth = 0, out = []) {
  if (depth > 4) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(path.join(dir, e.name), rel, depth + 1, out);
    else out.push(rel);
  }
  return out;
}

if (!existsSync(DIR)) {
  console.log('no public/data/transfers yet — nothing to index');
  process.exit(0);
}

const paths = (await walk(DIR)).filter((p) => p !== 'index.json');
const { pairs, ignored } = groupFiles(paths);

const out = { generated: new Date().toISOString(), pairs: [] };

for (const p of pairs) {
  const impulses = [];
  for (const variant of p.impulses) {
    let rows = [];
    for (const rel of variant.files) {
      rows = rows.concat(parseTransfersCsv(await readFile(path.join(DIR, rel), 'utf8')));
    }
    if (!rows.length) continue;
    const valid = rows.filter((r) => r.lunar_valid !== false);
    impulses.push({
      n: variant.n,
      files: variant.files,
      rows: rows.length,
      lunarInvalid: rows.length - valid.length,
      tofRange: range(rows.map((r) => r.TOF).filter(Number.isFinite)),
      dvRange: range(valid.map((r) => r.DV_total).filter(Number.isFinite)),
      maxResidual: rows.reduce((m, r) => Math.max(m, r.position_residual ?? 0), 0),
    });
    console.log(
      `  ${p.key}  n=${variant.n}: ${rows.length} rows` +
      `, ${rows.length - valid.length} lunar-invalid` +
      `, max residual ${impulses[impulses.length - 1].maxResidual.toExponential(1)}`
    );
  }
  if (p.matFiles?.length) {
    console.log(`  ${p.key}: ${p.matFiles.length} solver .mat (parsed in the browser)`);
  }
  if (!impulses.length && !p.orbitsFile && !p.matFiles?.length) continue;
  out.pairs.push({ ...p, impulses });
}

let bytes = 0;
for (const p of paths) bytes += (await stat(path.join(DIR, p))).size;

await writeFile(path.join(DIR, 'index.json'), JSON.stringify(out, null, 2));
console.log(`\nwrote data/transfers/index.json: ${out.pairs.length} pair(s), ${(bytes / 1e6).toFixed(1)} MB of CSV`);
if (ignored.length) console.log(`  ignored ${ignored.length} unrecognised file(s), e.g. ${ignored[0]}`);
