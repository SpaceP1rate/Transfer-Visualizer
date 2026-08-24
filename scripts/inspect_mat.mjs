#!/usr/bin/env node
/**
 * Report what is actually inside one .mat file.
 *
 * Run when the reducer says "no MATLAB table found": that message means the
 * file parsed as MAT5 but held no MCOS table object, so the export wrote
 * something else — a struct, plain arrays, a different variable name. This
 * prints the top-level variables and, where relevant, their fields and sizes,
 * which is enough to say what the export changed.
 *
 *   node scripts/inspect_mat.mjs public/data/solutions/edges_.../edge_....mat
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readMat, parseSubsystem } from '../src/lib/mat.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect_mat.mjs <file.mat>');
  process.exit(1);
}

const buf = await readFile(file);
const mat = await readMat(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const size = (v) => (v?.dims ? v.dims.join('x') : '');
const count = (v) =>
  v?.kind === 'num' ? v.value?.length
    : v?.kind === 'cell' ? v.cells?.length
    : v?.kind === 'char' ? String(v.value).length
    : '';

console.log(path.basename(file));
console.log('header      ', mat.header);
console.log('endian      ', mat.littleEndian ? 'little' : 'big');
console.log('truncated   ', mat.truncated);
console.log('subsystem   ', mat.subsystem ? `${mat.subsystem.length} bytes` : 'none  <- no MCOS objects, so no table');
console.log(`variables    ${mat.vars.size}`);

for (const [name, v] of mat.vars) {
  console.log(`  ${name}  kind=${v.kind}  dims=${size(v)}  n=${count(v)}${v.className ? `  class=${v.className}` : ''}`);
  if (v.kind === 'struct') {
    console.log(`    fields: ${v.fields.join(', ')}`);
    const rec = v.records?.[0] ?? {};
    for (const f of v.fields.slice(0, 40)) {
      const x = rec[f];
      console.log(`      ${f}: kind=${x?.kind ?? '?'} dims=${size(x)} n=${count(x)}`);
    }
  }
  if (v.kind === 'cell') {
    const kinds = [...new Set(v.cells.map((c) => c?.kind))];
    console.log(`    cell members: ${kinds.join(', ')}`);
  }
}

// If there is a subsystem, say what shapes it holds — the table reader matches
// a data block against a name block of the same count, so a mismatch here is
// the difference between "found" and "no table".
if (mat.subsystem) {
  const fw = parseSubsystem(mat.subsystem, mat.littleEndian);
  if (!fw || fw.kind !== 'cell') {
    console.log('FileWrapper  unreadable');
  } else {
    console.log(`FileWrapper  ${fw.cells.length} cells`);
    fw.cells.forEach((c, i) => {
      if (!c) return;
      if (c.kind === 'cell') {
        const kinds = [...new Set(c.cells.map((x) => x?.kind))];
        const lens = [...new Set(c.cells.map((x) =>
          x?.kind === 'num' ? x.value?.length : x?.kind === 'cell' ? x.cells?.length : x?.kind === 'char' ? 1 : -1))];
        console.log(`  [${i}] cell of ${c.cells.length}  kinds=${kinds.join('/')}  lengths=${lens.slice(0, 6).join(',')}${lens.length > 6 ? '…' : ''}`);
      } else {
        console.log(`  [${i}] ${c.kind} ${size(c)}`);
      }
    });
  }
}
