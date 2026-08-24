/**
 * How a folder of solver exports is interpreted.
 *
 * One set of rules, used by both the Node build script (which indexes data
 * committed to the repo) and the browser folder picker (which reads a directory
 * off the user's disk without uploading it), so a layout that works in one
 * place works in the other.
 *
 * Recognised shapes, in order of preference:
 *
 *   <pair>/orbits*.csv                     initial conditions for the run
 *   <pair>/n<k>/*.csv                      solutions for the k-impulse solver
 *   <pair>/n<k>_p<P>/*.csv                 the same, solved on a PxP phase grid
 *   <pair>/transfers*_n<k>[_p<P>].csv      the same, as a flat file
 *   transfers_<DEP>_to_<ARR>_n<k>[_p<P>].csv
 *                                          flat at the root; the pair comes
 *                                          from the filename
 *   edges_<DEP>_to_<ARR>/edge_*.mat        the solver's own output, unreduced —
 *                                          read directly, no MATLAB export step
 *
 * Anything else is reported as unrecognised rather than silently dropped.
 */

const CSV = /\.csv$/i;
const MAT = /\.mat$/i;
const EDGE_MAT = /^edge_.*\.mat$/i;
const EDGES_DIR = /^edges[_-](.+)$/i;
const FLAT = /^transfers_(.+?)_to_(.+?)_n(\d+)(?:_p(\d+))?\.csv$/i;
const NDIR = /^n(\d+)(?:_p(\d+))?$/i;
const NSUFFIX = /_n(\d+)(?:_p(\d+))?\.csv$/i;
const ORBITS = /^orbits.*\.csv$/i;

/**
 * @param {string[]} paths POSIX-style paths relative to the chosen root
 * @returns {{pairs: Array, ignored: string[]}}
 */
export function groupFiles(paths) {
  const pairs = new Map();
  const ignored = [];

  const pair = (key) => {
    if (!pairs.has(key)) {
      pairs.set(key, { key, orbitsFile: null, byN: new Map(), matFiles: [], label: labelFor(key) });
    }
    return pairs.get(key);
  };

  const catalogs = [];

  for (const p of paths) {
    if (MAT.test(p)) {
      const seg = p.split('/').filter(Boolean);
      const name = seg[seg.length - 1];
      const dir = seg.length > 1 ? seg[seg.length - 2] : null;
      if (EDGE_MAT.test(name)) {
        // edges_<DEP>_to_<ARR>/ is what the MATLAB driver creates; fall back to
        // the containing folder's name when it was renamed.
        const m = dir ? EDGES_DIR.exec(dir) : null;
        pair(m ? m[1] : dir ?? '_root').matFiles.push(p);
      } else {
        // Anything else is a candidate orbit catalog; confirmed by parsing.
        catalogs.push(p);
      }
      continue;
    }
    if (!CSV.test(p)) { if (!p.endsWith('/')) ignored.push(p); continue; }
    const seg = p.split('/').filter(Boolean);
    const name = seg[seg.length - 1];

    const flat = FLAT.exec(name);
    if (flat) {
      const key = seg.length > 1 ? seg[seg.length - 2] : `${flat[1]}_to_${flat[2]}`;
      addFile(
        pair(NDIR.test(key) ? `${flat[1]}_to_${flat[2]}` : key),
        Number(flat[3]), num(flat[4]), p
      );
      continue;
    }

    if (ORBITS.test(name)) {
      const key = seg.length > 1 ? seg[seg.length - 2] : '_root';
      pair(key).orbitsFile = p;
      continue;
    }

    const dir = seg.length > 1 ? seg[seg.length - 2] : null;
    const nDir = dir && NDIR.exec(dir);
    if (nDir) {
      const key = seg.length > 2 ? seg[seg.length - 3] : '_root';
      addFile(pair(key), Number(nDir[1]), num(nDir[2]), p);
      continue;
    }

    const suffix = NSUFFIX.exec(name);
    if (suffix && dir) {
      addFile(pair(dir), Number(suffix[1]), num(suffix[2]), p);
      continue;
    }

    ignored.push(p);
  }

  const out = [];
  for (const p of pairs.values()) {
    if (!p.byN.size && !p.matFiles.length && !p.orbitsFile) continue;
    const [dep, arr] = splitPair(p.key);
    out.push({
      key: p.key,
      label: p.label,
      depFamily: dep,
      arrFamily: arr,
      orbitsFile: p.orbitsFile,
      matFiles: p.matFiles.sort(),
      impulses: [...p.byN.values()]
        .sort((a, b) => a.n - b.n || (a.p ?? 0) - (b.p ?? 0))
        .map(({ n, p: phase, files }) => ({ n, p: phase, files: files.sort() })),
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return { pairs: out, ignored, catalogs };
}

const num = (v) => (v == null || v === '' ? null : Number(v));

/**
 * One variant is an impulse count *and* a phase-grid resolution: a run may
 * carry `n2_p25` and `n2_p50` side by side, and they are different solutions of
 * the same problem, not different views of one. They are keyed separately so
 * both stay selectable.
 */
export const variantKey = (n, p) => `n${n}${p ? `_p${p}` : ''}`;

function addFile(pair, n, phase, path) {
  const k = variantKey(n, phase);
  if (!pair.byN.has(k)) pair.byN.set(k, { n, p: phase, files: [] });
  pair.byN.get(k).files.push(path);
}

export function splitPair(key) {
  const m = /^(.+?)(?:__|_to_)(.+)$/.exec(key);
  return m ? [m[1], m[2]] : [null, null];
}

export function labelFor(key) {
  const [dep, arr] = splitPair(key);
  const pretty = (s) => (s ?? '').replace(/_/g, ' ');
  return dep ? `${pretty(dep)} → ${pretty(arr)}` : key.replace(/_/g, ' ');
}
